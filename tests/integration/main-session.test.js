import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFile, rm, stat, writeFile } from 'node:fs/promises';
import { execa } from 'execa';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { simpleGit } from 'simple-git';
import { createTempRepo } from '../helpers/temp-repo.js';
import { initStriart } from '../../src/init.ts';
import { createAgent } from '../../src/clone.ts';
import {
  readMainSession,
  readMainSessionStatus,
  startMainSession,
  stopMainSession,
} from '../../src/main-session.ts';
import { reserveMainSession } from '../../src/lock.ts';
import {
  mergeAgentCommit,
  retryQueue,
  runMainSession,
  syncAgentWithMain,
} from '../../src/orchestrator.ts';

const FAKE_AGENT = fileURLToPath(new URL('../helpers/fake-agent.cjs', import.meta.url));
const GATE_OK = 'node -e "process.exit(0)"';

/** Profil pointant sur le faux agent — même contrat que claude/codex/aider. */
const fakeProfile = { command: process.execPath, args: [FAKE_AGENT, '{{prompt}}'] };

async function setConfig(root, config) {
  await writeFile(
    path.join(root, '.striartrc.json'),
    JSON.stringify({ agentProfiles: { fake: fakeProfile }, ...config }),
  );
}

async function commitInAgent(info, fileName, content, message) {
  const git = simpleGit(info.path);
  await git.addConfig('user.name', 'Agent');
  await git.addConfig('user.email', 'agent@example.com');
  await writeFile(path.join(info.path, fileName), content);
  await git.add([fileName]);
  await git.commit(message);
}

/**
 * PID garanti mort : un process enfant déjà terminé. Le PID se lit sur le
 * sous-process, pas sur son résultat (absent du résultat d'execa 9 — le
 * helper rendait `undefined`, et les tests « PID mort » passaient sans
 * jamais exercer un vrai PID).
 */
async function deadPid() {
  const subprocess = execa('node', ['-e', 'process.exit(0)']);
  const { pid } = subprocess;
  await subprocess;
  if (!Number.isInteger(pid)) throw new Error('PID du sous-process illisible');
  return pid;
}

describe('session principale — main-session.js (intégration)', () => {
  let repo;

  beforeEach(async () => {
    repo = await createTempRepo();
    await initStriart(repo.root);
    await setConfig(repo.root, { testCommand: GATE_OK });
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    delete process.env.FAKE_AGENT_MODE;
    await repo.cleanup();
  });

  describe('contrat du module (read/start/stop)', () => {
    it('startMainSession écrit, readMainSession relit pid/reason/startedAt', async () => {
      expect(await readMainSession(repo.root)).toBeNull();

      await startMainSession(repo.root, { pid: 4242, reason: 'édition manuelle' });
      const session = await readMainSession(repo.root);
      expect(session).toMatchObject({ pid: 4242, reason: 'édition manuelle' });
      expect(typeof session.startedAt).toBe('string');
    });

    it('stopMainSession est idempotent (aucune erreur si rien à supprimer)', async () => {
      await expect(stopMainSession(repo.root)).resolves.toBeUndefined();
      await startMainSession(repo.root, { pid: 4242, reason: 'x' });
      await stopMainSession(repo.root);
      expect(await readMainSession(repo.root)).toBeNull();
      // Second stop, rien à retirer : toujours permis.
      await expect(stopMainSession(repo.root)).resolves.toBeUndefined();
    });
  });

  describe('assertNoLiveMainSession — garde dans withMainLock', () => {
    it('PID vivant : mergeAgentCommit refuse avec MAIN_SESSION_LIVE et la raison déclarée', async () => {
      const agent = await createAgent({ root: repo.root, name: 'agent-a' });
      await commitInAgent(agent, 'feature.js', 'export const x = 1;\n', 'feat: x');
      await startMainSession(repo.root, {
        pid: process.pid,
        reason: 'résolution manuelle en cours',
      });

      await expect(mergeAgentCommit({ root: repo.root, agent: 'agent-a' })).rejects.toMatchObject({
        code: 'MAIN_SESSION_LIVE',
        message: expect.stringContaining('résolution manuelle en cours'),
      });
    });

    it('PID vivant : syncAgentWithMain refuse avec MAIN_SESSION_LIVE', async () => {
      await createAgent({ root: repo.root, name: 'agent-a' });
      await writeFile(path.join(repo.root, 'nouveau.js'), 'export const n = 1;\n');
      await repo.git.add(['nouveau.js']);
      await repo.git.commit('feat: nouveau depuis main');
      await startMainSession(repo.root, { pid: process.pid, reason: 'édition à la main' });

      await expect(syncAgentWithMain({ root: repo.root, agent: 'agent-a' })).rejects.toMatchObject({
        code: 'MAIN_SESSION_LIVE',
        message: expect.stringContaining('édition à la main'),
      });
    });

    it('PID vivant : retryQueue refuse avec MAIN_SESSION_LIVE', async () => {
      await startMainSession(repo.root, { pid: process.pid, reason: 'occupation directe' });

      await expect(retryQueue({ root: repo.root })).rejects.toMatchObject({
        code: 'MAIN_SESSION_LIVE',
        message: expect.stringContaining('occupation directe'),
      });
    });

    it('PID mort : ne bloque rien, retryQueue passe normalement', async () => {
      await startMainSession(repo.root, {
        pid: await deadPid(),
        reason: 'session terminée sans nettoyage',
      });

      await expect(retryQueue({ root: repo.root })).resolves.toMatchObject({
        started: [],
        stillWaiting: [],
      });
    });
  });

  describe('protection du MERGE_HEAD contre recoverOrphanMerge (incident réel)', () => {
    async function createOrphanMerge() {
      await writeFile(path.join(repo.root, 'shared.js'), 'main\n');
      await repo.git.add(['shared.js']);
      await repo.git.commit('feat: main');
      await repo.git.checkoutBranch('autre', 'HEAD~1');
      await writeFile(path.join(repo.root, 'shared.js'), 'autre\n');
      await repo.git.add(['shared.js']);
      await repo.git.commit('feat: autre');
      await repo.git.checkout('main');
      await repo.git.raw(['merge', 'autre', '--no-commit', '--no-ff']).catch(() => {});
      await expect(stat(path.join(repo.root, '.git', 'MERGE_HEAD'))).resolves.toBeTruthy();
    }

    it("un merge en cours n'est PAS annulé tant que la session principale vit, puis récupéré une fois morte", async () => {
      await createOrphanMerge();
      await startMainSession(repo.root, {
        pid: process.pid,
        reason: 'résolution du conflit shared.js',
      });

      await expect(retryQueue({ root: repo.root })).rejects.toMatchObject({
        code: 'MAIN_SESSION_LIVE',
      });
      // Le merge en cours est intact : ni abandonné, ni finalisé.
      await expect(stat(path.join(repo.root, '.git', 'MERGE_HEAD'))).resolves.toBeTruthy();
      expect((await simpleGit(repo.root).status()).conflicted).toEqual(['shared.js']);

      // La session se termine (sortie de secours équivalente à la fermeture
      // du process qui la portait) : l'opération suivante récupère le débris,
      // exactement comme avant l'ajout de la session principale (non-régression).
      await stopMainSession(repo.root);
      await retryQueue({ root: repo.root });
      await expect(stat(path.join(repo.root, '.git', 'MERGE_HEAD'))).rejects.toThrow();
      expect((await simpleGit(repo.root).status()).conflicted).toEqual([]);
    });
  });

  describe('runMainSession — agent lancé directement sur le repo principal', () => {
    const run = (extra = {}) =>
      runMainSession({
        root: repo.root,
        prompt: 'corrige le bug X',
        profile: 'fake',
        reason: 'corrige le bug X',
        ...extra,
      });

    it('chemin vert : COMPLETED, travail commité directement sur main, PID dépublié en fin de session', async () => {
      process.env.FAKE_AGENT_MODE = 'commit';

      const result = await run();

      expect(result.status).toBe('COMPLETED');
      expect(result.exitCode).toBe(0);
      await expect(readFile(path.join(repo.root, 'feature.js'), 'utf8')).resolves.toContain(
        'feature = 1',
      );
      // Pas de clone : le commit est allé directement dans le repo principal.
      const log = await repo.git.log({ maxCount: 1 });
      expect(log.latest.message).toContain('feat: travail du faux agent');

      // Dépublication : la session ne bloque plus rien après coup.
      expect(await readMainSession(repo.root)).toBeNull();
    });

    it('arrêt demandé (Ctrl+C) : l’agent est tué ET la session principale dépubliée', async () => {
      process.env.FAKE_AGENT_MODE = 'hang';
      const controller = new AbortController();
      const pending = run({ signal: controller.signal });
      await vi.waitFor(async () => expect(await readMainSession(repo.root)).not.toBeNull(), {
        timeout: 10_000,
      });
      controller.abort();
      const result = await pending;
      expect(result.status).toBe('CANCELLED');
      expect(await readMainSession(repo.root)).toBeNull();
    });

    it("régression bug 2 : profil invalide échoue avant toute réservation, ne publie ni n'efface une session existante", async () => {
      expect(await readMainSession(repo.root)).toBeNull();

      await expect(run({ profile: 'inconnu' })).rejects.toMatchObject({ code: 'PROFILE_UNKNOWN' });

      // Rien publié : resolveAgentProfile a throw avant toute réservation.
      expect(await readMainSession(repo.root)).toBeNull();

      // Repris avec une session déjà vivante (simule un AUTRE process) : le
      // `finally` qui dépublie sans condition ne doit être atteint QUE si
      // CET appel a lui-même réussi sa réservation — un profil invalide fait
      // échouer avant, donc ne doit jamais effacer l'entrée d'un autre.
      await startMainSession(repo.root, { pid: process.pid, reason: 'autre chose' });

      await expect(run({ profile: 'inconnu' })).rejects.toMatchObject({ code: 'PROFILE_UNKNOWN' });

      const session = await readMainSession(repo.root);
      expect(session).toMatchObject({ pid: process.pid, reason: 'autre chose' });
      await stopMainSession(repo.root);
    });

    it('sortie non nulle : FAILED, PID quand même dépublié (finally)', async () => {
      process.env.FAKE_AGENT_MODE = 'fail';

      const result = await run();

      expect(result.status).toBe('FAILED');
      expect(result.exitCode).toBe(3);
      expect(await readMainSession(repo.root)).toBeNull();
    });

    it('session déjà vivante : un second appel refuse avec MAIN_SESSION_LIVE', async () => {
      // Simule une première session en cours (le hook onSpawn n'est pas
      // observable de l'extérieur — on matérialise directement l'état qu'il
      // aurait publié).
      await startMainSession(repo.root, { pid: process.pid, reason: 'session déjà en cours' });

      await expect(run()).rejects.toMatchObject({
        code: 'MAIN_SESSION_LIVE',
        message: expect.stringContaining('session déjà en cours'),
      });

      // Le second appel n'a pas touché à la session déclarée par le premier.
      const session = await readMainSession(repo.root);
      expect(session).toMatchObject({ pid: process.pid, reason: 'session déjà en cours' });
      await stopMainSession(repo.root);
    });

    it("régression bug 1 : la réservation attend qu'une opération déjà en cours libère main.lock, ne s'y intercale pas", async () => {
      // Simule une opération DÉJÀ EN VOL sous withMainLock (mergeAgentCommit,
      // syncAgentWithMain, retryQueue...) : main.lock existe, détenteur vivant
      // (notre propre PID — isProcessAlive() le voit vivant), même format que
      // celui écrit par `acquire` (src/lock.js), au format hérité (sans jeton
      // ni battement). On ne passe pas par un vrai mergeAgentCommit avec Test
      // Gate lent : dans CE MÊME process, l'exclusion passerait par la file
      // en mémoire de withMainLock (réentrance par contexte asynchrone), pas
      // par le fichier. Matérialiser le verrou directement exerce la vraie
      // attente inter-process de `acquire()` — le mécanisme qui protège deux
      // VRAIS process concurrents (le scénario réel de l'incident).
      const lockFile = path.join(repo.root, '.striart', 'main.lock');
      await writeFile(
        lockFile,
        `${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), label: 'merge:agent-a (simulé)' })}\n`,
      );
      const releaseAfterMs = 1500;
      const releaseTimer = setTimeout(() => {
        rm(lockFile, { force: true }).catch(() => {});
      }, releaseAfterMs);

      process.env.FAKE_AGENT_MODE = 'commit';
      const before = Date.now();
      const result = await run();
      const elapsedMs = Date.now() - before;

      clearTimeout(releaseTimer);
      await rm(lockFile, { force: true }).catch(() => {});

      expect(result.status).toBe('COMPLETED');
      // La réservation n'a pu publier la session (et donc spawner l'agent)
      // qu'APRÈS la libération du verrou externe — pas pendant qu'il était tenu.
      expect(elapsedMs).toBeGreaterThanOrEqual(releaseAfterMs - 100);
    });
  });

  describe('reserveMainSession — striart lock --start', () => {
    it('PID explicite vivant : réserve, la vitalité est rapportée, une seconde réservation refuse', async () => {
      const session = await reserveMainSession(repo.root, {
        reason: 'édition à la main',
        pid: process.pid,
        explicitPid: true,
      });
      expect(session).toMatchObject({ pid: process.pid, reason: 'édition à la main' });
      expect(await readMainSessionStatus(repo.root)).toMatchObject({
        pid: process.pid,
        alive: true,
      });
      await expect(
        reserveMainSession(repo.root, { reason: 'autre', pid: process.pid, explicitPid: true }),
      ).rejects.toMatchObject({ code: 'MAIN_SESSION_LIVE', hint: 'striart lock --stop' });
    });

    it('PID mort → LOCK_PID_DEAD (une réservation qui ne protège rien est refusée), rien publié', async () => {
      const pid = await deadPid();
      await expect(
        reserveMainSession(repo.root, { reason: 'x', pid, explicitPid: true }),
      ).rejects.toMatchObject({ code: 'LOCK_PID_DEAD', kind: 'usage' });
      expect(await readMainSession(repo.root)).toBeNull();
    });

    it('raison vide ou PID mal formé → erreur d’usage', async () => {
      await expect(
        reserveMainSession(repo.root, { reason: '  ', pid: process.pid, explicitPid: true }),
      ).rejects.toMatchObject({ code: 'LOCK_REASON_EMPTY', kind: 'usage' });
      await expect(
        reserveMainSession(repo.root, { reason: 'x', pid: Number.NaN, explicitPid: true }),
      ).rejects.toMatchObject({ code: 'INVALID_PID', kind: 'usage' });
    });

    // Régression (audit CLI 2026-10-18) : sous Git Bash ou `cmd /c`, le
    // parent de la CLI meurt avec elle ; la réservation était publiée puis
    // désarmée dès le retour de la commande, sans aucun avertissement.
    it('PID implicite qui n’est pas un shell interactif → LOCK_PID_EPHEMERAL, commande --pid proposée', async () => {
      const holder = execa(process.execPath, ['-e', 'setInterval(() => {}, 1000)']);
      try {
        await expect(
          reserveMainSession(repo.root, { reason: 'x', pid: holder.pid, explicitPid: false }),
        ).rejects.toMatchObject({
          code: 'LOCK_PID_EPHEMERAL',
          kind: 'usage',
          details: { reason: 'NOT_A_SHELL', image: 'node' },
          hint: expect.stringContaining('--pid'),
        });
        expect(await readMainSession(repo.root)).toBeNull();
      } finally {
        holder.kill();
        await holder.catch(() => {});
      }
    });
  });
});

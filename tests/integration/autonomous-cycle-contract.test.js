/**
 * Contrat de la primitive de fin de session (`src/autonomous-cycle.ts`) — revue
 * du noyau de fiabilité (K-I1, K-I2 et les écarts d'équivalence avec l'ancien
 * `runAutonomousTask`) :
 *
 *  - `commitPolicy: 'human'` conserve TOUJOURS le clone, même si l'agent a
 *    committé (HUMAN_REVIEW_REQUIRED) ;
 *  - un commit déjà dans la cible (`UP_TO_DATE`) reste un succès MAIS bruyant :
 *    avertissement ALREADY_INTEGRATED + événement, pour tous les consommateurs
 *    (cycle autonome, proxy ACP, modes orchestrés) ;
 *  - la branche de TÂCHE (refs/heads) fait foi pour « rien à merger » ;
 *  - une annulation (Ctrl+C) n'émet pas d'événement `session:failed` ;
 *  - `sessionPid` désigne CE process dès le lancement de l'agent (aucune
 *    fenêtre sans garde entre la mort de l'agent et le commit Striart).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { simpleGit } from 'simple-git';
import { createTempRepo } from '../helpers/temp-repo.js';
import { initStriart } from '../../src/init.js';
import { createAgent, readRegistry } from '../../src/clone.js';
import { mergeAgentCommit, runAutonomousTask } from '../../src/orchestrator.js';
import { onStriartEvent } from '../../src/events.js';
import { concludeProxySession } from '../../src/acp-agent/cycle.ts';
import { finalizeClone } from '../../src/orchestration/unit.ts';
import { loadConfig } from '../../src/config.js';
import { isProcessAlive } from '../../src/process-tree.js';
import { logger } from '../../src/logger.js';
import { concludeUnstartedClone } from '../../src/autonomous-cycle.ts';

const FAKE_AGENT = fileURLToPath(new URL('../helpers/fake-agent.cjs', import.meta.url));
const GATE_OK = 'node -e "process.exit(0)"';
const GATE_KO = 'node -e "console.error(\'jamais exécuté\'); process.exit(1)"';
const exists = async (p) => Boolean(await stat(p).catch(() => null));

const DETACHED_AGENT = `
const { writeFileSync } = require('node:fs');
const { execFileSync } = require('node:child_process');
const git = (args) => execFileSync('git', args, { stdio: 'pipe' }).toString().trim();
git(['checkout', '--detach']);
writeFileSync('ailleurs.js', 'export const ailleurs = 1;\\n');
git(['add', '-A']);
git(['-c', 'user.email=a@example.com', '-c', 'user.name=Agent', 'commit', '-m', 'feat: hors branche']);
`;

async function setConfig(root, config, extraProfiles = {}) {
  await writeFile(
    path.join(root, '.striartrc.json'),
    JSON.stringify({
      agentProfiles: {
        fake: { command: process.execPath, args: [FAKE_AGENT, '{{prompt}}'] },
        ...extraProfiles,
      },
      ...config,
    }),
  );
}

function mockRouter(files) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ ok: true, json: async () => ({ response: JSON.stringify({ files }) }) })),
  );
}

describe('fin de session autonome — contrat (intégration)', () => {
  let repo;
  let events;
  let unsubscribe;

  beforeEach(async () => {
    repo = await createTempRepo();
    await initStriart(repo.root);
    mockRouter(['feature.js']);
    events = [];
    unsubscribe = onStriartEvent((_config, event) => {
      events.push(event);
    });
  });

  afterEach(async () => {
    unsubscribe();
    vi.unstubAllGlobals();
    delete process.env.FAKE_AGENT_MODE;
    await repo.cleanup();
  });

  const run = (extra = {}) =>
    runAutonomousTask({
      root: repo.root,
      agent: 'agent-a',
      prompt: 'ajoute une feature',
      profile: 'fake',
      ...extra,
    });

  it("commitPolicy 'human' : l'agent a committé → AUCUN merge, clone conservé (HUMAN_REVIEW_REQUIRED)", async () => {
    await setConfig(repo.root, {
      gateContainer: 'process',
      testCommand: GATE_OK,
      commitPolicy: 'human',
    });
    process.env.FAKE_AGENT_MODE = 'commit';

    const result = await run();

    expect(result.status).toBe('KEPT');
    expect(result.keptCode).toBe('HUMAN_REVIEW_REQUIRED');
    expect(result.keptDetail).toBe('human');
    expect(result.merge).toBeNull();
    expect(result.cleaned).toBe(false);
    expect(result.keptReason).toMatch(/human/);
    expect(await exists(result.clonePath)).toBe(true);
    // Rien n'a atteint la cible : la revue humaine précède tout merge.
    expect(await exists(path.join(repo.root, 'feature.js'))).toBe(false);
    const registry = await readRegistry(repo.root);
    expect(registry['agent-a']).toBeDefined();
    expect(registry['agent-a'].sessionPid ?? null).toBeNull();
  });

  it("commitPolicy 'human' propre au profil : même conservation", async () => {
    await setConfig(
      repo.root,
      { gateContainer: 'process', testCommand: GATE_OK },
      {
        revue: {
          command: process.execPath,
          args: [FAKE_AGENT, '{{prompt}}'],
          commitPolicy: 'human',
        },
      },
    );
    process.env.FAKE_AGENT_MODE = 'commit';

    const result = await run({ profile: 'revue' });

    expect(result.status).toBe('KEPT');
    expect(result.keptCode).toBe('HUMAN_REVIEW_REQUIRED');
    expect(result.merge).toBeNull();
    expect(await exists(path.join(repo.root, 'feature.js'))).toBe(false);
  });

  it('un commit fait hors de la branche de tâche (HEAD détaché) ne compte pas : EMPTY, pas de merge', async () => {
    const script = path.join(repo.root, '.striart', 'detached-agent.cjs');
    await writeFile(script, DETACHED_AGENT);
    await setConfig(
      repo.root,
      { gateContainer: 'process', testCommand: GATE_KO },
      { detached: { command: process.execPath, args: [script, '{{prompt}}'] } },
    );

    const result = await run({ profile: 'detached' });

    expect(result.status).toBe('EMPTY');
    expect(result.keptCode).toBe('NO_COMMIT');
    expect(result.merge).toBeNull();
    expect(await exists(result.clonePath)).toBe(true);
  });

  it("annulation (Ctrl+C) : session CANCELLED, aucun événement 'session:failed' (le webhook n'annonce pas l'arrêt voulu)", async () => {
    await setConfig(repo.root, { gateContainer: 'process', testCommand: GATE_OK });
    process.env.FAKE_AGENT_MODE = 'hang';
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 1500);

    const result = await run({ signal: controller.signal });

    expect(result.session.status).toBe('CANCELLED');
    expect(result.status).toBe('SESSION_FAILED');
    expect(events.filter((e) => e.type === 'session:failed')).toEqual([]);
  });

  it("session en échec (code ≠ 0) : l'événement 'session:failed' reste émis", async () => {
    await setConfig(repo.root, { gateContainer: 'process', testCommand: GATE_OK });
    process.env.FAKE_AGENT_MODE = 'fail';

    await run();

    const failed = events.filter((e) => e.type === 'session:failed');
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchObject({ agent: 'agent-a', status: 'FAILED' });
  });

  it("sessionPid : le PID de l'AGENT (vivant) est publié dès le spawn — un orchestrateur tué n'ouvre pas le clone — puis dépublié", async () => {
    await setConfig(repo.root, { testCommand: GATE_OK });
    process.env.FAKE_AGENT_MODE = 'hang';
    const controller = new AbortController();

    const pending = run({ signal: controller.signal });
    let published = null;
    for (let i = 0; i < 200 && (published === null || published === process.pid); i += 1) {
      await new Promise((r) => setTimeout(r, 50));
      const meta = (await readRegistry(repo.root))['agent-a'];
      published = meta?.sessionPid ?? null;
    }
    const alive = published !== null && isProcessAlive(published);
    controller.abort();
    await pending;

    expect(published).not.toBeNull();
    expect(published).not.toBe(process.pid);
    expect(alive).toBe(true);
    expect((await readRegistry(repo.root))['agent-a'].sessionPid ?? null).toBeNull();
  });
});

describe('catch muets de la primitive de fin de session (K-M1)', () => {
  it('dépublication du PID en échec (agent absent du registre) : journalisée, jamais muette', async () => {
    const repo = await createTempRepo();
    try {
      await initStriart(repo.root);
      const warn = vi.spyOn(logger, 'warn');
      await concludeUnstartedClone({
        root: repo.root,
        meta: {
          name: 'fantome',
          path: path.join(repo.root, '.striart', 'agents', 'fantome'),
          branch: 'striart/fantome/task-x',
          taskId: 'x',
          baseCommit: 'a'.repeat(40),
        },
        wording: 'runner',
      }).catch(() => {});

      expect(warn.mock.calls.some((call) => call[0]?.agent === 'fantome')).toBe(true);
      warn.mockRestore();
    } finally {
      await repo.cleanup();
    }
  });
});

describe('commit déjà dans la cible (UP_TO_DATE) — succès bruyant partout (intégration)', () => {
  let repo;
  let events;
  let unsubscribe;

  /** Clone supervisé dont le commit est amené dans la cible par fast-forward. */
  async function agentAlreadyInTarget() {
    const info = await createAgent({ root: repo.root, name: 'agent-a' });
    const git = simpleGit(info.path);
    await git.addConfig('user.name', 'Agent');
    await git.addConfig('user.email', 'agent@example.com');
    await writeFile(path.join(info.path, 'feature.js'), 'export const feature = 1;\n');
    await git.add(['feature.js']);
    await git.commit('feat: feature');
    const sha = (await git.revparse(['HEAD'])).trim();
    await repo.git.raw(['fetch', '-q', info.path, info.branch]);
    await repo.git.raw(['merge', '-q', '--ff-only', 'FETCH_HEAD']);
    const meta = (await readRegistry(repo.root))['agent-a'];
    return { sha, meta: { ...meta, name: 'agent-a' } };
  }

  beforeEach(async () => {
    repo = await createTempRepo();
    await initStriart(repo.root);
    await setConfig(repo.root, { gateContainer: 'process', testCommand: GATE_KO });
    events = [];
    unsubscribe = onStriartEvent((_config, event) => {
      events.push(event);
    });
  });

  afterEach(async () => {
    unsubscribe();
    await repo.cleanup();
  });

  it('mergeAgentCommit : UP_TO_DATE { alreadyMerged, mergeSha } — mergeSha est le commit de la cible qui porte le travail', async () => {
    const { sha } = await agentAlreadyInTarget();

    const result = await mergeAgentCommit({ root: repo.root, agent: 'agent-a' });

    expect(result).toMatchObject({ status: 'UP_TO_DATE', alreadyMerged: true, sha });
    // Le fast-forward a posé le commit de l'agent lui-même en tête de la cible.
    expect(result.mergeSha).toBe(sha);
  });

  it('mergeAgentCommit : second appel après un merge réel → UP_TO_DATE alreadyMerged, mergeSha = le commit de merge', async () => {
    await setConfig(repo.root, { gateContainer: 'process', testCommand: GATE_OK });
    const info = await createAgent({ root: repo.root, name: 'agent-b' });
    const git = simpleGit(info.path);
    await git.addConfig('user.name', 'Agent');
    await git.addConfig('user.email', 'agent@example.com');
    await writeFile(path.join(info.path, 'b.js'), 'export const b = 1;\n');
    await git.add(['b.js']);
    await git.commit('feat: b');
    const first = await mergeAgentCommit({ root: repo.root, agent: 'agent-b' });
    expect(first.status).toBe('MERGED');

    const second = await mergeAgentCommit({ root: repo.root, agent: 'agent-b' });

    expect(second).toMatchObject({ status: 'UP_TO_DATE', alreadyMerged: true });
    expect(second.mergeSha).toBe(first.mergeSha);
  });

  it('proxy ACP : MERGED + mergeSha + avertissement ALREADY_INTEGRATED + événement, clone nettoyé, Test Gate non rejoué', async () => {
    const { sha, meta } = await agentAlreadyInTarget();
    const config = await loadConfig(repo.root);

    const outcome = await concludeProxySession({
      root: repo.root,
      config,
      meta,
      profileKey: 'fake',
      profile: { command: process.execPath, args: [] },
      session: { status: 'COMPLETED', logPath: path.join(repo.root, 'x.log') },
      prompt: 'tâche',
      merge: true,
      deferredReason: 'MANUAL',
    });

    expect(outcome.status).toBe('MERGED');
    expect(outcome.cleaned).toBe(true);
    expect(outcome.merge).toMatchObject({
      status: 'UP_TO_DATE',
      alreadyMerged: true,
      mergeSha: sha,
    });
    expect(outcome.warnings).toEqual(['ALREADY_INTEGRATED']);
    expect(events.filter((e) => e.type === 'session:already-integrated')).toEqual([
      expect.objectContaining({ agent: 'agent-a', sha }),
    ]);
  });

  it('modes orchestrés (finalizeClone) : MERGED avec merge { sha, mergeSha, alreadyMerged }', async () => {
    const { sha, meta } = await agentAlreadyInTarget();

    const final = await finalizeClone({ root: repo.root }, meta);

    expect(final.status).toBe('MERGED');
    expect(final.kept).toBe(false);
    expect(final.merge).toEqual({ sha, mergeSha: sha, alreadyMerged: true });
    expect(events.filter((e) => e.type === 'session:already-integrated')).toHaveLength(1);
  });

  it("modes orchestrés (finalizeClone) + commitPolicy 'human' : KEPT / HUMAN_REVIEW_REQUIRED, aucun merge, clone conservé", async () => {
    await setConfig(repo.root, {
      gateContainer: 'process',
      testCommand: GATE_OK,
      commitPolicy: 'human',
    });
    const info = await createAgent({ root: repo.root, name: 'agent-h' });
    const git = simpleGit(info.path);
    await git.addConfig('user.name', 'Agent');
    await git.addConfig('user.email', 'agent@example.com');
    await writeFile(path.join(info.path, 'h.js'), 'export const h = 1;\n');
    await git.add(['h.js']);
    await git.commit('feat: h');
    const meta = { ...(await readRegistry(repo.root))['agent-h'], name: 'agent-h' };

    const final = await finalizeClone({ root: repo.root }, meta);

    expect(final).toMatchObject({
      status: 'KEPT',
      detail: 'HUMAN_REVIEW_REQUIRED',
      kept: true,
      merge: null,
    });
    expect(await exists(info.path)).toBe(true);
    expect(await exists(path.join(repo.root, 'h.js'))).toBe(false);
  });
});

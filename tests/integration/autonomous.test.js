import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTempRepo } from '../helpers/temp-repo.js';
import { initStriart } from '../../src/init.js';
import { readRegistry } from '../../src/clone.js';
import { runAutonomousTask } from '../../src/orchestrator.js';

const FAKE_AGENT = fileURLToPath(new URL('../helpers/fake-agent.cjs', import.meta.url));
const GATE_OK = 'node -e "process.exit(0)"';
const GATE_KO = 'node -e "console.error(\'tests cassés\'); process.exit(1)"';

/** Profil pointant sur le faux agent — même contrat que claude/codex/aider. */
const fakeProfile = { command: process.execPath, args: [FAKE_AGENT, '{{prompt}}'] };

async function setConfig(root, config) {
  await writeFile(
    path.join(root, '.striartrc.json'),
    JSON.stringify({ agentProfiles: { fake: fakeProfile }, ...config }),
  );
}

function mockRouter(files) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ ok: true, json: async () => ({ response: JSON.stringify({ files }) }) })),
  );
}

const exists = async (p) => Boolean(await stat(p).catch(() => null));

describe('mode autonome — cycle complet (intégration)', () => {
  let repo;

  beforeEach(async () => {
    repo = await createTempRepo();
    await initStriart(repo.root);
    mockRouter(['feature.js']);
  });

  afterEach(async () => {
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

  it('chemin vert : session → merge → gate → clone supprimé', async () => {
    await setConfig(repo.root, { testCommand: GATE_OK });
    process.env.FAKE_AGENT_MODE = 'commit';

    const result = await run();

    expect(result.status).toBe('MERGED');
    expect(result.session.status).toBe('COMPLETED');
    expect(result.merge.status).toBe('MERGED');
    expect(result.cleaned).toBe(true);
    expect(result.keptReason).toBeNull();

    // Le travail est bien dans main, et l'agent a disparu du registre.
    const merged = await readFile(path.join(repo.root, 'feature.js'), 'utf8');
    expect(merged).toContain('export const feature');
    expect(await readRegistry(repo.root)).toEqual({});
    expect(await exists(result.clonePath)).toBe(false);

    // Le log de session survit à la suppression du clone : c'est la seule
    // trace de ce qu'a fait un agent que personne n'a regardé travailler.
    expect(await exists(result.session.logPath)).toBe(true);
  });

  it('NE SUPPRIME PAS le clone quand l’agent laisse du travail non commité', async () => {
    // Garde-fou central du mode autonome : le merge réussit (le commit est
    // bon), mais le worktree contient encore du travail en cours. Le
    // supprimer détruirait du code que personne n'a relu.
    await setConfig(repo.root, { testCommand: GATE_OK });
    process.env.FAKE_AGENT_MODE = 'dirty';

    const result = await run();

    expect(result.status).toBe('MERGED');
    expect(result.merge.status).toBe('MERGED');
    expect(result.cleaned).toBe(false);
    expect(result.keptReason).toMatch(/PENDING/);
    expect(await exists(result.clonePath)).toBe(true);
    expect(await exists(path.join(result.clonePath, 'brouillon.js'))).toBe(true);
  });

  it('sortie 0 sans commit → EMPTY, ni merge ni suppression', async () => {
    await setConfig(repo.root, { testCommand: GATE_OK });
    process.env.FAKE_AGENT_MODE = 'noop';

    const result = await run();

    expect(result.status).toBe('EMPTY');
    expect(result.session.status).toBe('COMPLETED');
    expect(result.merge).toBeNull();
    expect(result.cleaned).toBe(false);
    expect(await exists(result.clonePath)).toBe(true);
  });

  it('sortie non nulle → SESSION_FAILED, clone conservé pour diagnostic', async () => {
    await setConfig(repo.root, { testCommand: GATE_OK });
    process.env.FAKE_AGENT_MODE = 'fail';

    const result = await run();

    expect(result.status).toBe('SESSION_FAILED');
    expect(result.session.status).toBe('FAILED');
    expect(result.session.exitCode).toBe(3);
    expect(result.cleaned).toBe(false);
    expect(await exists(result.clonePath)).toBe(true);
  });

  it('Test Gate rouge → MERGE_BLOCKED, clone conservé (règle d’or n°2)', async () => {
    await setConfig(repo.root, { testCommand: GATE_KO });
    process.env.FAKE_AGENT_MODE = 'commit';

    const result = await run();

    expect(result.status).toBe('MERGE_BLOCKED');
    expect(result.merge.status).toBe('GATE_FAILED');
    expect(result.cleaned).toBe(false);
    expect(await exists(result.clonePath)).toBe(true);

    // Le gate rouge n'a rien laissé passer dans main.
    expect(await exists(path.join(repo.root, 'feature.js'))).toBe(false);
  });

  it('session qui ne rend jamais la main → TIMEOUT, arbre de process tué', async () => {
    await setConfig(repo.root, { testCommand: GATE_OK });
    process.env.FAKE_AGENT_MODE = 'hang';

    const result = await run({ timeoutMs: 2000 });

    expect(result.status).toBe('SESSION_FAILED');
    expect(result.session.status).toBe('TIMEOUT');
    expect(result.session.timedOut).toBe(true);
    expect(await exists(result.clonePath)).toBe(true);
  });

  it('profil inconnu : échec AVANT tout clonage, aucun orphelin', async () => {
    await setConfig(repo.root, { testCommand: GATE_OK });

    await expect(run({ profile: 'inexistant' })).rejects.toThrowError(/Profil d'agent inconnu/);
    expect(await readRegistry(repo.root)).toEqual({});
  });

  it('cohabite avec un agent supervisé : le watcher ne touche pas l’autonome', async () => {
    // Les deux modes tournent sur le même repo. Le watcher doit merger le
    // commit de l'agent supervisé, et laisser l'autonome à sa fin de session :
    // sinon il mergerait des commits intermédiaires, et gagnerait la course
    // contre le merge final (qui conclurait à tort à un échec).
    const { createAgent } = await import('../../src/clone.js');
    const { shouldWatcherMerge } = await import('../../src/orchestrator.js');
    await setConfig(repo.root, { testCommand: GATE_OK });

    await createAgent({ root: repo.root, name: 'humain', command: 'claude' });
    await createAgent({ root: repo.root, name: 'robot', mode: 'autonomous', profile: 'fake' });

    expect(await shouldWatcherMerge({ root: repo.root, agent: 'humain' })).toBe(true);
    expect(await shouldWatcherMerge({ root: repo.root, agent: 'robot' })).toBe(false);
    // Agent disparu du registre entre l'événement et le contrôle.
    expect(await shouldWatcherMerge({ root: repo.root, agent: 'fantome' })).toBe(false);
  });

  it('un watcher actif ne casse pas le cycle autonome (pas de double merge)', async () => {
    // Reproduction de la course réelle : un watcher tourne pendant toute la
    // session autonome. Sans le filtre de mode, il mergerait le commit de
    // l'agent avant la fin du cycle, et runAutonomousTask recevrait
    // UP_TO_DATE → MERGE_BLOCKED, clone conservé : un faux échec.
    const { watchAgents } = await import('../../src/watcher.js');
    const { shouldWatcherMerge } = await import('../../src/orchestrator.js');
    const { mergeAgentCommit } = await import('../../src/orchestrator.js');
    await setConfig(repo.root, { testCommand: GATE_OK });
    process.env.FAKE_AGENT_MODE = 'commit';

    const merges = [];
    const watcher = watchAgents({
      root: repo.root,
      usePolling: true,
      onCommit: ({ agent, branch }) => {
        if (!branch.startsWith('striart/')) return;
        // Réplique exacte de la logique du CLI.
        void shouldWatcherMerge({ root: repo.root, agent }).then(async (should) => {
          if (!should) return;
          merges.push(agent);
          await mergeAgentCommit({ root: repo.root, agent }).catch(() => {});
        });
      },
    });
    await new Promise((resolve) => watcher.on('ready', resolve));

    try {
      const result = await run();
      // Laisse au watcher le temps de réagir s'il devait le faire (à tort).
      await new Promise((resolve) => setTimeout(resolve, 1500));

      expect(result.status).toBe('MERGED');
      expect(result.cleaned).toBe(true);
      expect(merges).toEqual([]); // le watcher n'a jamais mergé l'autonome
    } finally {
      await watcher.close();
    }
  });

  it('marque le mode et le profil dans le registre pendant la session', async () => {
    await setConfig(repo.root, { testCommand: GATE_OK });
    process.env.FAKE_AGENT_MODE = 'fail'; // échoue → l'agent reste au registre

    const result = await run();

    expect(result.status).toBe('SESSION_FAILED');
    const meta = (await readRegistry(repo.root))['agent-a'];
    expect(meta.mode).toBe('autonomous');
    expect(meta.profile).toBe('fake');
  });
});

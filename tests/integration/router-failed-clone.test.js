import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { stat } from 'node:fs/promises';
import { createTempRepo } from '../helpers/temp-repo.js';
import {
  GATE_OK,
  createScriptDir,
  mockRouter,
  writeStriartConfig,
} from '../helpers/orchestration.js';
import { initStriart } from '../../src/init.js';
import { readRegistry } from '../../src/clone.js';
import { applyPlan, retryQueue, runAutonomousTask, runTask } from '../../src/orchestrator.js';
import { readQueue } from '../../src/queue.js';

const exists = async (p) => Boolean(await stat(p).catch(() => null));

// Décision utilisateur « non bloquant » : la sentinelle WHOLE_REPO (tâche vague) ne
// s'aligne plus derrière un clone dont la session a ÉCHOUÉ sans rien commiter ; une
// collision sur un fichier PRÉCIS reste bloquante dans tous les cas.
describe(
  'Router — sentinelle WHOLE_REPO et clone conservé après échec',
  { timeout: 240_000 },
  () => {
    let repo;
    let script;

    beforeEach(async () => {
      repo = await createTempRepo();
      await initStriart(repo.root);
      script = await createScriptDir();
      // `[]` = prédiction vide → tâche jugée vague (`empty-prediction`) → sentinelle `**`.
      mockRouter({
        'tâche A': ['src/a.js'],
        'même fichier que A': ['src/a.js'],
        'tâche vague': [],
      });
    });

    afterEach(async () => {
      vi.unstubAllGlobals();
      await script.cleanup();
      await repo.cleanup();
    });

    const failingA = (extraTurn = {}) =>
      script.profile('a', [{ exit: 1, sleepMs: 100, ...extraTurn }]);

    it('a échoue sans commit : la tâche vague démarre, la collision précise reste bloquante', async () => {
      await writeStriartConfig(repo.root, {
        testCommand: GATE_OK,
        agentProfiles: { a: failingA() },
      });
      const a = await runAutonomousTask({
        root: repo.root,
        agent: 'a',
        prompt: 'tâche A',
        profile: 'a',
      });
      expect(a.status).toBe('SESSION_FAILED');
      expect(a.cleaned).toBe(false);
      expect((await readRegistry(repo.root)).a).toBeTruthy();

      // Fichier PRÉCIS partagé avec le clone en échec : toujours bloqué.
      const precise = await runTask({ root: repo.root, agent: 'd', prompt: 'même fichier que A' });
      expect(precise.status).toBe('QUEUED');
      expect(precise.collisions.map((c) => c.agent)).toEqual(['a']);

      // Vague : ne s'aligne plus derrière a, et le dit.
      const vague = await runTask({ root: repo.root, agent: 'c', prompt: 'tâche vague' });
      expect(vague.status).toBe('STARTED');
      expect(vague.relaxedBlockers).toEqual([
        { agent: 'a', reason: 'SESSION_FAILED', status: 'FAILED' },
      ]);

      // La tâche précise reste en file : a est toujours là.
      const retry = await retryQueue({ root: repo.root });
      expect(retry.started).toEqual([]);
      expect((await readQueue(repo.root)).map((t) => t.agent)).toEqual(['d']);
    });

    it('un clone en échec qui porte des commits bloque toujours la tâche vague', async () => {
      await writeStriartConfig(repo.root, {
        testCommand: GATE_OK,
        agentProfiles: { a: failingA({ write: { 'a.js': 'a\n' }, commit: true }) },
      });
      const a = await runAutonomousTask({
        root: repo.root,
        agent: 'a',
        prompt: 'tâche A',
        profile: 'a',
      });
      expect(a.status).toBe('SESSION_FAILED');

      const vague = await runTask({ root: repo.root, agent: 'c', prompt: 'tâche vague' });
      expect(vague.status).toBe('QUEUED');
      expect(vague.collisions.map((c) => c.agent)).toEqual(['a']);
    });

    it('mockRouter : défaut = fichier propre à la tâche (parallèle), prédiction vide = vague sérialisée derrière les agents VIVANTS', async () => {
      const x = await runTask({ root: repo.root, agent: 'x', prompt: 'tâche isolée X' });
      const y = await runTask({ root: repo.root, agent: 'y', prompt: 'tâche isolée Y' });
      expect(x.status).toBe('STARTED');
      expect(y.status).toBe('STARTED');
      expect(x.predictedFiles).not.toEqual(y.predictedFiles);

      const vague = await runTask({ root: repo.root, agent: 'c', prompt: 'tâche vague' });
      expect(vague.status).toBe('QUEUED');
      expect(vague.task.predictedFiles).toEqual(['**']);
      expect(vague.collisions.map((c) => c.agent).sort()).toEqual(['x', 'y']);
      expect(vague.relaxedBlockers).toBeUndefined();
    });

    it('plan v2 : le nœud vague ne tombe pas en WAIT_TIMEOUT derrière le clone en échec', async () => {
      await writeStriartConfig(repo.root, {
        testCommand: GATE_OK,
        orchestration: { waitTimeoutMs: 4000, pollIntervalMs: 100 },
        agentProfiles: {
          a: failingA(),
          c: script.profile('c', [{ write: { 'c.js': 'c\n' }, commit: true }]),
        },
      });
      const result = await applyPlan({
        root: repo.root,
        planText: JSON.stringify({
          version: 2,
          mode: 'parallel',
          concurrency: 1,
          onFailure: 'skip-dependents',
          tasks: [
            { id: 'a', agent: 'a', prompt: 'tâche A', autonomous: true, profile: 'a' },
            { id: 'c', agent: 'c', prompt: 'tâche vague', autonomous: true, profile: 'c' },
          ],
        }),
      });
      expect(result.nodes.map((n) => n.status)).toEqual(['SESSION_FAILED', 'MERGED']);
      expect(await exists(`${repo.root}/c.js`)).toBe(true);
    });
  },
);

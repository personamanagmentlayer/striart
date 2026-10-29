import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { createTempRepo } from '../helpers/temp-repo.js';
import {
  GATE_NO_BAD,
  GATE_OK,
  createScriptDir,
  mockRouter,
  writeStriartConfig,
} from '../helpers/orchestration.js';
import { initStriart } from '../../src/init.ts';
import { readRegistry } from '../../src/clone.ts';
import { applyPlan } from '../../src/orchestrator.ts';

// runAgentSession réel, sauf pour l'agent désigné par `sessionHook.failFor` (lève).
const sessionHook = vi.hoisted(() => ({ failFor: null }));
vi.mock('../../src/session.js', async (importActual) => {
  const actual = await importActual();
  return {
    ...actual,
    runAgentSession: (params) => {
      if (sessionHook.failFor && params.agent === sessionHook.failFor) {
        return Promise.reject(new Error('préparation de session impossible'));
      }
      return actual.runAgentSession(params);
    },
  };
});
import { listOrchestrationState } from '../../src/orchestration/store.ts';

const exists = async (p) => Boolean(await stat(p).catch(() => null));

const racePlan = (extra = {}) =>
  JSON.stringify({
    version: 2,
    tasks: [
      {
        id: 'perf',
        mode: 'race',
        agent: 'perf',
        prompt: 'optimize the feature',
        candidates: [{ profile: 'fast' }, { profile: 'slow' }],
        ...extra,
      },
    ],
  });

// Budget motivé : un nœud orchestré enchaîne plusieurs sessions d'agent, des
// clones et un ou plusieurs merges sous Test Gate (jusqu'à 4 sessions + 2
// merges) — au-delà des 90 s calibrées pour une opération git isolée.
describe(
  'mode race (intégration) — N agents sur la même tâche, un gagnant',
  { timeout: 240_000 },
  () => {
    let repo;
    let script;

    beforeEach(async () => {
      repo = await createTempRepo();
      await initStriart(repo.root);
      script = await createScriptDir();
      // Même prédiction pour tous les candidats : ils ne doivent PAS se
      // bloquer entre eux par le Router.
      mockRouter({ optimize: ['feature.js'] });
    });

    afterEach(async () => {
      sessionHook.failFor = null;
      vi.unstubAllGlobals();
      await script.cleanup();
      await repo.cleanup();
    });

    it('first-green : le premier candidat rouge au Test Gate perd, le suivant vert gagne', async () => {
      await writeStriartConfig(repo.root, {
        testCommand: GATE_NO_BAD,
        agentProfiles: {
          fast: script.profile('fast', [{ write: { 'feature.js': '// BAD\n' }, commit: true }]),
          slow: script.profile('slow', [
            { write: { 'feature.js': '// good\n' }, commit: true, sleepMs: 1500 },
          ]),
        },
      });
      const { nodes } = await applyPlan({ root: repo.root, planText: racePlan() });
      expect(nodes[0]).toMatchObject({ kind: 'race', status: 'MERGED', agent: 'perf-2' });
      expect(nodes[0].agents).toEqual(['perf-1', 'perf-2']);
      expect(await readFile(path.join(repo.root, 'feature.js'), 'utf8')).toContain('good');
      // losers: keep (défaut) — le perdant reste au registre, son clone intact.
      expect(Object.keys(await readRegistry(repo.root))).toEqual(['perf-1']);
    });

    it('losers: clean — la session perdante est annulée et son clone supprimé', async () => {
      await writeStriartConfig(repo.root, {
        testCommand: GATE_OK,
        agentProfiles: {
          fast: script.profile('fast', [{ write: { 'feature.js': '// one\n' }, commit: true }]),
          slow: script.profile('slow', [
            { write: { 'feature.js': '// two\n' }, commit: true, stamp: 'slow', sleepMs: 120_000 },
          ]),
        },
      });
      const { nodes } = await applyPlan({
        root: repo.root,
        planText: racePlan({ losers: 'clean' }),
      });
      expect(nodes[0]).toMatchObject({ status: 'MERGED', agent: 'perf-1' });
      // La session lente a été coupée : démarrée, jamais terminée d'elle-même.
      const stamps = await script.stamps();
      expect(stamps).toContain('slow-start');
      expect(stamps).not.toContain('slow-end');
      expect(await readRegistry(repo.root)).toEqual({});
      expect(await exists(path.join(repo.root, '.striart', 'agents', 'perf-2'))).toBe(false);
    });

    it('smallest-diff : le plus petit diff vert gagne, quel que soit l’ordre d’arrivée', async () => {
      await writeStriartConfig(repo.root, {
        testCommand: GATE_OK,
        agentProfiles: {
          fast: script.profile('fast', [
            { write: { 'feature.js': `${'// line\n'.repeat(40)}` }, commit: true },
          ]),
          slow: script.profile('slow', [
            { write: { 'feature.js': '// tiny\n' }, commit: true, sleepMs: 500 },
          ]),
        },
      });
      const { nodes } = await applyPlan({
        root: repo.root,
        planText: racePlan({ pick: 'smallest-diff' }),
      });
      expect(nodes[0]).toMatchObject({ status: 'MERGED', agent: 'perf-2' });
      expect(await readFile(path.join(repo.root, 'feature.js'), 'utf8')).toMatch(
        /^\/\/ tiny\r?\n$/,
      );
    });

    it('un candidat qui lève : les autres sessions sont annulées et le groupe est clos (ERROR)', async () => {
      await writeStriartConfig(repo.root, {
        testCommand: GATE_OK,
        agentProfiles: {
          fast: script.profile('fast', [
            { write: { 'feature.js': '// one\n' }, commit: true, stamp: 'fast', sleepMs: 120_000 },
          ]),
          slow: script.profile('slow', [{ stdout: 'x' }]),
        },
      });
      // Le 2e candidat lève (erreur de préparation de session) : simulé à la frontière.
      sessionHook.failFor = 'perf-2';
      const { nodes } = await applyPlan({ root: repo.root, planText: racePlan() });
      expect(nodes[0]).toMatchObject({ kind: 'race', status: 'ERROR' });
      // La session « fast » a été coupée (démarrée, jamais terminée d'elle-même)…
      const stamps = await script.stamps();
      expect(stamps).not.toContain('fast-end');
      // …et le groupe n'est pas laissé « actif ».
      const { groups } = await listOrchestrationState(repo.root);
      const race = groups.find((g) => g.kind === 'race');
      expect(race).toMatchObject({ status: 'done', result: 'ERROR' });
    });

    it('aucun candidat vert → RACE_NO_WINNER, tous les clones conservés', async () => {
      await writeStriartConfig(repo.root, {
        testCommand: GATE_NO_BAD,
        agentProfiles: {
          fast: script.profile('fast', [{ write: { 'feature.js': '// BAD 1\n' }, commit: true }]),
          slow: script.profile('slow', [{ write: { 'feature.js': '// BAD 2\n' }, commit: true }]),
        },
      });
      const { nodes } = await applyPlan({ root: repo.root, planText: racePlan() });
      expect(nodes[0]).toMatchObject({ status: 'RACE_NO_WINNER', kept: true });
      expect(Object.keys(await readRegistry(repo.root)).sort()).toEqual(['perf-1', 'perf-2']);
    });
  },
);

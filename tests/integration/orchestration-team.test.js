import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { createTempRepo } from '../helpers/temp-repo.js';
import {
  GATE_OK,
  createScriptDir,
  mockRouter,
  writeStriartConfig,
} from '../helpers/orchestration.js';
import { initStriart } from '../../src/init.js';
import { readRegistry, updateAgentMeta } from '../../src/clone.js';
import { applyPlan } from '../../src/orchestrator.js';
import { isProcessAlive } from '../../src/process-tree.js';

const exists = async (p) => Boolean(await stat(p).catch(() => null));
const mergeCount = async (git) =>
  (await git.raw(['log', '--merges', '--format=%H'])).split('\n').filter(Boolean).length;

const teamPlan = (extra = {}, roles = null) =>
  JSON.stringify({
    version: 2,
    tasks: [
      {
        id: 'api',
        mode: 'team',
        agent: 'api',
        prompt: 'build a sum api with tests',
        roles: roles ?? [
          { name: 'backend', profile: 'backend', files: ['src/**'] },
          { name: 'tester', profile: 'tester', files: ['tests/**'] },
        ],
        ...extra,
      },
    ],
  });

// Budget motivé : un nœud orchestré enchaîne plusieurs sessions d'agent, des
// clones et un ou plusieurs merges sous Test Gate (jusqu'à 4 sessions + 2
// merges) — au-delà des 90 s calibrées pour une opération git isolée.
describe(
  'mode team (intégration) — collaboration intra-clone à deux rôles',
  { timeout: 240_000 },
  () => {
    let repo;
    let script;

    beforeEach(async () => {
      repo = await createTempRepo();
      await initStriart(repo.root);
      script = await createScriptDir();
      mockRouter();
    });

    afterEach(async () => {
      vi.unstubAllGlobals();
      await script.cleanup();
      await repo.cleanup();
    });

    it('cadence turns : un écrivain à la fois, message médié d’un rôle à l’autre, un seul merge', async () => {
      await writeStriartConfig(repo.root, {
        testCommand: GATE_OK,
        agentProfiles: {
          backend: script.profile('backend', [
            {
              write: { 'src/api.js': 'export const sum = (a, b) => a + b;\n' },
              outbox: {
                messages: [{ to: 'tester', kind: 'handoff', body: 'api exports sum(a,b)' }],
                done: true,
              },
              commit: true,
            },
          ]),
          tester: script.profile('tester', [
            {
              writeIfPrompt: { 'sum(a,b)': { 'tests/api.test.js': '// covers sum\n' } },
              outbox: { done: true },
              commit: true,
            },
          ]),
        },
      });
      const { nodes } = await applyPlan({ root: repo.root, planText: teamPlan() });
      expect(nodes[0]).toMatchObject({
        kind: 'team',
        status: 'MERGED',
        rounds: 1,
        agents: ['api'],
      });
      expect(await readFile(path.join(repo.root, 'src', 'api.js'), 'utf8')).toContain('sum');
      expect(await exists(path.join(repo.root, 'tests', 'api.test.js'))).toBe(true);
      expect(await mergeCount(repo.git)).toBe(1);
      // Le briefing du 2e rôle cite le travail du 1er (faits git) et son message.
      const prompts = await script.prompts('tester');
      expect(prompts).toContain('src/api.js');
      expect(prompts).toMatch(/STRIART-UNTRUSTED[\s\S]*api exports sum\(a,b\)/);
    });

    it('pendant un tour, le clone est intouchable (SESSION_LIVE) : sessionPid vivant publié', async () => {
      // Le 1er rôle dort : on observe le registre pendant son tour.
      await writeStriartConfig(repo.root, {
        testCommand: GATE_OK,
        agentProfiles: {
          backend: script.profile('backend', [
            { write: { 'src/api.js': 'x\n' }, commit: true, sleepMs: 2500 },
          ]),
          tester: script.profile('tester', [{ write: { 'tests/a.test.js': 'x\n' }, commit: true }]),
        },
      });
      const running = applyPlan({ root: repo.root, planText: teamPlan() });
      let meta = null;
      for (let i = 0; i < 100; i += 1) {
        meta = (await readRegistry(repo.root)).api ?? null;
        if (meta?.collab?.cadence === 'turns' && meta.collab.activeRole === 'backend') break;
        await new Promise((r) => setTimeout(r, 100));
      }
      expect(meta?.collab).toMatchObject({ kind: 'team', cadence: 'turns', activeRole: 'backend' });
      expect(isProcessAlive(meta.sessionPid)).toBe(true);
      const { nodes } = await running;
      expect(nodes[0].status).toBe('MERGED');
    });

    it('un rôle qui écrit HORS de son périmètre → SCOPE_VIOLATION, rien n’est mergé', async () => {
      await writeStriartConfig(repo.root, {
        testCommand: GATE_OK,
        agentProfiles: {
          backend: script.profile('backend', [
            { write: { 'tests/sneaky.test.js': 'x\n' }, commit: true },
          ]),
          tester: script.profile('tester', [{ write: { 'tests/a.test.js': 'x\n' }, commit: true }]),
        },
      });
      const { nodes } = await applyPlan({ root: repo.root, planText: teamPlan() });
      expect(nodes[0]).toMatchObject({ status: 'SCOPE_VIOLATION', kept: true });
      expect(await script.invocations('tester')).toBe(0);
      expect(await exists(path.join(repo.root, 'tests', 'sneaky.test.js'))).toBe(false);
    });

    it('cadence parallel : partition statique, aucun commit d’agent, un commit unique par Striart', async () => {
      await writeStriartConfig(repo.root, {
        testCommand: GATE_OK,
        agentProfiles: {
          backend: script.profile('backend', [
            { write: { 'src/api.js': 'x\n' }, stamp: 'backend', sleepMs: 1200 },
          ]),
          tester: script.profile('tester', [
            { write: { 'tests/api.test.js': 'x\n' }, stamp: 'tester', sleepMs: 1200 },
          ]),
        },
      });
      const { nodes } = await applyPlan({
        root: repo.root,
        planText: teamPlan({ cadence: 'parallel' }),
      });
      expect(nodes[0]).toMatchObject({ status: 'MERGED' });
      expect(await exists(path.join(repo.root, 'src', 'api.js'))).toBe(true);
      expect(await exists(path.join(repo.root, 'tests', 'api.test.js'))).toBe(true);
      // Les deux sessions se sont chevauchées.
      const stamps = await script.stamps();
      expect(stamps.slice(0, 2).sort()).toEqual(['backend-start', 'tester-start']);
    });

    it('cadence parallel : un agent qui commite → TEAM_COMMIT_FORBIDDEN', async () => {
      await writeStriartConfig(repo.root, {
        testCommand: GATE_OK,
        agentProfiles: {
          backend: script.profile('backend', [{ write: { 'src/api.js': 'x\n' }, commit: true }]),
          tester: script.profile('tester', [{ write: { 'tests/api.test.js': 'x\n' } }]),
        },
      });
      const { nodes } = await applyPlan({
        root: repo.root,
        planText: teamPlan({ cadence: 'parallel' }),
      });
      expect(nodes[0]).toMatchObject({ status: 'TEAM_COMMIT_FORBIDDEN', kept: true });
    });

    it('un rôle annulé par l’arrêt demandé : PID dépublié, clone conservé', async () => {
      await writeStriartConfig(repo.root, {
        testCommand: GATE_OK,
        agentProfiles: {
          backend: script.profile('backend', [{ sleepMs: 30_000 }]),
          tester: script.profile('tester', [{}]),
        },
      });
      const controller = new AbortController();
      const running = applyPlan({
        root: repo.root,
        planText: teamPlan(),
        signal: controller.signal,
      });
      for (let i = 0; i < 100; i += 1) {
        if ((await readRegistry(repo.root)).api?.collab?.activeRole === 'backend') break;
        await new Promise((r) => setTimeout(r, 100));
      }
      controller.abort();
      const result = await running;
      expect(result.nodes[0]).toMatchObject({ status: 'CANCELLED', kept: true });
      const meta = (await readRegistry(repo.root)).api;
      expect(meta.sessionPid ?? null).toBeNull();
      // Le registre reste modifiable (aucun PID fantôme).
      await updateAgentMeta(repo.root, 'api', {});
    });
  },
);

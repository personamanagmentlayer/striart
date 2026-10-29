import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { createTempRepo } from '../helpers/temp-repo.js';
import {
  GATE_OK,
  createScriptDir,
  mockRouter,
  writeStriartConfig,
} from '../helpers/orchestration.js';
import { initStriart } from '../../src/init.ts';
import { readRegistry } from '../../src/clone.ts';
import { applyPlan } from '../../src/orchestrator.ts';

const mergeCount = async (git) =>
  (await git.raw(['log', '--merges', '--format=%H'])).split('\n').filter(Boolean).length;

// Budget motivé : un nœud orchestré enchaîne plusieurs sessions d'agent, des
// clones et un ou plusieurs merges sous Test Gate (jusqu'à 4 sessions + 2
// merges) — au-delà des 90 s calibrées pour une opération git isolée.
describe(
  'mode pipeline (intégration) — la sortie validée d’une étape alimente la suivante',
  { timeout: 240_000 },
  () => {
    let repo;
    let script;

    beforeEach(async () => {
      repo = await createTempRepo();
      await initStriart(repo.root);
      script = await createScriptDir();
      mockRouter();
      await writeStriartConfig(repo.root, {
        testCommand: GATE_OK,
        agentProfiles: {
          designer: script.profile('designer', [
            {
              write: { 'schema.js': 'export const column = "jwt_version";\n' },
              commit: true,
              handoff: 'Use the column jwt_version for token revocation.',
            },
          ]),
          builder: script.profile('builder', [
            {
              // N'écrit (et donc ne commite) que si l'artefact de l'étape
              // précédente est arrivé dans son prompt.
              writeIfPrompt: { jwt_version: { 'auth.js': 'export const auth = true;\n' } },
              commit: true,
            },
          ]),
        },
      });
    });

    afterEach(async () => {
      vi.unstubAllGlobals();
      await script.cleanup();
      await repo.cleanup();
    });

    const plan = (handoff) =>
      JSON.stringify({
        version: 2,
        tasks: [
          {
            id: 'feature',
            mode: 'pipeline',
            agent: 'feat',
            handoff,
            steps: [
              { id: 'design', prompt: 'design the schema', profile: 'designer' },
              { id: 'build', prompt: 'build the auth on top of the schema', profile: 'builder' },
            ],
          },
        ],
      });

    it('handoff merge : chaque étape mergée sous Test Gate, la suivante reçoit faits + artefact', async () => {
      const { nodes } = await applyPlan({ root: repo.root, planText: plan('merge') });
      expect(nodes[0]).toMatchObject({ kind: 'pipeline', status: 'MERGED', kept: false });
      expect(nodes[0].agents).toEqual(['feat-design', 'feat-build']);
      expect(await readFile(path.join(repo.root, 'schema.js'), 'utf8')).toContain('jwt_version');
      expect(await readFile(path.join(repo.root, 'auth.js'), 'utf8')).toContain('auth');
      expect(await mergeCount(repo.git)).toBe(2);

      const prompts = await script.prompts('builder');
      // Faits calculés par Striart (fichiers mergés) + artefact encadré non fiable.
      expect(prompts).toContain('schema.js');
      expect(prompts).toMatch(/STRIART-UNTRUSTED[\s\S]*jwt_version for token revocation/);
      expect(await readRegistry(repo.root)).toEqual({});
    });

    it('handoff clone : étapes en tours de parole dans UN clone, un seul merge', async () => {
      const { nodes } = await applyPlan({ root: repo.root, planText: plan('clone') });
      expect(nodes[0]).toMatchObject({ status: 'MERGED', agents: ['feat'] });
      expect(await mergeCount(repo.git)).toBe(1);
      expect(await readFile(path.join(repo.root, 'auth.js'), 'utf8')).toContain('auth');
    });

    it('une étape en échec arrête le pipeline : l’étape suivante ne démarre pas', async () => {
      await writeStriartConfig(repo.root, {
        testCommand: GATE_OK,
        agentProfiles: {
          designer: script.profile('designer', [{ exit: 3 }]),
          builder: script.profile('builder', [{ write: { 'auth.js': 'x\n' }, commit: true }]),
        },
      });
      const { nodes } = await applyPlan({ root: repo.root, planText: plan('merge') });
      expect(nodes[0]).toMatchObject({ status: 'SESSION_FAILED', kept: true });
      expect(await script.invocations('builder')).toBe(0);
    });
  },
);

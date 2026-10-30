import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTempRepo } from '../helpers/temp-repo.js';
import {
  GATE_NO_BAD,
  GATE_OK,
  createScriptDir,
  mockRouter,
  writeStriartConfig,
} from '../helpers/orchestration.js';
import { initStriart } from '../../src/init.ts';
import { applyPlan } from '../../src/orchestrator.ts';

/**
 * Preuve d'un nœud (lot O, priorité 2 du Run Manager) : un nœud MERGED porte
 * une `evidence` construite depuis ce que le noyau a déjà mesuré — jamais
 * recalculée, jamais absente pour un succès.
 */
describe(
  'evidence bundle (intégration) — preuve attachée au résultat d’un nœud',
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

    it('tâche autonome MERGED : commit, gate vert et usage connu de l’agent', async () => {
      await writeStriartConfig(repo.root, {
        testCommand: GATE_OK,
        agentProfiles: { a: script.profile('a', [{ write: { 'a.js': 'a\n' }, commit: true }]) },
      });
      const planText = JSON.stringify({
        version: 2,
        tasks: [{ id: 'a', agent: 'a', prompt: 'task a', autonomous: true, profile: 'a' }],
      });
      const result = await applyPlan({ root: repo.root, planText });
      const node = result.nodes[0];
      expect(node.status).toBe('MERGED');
      expect(node.evidence).toMatchObject({
        objective: 'task a',
        semantic: false,
        kept: false,
        verdicts: [],
      });
      expect(node.evidence.commit).toMatchObject({
        sha: node.merge.sha,
        mergeSha: node.merge.mergeSha,
      });
      expect(node.evidence.gate).toMatchObject({ success: true, timedOut: false });
      expect(node.evidence.usage).toMatchObject({
        tokens: expect.any(Number),
        costUsd: expect.any(Number),
      });
    });

    it('tâche autonome GATE_FAILED : le journal du Test Gate est la preuve, jamais tu', async () => {
      await writeStriartConfig(repo.root, {
        testCommand: GATE_NO_BAD,
        agentProfiles: {
          a: script.profile('a', [{ write: { 'a.js': '// BAD\n' }, commit: true }]),
        },
      });
      const planText = JSON.stringify({
        version: 2,
        tasks: [{ id: 'a', agent: 'a', prompt: 'task a', autonomous: true, profile: 'a' }],
      });
      const result = await applyPlan({ root: repo.root, planText });
      const node = result.nodes[0];
      expect(node.status).toBe('MERGE_BLOCKED');
      expect(node.evidence.commit).toBeNull();
      expect(node.evidence.gate).toMatchObject({ success: false });
    });

    it('mode review MERGED : la preuve porte les verdicts déjà collectés', async () => {
      await writeStriartConfig(repo.root, {
        testCommand: GATE_OK,
        agentProfiles: {
          author: script.profile('author', [
            { write: { 'feature.js': 'export const v = 1;\n' }, commit: true },
          ]),
          reviewer: script.profile('reviewer', [
            { verdict: { verdict: 'approve', summary: 'ok' } },
          ]),
        },
      });
      const planText = JSON.stringify({
        version: 2,
        tasks: [
          {
            id: 'auth',
            mode: 'review',
            agent: 'auth',
            prompt: 'implement the feature',
            author: { profile: 'author' },
            reviewers: [{ name: 'critic', profile: 'reviewer' }],
          },
        ],
      });
      const result = await applyPlan({ root: repo.root, planText });
      const node = result.nodes[0];
      expect(node.status).toBe('MERGED');
      expect(node.evidence.objective).toBe('implement the feature');
      expect(node.evidence.verdicts.map((v) => v.verdict)).toEqual(['approve']);
      expect(node.evidence.commit).toMatchObject({ sha: node.merge.sha });
      expect(node.evidence.gate).toMatchObject({ success: true });
    });
  },
);

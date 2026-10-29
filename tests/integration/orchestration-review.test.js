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
import { initStriart } from '../../src/init.ts';
import { readRegistry } from '../../src/clone.ts';
import { applyPlan } from '../../src/orchestrator.ts';
import { answerHumanReview, listHumanReviews } from '../../src/orchestration/human-review.ts';
import { readCollabGroup } from '../../src/collab/channel.ts';

const exists = async (p) => Boolean(await stat(p).catch(() => null));

const reviewPlan = (extra = {}) =>
  JSON.stringify({
    version: 2,
    tasks: [
      {
        id: 'auth',
        mode: 'review',
        agent: 'auth',
        prompt: 'implement the feature',
        author: { profile: 'author' },
        reviewers: [{ name: 'critic', profile: 'reviewer' }],
        ...extra,
      },
    ],
  });

// Budget motivé : un nœud orchestré enchaîne plusieurs sessions d'agent, des
// clones et un ou plusieurs merges sous Test Gate (jusqu'à 4 sessions + 2
// merges) — au-delà des 90 s calibrées pour une opération git isolée.
describe(
  'mode review (intégration) — un relecteur relit le diff de l’auteur avant merge',
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

    it('refus avec remarques → l’auteur corrige avec le retour → approbation → merge sous Test Gate', async () => {
      await writeStriartConfig(repo.root, {
        testCommand: GATE_OK,
        agentProfiles: {
          author: script.profile('author', [
            { write: { 'feature.js': 'export const v = 1;\n' }, commit: true },
            // Le 2e tour ne commite que si la remarque du relecteur est arrivée
            // dans son prompt (sinon « nothing to commit » → session en échec).
            {
              writeIfPrompt: { 'missing null check': { 'feature.js': 'export const v = 2;\n' } },
              commit: true,
            },
          ]),
          reviewer: script.profile('reviewer', [
            {
              verdict: {
                verdict: 'request-changes',
                summary: 'missing null check',
                comments: [{ file: 'feature.js', severity: 'major', body: 'missing null check' }],
              },
            },
            { verdict: { verdict: 'approve', summary: 'good now' } },
          ]),
        },
      });

      const result = await applyPlan({ root: repo.root, planText: reviewPlan() });
      const node = result.nodes[0];

      expect(node).toMatchObject({ kind: 'review', status: 'MERGED', rounds: 2, kept: false });
      expect(node.verdicts.map((v) => v.verdict)).toEqual(['request-changes', 'approve']);
      expect(node.verdicts[0]).toMatchObject({ reviewer: 'critic', kind: 'agent', source: 'log' });
      expect(await readFile(path.join(repo.root, 'feature.js'), 'utf8')).toContain('v = 2');

      // Le relecteur a reçu la base de comparaison ; l'auteur, le retour ENCADRÉ
      // comme non fiable (jamais présenté comme une instruction).
      const authorPrompts = await script.prompts('author');
      expect(authorPrompts).toMatch(/STRIART-UNTRUSTED[\s\S]*missing null check/);
      expect(await script.prompts('reviewer')).toMatch(/git diff [0-9a-f]{7,40}/);

      // Cycle vert : clone supprimé, registre vide, groupe clos.
      expect(await readRegistry(repo.root)).toEqual({});
      const group = await readCollabGroup(repo.root, node.group);
      expect(group.closedAt).not.toBeNull();
    });

    it('verdict reject → REVIEW_REJECTED, rien n’est mergé, le clone est conservé', async () => {
      await writeStriartConfig(repo.root, {
        testCommand: GATE_OK,
        agentProfiles: {
          author: script.profile('author', [{ write: { 'feature.js': 'x\n' }, commit: true }]),
          reviewer: script.profile('reviewer', [
            { verdict: { verdict: 'reject', summary: 'wrong approach' } },
          ]),
        },
      });
      const { nodes } = await applyPlan({ root: repo.root, planText: reviewPlan() });
      expect(nodes[0]).toMatchObject({ status: 'REVIEW_REJECTED', kept: true, rounds: 1 });
      expect(await exists(path.join(repo.root, 'feature.js'))).toBe(false);
      expect(Object.keys(await readRegistry(repo.root))).toEqual(['auth']);
    });

    it('un relecteur qui MODIFIE le clone → READ_ONLY_VIOLATION (fail closed), rien n’est mergé', async () => {
      await writeStriartConfig(repo.root, {
        testCommand: GATE_OK,
        agentProfiles: {
          author: script.profile('author', [{ write: { 'feature.js': 'x\n' }, commit: true }]),
          reviewer: script.profile('reviewer', [
            {
              write: { 'feature.js': 'sabotage\n' },
              verdict: { verdict: 'approve', summary: 'ok' },
            },
          ]),
        },
      });
      const { nodes } = await applyPlan({ root: repo.root, planText: reviewPlan() });
      expect(nodes[0]).toMatchObject({ status: 'READ_ONLY_VIOLATION', kept: true });
      expect(await exists(path.join(repo.root, 'feature.js'))).toBe(false);
    });

    it('verdict absent → nouvelle demande (verdictRetries), puis VERDICT_INVALID', async () => {
      await writeStriartConfig(repo.root, {
        testCommand: GATE_OK,
        agentProfiles: {
          author: script.profile('author', [{ write: { 'feature.js': 'x\n' }, commit: true }]),
          reviewer: script.profile('reviewer', [{ stdout: 'LGTM!' }]),
        },
      });
      const { nodes } = await applyPlan({ root: repo.root, planText: reviewPlan() });
      expect(nodes[0]).toMatchObject({ status: 'VERDICT_INVALID', kept: true });
      expect(await script.invocations('reviewer')).toBe(2);
      expect(await exists(path.join(repo.root, 'feature.js'))).toBe(false);
    });

    it('verdict par l’outbox (.striart-outbox.json) — jamais committé avec le travail', async () => {
      await writeStriartConfig(repo.root, {
        testCommand: GATE_OK,
        agentProfiles: {
          author: script.profile('author', [
            {
              write: { 'feature.js': 'x\n' },
              // L'auteur laisse aussi un message dans l'outbox avant son commit.
              outbox: { messages: [{ to: 'critic', kind: 'note', body: 'see feature.js' }] },
              commit: true,
            },
          ]),
          reviewer: script.profile('reviewer', [
            { outbox: { verdict: { verdict: 'approve', summary: 'fine' } } },
          ]),
        },
      });
      const { nodes } = await applyPlan({ root: repo.root, planText: reviewPlan() });
      expect(nodes[0]).toMatchObject({ status: 'MERGED' });
      expect(nodes[0].verdicts[0].source).toBe('outbox');
      expect(await exists(path.join(repo.root, '.striart-outbox.json'))).toBe(false);
      // Le message de l'auteur a été médié vers le relecteur (inbox / briefing).
      expect(await script.prompts('reviewer')).toContain('see feature.js');
    });

    it('relecteur humain : la demande attend `striart review`, l’approbation déclenche le merge', async () => {
      await writeStriartConfig(repo.root, {
        testCommand: GATE_OK,
        agentProfiles: {
          author: script.profile('author', [{ write: { 'feature.js': 'x\n' }, commit: true }]),
        },
        orchestration: { pollIntervalMs: 200 },
      });
      const planText = JSON.stringify({
        version: 2,
        tasks: [
          {
            mode: 'review',
            agent: 'auth',
            prompt: 'implement',
            author: { profile: 'author' },
            reviewers: [{ name: 'lead', human: true }],
          },
        ],
      });
      const running = applyPlan({ root: repo.root, planText });
      let pending = [];
      for (let i = 0; i < 150 && pending.length === 0; i += 1) {
        pending = (await listHumanReviews(repo.root)).filter((r) => r.status === 'PENDING');
        if (pending.length === 0) await new Promise((r) => setTimeout(r, 200));
      }
      expect(pending).toHaveLength(1);
      expect(pending[0]).toMatchObject({ agent: 'auth', reviewer: 'lead', round: 1 });
      await answerHumanReview(repo.root, pending[0].id, {
        verdict: 'approve',
        summary: 'ship it',
        comments: [],
      });
      const { nodes } = await running;
      expect(nodes[0]).toMatchObject({ status: 'MERGED' });
      expect(nodes[0].verdicts[0]).toMatchObject({ kind: 'human', source: 'human' });
      await expect(
        answerHumanReview(repo.root, pending[0].id, {
          verdict: 'reject',
          summary: '',
          comments: [],
        }),
      ).rejects.toMatchObject({ code: 'REVIEW_NOT_PENDING' });
    });
  },
);

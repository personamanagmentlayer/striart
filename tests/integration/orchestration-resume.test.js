import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTempRepo } from '../helpers/temp-repo.js';
import {
  GATE_OK,
  createScriptDir,
  mockRouter,
  writeStriartConfig,
} from '../helpers/orchestration.js';
import { initStriart } from '../../src/init.ts';
import { applyPlan } from '../../src/orchestrator.ts';

/**
 * Run Manager (lot O, priorité 1) : un plan v2 interrompu persiste assez
 * d'état pour être repris sans rejouer les tâches déjà terminées. On simule
 * le "process tué" en abortant pile au moment où la tâche `a` se termine —
 * avant que le scheduler ait pu examiner `b` — plutôt qu'en tuant réellement
 * le process (impossible dans le même test), ce qui donne la même garantie :
 * `b` n'a jamais été lancée.
 */
describe('plan v2 --resume (intégration) — reprise sans doublon', { timeout: 240_000 }, () => {
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

  const profiles = () => ({
    a: script.profile('a', [{ write: { 'a.js': 'a\n' }, commit: true, stamp: 'a' }]),
    b: script.profile('b', [{ write: { 'b.js': 'b\n' }, commit: true, stamp: 'b' }]),
  });

  const twoTasks = () =>
    JSON.stringify({
      version: 2,
      tasks: [
        { id: 'a', agent: 'a', prompt: 'task a', autonomous: true, profile: 'a' },
        { id: 'b', agent: 'b', prompt: 'task b', autonomous: true, profile: 'b', after: 'a' },
      ],
    });

  it('reprend après une interruption : `a` jamais rejouée, `b` termine le plan', async () => {
    await writeStriartConfig(repo.root, { testCommand: GATE_OK, agentProfiles: profiles() });
    const ctrl = new AbortController();
    const first = await applyPlan({
      root: repo.root,
      planText: twoTasks(),
      signal: ctrl.signal,
      // Coupe le plan dès que `a` termine, avant que le scheduler ne regarde `b`.
      onProgress: (event) => {
        if (event.type === 'node-finished' && event.nodeId === 'a') ctrl.abort();
      },
    });
    expect(first.interrupted).toBe(true);
    expect(first.nodes.map((n) => [n.id, n.status])).toEqual([
      ['a', 'MERGED'],
      ['b', 'SKIPPED'],
    ]);
    expect(first.nodes[1].detail).toBe('INTERRUPTED');
    expect(first.notApplied).toEqual([{ id: 'b', agent: 'b' }]);
    expect(await script.invocations('a')).toBe(1);
    expect(await script.invocations('b')).toBe(0);

    const runId = first.run.id;
    const second = await applyPlan({
      root: repo.root,
      planText: twoTasks(),
      resume: { runId },
    });
    expect(second.run.id).toBe(runId);
    expect(second.interrupted).toBe(false);
    expect(second.nodes.map((n) => [n.id, n.status])).toEqual([
      ['a', 'MERGED'],
      ['b', 'MERGED'],
    ]);
    // `a` n'a pas été rejouée : une seule invocation malgré les deux applyPlan.
    expect(await script.invocations('a')).toBe(1);
    expect(await script.invocations('b')).toBe(1);
  });

  it('refuse de reprendre un run introuvable', async () => {
    await writeStriartConfig(repo.root, { testCommand: GATE_OK, agentProfiles: profiles() });
    await expect(
      applyPlan({
        root: repo.root,
        planText: twoTasks(),
        resume: { runId: 'run-aaaaaaaaaaaa' },
      }),
    ).rejects.toMatchObject({ code: 'ORCHESTRATION_RUN_NOT_FOUND' });
  });

  it('refuse de reprendre avec un plan différent (congruence par index)', async () => {
    await writeStriartConfig(repo.root, { testCommand: GATE_OK, agentProfiles: profiles() });
    const ctrl = new AbortController();
    const first = await applyPlan({
      root: repo.root,
      planText: twoTasks(),
      signal: ctrl.signal,
      onProgress: (event) => {
        if (event.type === 'node-finished' && event.nodeId === 'a') ctrl.abort();
      },
    });
    const otherPlan = JSON.stringify({
      version: 2,
      tasks: [{ id: 'a', agent: 'a', prompt: 'task a', autonomous: true, profile: 'a' }],
    });
    await expect(
      applyPlan({ root: repo.root, planText: otherPlan, resume: { runId: first.run.id } }),
    ).rejects.toMatchObject({ code: 'ORCHESTRATION_RESUME_MISMATCH' });
  });

  it('refuse --resume sur un plan v1', async () => {
    await writeStriartConfig(repo.root, { testCommand: GATE_OK, agentProfiles: profiles() });
    const v1 = JSON.stringify({
      version: 1,
      tasks: [{ agent: 'a', prompt: 'task a', autonomous: true, profile: 'a' }],
    });
    await expect(
      applyPlan({ root: repo.root, planText: v1, resume: { runId: 'run-aaaaaaaaaaaa' } }),
    ).rejects.toMatchObject({ code: 'PLAN_INVALID', details: { reason: 'RESUME_NEEDS_V2' } });
  });
});

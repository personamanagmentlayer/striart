import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { stat } from 'node:fs/promises';
import { createTempRepo } from '../helpers/temp-repo.js';
import {
  GATE_OK,
  createScriptDir,
  mockRouter,
  writeStriartConfig,
} from '../helpers/orchestration.js';
import { initStriart } from '../../src/init.ts';
import { applyPlan } from '../../src/orchestrator.ts';
import { buildObservabilityReport, traceRun } from '../../src/orchestration/observability.ts';

const exists = async (p) => Boolean(await stat(p).catch(() => null));

/**
 * Observabilité de bout en bout (lot O, priorité 6 du Run Manager) :
 * `traceRun` assemble run_id → task_id → essai → agent/session → commit à
 * partir de données déjà persistées ; `buildObservabilityReport` les agrège
 * sur tous les runs retenus. Rien n'est mesuré ici qui ne l'était déjà par
 * les priorités précédentes.
 */
describe('observabilité (intégration) — trace et bilan agrégé', { timeout: 240_000 }, () => {
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

  it('traceRun relie run_id → tâche → essai → agent → commit, après une reprise', async () => {
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
    const runId = first.run.id;
    await applyPlan({ root: repo.root, planText: twoTasks(), resume: { runId } });

    const trace = await traceRun(repo.root, runId);
    expect(trace.runId).toBe(runId);
    expect(trace.status).toBe('done');
    expect(trace.resumeCount).toBe(1);
    expect(trace.nodes).toHaveLength(2);

    const [a, b] = trace.nodes;
    expect(a).toMatchObject({
      taskId: 'a',
      kind: 'task',
      status: 'MERGED',
      attempt: 1,
      agent: 'a',
    });
    expect(a.commit).toMatchObject({ sha: expect.any(String), mergeSha: expect.any(String) });
    expect(a.sessionLogPath).toBeTruthy();
    expect(await exists(a.sessionLogPath)).toBe(true);
    expect(b).toMatchObject({
      taskId: 'b',
      kind: 'task',
      status: 'MERGED',
      attempt: 1,
      agent: 'b',
    });
  });

  it('refuse de tracer un run introuvable, comme --resume', async () => {
    await expect(traceRun(repo.root, 'run-aaaaaaaaaaaa')).rejects.toMatchObject({
      code: 'ORCHESTRATION_RUN_NOT_FOUND',
    });
  });

  it('buildObservabilityReport agrège taux de réussite, interventions et reprises sur les runs persistés', async () => {
    await writeStriartConfig(repo.root, {
      testCommand: GATE_OK,
      agentProfiles: {
        ...profiles(),
        human: script.profile('human', [{ write: { 'h.js': 'h\n' }, commit: true }]),
      },
    });
    // Run 1 : interrompu puis repris — compte pour une reprise après crash.
    const ctrl = new AbortController();
    const first = await applyPlan({
      root: repo.root,
      planText: twoTasks(),
      signal: ctrl.signal,
      onProgress: (event) => {
        if (event.type === 'node-finished' && event.nodeId === 'a') ctrl.abort();
      },
    });
    await applyPlan({ root: repo.root, planText: twoTasks(), resume: { runId: first.run.id } });

    // Run 2 : commitPolicy 'human' — le travail est conservé pour revue, jamais mergé seul.
    await writeStriartConfig(repo.root, {
      testCommand: GATE_OK,
      agentProfiles: {
        ...profiles(),
        human: {
          ...script.profile('human', [{ write: { 'h.js': 'h\n' }, commit: true }]),
          commitPolicy: 'human',
        },
      },
    });
    await applyPlan({
      root: repo.root,
      planText: JSON.stringify({
        version: 2,
        tasks: [
          { id: 'h', agent: 'human', prompt: 'needs review', autonomous: true, profile: 'human' },
        ],
      }),
    });

    const report = await buildObservabilityReport(repo.root);
    expect(report.totalRuns).toBe(2);
    // 3 tâches terminées au total (a, b du run 1 ; h du run 2) : 2 réussies, 1 gardée pour revue.
    expect(report.terminalNodes).toBe(3);
    expect(report.mergedNodes).toBe(2);
    expect(report.mergedTaskRate).toBeCloseTo(2 / 3);
    expect(report.humanInterventionRate).toBeCloseTo(1 / 3);
    expect(report.crashRecoveries).toBe(1);
    expect(
      report.avgCostPerMergedTask === null || typeof report.avgCostPerMergedTask === 'number',
    ).toBe(true);
  });

  it('bilan vide sans aucun run persisté', async () => {
    const report = await buildObservabilityReport(repo.root);
    expect(report).toMatchObject({
      totalRuns: 0,
      totalNodes: 0,
      terminalNodes: 0,
      mergedNodes: 0,
      mergedTaskRate: null,
      humanInterventionRate: null,
      crashRecoveries: 0,
      avgCostPerMergedTask: null,
    });
  });
});

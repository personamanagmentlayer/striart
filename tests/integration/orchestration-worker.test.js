import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createTempRepo } from '../helpers/temp-repo.js';
import {
  GATE_OK,
  createScriptDir,
  mockRouter,
  writeStriartConfig,
} from '../helpers/orchestration.js';
import { initStriart } from '../../src/init.ts';
import { applyPlan } from '../../src/orchestrator.ts';
import { loadConfig } from '../../src/config.ts';
import { parsePlan } from '../../src/plan.ts';
import { runWorker } from '../../src/orchestration/scheduler.ts';
import { claimRunNode, createRunState, loadRunState } from '../../src/orchestration/store.ts';
import { traceRun } from '../../src/orchestration/observability.ts';

/**
 * Workers coopératifs (lot O, priorité 7) : plusieurs `runWorker` (même
 * process ou process séparés partageant `.striart/`) réclament les nœuds
 * d'un MÊME run sans jamais en exécuter aucun deux fois — la garantie
 * tient au verrou d'état déjà partagé par tout `.striart/`
 * (`claimRunNode`), jamais à un pool interne.
 */
describe('claimRunNode — CAS atomique', () => {
  let root;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'striart-worker-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const nodes = (specs) =>
    specs.map((s) => ({
      id: s.id,
      kind: 'task',
      state: 'pending',
      status: null,
      agent: null,
      result: null,
    }));

  it('deux réclamations simultanées du même nœud : une seule gagne', async () => {
    const run = await createRunState(
      root,
      { mode: 'parallel', concurrency: 2, onFailure: 'stop', nodes: nodes([{ id: 'a' }]) },
      50,
    );
    const [first, second] = await Promise.all([
      claimRunNode(root, run.id, 0),
      claimRunNode(root, run.id, 0),
    ]);
    expect([first, second].filter(Boolean)).toHaveLength(1);
  });

  it('refuse de réclamer un nœud qui n’est plus pending', async () => {
    const run = await createRunState(
      root,
      { mode: 'parallel', concurrency: 2, onFailure: 'stop', nodes: nodes([{ id: 'a' }]) },
      50,
    );
    expect(await claimRunNode(root, run.id, 0)).toBe(true);
    expect(await claimRunNode(root, run.id, 0)).toBe(false);
  });

  it('refuse de réclamer un nœud dont la ressource est déjà tenue par un autre nœud running', async () => {
    const run = await createRunState(
      root,
      {
        mode: 'parallel',
        concurrency: 2,
        onFailure: 'stop',
        nodes: nodes([{ id: 'a' }, { id: 'b' }]),
      },
      50,
    );
    const resourcesOf = () => ['db']; // les deux nœuds partagent la même ressource.
    expect(await claimRunNode(root, run.id, 0, resourcesOf)).toBe(true);
    expect(await claimRunNode(root, run.id, 1, resourcesOf)).toBe(false);
    const state = await loadRunState(root, run.id);
    expect(state.nodes[1].state).toBe('pending');
  });

  it('un nœud invalide ou hors bornes n’est jamais réclamé', async () => {
    const run = await createRunState(
      root,
      { mode: 'parallel', concurrency: 2, onFailure: 'stop', nodes: nodes([{ id: 'a' }]) },
      50,
    );
    expect(await claimRunNode(root, run.id, 5)).toBe(false);
    expect(await claimRunNode(root, 'run-aaaaaaaaaaaa', 0)).toBe(false);
  });
});

describe('runWorker (intégration) — exécution sans doublon', { timeout: 240_000 }, () => {
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

  const fourIndependentTasks = () =>
    JSON.stringify({
      version: 2,
      mode: 'parallel',
      tasks: ['a', 'b', 'c', 'd'].map((id) => ({
        id,
        agent: id,
        prompt: `task ${id}`,
        autonomous: true,
        profile: id,
      })),
    });

  it('deux workers concurrents drainent le même run sans jamais exécuter une tâche deux fois', async () => {
    await writeStriartConfig(repo.root, {
      testCommand: GATE_OK,
      agentProfiles: Object.fromEntries(
        ['a', 'b', 'c', 'd'].map((id) => [
          id,
          script.profile(id, [{ write: { [`${id}.js`]: `${id}\n` }, commit: true, sleepMs: 200 }]),
        ]),
      ),
    });
    const config = await loadConfig(repo.root);
    const plan = parsePlan(fourIndependentTasks());

    const first = await runWorker({ root: repo.root, plan, config });
    const runId = first.runId;
    expect(first.joined).toBe(false);

    // Deuxième worker, lancé en PARALLÈLE du premier qui continue sa propre boucle :
    // les deux coopèrent sur le même run jusqu'à épuisement.
    const [a, b] = await Promise.all([
      runWorker({ root: repo.root, plan, config, runId }),
      runWorker({ root: repo.root, plan, config, runId }),
    ]);
    expect(a.joined).toBe(true);
    expect(b.joined).toBe(true);
    expect(a.allDone || b.allDone).toBe(true);

    for (const id of ['a', 'b', 'c', 'd']) {
      expect(await script.invocations(id)).toBe(1);
    }
    const trace = await traceRun(repo.root, runId);
    expect(trace.status).toBe('done');
    expect(trace.nodes.map((n) => n.status)).toEqual(['MERGED', 'MERGED', 'MERGED', 'MERGED']);
    // Chaque tâche réclamée par EXACTEMENT un des trois appels (le premier a pu
    // en prendre certaines avant que les deux autres ne démarrent).
    expect(first.claimed + a.claimed + b.claimed).toBe(4);
  });

  it('une ressource partagée reste exclusive même réclamée par deux workers concurrents', async () => {
    await writeStriartConfig(repo.root, {
      testCommand: GATE_OK,
      agentProfiles: {
        a: script.profile('a', [
          { write: { 'a.js': 'a\n' }, commit: true, stamp: 'a', sleepMs: 500 },
        ]),
        b: script.profile('b', [{ write: { 'b.js': 'b\n' }, commit: true, stamp: 'b' }]),
      },
    });
    const config = await loadConfig(repo.root);
    const tasks = [
      { id: 'a', agent: 'a', prompt: 'task a', autonomous: true, profile: 'a', resources: ['db'] },
      { id: 'b', agent: 'b', prompt: 'task b', autonomous: true, profile: 'b', resources: ['db'] },
    ];
    const plan = parsePlan(JSON.stringify({ version: 2, mode: 'parallel', tasks }));
    // Run créé à part (pas encore drainé) pour que les deux workers ci-dessous
    // le rejoignent VRAIMENT en même temps, plutôt que l'un ne crée le sien.
    const run = await createRunState(
      repo.root,
      {
        mode: 'parallel',
        concurrency: 2,
        onFailure: 'stop',
        nodes: tasks.map((t) => ({
          id: t.id,
          kind: 'task',
          state: 'pending',
          status: null,
          agent: null,
          result: null,
        })),
      },
      50,
    );
    const [w1, w2] = await Promise.all([
      runWorker({ root: repo.root, plan, config, runId: run.id }),
      runWorker({ root: repo.root, plan, config, runId: run.id }),
    ]);
    expect(w1.joined).toBe(true);
    expect(w2.joined).toBe(true);
    expect(w1.allDone || w2.allDone).toBe(true);
    const trace = await traceRun(repo.root, run.id);
    expect(trace.nodes.map((n) => n.status)).toEqual(['MERGED', 'MERGED']);
    // Jamais le chevauchement, même réparties entre deux workers : la
    // ressource partagée les a sérialisées.
    expect(await script.stamps()).toEqual(['a-start', 'a-end', 'b-start', 'b-end']);
  });

  it('rejoint un run existant (créé par applyPlan), le termine sans rejouer les tâches faites', async () => {
    await writeStriartConfig(repo.root, {
      testCommand: GATE_OK,
      agentProfiles: {
        a: script.profile('a', [{ write: { 'a.js': 'a\n' }, commit: true }]),
        b: script.profile('b', [{ write: { 'b.js': 'b\n' }, commit: true }]),
      },
    });
    const ctrl = new AbortController();
    const first = await applyPlan({
      root: repo.root,
      planText: JSON.stringify({
        version: 2,
        tasks: [
          { id: 'a', agent: 'a', prompt: 'task a', autonomous: true, profile: 'a' },
          { id: 'b', agent: 'b', prompt: 'task b', autonomous: true, profile: 'b', after: 'a' },
        ],
      }),
      signal: ctrl.signal,
      onProgress: (event) => {
        if (event.type === 'node-finished' && event.nodeId === 'a') ctrl.abort();
      },
    });
    expect(await script.invocations('b')).toBe(0);

    const config = await loadConfig(repo.root);
    const plan = parsePlan(
      JSON.stringify({
        version: 2,
        tasks: [
          { id: 'a', agent: 'a', prompt: 'task a', autonomous: true, profile: 'a' },
          { id: 'b', agent: 'b', prompt: 'task b', autonomous: true, profile: 'b', after: 'a' },
        ],
      }),
    );
    const worker = await runWorker({ root: repo.root, plan, config, runId: first.run.id });
    expect(worker.joined).toBe(true);
    expect(worker.allDone).toBe(true);
    expect(worker.claimed).toBe(1); // seule `b` restait à réclamer.
    expect(await script.invocations('a')).toBe(1);
    expect(await script.invocations('b')).toBe(1);
  });

  it('refuse de rejoindre un run introuvable', async () => {
    await writeStriartConfig(repo.root, {
      testCommand: GATE_OK,
      agentProfiles: { a: script.profile('a', [{ write: { 'a.js': 'a\n' }, commit: true }]) },
    });
    const config = await loadConfig(repo.root);
    const plan = parsePlan(
      JSON.stringify({
        version: 2,
        tasks: [{ id: 'a', agent: 'a', prompt: 'task a', autonomous: true, profile: 'a' }],
      }),
    );
    await expect(
      runWorker({ root: repo.root, plan, config, runId: 'run-aaaaaaaaaaaa' }),
    ).rejects.toMatchObject({ code: 'ORCHESTRATION_RUN_NOT_FOUND' });
  });

  it('refuse de rejoindre avec un plan différent (congruence par index)', async () => {
    await writeStriartConfig(repo.root, {
      testCommand: GATE_OK,
      agentProfiles: { a: script.profile('a', [{ write: { 'a.js': 'a\n' }, commit: true }]) },
    });
    const config = await loadConfig(repo.root);
    const onlyA = parsePlan(
      JSON.stringify({
        version: 2,
        tasks: [{ id: 'a', agent: 'a', prompt: 'task a', autonomous: true, profile: 'a' }],
      }),
    );
    const created = await runWorker({ root: repo.root, plan: onlyA, config });
    // Même profil (déjà configuré) pour que la validation des profils passe
    // et que ce soit bien la CONGRUENCE (id de tâche différent) qui refuse.
    const differentPlan = parsePlan(
      JSON.stringify({
        version: 2,
        tasks: [{ id: 'z', agent: 'z', prompt: 'task z', autonomous: true, profile: 'a' }],
      }),
    );
    await expect(
      runWorker({ root: repo.root, plan: differentPlan, config, runId: created.runId }),
    ).rejects.toMatchObject({ code: 'ORCHESTRATION_RESUME_MISMATCH' });
  });
});

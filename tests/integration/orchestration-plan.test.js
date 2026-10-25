import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { createTempRepo } from '../helpers/temp-repo.js';
import {
  GATE_OK,
  createScriptDir,
  mockRouter,
  writeStriartConfig,
} from '../helpers/orchestration.js';
import { initStriart } from '../../src/init.js';
import { readRegistry } from '../../src/clone.js';
import { applyPlan, stopAgent } from '../../src/orchestrator.js';
import { collectStatus } from '../../src/status.ts';

const exists = async (p) => Boolean(await stat(p).catch(() => null));

// Budget motivé : un nœud orchestré enchaîne plusieurs sessions d'agent, des
// clones et un ou plusieurs merges sous Test Gate (jusqu'à 4 sessions + 2
// merges) — au-delà des 90 s calibrées pour une opération git isolée.
describe('plan v2 (intégration) — sequential / parallel / onFailure', { timeout: 240_000 }, () => {
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

  const profiles = (extra = {}) => ({
    a: script.profile('a', [{ write: { 'a.js': 'a\n' }, commit: true, stamp: 'a', sleepMs: 1200 }]),
    b: script.profile('b', [{ write: { 'b.js': 'b\n' }, commit: true, stamp: 'b', sleepMs: 1200 }]),
    ...extra,
  });

  const twoTasks = (planExtra = {}, bAfter = undefined) =>
    JSON.stringify({
      version: 2,
      ...planExtra,
      tasks: [
        { id: 'a', agent: 'a', prompt: 'task a', autonomous: true, profile: 'a' },
        {
          id: 'b',
          agent: 'b',
          prompt: 'task b',
          autonomous: true,
          profile: 'b',
          ...(bAfter ? { after: bAfter } : {}),
        },
      ],
    });

  it('parallel : deux tâches indépendantes se chevauchent (concurrency 2)', async () => {
    // Barrière : `a` ne finit que lorsque `b` a démarré — impossible en série
    // (a sortirait en 7 au bout de 60 s). Preuve déterministe, sans minutage.
    const barrier = `${script.dir}/b-started`;
    await writeStriartConfig(repo.root, {
      testCommand: GATE_OK,
      agentProfiles: profiles({
        a: script.profile('a', [
          { write: { 'a.js': 'a\n' }, commit: true, stamp: 'a', waitFor: barrier },
        ]),
        b: script.profile('b', [
          { write: { 'b.js': 'b\n' }, commit: true, stamp: 'b', touch: barrier },
        ]),
      }),
    });
    const result = await applyPlan({
      root: repo.root,
      planText: twoTasks({ mode: 'parallel', concurrency: 2 }),
    });
    expect(result.nodes.map((n) => n.status)).toEqual(['MERGED', 'MERGED']);
    const stamps = await script.stamps();
    expect(stamps.indexOf('b-start')).toBeLessThan(stamps.indexOf('a-end'));
    expect(await exists(path.join(repo.root, 'a.js'))).toBe(true);
    expect(await exists(path.join(repo.root, 'b.js'))).toBe(true);
  });

  it('sequential (défaut) : la seconde attend la fin de la première', async () => {
    await writeStriartConfig(repo.root, { testCommand: GATE_OK, agentProfiles: profiles() });
    const result = await applyPlan({ root: repo.root, planText: twoTasks() });
    expect(result.nodes.map((n) => n.status)).toEqual(['MERGED', 'MERGED']);
    expect(await script.stamps()).toEqual(['a-start', 'a-end', 'b-start', 'b-end']);
  });

  it('--concurrency 1 (surcharge) force la sérialisation d’un plan parallel', async () => {
    await writeStriartConfig(repo.root, { testCommand: GATE_OK, agentProfiles: profiles() });
    await applyPlan({
      root: repo.root,
      planText: twoTasks({ mode: 'parallel' }),
      overrides: { concurrency: 1 },
    });
    expect(await script.stamps()).toEqual(['a-start', 'a-end', 'b-start', 'b-end']);
  });

  it('onFailure stop (défaut) : après un échec, plus rien ne démarre', async () => {
    await writeStriartConfig(repo.root, {
      testCommand: GATE_OK,
      agentProfiles: profiles({ a: script.profile('a', [{ exit: 3 }]) }),
    });
    const result = await applyPlan({ root: repo.root, planText: twoTasks() });
    expect(result.nodes[0].status).toBe('SESSION_FAILED');
    expect(result.nodes[1]).toMatchObject({ status: 'SKIPPED', detail: 'STOPPED' });
    expect(await script.invocations('b')).toBe(0);
  });

  it('onFailure skip-dependents : seules les dépendantes sautent', async () => {
    await writeStriartConfig(repo.root, {
      testCommand: GATE_OK,
      agentProfiles: profiles({
        a: script.profile('a', [{ exit: 3 }]),
        c: script.profile('c', [{ write: { 'c.js': 'c\n' }, commit: true }]),
      }),
    });
    const planText = JSON.stringify({
      version: 2,
      mode: 'parallel',
      onFailure: 'skip-dependents',
      tasks: [
        { id: 'a', agent: 'a', prompt: 'a', autonomous: true, profile: 'a' },
        { id: 'b', agent: 'b', prompt: 'b', autonomous: true, profile: 'b', after: 'a' },
        { id: 'c', agent: 'c', prompt: 'c', autonomous: true, profile: 'c' },
      ],
    });
    const result = await applyPlan({ root: repo.root, planText });
    expect(result.nodes.map((n) => [n.id, n.status])).toEqual([
      ['a', 'SESSION_FAILED'],
      ['b', 'SKIPPED'],
      ['c', 'MERGED'],
    ]);
    expect(result.nodes[1].detail).toBe('DEPENDENCY_FAILED');
  });

  it('sequential : une tâche SUPERVISÉE est attendue jusqu’à la sortie de son agent', async () => {
    await writeStriartConfig(repo.root, {
      testCommand: GATE_OK,
      agentProfiles: profiles(),
      orchestration: { pollIntervalMs: 200 },
    });
    const planText = JSON.stringify({
      version: 2,
      tasks: [
        { id: 'human', agent: 'human', prompt: 'manual work' },
        { id: 'b', agent: 'b', prompt: 'task b', autonomous: true, profile: 'b' },
      ],
    });
    const progress = [];
    const running = applyPlan({
      root: repo.root,
      planText,
      onProgress: (event) => progress.push(event),
    });
    const started = () =>
      progress.some((e) => e.type === 'node-started' && e.info?.name === 'human');
    for (let i = 0; i < 300 && !(started() && (await readRegistry(repo.root)).human); i += 1) {
      await new Promise((r) => setTimeout(r, 100));
    }
    // Pendant l'attente : rien n'a démarré pour b, l'état du plan est lisible.
    expect(await script.invocations('b')).toBe(0);
    const status = await collectStatus(repo.root);
    expect(status.orchestration.runs[0]).toMatchObject({ status: 'running', alive: true });
    expect(progress.some((e) => e.type === 'node-started' && e.info?.name === 'human')).toBe(true);

    await stopAgent({ root: repo.root, agent: 'human', force: true });
    const result = await running;
    expect(result.nodes.map((n) => n.status)).toEqual(['FINISHED', 'MERGED']);
    const after = await collectStatus(repo.root);
    expect(after.orchestration.runs[0].status).toBe('done');
  });

  it('--dry-run v2 : rien n’est lancé, les profils de tous les rôles sont vérifiés', async () => {
    await writeStriartConfig(repo.root, { testCommand: GATE_OK, agentProfiles: profiles() });
    const planText = JSON.stringify({
      version: 2,
      tasks: [
        {
          id: 'r',
          mode: 'review',
          prompt: 'x',
          author: { profile: 'a' },
          reviewers: [{ profile: 'nope' }],
        },
      ],
    });
    await expect(applyPlan({ root: repo.root, planText, dryRun: true })).rejects.toMatchObject({
      code: 'PROFILE_UNKNOWN',
    });
    const ok = await applyPlan({ root: repo.root, planText: twoTasks(), dryRun: true });
    expect(ok.tasks.map((t) => [t.id, t.kind, t.mode])).toEqual([
      ['a', 'task', 'autonomous'],
      ['b', 'task', 'autonomous'],
    ]);
    expect(await readRegistry(repo.root)).toEqual({});
  });
});

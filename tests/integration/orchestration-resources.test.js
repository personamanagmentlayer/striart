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
 * Ressources hors-Git d'un nœud de plan v2 (lot O, priorité 4 du Run
 * Manager) : deux nœuds qui déclarent le même nom ne tournent jamais en
 * même temps, même sans dépendance ni collision prédite par le Router, et
 * même en `parallel` avec une concurrence qui les laisserait sinon se
 * chevaucher.
 */
describe('plan v2 — ressources hors-Git (intégration)', { timeout: 240_000 }, () => {
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

  it('deux tâches indépendantes partageant une ressource ne se chevauchent jamais, même en parallel', async () => {
    await writeStriartConfig(repo.root, {
      testCommand: GATE_OK,
      agentProfiles: {
        a: script.profile('a', [
          { write: { 'a.js': 'a\n' }, commit: true, stamp: 'a', sleepMs: 800 },
        ]),
        b: script.profile('b', [{ write: { 'b.js': 'b\n' }, commit: true, stamp: 'b' }]),
      },
    });
    const planText = JSON.stringify({
      version: 2,
      mode: 'parallel',
      concurrency: 2,
      tasks: [
        {
          id: 'a',
          agent: 'a',
          prompt: 'task a',
          autonomous: true,
          profile: 'a',
          resources: ['db'],
        },
        {
          id: 'b',
          agent: 'b',
          prompt: 'task b',
          autonomous: true,
          profile: 'b',
          resources: ['db'],
        },
      ],
    });
    const result = await applyPlan({ root: repo.root, planText });
    expect(result.nodes.map((n) => n.status)).toEqual(['MERGED', 'MERGED']);
    // Jamais le chevauchement : `b` n'a démarré qu'une fois `a` terminée.
    expect(await script.stamps()).toEqual(['a-start', 'a-end', 'b-start', 'b-end']);
  });

  it('sans ressource partagée, les mêmes tâches se chevauchent normalement', async () => {
    const barrier = `${script.dir}/b-started`;
    await writeStriartConfig(repo.root, {
      testCommand: GATE_OK,
      agentProfiles: {
        a: script.profile('a', [
          { write: { 'a.js': 'a\n' }, commit: true, stamp: 'a', waitFor: barrier },
        ]),
        b: script.profile('b', [
          { write: { 'b.js': 'b\n' }, commit: true, stamp: 'b', touch: barrier },
        ]),
      },
    });
    const planText = JSON.stringify({
      version: 2,
      mode: 'parallel',
      concurrency: 2,
      tasks: [
        { id: 'a', agent: 'a', prompt: 'task a', autonomous: true, profile: 'a' },
        { id: 'b', agent: 'b', prompt: 'task b', autonomous: true, profile: 'b' },
      ],
    });
    const result = await applyPlan({ root: repo.root, planText });
    expect(result.nodes.map((n) => n.status)).toEqual(['MERGED', 'MERGED']);
    const stamps = await script.stamps();
    expect(stamps.indexOf('b-start')).toBeLessThan(stamps.indexOf('a-end'));
  });

  it('refuse des ressources invalides (liste de noms distincts non vides)', async () => {
    await writeStriartConfig(repo.root, { testCommand: GATE_OK, agentProfiles: {} });
    const planText = JSON.stringify({
      version: 2,
      tasks: [{ id: 'a', agent: 'a', prompt: 'x', resources: ['db', 'db'] }],
    });
    await expect(applyPlan({ root: repo.root, planText, dryRun: true })).rejects.toMatchObject({
      code: 'PLAN_INVALID',
      details: { reason: 'RESOURCES_INVALID' },
    });
  });
});

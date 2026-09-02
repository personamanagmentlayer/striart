import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createTempRepo } from '../helpers/temp-repo.js';
import { initStriart } from '../../src/init.js';
import { createConflictTicket } from '../../src/conflicts.js';
import { runDoctor } from '../../src/doctor.js';

function check(result, id) {
  return result.checks.find((c) => c.id === id);
}

describe('striart doctor (intégration)', () => {
  let repo;

  beforeEach(async () => {
    repo = await createTempRepo();
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await repo.cleanup();
  });

  it('environnement sain : tous les checks passent (ollama mocké joignable)', async () => {
    await initStriart(repo.root);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) }));

    const result = await runDoctor(repo.root);

    expect(result.healthy).toBe(true);
    expect(check(result, 'git').level).toBe('ok');
    expect(check(result, 'repo').level).toBe('ok');
    expect(check(result, 'init').level).toBe('ok');
    expect(check(result, 'config').level).toBe('ok');
    expect(check(result, 'branch').level).toBe('ok');
    expect(check(result, 'llm').level).toBe('ok');
    expect(check(result, 'lock').level).toBe('ok');
    expect(check(result, 'tickets').level).toBe('ok');
  });

  it('repo non initialisé → fail init, healthy false, sans jamais throw', async () => {
    const result = await runDoctor(repo.root);
    expect(result.healthy).toBe(false);
    expect(check(result, 'init').level).toBe('fail');
    expect(check(result, 'init').detail).toContain('striart init');
  });

  it('hors de tout repo git → fail repo, checks dépendants en skip', async () => {
    const outside = await mkdtemp(path.join(os.tmpdir(), 'striart-outside-'));
    try {
      const result = await runDoctor(outside);
      expect(result.healthy).toBe(false);
      expect(check(result, 'repo').level).toBe('fail');
      expect(check(result, 'init').level).toBe('skip');
      expect(check(result, 'llm').level).toBe('skip');
    } finally {
      await rm(outside, { recursive: true, force: true, maxRetries: 5 });
    }
  });

  it('signaux dégradés : ollama down, ticket ouvert, mauvaise branche → warn (pas fail)', async () => {
    await initStriart(repo.root);
    await createConflictTicket(repo.root, {
      agent: 'agent-a',
      branch: 'b',
      sha: 'c'.repeat(40),
      reason: 'MERGE_CONFLICT',
    });
    await repo.git.checkoutLocalBranch('feature/autre');
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));

    const result = await runDoctor(repo.root);

    // Des warn, pas des fail : l'environnement reste utilisable.
    expect(result.healthy).toBe(true);
    expect(check(result, 'llm').level).toBe('warn');
    expect(check(result, 'tickets').level).toBe('warn');
    expect(check(result, 'branch').level).toBe('warn');
    expect(check(result, 'branch').detail).toContain('targetBranch');
  });

  it('config invalide → fail config', async () => {
    await initStriart(repo.root);
    await writeFile(path.join(repo.root, '.striartrc.json'), JSON.stringify({ testCommand: 42 }));
    const result = await runDoctor(repo.root);
    expect(check(result, 'config').level).toBe('fail');
    expect(result.healthy).toBe(false);
  });
});

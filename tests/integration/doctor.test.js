import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { simpleGit } from 'simple-git';
import { createTempRepo } from '../helpers/temp-repo.js';
import { initStriart } from '../../src/init.ts';
import { createConflictTicket } from '../../src/conflicts.ts';
import { runDoctor } from '../../src/doctor.ts';
import { quietShell } from '../helpers/pty-test-utils.js';

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
    // Config écrite AVANT init (qui sinon génère striart.config.mjs) : shell sans
    // profil, pour que le constat `pty` ne dépende pas des profils PowerShell
    // de la machine qui exécute le test (cf. le test dédié plus bas).
    await writeFile(
      path.join(repo.root, '.striartrc.json'),
      JSON.stringify({ pty: { shellArgs: quietShell().args } }),
    );
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
    expect(check(result, 'secrets').level).toBe('ok');
    expect(check(result, 'manual')).toMatchObject({ level: 'ok', detail: 'opérationnelle' });
    expect(check(result, 'pty')).toMatchObject({
      level: 'ok',
      key: 'pty.ok',
      params: { implementation: 'native', source: 'auto' },
    });
    expect(check(result, 'pty').detail).toMatch(/native/);
    expect(result.summary).toMatchObject({ fail: 0, warn: 0 });
  });

  it('pty.shell introuvable : constat pty en échec nommé, jamais un repli sur auto', async () => {
    await writeFile(
      path.join(repo.root, '.striartrc.json'),
      JSON.stringify({ pty: { shell: 'shell-introuvable-xyz' } }),
    );
    await initStriart(repo.root);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) }));

    const result = await runDoctor(repo.root);

    expect(check(result, 'pty')).toMatchObject({ level: 'fail', key: 'pty.invalid' });
    expect(result.healthy).toBe(false);
  });

  it('repo non initialisé → fail init, healthy false, sans jamais throw', async () => {
    const result = await runDoctor(repo.root);
    expect(result.healthy).toBe(false);
    expect(check(result, 'init')).toMatchObject({ level: 'fail', hint: 'striart init' });
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

    // Des warn, pas des fail : l'environnement reste utilisable…
    expect(result.healthy).toBe(true);
    expect(check(result, 'llm')).toMatchObject({ level: 'warn', hint: 'ollama serve' });
    expect(check(result, 'tickets')).toMatchObject({ level: 'warn', hint: 'striart resolve' });
    expect(check(result, 'branch').level).toBe('warn');
    expect(check(result, 'branch').detail).toContain('targetBranch');
    expect(check(result, 'branch').hint).toBe('git switch main');
    // … mais le bilan ne peut plus conclure « opérationnel » (régression
    // audit 2026-10-18 : 3 avertissements, « ✨ Environnement opérationnel »).
    expect(result.summary.warn).toBeGreaterThanOrEqual(4);
    // LLM injoignable : la fusion sémantique n'est PAS « opérationnelle ».
    expect(check(result, 'manual').level).toBe('warn');
  });

  it('repo sans aucun commit → fail repo (start refuserait : EMPTY_REPO)', async () => {
    const empty = await mkdtemp(path.join(os.tmpdir(), 'striart-empty-'));
    try {
      await simpleGit(empty).init();
      const result = await runDoctor(empty);
      expect(check(result, 'repo')).toMatchObject({
        level: 'fail',
        hint: expect.stringContaining('git commit'),
      });
      expect(result.healthy).toBe(false);
    } finally {
      await rm(empty, { recursive: true, force: true, maxRetries: 5 });
    }
  });

  it('targetBranch inexistante → fail branch (merge/sync/watch échoueraient tous)', async () => {
    await initStriart(repo.root);
    await writeFile(
      path.join(repo.root, '.striartrc.json'),
      JSON.stringify({ targetBranch: 'nope' }),
    );
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) }));
    const result = await runDoctor(repo.root);
    expect(check(result, 'branch')).toMatchObject({ level: 'fail' });
    expect(check(result, 'branch').detail).toContain('nope');
    expect(result.healthy).toBe(false);
  });

  it('semanticMerge: false → fusion sémantique « ignoré », pas « opérationnelle »', async () => {
    await initStriart(repo.root);
    await writeFile(
      path.join(repo.root, '.striartrc.json'),
      JSON.stringify({ semanticMerge: false }),
    );
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) }));
    expect(check(await runDoctor(repo.root), 'manual').level).toBe('skip');
  });

  it('secret présent dans l’historique → warn secrets (start refuserait de cloner)', async () => {
    await initStriart(repo.root);
    await writeFile(path.join(repo.root, '.env'), 'API_KEY=x\n');
    await repo.git.raw(['add', '-f', '.env']);
    await repo.git.commit('feat: .env par erreur');
    await repo.git.rm(['.env']);
    await repo.git.commit('fix: retire .env');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) }));
    const secrets = check(await runDoctor(repo.root), 'secrets');
    expect(secrets.level).toBe('warn');
    expect(secrets.detail).toContain('.env');
    expect(secrets.hint).toContain('--allow-historical-secrets');
  });

  it('config invalide → fail config', async () => {
    await initStriart(repo.root);
    await writeFile(path.join(repo.root, '.striartrc.json'), JSON.stringify({ testCommand: 42 }));
    const result = await runDoctor(repo.root);
    expect(check(result, 'config').level).toBe('fail');
    expect(result.healthy).toBe(false);
  });
});

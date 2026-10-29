import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTempRepo } from '../helpers/temp-repo.js';
import { initStriart } from '../../src/init.ts';
import { appendUsage } from '../../src/tokens/ledger.ts';
import { pruneWorkspace } from '../../src/prune.ts';
import { collectStatus } from '../../src/status.ts';
import { runDoctor } from '../../src/doctor.ts';

const CLI = fileURLToPath(new URL('../../src/cli.js', import.meta.url));

function run(args, { cwd, lang = 'fr' }) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd,
      env: { ...process.env, STRIART_LANG: lang, FORCE_COLOR: undefined, NO_COLOR: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

const record = (over = {}) => ({
  v: 1,
  ts: new Date().toISOString(),
  role: 'merger',
  provider: 'anthropic',
  model: 'claude-x',
  agent: 'agent-a',
  taskId: 'task-1',
  durationMs: 5,
  source: 'api',
  outcome: 'ok',
  estimated: false,
  input: 1000,
  output: 200,
  cacheRead: 500,
  cacheWrite: 0,
  reasoning: 0,
  costUsd: null,
  ...over,
});

describe('striart usage / status / doctor / prune (tokens)', () => {
  let repo;
  beforeEach(async () => {
    repo = await createTempRepo();
    await initStriart(repo.root);
    await appendUsage(repo.root, record());
    await appendUsage(
      repo.root,
      record({ role: 'router', agent: null, taskId: null, input: 300, output: 20, cacheRead: 0 }),
    );
  });
  afterEach(async () => {
    await repo.cleanup();
  });

  it('usage --json : document enveloppé, schemaVersion, agrégats par rôle', async () => {
    const { code, stdout } = await run(['usage', '--json'], { cwd: repo.root });
    expect(code).toBe(0);
    const doc = JSON.parse(stdout);
    expect(doc).toMatchObject({ ok: true, command: 'usage' });
    expect(doc.data.schemaVersion).toBe(1);
    expect(doc.data.byRole.map((r) => r.key).sort()).toEqual(['merger', 'router']);
    expect(doc.data.total.tokens).toBe(1000 + 200 + 500 + 300 + 20);
  });

  it('usage (humain) : tableau, coût incomplet signalé faute de prix, filtre par rôle', async () => {
    const all = await run(['usage'], { cwd: repo.root });
    expect(all.code).toBe(0);
    expect(all.stdout).toContain('merger');
    expect(all.stdout).toContain('router');
    expect(all.stderr + all.stdout).toContain('tokens.pricing');
    const only = await run(['usage', '--role', 'router', '--json'], { cwd: repo.root });
    expect(JSON.parse(only.stdout).data.byRole.map((r) => r.key)).toEqual(['router']);
  });

  it('usage : période invalide → sortie 2 (usage), rôle inconnu → sortie 2', async () => {
    const bad = await run(['usage', '--since', 'hier'], { cwd: repo.root });
    expect(bad.code).toBe(2);
    const role = await run(['usage', '--role', 'nope'], { cwd: repo.root });
    expect(role.code).toBe(2);
  });

  it('usage sur un dépôt sans registre : message vide, sortie 0', async () => {
    const fresh = await createTempRepo();
    try {
      await initStriart(fresh.root);
      const r = await run(['usage'], { cwd: fresh.root });
      expect(r.code).toBe(0);
      expect(r.stdout + r.stderr).toMatch(/aucun usage/);
    } finally {
      await fresh.cleanup();
    }
  });

  it('status --json : champ `tokens` additif (comptabilité, consommation du jour, plafonds)', async () => {
    await writeFile(
      path.join(repo.root, '.striartrc.json'),
      JSON.stringify({ tokens: { budgets: { perDay: { maxTokens: 1000 } } } }),
    );
    const status = await collectStatus(repo.root);
    expect(status.tokens).toMatchObject({ available: true, accounting: true });
    expect(status.tokens.today.tokens).toBe(2020);
    expect(status.tokens.budgets).toEqual([
      expect.objectContaining({ scope: 'perDay', level: 'exceeded' }),
    ]);
    // Champs historiques inchangés.
    expect(status).toHaveProperty('agents');
    expect(status).toHaveProperty('queue');
  });

  it('doctor : ligne tokens (ok par défaut, relâchement affiché sinon)', async () => {
    const ok = await runDoctor(repo.root);
    const okLine = ok.checks.find((c) => c.id === 'tokens');
    expect(okLine).toBeTruthy();
    await writeFile(
      path.join(repo.root, '.striartrc.json'),
      JSON.stringify({ tokens: { accounting: false } }),
    );
    const relaxed = await runDoctor(repo.root);
    const lines = relaxed.checks.filter((c) => c.id === 'tokens');
    expect(
      lines.some((c) => c.level === 'warn' && /tokens\.accounting/.test(JSON.stringify(c))),
    ).toBe(true);
  });

  it('prune : applique tokens.retentionDays au registre (dry-run sans effet)', async () => {
    await appendUsage(repo.root, record({ ts: '2020-01-01T00:00:00.000Z' }));
    await writeFile(
      path.join(repo.root, '.striartrc.json'),
      JSON.stringify({ tokens: { retentionDays: 30 } }),
    );
    const dry = await pruneWorkspace({ root: repo.root, dryRun: true });
    expect(dry.usage.ledgerRemoved.map((r) => r.file)).toEqual(['2020-01-01.ndjson']);
    const real = await pruneWorkspace({ root: repo.root });
    expect(real.usage.ledgerRemoved).toHaveLength(1);
    const again = await pruneWorkspace({ root: repo.root });
    expect(again.usage.ledgerRemoved).toHaveLength(0);
  });
});

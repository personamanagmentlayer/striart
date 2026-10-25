import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  appendUsage,
  currentTotals,
  listLedgerFiles,
  pruneLedger,
  readRecords,
  resetUsageIndex,
  sanitizeRecord,
  usageDir,
  utcDay,
} from '../../src/tokens/ledger.ts';
import { cacheGet, cacheKey, cachePut, sweepCache } from '../../src/tokens/cache.ts';
import { buildUsageReport, parsePeriodBound, usageSummary } from '../../src/tokens/report.ts';

const record = (over = {}) => ({
  v: 1,
  ts: new Date().toISOString(),
  role: 'merger',
  provider: 'anthropic',
  model: 'claude-x',
  agent: 'agent-a',
  taskId: 'task-1',
  durationMs: 12,
  source: 'api',
  outcome: 'ok',
  estimated: false,
  input: 100,
  output: 50,
  cacheRead: 20,
  cacheWrite: 0,
  reasoning: 0,
  costUsd: 0.01,
  ...over,
});

describe('registre d’usage (disque)', () => {
  let root;
  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'striart-usage-'));
    resetUsageIndex();
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true, maxRetries: 5 });
  });

  it('append-only, un fichier par jour UTC, une ligne JSON par enregistrement', async () => {
    await appendUsage(root, record({ ts: '2026-10-23T23:59:59.000Z' }));
    await appendUsage(root, record({ ts: '2026-10-24T00:00:01.000Z' }));
    await appendUsage(root, record({ ts: '2026-10-24T08:00:00.000Z' }));
    expect((await listLedgerFiles(root)).map((f) => f.date)).toEqual(['2026-10-23', '2026-10-24']);
    const text = await readFile(path.join(usageDir(root), '2026-10-24.ndjson'), 'utf8');
    expect(text.trim().split('\n')).toHaveLength(2);
    expect(JSON.parse(text.split('\n')[0]).model).toBe('claude-x');
  });

  it('JAMAIS de prompt, de contenu ni de clé : liste blanche de champs', async () => {
    await appendUsage(
      root,
      record({
        prompt: 'SECRET PROMPT',
        response: 'SECRET OUT',
        apiKey: 'sk-123',
        content: 'x',
        authorization: 'Bearer y',
      }),
    );
    const text = await readFile(path.join(usageDir(root), `${utcDay(Date.now())}.ndjson`), 'utf8');
    for (const forbidden of ['SECRET', 'sk-123', 'Bearer', 'apiKey', 'authorization']) {
      expect(text).not.toContain(forbidden);
    }
  });

  it('refuse d’écrire un enregistrement invalide (rôle inconnu, version, date)', async () => {
    await expect(appendUsage(root, record({ role: 'hacker' }))).rejects.toThrow();
    expect(sanitizeRecord({ ...record(), v: 2 })).toBeNull();
    expect(sanitizeRecord({ ...record(), ts: 'hier' })).toBeNull();
  });

  it('lecture tolérante : ligne tronquée, JSON invalide, hors schéma → comptées, jamais fatales', async () => {
    await appendUsage(root, record());
    const file = path.join(usageDir(root), `${utcDay(Date.now())}.ndjson`);
    await appendFile(file, '{"v":1,"ts":"2026-10-24T10:00:00.000Z","role":"mer\n');
    await appendFile(file, 'pas du json\n');
    await appendFile(file, '{"v":1,"role":"merger"}\n');
    await appendUsage(root, record({ input: 7 }));
    const { records, skipped } = await readRecords(root);
    expect(records).toHaveLength(2);
    expect(skipped).toBe(3);
  });

  it('écritures concurrentes : aucune ligne perdue ni entrelacée', async () => {
    await Promise.all(
      Array.from({ length: 60 }, (_, i) =>
        appendUsage(root, record({ input: i, taskId: `t${i}` })),
      ),
    );
    const { records, skipped } = await readRecords(root);
    expect(skipped).toBe(0);
    expect(records.map((r) => r.input).sort((a, b) => a - b)).toEqual(
      Array.from({ length: 60 }, (_, i) => i),
    );
  });

  it('cumuls incrémentaux par jour / tâche / agent / global, avec ligne partielle ignorée', async () => {
    await appendUsage(
      root,
      record({ input: 100, output: 0, cacheRead: 0, taskId: 't1', agent: 'a1' }),
    );
    await appendUsage(
      root,
      record({ input: 10, output: 0, cacheRead: 0, taskId: 't2', agent: 'a1', costUsd: null }),
    );
    await appendUsage(
      root,
      record({
        ts: '2026-01-01T00:00:00.000Z',
        input: 1000,
        output: 0,
        cacheRead: 0,
        taskId: 't1',
        agent: 'a2',
      }),
    );
    const first = await currentTotals(root, { taskId: 't1', agent: 'a1' });
    expect(first.perTask.tokens).toBe(1100);
    expect(first.perAgent.tokens).toBe(110);
    expect(first.perDay.tokens).toBe(110);
    expect(first.global.tokens).toBe(1110);
    expect(first.perDay.unpriced).toBe(1);
    // Ligne en cours d'écriture (pas de \n) : ignorée jusqu'à complétion, lue ensuite.
    const file = path.join(usageDir(root), `${utcDay(Date.now())}.ndjson`);
    await appendFile(file, JSON.stringify(record({ input: 5, output: 0, cacheRead: 0 })));
    expect((await currentTotals(root)).perDay.tokens).toBe(110);
    await appendFile(file, '\n');
    expect((await currentTotals(root)).perDay.tokens).toBe(115);
  });

  it('fichier raccourci (rotation manuelle) : l’agrégat repart de zéro', async () => {
    await appendUsage(root, record({ input: 100, output: 0, cacheRead: 0 }));
    expect((await currentTotals(root)).global.tokens).toBe(100);
    const file = path.join(usageDir(root), `${utcDay(Date.now())}.ndjson`);
    await writeFile(file, '');
    expect((await currentTotals(root)).global.tokens).toBe(0);
  });

  it('rétention : supprime les fichiers plus vieux que N jours (dryRun sans effet), ignore les noms étrangers', async () => {
    await appendUsage(root, record({ ts: '2026-01-01T00:00:00.000Z' }));
    await appendUsage(root, record());
    await writeFile(path.join(usageDir(root), 'notes.txt'), 'x');
    const dry = await pruneLedger(root, { retentionDays: 30, dryRun: true });
    expect(dry.removed.map((r) => r.file)).toEqual(['2026-01-01.ndjson']);
    expect((await listLedgerFiles(root)).length).toBe(2);
    await pruneLedger(root, { retentionDays: 30 });
    expect((await listLedgerFiles(root)).map((f) => f.date)).toEqual([utcDay(Date.now())]);
    expect(await readdir(usageDir(root))).toContain('notes.txt');
  });
});

describe('rapport d’usage', () => {
  let root;
  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'striart-usage-'));
    resetUsageIndex();
    await appendUsage(
      root,
      record({
        role: 'router',
        agent: null,
        taskId: null,
        input: 100,
        output: 10,
        cacheRead: 0,
        costUsd: 0.001,
      }),
    );
    await appendUsage(
      root,
      record({ role: 'merger', input: 200, output: 100, cacheRead: 100, costUsd: 0.01 }),
    );
    await appendUsage(
      root,
      record({
        role: 'merger',
        outcome: 'cache-hit',
        input: 0,
        output: 0,
        cacheRead: 0,
        costUsd: 0,
      }),
    );
    await appendUsage(
      root,
      record({ role: 'merger', outcome: 'budget', input: 0, output: 0, cacheRead: 0, costUsd: 0 }),
    );
    await appendUsage(
      root,
      record({
        role: 'agent',
        source: 'unmetered',
        input: null,
        output: null,
        cacheRead: null,
        cacheWrite: null,
        reasoning: null,
        costUsd: null,
        instructionsTokens: 900,
      }),
    );
    await appendUsage(
      root,
      record({
        role: 'memory',
        model: 'm2',
        provider: 'ollama',
        estimated: true,
        source: 'estimate',
        input: 50,
        output: 5,
        cacheRead: 0,
        costUsd: null,
      }),
    );
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true, maxRetries: 5 });
  });

  it('agrège par rôle, agent, tâche, modèle ; déclare estimations, sessions sans relevé, appels sans prix', async () => {
    const report = await buildUsageReport(root, {});
    expect(report.schemaVersion).toBe(1);
    expect(report.total.resultCacheHits).toBe(1);
    expect(report.total.refused).toBe(1);
    expect(report.total.estimatedCalls).toBe(1);
    expect(report.total.unmeteredSessions).toBe(1);
    expect(report.total.unpricedCalls).toBe(1); // le relevé mémoire estimé sans prix
    expect(report.byRole.map((r) => r.key).sort()).toEqual(['agent', 'memory', 'merger', 'router']);
    const merger = report.byRole.find((r) => r.key === 'merger');
    expect(merger.calls).toBe(1);
    expect(merger.tokens).toBe(400);
    expect(report.cache.promptHitRate).toBeCloseTo(0.25, 5);
    expect(report.cache.resultCacheEligible).toBe(2); // 1 hit + 1 appel réel du router (rôle cacheable)
    expect(report.instructions.lastTokens).toBe(900);
  });

  it('filtres rôle / agent / tâche et période', async () => {
    expect((await buildUsageReport(root, {}, { role: 'router' })).byRole.map((r) => r.key)).toEqual(
      ['router'],
    );
    expect(
      (await buildUsageReport(root, {}, { agent: 'agent-a' })).byAgent.map((r) => r.key),
    ).toEqual(['agent-a']);
    expect((await buildUsageReport(root, {}, { since: '2030-01-01' })).total.calls).toBe(0);
    expect((await buildUsageReport(root, {}, { until: '2000-01-01' })).total.calls).toBe(0);
  });

  it('période invalide : USAGE_PERIOD_INVALID', async () => {
    await expect(buildUsageReport(root, {}, { since: 'hier' })).rejects.toMatchObject({
      code: 'USAGE_PERIOD_INVALID',
    });
    await expect(
      buildUsageReport(root, {}, { since: '2026-10-25', until: '2026-10-01' }),
    ).rejects.toMatchObject({
      code: 'USAGE_PERIOD_INVALID',
    });
    expect(parsePeriodBound('7d', Date.parse('2026-10-24T00:00:00Z')).toISOString()).toBe(
      '2026-10-17T00:00:00.000Z',
    );
  });

  it('résumé (status/doctor/Control Protocol) : consommation du jour et niveau des plafonds', async () => {
    const config = { tokens: { budgets: { perDay: { maxTokens: 500 } } } };
    const summary = await usageSummary(root, config);
    expect(summary.accounting).toBe(true);
    expect(summary.today.tokens).toBeGreaterThan(500);
    expect(summary.budgets).toEqual([
      expect.objectContaining({ scope: 'perDay', metric: 'tokens', limit: 500, level: 'exceeded' }),
    ]);
  });
});

describe('cache local de résultats', () => {
  let root;
  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'striart-cache-'));
    await mkdir(usageDir(root), { recursive: true });
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true, maxRetries: 5 });
  });

  const key = (over = {}) =>
    cacheKey({
      role: 'router',
      provider: 'p',
      model: 'm',
      promptVersion: 'v1',
      material: ['tâche', 'arbre'],
      ...over,
    });

  it('hit dans le TTL, miss après expiration', async () => {
    await cachePut(root, key(), 'router', '{"files":["a.js"]}', {
      ttlMs: 1000,
      maxEntries: 10,
      now: 1_000,
    });
    expect(await cacheGet(root, key(), 1_500)).toBe('{"files":["a.js"]}');
    expect(await cacheGet(root, key(), 2_500)).toBeNull();
  });

  it('invalidation structurelle : tâche, arbre, modèle, version de prompt → autre clé', () => {
    const base = key();
    expect(key({ material: ['autre', 'arbre'] })).not.toBe(base);
    expect(key({ material: ['tâche', 'arbre2'] })).not.toBe(base);
    expect(key({ model: 'm2' })).not.toBe(base);
    expect(key({ promptVersion: 'v2' })).not.toBe(base);
    // Encodage injectif : ['ab','c'] ≠ ['a','bc'].
    expect(key({ material: ['ab', 'c'] })).not.toBe(key({ material: ['a', 'bc'] }));
  });

  it('borné en nombre d’entrées (les plus anciennes évincées) ; entrée corrompue = miss purgé', async () => {
    for (let i = 0; i < 5; i += 1) {
      await cachePut(root, key({ material: [String(i)] }), 'router', `r${i}`, {
        ttlMs: 60_000,
        maxEntries: 3,
        now: Date.now() + i,
      });
      await new Promise((r) => setTimeout(r, 15));
    }
    const files = (await readdir(path.join(usageDir(root), 'cache'))).filter((f) =>
      f.endsWith('.json'),
    );
    expect(files.length).toBe(3);
    const k = key({ material: ['4'] });
    await writeFile(path.join(usageDir(root), 'cache', `${k}.json`), '{corrompu');
    expect(await cacheGet(root, k)).toBeNull();
  });

  it('sweep : retire les entrées expirées', async () => {
    await cachePut(root, key(), 'router', 'x', { ttlMs: 10, maxEntries: 10, now: 1 });
    const res = await sweepCache(root, { now: Date.now() });
    expect(res.removed).toBe(1);
  });
});

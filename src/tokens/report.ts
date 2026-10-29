/**
 * Rapports d'usage (lot T) : source unique de `striart usage`, du champ
 * `tokens` de `striart status --json`, de la ligne `doctor` et — via
 * `usageSummary` — des futurs consommateurs du Control Protocol.
 * Lecture seule, tolérante (lignes illisibles comptées, jamais fatales).
 */
import type { StriartConfig, UsageRecord, UsageRole } from '../types.js';
import { StriartError } from '../errors.ts';
import { currentTotals, readRecords, recordTokens, utcDay } from './ledger.ts';
import { stalePrices as findStalePrices } from './pricing.ts';
import { resolveTokensSettings, tokensRelaxations } from './settings.ts';

export const USAGE_REPORT_SCHEMA_VERSION = 1;

export interface UsageRow {
  key: string;
  /** Appels ou sessions comptés (hors refus et hits de cache). */
  calls: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning: number;
  /** Entrée totale + sortie. */
  tokens: number;
  /** Somme des coûts connus ; `null` si AUCUN enregistrement du groupe n'a de coût. */
  costUsd: number | null;
  /** Enregistrements consommant des jetons sans prix déclaré (le coût est alors incomplet). */
  unpricedCalls: number;
  estimatedCalls: number;
  unmeteredSessions: number;
  resultCacheHits: number;
  refused: number;
  errors: number;
}

export interface UsageReport {
  schemaVersion: 1;
  period: { from: string | null; to: string | null };
  files: number;
  skippedLines: number;
  total: UsageRow;
  byRole: UsageRow[];
  byAgent: UsageRow[];
  byTask: UsageRow[];
  byModel: UsageRow[];
  byDay: UsageRow[];
  cache: {
    /** Part du prompt d'entrée servie par le cache de prompt du fournisseur (null = aucune donnée). */
    promptHitRate: number | null;
    resultCacheHits: number;
    /** Appels éligibles au cache de résultats (hits + appels réels des rôles cacheables). */
    resultCacheEligible: number;
  };
  /** Consignes injectées : dernière taille estimée relevée (jetons). */
  instructions: { lastTokens: number | null; sessions: number };
}

const emptyRow = (key: string): UsageRow => ({
  key,
  calls: 0,
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  reasoning: 0,
  tokens: 0,
  costUsd: null,
  unpricedCalls: 0,
  estimatedCalls: 0,
  unmeteredSessions: 0,
  resultCacheHits: 0,
  refused: 0,
  errors: 0,
});

function add(row: UsageRow, r: UsageRecord): void {
  if (r.outcome === 'cache-hit') {
    row.resultCacheHits += 1;
    return;
  }
  if (r.outcome === 'budget') {
    row.refused += 1;
    return;
  }
  if (r.outcome === 'error') row.errors += 1;
  if (r.source === 'unmetered') row.unmeteredSessions += 1;
  const tokens = recordTokens(r);
  if (tokens > 0 || r.source === 'unmetered' || r.outcome !== 'error') row.calls += 1;
  row.input += r.input ?? 0;
  row.output += r.output ?? 0;
  row.cacheRead += r.cacheRead ?? 0;
  row.cacheWrite += r.cacheWrite ?? 0;
  row.reasoning += r.reasoning ?? 0;
  row.tokens += tokens;
  if (r.costUsd !== null) row.costUsd = (row.costUsd ?? 0) + r.costUsd;
  else if (tokens > 0) row.unpricedCalls += 1;
  if (r.estimated) row.estimatedCalls += 1;
}

function group(
  records: readonly UsageRecord[],
  keyOf: (r: UsageRecord) => string | null,
): UsageRow[] {
  const map = new Map<string, UsageRow>();
  for (const r of records) {
    const key = keyOf(r);
    if (key === null) continue;
    let row = map.get(key);
    if (!row) {
      row = emptyRow(key);
      map.set(key, row);
    }
    add(row, r);
  }
  return [...map.values()].sort((a, b) => b.tokens - a.tokens || (a.key < b.key ? -1 : 1));
}

/** Périodes : `7d`, `24h`, `30m`, `today`, ou une date `YYYY-MM-DD`. */
export function parsePeriodBound(value: string, now = Date.now()): Date {
  const v = value.trim();
  if (v === 'today') {
    const d = new Date(now);
    d.setUTCHours(0, 0, 0, 0);
    return d;
  }
  const rel = /^(\d+)([dhm])$/.exec(v);
  if (rel) {
    const unit = { d: 86_400_000, h: 3_600_000, m: 60_000 }[rel[2] as 'd' | 'h' | 'm'];
    return new Date(now - Number(rel[1]) * unit);
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) {
    const d = new Date(`${v}T00:00:00Z`);
    if (!Number.isNaN(d.getTime())) return d;
  }
  throw new StriartError(
    `Invalid period "${value}": use a duration (7d, 24h, 30m), "today" or a UTC date (YYYY-MM-DD).`,
    { code: 'USAGE_PERIOD_INVALID', hint: 'striart usage --since 7d', details: { value } },
  );
}

export interface ReportOptions {
  since?: string | null;
  until?: string | null;
  role?: UsageRole | null;
  agent?: string | null;
  taskId?: string | null;
  now?: number;
}

export async function buildUsageReport(
  root: string,
  config: StriartConfig | Record<string, unknown>,
  options: ReportOptions = {},
): Promise<UsageReport> {
  const now = options.now ?? Date.now();
  const from = options.since ? parsePeriodBound(options.since, now) : null;
  const to = options.until ? parsePeriodBound(options.until, now) : null;
  if (from && to && from > to) {
    throw new StriartError('Invalid period: --since is after --until.', {
      code: 'USAGE_PERIOD_INVALID',
      hint: 'striart usage --since 7d',
      details: { since: options.since, until: options.until },
    });
  }
  const read = await readRecords(root, {
    fromDay: from ? utcDay(from) : null,
    toDay: to ? utcDay(to) : null,
  });
  const settings = resolveTokensSettings(config as { tokens?: unknown });
  const records = read.records.filter(
    (r) =>
      (!from || Date.parse(r.ts) >= from.getTime()) &&
      // `--until` désigne une date : inclusive du jour entier.
      (!to ||
        Date.parse(r.ts) <
          to.getTime() + (/^\d{4}-\d{2}-\d{2}$/.test(options.until ?? '') ? 86_400_000 : 0)) &&
      (!options.role || r.role === options.role) &&
      (!options.agent || r.agent === options.agent) &&
      (!options.taskId || r.taskId === options.taskId),
  );

  const total = emptyRow('total');
  for (const r of records) add(total, r);

  const apiRecords = records.filter(
    (r) => r.source === 'api' && r.outcome !== 'cache-hit' && r.outcome !== 'budget',
  );
  const apiInput = apiRecords.reduce(
    (s, r) => s + (r.input ?? 0) + (r.cacheRead ?? 0) + (r.cacheWrite ?? 0),
    0,
  );
  const apiCacheRead = apiRecords.reduce((s, r) => s + (r.cacheRead ?? 0), 0);
  const cacheableRoles = new Set<string>(settings.cache.roles);
  const hits = records.filter((r) => r.outcome === 'cache-hit').length;
  const eligibleReal = records.filter(
    (r) =>
      cacheableRoles.has(r.role) &&
      r.source === 'api' &&
      (r.outcome === 'ok' || r.outcome === 'rejected'),
  ).length;
  const withInstructions = records.filter((r) => r.instructionsTokens !== undefined);

  return {
    schemaVersion: USAGE_REPORT_SCHEMA_VERSION,
    period: { from: from?.toISOString() ?? null, to: to?.toISOString() ?? null },
    files: read.files,
    skippedLines: read.skipped,
    total,
    byRole: group(records, (r) => r.role),
    byAgent: group(records, (r) => r.agent),
    byTask: group(records, (r) => r.taskId),
    byModel: group(records, (r) => (r.model ? `${r.provider ?? '?'}:${r.model}` : null)),
    byDay: group(records, (r) => r.ts.slice(0, 10)).sort((a, b) => (a.key < b.key ? -1 : 1)),
    cache: {
      promptHitRate: apiInput > 0 ? apiCacheRead / apiInput : null,
      resultCacheHits: hits,
      resultCacheEligible: hits + eligibleReal,
    },
    instructions: {
      lastTokens:
        withInstructions.length > 0
          ? (withInstructions[withInstructions.length - 1].instructionsTokens ?? null)
          : null,
      sessions: withInstructions.length,
    },
  };
}

// -------------------------------------------------------------------------
// État des budgets, résumé pour status/doctor/Control Protocol
// -------------------------------------------------------------------------

export interface BudgetLine {
  scope: 'perDay' | 'global';
  metric: 'tokens' | 'costUsd';
  limit: number;
  used: number;
  ratio: number;
  level: 'ok' | 'warn' | 'exceeded';
}

export interface UsageSummary {
  accounting: boolean;
  enforcement: 'hard' | 'alert-only';
  today: { tokens: number; costUsd: number; unpricedCalls: number };
  budgets: BudgetLine[];
  relaxations: Array<{ key: string; summary: string }>;
  stalePrices: Array<{ key: string; asOf: string; ageDays: number }>;
  instructionsMode: 'full' | 'compact';
  unpricedModels: boolean;
}

/**
 * Résumé compact, additif et rétrocompatible : champ `tokens` de `status
 * --json`, ligne `doctor`, charge utile `tokens:summary` du Control Protocol.
 */
export async function usageSummary(
  root: string,
  config: StriartConfig | Record<string, unknown>,
): Promise<UsageSummary> {
  const settings = resolveTokensSettings(config as { tokens?: unknown });
  const totals = await currentTotals(root).catch(() => null);
  const day = totals?.perDay ?? { tokens: 0, costUsd: 0, unpriced: 0 };
  const lines: BudgetLine[] = [];
  const rolling: Array<['perDay' | 'global', { tokens: number; costUsd: number }]> = [
    ['perDay', day],
    ['global', totals?.global ?? { tokens: 0, costUsd: 0 }],
  ];
  for (const [scope, used] of rolling) {
    const limits = settings.budgets[scope];
    const metrics: Array<['tokens' | 'costUsd', number | null, number]> = [
      ['tokens', limits.maxTokens, used.tokens],
      ['costUsd', limits.maxCostUsd, used.costUsd],
    ];
    for (const [metric, limit, value] of metrics) {
      if (limit === null) continue;
      const ratio = limit === 0 ? 1 : value / limit;
      lines.push({
        scope,
        metric,
        limit,
        used: value,
        ratio,
        level: value > limit ? 'exceeded' : ratio >= settings.budgets.warnAtRatio ? 'warn' : 'ok',
      });
    }
  }
  return {
    accounting: settings.accounting,
    enforcement: settings.budgets.enforcement,
    today: { tokens: day.tokens, costUsd: day.costUsd, unpricedCalls: day.unpriced },
    budgets: lines,
    relaxations: tokensRelaxations(config as { tokens?: unknown }),
    stalePrices: findStalePrices(settings.pricing, settings.pricingStaleAfterDays),
    instructionsMode: settings.instructions.mode,
    unpricedModels: day.unpriced > 0,
  };
}

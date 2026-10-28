/**
 * Registre d'usage APPEND-ONLY : `.striart/usage/YYYY-MM-DD.ndjson` (UTC),
 * une ligne JSON par appel LLM ou par session d'agent (lot T).
 *
 * Invariants :
 *  - JAMAIS de prompt, de réponse, de contenu de fichier ni de clé : une ligne
 *    est reconstruite champ par champ par `sanitizeRecord` (liste blanche) ;
 *    les chaînes sont bornées et débarrassées de leurs contrôles.
 *  - Écriture robuste : un `appendFile` (O_APPEND — atomique pour une ligne
 *    courte, sous Windows comme sous POSIX) sérialisé par process et rejoué
 *    sur les erreurs transitoires de fichier (antivirus, indexeur Windows).
 *    Aucun verrou inter-processus : watch, dashboard et CLI écrivent en même
 *    temps sans se bloquer, et une ligne n'est jamais entrelacée avec une autre.
 *  - Lecture TOLÉRANTE : une ligne illisible (crash en pleine écriture, édition
 *    manuelle) est comptée et ignorée, jamais fatale.
 *  - Agrégats incrémentaux : les budgets sont évalués à chaque appel ; relire
 *    tout le registre à chaque fois coûterait plus que l'appel. Seuls les
 *    octets ajoutés depuis la dernière lecture sont analysés.
 */
import { appendFile, open, readFile, readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import type { UsageRecord, UsageRole, UsageSource } from '../types.js';
import { striartDir } from '../paths.js';
import { withTransientRetry } from '../json-file.js';
import { logger } from '../logger.js';
import { mkdirPrivate } from '../private-fs.ts';

export function usageDir(root: string): string {
  return path.join(striartDir(root), 'usage');
}

const FILE_RE = /^(\d{4}-\d{2}-\d{2})\.ndjson$/;

export function ledgerFileName(date: string): string {
  return `${date}.ndjson`;
}

/** Jour UTC (YYYY-MM-DD) d'un horodatage. */
export function utcDay(ts: string | number | Date): string {
  return new Date(ts).toISOString().slice(0, 10);
}

export const USAGE_ROLES: readonly UsageRole[] = [
  'router',
  'merger',
  'memory',
  'judge',
  'review',
  'agent',
];
const SOURCES: readonly UsageSource[] = ['api', 'agent-stream', 'acp', 'estimate', 'unmetered'];
const OUTCOMES = ['ok', 'rejected', 'error', 'cache-hit', 'budget', 'stopped'] as const;
/** Une ligne plus longue n'est pas une ligne de Striart : ignorée à la lecture. */
const MAX_LINE_CHARS = 16 * 1024;

const nonNegInt = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.round(v) : null;
const CONTROL_RE = new RegExp('[\\u0000-\\u001f\\u007f]', 'g');
const str = (v: unknown, max = 200): string | null =>
  typeof v === 'string' && v.length > 0 ? v.replace(CONTROL_RE, ' ').slice(0, max) : null;

/**
 * Reconstruit un enregistrement valide depuis une entrée quelconque (liste
 * blanche), ou `null` si elle n'en est pas un. Sert à l'écriture (rien
 * d'autre que les champs connus ne sort) ET à la lecture (tolérance).
 */
export function sanitizeRecord(input: unknown): UsageRecord | null {
  if (typeof input !== 'object' || input === null) return null;
  const r = input as Record<string, unknown>;
  if (r.v !== 1) return null;
  const ts = typeof r.ts === 'string' && !Number.isNaN(Date.parse(r.ts)) ? r.ts : null;
  if (!ts) return null;
  if (!USAGE_ROLES.includes(r.role as UsageRole)) return null;
  const source = SOURCES.includes(r.source as UsageSource) ? (r.source as UsageSource) : null;
  const outcome = (OUTCOMES as readonly unknown[]).includes(r.outcome)
    ? (r.outcome as UsageRecord['outcome'])
    : null;
  if (!source || !outcome) return null;
  const out: UsageRecord = {
    v: 1,
    ts,
    role: r.role as UsageRole,
    provider: str(r.provider, 60),
    model: str(r.model, 200),
    agent: str(r.agent, 64),
    taskId: str(r.taskId, 128),
    durationMs: nonNegInt(r.durationMs) ?? 0,
    source,
    outcome,
    estimated: r.estimated === true,
    input: nonNegInt(r.input),
    output: nonNegInt(r.output),
    cacheRead: nonNegInt(r.cacheRead),
    cacheWrite: nonNegInt(r.cacheWrite),
    reasoning: nonNegInt(r.reasoning),
    costUsd:
      typeof r.costUsd === 'number' && Number.isFinite(r.costUsd) && r.costUsd >= 0
        ? r.costUsd
        : null,
  };
  const promptChars = nonNegInt(r.promptChars);
  if (promptChars !== null) out.promptChars = promptChars;
  const instructionsTokens = nonNegInt(r.instructionsTokens);
  if (instructionsTokens !== null) out.instructionsTokens = instructionsTokens;
  const contextUsed = nonNegInt(r.contextUsed);
  if (contextUsed !== null) out.contextUsed = contextUsed;
  const detail = str(r.detail, 200);
  if (detail) out.detail = detail;
  return out;
}

/** Jetons comptés par les budgets pour un enregistrement (entrée totale + sortie ; null = 0). */
export function recordTokens(r: UsageRecord): number {
  return (r.input ?? 0) + (r.cacheRead ?? 0) + (r.cacheWrite ?? 0) + (r.output ?? 0);
}

// -------------------------------------------------------------------------
// Écriture
// -------------------------------------------------------------------------

const writeChains = new Map<string, Promise<unknown>>();

/**
 * Ajoute un enregistrement au registre du jour. Rejette en cas d'échec
 * d'écriture : l'appelant décide (l'instrumentation journalise et continue,
 * un appel LLM déjà fait ne doit pas être perdu pour un disque capricieux).
 */
export async function appendUsage(root: string, record: UsageRecord): Promise<void> {
  const clean = sanitizeRecord(record);
  if (!clean) throw new TypeError('enregistrement d’usage invalide');
  const dir = usageDir(root);
  const file = path.join(dir, ledgerFileName(utcDay(clean.ts)));
  const line = `${JSON.stringify(clean)}\n`;
  const previous = writeChains.get(file) ?? Promise.resolve();
  const next = previous
    .catch(() => undefined)
    .then(async () => {
      await mkdirPrivate(dir);
      await withTransientRetry(() => appendFile(file, line, { encoding: 'utf8', mode: 0o600 }));
    });
  writeChains.set(file, next);
  try {
    await next;
  } finally {
    if (writeChains.get(file) === next) writeChains.delete(file);
  }
}

// -------------------------------------------------------------------------
// Lecture
// -------------------------------------------------------------------------

export interface LedgerFile {
  date: string;
  file: string;
}

/** Fichiers du registre, du plus ancien au plus récent (noms hors format ignorés). */
export async function listLedgerFiles(root: string): Promise<LedgerFile[]> {
  const dir = usageDir(root);
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  return entries
    .filter((e) => e.isFile() && FILE_RE.test(e.name))
    .map((e) => ({ date: e.name.slice(0, 10), file: path.join(dir, e.name) }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

/** Analyse tolérante d'un bloc de lignes NDJSON. */
export function parseLines(text: string): { records: UsageRecord[]; skipped: number } {
  const records: UsageRecord[] = [];
  let skipped = 0;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line.length === 0) continue;
    if (line.length > MAX_LINE_CHARS) {
      skipped += 1;
      continue;
    }
    try {
      const record = sanitizeRecord(JSON.parse(line));
      if (record) records.push(record);
      else skipped += 1;
    } catch {
      // Ligne tronquée par un crash ou éditée à la main : comptée, jamais fatale.
      skipped += 1;
    }
  }
  return { records, skipped };
}

export interface ReadOptions {
  /** Jour UTC inclus (YYYY-MM-DD). */
  fromDay?: string | null;
  toDay?: string | null;
}

export async function readRecords(
  root: string,
  { fromDay = null, toDay = null }: ReadOptions = {},
): Promise<{ records: UsageRecord[]; skipped: number; files: number }> {
  const files = (await listLedgerFiles(root)).filter(
    (f) => (!fromDay || f.date >= fromDay) && (!toDay || f.date <= toDay),
  );
  const records: UsageRecord[] = [];
  let skipped = 0;
  for (const f of files) {
    let text: string;
    try {
      text = await withTransientRetry(() => readFile(f.file, 'utf8'));
    } catch (error) {
      logger.warn({ err: error, file: f.file }, 'Registre d’usage : fichier illisible (ignoré)');
      skipped += 1;
      continue;
    }
    const parsed = parseLines(text);
    records.push(...parsed.records);
    skipped += parsed.skipped;
  }
  return { records, skipped, files: files.length };
}

// -------------------------------------------------------------------------
// Agrégats incrémentaux pour les budgets
// -------------------------------------------------------------------------

export interface Totals {
  tokens: number;
  costUsd: number;
  /** Nombre d'enregistrements consommateurs sans coût (modèle sans prix déclaré). */
  unpriced: number;
}

const zero = (): Totals => ({ tokens: 0, costUsd: 0, unpriced: 0 });

function addTo(t: Totals, r: UsageRecord): void {
  const tokens = recordTokens(r);
  t.tokens += tokens;
  if (r.costUsd === null) {
    if (tokens > 0) t.unpriced += 1;
  } else t.costUsd += r.costUsd;
}

interface FileAggregate {
  offset: number;
  total: Totals;
  byTask: Map<string, Totals>;
  byAgent: Map<string, Totals>;
}

const aggregates = new Map<string, FileAggregate>();

/** Pour les tests : oublie les agrégats mémoire. */
export function resetUsageIndex(): void {
  aggregates.clear();
}

function bucket(map: Map<string, Totals>, key: string): Totals {
  let t = map.get(key);
  if (!t) {
    t = zero();
    map.set(key, t);
  }
  return t;
}

async function refreshAggregate(file: string): Promise<FileAggregate | null> {
  const st = await stat(file).catch(() => null);
  if (!st) {
    aggregates.delete(file);
    return null;
  }
  let agg = aggregates.get(file);
  // Fichier raccourci ou remplacé (rétention, édition manuelle) : repartir de zéro.
  if (agg && st.size < agg.offset) agg = undefined;
  if (!agg) agg = { offset: 0, total: zero(), byTask: new Map(), byAgent: new Map() };
  if (st.size > agg.offset) {
    const handle = await open(file, 'r');
    try {
      const length = st.size - agg.offset;
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buffer, 0, length, agg.offset);
      const text = buffer.subarray(0, bytesRead).toString('utf8');
      // Seules les lignes COMPLÈTES sont consommées : une écriture en cours
      // (ligne sans '\n') sera relue en entier au prochain passage.
      const lastNl = text.lastIndexOf('\n');
      if (lastNl >= 0) {
        const complete = text.slice(0, lastNl + 1);
        agg.offset += Buffer.byteLength(complete, 'utf8');
        for (const r of parseLines(complete).records) {
          addTo(agg.total, r);
          if (r.taskId) addTo(bucket(agg.byTask, r.taskId), r);
          if (r.agent) addTo(bucket(agg.byAgent, r.agent), r);
        }
      }
    } finally {
      await handle.close();
    }
  }
  aggregates.set(file, agg);
  return agg;
}

function sum(into: Totals, from: Totals | undefined): void {
  if (!from) return;
  into.tokens += from.tokens;
  into.costUsd += from.costUsd;
  into.unpriced += from.unpriced;
}

export interface UsedQuery {
  /** Jour UTC pour la portée 'perDay' (défaut : aujourd'hui). */
  day?: string;
  taskId?: string | null;
  agent?: string | null;
}

export interface CurrentTotals {
  perDay: Totals;
  perTask: Totals;
  perAgent: Totals;
  global: Totals;
}

/** Cumuls courants pour chaque portée de budget (lecture incrémentale du registre). */
export async function currentTotals(root: string, query: UsedQuery = {}): Promise<CurrentTotals> {
  const day = query.day ?? utcDay(Date.now());
  const out: CurrentTotals = { perDay: zero(), perTask: zero(), perAgent: zero(), global: zero() };
  for (const f of await listLedgerFiles(root)) {
    const agg = await refreshAggregate(f.file).catch((error) => {
      logger.warn({ err: error, file: f.file }, 'Registre d’usage : agrégat illisible (ignoré)');
      return null;
    });
    if (!agg) continue;
    sum(out.global, agg.total);
    if (f.date === day) sum(out.perDay, agg.total);
    if (query.taskId) sum(out.perTask, agg.byTask.get(query.taskId));
    if (query.agent) sum(out.perAgent, agg.byAgent.get(query.agent));
  }
  return out;
}

// -------------------------------------------------------------------------
// Rétention
// -------------------------------------------------------------------------

/**
 * Supprime les fichiers du registre plus vieux que `retentionDays` (jour UTC
 * du NOM de fichier — jamais interprété comme un chemin). `dryRun` : rapporte
 * seulement. Les échecs de suppression sont rapportés, jamais fatals.
 */
export async function pruneLedger(
  root: string,
  {
    retentionDays,
    dryRun = false,
    now = Date.now(),
  }: { retentionDays: number; dryRun?: boolean; now?: number },
): Promise<{
  removed: Array<{ file: string; freedBytes: number }>;
  failed: Array<{ file: string; cause: string }>;
}> {
  const cutoffDay = utcDay(now - retentionDays * 86_400_000);
  const removed: Array<{ file: string; freedBytes: number }> = [];
  const failed: Array<{ file: string; cause: string }> = [];
  for (const f of await listLedgerFiles(root)) {
    if (f.date >= cutoffDay) continue;
    const st = await stat(f.file).catch(() => null);
    if (!st) continue;
    if (!dryRun) {
      try {
        await withTransientRetry(() => rm(f.file, { force: true }));
        aggregates.delete(f.file);
      } catch (error) {
        failed.push({
          file: path.basename(f.file),
          cause: (error as { code?: string }).code ?? (error as Error).message,
        });
        continue;
      }
    }
    removed.push({ file: path.basename(f.file), freedBytes: st.size });
  }
  return { removed, failed };
}

/**
 * Métriques du banc du Router : fonctions pures (testées dans
 * tests/unit/bench-router-metrics.test.js), sans réseau ni git.
 *
 * Vocabulaire :
 *  - « code »  = fichiers qui ne sont pas de la tenue de livre partagée
 *    (CHANGELOG, README, docs, roadmap, package*.json, verrous) — la liste est
 *    celle de `tokens.router.sharedFiles` (src/router-shared.ts) ;
 *  - une tâche « sérialisée » (sentinelle `**`) entre en collision avec tout :
 *    elle compte comme COUVERTE pour le rappel et comme collision VUE pour les
 *    paires, mais est comptée à part (le coût d'une sérialisation est une attente) ;
 *  - une paire de tâches « se chevauche vraiment » si leurs fichiers RÉELS
 *    (le commit) se recoupent ; « vue » si les prédictions se recoupent
 *    (ou si l'une est sérialisée), exactement comme `detectCollisions`.
 */
import type { SharedMatcher } from '../src/router-shared.ts';

export interface Outcome {
  sha: string;
  /** Fichiers réellement modifiés par le commit. */
  truth: string[];
  /** Prédiction rendue par predictFiles (peut contenir `**`), null si erreur. */
  predicted: string[] | null;
  error: string | null;
  ms: number;
  tokensIn: number;
  tokensOut: number;
  calls: number;
}

export const WHOLE = '**';

interface Prepared {
  o: Outcome;
  failed: boolean;
  serialized: boolean;
  pred: Set<string>;
  predCode: Set<string>;
  truthAll: Set<string>;
  truthCode: Set<string>;
}

export interface PairTable {
  n: number;
  /** Indexé par i*n+j (i<j) : 1 si le chevauchement réel porte sur du code. */
  realCode: Uint8Array;
  realAll: Uint8Array;
  seen: Uint8Array;
  valid: Uint8Array;
}

export interface Metrics {
  tasks: number;
  errors: number;
  serialized: number;
  precisionAll: number;
  recallAll: number;
  precisionCode: number;
  recallCode: number;
  /** Part des tâches (hors erreurs) dont TOUS les fichiers de code réels sont couverts. */
  fullyCoveredCode: number;
  avgPredicted: number;
  pairs: {
    /** Vue « code » : chevauchement réel sur du code / alertes inutiles (collision sans chevauchement de code). */
    realCode: number;
    detectedCode: number;
    missedCode: number;
    noCodeOverlap: number;
    needlessAlarms: number;
    /** Vue stricte : tous fichiers confondus (comparable au banc historique). */
    realAll: number;
    detectedAll: number;
    noOverlapAll: number;
    falseAlarmsAll: number;
  };
  latencyMs: { p50: number; p95: number };
  tokens: { inPerTask: number; outPerTask: number; callsPerTask: number };
}

const ratio = (a: number, b: number) => (b === 0 ? Number.NaN : a / b);

function prepare(outcomes: readonly Outcome[], isShared: SharedMatcher): Prepared[] {
  return outcomes.map((o) => {
    const failed = o.error !== null || o.predicted === null;
    const predicted = o.predicted ?? [];
    const serialized = predicted.includes(WHOLE);
    const truthAll = new Set(o.truth);
    return {
      o,
      failed,
      serialized,
      pred: new Set(serialized ? [] : predicted),
      predCode: new Set(serialized ? [] : predicted.filter((f) => !isShared(f))),
      truthAll,
      truthCode: new Set(o.truth.filter((f) => !isShared(f))),
    };
  });
}

function intersects(a: Set<string>, b: Set<string>): boolean {
  const [s, l] = a.size <= b.size ? [a, b] : [b, a];
  for (const x of s) if (l.has(x)) return true;
  return false;
}

function pairTable(p: Prepared[]): PairTable {
  const n = p.length;
  const t: PairTable = {
    n,
    realCode: new Uint8Array(n * n),
    realAll: new Uint8Array(n * n),
    seen: new Uint8Array(n * n),
    valid: new Uint8Array(n * n),
  };
  for (let i = 0; i < n; i += 1) {
    for (let j = i + 1; j < n; j += 1) {
      const a = p[i]!;
      const b = p[j]!;
      const k = i * n + j;
      if (a.failed || b.failed) continue;
      t.valid[k] = 1;
      t.realCode[k] = intersects(a.truthCode, b.truthCode) ? 1 : 0;
      t.realAll[k] = intersects(a.truthAll, b.truthAll) ? 1 : 0;
      t.seen[k] = a.serialized || b.serialized || intersects(a.pred, b.pred) ? 1 : 0;
    }
  }
  return t;
}

function percentile(sorted: number[], q: number): number {
  if (sorted.length === 0) return Number.NaN;
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!;
}

/** Métriques sur un sous-ensemble (avec répétitions possibles) de tâches, par indices. */
function metricsFor(p: Prepared[], pairs: PairTable, idx: readonly number[]): Metrics {
  let errors = 0;
  let serialized = 0;
  let tpAll = 0;
  let predAll = 0;
  let truthAllN = 0;
  let tpCode = 0;
  let predCode = 0;
  let truthCodeN = 0;
  let covered = 0;
  let coverable = 0;
  let predictedTotal = 0;
  let answered = 0;
  const lat: number[] = [];
  let tIn = 0;
  let tOut = 0;
  let calls = 0;
  for (const i of idx) {
    const t = p[i]!;
    lat.push(t.o.ms);
    tIn += t.o.tokensIn;
    tOut += t.o.tokensOut;
    calls += t.o.calls;
    if (t.failed) {
      errors += 1;
      continue;
    }
    if (t.serialized) {
      serialized += 1;
      if (t.truthCode.size > 0) {
        coverable += 1;
        covered += 1;
      }
      continue;
    }
    answered += 1;
    predictedTotal += t.pred.size;
    const hitAll = [...t.truthAll].filter((f) => t.pred.has(f)).length;
    tpAll += hitAll;
    predAll += t.pred.size;
    truthAllN += t.truthAll.size;
    const hitCode = [...t.truthCode].filter((f) => t.pred.has(f)).length;
    tpCode += hitCode;
    predCode += t.predCode.size;
    truthCodeN += t.truthCode.size;
    if (t.truthCode.size > 0) {
      coverable += 1;
      if (hitCode === t.truthCode.size) covered += 1;
    }
  }
  let realCode = 0;
  let detectedCode = 0;
  let noCode = 0;
  let needless = 0;
  let realAll = 0;
  let detectedAll = 0;
  let noAll = 0;
  let falseAll = 0;
  const n = pairs.n;
  for (let a = 0; a < idx.length; a += 1) {
    for (let b = a + 1; b < idx.length; b += 1) {
      let i = idx[a]!;
      let j = idx[b]!;
      if (i === j) continue; // la même tâche tirée deux fois n'est pas une paire
      if (i > j) [i, j] = [j, i];
      const k = i * n + j;
      if (!pairs.valid[k]) continue;
      const seen = pairs.seen[k] === 1;
      if (pairs.realCode[k]) {
        realCode += 1;
        if (seen) detectedCode += 1;
      } else {
        noCode += 1;
        if (seen) needless += 1;
      }
      if (pairs.realAll[k]) {
        realAll += 1;
        if (seen) detectedAll += 1;
      } else {
        noAll += 1;
        if (seen) falseAll += 1;
      }
    }
  }
  const sortedLat = lat.sort((x, y) => x - y);
  const total = idx.length;
  return {
    tasks: total,
    errors,
    serialized,
    precisionAll: ratio(tpAll, predAll),
    recallAll: ratio(tpAll, truthAllN),
    precisionCode: ratio(tpCode, predCode),
    recallCode: ratio(tpCode, truthCodeN),
    fullyCoveredCode: ratio(covered, coverable),
    avgPredicted: ratio(predictedTotal, answered),
    pairs: {
      realCode,
      detectedCode,
      missedCode: realCode - detectedCode,
      noCodeOverlap: noCode,
      needlessAlarms: needless,
      realAll,
      detectedAll,
      noOverlapAll: noAll,
      falseAlarmsAll: falseAll,
    },
    latencyMs: { p50: percentile(sortedLat, 0.5), p95: percentile(sortedLat, 0.95) },
    tokens: {
      inPerTask: ratio(tIn, total),
      outPerTask: ratio(tOut, total),
      callsPerTask: ratio(calls, total),
    },
  };
}

export function evaluate(outcomes: readonly Outcome[], isShared: SharedMatcher): Metrics {
  const p = prepare(outcomes, isShared);
  return metricsFor(
    p,
    pairTable(p),
    outcomes.map((_, i) => i),
  );
}

/** PRNG déterministe (mulberry32) : un banc reproductible. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface Interval {
  value: number;
  lo: number;
  hi: number;
}

export interface Intervals {
  precisionCode: Interval;
  recallCode: Interval;
  recallAll: Interval;
  fullyCoveredCode: Interval;
  detectionCode: Interval;
  needlessAlarmRate: Interval;
  detectionAll: Interval;
  falseAlarmRateAll: Interval;
  serializedRate: Interval;
}

const pick: Record<keyof Intervals, (m: Metrics) => number> = {
  precisionCode: (m) => m.precisionCode,
  recallCode: (m) => m.recallCode,
  recallAll: (m) => m.recallAll,
  fullyCoveredCode: (m) => m.fullyCoveredCode,
  detectionCode: (m) => ratio(m.pairs.detectedCode, m.pairs.realCode),
  needlessAlarmRate: (m) => ratio(m.pairs.needlessAlarms, m.pairs.noCodeOverlap),
  detectionAll: (m) => ratio(m.pairs.detectedAll, m.pairs.realAll),
  falseAlarmRateAll: (m) => ratio(m.pairs.falseAlarmsAll, m.pairs.noOverlapAll),
  serializedRate: (m) => ratio(m.serialized, m.tasks),
};

/**
 * Intervalles de confiance à 95 % par bootstrap PERCENTILE sur les TÂCHES
 * (ré-échantillonnage avec remise ; les paires sont recalculées à chaque tirage).
 * Étroits seulement si l'échantillon est grand : sur ~35 tâches ils sont larges,
 * et c'est l'information honnête.
 */
export function bootstrap(
  outcomes: readonly Outcome[],
  isShared: SharedMatcher,
  { iterations = 2000, seed = 20261026 } = {},
): Intervals {
  const p = prepare(outcomes, isShared);
  const pairs = pairTable(p);
  const all = outcomes.map((_, i) => i);
  const point = metricsFor(p, pairs, all);
  const rand = rng(seed);
  const samples: Record<string, number[]> = {};
  for (const key of Object.keys(pick)) samples[key] = [];
  for (let b = 0; b < iterations; b += 1) {
    const idx = Array.from({ length: all.length }, () => Math.floor(rand() * all.length));
    const m = metricsFor(p, pairs, idx);
    for (const [key, fn] of Object.entries(pick)) {
      const v = fn(m);
      if (!Number.isNaN(v)) samples[key]!.push(v);
    }
  }
  const out = {} as Intervals;
  for (const [key, fn] of Object.entries(pick)) {
    const s = samples[key]!.sort((x, y) => x - y);
    out[key as keyof Intervals] = {
      value: fn(point),
      lo: percentile(s, 0.025),
      hi: percentile(s, 0.975),
    };
  }
  return out;
}

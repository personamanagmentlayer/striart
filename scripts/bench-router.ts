#!/usr/bin/env node
/**
 * Évaluation du Router sur l'HISTORIQUE RÉEL du dépôt — `npm run bench:router`.
 *
 * Réseau + clés d'API requis (lues dans le `.env` de la racine, jamais
 * affichées) : chaque cas fait de vrais appels au LLM. Opt-in, hors `npm test`.
 *
 * Protocole (reproductible, sans jugement humain) :
 *  - tâche  = demande NATURELLE et VAGUE, générée une fois par un LLM à partir
 *    du diff sans chemin ni symbole (scripts/bench-router-corpus.ts, corpus
 *    versionné dans scripts/data/router-bench-tasks.json) — pas le message du
 *    commit, écrit après coup et optimiste ;
 *  - arbre  = `git ls-tree` du commit PARENT (ce que voyait le Router), et ses
 *    sources lues dans les objets git (carte du dépôt, graphe d'imports) ;
 *  - vérité = fichiers que ce commit a réellement modifiés ;
 *  - jeu de RÉGLAGE (~60 %) et jeu de TEST tenu à l'écart (~40 %), partition
 *    fixée par l'empreinte du SHA : on règle sur `tune`, on RAPPORTE sur `test` ;
 *  - précision / rappel (code et total), couverture complète, détection des
 *    chevauchements sur toutes les paires (vus / manqués ; alertes inutiles),
 *    jetons et latence, intervalles de confiance à 95 % par bootstrap.
 *
 * Cache : chaque requête LLM (empreinte de l'URL + du corps + rang d'occurrence
 * dans la prédiction) est mémorisée sur disque (`--cache-dir`, hors dépôt) :
 * changer une variante purement déterministe (expansion, tenue de livre,
 * seuils) ne repaie rien ; une variante qui change le prompt repaie.
 *
 * Variantes : `legacy` (préréglage d'avant le lot), `balanced` (défaut livré),
 * `recall`, `default` (= défauts du jour) et les ablations de
 * `scripts/data/router-bench-variants.json` (patchs de `tokens.router` sur
 * `legacy`). Le jeu `test` ne sert qu'à CONFIRMER : on règle sur `tune`.
 * Les tarifs ($/M jetons entrée,sortie) sont des HYPOTHÈSES à remplacer.
 *
 * Usage : node scripts/bench-router.ts [--providers anthropic,openai,groq]
 *         [--variants legacy,balanced,recall] [--split test|tune|all] [--limit N]
 *         [--concurrency 4] [--out rapport.json] [--cache-dir DIR] [--details]
 *         [--model-anthropic ID] [--model-openai ID] [--model-groq ID]
 *         [--price-anthropic 1,5] [--price-openai 0.75,4.5] [--price-groq 0.15,0.6]
 *         [--anthropic-thinking off] [--variant-json '{"name":"x","router":{…}}']
 *         [--variants-file F.json]  ablations alternatives
 *         [--misses]                pourquoi un fichier de code manque (lexical / structurel / invisible)
 *         [--retrieval-only]        rappel@k de la récupération lexicale seule (sans LLM, gratuit)
 */
import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { AsyncLocalStorage } from 'node:async_hooks';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, parseEnv } from 'node:util';
import { bootstrap, evaluate } from './bench-router-metrics.ts';
import type { Outcome } from './bench-router-metrics.ts';

process.env.STRIART_TOKENS_NO_DISCOVERY = '1'; // ni comptabilité ni cache disque : un banc ne pollue pas .striart/
const ROOT = fileURLToPath(new URL('..', import.meta.url));

// `.env` : parsé (jamais exécuté), seules les clés connues sont retenues.
try {
  const env = parseEnv(readFileSync(new URL('../.env', import.meta.url), 'utf8'));
  for (const name of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GROQ_API_KEY']) {
    if (env[name] && !process.env[name]) process.env[name] = env[name];
  }
} catch {
  // Pas de .env : les clés viennent peut-être déjà de l'environnement.
}

const { DEFAULT_CONFIG } = await import('../src/config.js');
const { compileSharedMatcher, DEFAULT_SHARED_PATTERNS } = await import('../src/router-shared.ts');
const { predictFilesDetailed, WHOLE_REPO } = await import('../src/router.js');

const { values } = parseArgs({
  options: {
    providers: { type: 'string', default: 'anthropic' },
    variants: { type: 'string', default: 'legacy' },
    'variant-json': { type: 'string' },
    split: { type: 'string', default: 'test' },
    limit: { type: 'string' },
    concurrency: { type: 'string', default: '4' },
    out: { type: 'string' },
    'cache-dir': { type: 'string' },
    'model-anthropic': { type: 'string', default: 'claude-haiku-5-5' },
    'model-openai': { type: 'string', default: 'gpt-5.4-mini' },
    'model-groq': { type: 'string', default: 'openai/gpt-oss-120b' },
    'price-anthropic': { type: 'string', default: '1,5' },
    'price-openai': { type: 'string', default: '0.75,4.5' },
    'price-groq': { type: 'string', default: '0.15,0.6' },
    'anthropic-thinking': { type: 'string', default: 'as-is' },
    details: { type: 'boolean', default: false },
    'retrieval-only': { type: 'boolean', default: false },
    'variants-file': { type: 'string' },
    misses: { type: 'boolean', default: false },
    'bm25-json': { type: 'string' },
  },
});

const PROVIDERS: Record<string, { llm: Record<string, string>; keyEnv: string; price: string }> = {
  anthropic: {
    llm: {
      provider: 'anthropic',
      model: values['model-anthropic']!,
      apiKeyEnv: 'ANTHROPIC_API_KEY',
    },
    keyEnv: 'ANTHROPIC_API_KEY',
    price: values['price-anthropic']!,
  },
  openai: {
    llm: { provider: 'openai', model: values['model-openai']!, apiKeyEnv: 'OPENAI_API_KEY' },
    keyEnv: 'OPENAI_API_KEY',
    price: values['price-openai']!,
  },
  groq: {
    llm: {
      provider: 'openai',
      model: values['model-groq']!,
      baseUrl: 'https://api.groq.com/openai/v1',
      apiKeyEnv: 'GROQ_API_KEY',
    },
    keyEnv: 'GROQ_API_KEY',
    price: values['price-groq']!,
  },
};

/**
 * Variantes : patchs de `tokens.router`. `legacy` fige le comportement
 * d'AVANT le lot (aucune carte, aucune expansion, tenue de livre conservée,
 * un tirage, prompt historique) — la base de comparaison, quels que soient les
 * défauts d'aujourd'hui. `default` = réglage livré (rien de surchargé).
 */
const LEGACY = { preset: 'legacy' };
const VARIANTS: Record<string, Record<string, unknown>> = {
  legacy: LEGACY,
  balanced: { preset: 'balanced' },
  recall: { preset: 'recall' },
  default: {},
};

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v);
function deepMerge(base: Rec, patch: Rec): Rec {
  const out: Rec = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    out[k] = isRec(v) && isRec(base[k]) ? deepMerge(base[k] as Rec, v) : v;
  }
  return out;
}
if (values['variant-json']) {
  const extra = JSON.parse(values['variant-json']) as {
    name: string;
    router: Record<string, unknown>;
  };
  VARIANTS[extra.name] = extra.router;
}
// Fichier de variantes optionnel (ablations) : { "nom": { …patch tokens.router… } }
const variantsFile =
  values['variants-file'] ?? path.join(ROOT, 'scripts', 'data', 'router-bench-variants.json');
if (existsSync(variantsFile)) {
  for (const [name, patch] of Object.entries(
    JSON.parse(readFileSync(variantsFile, 'utf8')) as Record<string, Record<string, unknown>>,
  )) {
    // Une ablation est un patch sur le comportement HISTORIQUE (pas sur les défauts du jour) :
    // elle reste comparable quand les défauts livrés changent. `"_base": "default"` pour partir des défauts.
    if (name.startsWith('_')) continue;
    const { _base, ...rest } = patch as Rec;
    VARIANTS[name] = _base === 'default' ? rest : deepMerge(LEGACY, rest);
  }
}

const git = (...args: string[]) =>
  execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });

// ---------------------------------------------------------------------------
// Sources d'un commit passé, lues dans les objets git (client `cat-file --batch`)
// ---------------------------------------------------------------------------

class CatFile {
  private child: ChildProcessWithoutNullStreams;
  private buf = Buffer.alloc(0);
  private waiting: Array<(b: Buffer | null) => void> = [];
  private chain: Promise<unknown> = Promise.resolve();
  constructor() {
    this.child = spawn('git', ['cat-file', '--batch'], { cwd: ROOT });
    this.child.stdout.on('data', (d: Buffer) => {
      this.buf = Buffer.concat([this.buf, d]);
      this.drain();
    });
    this.child.stderr.on('data', () => undefined);
  }
  private drain(): void {
    for (;;) {
      const nl = this.buf.indexOf(0x0a);
      if (nl < 0 || this.waiting.length === 0) return;
      const header = this.buf.subarray(0, nl).toString('utf8');
      const m = /^[0-9a-f]+ \w+ (\d+)$/.exec(header);
      if (!m) {
        this.buf = this.buf.subarray(nl + 1);
        this.waiting.shift()!(null);
        continue;
      }
      const size = Number(m[1]);
      if (this.buf.length < nl + 1 + size + 1) return;
      const content = this.buf.subarray(nl + 1, nl + 1 + size);
      this.buf = this.buf.subarray(nl + 1 + size + 1);
      this.waiting.shift()!(Buffer.from(content));
    }
  }
  get(oid: string): Promise<Buffer | null> {
    const run = () =>
      new Promise<Buffer | null>((resolve) => {
        this.waiting.push(resolve);
        this.child.stdin.write(`${oid}\n`);
      });
    const p = this.chain.then(run, run);
    this.chain = p.catch(() => undefined);
    return p;
  }
  close(): void {
    this.child.stdin.end();
  }
}

const catFile = new CatFile();
const MAX_SOURCE_BYTES = 200_000;

function gitSources(sha: string) {
  const oids = new Map<string, string>();
  for (const line of git('ls-tree', '-r', `${sha}^`).split('\n')) {
    const m = /^\d+ blob ([0-9a-f]+)\t(.+)$/.exec(line);
    if (m) oids.set(m[2]!, m[1]!);
  }
  return {
    files: [...oids.keys()],
    sources: {
      async version(file: string) {
        return oids.get(file) ?? null;
      },
      async read(file: string) {
        const oid = oids.get(file);
        if (!oid) return null;
        const buf = await catFile.get(oid);
        if (!buf || buf.length > MAX_SOURCE_BYTES || buf.includes(0)) return null;
        return buf.toString('utf8');
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Fetch instrumenté : cache disque des réponses LLM + relevé des jetons
// ---------------------------------------------------------------------------

interface Meter {
  llmMs: number;
  fetchWall: number;
  tokensIn: number;
  tokensOut: number;
  calls: number;
  seen: Map<string, number>;
}
const meters = new AsyncLocalStorage<Meter>();
const cacheDir =
  values['cache-dir'] ??
  path.join(process.env.TEMP ?? process.env.TMPDIR ?? '/tmp', 'striart-router-bench-cache');
mkdirSync(cacheDir, { recursive: true });
const realFetch = globalThis.fetch;

interface Usage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  prompt_tokens?: number;
  completion_tokens?: number;
}

function readUsage(provider: string, data: { usage?: Usage } | null): { in: number; out: number } {
  const u: Usage = data?.usage ?? {};
  if (provider === 'anthropic')
    return {
      in:
        (u.input_tokens ?? 0) +
        (u.cache_creation_input_tokens ?? 0) +
        (u.cache_read_input_tokens ?? 0),
      out: u.output_tokens ?? 0,
    };
  return { in: u.prompt_tokens ?? 0, out: u.completion_tokens ?? 0 };
}

globalThis.fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  const meter = meters.getStore();
  if (!meter || typeof init.body !== 'string') return realFetch(input, init);
  const provider = url.includes('anthropic.com') ? 'anthropic' : 'openai';
  let body = init.body;
  if (provider === 'anthropic' && values['anthropic-thinking'] === 'off') {
    body = JSON.stringify({ ...JSON.parse(body), thinking: { type: 'disabled' } });
  }
  const base = createHash('sha256').update(url).update('\0').update(body).digest('hex');
  const rank = meter.seen.get(base) ?? 0;
  meter.seen.set(base, rank + 1);
  const key = createHash('sha256').update(`${base}:${rank}`).digest('hex');
  const wallStart = Date.now();
  const file = path.join(cacheDir, `${key}.json`);
  let record: { status: number; text: string; ms: number } | null = null;
  if (existsSync(file)) record = JSON.parse(readFileSync(file, 'utf8'));
  if (!record) {
    const t0 = Date.now();
    const res = await realFetch(input, { ...init, body });
    const text = await res.text();
    record = { status: res.status, text, ms: Date.now() - t0 };
    if (res.ok) writeFileSync(file, JSON.stringify(record)); // jamais une erreur transitoire
  }
  meter.calls += 1;
  meter.llmMs += record.ms;
  meter.fetchWall += Date.now() - wallStart;
  try {
    const usage = readUsage(provider, JSON.parse(record.text));
    meter.tokensIn += usage.in;
    meter.tokensOut += usage.out;
  } catch {
    // Réponse non JSON (erreur HTTP) : pas de jetons à relever.
  }
  return new Response(record.text, {
    status: record.status,
    headers: { 'content-type': 'application/json' },
  });
}) as typeof fetch;

// ---------------------------------------------------------------------------
// Corpus
// ---------------------------------------------------------------------------

/** Historique complet (plus récent d'abord) : fichiers de chaque commit, pour la co-modification AVANT un commit donné. */
let fullHistory: Array<{ sha: string; files: string[] }> | null = null;
function historyBefore(sha: string, limit = 400): string[][] {
  if (!fullHistory) {
    fullHistory = git('log', '--no-merges', '--format=%x1e%H', '--name-only')
      .split(String.fromCharCode(30))
      .filter(Boolean)
      .map((entry) => {
        const [h, ...files] = entry.trim().split(String.fromCharCode(10));
        return { sha: h!, files: files.filter(Boolean) };
      });
  }
  const at = fullHistory.findIndex((c) => c.sha === sha);
  return fullHistory.slice(at + 1, at + 1 + limit).map((c) => c.files);
}

interface Case {
  sha: string;
  split: 'tune' | 'test';
  task: string;
  truth: string[];
  tree: string[];
  history: string[][];
  sources: ReturnType<typeof gitSources>['sources'];
}

function loadCases(): Case[] {
  const corpus = JSON.parse(
    readFileSync(new URL('./data/router-bench-tasks.json', import.meta.url), 'utf8'),
  ) as { cases: Array<{ sha: string; split: 'tune' | 'test'; task: string }> };
  const wanted = values.split === 'all' ? ['tune', 'test'] : [values.split];
  let cases = corpus.cases.filter((c) => wanted.includes(c.split));
  if (values.limit) cases = cases.slice(0, Number(values.limit));
  return cases.map((c) => {
    const truth = git('diff-tree', '--no-commit-id', '--name-only', '-r', c.sha)
      .split('\n')
      .filter(Boolean);
    const { files, sources } = gitSources(c.sha);
    return { ...c, truth, tree: files, sources, history: historyBefore(c.sha) };
  });
}

async function mapLimit<T, R>(items: T[], n: number, fn: (item: T, i: number) => Promise<R>) {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]!, i);
      }
    }),
  );
  return out;
}

const pct = (n: number) => (Number.isNaN(n) ? '  n/a' : `${(n * 100).toFixed(0)}%`.padStart(4));
const ci = (i: { value: number; lo: number; hi: number }) =>
  `${pct(i.value)} [${pct(i.lo).trim()}–${pct(i.hi).trim()}]`;

const isShared = compileSharedMatcher(DEFAULT_SHARED_PATTERNS);

/**
 * Pourquoi un fichier de code réel manque-t-il ? On teste ce qu'aucun signal
 * déterministe ne pourrait rattraper : le fichier est-il dans les 40 premiers
 * candidats lexicaux, atteignable par expansion (tests, imports, frères, jumeaux,
 * co-modification) depuis ce que le Router a prédit, ou INVISIBLE (couplage
 * sémantique sans trace textuelle ni structurelle) ?
 */
async function analyzeMisses(cases: Case[], outcomes: Outcome[]) {
  const { buildRepoMap } = await import('../src/router-map.ts');
  const { buildRetrievalIndex, retrieve } = await import('../src/router-retrieval.ts');
  const { buildImportGraph, invertImportGraph } = await import('../src/imports.js');
  const { expandPrediction } = await import('../src/router-expand.ts');
  const { buildCoChange } = await import('../src/router-cochange.ts');
  const counts = { missed: 0, lexical: 0, structural: 0, invisible: 0 };
  const byKind: Record<string, number> = {};
  const invisible: string[] = [];
  for (let i = 0; i < cases.length; i += 1) {
    const c = cases[i]!;
    const o = outcomes[i]!;
    if (!o.predicted || o.predicted.includes(WHOLE_REPO)) continue;
    const predicted = new Set(o.predicted);
    const missed = c.truth.filter((f) => !isShared(f) && !predicted.has(f) && c.tree.includes(f));
    if (missed.length === 0) continue;
    const summaries = await buildRepoMap(c.tree, c.sources);
    const top = new Set(
      retrieve(buildRetrievalIndex(c.tree, summaries), c.task, { topK: 40 }).map((r) => r.path),
    );
    const graph = await buildImportGraph('', c.tree, c.sources);
    const reachable = new Set(
      expandPrediction({
        core: o.predicted.map((path) => ({ path, confidence: 1 })),
        files: new Set(c.tree),
        graph,
        inverse: invertImportGraph(graph),
        coChange: buildCoChange(c.history),
        settings: {
          imports: 'both',
          depth: 2,
          tests: true,
          siblings: true,
          contracts: true,
          coChange: true,
          maxAdded: 500,
        },
      }).map((a) => a.path),
    );
    for (const f of missed) {
      counts.missed += 1;
      const kind = /^tests?\//.test(f)
        ? 'test'
        : /^(src|native|scripts)\//.test(f)
          ? 'source'
          : 'autre';
      if (top.has(f)) counts.lexical += 1;
      else if (reachable.has(f)) counts.structural += 1;
      else {
        counts.invisible += 1;
        byKind[kind] = (byKind[kind] ?? 0) + 1;
        if (invisible.length < 12) invisible.push(f);
      }
    }
  }
  return { ...counts, invisibleByKind: byKind, invisibleExamples: invisible };
}

async function run(providerName: string, variantName: string, cases: Case[]) {
  const spec = PROVIDERS[providerName]!;
  if (!process.env[spec.keyEnv]) {
    console.error(`[${providerName}] ignoré : ${spec.keyEnv} absente.`);
    return null;
  }
  const patch = VARIANTS[variantName]!;
  const config = {
    ...DEFAULT_CONFIG,
    llm: { ...DEFAULT_CONFIG.llm, ...spec.llm },
    tokens: { router: patch },
  };
  const details: Array<Record<string, unknown>> = [];
  const outcomes = await mapLimit(
    cases,
    Number(values.concurrency),
    async (c): Promise<Outcome> => {
      const meter: Meter = {
        llmMs: 0,
        fetchWall: 0,
        tokensIn: 0,
        tokensOut: 0,
        calls: 0,
        seen: new Map(),
      };
      const t0 = Date.now();
      let predicted: string[] | null = null;
      let error: string | null = null;
      let extra: unknown = null;
      try {
        await meters.run(meter, async () => {
          const params = {
            prompt: c.task,
            projectFiles: c.tree,
            config,
            timeoutMs: 120_000,
            retries: 2,
            headSha: `${c.sha}^`,
            sources: c.sources,
            history: c.history,
          };
          const r = await predictFilesDetailed(params);
          predicted = r.files;
          extra = r.details;
        });
      } catch (e) {
        const x = e as { code?: string; message?: string; details?: { cause?: string } };
        error = `${x.code ?? 'ERR'}: ${(x.details?.cause ?? x.message ?? '').slice(0, 140)}`;
      }
      details.push({ sha: c.sha, task: c.task, truth: c.truth, predicted, error, extra });
      return {
        sha: c.sha,
        truth: c.truth,
        predicted,
        error,
        // Latence = durée RÉSEAU d'origine des appels (conservée par le cache) + calcul local réel.
        ms: Date.now() - t0 - meter.fetchWall + meter.llmMs,
        tokensIn: meter.tokensIn,
        tokensOut: meter.tokensOut,
        calls: meter.calls,
      };
    },
  );
  const missesReport = values.misses ? await analyzeMisses(cases, outcomes) : null;
  const [pin, pout] = spec.price.split(',').map(Number) as [number, number];
  const metrics = evaluate(outcomes, isShared);
  const intervals = bootstrap(outcomes, isShared);
  const costPerTask =
    (metrics.tokens.inPerTask * pin + metrics.tokens.outPerTask * pout) / 1_000_000;
  return {
    provider: providerName,
    model: spec.llm.model,
    variant: variantName,
    split: values.split,
    cases: cases.length,
    metrics,
    intervals,
    costPerTaskUsd: costPerTask,
    priceAssumption: { inPerMTok: pin, outPerMTok: pout },
    errors: [...new Set(outcomes.filter((o) => o.error).map((o) => o.error))],
    outcomes,
    ...(missesReport ? { misses: missesReport } : {}),
    ...(values.details ? { details } : {}),
  };
}

const cases = loadCases();

if (values['retrieval-only']) {
  const { buildRepoMap } = await import('../src/router-map.ts');
  const { buildRetrievalIndex, retrieve } = await import('../src/router-retrieval.ts');
  const tuning = values['bm25-json'] ? JSON.parse(values['bm25-json']) : {};
  for (const bilingual of [false, true]) {
    const ks = [5, 10, 20, 40];
    const hits = ks.map(() => 0);
    let total = 0;
    let anyHit10 = 0;
    for (const c of cases) {
      const summaries = await buildRepoMap(c.tree, c.sources);
      const ranked = retrieve(
        buildRetrievalIndex(c.tree, summaries, {
          dir: 1,
          base: 3,
          symbols: 2,
          doc: 1,
          ...tuning.w,
        }),
        c.task,
        {
          topK: 40,
          bilingual,
          ...tuning.p,
        },
      );
      const code = c.truth.filter((f) => !isShared(f) && c.tree.includes(f));
      total += code.length;
      ks.forEach((k, idx) => {
        const top = new Set(ranked.slice(0, k).map((r) => r.path));
        hits[idx]! += code.filter((f) => top.has(f)).length;
      });
      if (code.some((f) => ranked.slice(0, 10).some((r) => r.path === f))) anyHit10 += 1;
    }
    console.log(
      `BM25 bilingual=${bilingual} (${cases.length} tâches, ${total} fichiers de code existants avant le commit) : ` +
        ks.map((k, idx) => `rappel@${k}=${((100 * hits[idx]!) / total).toFixed(0)}%`).join(' ') +
        ` ; au moins un bon fichier dans le top 10 : ${anyHit10}/${cases.length}`,
    );
  }
  catFile.close();
  process.exit(0);
}
console.error(
  `${cases.length} tâches (${values.split}) ; HEAD ${git('rev-parse', '--short', 'HEAD').trim()} ; cache ${cacheDir}`,
);
const results: NonNullable<Awaited<ReturnType<typeof run>>>[] = [];
for (const name of values.providers!.split(',').map((s) => s.trim())) {
  if (!PROVIDERS[name]) {
    console.error(`Fournisseur inconnu : ${name}`);
    continue;
  }
  for (const variant of values.variants!.split(',').map((s) => s.trim())) {
    if (!VARIANTS[variant]) {
      console.error(`Variante inconnue : ${variant}`);
      continue;
    }
    const r = await run(name, variant, cases);
    if (r) results.push(r);
  }
}
catFile.close();

const f1 = (n: number) => (Number.isNaN(n) ? 'n/a' : n.toFixed(1));
console.log(
  `\nRouter — évaluation sur historique réel (jeu « ${values.split} », ${cases.length} tâches ; IC 95 % bootstrap entre crochets)`,
);
console.log(
  [
    'fournisseur/variante'.padEnd(30),
    'préc.code'.padEnd(14),
    'rappel code'.padEnd(14),
    'rappel tout'.padEnd(14),
    'couv.complète'.padEnd(14),
    'détect.code'.padEnd(14),
    'alertes inutiles'.padEnd(16),
    'J'.padEnd(4),
    'sér.',
    'err',
    'préd.',
    'jetons',
    '$/tâche',
    'p50',
  ].join(' '),
);
for (const r of results) {
  const i = r.intervals;
  const m = r.metrics;
  console.log(
    [
      `${r.provider}/${r.variant}`.padEnd(30),
      ci(i.precisionCode).padEnd(14),
      ci(i.recallCode).padEnd(14),
      ci(i.recallAll).padEnd(14),
      ci(i.fullyCoveredCode).padEnd(14),
      ci(i.detectionCode).padEnd(14),
      `${(100 * (i.detectionCode.value - i.needlessAlarmRate.value)).toFixed(0)}`.padEnd(4),
      ci(i.needlessAlarmRate).padEnd(16),
      pct(i.serializedRate.value),
      String(m.errors).padStart(3),
      f1(m.avgPredicted).padStart(5),
      `${(m.tokens.inPerTask / 1000).toFixed(1)}k+${m.tokens.outPerTask.toFixed(0)}`,
      `$${r.costPerTaskUsd.toFixed(4)}`,
      `${m.latencyMs.p50}ms`,
    ].join(' '),
  );
}
console.log(
  '\nPaires (vue code = chevauchement sur fichiers hors tenue de livre ; vue stricte = tous fichiers)',
);
for (const r of results) {
  const p = r.metrics.pairs;
  console.log(
    `${r.provider}/${r.variant}: code ${p.detectedCode}/${p.realCode} vus (${p.missedCode} manqués), ${p.needlessAlarms}/${p.noCodeOverlap} alertes inutiles | strict ${p.detectedAll}/${p.realAll} vus, ${p.falseAlarmsAll}/${p.noOverlapAll} fausses alertes (${ci(r.intervals.falseAlarmRateAll)})`,
  );
  for (const e of r.errors) console.log(`   erreur : ${e}`);
  if ('misses' in r && r.misses)
    console.log(`   fichiers de code manqués : ${JSON.stringify(r.misses)}`);
}
console.log(
  `(tarif supposé $/M jetons entrée,sortie : ${[...new Set(results.map((r) => `${r.provider}=${r.priceAssumption.inPerMTok},${r.priceAssumption.outPerMTok}`))].join(' ')} — hypothèse à remplacer par le tarif réel)`,
);
void WHOLE_REPO;
if (values.out)
  writeFileSync(
    values.out,
    JSON.stringify({ at: new Date().toISOString(), split: values.split, results }, null, 2),
  );

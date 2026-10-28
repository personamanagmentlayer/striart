#!/usr/bin/env node
/**
 * Évaluation de la FUSION SÉMANTIQUE avec un vrai LLM — `npm run bench:merger`.
 * Réseau + clés d'API (`.env`, jamais affichées). Opt-in, hors `npm test`.
 *
 * Pourquoi un jeu d'or plutôt que l'historique : l'historique d'un dépôt est
 * linéaire. Un correctif qui s'applique seul sur l'ancêtre n'entre pas en
 * conflit textuel ; un qui entre en conflit a été écrit SUR l'autre (donc n'est
 * pas indépendant) — aucun vrai conflit concurrent n'y est reconstituable.
 *
 * Chaque cas : BASE / A (branche principale) / B (branche agent) qui se
 * chevauchent TEXTUELLEMENT (git les déclare en conflit — vérifié par le banc)
 * mais restent compatibles en INTENTION, plus une vérification EXÉCUTABLE : le
 * fichier fusionné est importé et son comportement est contrôlé. Une fusion
 * « qui a l'air juste » mais fausse échoue donc ; le Test Gate de Striart fait
 * le même travail avec la suite du projet.
 *
 * Usage : node scripts/bench-merger.ts [--provider anthropic|openai|groq]
 *         [--model ID] [--repeat 2] [--only nom] [--out rapport.json]
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs, parseEnv } from 'node:util';

process.env.STRIART_TOKENS_NO_DISCOVERY = '1';

try {
  const env = parseEnv(readFileSync(new URL('../.env', import.meta.url), 'utf8'));
  for (const name of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GROQ_API_KEY']) {
    if (env[name] && !process.env[name]) process.env[name] = env[name];
  }
} catch {
  // Pas de .env : les clés viennent peut-être déjà de l'environnement.
}

const { DEFAULT_CONFIG } = await import('../src/config.js');
const { semanticMerge } = await import('../src/merger.js');

const { values } = parseArgs({
  options: {
    provider: { type: 'string', default: 'anthropic' },
    model: { type: 'string' },
    repeat: { type: 'string', default: '3' },
    only: { type: 'string' },
    out: { type: 'string' },
  },
});

const LLMS: Record<string, Record<string, string>> = {
  anthropic: { provider: 'anthropic', model: 'claude-haiku-5-5', apiKeyEnv: 'ANTHROPIC_API_KEY' },
  openai: { provider: 'openai', model: 'gpt-5.4-mini', apiKeyEnv: 'OPENAI_API_KEY' },
  groq: {
    provider: 'openai',
    model: 'openai/gpt-oss-120b',
    baseUrl: 'https://api.groq.com/openai/v1',
    apiKeyEnv: 'GROQ_API_KEY',
  },
};
if (!LLMS[values.provider!]) throw new Error(`fournisseur inconnu : ${values.provider}`);
const llm = { ...LLMS[values.provider!] };
if (values.model) llm.model = values.model;
const config = { ...DEFAULT_CONFIG, llm: { ...DEFAULT_CONFIG.llm, ...llm } };

// Module importé dynamiquement (code sous test) : son contrat est celui de chaque cas.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Mod = Record<string, any>;
interface Golden {
  name: string;
  file: string;
  base: string;
  ours: string;
  theirs: string;
  /** Contrôle de comportement du fichier fusionné ; lève en cas d'écart. */
  verify: (m: Mod) => void;
}

const eq = (actual: unknown, expected: unknown, what: string) => {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `${what} : attendu ${JSON.stringify(expected)}, obtenu ${JSON.stringify(actual)}`,
    );
  }
};

/** Fichier de remplissage réaliste : force le mode « régions » du Merger au-delà du seuil. */
const filler = (from: number, n: number) =>
  Array.from({ length: n }, (_, k) => from + k)
    .map((i) => `// utilitaire ${i}\nexport function util${i}(x) {\n  return x + ${i};\n}\n`)
    .join('\n');

const GOLDEN: Golden[] = [
  {
    name: 'deux ajouts au même endroit',
    file: 'lib.js',
    base: `export const a = () => 1;\n`,
    ours: `export const a = () => 1;\nexport const b = () => 2;\n`,
    theirs: `export const a = () => 1;\nexport const c = () => 3;\n`,
    verify: (m) => eq([m.a(), m.b(), m.c()], [1, 2, 3], 'a,b,c'),
  },
  {
    name: 'même ligne, intentions composables',
    file: 'calc.js',
    base: `export const offset = 0;\nexport function f(x) {\n  return x + 1;\n}\n`,
    ours: `export const offset = 10;\nexport function f(x) {\n  return x + 1 + offset;\n}\n`,
    theirs: `export const offset = 0;\nexport function f(x) {\n  return Math.max(0, x + 1);\n}\n`,
    // Attendu : plancher à 0 ET décalage de 10 conservé.
    verify: (m) => {
      eq(m.f(-50), 0, 'f(-50) (plancher)');
      eq(m.f(5) >= 16, true, 'f(5) conserve le décalage');
    },
  },
  {
    name: 'renommage contre nouvel appelant',
    file: 'money.js',
    base: `export function sum(list) {\n  return list.reduce((a, b) => a + b, 0);\n}\nexport function report(list) {\n  return 'total=' + sum(list);\n}\n`,
    ours: `export function total(list) {\n  return list.reduce((a, b) => a + b, 0);\n}\nexport function report(list) {\n  return 'total=' + total(list);\n}\n`,
    theirs: `export function sum(list) {\n  return list.reduce((a, b) => a + b, 0);\n}\nexport function report(list) {\n  return 'total=' + sum(list);\n}\nexport function average(list) {\n  return sum(list) / list.length;\n}\n`,
    // Après renommage, `average` doit appeler `total` : `sum` n'existe plus.
    verify: (m) => {
      eq(m.report([1, 2, 3]), 'total=6', 'report');
      eq(m.average([2, 4]), 3, 'average (appelle le nouveau nom)');
    },
  },
  {
    name: 'signature étendue contre nouvel appel',
    file: 'fmt.js',
    base: `export function fmt(v) {\n  return String(v);\n}\nexport const label = fmt(1);\n`,
    ours: `export function fmt(v, suffix = '') {\n  return String(v) + suffix;\n}\nexport const label = fmt(1);\n`,
    theirs: `export function fmt(v) {\n  return String(v);\n}\nexport const label = fmt(1);\nexport const other = fmt(2);\n`,
    verify: (m) => {
      eq([m.fmt(3), m.fmt(3, 'x')], ['3', '3x'], 'fmt');
      eq(m.label, '1', 'label');
      eq(m.other, '2', 'other');
    },
  },
  {
    name: 'objet de configuration : deux clés',
    file: 'config.js',
    base: `export const config = {\n  retries: 3,\n  timeout: 1000,\n};\n`,
    ours: `export const config = {\n  retries: 3,\n  timeout: 1000,\n  verbose: true,\n};\n`,
    theirs: `export const config = {\n  retries: 3,\n  timeout: 1000,\n  region: 'eu',\n};\n`,
    verify: (m) =>
      eq(m.config, { retries: 3, timeout: 1000, verbose: true, region: 'eu' }, 'config'),
  },
  {
    name: 'même bogue corrigé de deux façons',
    file: 'guard.js',
    base: `export function isEmpty(x) {\n  return x.length === 0;\n}\n`,
    ours: `export function isEmpty(x) {\n  return x == null || x.length === 0;\n}\n`,
    theirs: `export function isEmpty(x) {\n  return x === undefined || x === null || !x.length;\n}\n`,
    verify: (m) =>
      eq(
        [m.isEmpty(null), m.isEmpty(undefined), m.isEmpty([]), m.isEmpty([1])],
        [true, true, true, false],
        'isEmpty',
      ),
  },
  {
    name: 'classe : méthode contre champ + constructeur',
    file: 'counter.js',
    base: `export class Counter {\n  constructor() {\n    this.n = 0;\n  }\n  inc() {\n    this.n += 1;\n  }\n}\n`,
    ours: `export class Counter {\n  constructor() {\n    this.n = 0;\n  }\n  inc() {\n    this.n += 1;\n  }\n  reset() {\n    this.n = 0;\n  }\n}\n`,
    theirs: `export class Counter {\n  constructor(step = 1) {\n    this.n = 0;\n    this.step = step;\n  }\n  inc() {\n    this.n += this.step;\n  }\n}\n`,
    verify: (m) => {
      const c = new m.Counter(5);
      c.inc();
      eq(c.n, 5, 'pas de 5');
      c.reset();
      eq(c.n, 0, 'reset');
    },
  },
  {
    name: 'gros fichier (mode régions) : conflit au milieu',
    file: 'big.js',
    base: `${filler(0, 120)}\nexport function target(x) {\n  return x * 2;\n}\n${filler(120, 120)}`,
    ours: `${filler(0, 120)}\nexport function target(x) {\n  return x * 2 + 1;\n}\n${filler(120, 120)}`,
    theirs: `${filler(0, 120)}\nexport function target(x) {\n  if (x < 0) return 0;\n  return x * 2;\n}\n${filler(120, 120)}`,
    // Attendu : garde x<0 ET +1.
    verify: (m) => {
      eq(m.target(-3), 0, 'target(-3)');
      eq(m.target(4), 9, 'target(4)');
      eq(m.util7(1), 8, 'le reste du fichier est intact');
    },
  },
];

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

/** Résultat du merge textuel de git : conflit, ou fichier « propre » (qui peut être FAUX). */
function gitMerge(g: Golden): { conflict: boolean; clean: string | null } {
  const dir = mkdtempSync(path.join(tmpdir(), 'sbm-g-'));
  try {
    const opts = ['-c', 'user.name=b', '-c', 'user.email=b@b'];
    git(dir, 'init', '-q', '-b', 'main');
    const put = (text: string, msg: string) => {
      writeFileSync(path.join(dir, g.file), text);
      git(dir, 'add', '.');
      git(dir, ...opts, 'commit', '-q', '-m', msg);
    };
    put(g.base, 'base');
    git(dir, 'checkout', '-q', '-b', 'agent');
    put(g.theirs, 'theirs');
    git(dir, 'checkout', '-q', 'main');
    put(g.ours, 'ours');
    try {
      git(dir, ...opts, 'merge', '--no-edit', 'agent');
      return { conflict: false, clean: readFileSync(path.join(dir, g.file), 'utf8') };
    } catch {
      return { conflict: true, clean: null };
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function check(g: Golden, merged: string): Promise<string | null> {
  const dir = mkdtempSync(path.join(tmpdir(), 'sbm-v-'));
  try {
    const target = path.join(dir, g.file.replace(/\.js$/, '.mjs'));
    writeFileSync(target, merged);
    const mod = (await import(`${pathToFileURL(target).href}?${Date.now()}`)) as Mod;
    g.verify(mod);
    return null;
  } catch (error) {
    return (error as Error).message.slice(0, 160);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

interface Run {
  ok: boolean;
  reason: string | null;
  ms: number;
}

const cases = GOLDEN.filter((g) => !values.only || g.name.includes(values.only));
const repeat = Number(values.repeat);
const rows: {
  name: string;
  gitConflict: boolean;
  gitCleanButBroken: boolean | null;
  runs: Run[];
}[] = [];

for (const g of cases) {
  const gm = gitMerge(g);
  const row = {
    name: g.name,
    gitConflict: gm.conflict,
    // Merge « propre » de git : respecte-t-il le comportement attendu ? Sinon seul le Test Gate le rattrape.
    gitCleanButBroken: gm.clean === null ? null : (await check(g, gm.clean)) !== null,
    runs: [] as Run[],
  };
  for (let k = 0; k < repeat; k += 1) {
    const t0 = Date.now();
    try {
      const merged = await semanticMerge({
        filePath: g.file,
        base: g.base,
        ours: g.ours,
        theirs: g.theirs,
        config,
        timeoutMs: 180_000,
        retries: 1,
      });
      const reason = await check(g, merged);
      row.runs.push({ ok: reason === null, reason, ms: Date.now() - t0 });
    } catch (error) {
      const e = error as { code?: string; message?: string };
      row.runs.push({
        ok: false,
        reason: `${e.code ?? 'ERR'}: ${(e.message ?? '').slice(0, 120)}`,
        ms: Date.now() - t0,
      });
    }
  }
  rows.push(row);
}

console.log(`\nFusion sémantique — ${llm.provider}/${llm.model} (${repeat} essais par cas)`);
let ok = 0;
let total = 0;
for (const r of rows) {
  const passed = r.runs.filter((x) => x.ok).length;
  ok += passed;
  total += r.runs.length;
  const avg = Math.round(r.runs.reduce((s, x) => s + x.ms, 0) / r.runs.length);
  const mark = passed === r.runs.length ? '✓' : passed ? '~' : '✗';
  console.log(
    `${mark} ${r.name.padEnd(48)} ${passed}/${r.runs.length}` +
      `${r.gitConflict ? '' : r.gitCleanButBroken ? '  [git fusionne SANS conflit mais le résultat est FAUX : le Test Gate est le seul rempart]' : '  [git fusionne sans conflit, résultat correct]'}  ${avg} ms`,
  );
  for (const x of r.runs) if (!x.ok) console.log(`     ↳ ${x.reason}`);
}
console.log(
  `\nTotal : ${ok}/${total} fusions conformes au comportement attendu (${((ok / total) * 100).toFixed(0)} %)`,
);
if (values.out) {
  writeFileSync(values.out, JSON.stringify({ at: new Date().toISOString(), llm, rows }, null, 2));
}

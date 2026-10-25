#!/usr/bin/env node
/**
 * Mesure AVANT/APRÈS de l'économie de tokens — `npm run bench:tokens`.
 *
 * Hors ligne et déterministe : aucun appel réseau. Chaque cas reconstruit le
 * prompt tel qu'il partait AVANT le lot T (gabarits d'origine, recopiés
 * ci-dessous) et tel qu'il part APRÈS (les vrais constructeurs de src/), puis
 * compte les jetons avec l'estimateur local de Striart (conservateur : un
 * ordre de grandeur, pas la facture — l'usage réel est dans `striart usage`).
 *
 * Cas :
 *  1. Merger — un conflit à trois voies RÉEL fabriqué sur des fichiers du
 *     dépôt (tailles croissantes) ;
 *  2. Router — l'arbre `git ls-files` du dépôt (puis d'un monorepo synthétique
 *     de 10 000 fichiers) ;
 *  3. Consignes injectées à chaque session — gabarit complet / compact ;
 *  4. Memory Layer — le diff du dernier commit.
 *
 * Usage : node scripts/bench-tokens.ts [--json]
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { DEFAULT_CONFIG } from '../src/config.js';
import { buildAgentInstructions } from '../src/agents/instructions.ts';
import { compactMemoryDiff } from '../src/memory.js';
import { conflictRegions, diff3Merge, splitLines } from '../src/merge-hunks.ts';
import { buildRouterTree } from '../src/router-tree.ts';
import { estimateTokens } from '../src/tokens/estimate.ts';
import { resolveTokensSettings } from '../src/tokens/settings.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const { values } = parseArgs({ options: { json: { type: 'boolean', default: false } } });

const settings = resolveTokensSettings({});
const tokens = (text: string) => estimateTokens(text, settings.estimator);

interface Row {
  case: string;
  before: number;
  after: number;
  note?: string;
}
const rows: Row[] = [];
const add = (row: Row) => rows.push(row);

const git = (...args: string[]) =>
  execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

// ---------------------------------------------------------------- 1. Merger
const MERGER_BEFORE = (file: string, base: string, ours: string, theirs: string) =>
  `Tu es un expert en fusion de code JavaScript. Voici 3 versions d'un fichier.\nGénère le code fusionné qui préserve la logique des deux versions.\nLe résultat doit être du JavaScript syntaxiquement valide.\nNe rajoute aucune explication. Réponds uniquement avec le code.\n\nFichier : ${file}\n\nVersion BASE (commune) :\n${base}\n\nVersion A (branche principale) :\n${ours}\n\nVersion B (branche agent) :\n${theirs}`;

function mergerCase(file: string) {
  const base = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
  const lines = base.split('\n');
  const mid = Math.floor(lines.length / 2);
  const edit = (n: number, text: string) => lines.map((l, i) => (i === n ? text : l)).join('\n');
  // main et l'agent éditent la MÊME ligne du milieu ; chacun édite aussi une ligne à part.
  const ours = edit(mid, '// version main').split('\n');
  ours[3] = '// main seulement';
  const theirs = edit(mid, '// version agent').split('\n');
  theirs[lines.length - 3] = '// agent seulement';
  const oursText = ours.join('\n');
  const theirsText = theirs.join('\n');
  const before = tokens(MERGER_BEFORE(file, base, oursText, theirsText));
  const segments = diff3Merge(splitLines(base), splitLines(oursText), splitLines(theirsText));
  const regions = segments ? conflictRegions(segments, settings.merger.contextLines) : [];
  const afterText = regions
    .map((r) => [...r.before, ...r.base, ...r.ours, ...r.theirs, ...r.after].join('\n'))
    .join('\n\n');
  // + les consignes fixes du prompt par régions (~120 jetons).
  add({
    case: `Merger — ${file} (${lines.length} lignes)`,
    before,
    after: tokens(afterText) + 120,
    note: `${regions.length} région(s) en conflit sur le fichier`,
  });
}
for (const f of ['src/clone.js', 'src/orchestrator.js', 'src/dashboard.js']) {
  try {
    mergerCase(f);
  } catch {
    // fichier absent de ce dépôt : cas ignoré
  }
}

// ---------------------------------------------------------------- 2. Router
const ROUTER_INSTR = `Tu es un analyste de code. Voici une tâche de développement et la liste des fichiers d'un projet.\nListe UNIQUEMENT les fichiers que cette tâche va réellement modifier (1 à 5 maximum).\nN'inclus PAS les fichiers voisins ou improbables : chaque fichier listé bloque les autres agents qui le touchent.\nUn fichier de test n'est inclus que s'il teste directement le code modifié.\nRéponds UNIQUEMENT en JSON : {"files": ["src/..."]}`;
const TASK = 'corriger la gestion du verrou principal dans lock.js quand le détenteur est figé';

async function routerCase(
  name: string,
  files: string[],
  maxTreeTokens: number,
  mode: 'auto' | 'compact' = 'auto',
) {
  const before = tokens(
    `${ROUTER_INSTR}\n\nTâche : ${TASK}\n\nFichiers du projet :\n${files.join('\n')}`,
  );
  const tree = await buildRouterTree({
    files,
    task: TASK,
    settings: { ...settings.router.tree, maxTreeTokens, mode },
    estimator: settings.estimator,
    root: ROOT,
  });
  add({
    case: `Router — ${name} (${files.length} fichiers, ${mode}, max ${maxTreeTokens})`,
    before,
    after: tokens(`${ROUTER_INSTR}\n\nFichiers du projet :\n${tree.text}\n\nTâche : ${TASK}`),
    note: `arbre ${tree.mode}: ${tree.shown}/${tree.total} fichiers`,
  });
}
const repoFiles = git('ls-files').split('\n').filter(Boolean);
await routerCase('ce dépôt', repoFiles, settings.router.tree.maxTreeTokens);
await routerCase('ce dépôt, forcé compact', repoFiles, 6000, 'compact');
await routerCase('ce dépôt, budget serré', repoFiles, 800);
const mono = Array.from(
  { length: 10_000 },
  (_, i) => `packages/pkg-${i % 80}/src/module-${i}/index.ts`,
).concat(repoFiles);
await routerCase('monorepo synthétique', mono, settings.router.tree.maxTreeTokens);

// -------------------------------------------------------- 3. Consignes
const profile = { command: 'claude', args: ['{{prompt}}'] };
const instr = async (mode: 'full' | 'compact') =>
  (await buildAgentInstructions({
    root: ROOT,
    agent: 'agent-a',
    profileKey: 'claude',
    profile: profile as never,
    config: { ...DEFAULT_CONFIG, tokens: { instructions: { mode } } } as never,
    mode: 'autonomous',
  })) ?? '';
add({
  case: 'Consignes injectées par session (gabarit complet → compact)',
  before: tokens(await instr('full')),
  after: tokens(await instr('compact')),
  note: 'tokens.instructions.mode = compact',
});

// -------------------------------------------------------- 4. Memory
try {
  const diff = git('diff', 'HEAD~1', 'HEAD');
  const legacy = diff.slice(0, 8000);
  const compact = compactMemoryDiff(diff, settings.memory.diffMaxChars);
  add({
    case: `Memory Layer — diff du dernier commit (${diff.length} caractères)`,
    before: tokens(legacy),
    after: tokens(compact.text),
    note: compact.truncated
      ? `réduit, ${compact.omittedLines} lignes omises (déclarées)`
      : 'diff réduit aux lignes +/-',
  });
} catch {
  // pas d'historique suffisant : cas ignoré
}

// ------------------------------------------------------------ sortie
const saved = (r: Row) => (r.before === 0 ? 0 : Math.round((1 - r.after / r.before) * 100));
if (values.json) {
  process.stdout.write(
    `${JSON.stringify({ schemaVersion: 1, unit: 'estimated tokens', rows: rows.map((r) => ({ ...r, savedPercent: saved(r) })) }, null, 2)}\n`,
  );
} else {
  const width = Math.max(...rows.map((r) => r.case.length));
  process.stdout.write(
    `${'cas'.padEnd(width)}  ${'avant'.padStart(8)}  ${'après'.padStart(8)}  ${'gain'.padStart(5)}  note\n`,
  );
  for (const r of rows) {
    process.stdout.write(
      `${r.case.padEnd(width)}  ${String(r.before).padStart(8)}  ${String(r.after).padStart(8)}  ${`${saved(r)}%`.padStart(5)}  ${r.note ?? ''}\n`,
    );
  }
  process.stdout.write(
    '\nJetons estimés localement (conservateur) ; l’usage réel se lit avec `striart usage`.\n',
  );
}

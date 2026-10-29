/**
 * Carte du dépôt pour le Router : pour chaque fichier, ses symboles (fonctions,
 * classes, types exportés…) et la première ligne de sa documentation.
 *
 * Extraction LÉGÈRE par expressions régulières, multi-langages, sans compilateur
 * ni dépendance : c'est un signal de récupération et de contexte, pas une
 * analyse — un symbole manqué coûte un indice, jamais une erreur. Les résultats
 * sont mémorisés par (chemin, version) : un long processus (`striart watch`) ne
 * réanalyse que les fichiers modifiés.
 */
import { mapLimit } from './router-sources.ts';
import type { ProjectSources } from './router-sources.ts';

export interface FileSummary {
  /** Symboles affichables, exportés d'abord, dédoublonnés, plafonnés. */
  symbols: string[];
  /** Première ligne utile de la documentation du fichier (commentaire d'en-tête, titre markdown). */
  doc: string | null;
  /** Texte d'indexation additionnel (début de la doc, codes d'erreur littéraux) — non affiché. */
  index: string;
}

const MAX_SYMBOLS = 40;
const MAX_DOC_CHARS = 160;

const CODE_EXT =
  /\.(?:[cm]?[jt]sx?|py|rb|php|rs|go|java|kt|cs|c|h|cc|cpp|hpp|swift|scala|sh|ps1|sql|ya?ml|toml|md|mdx)$/i;
const SKIP_NAME =
  /(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|Cargo\.lock|[^/]*\.min\.js)$/;

/** Le fichier mérite-t-il une analyse (texte de code ou de doc connu, pas un artefact) ? */
export function isMappable(file: string): boolean {
  return CODE_EXT.test(file) && !SKIP_NAME.test(file);
}

const JS_KEYWORDS = new Set([
  'if',
  'for',
  'while',
  'switch',
  'catch',
  'function',
  'return',
  'constructor',
  'super',
  'await',
  'import',
  'with',
  'else',
  'do',
]);

interface Found {
  name: string;
  exported: boolean;
}

function add(out: Found[], name: string | undefined, exported: boolean): void {
  if (name && name.length >= 2) out.push({ name, exported });
}

function jsSymbols(src: string): Found[] {
  const out: Found[] = [];
  for (const m of src.matchAll(
    /^export\s+(?:default\s+)?(?:declare\s+)?(?:abstract\s+)?(?:async\s+)?(?:function\*?|class|const|let|var|interface|type|enum)\s+([A-Za-z_$][\w$]*)/gm,
  ))
    add(out, m[1], true);
  for (const m of src.matchAll(/^export\s*\{([^}]+)\}/gm))
    for (const part of m[1]!.split(','))
      add(
        out,
        part
          .split(/\s+as\s+/)
          .pop()
          ?.trim(),
        true,
      );
  for (const m of src.matchAll(/^(?:async\s+)?function\*?\s+([A-Za-z_$][\w$]*)/gm))
    add(out, m[1], false);
  for (const m of src.matchAll(/^(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/gm))
    add(out, m[1], false);
  for (const m of src.matchAll(
    /^(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/gm,
  ))
    add(out, m[1], false);
  // Méthodes de classe / d'objet (indentation de 2 espaces ou 1 tabulation).
  for (const m of src.matchAll(
    /^(?: {2}|\t)(?:public\s+|private\s+|protected\s+|static\s+|async\s+|get\s+|set\s+)*([A-Za-z_$][\w$]*)\s*\([^)\n]*\)\s*(?::\s*[^{=\n]+)?\{/gm,
  )) {
    if (!JS_KEYWORDS.has(m[1]!)) add(out, m[1], false);
  }
  return out;
}

function pySymbols(src: string): Found[] {
  const out: Found[] = [];
  for (const m of src.matchAll(/^(?:async\s+)?def\s+(\w+)/gm))
    add(out, m[1], !m[1]!.startsWith('_'));
  for (const m of src.matchAll(/^class\s+(\w+)/gm)) add(out, m[1], true);
  return out;
}

function rustSymbols(src: string): Found[] {
  const out: Found[] = [];
  for (const m of src.matchAll(
    /^\s*(pub(?:\([^)]*\))?\s+)?(?:async\s+|const\s+|unsafe\s+)*(?:fn|struct|enum|trait|mod|type|static)\s+(\w+)/gm,
  ))
    add(out, m[2], Boolean(m[1]));
  for (const m of src.matchAll(/^\s*impl(?:<[^>]*>)?\s+(?:[\w:<>]+\s+for\s+)?(\w+)/gm))
    add(out, m[1], false);
  return out;
}

function goSymbols(src: string): Found[] {
  const out: Found[] = [];
  for (const m of src.matchAll(/^func\s+(?:\([^)]*\)\s*)?(\w+)/gm))
    add(out, m[1], /^[A-Z]/.test(m[1]!));
  for (const m of src.matchAll(/^type\s+(\w+)/gm)) add(out, m[1], /^[A-Z]/.test(m[1]!));
  return out;
}

function rubySymbols(src: string): Found[] {
  const out: Found[] = [];
  for (const m of src.matchAll(/^\s*(?:def|class|module)\s+(?:self\.)?(\w+)/gm))
    add(out, m[1], true);
  return out;
}

function genericSymbols(src: string): Found[] {
  const out: Found[] = [];
  for (const m of src.matchAll(
    /^\s*(?:public\s+|private\s+|protected\s+|static\s+|final\s+|abstract\s+|sealed\s+)*(?:class|interface|enum|record|struct|function)\s+(\w+)/gm,
  ))
    add(out, m[1], true);
  return out;
}

function mdSymbols(src: string): { symbols: Found[]; title: string | null } {
  const out: Found[] = [];
  let title: string | null = null;
  for (const m of src.matchAll(/^(#{1,3})\s+(.+?)\s*#*\s*$/gm)) {
    const text = m[2]!.replace(/[`*_]/g, '').slice(0, 60);
    if (!title) title = text;
    else add(out, text, true);
  }
  return { symbols: out, title };
}

/** Texte de l'en-tête documentaire d'un fichier de code (premier bloc de commentaires). */
function headerComment(src: string, ext: string): string {
  const body = src.replace(/^#!.*\n/, '').replace(/^﻿/, '');
  if (['.py'].includes(ext)) {
    const doc = /^\s*(?:"""|''')([\s\S]*?)(?:"""|''')/.exec(body);
    if (doc) return doc[1]!;
  }
  const block = /^\s*\/\*+!?([\s\S]*?)\*\//.exec(body);
  if (block) return block[1]!.replace(/^\s*\*+ ?/gm, '');
  const lines: string[] = [];
  for (const line of body.split('\n')) {
    const m = /^\s*(?:\/\/[/!]?|#(?!!)|--)\s?(.*)$/.exec(line);
    if (!m) {
      if (line.trim() === '' && lines.length === 0) continue;
      break;
    }
    lines.push(m[1]!);
  }
  return lines.join('\n');
}

/** Première phrase/ligne utile d'un texte de commentaire. */
function firstLine(text: string): string | null {
  for (const raw of text.split('\n')) {
    const line = raw.replace(/^[\s*>#-]+/, '').trim();
    if (line.length < 8 || /^(@|eslint|prettier|ts-|istanbul|copyright|license)/i.test(line))
      continue;
    return line.length > MAX_DOC_CHARS ? `${line.slice(0, MAX_DOC_CHARS - 1)}…` : line;
  }
  return null;
}

/** Codes littéraux MAJUSCULES_AVEC_TIRET_BAS (codes d'erreur, constantes) : indices d'indexation. */
function literalCodes(src: string): string[] {
  const seen = new Set<string>();
  for (const m of src.matchAll(/['"`]([A-Z][A-Z0-9]+(?:_[A-Z0-9]+)+)['"`]/g)) {
    seen.add(m[1]!);
    if (seen.size >= 24) break;
  }
  return [...seen];
}

export function summarizeSource(file: string, source: string): FileSummary {
  const ext = file.slice(file.lastIndexOf('.')).toLowerCase();
  let found: Found[];
  let doc: string | null = null;
  let headerText = '';
  if (ext === '.md' || ext === '.mdx') {
    const md = mdSymbols(source);
    found = md.symbols;
    doc = md.title;
    headerText = md.title ?? '';
  } else {
    if (['.py'].includes(ext)) found = pySymbols(source);
    else if (ext === '.rs') found = rustSymbols(source);
    else if (ext === '.go') found = goSymbols(source);
    else if (ext === '.rb') found = rubySymbols(source);
    else if (/^\.(?:[cm]?[jt]sx?)$/.test(ext)) found = jsSymbols(source);
    else if (['.yml', '.yaml', '.toml', '.sql', '.sh', '.ps1'].includes(ext)) found = [];
    else found = genericSymbols(source);
    headerText = headerComment(source, ext).slice(0, 700);
    doc = firstLine(headerText);
  }
  // Exportés d'abord, ordre d'apparition conservé, dédoublonnés.
  const unique = new Map<string, boolean>();
  for (const f of found) unique.set(f.name, (unique.get(f.name) ?? false) || f.exported);
  const ordered = [...unique.entries()].sort((a, b) => Number(b[1]) - Number(a[1]));
  const symbols = ordered.slice(0, MAX_SYMBOLS).map(([name]) => name);
  const codes = ext === '.md' ? [] : literalCodes(source);
  return { symbols, doc, index: [headerText, ...codes].join(' ') };
}

const parseCache = new Map<string, FileSummary>();
const PARSE_CACHE_MAX = 30_000;

/** Pour les tests. */
export function resetRepoMapCache(): void {
  parseCache.clear();
}

/**
 * Carte du dépôt : résumé de chaque fichier analysable. Les fichiers non
 * analysables (binaires, verrous, gros) reçoivent un résumé vide : leur chemin
 * reste exploitable par la récupération.
 */
export async function buildRepoMap(
  files: readonly string[],
  sources: ProjectSources,
): Promise<Map<string, FileSummary>> {
  const empty: FileSummary = { symbols: [], doc: null, index: '' };
  const entries = await mapLimit(files, 32, async (file): Promise<[string, FileSummary]> => {
    if (!isMappable(file)) return [file, empty];
    const version = await sources.version(file);
    if (version === null) return [file, empty];
    const key = `${file}\0${version}`;
    const hit = parseCache.get(key);
    if (hit) return [file, hit];
    const source = await sources.read(file);
    if (source === null) return [file, empty];
    const summary = summarizeSource(file, source);
    if (parseCache.size >= PARSE_CACHE_MAX) parseCache.clear();
    parseCache.set(key, summary);
    return [file, summary];
  });
  return new Map(entries);
}

/** Une ligne de carte : `chemin — doc [sym1, sym2…]`. */
export function renderMapLine(file: string, s: FileSummary, maxSymbols = 8): string {
  const syms = s.symbols.slice(0, maxSymbols).join(', ');
  const parts = [file];
  if (s.doc) parts.push(`— ${s.doc}`);
  if (syms) parts.push(`[${syms}${s.symbols.length > maxSymbols ? ', …' : ''}]`);
  return parts.join(' ');
}

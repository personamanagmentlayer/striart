/**
 * Graphe d'imports statiques du projet — multi-langages.
 *
 * Sert au Router comme signal *advisory* : quand la tâche d'un agent touche
 * un fichier importé par les fichiers d'un autre agent (ou l'inverse), les
 * deux peuvent se casser mutuellement SANS conflit Git. On avertit — on ne
 * bloque jamais sur une dépendance sémantique (décision archi n°4 : le
 * Router reste un filtre grossier, bloquer les importeurs tuerait le
 * parallélisme ; le Test Gate reste le juge).
 *
 * Langages couverts : JS/TS (imports relatifs), Python (imports RELATIFS
 * `from .x import y`), Ruby (`require_relative`), PHP (`require`/`include`
 * de chemins relatifs). Uniquement les références RELATIVES, résolubles sans
 * connaître la config du build : les résolutions par package/namespace
 * (PYTHONPATH, autoload composer, $LOAD_PATH) exigeraient la config de
 * l'outillage — un faux négatif ne coûte qu'un avertissement manqué, un faux
 * positif coûterait la confiance dans le signal. Les langages compilés
 * restent couverts par le Test Gate.
 */
import { createHash } from 'node:crypto';
import path from 'node:path';
import { normalizeFilePath } from './project-path.ts';
import { fsSources, mapLimit } from './router-sources.ts';

const JS_EXTENSIONS = ['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs'];
/** Au-delà : fichier généré/bundle, sans valeur pour le graphe. */
const MAX_SOURCE_BYTES = 200_000;

const JS_IMPORT_RE =
  /(?:import|export)\s+[^'"]*?from\s+['"]([^'"\n]+)['"]|import\s*\(\s*['"]([^'"\n]+)['"]\s*\)|require\s*\(\s*['"]([^'"\n]+)['"]\s*\)|import\s+['"]([^'"\n]+)['"]/g;

/**
 * Résout un spécificateur RELATIF JS/TS vers un fichier du projet
 * (essais : tel quel, + extensions, /index + extensions). Les imports de
 * modules (bare specifiers) et les alias sont ignorés : le graphe est
 * volontairement conservateur, un faux négatif ne coûte qu'un avertissement
 * manqué.
 */
function resolveJsSpecifier(fromFile, spec, projectFiles) {
  if (!spec.startsWith('./') && !spec.startsWith('../')) return null;
  const base = path.posix.normalize(path.posix.join(path.posix.dirname(fromFile), spec));
  const candidates = [
    base,
    ...JS_EXTENSIONS.map((ext) => base + ext),
    // Import TS d'un chemin .js compilé : `./x.js` → source `./x.ts`.
    ...(base.endsWith('.js') ? [base.replace(/\.js$/, '.ts'), base.replace(/\.js$/, '.tsx')] : []),
    ...JS_EXTENSIONS.map((ext) => `${base}/index${ext}`),
  ];
  return candidates.find((c) => projectFiles.has(c)) ?? null;
}

function extractJsImports(file, source, projectFiles) {
  const imports = new Set();
  for (const match of source.matchAll(JS_IMPORT_RE)) {
    const spec = match[1] ?? match[2] ?? match[3] ?? match[4];
    const resolved = resolveJsSpecifier(file, spec, projectFiles);
    if (resolved) imports.add(resolved);
  }
  return imports;
}

/** `from .mod import x` / `from ..pkg import y` / `from . import a, b`. */
const PY_IMPORT_RE =
  /^[ \t]*from[ \t]+(\.+)([\w.]*)[ \t]+import[ \t]+([\w*]+(?:[ \t]*,[ \t]*[\w*]+)*)/gm;

function extractPythonImports(file, source, projectFiles) {
  const imports = new Set();
  const pick = (base) =>
    [`${base}.py`, `${base}/__init__.py`].find((c) => projectFiles.has(c)) ?? null;
  for (const match of source.matchAll(PY_IMPORT_RE)) {
    const [, dots, modulePath, names] = match;
    // 1 point = le package courant, chaque point de plus remonte d'un cran.
    let dir = path.posix.dirname(file);
    for (let i = 1; i < dots.length; i += 1) dir = path.posix.dirname(dir);
    if (dir === '.') dir = '';
    const moduleBase = modulePath
      ? path.posix.join(dir, ...modulePath.split('.').filter(Boolean))
      : null;
    if (moduleBase) {
      const resolved = pick(moduleBase);
      if (resolved) imports.add(resolved);
    }
    // `from . import x` (et `from .pkg import mod`) : chaque nom importé
    // peut être un module frère — on tente sa résolution aussi.
    for (const name of names.split(',')) {
      const trimmed = name.trim();
      if (!trimmed || trimmed === '*') continue;
      const resolved = pick(path.posix.join(moduleBase ?? dir, trimmed));
      if (resolved) imports.add(resolved);
    }
  }
  return imports;
}

/** `require_relative 'foo/bar'` — LA forme relative de Ruby. */
const RB_IMPORT_RE = /require_relative[ \t(]+['"]([^'"\n]+)['"]/g;

function extractRubyImports(file, source, projectFiles) {
  const imports = new Set();
  for (const match of source.matchAll(RB_IMPORT_RE)) {
    const base = path.posix.normalize(path.posix.join(path.posix.dirname(file), match[1]));
    const resolved = [base, `${base}.rb`].find((c) => projectFiles.has(c));
    if (resolved) imports.add(resolved);
  }
  return imports;
}

/**
 * `require`/`include`(`_once`) d'un littéral relatif, avec ou sans
 * `__DIR__ . '/...'`. Les `use` (namespaces) passent par l'autoload composer :
 * hors de portée sans sa config, donc ignorés (conservateur).
 */
const PHP_IMPORT_RE =
  /(?:require|include)(?:_once)?[ \t(]+(?:__DIR__[ \t]*\.[ \t]*)?['"]([^'"\n]+\.php)['"]/g;

function extractPhpImports(file, source, projectFiles) {
  const imports = new Set();
  for (const match of source.matchAll(PHP_IMPORT_RE)) {
    const spec = match[1].startsWith('/') ? `.${match[1]}` : match[1];
    const base = path.posix.normalize(path.posix.join(path.posix.dirname(file), spec));
    if (projectFiles.has(base)) imports.add(base);
  }
  return imports;
}

/** Table des langages : extension → extracteur. Ajout = une entrée. */
const LANGUAGES = [
  { extensions: JS_EXTENSIONS, extract: extractJsImports },
  { extensions: ['.py'], extract: extractPythonImports },
  { extensions: ['.rb'], extract: extractRubyImports },
  { extensions: ['.php'], extract: extractPhpImports },
];

function languageFor(file) {
  const ext = path.posix.extname(file);
  return LANGUAGES.find((lang) => lang.extensions.includes(ext)) ?? null;
}

/**
 * Construit le graphe d'imports : fichier → fichiers du projet qu'il importe.
 * Lecture best effort (fichier illisible ou trop gros : ignoré).
 * `sources` (facultatif) remplace la lecture du disque : le Router le fournit
 * pour analyser un arbre qui n'est pas celui du disque (banc sur historique).
 * @param {string} root
 * @param {string[]} files fichiers du projet (chemins relatifs)
 * @param {import('./router-sources.ts').ProjectSources | null} [sources]
 * @returns {Promise<Map<string, Set<string>>>}
 */
export async function buildImportGraph(root, files, sources = null) {
  const normalized = files.map(normalizeFilePath);
  const projectFiles = new Set(normalized);
  const reader = sources ?? fsSources(root);
  const graph = new Map();

  // Avec des sources explicites (le Router), l'analyse de chaque fichier est
  // mémorisée par (ensemble de fichiers, chemin, version) : un long processus ne
  // relit que ce qui a changé. Sans sources (appel historique), aucune mémoire.
  const fingerprint = sources
    ? createHash('sha256')
        .update(normalized.join(String.fromCharCode(10)))
        .digest('hex')
        .slice(0, 16)
    : null;
  const candidates = normalized.filter((file) => languageFor(file) !== null);
  const extracted = await mapLimit(candidates, 32, async (file) => {
    let key = null;
    if (fingerprint) {
      const version = await reader.version(file);
      if (version !== null) {
        key = `${fingerprint}|${file}|${version}`;
        const hit = GRAPH_CACHE.get(key);
        if (hit !== undefined) return hit;
      }
    }
    const source = await reader.read(file);
    let result = null;
    if (source !== null && source.length <= MAX_SOURCE_BYTES) {
      const imports = languageFor(file).extract(file, source, projectFiles);
      imports.delete(file);
      if (imports.size > 0) result = [file, imports];
    }
    if (key) {
      if (GRAPH_CACHE.size >= GRAPH_CACHE_MAX) GRAPH_CACHE.clear();
      GRAPH_CACHE.set(key, result);
    }
    return result;
  });
  for (const entry of extracted) if (entry) graph.set(entry[0], entry[1]);
  return graph;
}

const GRAPH_CACHE = new Map();
const GRAPH_CACHE_MAX = 30_000;

/** Pour les tests. */
export function resetImportGraphCache() {
  GRAPH_CACHE.clear();
}

/**
 * Graphe inversé : fichier → fichiers du projet qui l'importent.
 * @param {Map<string, Set<string>>} graph
 * @returns {Map<string, Set<string>>}
 */
export function invertImportGraph(graph) {
  const inverse = new Map();
  for (const [importer, deps] of graph) {
    for (const dep of deps) {
      let set = inverse.get(dep);
      if (!set) inverse.set(dep, (set = new Set()));
      set.add(importer);
    }
  }
  return inverse;
}

/**
 * Voisinage sémantique entre la tâche entrante et chaque agent actif :
 * fichiers de l'un directement importés par les fichiers de l'autre.
 * @param {{graph: Map<string, Set<string>>, predictedFiles: string[], agents: Array<{name: string, predictedFiles?: string[]}>}} params
 * @returns {import('./types.js').SemanticWarning[]}
 */
export function detectSemanticNeighbors({ graph, predictedFiles, agents }) {
  const mine = new Set(predictedFiles.map(normalizeFilePath));
  const importsOf = (file) => graph.get(file) ?? new Set();

  const warnings = [];
  for (const agent of agents) {
    const theirs = (agent.predictedFiles ?? []).map(normalizeFilePath);
    const links = [];
    for (const theirFile of theirs) {
      for (const myFile of mine) {
        if (importsOf(theirFile).has(myFile)) {
          links.push({ file: myFile, importedBy: theirFile });
        }
        if (importsOf(myFile).has(theirFile)) {
          links.push({ file: theirFile, importedBy: myFile });
        }
      }
    }
    if (links.length > 0) warnings.push({ agent: agent.name, links });
  }
  return warnings;
}

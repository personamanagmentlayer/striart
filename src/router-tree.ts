/**
 * Arbre de fichiers soumis au Router : filtré, compacté, classé (lot T).
 *
 * Le Router envoie TOUS les fichiers suivis par git au LLM ; sur un dépôt de
 * milliers de fichiers c'est l'essentiel de son coût. Trois niveaux, choisis
 * par `tokens.router.tree.mode` :
 *  - 'full'    : liste brute, comportement historique (aucun filtre) ;
 *  - 'compact' : fichiers de ressources retirés (motifs `exclude`) et chemins
 *    regroupés par dossier (`dir/: a.ts, b.ts`) — le préfixe commun n'est plus
 *    répété ;
 *  - 'auto' (défaut) : liste brute tant qu'elle tient dans `maxTreeTokens`,
 *    sinon compact, sinon CLASSÉ par pertinence pour la tâche (mots de la
 *    tâche × segments de chemin, étendu d'un saut par le graphe d'imports) et
 *    les dossiers non montrés résumés (`dir/ (+N files)`).
 *
 * Rien n'est tronqué en silence : l'arbre déclare lui-même qu'il est classé
 * (ligne `NOTE`), le nombre de fichiers montrés/omis est rendu à l'appelant
 * (journal, `striart usage`), et un fichier NOMMÉ dans la tâche n'est jamais
 * filtré. Un faux négatif du Router reste rattrapé par le Merger et le Test
 * Gate (décision archi n°4).
 */
import { compileGlob } from './glob-lite.ts';
import type { ProjectSources } from './router-sources.ts';
import { estimateTokens } from './tokens/estimate.ts';
import type { EstimatorOptions } from './tokens/estimate.ts';

export interface TreeSettings {
  mode: 'auto' | 'full' | 'compact';
  maxTreeTokens: number;
  exclude: readonly string[];
  importExpansion: boolean;
}

export interface TreeResult {
  /** Texte à placer dans le prompt. */
  text: string;
  mode: 'full' | 'compact' | 'ranked';
  total: number;
  shown: number;
  omitted: number;
  estimatedTokens: number;
}

const STOPWORDS = new Set([
  'the',
  'and',
  'for',
  'with',
  'that',
  'this',
  'from',
  'into',
  'les',
  'des',
  'une',
  'pour',
  'dans',
  'avec',
  'sur',
  'par',
  'est',
  'add',
  'fix',
  'update',
  'make',
  'file',
  'files',
  'code',
  'ajoute',
  'ajouter',
  'corrige',
  'corriger',
  'modifier',
  'faire',
  'nouvelle',
  'nouveau',
]);

/** Mots significatifs d'un texte (minuscules, >= 3 caractères, sans mots vides, camelCase éclaté). */
export function keywords(text: string): string[] {
  const split = text
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .split(/[^a-z0-9]+/);
  return [...new Set(split.filter((w) => w.length >= 3 && !STOPWORDS.has(w)))];
}

function pathScore(file: string, words: readonly string[]): number {
  if (words.length === 0) return 0;
  const lower = file.toLowerCase();
  const base = lower.slice(lower.lastIndexOf('/') + 1);
  const segments = new Set(keywords(file));
  let score = 0;
  for (const w of words) {
    if (base.includes(w)) score += 3;
    else if (segments.has(w) || lower.includes(w)) score += 1;
  }
  return score;
}

function compactLines(files: readonly string[]): string[] {
  const byDir = new Map<string, string[]>();
  for (const f of files) {
    const i = f.lastIndexOf('/');
    const dir = i < 0 ? './' : `${f.slice(0, i)}/`;
    const name = i < 0 ? f : f.slice(i + 1);
    const list = byDir.get(dir);
    if (list) list.push(name);
    else byDir.set(dir, [name]);
  }
  return [...byDir.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([dir, names]) => `${dir}: ${names.sort().join(', ')}`);
}

export const COMPACT_TREE_LEGEND =
  'The file list is grouped by directory ("dir/: a.ts, b.ts"); always answer with FULL paths (directory + file name).';

export interface BuildTreeParams {
  files: readonly string[];
  task: string;
  settings: TreeSettings;
  estimator: EstimatorOptions;
  /** Racine du dépôt : requise pour l'extension par le graphe d'imports. */
  root?: string | null;
  /** Sources du projet (remplace la lecture du disque sous `root`) pour le graphe d'imports. */
  sources?: ProjectSources | null;
  /**
   * Scores de pertinence DÉTERMINISTES fournis par l'appelant (BM25 de
   * router-retrieval.ts) : remplacent le score de chemin quand l'arbre doit être classé.
   */
  scores?: ReadonlyMap<string, number> | null;
}

export async function buildRouterTree(p: BuildTreeParams): Promise<TreeResult> {
  const { files, task, settings, estimator } = p;
  const sorted = [...files].sort();
  const full = sorted.join('\n');
  const fullTokens = estimateTokens(full, estimator);
  const asFull = (): TreeResult => ({
    text: full,
    mode: 'full',
    total: files.length,
    shown: files.length,
    omitted: 0,
    estimatedTokens: fullTokens,
  });
  if (settings.mode === 'full') return asFull();
  if (settings.mode === 'auto' && fullTokens <= settings.maxTreeTokens) return asFull();

  // Filtre des ressources — sauf fichier nommé explicitement par la tâche.
  const excluders = settings.exclude.map((g) => compileGlob(g, false));
  const named = (f: string) => task.includes(f) || task.includes(f.slice(f.lastIndexOf('/') + 1));
  const kept = sorted.filter((f) => named(f) || !excluders.some((re) => re.test(f)));

  const compactText = `${COMPACT_TREE_LEGEND}\n${compactLines(kept).join('\n')}`;
  const compactTokens = estimateTokens(compactText, estimator);
  if (settings.mode === 'compact' || compactTokens <= settings.maxTreeTokens) {
    return {
      text: compactText,
      mode: 'compact',
      total: files.length,
      shown: kept.length,
      omitted: files.length - kept.length,
      estimatedTokens: compactTokens,
    };
  }

  return rank({ ...p, files: kept }, files.length);
}

async function rank(p: BuildTreeParams, grandTotal: number): Promise<TreeResult> {
  const { files, task, settings, estimator } = p;
  const words = keywords(task);
  const scores = new Map<string, number>();
  for (const f of files) scores.set(f, p.scores ? (p.scores.get(f) ?? 0) : pathScore(f, words));

  // Un saut dans le graphe d'imports autour des meilleurs candidats : le
  // fichier qu'une tâche touche est souvent un voisin (importeur/importé) de
  // celui dont le nom la décrit.
  if (settings.importExpansion && (p.root || p.sources) && words.length > 0) {
    try {
      const seeds = [...scores.entries()]
        .filter(([, s]) => s > 0)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 8)
        .map(([f]) => f);
      if (seeds.length > 0) {
        const { buildImportGraph } = await import('./imports.ts');
        const codeFiles = files.slice(0, 4000);
        const graph = (await buildImportGraph(p.root ?? '', codeFiles, p.sources ?? null)) as Map<
          string,
          Set<string>
        >;
        for (const seed of seeds) {
          for (const dep of graph.get(seed) ?? []) scores.set(dep, (scores.get(dep) ?? 0) + 1);
        }
        for (const [importer, deps] of graph) {
          if (seeds.some((s) => deps.has(s))) scores.set(importer, (scores.get(importer) ?? 0) + 1);
        }
      }
    } catch {
      // Graphe indisponible : le classement par chemin suffit (signal advisory).
    }
  }

  const order = [...files].sort(
    (a, b) => (scores.get(b) ?? 0) - (scores.get(a) ?? 0) || (a < b ? -1 : a > b ? 1 : 0),
  );
  // Budget : on remplit par pertinence décroissante en réservant la place du résumé.
  const budget = Math.floor(settings.maxTreeTokens * 0.85);
  const shown: string[] = [];
  let used = estimateTokens(COMPACT_TREE_LEGEND, estimator) + 100;
  for (const f of order) {
    const cost = estimateTokens(f, estimator) + 1;
    if (used + cost > budget) break;
    shown.push(f);
    used += cost;
  }
  const shownSet = new Set(shown);
  const hiddenByDir = new Map<string, number>();
  for (const f of files) {
    if (shownSet.has(f)) continue;
    const i = f.lastIndexOf('/');
    const dir = i < 0 ? './' : `${f.slice(0, i)}/`;
    hiddenByDir.set(dir, (hiddenByDir.get(dir) ?? 0) + 1);
  }
  // Résumé des dossiers non montrés : les plus fournis d'abord, tant que la
  // place restante (jusqu'à maxTreeTokens) le permet.
  const omittedLines = [];
  let room = settings.maxTreeTokens - used - 20;
  for (const [dir, n] of [...hiddenByDir.entries()].sort(
    (a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1),
  )) {
    const line = `${dir} (+${n} file${n > 1 ? 's' : ''} not shown)`;
    const cost = estimateTokens(line, estimator) + 1;
    if (cost > room) break;
    omittedLines.push(line);
    room -= cost;
  }
  const text = [
    COMPACT_TREE_LEGEND,
    `NOTE: ${shown.length} of ${grandTotal} project files are listed, ranked by relevance to the task; directories below hold the other files. If the task needs a file that is not listed, answer with its most plausible FULL path.`,
    ...compactLines(shown),
    ...(omittedLines.length > 0 ? ['Not shown:', ...omittedLines] : []),
  ].join('\n');
  return {
    text,
    mode: 'ranked',
    total: grandTotal,
    shown: shown.length,
    omitted: grandTotal - shown.length,
    estimatedTokens: estimateTokens(text, estimator),
  };
}

/**
 * Récupération déterministe de candidats pour le Router : BM25 sur les chemins,
 * les symboles et la documentation de chaque fichier (carte du dépôt), sans
 * dépendance ni appel réseau.
 *
 * Rôle : un signal LEXICAL pour (1) présenter au LLM les fichiers les plus
 * proches de la tâche avec leurs symboles, (2) classer l'arbre quand il déborde
 * du budget, (3) détecter une tâche trop vague pour être prédite (aucun
 * candidat ne ressort). Ce n'est pas un oracle : le LLM départage, et un
 * couplage sans recouvrement de mots reste invisible.
 */
import type { FileSummary } from './router-map.ts';

const STOP = new Set(
  (
    'the and for with that this from into are was were have has not but all any can will ' +
    'les des une pour dans avec sur par est sont qui que quoi dont plus moins aussi cette ces ' +
    'son ses leur leurs aux elle ils nous vous mais donc car comme tout tous toute toutes ' +
    'etre avoir fait faire faut doit doivent peut peuvent sans sous entre vers chez ' +
    'ajouter ajoute ajout permettre permet pouvoir rendre rend assurer faire corriger corrige ' +
    'add fix update make allow let ensure should need needs when where which also not'
  ).split(' '),
);

/** Suffixes retirés (le plus long d'abord) — symétrique entre documents et requête. */
const SUFFIXES = [
  'ements',
  'ement',
  'ations',
  'ation',
  'ateurs',
  'ateur',
  'trices',
  'trice',
  'ences',
  'ence',
  'ances',
  'ance',
  'ments',
  'ment',
  'ities',
  'ity',
  'ings',
  'ing',
  'tions',
  'tion',
  'ables',
  'able',
  'ibles',
  'ible',
  'eurs',
  'euse',
  'eux',
  'ives',
  'ive',
  'iques',
  'ique',
  'ees',
  'ee',
  'ers',
  'er',
  'es',
  'ed',
  's',
  'x',
];

function stem(word: string): string {
  for (const suffix of SUFFIXES) {
    if (word.length - suffix.length >= 4 && word.endsWith(suffix)) {
      return word.slice(0, -suffix.length);
    }
  }
  return word;
}

/**
 * Mots d'un texte : camelCase/snake/kebab éclatés, accents repliés, minuscules,
 * mots vides retirés, radical léger. Les répétitions sont conservées (fréquences).
 */
export function terms(text: string): string[] {
  const out: string[] = [];
  const parts = text
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .split(/[^a-z0-9]+/);
  for (const w of parts) {
    if (w.length < 3 || STOP.has(w) || /^\d+$/.test(w)) continue;
    out.push(stem(w));
  }
  return out;
}

/**
 * Correspondances français → anglais du vocabulaire de développement courant.
 * Les tâches sont souvent écrites en français et le code en anglais : sans
 * pont, « verrou » ne retrouve pas `lock`. Appliqué à la REQUÊTE seulement,
 * à poids réduit. Liste générique (aucun nom propre au dépôt).
 */
const BRIDGE: Record<string, string[]> = {
  verrou: ['lock', 'mutex'],
  fichier: ['file'],
  depot: ['repo', 'repository'],
  jeton: ['token'],
  fusion: ['merge'],
  conflit: ['conflict'],
  journal: ['log', 'logger'],
  erreur: ['error'],
  tache: ['task', 'job'],
  file: ['queue'],
  attente: ['queue', 'wait'],
  supprim: ['delete', 'remove', 'clean'],
  nettoy: ['clean', 'prune'],
  suppression: ['delete', 'remove'],
  securit: ['security', 'safe'],
  authentif: ['auth', 'login'],
  utilisateur: ['user'],
  mot: ['word'],
  passe: ['password'],
  session: ['session'],
  commande: ['command', 'cli'],
  configuration: ['config', 'settings'],
  config: ['config'],
  reglage: ['settings', 'config'],
  option: ['option', 'flag'],
  tableau: ['table', 'array'],
  affich: ['display', 'render', 'show', 'print'],
  sortie: ['output', 'exit'],
  entree: ['input'],
  lecture: ['read'],
  ecriture: ['write'],
  chemin: ['path'],
  dossier: ['dir', 'directory', 'folder'],
  repertoire: ['dir', 'directory'],
  test: ['test', 'spec'],
  essai: ['test'],
  delai: ['timeout', 'delay'],
  reessai: ['retry'],
  reprise: ['retry', 'resume'],
  limite: ['limit', 'max'],
  plafond: ['limit', 'budget', 'max'],
  cout: ['cost', 'price'],
  prix: ['price', 'cost'],
  mise: ['update'],
  demarr: ['start', 'boot'],
  arret: ['stop', 'shutdown'],
  processus: ['process'],
  surveill: ['watch', 'monitor'],
  signal: ['signal'],
  reseau: ['network', 'net'],
  requete: ['request'],
  reponse: ['response'],
  serveur: ['server'],
  client: ['client'],
  tableaudebord: ['dashboard'],
  interface: ['ui', 'interface'],
  terminal: ['terminal', 'tty', 'pty'],
  document: ['doc', 'docs'],
  aide: ['help'],
  messag: ['message'],
  avertiss: ['warning', 'warn'],
  droit: ['permission', 'right'],
  permission: ['permission'],
  autoris: ['allow', 'permission'],
  refus: ['reject', 'deny', 'refuse'],
  valid: ['validate', 'check'],
  contr: ['check', 'guard'],
  garde: ['guard'],
  sauvegard: ['save', 'backup'],
  copi: ['copy', 'clone'],
  clone: ['clone'],
  branche: ['branch'],
  valeur: ['value'],
  defaut: ['default'],
  parametr: ['param', 'option', 'setting'],
  analys: ['parse', 'analyze'],
  lanc: ['run', 'start', 'spawn'],
  execut: ['run', 'exec'],
  traduct: ['i18n', 'locale'],
  langue: ['lang', 'locale', 'i18n'],
  couleur: ['color'],
  largeur: ['width'],
  perte: ['lost', 'loss'],
  perdu: ['lost'],
  vide: ['empty'],
  doublon: ['duplicate', 'dedupe'],
  dedoubl: ['dedupe', 'duplicate'],
  recycl: ['recycle', 'reuse'],
  rapport: ['report'],
  stat: ['status', 'stats'],
  etat: ['state', 'status'],
  mort: ['dead'],
  vivant: ['alive', 'live'],
};

export interface RetrievalDoc {
  path: string;
  tf: Map<string, number>;
  len: number;
}

export interface RetrievalIndex {
  docs: RetrievalDoc[];
  df: Map<string, number>;
  avgLen: number;
}

function addTerms(tf: Map<string, number>, list: string[], weight: number): void {
  for (const t of list) tf.set(t, (tf.get(t) ?? 0) + weight);
}

/** Indexe chemins (dossier ×1, nom ×3), symboles ×2, documentation et codes littéraux ×1. */
export interface FieldWeights {
  dir: number;
  base: number;
  symbols: number;
  doc: number;
}

export const DEFAULT_WEIGHTS: FieldWeights = { dir: 1, base: 3, symbols: 2, doc: 1 };

export function buildRetrievalIndex(
  files: readonly string[],
  summaries: ReadonlyMap<string, FileSummary>,
  weights: FieldWeights = DEFAULT_WEIGHTS,
): RetrievalIndex {
  const df = new Map<string, number>();
  const docs: RetrievalDoc[] = [];
  let total = 0;
  for (const path of files) {
    const slash = path.lastIndexOf('/');
    const dir = slash < 0 ? '' : path.slice(0, slash);
    const base = path.slice(slash + 1).replace(/\.[^.]+$/, '');
    const s = summaries.get(path);
    const tf = new Map<string, number>();
    addTerms(tf, terms(dir), weights.dir);
    addTerms(tf, terms(base), weights.base);
    if (s) {
      addTerms(tf, terms(s.symbols.join(' ')), weights.symbols);
      addTerms(tf, terms(`${s.doc ?? ''} ${s.index}`), weights.doc);
    }
    let len = 0;
    for (const [t, c] of tf) {
      len += c;
      df.set(t, (df.get(t) ?? 0) + 1);
    }
    total += len;
    docs.push({ path, tf, len });
  }
  return { docs, df, avgLen: docs.length ? total / docs.length : 1 };
}

export interface Scored {
  path: string;
  score: number;
}

export const BM25_PARAMS = { k1: 1.2, b: 0.75, bridge: 0.6 };

/** Requête pondérée : mots de la tâche à 1, équivalents anglais à 0,6. */
function queryWeights(task: string, bilingual: boolean, bridge: number): Map<string, number> {
  const q = new Map<string, number>();
  for (const t of new Set(terms(task))) {
    q.set(t, Math.max(q.get(t) ?? 0, 1));
    if (!bilingual) continue;
    // Les clés du pont sont comparées sur le radical (préfixe) du mot de la tâche.
    for (const [key, eqs] of Object.entries(BRIDGE)) {
      if (t === key || (key.length >= 4 && t.startsWith(key))) {
        for (const e of eqs) for (const s of terms(e)) q.set(s, Math.max(q.get(s) ?? 0, bridge));
      }
    }
  }
  return q;
}

/** Classement BM25 décroissant (les scores nuls sont omis), ex æquo départagés par chemin. */
export function retrieve(
  index: RetrievalIndex,
  task: string,
  {
    topK = 40,
    bilingual = true,
    k1 = BM25_PARAMS.k1,
    b = BM25_PARAMS.b,
    bridge = BM25_PARAMS.bridge,
  }: { topK?: number; bilingual?: boolean; k1?: number; b?: number; bridge?: number } = {},
): Scored[] {
  const q = queryWeights(task, bilingual, bridge);
  if (q.size === 0) return [];
  const n = index.docs.length;
  const idf = new Map<string, number>();
  for (const t of q.keys()) {
    const d = index.df.get(t) ?? 0;
    idf.set(t, Math.log(1 + (n - d + 0.5) / (d + 0.5)));
  }
  const scored: Scored[] = [];
  for (const doc of index.docs) {
    let score = 0;
    for (const [t, w] of q) {
      const f = doc.tf.get(t);
      if (!f) continue;
      score +=
        w * idf.get(t)! * ((f * (k1 + 1)) / (f + k1 * (1 - b + (b * doc.len) / index.avgLen)));
    }
    if (score > 0) scored.push({ path: doc.path, score });
  }
  scored.sort((a, b) => b.score - a.score || (a.path < b.path ? -1 : 1));
  return scored.slice(0, topK);
}

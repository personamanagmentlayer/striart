/**
 * Co-modification historique : « quand A change, B change aussi » mesuré sur
 * les derniers commits. Signal advisory du Router (contrats partagés, fichiers
 * de test, déclarations de types qui accompagnent un module) — seul, il pèse
 * peu ; il se combine avec l'expansion par imports et appariements.
 *
 * Les commits de masse (réformatage, renommage global) sont ignorés : ils
 * associent tout à tout.
 */
import { simpleGit } from 'simple-git';
import { normalizeFilePath } from './project-path.ts';

export interface CoChangeModel {
  commits: number;
  /** Nombre de commits qui touchent chaque fichier. */
  support: Map<string, number>;
  /** Pour A : B → nombre de commits où A et B changent ensemble. */
  pairs: Map<string, Map<string, number>>;
}

export interface CoChangeOptions {
  /** Commits touchant plus de fichiers : ignorés (masse). */
  maxFilesPerCommit?: number;
}

export function buildCoChange(
  commits: readonly (readonly string[])[],
  { maxFilesPerCommit = 25 }: CoChangeOptions = {},
): CoChangeModel {
  const support = new Map<string, number>();
  const pairs = new Map<string, Map<string, number>>();
  let used = 0;
  for (const raw of commits) {
    const files = [...new Set(raw.map(normalizeFilePath).filter(Boolean))];
    if (files.length === 0 || files.length > maxFilesPerCommit) continue;
    used += 1;
    for (const a of files) {
      support.set(a, (support.get(a) ?? 0) + 1);
      let row = pairs.get(a);
      if (!row) pairs.set(a, (row = new Map()));
      for (const b of files) if (a !== b) row.set(b, (row.get(b) ?? 0) + 1);
    }
  }
  return { commits: used, support, pairs };
}

export interface Associated {
  path: string;
  /** P(B change | A change), dans [0, 1]. */
  confidence: number;
  support: number;
}

/** Fichiers qui changent avec `file` au moins `minSupport` fois et `minConfidence` du temps. */
export function associatedWith(
  model: CoChangeModel,
  file: string,
  { minSupport = 3, minConfidence = 0.5 } = {},
): Associated[] {
  const base = model.support.get(file) ?? 0;
  if (base < minSupport) return [];
  const out: Associated[] = [];
  for (const [other, n] of model.pairs.get(file) ?? []) {
    const confidence = n / base;
    if (n >= minSupport && confidence >= minConfidence)
      out.push({ path: other, confidence, support: n });
  }
  return out.sort((x, y) => y.confidence - x.confidence || (x.path < y.path ? -1 : 1));
}

const modelCache = new Map<string, CoChangeModel>();

/**
 * Charge l'historique récent d'une référence (`ref`, p. ex. la branche cible) par
 * simple-git et le résume. Mémorisé par (racine, ref résolue) : un long processus
 * ne relit pas l'historique tant que la cible n'a pas avancé. Lève si git échoue —
 * l'appelant traite l'absence d'historique comme « pas de signal ».
 */
export async function loadCoChange(
  root: string,
  ref: string,
  { limit = 400, ...options }: CoChangeOptions & { limit?: number } = {},
): Promise<CoChangeModel> {
  // `ref` vient de l'appelant : jamais une option git (`-x`), seulement un nom de ref ou un SHA.
  if (!/^[A-Za-z0-9_][A-Za-z0-9._/-]*$/.test(ref)) {
    throw new Error('référence git invalide pour l’historique de co-modification');
  }
  const git = simpleGit({ baseDir: root });
  const head = (await git.revparse([ref])).trim();
  const key = `${root}\0${head}\0${limit}`;
  const hit = modelCache.get(key);
  if (hit) return hit;
  const out = await git.raw([
    'log',
    '--no-merges',
    '--name-only',
    '--format=%x1e',
    '-n',
    String(limit),
    head,
  ]);
  const commits = out
    .split('\x1e')
    .map((block) => block.split('\n').filter(Boolean))
    .filter((files) => files.length > 0);
  const model = buildCoChange(commits, options);
  if (modelCache.size >= 8) modelCache.clear();
  modelCache.set(key, model);
  return model;
}

/** Pour les tests. */
export function resetCoChangeCache(): void {
  modelCache.clear();
}

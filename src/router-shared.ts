/**
 * Fichiers « de tenue de livre » partagés (journal des changements, README,
 * documentation, feuille de route, manifestes et verrous de dépendances).
 *
 * Presque toute tâche réelle les touche : les laisser dans la prédiction
 * sérialiserait à tort la quasi-totalité des agents entre eux, pour des
 * conflits triviaux que le Merger résout. La politique `tokens.router.sharedFiles`
 * les retire donc de ce qui sert à DÉTECTER LES COLLISIONS (le tableau rendu par
 * `predictFiles`) tout en les conservant dans `details.shared` pour l'information.
 *  - 'exclude' : retirés du tableau de collision (défaut) ;
 *  - 'keep'    : comportement historique, traités comme n'importe quel fichier.
 */
import { compileGlob } from './glob-lite.ts';

export const DEFAULT_SHARED_PATTERNS: readonly string[] = Object.freeze([
  '**/CHANGELOG*',
  '**/README*',
  '**/CONTRIBUTING*',
  'docs/**',
  'roadmap/**',
  '**/package.json',
  '**/package-lock.json',
  '**/pnpm-lock.yaml',
  '**/yarn.lock',
  '**/Cargo.lock',
  '**/*.lock',
]);

export type SharedMatcher = (file: string) => boolean;

/** Matcher insensible à la casse ; un motif invalide lève (validé en amont à la config). */
export function compileSharedMatcher(patterns: readonly string[]): SharedMatcher {
  const compiled = patterns.map((p) => compileGlob(p, true));
  return (file) => compiled.some((re) => re.test(file));
}

export function partitionShared(
  files: readonly string[],
  isShared: SharedMatcher,
): { own: string[]; shared: string[] } {
  const own: string[] = [];
  const shared: string[] = [];
  for (const f of files) (isShared(f) ? shared : own).push(f);
  return { own, shared };
}

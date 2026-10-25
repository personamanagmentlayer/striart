/**
 * Globs ANCRÉS minimaux, sans dépendance et sans accolades : source unique
 * pour la garde des chemins protégés (protected-paths.ts) et le filtre de
 * l'arbre du Router (tokens.router.tree.exclude). Module sans import lourd :
 * il est chargé par la validation de la config, donc au démarrage de chaque
 * commande.
 *
 * Grammaire : segments séparés par `/` ; `*` et `?` ne franchissent pas un
 * `/` ; `**` seul dans son segment franchit les dossiers (`x/**` = `x` et
 * tout son contenu, `**` seul = tout). Chemins relatifs uniquement.
 */

/** Pourquoi un motif est refusé ; null s'il est valide. */
export function globPatternProblem(pattern: unknown): string | null {
  if (typeof pattern !== 'string' || pattern.trim().length === 0) return 'EMPTY';
  if (pattern !== pattern.trim()) return 'WHITESPACE';
  if (/[\0\\[\]{}]/.test(pattern)) return 'UNSUPPORTED_SYNTAX';
  if (pattern.startsWith('!')) return 'NEGATION';
  if (pattern.startsWith('/')) return 'ABSOLUTE';
  const segments = pattern.split('/');
  if (segments.some((s) => s === '' || s === '.' || s === '..')) return 'BAD_SEGMENT';
  if (segments.some((s) => s.includes('**') && s !== '**')) return 'BAD_GLOBSTAR';
  return null;
}

/** Glob ancré → RegExp. Lève si le motif est invalide (voir globPatternProblem). */
export function compileGlob(pattern: string, caseInsensitive: boolean): RegExp {
  const problem = globPatternProblem(pattern);
  if (problem) throw new Error(`invalid glob pattern (${problem})`);
  const segments = pattern.split('/');
  let source = '';
  for (let i = 0; i < segments.length; i += 1) {
    const segment = segments[i];
    const last = i === segments.length - 1;
    if (segment === '**') {
      if (last) {
        // `x/**` : `x` lui-même et tout ce qu'il contient ; `**` seul : tout.
        source = i === 0 ? '.*' : `${source.slice(0, -1)}(?:/.*)?`;
      } else {
        source += '(?:[^/]+/)*';
      }
      continue;
    }
    source += segment
      .replaceAll(/[.+^$()|\\]/g, '\\$&')
      .replaceAll('*', '[^/]*')
      .replaceAll('?', '[^/]');
    if (!last) source += '/';
  }
  return new RegExp(`^${source}$`, caseInsensitive ? 'i' : '');
}

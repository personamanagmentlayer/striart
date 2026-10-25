import path from 'node:path';

/**
 * Chemins de `.striart/` dont les changements ne sont JAMAIS un changement
 * d'état à rafraîchir — source unique des watchers du Control Protocol
 * (`control/hub.ts`) et du flux de ressources MCP (`mcp/change-feed.ts`).
 *
 *  - `agents/`     clones entiers (leurs refs ont leur propre watcher) ;
 *  - `lock-queue/` file d'attente du verrou principal ;
 *  - `removing/`   marqueurs de suppression de clone en cours ;
 *  - `main.lock`, `state.lock`, `state.lock.break`, `state.lock.break.reclaim` :
 *    verrous transitoires —
 *    pris et relâchés par chaque écriture d'état, ils déclencheraient un
 *    rafraîchissement par écriture… dont la collecte reprend le verrou
 *    (boucle d'auto-excitation) ;
 *  - `*.tmp`       écritures atomiques en cours (le rename, lui, est vu).
 *
 * `extraHeads` : dossiers propres à un consommateur (logs/, control/…).
 * `rel` est relatif à `.striart/` ; la racine et un chemin hors du dossier
 * ne sont pas décidés ici (false).
 */
const COMMON_IGNORED_HEADS: ReadonlySet<string> = new Set(['agents', 'lock-queue', 'removing']);
const TRANSIENT_FILES: ReadonlySet<string> = new Set([
  'main.lock',
  'state.lock',
  'state.lock.break',
  'state.lock.break.reclaim',
]);

export function isIgnoredStatePath(rel: string, extraHeads: readonly string[] = []): boolean {
  if (rel === '' || rel.startsWith('..')) return false;
  const [head] = rel.split(path.sep);
  return (
    COMMON_IGNORED_HEADS.has(head) ||
    extraHeads.includes(head) ||
    TRANSIENT_FILES.has(rel) ||
    rel.endsWith('.tmp')
  );
}

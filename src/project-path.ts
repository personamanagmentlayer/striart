import path from 'node:path';

/**
 * Un chemin donné par une source non fiable (prédiction du LLM, option de
 * ligne de commande) est-il un chemin de projet légitime (relatif, dans
 * l'arbre) ? Un `../` ou un chemin absolu n'ont aucun sens ici : on les écarte
 * à la source. Défense en profondeur, pas dernière ligne.
 *
 * Module sans dépendance lourde : la CLI le charge à chaque démarrage (parse.ts)
 * sans traîner le Router et la couche LLM.
 */
export function isSafeProjectPath(p: unknown): boolean {
  if (typeof p !== 'string' || p.length === 0) return false;
  if (path.isAbsolute(p) || /^[A-Za-z]:/.test(p)) return false; // absolu POSIX ou lettre de lecteur Windows
  return !p.split('/').includes('..');
}

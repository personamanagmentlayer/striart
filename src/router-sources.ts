/**
 * Accès aux SOURCES du projet pour le Router (carte du dépôt, graphe d'imports).
 *
 * Une abstraction minuscule plutôt que `readFile(root, path)` partout : le Router
 * lit le disque en production (`fsSources`), mais le banc (`scripts/bench-router.ts`)
 * lui présente l'arbre d'un commit PASSÉ lu depuis les objets git, sans extraire
 * de worktree — la même logique tourne donc sur les deux.
 *
 * `version(path)` est une clé de cache bon marché (taille:mtime sur disque, oid
 * git pour le banc) : une analyse n'est refaite que si elle change.
 */
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';

/** Au-delà : fichier généré/bundle, sans valeur pour la carte ni le graphe. */
export const MAX_SOURCE_BYTES = 200_000;

export interface ProjectSources {
  /** Contenu texte, ou null (illisible, binaire, trop gros, absent). */
  read(file: string): Promise<string | null>;
  /** Clé de cache de la version courante du fichier, ou null s'il est absent. */
  version(file: string): Promise<string | null>;
}

export function fsSources(root: string): ProjectSources {
  const abs = (file: string) => path.join(root, file);
  return {
    async read(file) {
      try {
        // La taille est contrôlée AVANT la lecture : un bundle généré de plusieurs Mo n'est jamais chargé.
        const st = await stat(abs(file));
        if (!st.isFile() || st.size > MAX_SOURCE_BYTES) return null;
        return await readFile(abs(file), 'utf8');
      } catch {
        return null; // fichier disparu/illisible : signal advisory, jamais une erreur
      }
    },
    async version(file) {
      try {
        const st = await stat(abs(file));
        return st.isFile() ? `${st.size}:${Math.trunc(st.mtimeMs)}` : null;
      } catch {
        return null;
      }
    },
  };
}

/** Exécute `fn` sur `items` avec au plus `limit` opérations en vol. */
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]!, i);
      }
    }),
  );
  return out;
}

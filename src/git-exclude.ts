import { lstat } from 'node:fs/promises';
import path from 'node:path';
import { safeReadText, safeWriteFile, unsafeWrite } from './safe-write.ts';

/**
 * `.git/info/exclude` d'un clone d'agent : ignore LOCALE, jamais partagée
 * ni commitée. Un fichier non suivi que Striart dépose dans un clone
 * (mémoire, consignes, boîtes de collaboration, configuration de hook) doit
 * y figurer : sinon il salirait le `git status` de l'agent (rebase auto
 * ajourné en SKIPPED_DIRTY) ou serait capturé par un `git add -A`.
 *
 * Module UNIQUE pour tout Striart (mémoire, consignes injectées, collab,
 * hooks). Format conservé à l'identique de l'implémentation historique de
 * memory.js : contenu existant gardé tel quel (fins de ligne comprises),
 * nouvelles entrées ajoutées en fin, une par ligne.
 *
 * Seule différence assumée : un fichier ILLISIBLE (autre qu'absent) fait
 * échouer l'appel au lieu d'être traité comme vide — l'ancien comportement
 * l'aurait ensuite écrasé, perdant les exclusions existantes.
 */

export function cloneExcludePath(clonePath: string): string {
  return path.join(clonePath, '.git', 'info', 'exclude');
}

/** Chemin de l'exclude relatif au clone (séparateur `/`, comme safe-write). */
const EXCLUDE_REL = '.git/info/exclude';

/**
 * Lit l'exclude sans suivre de lien (le clone est écrit par un agent). Absent :
 * null. Présent mais illisible ou atteint par un lien : erreur — jamais traité
 * comme vide, il serait ensuite écrasé.
 */
async function readExclude(clonePath: string): Promise<string | null> {
  const text = await safeReadText(clonePath, EXCLUDE_REL);
  if (text !== null) return text;
  try {
    await lstat(cloneExcludePath(clonePath));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  throw unsafeWrite('the exclude file is unreadable or reached through a link', EXCLUDE_REL);
}

/** Ajoute les entrées absentes (idempotent), en une seule écriture. */
export async function ensureCloneExcludes(
  clonePath: string,
  entries: readonly string[],
): Promise<void> {
  const current = (await readExclude(clonePath)) ?? '';
  const lines = current.split(/\r?\n/);
  const missing = [...new Set(entries)].filter((entry) => !lines.includes(entry));
  if (missing.length === 0) return;
  await safeWriteFile(clonePath, EXCLUDE_REL, `${current.trimEnd()}\n${missing.join('\n')}\n`);
}

/** Ajoute une entrée (idempotent) — forme historique de memory.js. */
export async function ensureCloneExclude(clonePath: string, entry: string): Promise<void> {
  await ensureCloneExcludes(clonePath, [entry]);
}

/** Retire exactement ces entrées ; le reste du fichier est conservé. Fichier absent : rien. */
export async function removeCloneExcludes(
  clonePath: string,
  entries: readonly string[],
): Promise<void> {
  const current = await readExclude(clonePath);
  if (current === null) return;
  const lines = current.split(/\r?\n/);
  const kept = lines.filter((line) => !entries.includes(line));
  if (kept.length === lines.length) return;
  const body = kept.join('\n').replace(/^\n+/, '').trimEnd();
  await safeWriteFile(clonePath, EXCLUDE_REL, body === '' ? '' : `${body}\n`);
}

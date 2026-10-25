import { randomBytes } from 'node:crypto';
import { lstat, mkdir, open, readFile, realpath, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { StriartError } from './errors.js';

/**
 * Écritures de Striart DANS un dossier qu'un agent peut modifier (un clone) :
 * UNE primitive pour la mémoire, les consignes injectées, l'inbox de
 * collaboration, `.git/info/exclude`, la configuration des hooks.
 *
 * Le problème : un agent sandboxé (écriture limitée à son clone) y plante un
 * lien symbolique `.striart-inbox.md -> ~/.ssh/authorized_keys` (ou remplace un
 * dossier intermédiaire par un lien) ; l'écriture suivante de Striart, qui
 * tourne SANS sandbox, suivrait le lien — l'évasion est faite par Striart.
 *
 * Le contrat, pour un chemin RELATIF à `root` (le clone) :
 *  - chaque composant intermédiaire est inspecté (`lstat`, jamais suivi) : un
 *    lien symbolique (ou une jonction Windows) ou un non-dossier est refusé ;
 *    ceux qui manquent sont créés un par un (jamais `mkdir -p` qui suit) ;
 *  - une feuille qui est un lien est remplacée (le lien lui-même, pas sa
 *    cible) ; une feuille dossier est refusée ;
 *  - le contenu est écrit dans un temporaire créé EXCLUSIVEMENT (`wx`, ne suit
 *    pas un lien) puis renommé sur la feuille : le rename remplace l'entrée de
 *    répertoire, jamais l'inode — un lien dur planté vers un fichier extérieur
 *    n'est donc pas modifié ;
 *  - juste avant le rename, le parent est re-résolu (`realpath`) et doit rester
 *    sous le `realpath` de `root` (un dossier échangé entre-temps est détecté).
 *
 * Limite assumée : entre cette dernière vérification et le rename, un agent
 * concurrent peut encore échanger un dossier ; la fenêtre est de quelques
 * microsecondes et seul `openat2(RESOLVE_BENEATH)` (non exposé par Node) la
 * fermerait. Les écritures restent best effort côté appelants.
 */

export function unsafeWrite(reason: string, rel: string): StriartError {
  return new StriartError(
    `Write refused: ${reason} (${rel}). Striart does not write through links inside an agent clone.`,
    {
      code: 'SAFE_WRITE_UNSAFE',
      hint: 'striart doctor',
      details: { reason, path: rel },
    },
  );
}

export function isSafeWriteError(error: unknown): boolean {
  return error instanceof StriartError && error.code === 'SAFE_WRITE_UNSAFE';
}

/** Segments d'un chemin relatif sûr ; refuse absolu, `..`, vide, NUL. */
function segmentsOf(rel: string): string[] {
  const normalized = rel.replaceAll('\\', '/');
  const segments = normalized.split('/').filter((s) => s !== '' && s !== '.');
  if (
    segments.length === 0 ||
    normalized.startsWith('/') ||
    /^[A-Za-z]:/.test(normalized) ||
    normalized.includes('\0') ||
    segments.includes('..')
  ) {
    throw unsafeWrite('path is not a clean relative path', rel);
  }
  return segments;
}

async function lstatOrNull(file: string) {
  try {
    return await lstat(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

/**
 * Parcourt les dossiers intermédiaires. `create` : crée les manquants un par
 * un. Rend le dossier parent, ou null s'il n'existe pas (et `create` faux).
 */
async function walkParents(
  root: string,
  dirs: string[],
  rel: string,
  create: boolean,
): Promise<string | null> {
  let current = root;
  for (const segment of dirs) {
    current = path.join(current, segment);
    let info = await lstatOrNull(current);
    if (!info) {
      if (!create) return null;
      try {
        await mkdir(current);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
      info = await lstat(current);
    }
    if (info.isSymbolicLink()) throw unsafeWrite('a parent directory is a link', rel);
    if (!info.isDirectory()) throw unsafeWrite('a parent component is not a directory', rel);
  }
  return current;
}

async function assertStillInside(root: string, parent: string, rel: string): Promise<void> {
  const [realRoot, realParent] = await Promise.all([realpath(root), realpath(parent)]);
  const relative = path.relative(realRoot, realParent);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw unsafeWrite('the parent directory resolves outside the clone', rel);
  }
}

export interface SafeWriteOptions {
  /** Mode du fichier créé (POSIX ; sans effet réel sous Windows). Défaut 0o644. */
  mode?: number;
  /** Créer les dossiers manquants (un par un, sans suivre de lien). Défaut true. */
  mkdirp?: boolean;
}

/** Écrit `content` à `rel` sous `root` sans jamais suivre un lien (voir l'en-tête). */
export async function safeWriteFile(
  root: string,
  rel: string,
  content: string | Uint8Array,
  { mode = 0o644, mkdirp = true }: SafeWriteOptions = {},
): Promise<void> {
  const segments = segmentsOf(rel);
  const leaf = segments[segments.length - 1];
  const parent = await walkParents(root, segments.slice(0, -1), rel, mkdirp);
  if (parent === null) throw unsafeWrite('the parent directory does not exist', rel);
  const target = path.join(parent, leaf);

  const existing = await lstatOrNull(target);
  if (existing?.isDirectory()) throw unsafeWrite('the target is a directory', rel);
  // Lien (symbolique ou jonction), FIFO, périphérique : l'entrée elle-même est
  // retirée — `rm` ne suit pas un lien — puis le fichier est recréé.
  if (existing && !existing.isFile()) await rm(target, { force: true });

  const tmp = path.join(parent, `.${leaf}.${randomBytes(6).toString('hex')}.tmp`);
  try {
    const handle = await open(tmp, 'wx', mode);
    try {
      await handle.writeFile(content);
    } finally {
      await handle.close();
    }
    await assertStillInside(root, parent, rel);
    try {
      await rename(tmp, target);
    } catch (error) {
      // Windows : rename refusé quand un process tient la cible ouverte sans
      // partage de suppression. Repli sur l'écriture en place, seulement si la
      // cible vient d'être revérifiée comme fichier ordinaire à un seul lien.
      const code = (error as NodeJS.ErrnoException).code;
      if (process.platform !== 'win32' || (code !== 'EPERM' && code !== 'EBUSY')) throw error;
      const again = await lstatOrNull(target);
      if (!again?.isFile() || again.nlink > 1)
        throw unsafeWrite('the target cannot be replaced', rel);
      const inPlace = await open(target, 'w', mode);
      try {
        await inPlace.writeFile(content);
      } finally {
        await inPlace.close();
      }
    }
  } finally {
    await rm(tmp, { force: true }).catch(() => {
      // Temporaire déjà renommé ou absent : rien à nettoyer.
    });
  }
}

/** Copie `source` vers `rel` sous `root` (écriture sûre du contenu lu). */
export async function safeCopyFile(
  root: string,
  rel: string,
  source: string,
  options: SafeWriteOptions = {},
): Promise<void> {
  await safeWriteFile(root, rel, await readFile(source), options);
}

/**
 * Retire `rel` sous `root` : l'entrée elle-même, jamais la cible d'un lien, et
 * seulement si les dossiers intermédiaires ne sont pas des liens. Absent : rien.
 */
export async function safeRemove(root: string, rel: string): Promise<void> {
  const segments = segmentsOf(rel);
  const parent = await walkParents(root, segments.slice(0, -1), rel, false);
  if (parent === null) return;
  const target = path.join(parent, segments[segments.length - 1]);
  const existing = await lstatOrNull(target);
  if (!existing) return;
  if (existing.isDirectory()) throw unsafeWrite('the target is a directory', rel);
  await rm(target, { force: true });
}

/**
 * Lit `rel` sous `root` comme texte UTF-8 si c'est un fichier ordinaire atteint
 * sans lien ; null sinon (absent, lien, dossier, périphérique, trop gros).
 * Jamais de lecture à travers un lien : `readFile` sur un lien vers
 * `/dev/zero` ou un fichier géant bloquerait ou saturerait la mémoire.
 */
export async function safeReadText(
  root: string,
  rel: string,
  maxBytes = 4 * 1024 * 1024,
): Promise<string | null> {
  let segments: string[];
  try {
    segments = segmentsOf(rel);
  } catch {
    return null;
  }
  let parent: string | null;
  try {
    parent = await walkParents(root, segments.slice(0, -1), rel, false);
  } catch {
    return null;
  }
  if (parent === null) return null;
  const target = path.join(parent, segments[segments.length - 1]);
  const info = await lstatOrNull(target);
  if (!info?.isFile() || info.size > maxBytes) return null;
  return readFile(target, 'utf8').catch(() => null);
}

/**
 * Nature de l'entrée `rel` sous `root`, sans suivre de lien : 'absent', 'file'
 * (fichier ordinaire atteint sans lien) ou 'other' (lien, dossier, spécial, ou
 * dossier intermédiaire qui est un lien). Sert à ne jamais traiter comme
 * « libre » une entrée qui n'est pas à Striart.
 */
export async function safeEntryKind(
  root: string,
  rel: string,
): Promise<'absent' | 'file' | 'other'> {
  let segments: string[];
  try {
    segments = segmentsOf(rel);
  } catch {
    return 'other';
  }
  let parent: string | null;
  try {
    parent = await walkParents(root, segments.slice(0, -1), rel, false);
  } catch {
    return 'other';
  }
  if (parent === null) return 'absent';
  const info = await lstatOrNull(path.join(parent, segments[segments.length - 1]));
  if (!info) return 'absent';
  return info.isFile() ? 'file' : 'other';
}

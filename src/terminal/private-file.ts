import { randomBytes } from 'node:crypto';
import { chmod, lstat, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { StriartError } from '../errors.js';

/**
 * Écriture atomique d'un fichier HORS de `.striart/` (dossier de données
 * d'un terminal, configuration d'un outil de coding) avec un mode explicite :
 *  - la cible, si elle existe, doit être un fichier ordinaire (un lien
 *    symbolique planté rediriger l'écriture ailleurs : refus) ;
 *  - temporaire créé EXCLUSIVEMENT (`wx`) dans le même dossier, avec le mode
 *    demandé, puis renommé sur la cible (jamais de fichier à moitié écrit).
 * `writeFileAtomic` (json-file.js) sert les fichiers d'état de Striart et ne
 * règle pas le mode : d'où ce module, partagé par Warp et les hooks.
 *
 * Sous Windows, le mode n'a pas d'effet réel (les ACL du dossier
 * s'appliquent) : documenté, pas simulé.
 */
export async function writePrivateFileAtomic(
  target: string,
  content: string,
  { mode = 0o600, code = 'TERMINAL_UNSAFE' }: { mode?: number; code?: string } = {},
): Promise<void> {
  const existing = await lstat(target).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (existing && !existing.isFile()) {
    throw new StriartError(
      `Écriture refusée : ${target} existe et n'est pas un fichier ordinaire (lien symbolique ?).`,
      { code, details: { path: target } },
    );
  }
  const dir = path.dirname(target);
  const tmp = path.join(dir, `.${path.basename(target)}.${randomBytes(6).toString('hex')}.tmp`);
  try {
    await writeFile(tmp, content, { encoding: 'utf8', flag: 'wx', mode });
    // umask ne peut que retirer des bits : chmod garantit le mode exact.
    await chmod(tmp, mode);
    await rename(tmp, target);
  } catch (error) {
    await rm(tmp, { force: true }).catch(() => {
      // Temporaire déjà absent : rien de plus à nettoyer, l'erreur d'origine remonte.
    });
    throw error;
  }
}

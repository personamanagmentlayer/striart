import { randomBytes } from 'node:crypto';
import { open, readFile, readdir, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { StriartError } from './errors.ts';
import { logger } from './logger.ts';
import { assertStateLockHeld, withStateLock } from './state-lock.ts';

/**
 * Socle des fichiers d'état (`.striart/*.json`, tickets, demandes de
 * permission, PID files).
 *
 * Écriture (writeJsonAtomic v2) : fichier temporaire au nom UNIQUE
 * (`<fichier>.<pid>.<aléa>.tmp`, deux écrivains ne partagent jamais le même),
 * contenu forcé sur disque (`FileHandle.sync`) AVANT le renommage, puis
 * `fsync` du dossier sous POSIX (le renommage lui-même devient durable).
 * Windows refuse le renommage tant qu'un autre process a la cible ouverte
 * (EPERM/EACCES/EBUSY, 24 à 70 % des écritures sous lecture concurrente
 * d'après l'audit) : retenté avec attente exponentielle et gigue, dans un
 * budget de TRANSIENT_RETRY_BUDGET_MS. Au-delà, ou sur toute autre erreur :
 * le temporaire est retiré et l'écriture échoue (STATE_WRITE_FAILED) — fail
 * closed, l'état précédent reste intact. Pas de graceful-fs : un correctif
 * global de `fs` changerait le comportement de tout le process.
 *
 * Lecture (readJson) : retentée sur les mêmes erreurs passagères de Windows
 * (fichier en cours de remplacement).
 *
 * Mise à jour (updateJsonLocked) : lecture-modification-écriture sous le
 * verrou d'état du dossier (state-lock.js) — sans lui, deux process qui
 * mettent à jour le même fichier perdent l'une des deux écritures.
 */

/** Budget des nouvelles tentatives sur erreur passagère (Windows). */
export const TRANSIENT_RETRY_BUDGET_MS = 2_000;
/** Budget d'une lecture : plus court, un lecteur n'a qu'un remplacement à laisser passer. */
const READ_RETRY_BUDGET_MS = 1_000;

/** Temporaire d'écriture : `<nom>.<pid>.<12 hex>.tmp`. */
const TEMP_FILE_RE = /\.(\d+)\.[0-9a-f]{12}\.tmp$/;
/** Temporaire au nom fixe des versions <= 0.11 (`agents.json.tmp`). */
const LEGACY_TEMP_RE = /\.json\.tmp$/;
/** Un temporaire de process vivant plus vieux que ça est abandonné (écriture de quelques ms). */
const TEMP_ORPHAN_AGE_MS = 10 * 60_000;
/** Temporaire sans PID (ancien format) : orphelin au-delà. */
const UNOWNED_TEMP_AGE_MS = 60_000;

/** Codes FS que Windows renvoie le temps qu'un autre process lâche le fichier. */
const TRANSIENT_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);

/** Erreur passagère de Windows (fichier ouvert sans partage, suppression en attente). */
export function isTransientFsError(error) {
  return process.platform === 'win32' && TRANSIENT_CODES.has(error?.code);
}

/**
 * Exécute `operation`, retentée sur erreur passagère avec attente
 * exponentielle plafonnée et gigue (moitié fixe, moitié aléatoire), jusqu'à
 * `budgetMs`. La dernière erreur remonte telle quelle.
 * @template T
 * @param {() => Promise<T>} operation
 * @param {{budgetMs?: number, isTransient?: (error: any) => boolean}} [options]
 * @returns {Promise<T>}
 */
export async function withTransientRetry(
  operation,
  { budgetMs = TRANSIENT_RETRY_BUDGET_MS, isTransient = isTransientFsError } = {},
) {
  const deadline = Date.now() + budgetMs;
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      const remaining = deadline - Date.now();
      if (!isTransient(error) || remaining <= 0) throw error;
      const cap = Math.min(4 * 2 ** attempt, 200);
      await sleep(Math.min(cap / 2 + Math.random() * (cap / 2), remaining));
    }
  }
}

/**
 * Lit un fichier JSON. Retourne `fallback` si le fichier n'existe pas,
 * throw StriartError(code) s'il est corrompu, STATE_READ_FAILED s'il reste
 * illisible (droits, E/S) après les nouvelles tentatives.
 */
export async function readJson(filePath, { fallback, code = 'JSON_CORRUPT' }) {
  let raw;
  try {
    raw = await withTransientRetry(() => readFile(filePath, 'utf8'), {
      budgetMs: READ_RETRY_BUDGET_MS,
    });
  } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw new StriartError(`Fichier d'état illisible (${filePath}) : ${error.code}.`, {
      code: 'STATE_READ_FAILED',
      hint: 'striart doctor',
      details: { path: filePath, cause: error.code ?? error.message },
    });
  }
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new StriartError(`Fichier JSON corrompu (${filePath}) : ${error.message}`, {
      code,
      details: { path: filePath, cause: error.message },
    });
  }
}

/** Codes d'un `fsync` de dossier que le système de fichiers ne sait pas faire. */
const DIR_SYNC_UNSUPPORTED = new Set(['EINVAL', 'ENOTSUP', 'EISDIR', 'EPERM', 'EACCES']);

/**
 * Rend le renommage durable (POSIX). Windows n'ouvre pas un dossier en
 * lecture : NTFS journalise déjà les métadonnées, rien à faire. Un échec ici
 * n'annule PAS l'écriture (elle est visible) : il est journalisé, jamais tu.
 */
async function syncDirectory(dir) {
  if (process.platform === 'win32') return;
  let handle;
  try {
    handle = await open(dir, 'r');
    await handle.sync();
  } catch (error) {
    if (!DIR_SYNC_UNSUPPORTED.has(error.code)) {
      logger.warn({ err: error.code ?? error.message, dir }, 'fsync du dossier d’état impossible');
    }
  } finally {
    await handle?.close().catch(() => {});
  }
}

/** @param {string} filePath */
function tempPathFor(filePath) {
  return `${filePath}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
}

/**
 * Écriture atomique et durable d'un contenu texte : un crash au milieu ne
 * laisse jamais un fichier à moitié écrit, deux écrivains concurrents ne se
 * mélangent jamais (le dernier renommage gagne, entier).
 * @param {string} filePath @param {string} content
 */
export async function writeFileAtomic(filePath, content) {
  const tmp = tempPathFor(filePath);
  let handle = null;
  try {
    // 0600 : les fichiers d'état portent des prompts, des chemins, des jetons.
    handle = await open(tmp, 'wx', 0o600);
    await handle.writeFile(content, 'utf8');
    await handle.sync();
    await handle.close();
    handle = null;
    await withTransientRetry(() => rename(tmp, filePath));
  } catch (error) {
    await handle?.close().catch(() => {});
    await rm(tmp, { force: true }).catch(() => {
      // Reliquat : balayé par sweepOrphanTempFiles (réconciliation).
    });
    throw new StriartError(`Écriture du fichier d'état impossible (${filePath}) : ${error.code}.`, {
      code: 'STATE_WRITE_FAILED',
      hint: 'striart doctor',
      details: { path: filePath, cause: error.code ?? error.message },
    });
  }
  await syncDirectory(path.dirname(filePath));
}

/**
 * Écriture atomique d'un JSON (voir writeFileAtomic).
 * @param {string} filePath @param {unknown} data
 */
export async function writeJsonAtomic(filePath, data) {
  await writeFileAtomic(filePath, `${JSON.stringify(data, null, 2)}\n`);
}

/**
 * Codes d'un `rm` récursif qui se lèvent d'eux-mêmes : handle tenu par un
 * indexeur, un antivirus ou un watcher (Windows), dossier repeuplé pendant
 * le parcours, table de descripteurs pleine.
 */
const RM_TRANSIENT_CODES = new Set(['EBUSY', 'EPERM', 'EACCES', 'ENOTEMPTY', 'EMFILE', 'ENFILE']);
/** Windows libère ses handles en secondes (watcher chokidar : ~1 s mesurée). */
const RM_RETRY_BUDGET_MS = process.platform === 'win32' ? 10_000 : 1_000;

/**
 * Suppression récursive avec nouvelles tentatives à attente exponentielle et
 * gigue (le `maxRetries` de Node n'attend que linéairement, 100 ms × essai).
 * La dernière erreur remonte.
 * @param {string} dir
 */
export async function removeTreeWithBackoff(dir) {
  await withTransientRetry(() => rm(dir, { recursive: true, force: true }), {
    budgetMs: RM_RETRY_BUDGET_MS,
    isTransient: (error) => RM_TRANSIENT_CODES.has(error?.code),
  });
}

/** Valeur de retour d'un mutateur qui n'a rien changé : aucune écriture. */
export const UNCHANGED = Symbol('UNCHANGED');

/**
 * Lecture-modification-écriture d'un fichier JSON sous le verrou d'état de
 * son dossier : aucune mise à jour concurrente (autre process, autre
 * contexte asynchrone) ne peut être perdue entre la lecture et l'écriture.
 *
 * `mutator` reçoit la valeur courante (ou une copie de `fallback`) et rend la
 * valeur à écrire — ou UNCHANGED pour ne rien écrire. Il doit être COURT :
 * aucune opération git, LLM, process, ni `withMainLock` (ordre de prise :
 * verrou principal PUIS verrou d'état). Une exception du mutateur annule la
 * mise à jour (rien n'est écrit) et remonte.
 *
 * @template T
 * @param {string} filePath
 * @param {{fallback: T, code?: string}} options
 * @param {(current: T) => T | typeof UNCHANGED | Promise<T | typeof UNCHANGED>} mutator
 * @returns {Promise<T>} la valeur désormais sur disque
 */
export async function updateJsonLocked(filePath, { fallback, code }, mutator) {
  const dir = path.dirname(filePath);
  // Mise à jour d'un enregistrement qui doit EXISTER (fallback null) dont le dossier n'existe
  // pas encore : il n'y a rien à protéger d'une écriture concurrente (le verrou vit dans ce
  // dossier). Le mutateur juge sur « absent » — « demande inconnue » plutôt qu'une erreur de
  // verrou — et ne peut rien écrire : les créateurs font leur `mkdir` avant.
  if (
    fallback === null &&
    !(await stat(dir).then(
      (s) => s.isDirectory(),
      () => false,
    ))
  ) {
    const next = await mutator(null);
    if (next === UNCHANGED) return null;
  }
  return withStateLock(dir, async () => {
    const current = await readJson(filePath, { fallback: structuredClone(fallback), code });
    const next = await mutator(current);
    if (next === UNCHANGED) return current;
    await assertStateLockHeld(dir);
    await writeJsonAtomic(filePath, next);
    return next;
  });
}

/**
 * Retire les temporaires d'écriture orphelins (crash entre l'écriture et le
 * renommage) sous `dir`, sans jamais toucher à celui d'un écrivain en cours :
 *  - `<f>.<pid>.<aléa>.tmp` : PID mort (et pas le nôtre), ou plus vieux que
 *    TEMP_ORPHAN_AGE_MS ;
 *  - ancien format `<f>.json.tmp` : plus vieux que UNOWNED_TEMP_AGE_MS.
 * `skip` : noms de sous-dossiers à ne jamais parcourir (les clones d'agents
 * sont des worktrees : un `.tmp` y appartient à l'agent).
 * @param {string} dir
 * @param {{maxDepth?: number, skip?: string[]}} [options]
 * @returns {Promise<string[]>} chemins retirés
 */
export async function sweepOrphanTempFiles(dir, { maxDepth = 2, skip = [] } = {}) {
  const removed = [];
  const now = Date.now();
  // Chargé à la demande (binaire natif, execa) : hors du chemin d'écriture.
  const { isProcessAlive } = await import('./process-tree.ts');
  const walk = async (current, depth) => {
    const entries = await readdir(current, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (depth < maxDepth && !(depth === 0 && skip.includes(entry.name))) {
          await walk(full, depth + 1);
        }
        continue;
      }
      if (!entry.isFile()) continue;
      const owned = TEMP_FILE_RE.exec(entry.name);
      if (!owned && !LEGACY_TEMP_RE.test(entry.name)) continue;
      const stats = await stat(full).catch(() => null);
      if (!stats) continue;
      const age = now - stats.mtimeMs;
      let orphan;
      if (owned) {
        const pid = Number(owned[1]);
        orphan =
          age > TEMP_ORPHAN_AGE_MS || (pid !== process.pid && !isProcessAlive(pid) && age > 1_000);
      } else {
        orphan = age > UNOWNED_TEMP_AGE_MS;
      }
      if (!orphan) continue;
      try {
        await rm(full, { force: true });
        removed.push(full);
      } catch (error) {
        logger.warn({ err: error.code, path: full }, 'Temporaire orphelin non retiré');
      }
    }
  };
  await walk(dir, 0);
  return removed;
}

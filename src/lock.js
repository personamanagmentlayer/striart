import { open, readFile, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { simpleGit } from 'simple-git';
import { striartDir } from './paths.js';
import { StriartError } from './errors.js';
import { logger } from './logger.js';

const POLL_MS = 300;
const DEFAULT_TIMEOUT_MS = 120_000;
// TTL de sécurité contre la réutilisation de PID : un lock plus vieux que ça
// est cassé même si un processus porte (par hasard) le même PID.
const STALE_TTL_MS = 30 * 60 * 1000;

// Réentrance intra-processus : les opérations s'imbriquent (stop → retryQueue,
// merge → sync). Dans un même processus, la sérialisation est déjà assurée
// par la chaîne de promesses du watch ; le lock fichier protège ENTRE processus.
let depth = 0;

function lockPath(root) {
  return path.join(striartDir(root), 'main.lock');
}

function pidAlive(pid) {
  if (!Number.isInteger(pid)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM = le process existe mais ne nous appartient pas → vivant.
    return error.code === 'EPERM';
  }
}

async function readLockInfo(file) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return null; // en cours d'écriture par le détenteur, ou corrompu
  }
}

async function lockAgeMs(file) {
  const stats = await stat(file).catch(() => null);
  return stats ? Date.now() - stats.mtimeMs : 0;
}

/**
 * Acquiert le verrou par création exclusive ('wx' : atomique au niveau du
 * noyau). Sur EEXIST : casse les verrous orphelins (détenteur mort, ou plus
 * vieux que le TTL), sinon attend son tour par polling jusqu'au timeout.
 */
async function acquire(root, label, timeoutMs) {
  const file = lockPath(root);
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    try {
      const handle = await open(file, 'wx');
      await handle.writeFile(
        `${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), label })}\n`,
        'utf8',
      );
      return { file, handle };
    } catch (error) {
      if (error.code === 'ENOENT') return null; // .striart/ absent : striart init tranchera
      if (error.code !== 'EEXIST') throw error;

      const info = await readLockInfo(file);
      const age = await lockAgeMs(file);
      const stale =
        (info && !pidAlive(info.pid)) || // détenteur mort (crash, Ctrl+C)
        age > STALE_TTL_MS || // TTL : parade à la réutilisation de PID
        (!info && age > 10_000); // fichier illisible ET vieux : débris
      if (stale) {
        logger.warn(
          { holder: info?.label ?? 'inconnu', pid: info?.pid, ageMs: Math.round(age) },
          'Verrou orphelin détecté — cassé',
        );
        await rm(file, { force: true }).catch(() => {});
        continue; // retente le 'wx' immédiatement (course possible, le noyau arbitre)
      }

      if (Date.now() >= deadline) {
        throw new StriartError(
          `Impossible d'obtenir le verrou du repo principal : détenu par "${info?.label ?? 'inconnu'}" (pid ${info?.pid ?? '?'}) depuis ${Math.round(age / 1000)}s.`,
          {
            code: 'LOCK_TIMEOUT',
            details: { holder: info?.label, pid: info?.pid, lockFile: file },
          },
        );
      }
      await sleep(POLL_MS);
    }
  }
}

/**
 * Un merge --no-commit interrompu par un crash laisse le repo principal en
 * état de merge (MERGE_HEAD présent). Comme on vient d'obtenir le verrou,
 * aucune opération légitime n'est en cours : c'est un débris → abort.
 */
async function recoverOrphanMerge(root) {
  const mergeHead = path.join(root, '.git', 'MERGE_HEAD');
  if (await stat(mergeHead).catch(() => null)) {
    logger.warn(
      'Merge orphelin détecté dans le repo principal (crash précédent ?) — merge --abort de récupération',
    );
    await simpleGit(root)
      .raw(['merge', '--abort'])
      .catch(() => {});
  }
}

/**
 * Exécute `fn` sous le verrou global du repo principal (.striart/main.lock).
 *
 * - exclusion mutuelle ENTRE processus (watch + CLI manuelle, deux CLI...) ;
 * - réentrant DANS un processus (les opérations s'imbriquent librement) ;
 * - verrous orphelins cassés automatiquement (pid mort ou TTL dépassé) ;
 * - à l'acquisition, récupération d'un éventuel merge orphelin.
 *
 * @template T
 * @param {string} root
 * @param {string} label   Nom de l'opération, affiché à qui attend le verrou.
 * @param {() => Promise<T>} fn
 * @param {{timeoutMs?: number}} [opts]
 * @returns {Promise<T>}
 */
export async function withMainLock(root, label, fn, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  if (depth > 0) {
    depth += 1;
    try {
      return await fn();
    } finally {
      depth -= 1;
    }
  }

  const lock = await acquire(root, label, timeoutMs);
  if (lock === null) return fn(); // pas de .striart/ : l'opération lèvera NOT_INITIALIZED

  depth = 1;
  try {
    await recoverOrphanMerge(root);
    return await fn();
  } finally {
    depth = 0;
    await lock.handle.close().catch(() => {});
    await rm(lock.file, { force: true }).catch(() => {});
  }
}

import { unlink } from 'node:fs/promises';
import path from 'node:path';
import { striartDir } from './paths.js';
import { readJson, writeJsonAtomic } from './json-file.js';

/**
 * Session déclarée sur le REPO PRINCIPAL lui-même (pas un clone d'agent) :
 * un agent lancé directement dans son worktree (`runMainSession`), ou un
 * humain qui édite à la main sans committer (`striart lock start`).
 *
 * Généralise au principal ce que `sessionPid` fait déjà par agent (décision
 * architecturale n°6.4) : tant que le PID déclaré vit, `withMainLock` refuse
 * toute opération mutante (merge, sync, promote, resolve --apply, le
 * merge auto de `watch`) au lieu de laisser `recoverOrphanMerge` traiter un
 * merge/état en cours comme un débris de crash. Un PID mort ne bloque
 * rien : la garde relit le fichier à chaque appel, pas de nettoyage actif
 * requis pour se débloquer (mais `reconcile` le fait quand même, par hygiène
 * — voir orchestrator.js).
 *
 * Un seul singleton pour tout le repo (contrairement à `agents.json`, indexé
 * par agent) : le principal n'a qu'un worktree, donc au plus UNE occupation
 * directe a du sens à la fois.
 */

function mainSessionPath(root) {
  return path.join(striartDir(root), 'main-session.json');
}

/**
 * @param {string} root
 * @returns {Promise<{pid: number, reason: string, startedAt: string} | null>}
 */
export async function readMainSession(root) {
  return readJson(mainSessionPath(root), { fallback: null, code: 'MAIN_SESSION_CORRUPT' });
}

/**
 * @param {string} root @param {{pid: number|null, reason: string}} params
 * @returns {Promise<{pid: number|null, reason: string, startedAt: string}>}
 */
export async function startMainSession(root, { pid, reason }) {
  const session = { pid, reason, startedAt: new Date().toISOString() };
  await writeJsonAtomic(mainSessionPath(root), session);
  return session;
}

/** Toujours permis, y compris si le PID déclaré vit encore (c'est la sortie de secours). */
export async function stopMainSession(root) {
  await unlink(mainSessionPath(root)).catch((error) => {
    if (error.code !== 'ENOENT') throw error;
  });
}

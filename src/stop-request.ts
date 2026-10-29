/**
 * Canal d'arrêt propre, multiplateforme, des process détachés de Striart
 * (daemons `watch`/`dashboard`, hôtes de pty).
 *
 * Pourquoi un fichier et pas un signal : sous Windows, `process.kill(pid)`
 * est un TerminateProcess — ni handler, ni vidange. Un watcher arrêté en
 * plein Test Gate y mourait net, laissant le principal « merging », un
 * `main.lock` orphelin et l'arbre du gate vivant dans le worktree. Le
 * fichier de demande est lu par le process lui-même, qui s'arrête par le
 * même chemin que sur SIGTERM (vidange comprise), sur tous les OS.
 *
 * Protocole (fichier JSON écrit atomiquement) :
 *  1. le demandeur écrit `{pid, requestedAt}` ;
 *  2. le process visé (même `pid`) répond en ajoutant `ackAt`, puis s'arrête
 *     proprement ; il retire le fichier en sortant ;
 *  3. sans accusé dans le délai (process d'une version antérieure, ou
 *     bloqué), le demandeur se rabat sur le signal — décision de l'appelant.
 * Un accusé déjà présent signifie « arrêt en cours » : on ne re-signale pas
 * (un second signal forcerait la sortie en plein merge).
 */
import { readFile, rm } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { writeJsonAtomic } from './json-file.ts';
import { isProcessAlive } from './process-tree.ts';

const POLL_MS = 100;
const WATCH_INTERVAL_MS = 250;

/**
 * Lit une demande d'arrêt (null si absente, en cours de remplacement ou illisible).
 */
export async function readStopRequest(
  file: string,
): Promise<{ pid: number; requestedAt: string; ackAt?: string } | null> {
  try {
    const raw = JSON.parse(await readFile(file, 'utf8'));
    return Number.isInteger(raw?.pid) ? raw : null;
  } catch {
    // Absent, en cours de remplacement ou illisible : pas de demande lisible.
    return null;
  }
}

/** Retire la demande — seulement si elle vise `pid` quand il est donné. */
export async function clearStopRequest(file: string, pid: number | null = null): Promise<void> {
  const request = await readStopRequest(file);
  if (pid !== null && request && request.pid !== pid) return;
  await rm(file, { force: true });
}

/**
 * Côté process visé : surveille la demande d'arrêt qui le désigne. `onStop`
 * est appelé une fois, APRÈS que l'accusé a été écrit — sinon le demandeur,
 * ne le voyant pas, se rabattrait sur le signal en pleine vidange.
 * Rend la fonction qui arrête la surveillance.
 */
export function watchStopRequest(
  file: string,
  {
    onStop,
    pid = process.pid,
    intervalMs = WATCH_INTERVAL_MS,
  }: { onStop: () => void; pid?: number; intervalMs?: number },
): () => void {
  let done = false;
  let busy = false;
  const timer = setInterval(async () => {
    if (done || busy) return;
    busy = true;
    try {
      const request = await readStopRequest(file);
      if (request?.pid !== pid || request.ackAt) return;
      await writeJsonAtomic(file, { ...request, ackAt: new Date().toISOString() });
      done = true;
      clearInterval(timer);
      onStop();
    } catch {
      // Écriture de l'accusé refusée (fichier tenu par un lecteur sous
      // Windows) : nouvel essai au tour suivant, l'arrêt n'est pas perdu.
    } finally {
      busy = false;
    }
  }, intervalMs);
  timer.unref();
  return () => {
    done = true;
    clearInterval(timer);
  };
}

/**
 * Côté demandeur : demande l'arrêt de `pid` puis attend sa sortie.
 * Paramètres :
 *   `fallback` : appelé si aucun accusé n'arrive (signal classique) ; peut lever.
 *   `confirmIdentity` : relit l'identité du process JUSTE avant le repli (sans
 *   cache) ; faux = le PID n'est plus l'instance publiée (mort, recyclé, ou
 *   illisible) → aucun signal n'est envoyé (S-M2 : le délai d'accusé est une
 *   fenêtre pendant laquelle le numéro peut changer de propriétaire).
 */
export async function requestStop({
  file,
  pid,
  ackWaitMs,
  waitMs,
  fallback,
  confirmIdentity,
}: {
  file: string;
  pid: number;
  ackWaitMs: number;
  waitMs: number;
  fallback: () => unknown;
  confirmIdentity?: () => Promise<boolean>;
}): Promise<'exited' | 'stopping'> {
  const existing = await readStopRequest(file);
  const acknowledged = existing?.pid === pid && Boolean(existing.ackAt);
  if (!acknowledged) {
    if (existing?.pid !== pid)
      await writeJsonAtomic(file, { pid, requestedAt: new Date().toISOString() });
    const ackDeadline = Date.now() + ackWaitMs;
    let acked = false;
    while (Date.now() < ackDeadline && isProcessAlive(pid)) {
      const request = await readStopRequest(file);
      if (request?.pid === pid && request.ackAt) {
        acked = true;
        break;
      }
      await sleep(POLL_MS);
    }
    if (!acked && isProcessAlive(pid)) {
      if (confirmIdentity && !(await confirmIdentity())) {
        // Plus l'instance publiée : jamais de signal à un PID non identifié.
        return isProcessAlive(pid) ? 'stopping' : 'exited';
      }
      await fallback();
    }
  }
  const deadline = Date.now() + waitMs;
  while (isProcessAlive(pid) && Date.now() < deadline) await sleep(POLL_MS);
  return isProcessAlive(pid) ? 'stopping' : 'exited';
}

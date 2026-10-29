/**
 * FERMETURE PROPRE d'une session inactive — la seule exception à l'invariant
 * « un clone dont la session vit est intouchable », et seulement pour LA
 * SESSION : jamais rebase, merge, retrait du registre ni suppression. Le clone
 * et son travail non commité restent exactement où ils sont.
 *
 * Voies, selon qui porte la session (jamais un kill à l'aveugle) :
 *  - ACP     : `stopAcpHost` — demande d'arrêt lue par l'hôte (session/cancel,
 *              arrêt de l'agent), repli sur le kill d'arbre SEULEMENT si l'hôte
 *              est identifié (ligne de commande + heure de création) ;
 *  - terminal: `stopPtyHost`, même protocole, seulement si la sortie du pty est observée (`host.output`) ou sous `idle.closePty` ;
 *  - process : session autonome en mode argv. Le process qui la SUPERVISE
 *              (`sessionOwnerPid`) reçoit une demande d'arrêt sur disque
 *              (stop-request.ts), l'accuse puis annule SA session par son chemin
 *              normal (CANCELLED, clone conservé) — il tient le handle du
 *              sous-process, aucun PID n'est deviné. Sans superviseur vivant
 *              (agent orphelin), l'agent est arrêté en douceur (SIGTERM, POSIX)
 *              puis par kill d'arbre, après vérification de son identité par
 *              l'heure de création. Superviseur vivant mais muet : AUCUN kill
 *              (`IDLE_CLOSE_NOT_ACKNOWLEDGED`).
 *
 * Toute issue négative est un CODE du rapport (jamais une exception qui
 * interromprait le balayage) ; la session reste alors vivante, intacte.
 */
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { acpHostStatus, stopAcpHost } from '../acp/host.ts';
import { logger } from '../logger.ts';
import { readMainSessionStatus } from '../main-session.ts';
import { readProcessInfos } from '../process-info.ts';
import type { ProcessInfo } from '../process-info.ts';
import { isProcessAlive, killProcessTree } from '../process-tree.ts';
import { ptyHostStatus } from '../pty-host-state.ts';
import { stopPtyHost } from '../pty-host.ts';
import { readStopRequest, requestStop } from '../stop-request.ts';
import type { AgentMeta } from '../types.js';
import type { HostKind } from './classify.ts';
import { closeRequestPath } from './paths.ts';

/**
 * Issue d'une tentative de fermeture :
 *  - CLOSED  : la session est sortie ; CLOSING : arrêt accusé, sortie en cours ;
 *  - REFUSED : une garde a dit non (la session est intacte) — `code` IDLE_CLOSE_* ;
 *  - FAILED  : l'arrêt a échoué (`IDLE_CLOSE_FAILED`), la session peut vivre encore.
 */
export type CloseStatus = 'CLOSED' | 'CLOSING' | 'REFUSED' | 'FAILED';

export interface CloseOutcome {
  status: CloseStatus;
  /** Code d'erreur classé (ERROR_KINDS) pour REFUSED / FAILED, null sinon. */
  code:
    | 'IDLE_CLOSE_BLOCKED'
    | 'IDLE_CLOSE_UNVERIFIED'
    | 'IDLE_CLOSE_NOT_ACKNOWLEDGED'
    | 'IDLE_CLOSE_FAILED'
    | null;
  host: HostKind;
  /** Motif stable, jamais un message système. */
  detail: string | null;
}

export interface CloseTimings {
  /** Attente de l'accusé du superviseur d'une session argv. */
  ackWaitMs: number;
  /** Attente de la sortie après l'accusé. */
  exitWaitMs: number;
  /** Délai entre SIGTERM et le kill d'arbre d'un agent orphelin (POSIX). */
  termGraceMs: number;
}

export const DEFAULT_CLOSE_TIMINGS: Readonly<CloseTimings> = Object.freeze({
  ackWaitMs: 5_000,
  exitWaitMs: 15_000,
  termGraceMs: 5_000,
});

/** Fenêtre dans laquelle un agent lancé par `onSpawn` est créé par rapport à sa publication. */
const ORPHAN_START_BEFORE_MS = 120_000;
const ORPHAN_START_AFTER_MS = 5_000;

/**
 * Le process `info` est-il l'agent publié à `publishedAt` (ms) ? Un agent est
 * créé juste AVANT que son PID soit publié : un process créé après (repreneur
 * du numéro) ou longtemps avant (autre chose, p. ex. un superviseur) n'est pas
 * lui. Heure de création illisible : non vérifiable. Pur, testable.
 */
export function judgeOrphanAgent(
  info: Pick<ProcessInfo, 'startTimeMs'> | undefined,
  publishedAt: number | null,
): 'alive' | 'foreign' | 'unverified' {
  if (!info || info.startTimeMs === null || publishedAt === null) return 'unverified';
  if (info.startTimeMs > publishedAt + ORPHAN_START_AFTER_MS) return 'foreign';
  if (info.startTimeMs < publishedAt - ORPHAN_START_BEFORE_MS) return 'foreign';
  return 'alive';
}

async function waitGone(pid: number, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (isProcessAlive(pid)) {
    if (Date.now() >= deadline) return false;
    await sleep(100);
  }
  return true;
}

/** Garde finale, relue JUSTE avant d'agir : la session du principal n'est jamais fermée. */
async function touchesMainSession(root: string, pids: Array<number | null | undefined>) {
  const main = await readMainSessionStatus(root).catch(() => ({ alive: true, pid: -1 }));
  if (!main) return false;
  // Illisible (catch ci-dessus) : présumée concernée, fail closed.
  return main.pid === -1 || (main.alive && pids.includes(main.pid));
}

export async function closeSession(
  root: string,
  name: string,
  meta: AgentMeta,
  expected: { host: HostKind; pid: number | null },
  timings: CloseTimings = DEFAULT_CLOSE_TIMINGS,
): Promise<CloseOutcome> {
  const host = expected.host;

  if (await touchesMainSession(root, [expected.pid, meta.sessionPid, meta.sessionOwnerPid])) {
    return { status: 'REFUSED', code: 'IDLE_CLOSE_BLOCKED', host: host, detail: 'MAIN_SESSION' };
  }

  try {
    if (host === 'acp') {
      const status = await acpHostStatus(root, name, { fresh: true });
      if (!status.running || status.pid !== expected.pid)
        return {
          status: 'REFUSED',
          code: 'IDLE_CLOSE_BLOCKED',
          host: host,
          detail: 'SESSION_CHANGED',
        };
      const result = await stopAcpHost(root, name);
      if (result.untouched)
        return {
          status: 'REFUSED',
          code: 'IDLE_CLOSE_UNVERIFIED',
          host: host,
          detail: result.untouched,
        };
      if (result.stopping) return { status: 'CLOSING', code: null, host: host, detail: null };
      return result.stopped || result.wasStale
        ? { status: 'CLOSED', code: null, host: host, detail: null }
        : { status: 'FAILED', code: 'IDLE_CLOSE_FAILED', host: host, detail: 'NOT_STOPPED' };
    }

    if (host === 'pty') {
      const status = await ptyHostStatus(root, name, { fresh: true });
      if (!status.running || status.pid !== expected.pid)
        return {
          status: 'REFUSED',
          code: 'IDLE_CLOSE_BLOCKED',
          host: host,
          detail: 'SESSION_CHANGED',
        };
      const result = await stopPtyHost(root, name);
      if (result.untouched)
        return {
          status: 'REFUSED',
          code: 'IDLE_CLOSE_UNVERIFIED',
          host: host,
          detail: result.untouched,
        };
      if (result.stopping) return { status: 'CLOSING', code: null, host: host, detail: null };
      return result.stopped || result.wasStale
        ? { status: 'CLOSED', code: null, host: host, detail: null }
        : { status: 'FAILED', code: 'IDLE_CLOSE_FAILED', host: host, detail: 'NOT_STOPPED' };
    }

    if (host === 'process')
      return await closeProcessSession(root, name, meta, expected.pid, timings);

    return { status: 'REFUSED', code: 'IDLE_CLOSE_BLOCKED', host: host, detail: 'NO_LIVE_SESSION' };
  } catch (error) {
    logger.warn(
      { agent: name, host, code: (error as { code?: string }).code },
      'Fermeture de session inactive en échec',
    );
    return {
      status: 'FAILED',
      code: 'IDLE_CLOSE_FAILED',
      host,
      detail: (error as { code?: string }).code ?? 'ERROR',
    };
  }
}

async function closeProcessSession(
  root: string,
  name: string,
  meta: AgentMeta,
  expectedPid: number | null,
  timings: CloseTimings,
): Promise<CloseOutcome> {
  const agentPid = meta.sessionPid ?? null;
  if (agentPid === null || agentPid !== expectedPid || !isProcessAlive(agentPid))
    return {
      status: 'REFUSED',
      code: 'IDLE_CLOSE_BLOCKED',
      host: 'process',
      detail: 'SESSION_CHANGED',
    };
  // Jamais soi-même, jamais son parent : le GC tourne souvent dans `striart watch`.
  if (agentPid === process.pid || agentPid === process.ppid)
    return { status: 'REFUSED', code: 'IDLE_CLOSE_BLOCKED', host: 'process', detail: 'SELF' };

  const ownerPid = meta.sessionOwnerPid ?? null;

  // Cas 1 — superviseur vivant et distinct de l'agent : demande d'arrêt propre.
  if (ownerPid !== null && ownerPid !== agentPid && isProcessAlive(ownerPid)) {
    const file = closeRequestPath(root, name);
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    const outcome = await requestStop({
      file,
      pid: agentPid,
      ackWaitMs: timings.ackWaitMs,
      waitMs: timings.exitWaitMs,
      // Le superviseur vit : c'est LUI qui arrête sa session. Aucun kill extérieur.
      confirmIdentity: async () => false,
      fallback: () => undefined,
    });
    const acked = Boolean((await readStopRequest(file))?.ackAt);
    if (outcome === 'exited')
      return { status: 'CLOSED', code: null, host: 'process', detail: null };
    return acked
      ? { status: 'CLOSING', code: null, host: 'process', detail: null }
      : { status: 'REFUSED', code: 'IDLE_CLOSE_NOT_ACKNOWLEDGED', host: 'process', detail: null };
  }

  // Cas 2 — pas de superviseur connu : on ne peut pas prouver que ce PID est un agent.
  if (ownerPid === null || ownerPid === agentPid)
    return {
      status: 'REFUSED',
      code: 'IDLE_CLOSE_UNVERIFIED',
      host: 'process',
      detail: 'NO_SUPERVISOR_RECORD',
    };

  // Cas 3 — agent ORPHELIN (son superviseur est mort) : arrêt doux puis kill d'arbre vérifié.
  const published = meta.sessionStartedAt ? Date.parse(meta.sessionStartedAt) : null;
  const verdictOf = async () =>
    judgeOrphanAgent((await readProcessInfos([agentPid])).get(agentPid), published);
  if ((await verdictOf()) !== 'alive')
    return {
      status: 'REFUSED',
      code: 'IDLE_CLOSE_UNVERIFIED',
      host: 'process',
      detail: 'IDENTITY',
    };

  if (process.platform !== 'win32') {
    try {
      process.kill(agentPid, 'SIGTERM');
    } catch (error) {
      if ((error as { code?: string }).code === 'EPERM')
        return {
          status: 'REFUSED',
          code: 'IDLE_CLOSE_UNVERIFIED',
          host: 'process',
          detail: 'DENIED',
        };
    }
    if (await waitGone(agentPid, timings.termGraceMs))
      return { status: 'CLOSED', code: null, host: 'process', detail: null };
  }
  // Identité relue juste avant le kill (le numéro a pu changer de propriétaire entre-temps).
  const startTimeMs = (await readProcessInfos([agentPid])).get(agentPid)?.startTimeMs ?? null;
  if ((await verdictOf()) !== 'alive' || startTimeMs === null) {
    return isProcessAlive(agentPid)
      ? { status: 'REFUSED', code: 'IDLE_CLOSE_UNVERIFIED', host: 'process', detail: 'IDENTITY' }
      : { status: 'CLOSED', code: null, host: 'process', detail: null };
  }
  await killProcessTree(
    { pid: agentPid, kill: (signal?: NodeJS.Signals) => process.kill(agentPid, signal) },
    { rootStartedMs: startTimeMs },
  );
  return (await waitGone(agentPid, timings.exitWaitMs))
    ? { status: 'CLOSED', code: null, host: 'process', detail: null }
    : { status: 'FAILED', code: 'IDLE_CLOSE_FAILED', host: 'process', detail: 'STILL_ALIVE' };
}

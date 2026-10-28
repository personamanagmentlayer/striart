/**
 * Collecte des SIGNAUX d'activité et des GARDE-FOUS d'un agent, depuis le
 * disque et l'état de Striart. Lecture seule, aucun verrou : un instantané.
 *
 * Signaux (voir classify.ts pour leur composition) :
 *  - sessionStart  : création du clone, début de la dernière session, démarrage
 *                    de l'hôte (ACP, terminal) — une session qui vient de naître
 *                    n'est pas inactive ;
 *  - sessionOutput : dernière sortie de l'agent. Session autonome argv : battement
 *                    (heartbeat.ts) ; session ACP : journal de session au fil de
 *                    l'eau ; terminal : dernière sortie PUBLIÉE par l'hôte natif
 *                    (`host.output`, liée à son PID) ; à défaut (hôte antérieur,
 *                    programme silencieux, fichier invalide) journal de l'hôte s'il
 *                    existe, sinon inobservable — et la sortie reste alors NON observée
 *                    (fermeture refusée sans `idle.closePty`) ;
 *  - worktree      : écriture exacte du worktree (`cloneWorktreeActivity`) ;
 *  - refs          : reflog de HEAD et références de branches du clone ;
 *  - messages      : boîtes de collaboration du clone.
 *
 * Les signaux sont lus du moins cher au plus cher ; dès qu'un signal frais
 * (< `freshWithinMs`) est connu, le parcours du worktree est SAUTÉ — l'agent est
 * actif quoi qu'il dise. Toute lecture qui échoue autrement que par « absent »
 * donne `unknown` (fail closed).
 *
 * Garde-fous : demande humaine en attente, ticket ouvert, plan d'orchestration
 * ou collaboration, merge/stop/sync en cours sur l'agent, session du repo
 * principal, suppression en cours, exclusion de la config.
 */
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { acpHostStatus } from '../acp/host.ts';
import { INBOX_FILE, OUTBOX_FILE } from '../collab/files.ts';
import { cloneWorktreeActivity } from '../clone.js';
import { listConflictTickets } from '../conflicts.js';
import { readMainLockStatus } from '../lock.js';
import { readMainSessionStatus } from '../main-session.js';
import { listOrchestrationState } from '../orchestration/store.ts';
import { permissionsDir } from '../permissions.ts';
import { isProcessAlive } from '../process-tree.js';
import { ptyHostStatus, readPtyHostLastOutput } from '../pty-host-state.ts';
import { sessionLogPath } from '../session.js';
import type { AgentMeta } from '../types.js';
import { striartDir } from '../paths.js';
import type { BlockerCode, HostKind, SessionKind, SignalReading } from './classify.ts';
import { isAgentExcluded } from './settings.ts';
import type { IdleSettings } from './settings.ts';
import { outputBeatPath } from './paths.ts';

/** Contexte partagé par tous les agents d'un balayage (lu UNE fois). */
export interface SweepContext {
  root: string;
  settings: IdleSettings;
  /** Agents ayant une demande humaine (permission, question) en attente. */
  humanRequests: Set<string>;
  /** Agents ayant un ticket de conflit ouvert. */
  tickets: Set<string>;
  /** Agents portés par un plan / un groupe d'orchestration vivant. */
  orchestrated: Set<string>;
  /** Libellé du détenteur du verrou principal (`merge:agent-a`), null si libre. */
  lockHolder: string | null;
  lockAgent: string | null;
  /** PID de la session déclarée sur le repo principal, si elle vit. */
  mainSessionPid: number | null;
  /**
   * Sources de contexte ILLISIBLES : tant qu'il en reste, AUCUNE fermeture n'est
   * permise (un garde-fou qu'on n'a pas pu lire est supposé armé).
   */
  holds: string[];
}

const isMissing = (error: unknown): boolean => (error as { code?: string })?.code === 'ENOENT';

async function listPendingAgents(root: string, holds: string[]): Promise<{ pending: Set<string> }> {
  const pending = new Set<string>();
  const dir = permissionsDir(root);
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (error) {
    if (!isMissing(error)) holds.push('HUMAN_REQUESTS_UNREADABLE');
    return { pending };
  }
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    try {
      const request = JSON.parse(await readFile(path.join(dir, name), 'utf8'));
      if (request?.status === 'PENDING') {
        if (typeof request.agent === 'string') pending.add(request.agent);
        else holds.push('HUMAN_REQUESTS_UNREADABLE');
      }
    } catch {
      // Une demande qu'on ne sait pas lire est peut-être en attente : aucune fermeture.
      if (!holds.includes('HUMAN_REQUESTS_UNREADABLE')) holds.push('HUMAN_REQUESTS_UNREADABLE');
    }
  }
  return { pending };
}

/** `merge:agent-a`, `stop:agent-a`, `sync:agent-a`, `start:agent-a`, `reuse:agent-a` → `agent-a`. */
const LOCK_AGENT_RE = /^(?:merge|stop|sync|start|reuse):([A-Za-z0-9][A-Za-z0-9_-]{0,63})$/;

export async function loadSweepContext(
  root: string,
  settings: IdleSettings,
): Promise<SweepContext> {
  const holds: string[] = [];
  const ctx: SweepContext = {
    root,
    settings,
    humanRequests: new Set(),
    tickets: new Set(),
    orchestrated: new Set(),
    lockHolder: null,
    lockAgent: null,
    mainSessionPid: null,
    holds,
  };

  ctx.humanRequests = (await listPendingAgents(root, holds)).pending;

  try {
    for (const ticket of await listConflictTickets(root)) {
      if ('agent' in ticket && typeof ticket.agent === 'string') ctx.tickets.add(ticket.agent);
    }
  } catch {
    holds.push('TICKETS_UNREADABLE');
  }

  try {
    const state = await listOrchestrationState(root);
    for (const group of state.groups) {
      if (group.status === 'running' && group.alive)
        for (const a of group.agents) ctx.orchestrated.add(a);
    }
    for (const run of state.runs) {
      if (run.status !== 'running' || !run.alive) continue;
      for (const node of run.nodes) {
        if (node.agent && node.state !== 'done' && node.state !== 'skipped')
          ctx.orchestrated.add(node.agent);
      }
    }
  } catch {
    holds.push('ORCHESTRATION_UNREADABLE');
  }

  try {
    const lock = await readMainLockStatus(root);
    if (lock.state !== 'free') {
      ctx.lockHolder = lock.holder ?? lock.state;
      ctx.lockAgent = lock.holder ? (LOCK_AGENT_RE.exec(lock.holder)?.[1] ?? null) : null;
      if (lock.state === 'unreadable' || lock.state === 'invalid') holds.push('LOCK_UNREADABLE');
    }
    if (lock.recoveryBlocked) {
      holds.push('MERGE_STATE_UNRESOLVED');
      if (lock.recoveryBlocked.agent) ctx.lockAgent = lock.recoveryBlocked.agent;
    }
  } catch {
    holds.push('LOCK_UNREADABLE');
  }

  try {
    const main = await readMainSessionStatus(root);
    if (main?.alive) ctx.mainSessionPid = main.pid;
  } catch {
    holds.push('MAIN_SESSION_UNREADABLE');
  }

  return ctx;
}

async function mtimeReading(
  name: SignalReading['name'],
  file: string,
  whenMissing: 'absent' | 'unknown',
): Promise<SignalReading> {
  try {
    return { name, status: 'known', at: (await stat(file)).mtimeMs };
  } catch (error) {
    return { name, status: isMissing(error) ? whenMissing : 'unknown', at: null };
  }
}

async function newestUnder(dir: string): Promise<{ at: number; ok: boolean }> {
  let at = 0;
  let ok = true;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    return { at, ok: isMissing(error) };
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const sub = await newestUnder(full);
      at = Math.max(at, sub.at);
      ok &&= sub.ok;
      continue;
    }
    try {
      at = Math.max(at, (await stat(full)).mtimeMs);
    } catch (error) {
      if (!isMissing(error)) ok = false;
    }
  }
  return { at, ok };
}

/** Commits, checkouts, rebases du clone : reflog de HEAD et références de branches. */
async function refsReading(clonePath: string): Promise<SignalReading> {
  const gitDir = path.join(clonePath, '.git');
  const head = await mtimeReading('refs', path.join(gitDir, 'logs', 'HEAD'), 'absent');
  const heads = await newestUnder(path.join(gitDir, 'refs', 'heads'));
  if (head.status === 'unknown' || !heads.ok) return { name: 'refs', status: 'unknown', at: null };
  const at = Math.max(head.at ?? 0, heads.at);
  return at > 0
    ? { name: 'refs', status: 'known', at }
    : { name: 'refs', status: 'absent', at: null };
}

async function messagesReading(clonePath: string): Promise<SignalReading> {
  const files = await Promise.all(
    [INBOX_FILE, OUTBOX_FILE].map((f) =>
      mtimeReading('messages', path.join(clonePath, f), 'absent'),
    ),
  );
  if (files.some((f) => f.status === 'unknown'))
    return { name: 'messages', status: 'unknown', at: null };
  const times = files.map((f) => f.at).filter((t): t is number => t !== null);
  return times.length > 0
    ? { name: 'messages', status: 'known', at: Math.max(...times) }
    : { name: 'messages', status: 'absent', at: null };
}

export interface AgentFacts {
  name: string;
  profile: string | null;
  kind: SessionKind;
  host: HostKind;
  /** PID du process qui porte la session vivante (hôte ACP, hôte de terminal, agent argv). */
  sessionPid: number | null;
  readings: SignalReading[];
  blockers: BlockerCode[];
  /** Le parcours du worktree a été sauté parce qu'un signal frais suffisait. */
  worktreeSkipped: boolean;
  /** Terminal : la dernière sortie du pty a été lue dans `host.output` (hôte natif qui la publie). */
  ptyOutputObserved: boolean;
}

interface SessionIdentity {
  kind: SessionKind;
  host: HostKind;
  pid: number | null;
  startedAt: number | null;
}

async function identifySession(
  root: string,
  name: string,
  meta: AgentMeta,
): Promise<SessionIdentity> {
  const acp = await acpHostStatus(root, name).catch(() => null);
  if (acp?.running) {
    return {
      kind: 'live',
      host: 'acp',
      pid: acp.pid,
      startedAt: acp.startedAt ? Date.parse(acp.startedAt) : null,
    };
  }
  const pty = await ptyHostStatus(root, name).catch(() => null);
  // Hôte de terminal illisible (autre utilisateur) : compté vivant par ptyHostStatus lui-même.
  if (pty?.running) {
    return {
      kind: 'live',
      host: 'pty',
      pid: pty.pid,
      startedAt: pty.startedAt ? Date.parse(pty.startedAt) : null,
    };
  }
  if (isProcessAlive(meta.sessionPid)) {
    return {
      kind: 'live',
      host: 'process',
      pid: meta.sessionPid ?? null,
      startedAt: meta.sessionStartedAt ? Date.parse(meta.sessionStartedAt) : null,
    };
  }
  const everHadSession = Boolean(meta.sessionStartedAt) || meta.sessionPid != null;
  return { kind: everHadSession ? 'ended' : 'none', host: 'none', pid: null, startedAt: null };
}

/** `complete` faux : une partie du worktree est illisible → signal INCONNU (fail closed). */
function worktreeReading(activityMs: number, complete: boolean): SignalReading {
  if (!complete) return { name: 'worktree', status: 'unknown', at: null };
  return activityMs > 0
    ? { name: 'worktree', status: 'known', at: activityMs }
    : { name: 'worktree', status: 'absent', at: null };
}

function finite(ms: number | null | undefined): number | null {
  return typeof ms === 'number' && Number.isFinite(ms) ? ms : null;
}

/**
 * Faits d'un agent : session, signaux, garde-fous. `worktreeMs` : activité du
 * worktree DÉJÀ mesurée par l'appelant (`listAgents`) — évite un second parcours.
 */
export async function collectAgentFacts(
  ctx: SweepContext,
  name: string,
  meta: AgentMeta,
  { worktreeMs, now }: { worktreeMs?: number | null; now: number },
): Promise<AgentFacts> {
  const { root, settings } = ctx;
  const session = await identifySession(root, name, meta);

  const blockers: BlockerCode[] = [];
  if (
    isAgentExcluded(settings, name) ||
    (meta.profile && settings.excludeProfiles.includes(meta.profile))
  )
    blockers.push('EXCLUDED');
  if (ctx.humanRequests.has(name)) blockers.push('HUMAN_REQUEST');
  if (ctx.tickets.has(name)) blockers.push('OPEN_TICKET');
  if (ctx.orchestrated.has(name) || meta.collab) blockers.push('ORCHESTRATED');
  if (ctx.lockAgent === name) blockers.push('MERGE_IN_PROGRESS');
  if (meta.removing) blockers.push('REMOVING');
  if (
    ctx.mainSessionPid !== null &&
    [session.pid, meta.sessionPid, meta.sessionOwnerPid].includes(ctx.mainSessionPid)
  )
    blockers.push('MAIN_SESSION');

  const readings: SignalReading[] = [];

  // sessionStart : le plus récent de la création du clone et du début de la session.
  const starts = [
    finite(Date.parse(meta.createdAt)),
    finite(meta.sessionStartedAt ? Date.parse(meta.sessionStartedAt) : null),
    finite(session.startedAt),
  ].filter((t): t is number => t !== null);
  readings.push(
    starts.length > 0
      ? { name: 'sessionStart', status: 'known', at: Math.max(...starts) }
      : { name: 'sessionStart', status: 'unknown', at: null },
  );

  // sessionOutput.
  let ptyOutputObserved = false;
  if (session.kind === 'live') {
    if (session.host === 'process') {
      readings.push(await mtimeReading('sessionOutput', outputBeatPath(root, name), 'unknown'));
    } else if (session.host === 'acp') {
      readings.push(
        await mtimeReading('sessionOutput', sessionLogPath(root, name, meta.taskId), 'unknown'),
      );
    } else {
      // Terminal : la sortie vient de l'hôte natif lui-même (`host.output`, liée à son PID). Sinon
      // (hôte d'une version antérieure, programme encore silencieux, fichier invalide) : retour
      // à l'ancien signal — le journal de l'hôte s'il existe — et la sortie reste INOBSERVÉE.
      const lastOutput =
        session.pid !== null ? await readPtyHostLastOutput(root, name, session.pid) : null;
      if (lastOutput !== null) {
        ptyOutputObserved = true;
        readings.push({ name: 'sessionOutput', status: 'known', at: lastOutput });
      } else {
        const ptyLog = await mtimeReading(
          'sessionOutput',
          path.join(striartDir(root), 'logs', `pty-${name}.log`),
          'absent',
        );
        readings.push(
          ptyLog.status === 'absent'
            ? { name: 'sessionOutput', status: 'unobservable', at: null }
            : ptyLog,
        );
      }
    }
  }

  readings.push(await messagesReading(meta.path));
  readings.push(await refsReading(meta.path));

  const freshWithin = settings.warnAfterMs;
  const fresh = readings.some(
    (r) => r.status === 'known' && r.at !== null && now - r.at < freshWithin,
  );
  const unknown = readings.some((r) => r.status === 'unknown');

  let worktreeSkipped = false;
  if (worktreeMs !== undefined && worktreeMs !== null) {
    readings.push(worktreeReading(worktreeMs, true));
  } else if (fresh || unknown) {
    // Un signal frais (ou un signal inconnu, qui rend déjà l'agent actif) décide :
    // le parcours exact du worktree serait du travail inutile.
    worktreeSkipped = true;
  } else {
    try {
      const scan = await cloneWorktreeActivity(meta.path);
      readings.push(worktreeReading(scan.workActivityMs, scan.complete));
    } catch {
      readings.push(worktreeReading(0, false));
    }
  }

  return {
    name,
    profile: meta.profile ?? null,
    kind: session.kind,
    host: session.host,
    sessionPid: session.pid,
    readings,
    blockers,
    worktreeSkipped,
    ptyOutputObserved,
  };
}

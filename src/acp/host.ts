import { spawn } from 'node:child_process';
import { openSync, closeSync } from 'node:fs';
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { StriartError } from '../errors.js';
import { writeJsonAtomic } from '../json-file.js';
import { checkProcessInstance, readProcessInfos } from '../process-info.ts';
import { isProcessAlive, killProcessTree } from '../process-tree.js';
import { clearStopRequest, requestStop } from '../stop-request.ts';
import { validateAgentName } from '../agent-name.ts';
import { sessionLogPath } from '../session.js';
import {
  HOST_PROTOCOL_VERSION,
  acpBusTokenPath,
  acpHostDir,
  acpHostLogPath,
  acpHostPidFilePath,
  acpHostReadyFilePath,
  acpHostSocketPath,
  assertSocketDirPrivate,
  acpHostStopFilePath,
  newToken,
  readFrames,
  writeFrame,
} from './host-ipc.ts';
import type { AcpOptions, McpServerSpec, TextContentBlock } from './protocol.ts';
import type { AgentProfile, SessionResult } from '../types.js';

/**
 * Cycle de vie de l'HÔTE DE SESSION ACP PERSISTANT d'un agent — même patron
 * que l'hôte de pty (`pty-host.ts`, Phase C) : process détaché, PID file
 * atomique, identité vérifiée à la ligne de commande (`checkProcessInstance`,
 * jamais un PID recyclé cru vivant ni tué), arrêt propre par demande sur
 * disque (`src/stop-request.js`), canal local (`host-ipc.ts`).
 *
 * Pourquoi un process détaché : la session ACP d'une tâche autonome vivait
 * dans le process CLI éphémère qui la lançait — inadressable depuis
 * `watch --ui`. Portée par l'hôte, elle devient joignable (Phase E du bus
 * `@agent`) et survit au besoin entre plusieurs prompts (socle du proxy ACP,
 * lot I10). Son PID est celui que l'appelant publie au registre
 * (`sessionPid`) : la garde SESSION_LIVE couvre l'hôte, qui ne sort
 * qu'après la mort de l'agent.
 *
 * API interne (consommateurs : `runAcpSession`, `watch --ui`, futur proxy) :
 *  - `launchAcpHost(root, spec)`      → démarre l'hôte (refus ACP_HOST_BUSY) ;
 *  - `connectAcpHostOwner(...)`        → canal propriétaire : résultat, annulation ;
 *  - `sendHumanPrompt(root, agent, t)` → prompt humain du bus ;
 *  - `acpHostStatus` / `stopAcpHost`   → état, arrêt propre.
 */

/** Spécification transmise à l'hôte par son stdin (jamais en argv : `profile.env` porte des clés). */
export interface AcpHostRunSpec {
  root: string;
  agent: string;
  taskId: string;
  cwd: string;
  profile: AgentProfile;
  profileKey: string;
  options: AcpOptions;
  initialPrompt: TextContentBlock[];
  timeoutMs: number;
  closeWhenIdle: boolean;
  ownerPid: number;
  ownerToken: string;
  busToken: string;
  mcpServers: McpServerSpec[];
  logPath: string;
}

export interface LaunchAcpHostSpec {
  agent: string;
  taskId: string;
  cwd: string;
  profile: AgentProfile;
  profileKey?: string;
  options: AcpOptions;
  initialPrompt: TextContentBlock[];
  timeoutMs: number;
  /** true : la session se ferme quand la file est vide (tâche autonome). */
  closeWhenIdle: boolean;
  /** Process superviseur ; sa mort annule la session (fail closed). */
  ownerPid: number;
  mcpServers: McpServerSpec[];
  /** Environnement de base de l'agent (défaut : celui du process). */
  env?: NodeJS.ProcessEnv;
}

export interface AcpHostStatus {
  running: boolean;
  stale: boolean;
  /** Vivant ET reconnu : seul cas où l'hôte peut être arrêté. */
  verified: boolean;
  /** Canal ouvert (l'hôte a publié `host.ready`). */
  listening: boolean;
  pid: number | null;
  startedAt: string | null;
}

/** Délai d'attente du canal de l'hôte après son lancement. */
const CONNECT_TIMEOUT_MS = 15_000;
const CONNECT_RETRY_MS = 100;
const BUS_REPLY_TIMEOUT_MS = 5_000;
const HOST_STOP_ACK_WAIT_MS = 3_000;
/** L'hôte annule la session (grâce d'annulation de l'agent comprise) avant de sortir. */
const HOST_STOP_WAIT_MS = 10_000;
/** Après le résultat, l'hôte ne fait que fermer son canal et retirer ses fichiers. */
const HOST_EXIT_WAIT_MS = 5_000;

const TASK_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function entryPath(): string {
  // Fichier .js : chemin stable, non réécrit par le pack (jamais un .ts construit à l'exécution).
  return fileURLToPath(new URL('./host-entry.js', import.meta.url));
}

interface PidFileContent {
  pid: number;
  startedAt: string;
}

async function readJsonFile<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as T;
  } catch {
    return null;
  }
}

/**
 * État de l'hôte. Un PID file dont le process est mort — ou dont le numéro a
 * été recyclé — est `stale`, jamais nettoyé ici. Identité illisible (autre
 * utilisateur) : comptée vivante, fail closed. `fresh` : identité relue sans
 * cache — obligatoire avant d'arrêter l'hôte ou de décider d'en lancer un.
 */
export async function acpHostStatus(
  root: string,
  agent: string,
  { fresh = false }: { fresh?: boolean } = {},
): Promise<AcpHostStatus> {
  const info = await readJsonFile<PidFileContent>(acpHostPidFilePath(root, agent));
  if (!info || !Number.isInteger(info.pid)) {
    return {
      running: false,
      stale: false,
      verified: false,
      listening: false,
      pid: null,
      startedAt: null,
    };
  }
  const verdict = await checkProcessInstance(
    info.pid,
    { scriptName: 'host-entry.js', args: ['acp-host', agent], startedAt: info.startedAt },
    { cache: !fresh },
  );
  const alive = verdict === 'alive' || verdict === 'unverified';
  const ready = alive
    ? await readJsonFile<{ pid?: number }>(acpHostReadyFilePath(root, agent))
    : null;
  return {
    running: alive,
    stale: !alive,
    verified: verdict === 'alive',
    listening: alive && ready?.pid === info.pid,
    pid: info.pid,
    startedAt: info.startedAt,
  };
}

async function releaseHostFiles(root: string, agent: string): Promise<void> {
  await rm(acpHostPidFilePath(root, agent), { force: true });
  await rm(acpHostReadyFilePath(root, agent), { force: true });
  await rm(acpBusTokenPath(root, agent), { force: true });
  await clearStopRequest(acpHostStopFilePath(root, agent));
  if (process.platform !== 'win32') await rm(acpHostSocketPath(root, agent), { force: true });
}

/** Écrit le jeton du bus, lisible par le seul propriétaire du compte (POSIX). */
async function writeBusToken(root: string, agent: string, token: string): Promise<void> {
  const file = acpBusTokenPath(root, agent);
  const tmp = `${file}.tmp`;
  await writeFile(tmp, token, { encoding: 'utf8', mode: 0o600 });
  if (process.platform !== 'win32') await chmod(tmp, 0o600);
  await rename(tmp, file);
}

/**
 * Démarre l'hôte de session d'un agent. Refuse s'il en vit déjà un
 * (ACP_HOST_BUSY : une session à la fois par agent — un clone, un agent).
 * Rend son PID dès le spawn ; le canal s'ouvre un instant plus tard
 * (`connectAcpHostOwner` attend, `acpHostStatus().listening` le dit).
 */
export async function launchAcpHost(
  root: string,
  spec: LaunchAcpHostSpec,
): Promise<{ pid: number; startedAt: string; ownerToken: string; logPath: string }> {
  validateAgentName(spec.agent);
  if (!TASK_ID_RE.test(spec.taskId)) {
    throw new StriartError(`Identifiant de tâche invalide pour une session ACP.`, {
      code: 'INVALID_ARGUMENT',
      details: { option: 'taskId' },
    });
  }
  const { agent } = spec;
  const status = await acpHostStatus(root, agent, { fresh: true });
  if (status.running) {
    throw new StriartError(
      `Une session ACP vit déjà pour "${agent}" (hôte PID ${status.pid}) : une seule session par agent.`,
      { code: 'ACP_HOST_BUSY', hint: 'striart status', details: { agent, pid: status.pid } },
    );
  }
  await releaseHostFiles(root, agent);
  await mkdir(acpHostDir(root, agent), { recursive: true });

  const ownerToken = newToken();
  const busToken = newToken();
  await writeBusToken(root, agent, busToken);
  const logPath = sessionLogPath(root, agent, spec.taskId);
  const runSpec: AcpHostRunSpec = {
    root,
    agent,
    taskId: spec.taskId,
    cwd: spec.cwd,
    profile: spec.profile,
    profileKey: spec.profileKey ?? 'custom',
    options: spec.options,
    initialPrompt: spec.initialPrompt,
    timeoutMs: spec.timeoutMs,
    closeWhenIdle: spec.closeWhenIdle,
    ownerPid: spec.ownerPid,
    ownerToken,
    busToken,
    mcpServers: spec.mcpServers,
    logPath,
  };

  const hostLog = acpHostLogPath(root, agent);
  await mkdir(path.dirname(hostLog), { recursive: true });
  const logFd = openSync(hostLog, 'a');
  let child;
  try {
    child = spawn(process.execPath, [entryPath(), 'acp-host', '--agent', agent, '--root', root], {
      // Jamais le clone : sous Windows, un process dont le répertoire courant
      // est le clone empêcherait sa suppression en fin de cycle. L'agent, lui,
      // reçoit le clone comme cwd (session.ts).
      cwd: root,
      detached: true,
      stdio: ['pipe', logFd, logFd],
      env: spec.env ?? process.env,
      windowsHide: true,
    });
  } finally {
    closeSync(logFd);
  }
  const startedAt = new Date().toISOString();
  if (!child.pid) {
    await releaseHostFiles(root, agent);
    throw new StriartError(`Échec du démarrage de l'hôte de session ACP pour "${agent}".`, {
      code: 'ACP_HOST_SPAWN_FAILED',
      hint: 'striart doctor',
      details: { agent },
    });
  }
  // PID file atomique AVANT la spec : l'hôte ne démarre sa session qu'à la
  // réception de sa spec, l'appelant peut donc publier ce PID sans course.
  await writeJsonAtomic(acpHostPidFilePath(root, agent), { pid: child.pid, startedAt });
  child.stdin?.on('error', () => {
    // Hôte mort avant lecture : constaté par la connexion du propriétaire.
  });
  child.stdin?.end(`${JSON.stringify(runSpec)}\n`);
  child.unref();
  return { pid: child.pid, startedAt, ownerToken, logPath };
}

/** Connexion au canal de l'hôte, réessayée tant qu'il démarre et vit. */
async function connectHost(root: string, agent: string, pid: number | null): Promise<net.Socket> {
  const socketPath = acpHostSocketPath(root, agent);
  const deadline = Date.now() + CONNECT_TIMEOUT_MS;
  for (;;) {
    // Avant CHAQUE tentative : jamais de jeton envoyé dans un dossier que
    // quelqu'un d'autre pourrait contrôler (S-M9). Absent = l'hôte démarre.
    await assertSocketDirPrivate(socketPath, { create: false }).catch((error) => {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    });
    try {
      return await new Promise<net.Socket>((resolve, reject) => {
        const socket = net.connect(socketPath);
        socket.once('connect', () => {
          socket.off('error', reject);
          resolve(socket);
        });
        socket.once('error', reject);
      });
    } catch (error) {
      if (Date.now() > deadline || (pid !== null && !isProcessAlive(pid))) throw error;
      await new Promise((resolve) => setTimeout(resolve, CONNECT_RETRY_MS));
    }
  }
}

export interface AcpHostOwnerConnection {
  /** Résultat de la session (rejeté si l'hôte disparaît sans le rendre). */
  result: Promise<SessionResult>;
  /** Annule la SESSION (fail closed : CANCELLED). */
  cancel(): void;
  /** Annule le seul tour en cours (`session/cancel`) ; la session continue. */
  cancelTurn(): void;
  /** Fin de session PROPRE : plus de prompt, le tour en cours se termine, puis session/close. */
  closeSession(): void;
  close(): void;
}

/** Événement de déroulé relayé par l'hôte au propriétaire (proxy `striart acp`, lot I10). */
export type AcpHostEvent =
  | {
      type: 'turn';
      phase: 'start' | 'end';
      turn: number;
      source?: 'initial' | 'bus';
      tag: string | null;
      stopReason?: string | null;
    }
  | { type: 'update'; update: Record<string, unknown> };

/**
 * Canal PROPRIÉTAIRE : un seul par hôte, authentifié par le jeton remis à
 * `launchAcpHost`. Sa fermeture sans résultat annule la session côté hôte.
 */
export async function connectAcpHostOwner(
  root: string,
  agent: string,
  {
    pid,
    ownerToken,
    onEvent = null,
  }: { pid: number; ownerToken: string; onEvent?: ((event: AcpHostEvent) => void) | null },
): Promise<AcpHostOwnerConnection> {
  const socket = await connectHost(root, agent, pid);
  socket.on('error', () => {
    // Coupure : constatée par la fin du flux (résultat absent → rejet).
  });
  writeFrame(socket, {
    type: 'hello',
    version: HOST_PROTOCOL_VERSION,
    role: 'owner',
    token: ownerToken,
  });
  const result = (async () => {
    for await (const frame of readFrames(socket)) {
      if (frame.type === 'result') return frame.result as SessionResult;
      if (onEvent && (frame.type === 'turn' || frame.type === 'update')) {
        try {
          onEvent(frame as unknown as AcpHostEvent);
        } catch {
          // Observateur défaillant : n'interrompt jamais la lecture du résultat.
        }
        continue;
      }
      if (frame.type === 'refused') {
        throw new StriartError(`Canal propriétaire de l'hôte ACP refusé (${String(frame.code)}).`, {
          code: 'ACP_HOST_LOST',
          details: { agent },
        });
      }
    }
    throw new StriartError(
      `L'hôte de session ACP de "${agent}" a disparu sans rendre de résultat.`,
      {
        code: 'ACP_HOST_LOST',
        hint: 'striart doctor',
        details: { agent },
      },
    );
  })();
  result.catch(() => {
    // Consommé par l'appelant ; évite un rejet non géré si personne n'écoute.
  });
  return {
    result,
    cancel: () => writeFrame(socket, { type: 'cancel' }),
    cancelTurn: () => writeFrame(socket, { type: 'cancel-turn' }),
    closeSession: () => writeFrame(socket, { type: 'close' }),
    close: () => socket.end(),
  };
}

/** Attend la sortie de l'hôte (après son résultat) ; rend false s'il s'attarde. */
export async function waitForAcpHostExit(
  pid: number,
  timeoutMs = HOST_EXIT_WAIT_MS,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (isProcessAlive(pid)) {
    if (Date.now() > deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, CONNECT_RETRY_MS));
  }
  return true;
}

export type HumanPromptResult =
  { ok: true; position: number } | { ok: false; code: string; message: string };

/**
 * Bus `@agent` (Phase E) : remet un texte HUMAIN à la session ACP vivante de
 * l'agent, qui le jouera comme prompt supplémentaire après le tour en cours.
 * N'appeler qu'avec ce qu'un humain a tapé — jamais une sortie d'agent ou de
 * LLM réinjectée (l'hôte ne peut pas le vérifier : c'est une règle des
 * appelants, tenue par `watch --ui`, seul appelant). Ne lève jamais : un
 * refus est un résultat explicite.
 */
export async function sendHumanPrompt(
  root: string,
  agent: string,
  text: string,
  { tag = null }: { tag?: string | null } = {},
): Promise<HumanPromptResult> {
  validateAgentName(agent);
  const status = await acpHostStatus(root, agent);
  if (!status.running || !status.listening) {
    return {
      ok: false,
      code: 'ACP_SESSION_NOT_FOUND',
      message: 'no live ACP session for this agent',
    };
  }
  let token: string;
  try {
    token = (await readFile(acpBusTokenPath(root, agent), 'utf8')).trim();
  } catch {
    return {
      ok: false,
      code: 'ACP_SESSION_NOT_FOUND',
      message: 'the ACP session has no bus channel',
    };
  }
  let socket: net.Socket;
  try {
    socket = await connectHost(root, agent, status.pid);
  } catch (error) {
    return { ok: false, code: 'ACP_HOST_UNREACHABLE', message: (error as Error).message };
  }
  socket.on('error', () => {
    // Coupure : traitée comme absence de réponse.
  });
  const timer = setTimeout(() => socket.destroy(), BUS_REPLY_TIMEOUT_MS);
  try {
    writeFrame(socket, { type: 'hello', version: HOST_PROTOCOL_VERSION, role: 'bus', token });
    let welcomed = false;
    for await (const frame of readFrames(socket)) {
      if (frame.type === 'welcome' && !welcomed) {
        welcomed = true;
        writeFrame(socket, { type: 'prompt', origin: 'human', text, ...(tag ? { tag } : {}) });
        continue;
      }
      if (frame.type === 'ack' && Number.isInteger(frame.position)) {
        return { ok: true, position: frame.position as number };
      }
      if (frame.type === 'refused') {
        return { ok: false, code: String(frame.code), message: String(frame.message ?? '') };
      }
    }
    return { ok: false, code: 'ACP_HOST_UNREACHABLE', message: 'the ACP host closed the channel' };
  } finally {
    clearTimeout(timer);
    socket.end();
  }
}

export interface AcpHostStopResult {
  stopped: boolean;
  wasStale: boolean;
  /** Arrêt demandé, hôte pas encore sorti : son PID file reste en place. */
  stopping: boolean;
  /** Hôte vivant mais non identifiable, ou non signalable : intouché. */
  untouched: 'unverified' | 'denied' | null;
}

/**
 * Arrête l'hôte proprement (demande d'arrêt lue par l'hôte → session/cancel,
 * kill de l'agent, sortie) ; repli sur le kill d'ARBRE sans accusé — l'agent
 * est l'enfant de l'hôte, il ne doit pas lui survivre. Jamais un kill à
 * l'aveugle : identité relue sans cache, un hôte non identifiable est laissé
 * en place (`untouched`).
 */
export async function stopAcpHost(root: string, agent: string): Promise<AcpHostStopResult> {
  const result = (partial: Partial<AcpHostStopResult>): AcpHostStopResult => ({
    stopped: false,
    wasStale: false,
    stopping: false,
    untouched: null,
    ...partial,
  });
  const status = await acpHostStatus(root, agent, { fresh: true });
  if (!status.running || !status.pid) {
    if (status.stale) await releaseHostFiles(root, agent);
    return result({ wasStale: status.stale });
  }
  if (!status.verified) return result({ untouched: 'unverified' });
  const pid = status.pid;
  let outcome: 'exited' | 'stopping';
  try {
    outcome = await requestStop({
      file: acpHostStopFilePath(root, agent),
      pid,
      ackWaitMs: HOST_STOP_ACK_WAIT_MS,
      waitMs: HOST_STOP_WAIT_MS,
      confirmIdentity: async () => {
        const fresh = await acpHostStatus(root, agent, { fresh: true });
        return fresh.verified && fresh.pid === pid;
      },
      fallback: async () => {
        // Heure de création relue juste après la revérification d'identité :
        // le binaire natif refuse la racine si le PID a changé de propriétaire.
        const rootStartedMs = (await readProcessInfos([pid])).get(pid)?.startTimeMs ?? null;
        await killProcessTree(
          { pid, kill: (signal?: NodeJS.Signals) => process.kill(pid, signal) },
          { rootStartedMs },
        );
      },
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EPERM') return result({ untouched: 'denied' });
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
    await releaseHostFiles(root, agent);
    return result({ wasStale: true });
  }
  if (outcome === 'stopping') return result({ stopping: true });
  await releaseHostFiles(root, agent);
  return result({ stopped: true });
}

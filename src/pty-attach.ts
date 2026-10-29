import { spawn } from 'node:child_process';
import type { ChildProcess, StdioOptions } from 'node:child_process';
import net from 'node:net';
import readline from 'node:readline';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { StriartError } from './errors.ts';
import { logger } from './logger.ts';
import { ptyDir, privateTmpDir } from './paths.ts';
import { mkdirPrivate } from './private-fs.ts';
import { validateAgentName } from './agent-name.ts';
import { nativePtyHostCommand, PTY_HOST_EXIT_ALREADY_RUNNING } from './native.ts';
import {
  ptyHostStateDir,
  ptyHostStatus,
  ptyHostStopFilePath,
  readPtyHostPidFile,
} from './pty-host-state.ts';
import { requestStop } from './stop-request.ts';

/**
 * Possession de pty + protocole d'attache (roadmap : « `watch` interactif »,
 * Phase B ; hôte natif depuis le lot R2 « Composants natifs (Rust) »).
 *
 * Le pty d'un agent vit dans un process HÔTE dédié : le binaire natif
 * `striart-native pty-host` (ConPTY sous Windows, `openpty` ailleurs — voir
 * native/striart-native/src/pty_host). Patron de multiplexeur maison, même
 * famille que tmux/screen : d'autres process (`striart attach`, le panneau de
 * `watch --ui`, le bus `@agent`) s'y connectent par IPC locale — named pipe
 * sous Windows (DACL limitée à l'utilisateur courant), socket Unix `0600`
 * ailleurs — et deviennent des clients du même pty : plusieurs clients
 * peuvent lire ET écrire en même temps, comme plusieurs `tmux attach`.
 *
 * Deux façons de posséder un hôte :
 *  - détaché (`ensurePtyHost`, pty-host.ts) : survit au process qui l'a lancé
 *    — `--open` depuis une commande CLI éphémère ;
 *  - possédé par CE process (`startOwnedSession`) : l'hôte est un enfant,
 *    lancé avec `--parent-pid` — il s'arrête de lui-même si ce process meurt,
 *    et `writeToOwnedSession` y écrit par une connexion d'attache gardée
 *    ouverte.
 *
 * Protocole ndjson (une frame JSON par ligne), inchangé depuis l'hôte Node :
 * `hello`/`data`/`resize`/`exit` (+ `evicted`, client trop lent) côté
 * serveur, `input`/`message`/`resize` côté client. Les octets de sortie du
 * pty sont en base64 : un pty transporte des séquences ANSI et parfois des
 * octets qui ne sont pas de l'UTF-8 valide.
 */

interface HelloFrame {
  type: 'hello';
  agent: string;
  cols: number;
  rows: number;
}
interface DataFrame {
  type: 'data';
  /** Sortie du pty, base64. */
  chunk: string;
}
interface ExitFrame {
  type: 'exit';
  exitCode: number | null;
  signal: number | null;
}
/**
 * Même forme que `ResizeFrame` (client → serveur) dans l'autre sens :
 * diffusée par l'hôte à TOUS les clients attachés quand l'un d'eux
 * redimensionne le pty — un client qui émule sa propre grille (le tail de
 * `watch --ui`) reste aligné sur ce qu'un vrai terminal montrerait.
 */
interface ServerResizeFrame {
  type: 'resize';
  cols: number;
  rows: number;
}
/**
 * Contre-pression : le client n'a pas lu sa sortie assez vite (file d'envoi
 * de l'hôte au-delà de `pty.clientQueueBytes`). L'hôte a vidé sa file et
 * ferme la connexion ; `connectAttachClient` se reconnecte et reçoit l'état
 * courant par le rejeu.
 */
interface EvictedFrame {
  type: 'evicted';
  reason: string;
}
type ServerFrame = HelloFrame | DataFrame | ExitFrame | ServerResizeFrame | EvictedFrame;

interface InputFrame {
  type: 'input';
  /** Frappes brutes (client interactif), base64. */
  data: string;
}
interface MessageFrame {
  type: 'message';
  /** Instruction du bus `@agent` — Entrée ajoutée par l'hôte. */
  text: string;
}
interface ResizeFrame {
  type: 'resize';
  cols: number;
  rows: number;
}
type ClientFrame = InputFrame | MessageFrame | ResizeFrame;

/**
 * Chemin d'attache d'un agent. Sous Windows, les named pipes vivent dans un
 * espace de noms global (pas le filesystem) : le nom est dérivé de la racine
 * du repo + de l'agent par hash, pour rester stable et sans collision entre
 * deux repos qui utiliseraient le même nom d'agent. POSIX : le binaire natif
 * exige `<état de l'hôte>/attach.sock` exactement (voir `ptyHostStateDir`,
 * qui porte le repli de chemin trop long — PTY_ENDPOINT_TOO_LONG sinon).
 */
export function attachSocketPath(root: string, agent: string): string {
  validateAgentName(agent);
  if (process.platform === 'win32') {
    const hash = createHash('sha1').update(path.resolve(root)).digest('hex').slice(0, 12);
    return `\\\\.\\pipe\\striart-${hash}-${agent}`;
  }
  return path.join(ptyHostStateDir(root, agent), 'attach.sock');
}

function writeFrame(socket: net.Socket, frame: ClientFrame): void {
  if (!socket.destroyed) socket.write(`${JSON.stringify(frame)}\n`);
}

// ── Lancement de l'hôte natif ────────────────────────────────────────────

/** Réglages de l'hôte (config `pty`, voir src/config.js). */
export interface PtyHostSettings {
  replayBytes?: number;
  clientQueueBytes?: number;
  killGraceMs?: number;
}

export interface LaunchPtyHostOptions extends PtyHostSettings {
  shell: string;
  args?: string[];
  cwd: string;
  cols?: number;
  rows?: number;
  initialCommand?: string | null;
  env?: NodeJS.ProcessEnv;
  /** Détaché (survit à ce process) ou enfant possédé (`--parent-pid`). */
  detached: boolean;
  stdio: StdioOptions;
}

/** Délai de mise en service de l'hôte (canal ouvert, programme lancé). */
export const PTY_HOST_READY_TIMEOUT_MS = 20_000;

/** `TERM` du programme hébergé sous POSIX (ce que node-pty posait). */
const POSIX_TERM = 'xterm-256color';

/**
 * Lance `striart-native pty-host` pour un agent. Binaire absent ou non
 * vérifiable : NATIVE_UNAVAILABLE / NATIVE_INTEGRITY_FAILED — jamais de
 * repli silencieux.
 */
export async function launchPtyHost(
  root: string,
  agent: string,
  options: LaunchPtyHostOptions,
): Promise<ChildProcess> {
  validateAgentName(agent);
  const stateDir = ptyHostStateDir(root, agent);
  // Repli hors `.striart/` (chemin trop long pour un socket Unix) : le
  // binaire natif crée et sécurise `stateDir` lui-même (0700), mais pas son
  // parent `privateTmpDir()` s'il est créé au passage (`create_dir_all` ne
  // pose le mode que sur le dossier final) — posé ici pour éviter qu'un
  // dossier temporaire partagé nouvellement créé reste aux permissions par
  // défaut du système.
  if (process.platform !== 'win32' && !stateDir.startsWith(ptyDir(root))) {
    await mkdirPrivate(privateTmpDir());
  }
  const endpoint = attachSocketPath(root, agent);
  const { file, args } = await nativePtyHostCommand({
    agent,
    stateDir: path.resolve(stateDir),
    endpoint,
    cwd: path.resolve(options.cwd),
    program: options.shell,
    args: options.args ?? [],
    cols: options.cols,
    rows: options.rows,
    initial: options.initialCommand ?? null,
    term: process.platform === 'win32' ? null : POSIX_TERM,
    replayBytes: options.replayBytes,
    clientQueueBytes: options.clientQueueBytes,
    killGraceMs: options.killGraceMs,
    parentPid: options.detached ? null : process.pid,
  });
  const child = spawn(file, args, {
    cwd: options.cwd,
    detached: options.detached,
    stdio: options.stdio,
    env: options.env ?? process.env,
    windowsHide: true,
  });
  if (!child.pid) {
    // spawn a échoué de façon synchrone (EACCES, ENOENT) : l'erreur arrive
    // en événement, on la rend nommée.
    const error = await new Promise<Error | null>((resolve) => {
      child.once('error', resolve);
      setImmediate(() => resolve(null));
    });
    throw new StriartError(`Failed to start the pty host for "${agent}".`, {
      code: 'PTY_HOST_SPAWN_FAILED',
      hint: 'striart doctor',
      details: {
        agent,
        reason: 'SPAWN',
        errno: (error as NodeJS.ErrnoException | null)?.code ?? null,
      },
    });
  }
  return child;
}

/**
 * Issue du démarrage. Discriminant chaîne (`state`) et non booléen : le
 * `tsc` natif (TS 7) ne rétrécit pas une union discriminée par littéral
 * booléen sous `strict: false` (voir roadmap, Phase D).
 */
export type PtyHostReadiness =
  | { state: 'ready' }
  | { state: 'exited'; exitCode: number | null; signal: NodeJS.Signals | null }
  | { state: 'timeout' };

/**
 * Attend que l'hôte lancé publie son PID file (canal ouvert, programme
 * lancé), qu'il sorte (échec, ou sortie 3 : un autre hôte tient l'agent) ou
 * que le délai expire.
 */
export async function waitForPtyHostReady(
  root: string,
  agent: string,
  child: ChildProcess,
  timeoutMs = PTY_HOST_READY_TIMEOUT_MS,
): Promise<PtyHostReadiness> {
  let exited: { exitCode: number | null; signal: NodeJS.Signals | null } | null = null;
  const onExit = (exitCode: number | null, signal: NodeJS.Signals | null) => {
    exited = { exitCode, signal };
  };
  child.once('exit', onExit);
  try {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const info = await readPtyHostPidFile(root, agent);
      if (info?.pid === child.pid) return { state: 'ready' };
      const end = exited as { exitCode: number | null; signal: NodeJS.Signals | null } | null;
      if (end) return { state: 'exited', ...end };
      if (child.exitCode !== null || child.signalCode !== null) {
        return { state: 'exited', exitCode: child.exitCode, signal: child.signalCode };
      }
      if (Date.now() >= deadline) return { state: 'timeout' };
      await sleep(25);
    }
  } finally {
    child.removeListener('exit', onExit);
  }
}

// ── Hôte possédé par CE process ─────────────────────────────────────────

interface OwnedSession {
  root: string;
  agent: string;
  child: ChildProcess;
  conn: AttachConnection;
  exited: Promise<void>;
}

/** Un agent = un hôte possédé, tant que ce process vit. */
const sessions = new Map<string, OwnedSession>();
/** Démarrages en cours (deux appels concurrents partagent le même). */
const starting = new Map<string, Promise<void>>();

export interface StartOwnedSessionOptions extends PtyHostSettings {
  shell: string;
  args?: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  cols?: number;
  rows?: number;
}

/** Plus grande part du journal d'erreur de l'hôte gardée en mémoire. */
const STDERR_TAIL_BYTES = 16 * 1024;

/**
 * Démarre (ou réutilise) le pty possédé d'un agent. Idempotent : un second
 * appel ne relance jamais un second hôte, il réutilise le premier.
 */
export async function startOwnedSession(
  root: string,
  agent: string,
  options: StartOwnedSessionOptions,
): Promise<void> {
  validateAgentName(agent);
  if (sessions.has(agent)) return;
  const pending = starting.get(agent);
  if (pending) return pending;
  const start = startOwnedSessionNow(root, agent, options).finally(() => starting.delete(agent));
  starting.set(agent, start);
  return start;
}

async function startOwnedSessionNow(
  root: string,
  agent: string,
  options: StartOwnedSessionOptions,
): Promise<void> {
  const child = await launchPtyHost(root, agent, {
    ...options,
    detached: false,
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderrTail = '';
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (chunk: string) => {
    stderrTail = (stderrTail + chunk).slice(-STDERR_TAIL_BYTES);
  });
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
  const readiness = await waitForPtyHostReady(root, agent, child);
  if (readiness.state !== 'ready') {
    child.kill();
    throw hostStartError(agent, readiness, stderrTail);
  }
  const conn = await new Promise<AttachConnection>((resolve, reject) => {
    const connection = connectAttachClient(root, agent, {
      onData: () => {},
      onConnect: () => resolve(connection),
      onError: (error) => reject(error),
    });
  }).catch((error: Error) => {
    child.kill();
    throw new StriartError(`Cannot open the attach channel of agent "${agent}".`, {
      code: 'PTY_ATTACH_LISTEN_FAILED',
      hint: 'striart doctor',
      details: { agent, errno: (error as NodeJS.ErrnoException).code ?? null },
    });
  });
  const session: OwnedSession = { root, agent, child, conn, exited };
  sessions.set(agent, session);
  void exited.then(() => {
    conn.close();
    if (sessions.get(agent) === session) sessions.delete(agent);
    const waiters = exitWaiters.get(agent);
    exitWaiters.delete(agent);
    for (const resolve of waiters ?? []) resolve();
  });
  logger.info({ agent, hostPid: child.pid }, 'Pty possédé démarré (hôte natif)');
}

/** Erreur nommée d'un hôte qui n'a pas démarré (journal : dernière ligne JSON). */
export function hostStartError(
  agent: string,
  readiness: Exclude<PtyHostReadiness, { state: 'ready' }>,
  stderrTail: string,
  logFile: string | null = null,
): StriartError {
  if (readiness.state === 'timeout') {
    return new StriartError(`The pty host of "${agent}" did not become ready in time.`, {
      code: 'PTY_HOST_SPAWN_FAILED',
      // Le journal est dans `details.logFile` et dans le message du catalogue ;
      // un hint est une COMMANDE à copier, jamais une phrase.
      hint: 'striart doctor',
      details: { agent, reason: 'TIMEOUT', logFile },
    });
  }
  if (readiness.exitCode === PTY_HOST_EXIT_ALREADY_RUNNING) {
    return new StriartError(`A pty host already runs for agent "${agent}".`, {
      code: 'PTY_HOST_ALREADY_RUNNING',
      hint: `striart attach ${agent}`,
      details: { agent },
    });
  }
  const nativeCode = lastNativeErrorCode(stderrTail);
  return new StriartError(
    `The pty host of "${agent}" exited before being ready${nativeCode ? ` (${nativeCode})` : ''}.`,
    {
      code: 'PTY_HOST_SPAWN_FAILED',
      // Le journal est dans `details.logFile` et dans le message du catalogue ;
      // un hint est une COMMANDE à copier, jamais une phrase.
      hint: 'striart doctor',
      details: {
        agent,
        reason: 'EXITED',
        exitCode: readiness.exitCode,
        signal: readiness.signal,
        nativeCode,
        logFile,
      },
    },
  );
}

/** Code d'erreur natif de la dernière ligne JSON `{"error":{"code"}}` d'un journal. */
export function lastNativeErrorCode(log: string): string | null {
  const lines = log.trimEnd().split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const parsed = JSON.parse(lines[i]);
      const code = parsed?.error?.code;
      if (typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(code)) return code;
    } catch {
      // Ligne non JSON (sortie d'un outil tiers) : on remonte.
    }
  }
  return null;
}

/** Le pty d'un agent est-il possédé par CE process ? */
export function hasOwnedSession(agent: string): boolean {
  return sessions.has(agent);
}

/**
 * Écrit dans le pty possédé depuis CE process, par la connexion d'attache
 * gardée ouverte. `appendEnter` distingue une instruction complète (Entrée
 * ajoutée par l'hôte, comportement par défaut du bus) d'une frappe brute.
 */
export function writeToOwnedSession(agent: string, text: string, appendEnter = true): void {
  const session = sessions.get(agent);
  if (!session) {
    throw new StriartError(`No owned pty for agent "${agent}" in this process.`, {
      code: 'PTY_SESSION_NOT_FOUND',
      details: { agent },
    });
  }
  if (appendEnter) session.conn.sendMessage(text);
  else session.conn.sendRaw(text);
}

/** Attente de l'accusé puis de la sortie de l'hôte possédé. */
const OWNED_STOP_ACK_WAIT_MS = 3_000;
const OWNED_STOP_WAIT_MS = 10_000;

/**
 * Arrête le pty possédé d'un agent par le canal d'arrêt propre
 * (`host.stop`, accusé par l'hôte) : l'hôte ferme le pty, tue la descendance
 * restante après son délai de grâce, envoie la frame `exit` à tous les
 * clients puis sort. Sans accusé, l'enfant est tué (le Job Object / le
 * groupe POSIX emporte alors le shell). Résout quand l'hôte est sorti.
 */
export async function stopOwnedSession(agent: string): Promise<void> {
  const session = sessions.get(agent);
  if (!session) return;
  const pid = session.child.pid;
  if (pid && session.child.exitCode === null && session.child.signalCode === null) {
    await requestStop({
      file: ptyHostStopFilePath(session.root, agent),
      pid,
      ackWaitMs: OWNED_STOP_ACK_WAIT_MS,
      waitMs: OWNED_STOP_WAIT_MS,
      fallback: () => session.child.kill(),
      // Le délai d'accusé est une fenêtre où le numéro peut changer de propriétaire :
      // l'enfant doit être toujours vivant ET reconnu (identité relue sans cache)
      // juste avant le signal de repli.
      confirmIdentity: async () => {
        if (session.child.exitCode !== null || session.child.signalCode !== null) return false;
        const fresh = await ptyHostStatus(session.root, agent, { fresh: true });
        return fresh.verified && fresh.pid === pid;
      },
    }).catch(() => {
      // Process déjà sorti entre le test et la demande : rien à arrêter.
    });
  }
  await Promise.race([session.exited, sleep(OWNED_STOP_WAIT_MS)]);
  session.conn.close();
  if (sessions.get(agent) === session) sessions.delete(agent);
}

/** Résolveurs de `waitForSessionExit` en attente, par agent. */
const exitWaiters = new Map<string, Array<() => void>>();

/**
 * Résout quand le pty possédé d'un agent s'arrête (naturellement ou via
 * `stopOwnedSession`). Résout immédiatement si rien n'est possédé.
 */
export function waitForSessionExit(agent: string): Promise<void> {
  if (!sessions.has(agent)) return Promise.resolve();
  return new Promise((resolve) => {
    const list = exitWaiters.get(agent) ?? [];
    list.push(resolve);
    exitWaiters.set(agent, list);
  });
}

// ── Client d'attache ─────────────────────────────────────────────────────

export interface AttachClientOptions {
  onData: (text: string) => void;
  onExit?: (exitCode: number | null, signal: number | null) => void;
  /**
   * Canal introuvable (agent jamais démarré, hôte mort) ou connexion
   * rompue. Sans ce handler, l'événement 'error' non écouté d'un socket
   * ferait planter tout le process — jamais acceptable pour un client.
   */
  onError?: (error: Error) => void;
  /**
   * La connexion est établie côté serveur (frame `hello` reçue) — le signal
   * fiable pour savoir qu'un écrivain concurrent sera désormais vu par ce
   * client. `cols`/`rows` : dimensions RÉELLES du pty au moment de l'attache
   * (celles éventuellement demandées ci-dessous ne sont appliquées qu'après).
   */
  onConnect?: (info: { cols: number; rows: number }) => void;
  /**
   * Le pty a été redimensionné APRÈS la connexion — par ce client lui-même
   * ou par un AUTRE client attaché.
   */
  onResize?: (info: { cols: number; rows: number }) => void;
  /**
   * L'hôte a évincé ce client (trop lent à lire sa sortie). La connexion est
   * rétablie aussitôt et le rejeu suit (`onConnect` puis `onData`) : un
   * client qui émule un écran (le tail de `watch --ui`) doit le remettre à
   * zéro ici, sans quoi le rejeu s'ajouterait à l'écran déjà affiché.
   */
  onEvicted?: () => void;
  cols?: number;
  rows?: number;
}

export interface AttachConnection {
  /** Instruction complète, façon bus `@agent` — Entrée ajoutée par l'hôte. */
  sendMessage(text: string): void;
  /** Frappes brutes (client interactif attaché en direct). */
  sendRaw(text: string): void;
  resize(cols: number, rows: number): void;
  close(): void;
}

/** Reconnexions successives après éviction avant d'abandonner (onError). */
const MAX_EVICTION_RECONNECTS = 5;
const EVICTION_RECONNECT_DELAY_MS = 100;

/**
 * Connecte un client au pty d'un agent par le canal IPC réel (`striart
 * attach`, le panneau de `watch --ui`, le bus `@agent`, un test).
 *
 * La sortie est décodée en UTF-8 EN FLUX (un caractère multi-octets coupé
 * entre deux frames reste entier). Évincé par l'hôte (client trop lent), le
 * client se reconnecte de lui-même et reçoit le rejeu ; au-delà de
 * MAX_EVICTION_RECONNECTS évictions consécutives sans sortie lue, il
 * abandonne par `onError`.
 */
export function connectAttachClient(
  root: string,
  agent: string,
  options: AttachClientOptions,
): AttachConnection {
  const { onData, onExit, onError, onConnect, onResize, onEvicted } = options;
  const endpoint = attachSocketPath(root, agent);
  let requested: { cols: number; rows: number } | null =
    options.cols || options.rows ? { cols: options.cols ?? 0, rows: options.rows ?? 0 } : null;
  let socket: net.Socket;
  let closed = false;
  let exited = false;
  let evictions = 0;

  const open = () => {
    const current = net.createConnection(endpoint);
    socket = current;
    let evicted = false;
    const decoder = new TextDecoder('utf-8');
    current.on('error', (error) => {
      if (!evicted && !closed) onError?.(error);
    });
    const rl = readline.createInterface({ input: current });
    // readline.Interface réémet l'erreur du socket sur lui-même — sans ce
    // no-op, l'événement non écouté sur l'Interface planterait le client.
    rl.on('error', () => {});
    rl.on('line', (line) => {
      let frame: ServerFrame;
      try {
        frame = JSON.parse(line);
      } catch {
        return;
      }
      if (frame.type === 'data') {
        evictions = 0;
        const text = decoder.decode(Buffer.from(frame.chunk, 'base64'), { stream: true });
        if (text) onData(text);
      } else if (frame.type === 'exit') {
        exited = true;
        onExit?.(frame.exitCode, frame.signal);
      } else if (frame.type === 'hello') {
        if (requested) {
          writeFrame(current, {
            type: 'resize',
            cols: requested.cols || frame.cols,
            rows: requested.rows || frame.rows,
          });
        }
        onConnect?.({ cols: frame.cols, rows: frame.rows });
      } else if (frame.type === 'resize') {
        onResize?.({ cols: frame.cols, rows: frame.rows });
      } else if (frame.type === 'evicted') {
        evicted = true;
      }
    });
    current.on('close', () => {
      if (!evicted || closed || exited) return;
      evictions += 1;
      if (evictions > MAX_EVICTION_RECONNECTS) {
        onError?.(new Error(`attach client evicted ${evictions} times in a row (too slow)`));
        return;
      }
      onEvicted?.();
      setTimeout(() => {
        if (!closed) open();
      }, EVICTION_RECONNECT_DELAY_MS);
    });
  };
  open();

  return {
    sendMessage: (text) => writeFrame(socket, { type: 'message', text }),
    sendRaw: (text) =>
      writeFrame(socket, { type: 'input', data: Buffer.from(text, 'utf8').toString('base64') }),
    resize: (c, r) => {
      requested = { cols: c, rows: r };
      writeFrame(socket, { type: 'resize', cols: c, rows: r });
    },
    close: () => {
      closed = true;
      socket.end();
    },
  };
}

import * as pty from 'node-pty';
import net from 'node:net';
import readline from 'node:readline';
import { createHash } from 'node:crypto';
import { chmod, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { StriartError } from './errors.js';
import { logger } from './logger.js';
import { ptyDir } from './paths.js';
import { validateAgentName } from './clone.js';

/**
 * Possession de pty + protocole d'attache (roadmap : « `watch` interactif —
 * UI Ink + bus de messages `@agent` », Phase B).
 *
 * Striart devient propriétaire d'un pty par agent (`node-pty`, ConPTY sur
 * Windows) — patron de multiplexeur maison, même famille que tmux/screen.
 * Le pty vit dans CE process (le futur daemon `watch`) ; d'autres process
 * (le client d'attache que `--open` lancera en Phase C, un futur panneau du
 * dashboard…) s'y connectent par IPC locale — named pipe sous Windows, socket
 * Unix ailleurs — et deviennent des clients supplémentaires du même pty :
 * plusieurs clients peuvent lire ET écrire en même temps, comme plusieurs
 * `tmux attach` sur la même session. `writeToOwnedSession` est le raccourci
 * pour un écrivain qui vit DANS ce process (le futur bus `@agent` de l'UI
 * Ink) — pas besoin de faire un aller-retour IPC vers soi-même.
 *
 * Protocole ndjson (une frame JSON par ligne), même famille artisanale que
 * `acp.ts`/`mcp.js` — le sous-ensemble utilisé ne justifie pas une lib de
 * cadrage binaire. Les octets de sortie du pty sont encodés en base64 : un
 * pty transporte des séquences ANSI et potentiellement des octets qui ne
 * sont pas de l'UTF-8 valide (sortie d'outils tiers), base64 les rend
 * transparents à un cadrage ligne par ligne.
 */

/** Un agent = un pty possédé, tant que ce process (le daemon watch) vit. */
const sessions = new Map<string, OwnedSession>();

/** Résolveurs de `waitForSessionExit` en attente, par agent. */
const exitWaiters = new Map<string, Array<() => void>>();

interface OwnedSession {
  agent: string;
  term: pty.IPty;
  server: net.Server;
  socketPath: string;
  clients: Set<net.Socket>;
  cols: number;
  rows: number;
  /** Rejeu pour un client qui se connecte APRÈS coup — cf. REPLAY_BUFFER_CHARS. */
  replayBuffer: string;
}

/**
 * Sortie récente conservée pour rejeu à la connexion (octets, avant base64).
 * Sans ça, un client qui se connecte APRÈS que la commande initiale (ou un
 * message du bus) ait déjà produit sa sortie ne verrait jamais rien tant
 * qu'aucune nouvelle sortie n'arrive — le pty n'a pas d'historique, une
 * fenêtre `--open` ouverte une seconde trop tard ou le panneau de `watch`
 * démarrerait sur du vide. Borné (dernier écran plutôt que tout
 * l'historique) : ce n'est pas un remplacement du scrollback du terminal
 * lui-même, juste assez pour retrouver l'état courant en s'attachant.
 */
const REPLAY_BUFFER_CHARS = 64_000;

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
 * Même forme que `ResizeFrame` (ci-dessous, client → serveur) mais dans
 * l'autre sens : diffusée par le serveur à tous les AUTRES clients attachés
 * quand l'un d'eux redimensionne le pty. Sans ça, un client déjà connecté
 * (par exemple le tail de `watch --ui`, qui émule sa propre grille de
 * caractères à partir des mêmes octets) restait sur les dimensions connues
 * à SA connexion, désynchronisées dès qu'un `attach`/`--open` réel
 * redimensionnait son terminal après coup — retours à la ligne mal
 * recalculés côté émulation, différents de ce qu'un vrai terminal montrerait.
 */
interface ServerResizeFrame {
  type: 'resize';
  cols: number;
  rows: number;
}
type ServerFrame = HelloFrame | DataFrame | ExitFrame | ServerResizeFrame;

interface InputFrame {
  type: 'input';
  /** Frappes brutes (client interactif), base64. */
  data: string;
}
interface MessageFrame {
  type: 'message';
  /** Instruction du bus `@agent` — Entrée ajoutée automatiquement. */
  text: string;
}
interface ResizeFrame {
  type: 'resize';
  cols: number;
  rows: number;
}
type ClientFrame = InputFrame | MessageFrame | ResizeFrame;

export interface StartOwnedSessionOptions {
  shell: string;
  args?: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  cols?: number;
  rows?: number;
}

const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;

/**
 * Chemin d'attache d'un agent. Sous Windows, les named pipes vivent dans un
 * espace de noms global (pas le filesystem) : le nom est dérivé de la racine
 * du repo + de l'agent par hash, pour rester stable et sans collision entre
 * deux repos qui utiliseraient le même nom d'agent.
 */
export function attachSocketPath(root: string, agent: string): string {
  validateAgentName(agent);
  if (process.platform === 'win32') {
    const hash = createHash('sha1').update(path.resolve(root)).digest('hex').slice(0, 12);
    return `\\\\.\\pipe\\striart-${hash}-${agent}`;
  }
  return path.join(ptyDir(root), agent, 'attach.sock');
}

function writeFrame(socket: net.Socket, frame: ServerFrame | ClientFrame): void {
  socket.write(`${JSON.stringify(frame)}\n`);
}

function broadcast(session: OwnedSession, frame: ServerFrame): void {
  for (const client of session.clients) {
    if (!client.destroyed) writeFrame(client, frame);
  }
}

/**
 * Démarre (ou réutilise) le pty possédé d'un agent. Idempotent par
 * conception : plusieurs `--open` sur le même agent ne respawnent jamais un
 * second pty, ils deviennent des clients supplémentaires du même — c'est ce
 * qui permet au bus `@agent` d'écrire alors qu'une fenêtre est déjà attachée.
 */
export async function startOwnedSession(
  root: string,
  agent: string,
  options: StartOwnedSessionOptions,
): Promise<void> {
  validateAgentName(agent);
  const existing = sessions.get(agent);
  if (existing) return;

  const cols = options.cols ?? DEFAULT_COLS;
  const rows = options.rows ?? DEFAULT_ROWS;
  const term = pty.spawn(options.shell, options.args ?? [], {
    name: 'xterm-256color',
    cols,
    rows,
    cwd: options.cwd,
    env: (options.env ?? process.env) as { [key: string]: string },
  });

  const socketPath = attachSocketPath(root, agent);
  if (process.platform !== 'win32') {
    await mkdir(path.dirname(socketPath), { recursive: true });
    // Un socket orphelin d'un précédent daemon crashé ferait échouer le
    // listen (EADDRINUSE) — aucun process ne le possède plus, sûr à retirer.
    await rm(socketPath, { force: true });
  }

  const server = net.createServer((socket) => {
    writeFrame(socket, { type: 'hello', agent, cols: session.cols, rows: session.rows });
    // Rejeu AVANT l'ajout aux diffusions live, dans le même tick synchrone
    // (aucun await entre les deux) : aucune sortie ne peut arriver entre le
    // rejeu et le direct, donc jamais de trou ni de doublon.
    if (session.replayBuffer) {
      writeFrame(socket, {
        type: 'data',
        chunk: Buffer.from(session.replayBuffer, 'utf8').toString('base64'),
      });
    }
    session.clients.add(socket);

    const rl = readline.createInterface({ input: socket });
    // readline.Interface réémet l'erreur du socket sur lui-même — sans ce
    // no-op, un socket client qui coupe brutalement (readline.Interface sans
    // écouteur d'erreur) plante tout le process propriétaire du pty.
    rl.on('error', () => {});
    rl.on('line', (line) => {
      let frame: ClientFrame;
      try {
        frame = JSON.parse(line);
      } catch {
        return; // ligne malformée : ignorée, pas de crash du pty partagé
      }
      if (frame.type === 'input') {
        term.write(Buffer.from(frame.data, 'base64').toString('utf8'));
      } else if (frame.type === 'message') {
        term.write(`${frame.text}\r`);
      } else if (frame.type === 'resize') {
        session.cols = frame.cols;
        session.rows = frame.rows;
        term.resize(frame.cols, frame.rows);
        // Diffusé à TOUS les clients (l'émetteur inclus — idempotent, il
        // connaît déjà cette taille) : plus simple et plus sûr que de tenir
        // à jour une exclusion par socket pour un cas qui n'a aucun effet
        // observable de toute façon.
        broadcast(session, { type: 'resize', cols: frame.cols, rows: frame.rows });
      }
    });

    socket.on('close', () => session.clients.delete(socket));
    socket.on('error', () => session.clients.delete(socket));
  });

  const session: OwnedSession = {
    agent,
    term,
    server,
    socketPath,
    clients: new Set(),
    cols,
    rows,
    replayBuffer: '',
  };
  sessions.set(agent, session);

  term.onData((chunk) => {
    session.replayBuffer = (session.replayBuffer + chunk).slice(-REPLAY_BUFFER_CHARS);
    broadcast(session, { type: 'data', chunk: Buffer.from(chunk, 'utf8').toString('base64') });
  });
  term.onExit(({ exitCode, signal }) => {
    void stopOwnedSession(agent, { exitCode, signal: signal ?? null });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => {
      server.removeListener('error', reject);
      resolve();
    });
  }).catch((error) => {
    sessions.delete(agent);
    term.kill();
    throw new StriartError(`Impossible d'ouvrir le canal d'attache de l'agent "${agent}".`, {
      code: 'PTY_ATTACH_LISTEN_FAILED',
      details: { agent, socketPath, message: (error as Error).message },
    });
  });

  if (process.platform !== 'win32') {
    // SECURITY.md : un socket Unix hérite du umask du process, pas
    // forcément propriétaire-seul — sur une machine partagée, un autre
    // utilisateur local (sans accès en écriture au repo, donc hors du
    // modèle de menace habituel) pourrait sinon s'y attacher et injecter
    // des frappes dans le pty. 0600 explicite, jamais laissé à l'umask.
    await chmod(socketPath, 0o600);
  }

  logger.info({ agent, socketPath }, 'Pty possédé démarré');
}

/** Le pty d'un agent est-il possédé par CE process ? */
export function hasOwnedSession(agent: string): boolean {
  return sessions.has(agent);
}

/**
 * Écrit directement dans le pty depuis CE process — le raccourci du bus
 * `@agent` (Phase D), qui vit dans le même process que le pty (le daemon
 * `watch`) et n'a donc pas besoin de repasser par l'IPC pour s'écrire à
 * lui-même. `appendEnter` distingue une instruction complète (Entrée
 * ajoutée, comportement par défaut du bus) d'une frappe brute.
 */
export function writeToOwnedSession(agent: string, text: string, appendEnter = true): void {
  const session = sessions.get(agent);
  if (!session) {
    throw new StriartError(`Aucun pty possédé pour l'agent "${agent}" dans ce process.`, {
      code: 'PTY_SESSION_NOT_FOUND',
      details: { agent },
    });
  }
  session.term.write(appendEnter ? `${text}\r` : text);
}

/**
 * Arrête le pty d'un agent : diffuse une frame `exit` à tous les clients
 * attachés (arrêt naturel du pty comme arrêt explicite passent tous les deux
 * ici — `exitInfo` distingue les deux, mais le client voit toujours un exit
 * propre, jamais une connexion juste coupée), puis ferme les clients et le
 * canal d'attache. `client.end()` (pas `.destroy()`) : laisse la frame déjà
 * écrite partir avant la fermeture — un destroy immédiat pourrait la perdre.
 */
export async function stopOwnedSession(
  agent: string,
  exitInfo: { exitCode: number | null; signal: number | null } = { exitCode: null, signal: null },
): Promise<void> {
  const session = sessions.get(agent);
  if (!session) return;
  sessions.delete(agent);
  broadcast(session, { type: 'exit', exitCode: exitInfo.exitCode, signal: exitInfo.signal });
  for (const client of session.clients) client.end();
  await new Promise<void>((resolve) => session.server.close(() => resolve()));
  try {
    session.term.kill();
  } catch {
    // Déjà mort (c'est parfois onExit qui déclenche cet arrêt) : rien à faire.
  }
  if (process.platform !== 'win32') {
    await rm(session.socketPath, { force: true }).catch(() => {});
  }
  const waiters = exitWaiters.get(agent);
  exitWaiters.delete(agent);
  for (const resolve of waiters ?? []) resolve();
}

/**
 * Résout quand le pty possédé d'un agent s'arrête (naturellement ou via
 * `stopOwnedSession`) — le process hôte détaché (`pty-host-run`, Phase C)
 * s'en sert pour savoir combien de temps rester en vie : le pty EST sa
 * seule raison d'exister. Résout immédiatement si rien n'est possédé.
 */
export function waitForSessionExit(agent: string): Promise<void> {
  if (!sessions.has(agent)) return Promise.resolve();
  return new Promise((resolve) => {
    const list = exitWaiters.get(agent) ?? [];
    list.push(resolve);
    exitWaiters.set(agent, list);
  });
}

export interface AttachClientOptions {
  onData: (text: string) => void;
  onExit?: (exitCode: number | null, signal: number | null) => void;
  /**
   * Canal introuvable (agent jamais démarré, daemon mort) ou connexion
   * rompue. Sans ce handler, l'événement 'error' non écouté d'un socket
   * ferait planter tout le process — jamais acceptable pour un client.
   */
  onError?: (error: Error) => void;
  /**
   * La connexion est établie côté serveur (frame `hello` reçue) — le signal
   * fiable pour savoir qu'un écrivain concurrent (un autre client, ou
   * `writeToOwnedSession` dans le process propriétaire) sera désormais vu
   * par ce client. Écrire avant ce signal risque une frame de sortie
   * manquée (le client n'est pas encore dans la liste des diffusions).
   * `cols`/`rows` : dimensions RÉELLES du pty au moment de l'attache (pas
   * celles éventuellement demandées via l'option `cols`/`rows` ci-dessous,
   * qui ne sont appliquées qu'après ce frame) — un client qui doit
   * reproduire fidèlement l'affichage de l'outil hébergé (un terminal émulé
   * en tail, par exemple) en a besoin pour se dimensionner pareil.
   */
  onConnect?: (info: { cols: number; rows: number }) => void;
  /**
   * Le pty a été redimensionné APRÈS la connexion — par ce client lui-même
   * (si `cols`/`rows` a été passé ci-dessous) ou par un AUTRE client attaché
   * (un `attach` réel dont le terminal a changé de taille). Un client qui
   * émule sa propre grille de caractères à partir des octets bruts (le tail
   * de `watch --ui`) doit la redimensionner pareil, sous peine de mal
   * recalculer les retours à la ligne de l'outil hébergé.
   */
  onResize?: (info: { cols: number; rows: number }) => void;
  cols?: number;
  rows?: number;
}

export interface AttachConnection {
  /** Instruction complète, façon bus `@agent` — Entrée ajoutée par le pty possédé. */
  sendMessage(text: string): void;
  /** Frappes brutes (client interactif attaché en direct). */
  sendRaw(text: string): void;
  resize(cols: number, rows: number): void;
  close(): void;
}

/**
 * Connecte un client externe au pty possédé d'un agent (le client d'attache
 * de la Phase C, ou un test). Distinct de `writeToOwnedSession` : celui-ci
 * passe par le canal IPC réel, pour un process qui n'est pas le propriétaire
 * du pty.
 */
export function connectAttachClient(
  root: string,
  agent: string,
  { onData, onExit, onError, onConnect, onResize, cols, rows }: AttachClientOptions,
): AttachConnection {
  const socket = net.createConnection(attachSocketPath(root, agent));
  socket.on('error', (error) => onError?.(error));
  const rl = readline.createInterface({ input: socket });
  // readline.Interface réémet l'erreur du socket sur lui-même — sans ce
  // no-op, le socket.on('error') ci-dessus ne suffit pas : l'event non
  // écouté sur l'Interface plante quand même le process du client.
  rl.on('error', () => {});
  rl.on('line', (line) => {
    let frame: ServerFrame;
    try {
      frame = JSON.parse(line);
    } catch {
      return;
    }
    if (frame.type === 'data') {
      onData(Buffer.from(frame.chunk, 'base64').toString('utf8'));
    } else if (frame.type === 'exit') {
      onExit?.(frame.exitCode, frame.signal);
    } else if (frame.type === 'hello') {
      if (cols || rows) {
        writeFrame(socket, { type: 'resize', cols: cols ?? frame.cols, rows: rows ?? frame.rows });
      }
      onConnect?.({ cols: frame.cols, rows: frame.rows });
    } else if (frame.type === 'resize') {
      onResize?.({ cols: frame.cols, rows: frame.rows });
    }
  });

  return {
    sendMessage: (text) => writeFrame(socket, { type: 'message', text }),
    sendRaw: (text) =>
      writeFrame(socket, { type: 'input', data: Buffer.from(text, 'utf8').toString('base64') }),
    resize: (c, r) => writeFrame(socket, { type: 'resize', cols: c, rows: r }),
    close: () => socket.end(),
  };
}

import net from 'node:net';
import { chmod, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { writeJsonAtomic } from '../json-file.ts';
import { logger } from '../logger.ts';
import { mkdirPrivate } from '../private-fs.ts';
import { isProcessAlive } from '../process-tree.ts';
import { clearStopRequest, watchStopRequest } from '../stop-request.ts';
import {
  HOST_PROTOCOL_VERSION,
  acpBusTokenPath,
  acpHostPidFilePath,
  acpHostReadyFilePath,
  acpHostSocketPath,
  assertSocketDirPrivate,
  acpHostStopFilePath,
  busTextProblem,
  readFrames,
  tokensMatch,
  writeFrame,
} from './host-ipc.ts';
import { PromptQueue, driveAcpSession } from './session.ts';
import { SessionLog } from './session-log.ts';
import type { AcpHostRunSpec } from './host.ts';
import type { SessionResult } from '../types.js';

/**
 * Corps du process HÔTE de session ACP (lancé détaché par `launchAcpHost`,
 * entrée `host-entry.js`). Il possède la session — le process de l'agent est
 * son enfant — et l'expose sur un canal local :
 *  - le PROPRIÉTAIRE (le process qui supervise le cycle autonome) reçoit le
 *    résultat et peut annuler ; s'il disparaît (connexion coupée, PID mort),
 *    la session est annulée : FAIL CLOSED, jamais une session orpheline qui
 *    continuerait d'écrire dans un clone que plus personne ne surveille ;
 *  - les clients du BUS (`watch --ui`) ne peuvent qu'ajouter un prompt
 *    humain à la file (Phase E du bus `@agent`).
 * Arrêt propre : demande d'arrêt sur disque (`stopAcpHost`, src/stop-request.js)
 * ou signal — la session est annulée (`session/cancel`, puis kill).
 *
 * Socle du futur proxy ACP (lot I10) : `closeWhenIdle: false` garde la
 * session ouverte entre les prompts jusqu'à l'annulation du propriétaire.
 */

/** Délai laissé au propriétaire pour s'annoncer avant d'être tenu pour absent. */
const OWNER_HELLO_GRACE_MS = 30_000;
/** Délai laissé à un client pour envoyer sa frame `hello`. */
const HELLO_TIMEOUT_MS = 5_000;
const OWNER_POLL_MS = 1_000;
/** Pas d'attente d'un propriétaire qui arrive après la fin de session. */
const OWNER_LATE_POLL_MS = 50;
/** Étiquette d'un prompt du bus (opaque, rendue avec son tour au propriétaire). */
const PROMPT_TAG_RE = /^[A-Za-z0-9_-]{1,64}$/;
/**
 * Borne d'une frame `update` relayée au propriétaire, sous MAX_FRAME_BYTES
 * (une frame plus grosse serait écartée par le lecteur) : au-delà, un avis
 * explicite remplace la mise à jour — jamais une perte silencieuse.
 */
const MAX_RELAYED_UPDATE_BYTES = 900_000;
/** Événements retenus avant la première connexion du propriétaire. */
const MAX_OWNER_BACKLOG = 2_000;
const MAX_OWNER_BACKLOG_BYTES = 8_000_000;

export async function runAcpHost(spec: AcpHostRunSpec): Promise<void> {
  const { root, agent } = spec;
  const log = new SessionLog(spec.logPath);
  await log.open(
    `[acp] ${`${spec.profile.command} ${(spec.profile.args ?? []).join(' ')}`.trim()} (cwd: ${spec.cwd})\n` +
      `[acp] hôte de session persistant (PID ${process.pid})\n`,
  );

  const abort = new AbortController();
  const stopWith = (reason: string) => {
    if (abort.signal.aborted) return;
    log.append(`\n[hôte] ${reason} → session annulée\n`);
    abort.abort();
  };

  const queue = new PromptQueue(spec.initialPrompt, { closeWhenIdle: spec.closeWhenIdle });
  let owner: net.Socket | null = null;
  let ownerSeen = false;
  let result: SessionResult | null = null;
  /** Le résultat est déjà parti (propriétaire arrivé APRÈS la fin de session). */
  let resultDelivered = false;
  let control: { cancelTurn: () => boolean } | null = null;
  let inTurn = false;
  let pendingTurnCancel = false;
  /** Événement de déroulé vers le propriétaire (le proxy `striart acp` les relaie à l'IDE). */
  // La session démarre dès la réception de la spec, le propriétaire se
  // connecte un instant plus tard : ce qui précède sa connexion est retenu
  // (borné) et rejoué à son arrivée — le premier tour n'est jamais amputé.
  const backlog: Record<string, unknown>[] = [];
  let backlogBytes = 0;
  let backlogDropped = 0;
  const toOwner = (frame: Record<string, unknown>) => {
    if (owner) {
      writeFrame(owner, frame);
      return;
    }
    if (ownerSeen) return; // Propriétaire parti : la session est annulée de toute façon.
    const bytes = Buffer.byteLength(JSON.stringify(frame));
    if (backlog.length < MAX_OWNER_BACKLOG && backlogBytes + bytes <= MAX_OWNER_BACKLOG_BYTES) {
      backlog.push(frame);
      backlogBytes += bytes;
    } else backlogDropped += 1;
  };
  const flushBacklog = (socket: net.Socket) => {
    for (const frame of backlog.splice(0)) writeFrame(socket, frame);
    backlogBytes = 0;
    if (backlogDropped > 0) {
      writeFrame(socket, {
        type: 'update',
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: {
            type: 'text',
            text: `\n[striart] ${backlogDropped} early agent update(s) were not relayed — see the session log.\n`,
          },
        },
      });
      backlogDropped = 0;
    }
  };
  const relayUpdate = (update: Record<string, unknown>) => {
    if (!owner && ownerSeen) return;
    const bytes = Buffer.byteLength(JSON.stringify(update));
    if (bytes <= MAX_RELAYED_UPDATE_BYTES) {
      toOwner({ type: 'update', update });
      return;
    }
    toOwner({
      type: 'update',
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: {
          type: 'text',
          text: `\n[striart] an agent update of ${bytes} bytes was too large to relay — see the session log.\n`,
        },
      },
    });
  };

  const server = net.createServer((socket) => {
    socket.on('error', () => {
      // Client coupé : sa fermeture est traitée par 'close'.
    });
    let role: 'owner' | 'bus' | null = null;
    const helloTimer = setTimeout(() => socket.destroy(), HELLO_TIMEOUT_MS);
    socket.on('close', () => {
      clearTimeout(helloTimer);
      if (role === 'owner' && owner === socket) {
        owner = null;
        if (!result) stopWith('propriétaire déconnecté');
      }
    });
    void (async () => {
      for await (const frame of readFrames(socket)) {
        if (role === null) {
          clearTimeout(helloTimer);
          if (frame.type !== 'hello' || frame.version !== HOST_PROTOCOL_VERSION) {
            writeFrame(socket, {
              type: 'refused',
              code: 'ACP_HOST_PROTOCOL',
              message: 'hello expected',
            });
            socket.end();
            return;
          }
          if (frame.role === 'owner' && tokensMatch(spec.ownerToken, frame.token) && !owner) {
            role = 'owner';
            owner = socket;
            ownerSeen = true;
            writeFrame(socket, { type: 'welcome', role, agent });
            flushBacklog(socket);
            if (result) {
              writeFrame(socket, { type: 'result', result });
              resultDelivered = true;
            }
            continue;
          }
          if (frame.role === 'bus' && tokensMatch(spec.busToken, frame.token)) {
            role = 'bus';
            writeFrame(socket, { type: 'welcome', role, agent });
            continue;
          }
          writeFrame(socket, {
            type: 'refused',
            code: 'ACP_HOST_AUTH_FAILED',
            message: 'invalid token',
          });
          socket.end();
          return;
        }
        if (role === 'owner' && frame.type === 'cancel') {
          stopWith('annulation demandée par le propriétaire');
          continue;
        }
        // Proxy `striart acp` (lot I10) : annulation du SEUL tour en cours
        // (session/cancel de l'IDE), et fin de session PROPRE demandée par le
        // propriétaire (la file se ferme, le tour en cours se termine, puis
        // session/close) — distincte de `cancel`, qui annule la session.
        if (role === 'owner' && frame.type === 'cancel-turn') {
          const sent = inTurn ? (control?.cancelTurn() ?? false) : false;
          // Session amont pas encore ouverte (handshake en cours) : l'annulation
          // vise le premier tour, appliquée dès qu'il démarre — jamais perdue.
          if (!sent) pendingTurnCancel = true;
          log.append(
            `\n[hôte] annulation du tour demandée par le propriétaire${sent ? '' : ' (appliquée au démarrage du tour)'}\n`,
          );
          continue;
        }
        if (role === 'owner' && frame.type === 'close') {
          log.append('\n[hôte] fin de session demandée par le propriétaire\n');
          queue.close();
          continue;
        }
        if (role === 'bus' && frame.type === 'prompt') {
          writeFrame(socket, handleBusPrompt(frame));
          continue;
        }
        writeFrame(socket, {
          type: 'refused',
          code: 'ACP_HOST_PROTOCOL',
          message: 'unexpected frame',
        });
      }
    })().catch(() => socket.destroy());
  });

  /** Un message humain du bus devient un prompt de la file — jamais rien d'autre. */
  const handleBusPrompt = (frame: Record<string, unknown>): Record<string, unknown> => {
    if (!spec.options.bus) {
      log.append('\n[bus] message humain refusé (acp.bus: false)\n');
      return {
        type: 'refused',
        code: 'ACP_BUS_DISABLED',
        message: 'bus messages are disabled for this profile',
      };
    }
    const problem =
      frame.origin !== 'human'
        ? 'origin must be human'
        : frame.tag != null && !(typeof frame.tag === 'string' && PROMPT_TAG_RE.test(frame.tag))
          ? 'tag is invalid'
          : busTextProblem(frame.text);
    if (problem) return { type: 'refused', code: 'ACP_PROMPT_INVALID', message: problem };
    const position = abort.signal.aborted
      ? null
      : queue.enqueue(
          [{ type: 'text', text: frame.text as string }],
          typeof frame.tag === 'string' ? frame.tag : null,
        );
    if (position === null) {
      return { type: 'refused', code: 'ACP_SESSION_CLOSING', message: 'the session is closing' };
    }
    log.append(`\n[bus] message humain reçu via watch --ui — en file (position ${position})\n`);
    return { type: 'ack', position };
  };

  const socketPath = acpHostSocketPath(root, agent);
  if (process.platform !== 'win32') {
    await assertSocketDirPrivate(socketPath, { create: true });
    await mkdirPrivate(path.dirname(socketPath));
    await rm(socketPath, { force: true });
  }
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => {
      server.off('error', reject);
      resolve();
    });
  });
  if (process.platform !== 'win32') await chmod(socketPath, 0o600);
  await writeJsonAtomic(acpHostReadyFilePath(root, agent), {
    pid: process.pid,
    readyAt: new Date().toISOString(),
  });

  // Propriétaire : PID mort, ou jamais connecté dans le délai → fail closed.
  const startedAt = Date.now();
  const ownerWatch = setInterval(() => {
    if (!isProcessAlive(spec.ownerPid)) stopWith(`propriétaire disparu (PID ${spec.ownerPid})`);
    else if (!ownerSeen && Date.now() - startedAt > OWNER_HELLO_GRACE_MS)
      stopWith('propriétaire jamais connecté');
  }, OWNER_POLL_MS);
  ownerWatch.unref();
  const stopWatch = watchStopRequest(acpHostStopFilePath(root, agent), {
    onStop: () => stopWith('arrêt demandé (stopAcpHost)'),
  });
  const onSignal = () => stopWith('signal reçu');
  process.on('SIGTERM', onSignal);
  process.on('SIGINT', onSignal);

  try {
    result = await driveAcpSession(
      {
        root,
        agent,
        taskId: spec.taskId,
        cwd: spec.cwd,
        profile: spec.profile,
        profileKey: spec.profileKey,
        options: spec.options,
        env: process.env,
        mcpServers: spec.mcpServers,
      },
      queue,
      { signal: abort.signal, timeoutMs: spec.timeoutMs },
      log,
      {
        onTurnStart: (turn, source, tag) => {
          logger.info({ agent, turn, source }, 'Hôte ACP : tour de session');
          inTurn = true;
          toOwner({ type: 'turn', phase: 'start', turn, source, tag });
          if (pendingTurnCancel) {
            pendingTurnCancel = false;
            // Après l'envoi du session/prompt (écrit dans ce même tour de boucle).
            setImmediate(() => control?.cancelTurn());
          }
        },
        onTurnEnd: (turn, stopReason, tag) => {
          inTurn = false;
          toOwner({ type: 'turn', phase: 'end', turn, stopReason, tag });
        },
        onUpdate: relayUpdate,
        onControl: (c) => {
          control = c;
        },
      },
    );
  } catch (error) {
    // driveAcpSession ne lève pas pour un échec de l'agent : ceci est un bug
    // de Striart — rapporté au propriétaire comme un échec, jamais un vert.
    logger.error({ err: error, agent }, 'Hôte ACP : échec inattendu');
    result = {
      status: 'FAILED',
      agent,
      exitCode: null,
      durationMs: Date.now() - startedAt,
      timedOut: false,
      logPath: log.path,
      command: spec.profile.command,
      stopReason: null,
      turns: 0,
      errorCode: 'ACP_HOST_FAILED',
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    clearInterval(ownerWatch);
    stopWatch();
    process.off('SIGTERM', onSignal);
    process.off('SIGINT', onSignal);
  }

  // Une session qui finit VITE (binaire introuvable, refus au handshake) peut
  // se terminer avant que le propriétaire ait ouvert son canal : démonter le
  // socket maintenant lui rendrait « hôte injoignable » et perdrait le
  // résultat. L'hôte l'attend donc — borné, tant que son PID vit, et seulement
  // si la session s'est terminée D'ELLE-MÊME : un arrêt demandé (stopAcpHost,
  // signal, propriétaire disparu) démonte aussitôt, comme avant.
  if (!owner && !ownerSeen && !abort.signal.aborted) {
    const deadline = Date.now() + OWNER_HELLO_GRACE_MS;
    while (!owner && !ownerSeen && Date.now() < deadline && isProcessAlive(spec.ownerPid)) {
      await new Promise((resolve) => setTimeout(resolve, OWNER_LATE_POLL_MS));
    }
  }

  // Le résultat part au propriétaire AVANT le démontage : c'est lui qui
  // dépubliera la session (SESSION_LIVE) puis mergera.
  const ownerSocket = owner as net.Socket | null;
  if (ownerSocket) {
    if (!resultDelivered) writeFrame(ownerSocket, { type: 'result', result });
    await new Promise<void>((resolve) => {
      ownerSocket.end(() => resolve());
      setTimeout(resolve, 2_000).unref();
    });
  }
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await releaseOwnFiles(root, agent);
  await log.flush();
}

/** Retire les fichiers d'état de l'hôte — seulement s'ils désignent CE process. */
async function releaseOwnFiles(root: string, agent: string): Promise<void> {
  const ownedBy = async (file: string) => {
    try {
      return (JSON.parse(await readFile(file, 'utf8')) as { pid?: number }).pid === process.pid;
    } catch {
      return false; // Absent ou illisible : rien à retirer.
    }
  };
  const pidFile = acpHostPidFilePath(root, agent);
  // Le PID file désigne ce process : les autres fichiers d'état sont les siens.
  if (!(await ownedBy(pidFile))) return;
  await rm(acpHostReadyFilePath(root, agent), { force: true });
  await rm(acpBusTokenPath(root, agent), { force: true });
  await rm(pidFile, { force: true });
  await clearStopRequest(acpHostStopFilePath(root, agent), process.pid);
  if (process.platform !== 'win32') await rm(acpHostSocketPath(root, agent), { force: true });
}

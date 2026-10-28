/**
 * État (lecture seule) du process hôte de pty d'un agent : son PID file et
 * sa vitalité. Séparé de `pty-host.ts` (qui démarre et arrête l'hôte) pour
 * que les modules de plus bas niveau — `clone.js` et son `listAgents` —
 * puissent lire cet état sans dépendre de `pty-host.ts`, qui dépend
 * lui-même de `clone.js`.
 */
import { createHash } from 'node:crypto';
import { open, readFile } from 'node:fs/promises';
import path from 'node:path';
import { MAX_UNIX_SOCKET_PATH, privateTmpDir, ptyDir } from './paths.js';
import { checkProcessInstance } from './process-info.ts';
import type { ExpectedStriartProcess } from './process-info.ts';

export interface PtyHostStatus {
  running: boolean;
  stale: boolean;
  /** Vivant ET reconnu : seul cas où l'hôte peut être arrêté (jamais un PID non identifié). */
  verified: boolean;
  pid: number | null;
  startedAt: string | null;
  /**
   * Implémentation de l'hôte publié : `native` (binaire striart-native,
   * depuis le lot R2) ou `node` (hôte node-pty d'une version antérieure,
   * encore vivant après une mise à jour). null sans PID file.
   */
  implementation: 'native' | 'node' | null;
}

interface PidFileContent {
  pid: number;
  startedAt: string;
  implementation?: string;
  /** Nom du binaire natif (`striart-native.exe`), écrit par l'hôte lui-même. */
  program?: string;
  /** PID du programme hébergé (shell, outil de coding). */
  childPid?: number;
}

/**
 * Dossier d'état de l'hôte d'un agent (PID file, demande d'arrêt, socket
 * POSIX). Le binaire natif exige que le socket d'attache soit exactement
 * `<ce dossier>/attach.sock` (PTY_ENDPOINT_TOO_LONG / USAGE sinon) : repli
 * vers un dossier privé par utilisateur si le chemin naturel sous
 * `.striart/pty/` ferait dépasser la limite des sockets Unix (104 octets
 * macOS / 108 Linux) — observé en CI sur un dépôt temporaire profondément
 * imbriqué (macOS). Windows n'a pas cette limite (named pipe, espace de noms
 * global) : toujours le chemin naturel.
 */
export function ptyHostStateDir(root: string, agent: string): string {
  const inRepo = path.join(ptyDir(root), agent);
  if (process.platform === 'win32') return inRepo;
  if (Buffer.byteLength(path.join(inRepo, 'attach.sock')) <= MAX_UNIX_SOCKET_PATH) return inRepo;
  const hash = createHash('sha256')
    .update(`${path.resolve(root)}\0${agent}`)
    .digest('hex');
  return path.join(privateTmpDir(), `pty-${hash.slice(0, 24)}`);
}

export function ptyHostPidFilePath(root: string, agent: string): string {
  return path.join(ptyHostStateDir(root, agent), 'host.pid');
}

/** Demande d'arrêt propre de l'hôte (voir stop-request.js). */
export function ptyHostStopFilePath(root: string, agent: string): string {
  return path.join(ptyHostStateDir(root, agent), 'host.stop');
}

/** Dernière sortie du pty publiée par l'hôte natif (`{pid, lastOutputAt}`, voir files.rs). */
export function ptyHostOutputFilePath(root: string, agent: string): string {
  return path.join(ptyHostStateDir(root, agent), 'host.output');
}

/** Taille maximale lue : le document réel fait ~60 octets, au-delà le fichier est refusé. */
const OUTPUT_FILE_MAX_BYTES = 1024;
const ISO_MILLIS_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/**
 * Instant (ms epoch) de la dernière sortie du pty de `agent`, publié par l'hôte natif, ou
 * null quand il n'est PAS observé : fichier absent (hôte d'une version antérieure, programme
 * encore silencieux), trop gros, illisible, JSON invalide, horodatage mal formé, ou publié par
 * un AUTRE process que l'hôte attendu (PID différent : reliquat d'un hôte mort). Lecture
 * bornée, jamais d'exception : null = « sortie inobservable », que le GC traite en fail closed
 * (aucune fermeture sans `idle.closePty`).
 */
export async function readPtyHostLastOutput(
  root: string,
  agent: string,
  hostPid: number,
): Promise<number | null> {
  let handle;
  try {
    handle = await open(ptyHostOutputFilePath(root, agent), 'r');
    const buffer = Buffer.alloc(OUTPUT_FILE_MAX_BYTES + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead === 0 || bytesRead > OUTPUT_FILE_MAX_BYTES) return null;
    const doc: unknown = JSON.parse(buffer.toString('utf8', 0, bytesRead));
    if (typeof doc !== 'object' || doc === null) return null;
    const { pid, lastOutputAt } = doc as { pid?: unknown; lastOutputAt?: unknown };
    if (pid !== hostPid) return null;
    if (typeof lastOutputAt !== 'string' || !ISO_MILLIS_UTC.test(lastOutputAt)) return null;
    const at = Date.parse(lastOutputAt);
    return Number.isFinite(at) ? at : null;
  } catch {
    // Absent, en cours de remplacement (Windows) ou illisible : inobservable.
    return null;
  } finally {
    await handle?.close().catch(() => {});
  }
}

export async function readPtyHostPidFile(
  root: string,
  agent: string,
): Promise<PidFileContent | null> {
  try {
    const raw = JSON.parse(await readFile(ptyHostPidFilePath(root, agent), 'utf8'));
    return Number.isInteger(raw?.pid) && raw.pid > 0 ? raw : null;
  } catch {
    // Absent, en cours d'écriture (renommage atomique côté hôte) ou
    // illisible : aucun hôte publié.
    return null;
  }
}

/** Nom de binaire sûr (aucun séparateur de chemin) : `striart-native`, `striart-native.exe`… */
const PROGRAM_NAME_RE = /^[A-Za-z0-9._-]{1,128}$/;

/**
 * Identité attendue du process publié. Hôte natif : `<binaire> pty-host
 * --agent <agent>` (le nom du binaire vient du PID file que l'hôte a écrit
 * lui-même — `STRIART_NATIVE_BIN` peut désigner un fichier renommé) ; hôte
 * Node d'une version antérieure : `node …/cli.js pty-host-run <agent>`, pour
 * qu'une mise à jour ne fasse ni oublier ni tuer à l'aveugle un hôte encore
 * vivant.
 */
export function expectedPtyHostIdentity(
  agent: string,
  info: PidFileContent,
): { implementation: 'native' | 'node'; expected: ExpectedStriartProcess } {
  if (
    info.implementation === 'native' &&
    typeof info.program === 'string' &&
    PROGRAM_NAME_RE.test(info.program)
  ) {
    return {
      implementation: 'native',
      expected: {
        scriptName: info.program,
        imageName: info.program,
        args: ['pty-host', '--agent', agent],
        startedAt: info.startedAt,
      },
    };
  }
  return {
    implementation: 'node',
    expected: { scriptName: 'cli.js', args: ['pty-host-run', agent], startedAt: info.startedAt },
  };
}

/**
 * Un PID file dont le process est mort — ou dont le numéro a été recyclé par
 * l'OS au profit d'un autre process — est signalé `stale`, jamais nettoyé
 * silencieusement ici. L'hôte est reconnu à sa ligne de commande
 * (`expectedPtyHostIdentity`) et à son heure de création (un process créé
 * après la publication du PID n'est pas l'hôte publié) : un PID recyclé cru
 * vivant bloquait `cleanClones` (SESSION_LIVE) et `ensurePtyHost` à vie, et
 * `stopPtyHost` tuait un process innocent. Une identité illisible (autre
 * utilisateur) compte comme vivante : fail closed.
 *
 * `fresh` : identité relue sans cache — obligatoire avant d'arrêter l'hôte
 * ou de décider de le réutiliser.
 */
export async function ptyHostStatus(
  root: string,
  agent: string,
  { fresh = false }: { fresh?: boolean } = {},
): Promise<PtyHostStatus> {
  const info = await readPtyHostPidFile(root, agent);
  if (!info) {
    return {
      running: false,
      stale: false,
      verified: false,
      pid: null,
      startedAt: null,
      implementation: null,
    };
  }
  const { implementation, expected } = expectedPtyHostIdentity(agent, info);
  const verdict = await checkProcessInstance(info.pid, expected, { cache: !fresh });
  const alive = verdict === 'alive' || verdict === 'unverified';
  return {
    running: alive,
    stale: !alive,
    verified: verdict === 'alive',
    pid: info.pid,
    startedAt: info.startedAt,
    implementation,
  };
}

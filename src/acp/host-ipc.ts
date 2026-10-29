import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { lstat, mkdir } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { StriartError } from '../errors.ts';
import { MAX_UNIX_SOCKET_PATH, privateTmpDir, striartDir } from '../paths.ts';
import { validateAgentName } from '../agent-name.ts';
import { boundedLines } from '../line-reader.ts';

/**
 * Canal local de l'hôte de session ACP persistant : chemins, cadrage ndjson
 * et jetons. Même famille que le canal d'attache du pty (`pty-attach.ts`) —
 * named pipe sous Windows, socket Unix (0600) ailleurs, JAMAIS une adresse
 * réseau — avec une défense en plus : chaque client s'annonce avec un jeton.
 *  - jeton PROPRIÉTAIRE : transmis à l'hôte par son stdin, gardé en mémoire
 *    par le process qui supervise la session (jamais sur disque) — seul lui
 *    peut annuler la session et reçoit son résultat ;
 *  - jeton BUS : écrit dans `.striart/acp/<agent>/bus.token` (0600) pour les
 *    clients du bus `@agent` (`watch --ui`) — il ne permet QUE d'ajouter un
 *    prompt humain à la file. Il borne le canal aux comptes capables de lire
 *    `.striart/` (la DACL par défaut d'un named pipe Windows n'a pas été
 *    vérifiée indépendamment, SECURITY.md).
 */

/** Version du protocole hôte ↔ clients (ndjson). */
export const HOST_PROTOCOL_VERSION = 1;
/** Borne d'une frame reçue par l'hôte ou par un client. */
export const MAX_FRAME_BYTES = 1_000_000;
/** Borne d'un message humain du bus (caractères). */
export const MAX_BUS_TEXT_CHARS = 64_000;

export function acpHostDir(root: string, agent: string): string {
  validateAgentName(agent);
  return path.join(striartDir(root), 'acp', agent);
}

export const acpHostPidFilePath = (root: string, agent: string) =>
  path.join(acpHostDir(root, agent), 'host.pid');
export const acpHostStopFilePath = (root: string, agent: string) =>
  path.join(acpHostDir(root, agent), 'host.stop');
export const acpHostReadyFilePath = (root: string, agent: string) =>
  path.join(acpHostDir(root, agent), 'host.ready');
export const acpBusTokenPath = (root: string, agent: string) =>
  path.join(acpHostDir(root, agent), 'bus.token');
export const acpHostLogPath = (root: string, agent: string) =>
  path.join(striartDir(root), 'logs', `acp-host-${agent}.log`);

/**
 * Chemin du canal de l'hôte d'un agent. Windows : espace de noms global des
 * named pipes, nom dérivé par hash de la racine (deux dépôts, même nom
 * d'agent : pas de collision). POSIX : sous `.striart/acp/<agent>/`, ou dans
 * le dossier temporaire si ce chemin dépasse la limite des sockets Unix.
 */
export function acpHostSocketPath(root: string, agent: string): string {
  validateAgentName(agent);
  const hash = createHash('sha256')
    .update(`${path.resolve(root)}\0${agent}`)
    .digest('hex');
  if (process.platform === 'win32') return `\\\\.\\pipe\\striart-acp-${hash.slice(0, 12)}-${agent}`;
  const inRepo = path.join(acpHostDir(root, agent), 'host.sock');
  if (Buffer.byteLength(inRepo) <= MAX_UNIX_SOCKET_PATH) return inRepo;
  // Repli : un dossier PRIVÉ par utilisateur (jamais un nom prévisible dans
  // le dossier temporaire partagé, que n'importe quel utilisateur local peut
  // squatter — S-M9). Voir assertSocketDirPrivate.
  return path.join(privateTmpDir(), `acp-${hash.slice(0, 24)}.sock`);
}

/**
 * Le socket est-il dans le dossier privé de repli ? Si oui, ce dossier est
 * créé (`create`) ou seulement contrôlé, et REFUSÉ s'il n'est pas un vrai
 * dossier (pas un lien), à l'utilisateur courant, fermé au groupe et aux
 * autres : sinon un autre utilisateur local pourrait l'avoir pré-créé, voir
 * le jeton que le propriétaire envoie et forger la trame `result` (fail
 * closed). Sans effet pour un socket sous `.striart/` et sous Windows.
 */
export async function assertSocketDirPrivate(
  socketPath: string,
  { create }: { create: boolean },
): Promise<void> {
  if (process.platform === 'win32') return;
  const dir = path.dirname(socketPath);
  if (dir !== privateTmpDir()) return;
  if (create)
    await mkdir(dir, { mode: 0o700 }).catch((error) => {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    });
  const info = await lstat(dir);
  const uid = typeof process.getuid === 'function' ? process.getuid() : info.uid;
  if (!info.isDirectory() || info.uid !== uid || (info.mode & 0o077) !== 0) {
    throw new StriartError(
      `The private socket folder ${dir} is not safe (must be a real directory owned by you, mode 0700): refused.`,
      {
        code: 'ACP_SOCKET_DIR_UNSAFE',
        hint: `Inspect and remove it (rm -r ${dir}), then retry.`,
        details: { path: dir },
      },
    );
  }
}

export function newToken(): string {
  return randomBytes(32).toString('hex');
}

/** Comparaison à temps constant (aucune fuite de préfixe par le timing). */
export function tokensMatch(expected: string, received: unknown): boolean {
  if (typeof received !== 'string') return false;
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(received, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

export function writeFrame(socket: net.Socket, frame: Record<string, unknown>): void {
  if (!socket.destroyed && socket.writable) socket.write(`${JSON.stringify(frame)}\n`);
}

/**
 * Lit les frames d'une connexion (bornées, JSON objet uniquement). Une frame
 * trop longue ou illisible est écartée et signalée, jamais interprétée.
 */
export async function* readFrames(
  socket: net.Socket,
  onInvalid: (reason: string) => void = () => {},
): AsyncGenerator<Record<string, unknown>> {
  for await (const line of boundedLines(socket, {
    maxLineBytes: MAX_FRAME_BYTES,
    encoding: 'utf8',
    onOverflow: () => onInvalid('frame too large'),
  })) {
    if (line.length === 0) continue;
    let frame: unknown;
    try {
      frame = JSON.parse(line);
    } catch {
      onInvalid('invalid JSON');
      continue;
    }
    if (frame === null || typeof frame !== 'object' || Array.isArray(frame)) {
      onInvalid('frame must be an object');
      continue;
    }
    yield frame as Record<string, unknown>;
  }
}

/**
 * Texte humain recevable comme prompt supplémentaire : non vide, borné, sans
 * NUL ni caractère de contrôle autre que tabulation et sauts de ligne. Le
 * texte reste de la DONNÉE (bloc de contenu du protocole), jamais un argv
 * ni un shell.
 */
export function busTextProblem(text: unknown): string | null {
  if (typeof text !== 'string') return 'text must be a string';
  if (text.trim().length === 0) return 'text is empty';
  if (text.length > MAX_BUS_TEXT_CHARS) return 'text is too long';
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text))
    return 'text contains control characters';
  return null;
}

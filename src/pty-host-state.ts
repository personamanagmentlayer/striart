/**
 * État (lecture seule) du process hôte de pty d'un agent : son PID file et
 * sa vitalité. Séparé de `pty-host.ts` (qui démarre et arrête l'hôte) pour
 * que les modules de plus bas niveau — `clone.js` et son `listAgents` —
 * puissent lire cet état sans dépendre de `pty-host.ts`, qui dépend
 * lui-même de `clone.js`.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { ptyDir } from './paths.js';
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

/** Dossier d'état de l'hôte d'un agent (PID file, demande d'arrêt, socket POSIX). */
export function ptyHostStateDir(root: string, agent: string): string {
  return path.join(ptyDir(root), agent);
}

export function ptyHostPidFilePath(root: string, agent: string): string {
  return path.join(ptyHostStateDir(root, agent), 'host.pid');
}

/** Demande d'arrêt propre de l'hôte (voir stop-request.js). */
export function ptyHostStopFilePath(root: string, agent: string): string {
  return path.join(ptyHostStateDir(root, agent), 'host.stop');
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

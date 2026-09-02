import { execa } from 'execa';

/**
 * Le process existe-t-il encore ? `kill(pid, 0)` ne tue rien : il teste la
 * délivrabilité du signal, donc l'existence du process.
 *
 * Limite assumée : un PID peut être recyclé par l'OS après la mort de son
 * propriétaire. Ce signal est donc utilisé pour DÉCIDER DE S'ABSTENIR (ne pas
 * rebaser, ne pas supprimer), jamais pour autoriser une action destructive —
 * un faux positif fait patienter, ce qui est sans conséquence.
 *
 * @param {number|null|undefined} pid
 * @returns {boolean}
 */
export function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Normalise un code de sortie Windows en entier signé lisible.
 *
 * Windows rend les codes de sortie en uint32 : un process qui meurt sur
 * -4058 (ENOENT) ressort en 4294963238, illisible dans un log ou un ticket.
 * Les valeurs au-dessus de 2^31-1 sont repliées en signé (complément à deux) ;
 * tout le reste — codes POSIX, null d'un process tué par signal — passe tel
 * quel. Ne change jamais la sémantique du succès : 0 reste 0.
 *
 * @param {number|null|undefined} exitCode
 * @returns {number|null}
 */
export function normalizeExitCode(exitCode) {
  if (!Number.isInteger(exitCode)) return exitCode ?? null;
  return exitCode > 0x7fffffff ? exitCode - 0x1_0000_0000 : exitCode;
}

/**
 * Tue l'arbre de processus complet d'un subprocess execa.
 *
 * Tuer le process de tête seul laisse les petits-fils vivants (node, pytest,
 * le vrai binaire d'un agent lancé via un wrapper...) et surtout leurs flux de
 * sortie ouverts : l'attente du parent resterait bloquée indéfiniment.
 *
 * Deux stratégies, imposées par l'OS :
 *  - Windows : `taskkill /T /F` descend l'arbre par PID parent.
 *  - POSIX   : le subprocess est lancé `detached`, donc chef de son groupe ;
 *              `kill(-pid)` atteint tout le groupe d'un bloc. Repli sur le
 *              process seul si le groupe a déjà disparu.
 *
 * Ne throw jamais : c'est un chemin de nettoyage, appelé sur expiration de
 * délai ou sur annulation, où l'échec ne doit pas masquer la cause initiale.
 *
 * @param {{pid?: number, kill: (...args: any[]) => unknown}} subprocess
 * @returns {Promise<void>}
 */
export async function killProcessTree(subprocess) {
  if (!subprocess?.pid) {
    // Process déjà sorti (ou jamais démarré) : rien à tuer.
    return;
  }
  if (process.platform === 'win32') {
    await execa('taskkill', ['/pid', String(subprocess.pid), '/T', '/F'], { reject: false });
    return;
  }
  try {
    process.kill(-subprocess.pid, 'SIGKILL'); // groupe de process (detached)
  } catch {
    try {
      subprocess.kill('SIGKILL');
    } catch {
      // Le process est déjà mort : rien à faire.
    }
  }
}

import { logger } from './logger.ts';
import { nativeTreeKill } from './native.ts';

/**
 * Le process existe-t-il encore ? `kill(pid, 0)` ne tue rien : il teste la
 * délivrabilité du signal, donc l'existence du process.
 *
 * `EPERM` signifie que le process existe mais appartient à un autre
 * utilisateur (session lancée via sudo, service…) : il est VIVANT. Le
 * confondre avec `ESRCH` désarmait toutes les gardes qui reposent sur ce
 * signal.
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
  } catch (error) {
    return error?.code === 'EPERM';
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
 * Mécanisme : `striart-native proc tree-kill` (src/native.ts) — descendants
 * énumérés depuis un instantané complet de l'OS, liens parent → enfant
 * vérifiés par l'ordre des créations (un PID parent recyclé ne rattache
 * aucun innocent), kill de haut en bas en plusieurs passes ; sous POSIX, les
 * membres du groupe dont le subprocess (lancé `detached`) est chef sont
 * atteints même quand leur parent est déjà mort.
 *
 * Ne throw jamais : c'est un chemin de nettoyage, appelé sur expiration de
 * délai ou sur annulation (souvent en `void`), où l'échec ne doit pas masquer
 * la cause initiale. Un binaire natif indisponible n'est pas pour autant
 * passé sous silence : l'erreur (code NATIVE_*) est journalisée au niveau
 * error, puis le subprocess lui-même est tué — le minimum qui libère
 * l'appelant (sous POSIX, le groupe entier : `kill(-pid)`).
 *
 * @param {{pid?: number, kill: (...args: any[]) => unknown}} subprocess
 * @param {{treeKill?: (pid: number, options?: {rootStartedMs?: number | null}) => Promise<unknown>, rootStartedMs?: number | null}} [deps]
 *   `treeKill` : injection (tests). `rootStartedMs` : heure de création de la racine,
 *   telle que lue par `readProcessInfos` — le binaire natif refuse alors une racine
 *   dont le PID a changé de propriétaire (S-M2) ; sans elle, il ne la protège pas.
 * @returns {Promise<void>}
 */
export async function killProcessTree(
  subprocess,
  { treeKill = nativeTreeKill, rootStartedMs = null } = {},
) {
  if (!subprocess?.pid) {
    // Process déjà sorti (ou jamais démarré) : rien à tuer.
    return;
  }
  try {
    const result =
      /** @type {{failed?: {pid: number, reason: string}[], complete?: boolean, survivors?: {pid: number}[]}} */ await (rootStartedMs ===
      null
        ? treeKill(subprocess.pid)
        : treeKill(subprocess.pid, { rootStartedMs }));
    if (result?.complete === false) {
      // L'arbre n'est PAS éteint : jamais présenté comme un succès. Le
      // chemin de nettoyage ne lève pas (voir plus haut), mais l'erreur est
      // nommée (JOB_TERMINATE_INCOMPLETE) pour qui lit le journal.
      logger.error(
        {
          code: 'JOB_TERMINATE_INCOMPLETE',
          pid: subprocess.pid,
          survivors: (result.survivors ?? []).slice(0, 16).map((s) => s.pid),
          hint: 'tuer ces process à la main (striart doctor)',
        },
        'arbre de process : des descendants ont survécu au nettoyage',
      );
    }
    if (result?.failed?.length) {
      // Process de l'arbre que l'OS refuse de tuer (droits, process
      // protégé) : rien de plus à tenter ici, mais jamais en silence.
      logger.warn(
        { pid: subprocess.pid, failed: result.failed },
        'arbre de process : certains descendants n’ont pas pu être tués',
      );
    }
    return;
  } catch (error) {
    logger.error(
      {
        code: error?.code ?? 'NATIVE_COMMAND_FAILED',
        pid: subprocess.pid,
        hint: error?.hint ?? 'striart doctor',
      },
      `arbre de process non tué par le binaire natif : ${error?.message ?? String(error)} — seul le process de tête est tué`,
    );
  }
  killHeadOnly(subprocess);
}

/** Dernier recours : le subprocess (et, sous POSIX, son groupe). */
function killHeadOnly(subprocess) {
  if (process.platform !== 'win32') {
    try {
      process.kill(-subprocess.pid, 'SIGKILL'); // groupe de process (detached)
      return;
    } catch {
      // Pas de groupe (subprocess non détaché) : le process seul, ci-dessous.
    }
  }
  try {
    subprocess.kill('SIGKILL');
  } catch {
    // Le process est déjà mort : rien à faire.
  }
}

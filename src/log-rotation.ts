/**
 * Rotation des journaux de Striart par TAILLE, sans dépendance : `watch.log`
 * et `dashboard.log` (daemons), `watch-ui.log`. Schéma classique à N
 * générations : `x.log` (courant) → `x.log.1` → … → `x.log.N`, la plus
 * ancienne supprimée. Sans elle, un daemon qui tourne des semaines remplit
 * le disque (constat de l'audit : aucun journal n'était jamais purgé).
 *
 * Deux usages :
 *  - `rotateLogFileIfNeeded` (asynchrone) : avant d'ouvrir un journal (départ
 *    d'un daemon), pour qu'un fichier hérité trop gros soit d'abord tourné ;
 *  - `createRotatingFileSink` (synchrone) : l'écrivain du process qui
 *    possède le journal — il compte les octets écrits et tourne au passage du
 *    seuil. SYNCHRONE par nécessité (exception assumée à « fs/promises
 *    partout ») : c'est le puits de pino et de stdout/stderr ; une ligne
 *    écrite juste avant un `process.exit` ne doit pas être perdue, et pino
 *    lui-même écrit ses fichiers de façon synchrone.
 *
 * Windows : renommer un journal qu'un autre process lit (un `tail`) peut
 * échouer (EPERM/EBUSY). La rotation est alors REPORTÉE (nouvelle tentative
 * après ROTATION_RETRY_FRACTION du seuil), signalée dans le journal lui-même
 * — jamais un blocage de l'écrivain, jamais un échec tu.
 */
import { closeSync, fstatSync, openSync, renameSync, rmSync, writeSync } from 'node:fs';
import { rename, rm, stat } from 'node:fs/promises';

/** Options de rotation d'un journal. */
export interface LogRotation {
  maxBytes: number;
  generations: number;
}

/** Défauts : repris par DEFAULT_CONFIG (logMaxBytes, logGenerations). */
export const DEFAULT_LOG_MAX_BYTES = 10 * 1024 * 1024;
export const DEFAULT_LOG_GENERATIONS = 5;
/** Bornes de validation (config.js et variables d'environnement des daemons). */
export const LOG_MAX_BYTES_MIN = 64 * 1024;
export const LOG_MAX_BYTES_MAX = 1024 * 1024 * 1024;
export const LOG_GENERATIONS_MIN = 1;
export const LOG_GENERATIONS_MAX = 100;
/** Rotation reportée : nouvel essai après ce fraction du seuil écrite en plus. */
const ROTATION_RETRY_FRACTION = 0.1;

/**
 * Options de rotation valides ?
 */
export function isValidRotation(maxBytes: unknown, generations: unknown): boolean {
  return (
    Number.isSafeInteger(maxBytes) &&
    (maxBytes as number) >= LOG_MAX_BYTES_MIN &&
    (maxBytes as number) <= LOG_MAX_BYTES_MAX &&
    Number.isSafeInteger(generations) &&
    (generations as number) >= LOG_GENERATIONS_MIN &&
    (generations as number) <= LOG_GENERATIONS_MAX
  );
}

function generationPath(file: string, generation: number): string {
  return `${file}.${generation}`;
}

/**
 * Tourne `file` si sa taille atteint `maxBytes`. Asynchrone, renommages
 * retentés sur les erreurs passagères de Windows ; une erreur persistante
 * remonte (l'appelant décide — le départ d'un daemon la journalise).
 * Rend vrai si une rotation a eu lieu.
 */
export async function rotateLogFileIfNeeded(
  file: string,
  { maxBytes, generations }: LogRotation,
): Promise<boolean> {
  const stats = await stat(file).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (!stats || stats.size < maxBytes) return false;
  // Chargé à la demande : logger.js importe ce module, json-file importe
  // logger.js — un import statique créerait un cycle au démarrage.
  const { withTransientRetry } = await import('./json-file.js');
  await rm(generationPath(file, generations), { force: true });
  for (let generation = generations - 1; generation >= 1; generation -= 1) {
    await withTransientRetry(() =>
      rename(generationPath(file, generation), generationPath(file, generation + 1)),
    ).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
    });
  }
  await withTransientRetry(() => rename(file, generationPath(file, 1)));
  return true;
}

/**
 * Décalage synchrone des générations. Lève à la première erreur (hors
 * génération absente) : l'appelant reporte la rotation.
 */
function shiftGenerationsSync(file: string, generations: number): void {
  rmSync(generationPath(file, generations), { force: true });
  for (let generation = generations - 1; generation >= 1; generation -= 1) {
    try {
      renameSync(generationPath(file, generation), generationPath(file, generation + 1));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  renameSync(file, generationPath(file, 1));
}

/**
 * Écrivain synchrone d'un journal à rotation par taille.
 */
export function createRotatingFileSink(
  file: string,
  { maxBytes, generations }: LogRotation,
): { write: (chunk: string | Uint8Array) => void; close: () => void } {
  // null : descripteur fermé, réouverture à retenter.
  let fd: number | null = openSync(file, 'a', 0o600);
  let size = fstatSync(fd).size;
  let nextRotationAt = maxBytes;

  const rawWrite = (buffer: Buffer): void => {
    let offset = 0;
    while (offset < buffer.length) offset += writeSync(fd as number, buffer, offset);
    size += buffer.length;
  };

  /** Réouvre le journal ; false (et `fd` reste null) si l'ouverture échoue. */
  const reopen = () => {
    try {
      fd = openSync(file, 'a', 0o600);
      size = fstatSync(fd).size;
      return true;
    } catch (error) {
      // Jamais de descripteur périmé en service (EBADF, ou pire : un numéro
      // recyclé au profit d'un autre fichier) ; la ligne partira sur stderr.
      if (fd !== null) {
        try {
          closeSync(fd);
        } catch {
          // Déjà fermé : rien à faire.
        }
      }
      fd = null;
      lastOpenFailure = (error as NodeJS.ErrnoException).code ?? String(error);
      return false;
    }
  };
  let lastOpenFailure = '';

  const warnLine = (msg: string, err: string): Buffer =>
    Buffer.from(`${JSON.stringify({ level: 40, time: Date.now(), msg, err, file })}\n`, 'utf8');

  const rotate = () => {
    closeSync(fd as number);
    fd = null;
    let failure = null;
    try {
      shiftGenerationsSync(file, generations);
    } catch (error) {
      failure = error;
    }
    if (!reopen()) return; // fd null : le prochain write retente
    if (failure) {
      nextRotationAt = size + Math.ceil(maxBytes * ROTATION_RETRY_FRACTION);
      // Format d'une ligne pino (niveau warn) : lisible par les mêmes outils.
      rawWrite(
        warnLine(
          'Rotation du journal reportée',
          (failure as NodeJS.ErrnoException).code ?? String(failure),
        ),
      );
      return;
    }
    nextRotationAt = maxBytes;
  };

  return {
    write(chunk) {
      const buffer = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : Buffer.from(chunk);
      if (fd === null && !reopen()) {
        // Journal indisponible : la ligne n'est pas perdue en silence.
        process.stderr.write(buffer);
        return;
      }
      if (size > 0 && size + buffer.length > nextRotationAt) {
        rotate();
        if (fd === null) {
          process.stderr.write(
            warnLine('Réouverture du journal impossible après la rotation', lastOpenFailure),
          );
          process.stderr.write(buffer);
          return;
        }
      }
      rawWrite(buffer);
    },
    close() {
      if (fd !== null) closeSync(fd);
      fd = null;
    },
  };
}

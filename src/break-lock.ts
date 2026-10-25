/**
 * Verrou de CASSURE partagé : la brique qui sérialise toute suppression du
 * fichier d'un autre (verrou périmé, ticket orphelin) — commune au verrou
 * principal (`lock.js`, `lock-queue/break.lock`) et au verrou d'état
 * (`state-lock.js`, `state.lock.break`). Source unique : une correction de
 * course s'applique aux deux ou à aucun.
 *
 * Contrat :
 *  - `underBreakLock` exécute `fn` sous le verrou de cassure (création
 *    exclusive `wx`, arbitrée par le noyau) : une seule cassure à la fois, tous
 *    process confondus. `false` si un AUTRE casseur légitime le tient.
 *  - Un verrou de cassure DÉBRIS (voir `isBreakLockDebris`) est repris
 *    ATOMIQUEMENT (`reclaimBreakLock`) : une comparaison suivie d'une
 *    suppression ne suffit pas — deux observateurs d'un même verrou mort
 *    passeraient chacun la comparaison, et le second supprimerait le verrou
 *    NEUF du premier (le verrou serait alors tenu deux fois). La reprise est
 *    donc elle-même sérialisée par un marqueur à création exclusive
 *    (`<verrou de cassure>.reclaim`).
 *  - `removeIfUnchanged` supprime un fichier jugé périmé seulement s'il est
 *    toujours EXACTEMENT celui qui a été jugé (contenu ET mtime), sous le
 *    verrou de cassure, et rend une issue à quatre états
 *    (removed / abstained / busy / failed) : un échec de suppression n'est
 *    jamais pris pour un succès.
 *
 * Rien ici ne connaît le repo : l'appelant fournit un contexte (`BreakContext`).
 */
import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rm, stat } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { logger } from './logger.js';

/** Verrou de cassure vivant mais sans signe de vie depuis ça : tenu à perpétuité par un PID recyclé ou figé. */
export const BREAK_STALE_MS = 30_000;
/** Une défaillance d'E/S répétée à chaque sondage n'est journalisée qu'une fois par minute et par fichier. */
const FAILURE_LOG_EVERY_MS = 60_000;
/** Suppressions d'un verrou de cassure débris : tentatives et attente initiale (doublée à chaque essai). */
const REMOVE_ATTEMPTS = 4;
const REMOVE_RETRY_MS = 25;
/** Tentatives de prise du verrou de cassure (reprise d'un débris comprise). */
const BREAK_TAKE_ATTEMPTS = 3;

/** État lu d'un fichier de verrou ou de ticket. `null` = absent. */
export type LockFileRead =
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- contenu JSON d'un fichier de verrou, champs lus un à un
  | { state: 'ok'; raw: string; info: Record<string, any> }
  | { state: 'invalid'; raw: string }
  | { state: 'unreadable'; cause: string };

/** Contexte d'un verrou de cassure. */
export interface BreakContext {
  /** Chemin du verrou de cassure. */
  file: string;
  /** Dossier créé avant la prise (null : déjà là). */
  ensureDir: string | null;
  /** Erreur d'E/S nommée (fail closed). */
  ioError: (operation: string, file: string, error: unknown) => Error;
  /** Fichiers tenus par ce process (retirés à sa sortie) : fichier → jeton. */
  ownedFiles: Map<string, string>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- PID lu d'un fichier non fiable
  isAlive: (pid: any) => boolean | Promise<boolean>;
  checkInstance: (
    pid: number,
    expected: { scriptName: string; args: string[]; startedAt: string | null },
    options: { cache: false },
  ) => Promise<string>;
  /** Nom du script du process courant (identité enregistrée). */
  scriptName: string | null;
  /** Contenu invalide plus vieux que ça : débris. */
  invalidMs: number;
  /** Vivant sans signe de vie depuis ça : identité vérifiée (défaut BREAK_STALE_MS). */
  staleMs?: number;
  /** Échec d'ouverture passager à traiter comme « présent » (Windows). */
  isTransientOpenError?: (error: unknown) => boolean;
  /** Renseigné par la reprise d'un verrou de cassure débris impossible à supprimer (rendu en issue `failed`). */
  failure?: unknown;
}

/**
 * Issue d'une tentative de suppression d'un fichier jugé périmé :
 *  - `removed`   : le fichier n'existe plus (supprimé par nous, ou déjà parti) ;
 *  - `abstained` : il avait changé depuis le jugement — rien supprimé ;
 *  - `busy`      : un autre casseur vivant opère — rien supprimé ;
 *  - `failed`    : la suppression a échoué et le fichier est toujours là
 *                  (`error` : la cause système).
 */
export type RemovalOutcome =
  { status: 'removed' | 'abstained' | 'busy' } | { status: 'failed'; error: unknown };

const errorCode = (error: unknown): string | undefined => (error as { code?: string })?.code;

const failureLoggedAt = new Map<string, number>();

/**
 * Journalise une défaillance d'E/S NOMMÉE au plus une fois par minute et par
 * fichier : la boucle d'attente la rencontre à chaque sondage, et un journal
 * qui répète la même ligne cache les autres.
 */
export function warnFailureOnce(file: string, error: unknown, message: string): void {
  const now = Date.now();
  const last = failureLoggedAt.get(file);
  if (last !== undefined && now - last < FAILURE_LOG_EVERY_MS) return;
  failureLoggedAt.set(file, now);
  logger.warn({ file, cause: errorCode(error) ?? 'UNKNOWN' }, message);
}

/**
 * Catch NOMMÉ pour un nettoyage au mieux (fermeture de handle, retrait d'un
 * fichier dont l'échec n'invalide pas l'opération) : jamais muet, l'erreur est
 * journalisée avec son code et l'action visée.
 */
export function logIgnored(what: string, fields: Record<string, unknown> = {}) {
  return (error: unknown): void => {
    logger.debug({ ...fields, cause: errorCode(error) ?? 'UNKNOWN' }, `${what} — ignoré`);
  };
}

export function serializeRecord(record: unknown): string {
  return `${JSON.stringify(record)}\n`;
}

export async function readLockFile(file: string): Promise<LockFileRead | null> {
  let raw: string;
  try {
    raw = await readFile(file, 'utf8');
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return null;
    // Droits, partage Windows (EBUSY/EPERM) : présent mais illisible —
    // jamais une raison de casser, ni une preuve de perte.
    return {
      state: 'unreadable',
      cause: errorCode(error) ?? 'UNKNOWN',
    };
  }
  try {
    const info = JSON.parse(raw);
    if (info && typeof info === 'object' && !Array.isArray(info)) return { state: 'ok', raw, info };
  } catch {
    // JSON tronqué ou vide : création interrompue, ou écriture en cours.
  }
  return { state: 'invalid', raw };
}

export async function mtimeMs(file: string): Promise<number | null> {
  // `null` = mtime indisponible (fichier parti, ou stat refusé) : tous les
  // appelants le traitent comme « âge inconnu » (jamais comme preuve de
  // péremption) ou comparent l'égalité au mtime jugé.
  const stats = await stat(file).catch(() => null);
  return stats ? stats.mtimeMs : null;
}

export async function pathExists(file: string): Promise<boolean> {
  try {
    await stat(file);
    return true;
  } catch (error) {
    // Seul ENOENT prouve l'absence ; toute autre erreur laisse le doute (présent).
    return errorCode(error) !== 'ENOENT';
  }
}

/**
 * Un verrou de cassure présent est-il un débris ? Mort (PID absent), contenu
 * invalide et ancien, ou — vivant mais silencieux depuis `staleMs` — porté par
 * un AUTRE programme (PID recyclé : identité relue SANS CACHE, décision
 * destructive) ou d'identité non enregistrée (l'âge seul tranche : un verrou
 * de cassure se tient quelques millisecondes). Un détenteur d'identité
 * confirmée reste respecté, même lent. Illisible : jamais un débris.
 */
export async function isBreakLockDebris(
  ctx: BreakContext,
  current: LockFileRead,
): Promise<boolean> {
  if (current.state === 'unreadable') return false;
  const age = Date.now() - ((await mtimeMs(ctx.file)) ?? Date.now());
  if (current.state === 'invalid') return age > ctx.invalidMs;
  const { pid, script, startedAt } = current.info;
  if (!(await ctx.isAlive(pid))) return true;
  if (age <= (ctx.staleMs ?? BREAK_STALE_MS)) return false;
  if (typeof script !== 'string' || script === '') return true;
  try {
    const verdict = await ctx.checkInstance(
      pid,
      { scriptName: script, args: [], startedAt: startedAt ?? null },
      { cache: false },
    );
    return verdict === 'foreign' || verdict === 'dead';
  } catch (error) {
    // Identité illisible : jamais une preuve d'étrangeté (fail closed).
    warnFailureOnce(
      ctx.file,
      error,
      'Identité du détenteur du verrou de cassure illisible — respecté',
    );
    return false;
  }
}

/**
 * Prise de contrôle ATOMIQUE d'un verrou de cassure débris (voir l'en-tête du
 * module). Le marqueur n'est tenu que le temps d'une lecture et d'une
 * suppression ; un marqueur orphelin (PID mort) est retiré.
 * Rend true si le débris n'est plus là (supprimé par nous ou déjà parti) ; false
 * si un autre prend le contrôle ou si le contenu a changé (`judgedRaw` : contenu jugé débris).
 */
async function reclaimBreakLock(ctx: BreakContext, judgedRaw: string): Promise<boolean> {
  const file = ctx.file;
  const marker = `${file}.reclaim`;
  let handle: FileHandle;
  try {
    handle = await open(marker, 'wx');
  } catch (error) {
    const transient = ctx.isTransientOpenError?.(error) === true;
    if (errorCode(error) !== 'EEXIST' && !transient) {
      throw ctx.ioError('open', marker, error);
    }
    await clearOrphanReclaimMarker(ctx, marker);
    return false;
  }
  try {
    await handle.writeFile(
      serializeRecord({ pid: process.pid, startedAt: new Date().toISOString() }),
      'utf8',
    );
    const again = await readLockFile(file);
    if (again === null) return true;
    if (again.state === 'unreadable' || again.raw !== judgedRaw) return false;
    // Suppression retentée (bornée) : EPERM/EBUSY passagers (antivirus, indexeur
    // Windows). Un échec durable n'est PAS une erreur d'E/S brute : il est
    // consigné dans `ctx.failure` et rendu par `removeIfUnchangedAt` comme issue
    // `failed` — l'acquisition reste bornée par son délai.
    let removalError: unknown = null;
    for (let attempt = 0; attempt < REMOVE_ATTEMPTS; attempt += 1) {
      try {
        await rm(file, { force: true });
        removalError = null;
        break;
      } catch (error) {
        removalError = error;
        if (attempt + 1 < REMOVE_ATTEMPTS) await sleep(REMOVE_RETRY_MS * 2 ** attempt);
      }
    }
    if (removalError !== null && (await pathExists(file))) {
      ctx.failure = removalError;
      warnFailureOnce(file, removalError, 'Verrou de cassure orphelin impossible à supprimer');
      return false;
    }
    logger.warn(
      { pid: again.state === 'ok' ? (again.info.pid ?? null) : null },
      'Verrou de cassure orphelin retiré',
    );
    return true;
  } finally {
    await handle.close().catch(logIgnored('Fermeture du marqueur de reprise', { file: marker }));
    await rm(marker, { force: true }).catch(
      logIgnored('Retrait du marqueur de reprise', { file: marker }),
    );
  }
}

/**
 * Marqueur de reprise laissé par un process mort pendant sa lecture-suppression
 * (quelques microsecondes de fenêtre) : retiré pour ne pas bloquer à jamais la
 * reprise d'un verrou de cassure débris. L'exclusion elle-même reste le `wx`
 * du verrou de cassure (jamais deux détenteurs créés), donc une erreur de
 * jugement ici ne coûte qu'un tour.
 */
async function clearOrphanReclaimMarker(ctx: BreakContext, marker: string): Promise<void> {
  const current = await readLockFile(marker);
  if (current === null || current.state === 'unreadable') return;
  const age = Date.now() - ((await mtimeMs(marker)) ?? Date.now());
  const orphan =
    current.state === 'ok' ? !(await ctx.isAlive(current.info.pid)) : age > ctx.invalidMs;
  if (!orphan) return;
  const again = await readLockFile(marker);
  if (again === null || again.state === 'unreadable' || again.raw !== current.raw) return;
  await rm(marker, { force: true }).catch(
    logIgnored('Retrait du marqueur de reprise orphelin', { file: marker }),
  );
}

/**
 * Exécute `fn` sous le verrou de cassure : une seule suppression de fichier
 * d'autrui à la fois, tous process confondus. Rend `false` sans rien exécuter
 * si un AUTRE casseur légitime le tient (l'appelant retente au sondage
 * suivant). Un verrou de cassure débris est repris atomiquement, puis la prise
 * est retentée (au plus BREAK_TAKE_ATTEMPTS fois).
 */
export async function underBreakLockAt(
  ctx: BreakContext,
  fn: () => Promise<void>,
): Promise<boolean> {
  const file = ctx.file;
  const token = randomUUID();
  for (let attempt = 0; attempt < BREAK_TAKE_ATTEMPTS; attempt += 1) {
    let handle: FileHandle;
    try {
      if (ctx.ensureDir) {
        await mkdir(ctx.ensureDir).catch((error: unknown) => {
          if (errorCode(error) !== 'EEXIST') throw error;
        });
      }
      handle = await open(file, 'wx');
    } catch (error) {
      const transient = ctx.isTransientOpenError?.(error) === true;
      if (errorCode(error) !== 'EEXIST' && !transient) {
        throw ctx.ioError('open', file, error);
      }
      const current = await readLockFile(file);
      if (current === null) continue; // libéré entre-temps
      if (current.state === 'unreadable') return false;
      if (!(await isBreakLockDebris(ctx, current))) return false;
      if (!(await reclaimBreakLock(ctx, current.raw))) return false;
      continue;
    }
    ctx.ownedFiles.set(file, token);
    try {
      await handle.writeFile(
        serializeRecord({
          pid: process.pid,
          token,
          startedAt: new Date().toISOString(),
          script: ctx.scriptName,
        }),
        'utf8',
      );
      await fn();
      return true;
    } finally {
      await handle.close().catch(logIgnored('Fermeture du verrou de cassure', { file }));
      ctx.ownedFiles.delete(file);
      const current = await readLockFile(file);
      if (current?.state === 'ok' && current.info.token === token) {
        await rm(file, { force: true }).catch(logIgnored('Retrait du verrou de cassure', { file }));
      }
    }
  }
  return false;
}

/**
 * Supprime `file` seulement s'il est toujours EXACTEMENT celui qui a été
 * jugé (contenu ET mtime), sous le verrou de cassure. L'existence est relue
 * après la suppression : un échec persistant (EPERM/EBUSY : antivirus,
 * indexeur) est rendu EXPLICITEMENT (`failed`), jamais pris pour un succès.
 */
export async function removeIfUnchangedAt(
  ctx: BreakContext,
  file: string,
  judged: LockFileRead,
  judgedMtimeMs: number | null,
  logFields: Record<string, unknown>,
  message: string,
): Promise<RemovalOutcome> {
  let outcome: RemovalOutcome = { status: 'abstained' };
  const ran = await underBreakLockAt(ctx, async () => {
    const again = await readLockFile(file);
    if (again === null) {
      outcome = { status: 'removed' };
      return;
    }
    if (again.state === 'unreadable' || judged.state === 'unreadable') return;
    if (again.raw !== judged.raw || (await mtimeMs(file)) !== judgedMtimeMs) return;
    let removalError: unknown = null;
    try {
      await rm(file, { force: true });
    } catch (error) {
      removalError = error;
    }
    // Relue : seule l'absence prouve la suppression (jamais le retour de rm).
    if (await pathExists(file)) {
      outcome = {
        status: 'failed',
        error: removalError ?? Object.assign(new Error('still present'), { code: 'EEXIST' }),
      };
      return;
    }
    logger.warn(logFields, message);
    outcome = { status: 'removed' };
  });
  if (ran) return outcome;
  // Le verrou de cassure débris n'a pas pu être supprimé (EPERM durable) : issue `failed`, pas `busy`.
  if (ctx.failure !== undefined) return { status: 'failed', error: ctx.failure };
  return { status: 'busy' };
}

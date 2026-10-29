/**
 * Verrou d'ÉTAT court (`<dossier d'état>/state.lock`, en pratique
 * `.striart/state.lock`) : sérialise les lecture-modification-écriture des
 * fichiers d'état (agents.json, queue.json, state.json, locks.json,
 * main-session.json) ENTRE process et entre contextes asynchrones d'un même
 * process.
 *
 * Pourquoi un second verrou à côté de `main.lock` (lock.js) : le verrou
 * principal couvre des opérations longues (merge, Test Gate, LLM) et n'est
 * délibérément PAS tenu pendant une session autonome (décision n°6.1). Le
 * process autonome publie pourtant `sessionPid` au registre pendant que
 * `watch` écrit ce même registre sous le verrou principal : sans exclusion
 * commune, la dernière écriture efface l'autre (mise à jour perdue, prouvée
 * par l'audit). Ce verrou-ci est tenu le temps d'UNE lecture-modification-
 * écriture (quelques millisecondes, < 100 ms visé) et jamais pendant une
 * opération longue.
 *
 * Ordre de prise FIXE : verrou principal PUIS verrou d'état, jamais
 * l'inverse. Une section tenue ici ne prend jamais `withMainLock` ni
 * n'attend une opération git, un LLM ou un process : c'est ce qui rend un
 * interblocage impossible (le détenteur du verrou d'état n'attend personne).
 *
 * Exclusion inter-process par création exclusive (`wx`, arbitrée par le
 * noyau). Contenu : `{pid, token, createdAt, script}` (une ligne JSON). Un
 * verrou présent n'est cassé que si c'est un DÉBRIS :
 *  - son détenteur est mort (PID sans process) ;
 *  - son PID est le nôtre sans que le jeton soit à nous (PID recyclé) ;
 *  - il est illisible (vide, tronqué) depuis plus de UNREADABLE_DEBRIS_MS ;
 *  - il a plus de IDENTITY_CHECK_AFTER_MS et son PID porte désormais un
 *    programme étranger (identité relue auprès de l'OS, sans cache).
 * Un détenteur VIVANT et identifié n'est jamais cassé, même vieux : passé le
 * délai, l'appelant échoue (STATE_LOCK_TIMEOUT), fail closed.
 *
 * Cassures SÉRIALISÉES, par la brique PARTAGÉE avec lock.js (break-lock.js) :
 * un débris n'est supprimé que sous le verrou de cassure `state.lock.break`
 * (création exclusive), en relisant le verrou et en comparant contenu ET mtime
 * à ceux jugés. Le verrou de cassure lui-même, s'il est un débris (casseur
 * mort, contenu invalide ancien, PID recyclé vivant mais étranger ou sans
 * identité enregistrée au-delà de 30 s), est repris ATOMIQUEMENT par un
 * marqueur à création exclusive (`state.lock.break.reclaim`) : deux
 * observateurs du même verrou de cassure mort ne peuvent pas le supprimer
 * chacun puis le créer (verrou de cassure tenu deux fois). Une suppression qui
 * échoue durablement (EPERM/EBUSY sous Windows) est rendue explicitement
 * (issue `failed`) et l'acquisition reste bornée par son délai. (Écarté :
 * renommer vers une pierre tombale puis remettre en place — la remise en place
 * n'est pas atomique face à un troisième process qui a déjà recréé le verrou :
 * deux détenteurs.) Défense en profondeur : le
 * détenteur revérifie son jeton juste avant d'écrire (`assertStateLockHeld`)
 * — un verrou perdu fait échouer l'écriture (STATE_LOCK_LOST) au lieu
 * d'écrire sans exclusion.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { readFileSync, rmSync } from 'node:fs';
import { open, rm } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { StriartError } from './errors.ts';
import { logger } from './logger.ts';
import type { BreakContext, LockFileRead } from './break-lock.ts';
import {
  BREAK_STALE_MS,
  logIgnored,
  mtimeMs,
  readLockFile,
  removeIfUnchangedAt,
  serializeRecord,
  underBreakLockAt,
  warnFailureOnce,
} from './break-lock.ts';

export const STATE_LOCK_FILE = 'state.lock';

/** Nom du dossier d'état racine d'un dépôt (voir `striartDir`). */
const STATE_ROOT_DIR_NAME = '.striart';

/** Délai d'acquisition par défaut : un détenteur légitime tient quelques ms. */
const DEFAULT_TIMEOUT_MS = 10_000;
/** Verrou vide/tronqué plus vieux que ça : débris (le détenteur écrit juste après le `wx`). */
const UNREADABLE_DEBRIS_MS = 2_000;
/** Âge au-delà duquel l'identité du détenteur vivant est relue (PID recyclé ?). */
const IDENTITY_CHECK_AFTER_MS = 5_000;
/** Une section plus longue que ça est signalée (le contrat est < 100 ms). */
const SLOW_HOLD_WARN_MS = 1_000;
/** Intervalle minimal entre deux lectures d'identité d'un même détenteur. */
const IDENTITY_RECHECK_MS = 1_000;
const identityMemo = new Map<string, { token: string; at: number; reason: string | null }>();
const POLL_MIN_MS = 2;
const POLL_MAX_MS = 40;

const IS_WINDOWS = process.platform === 'win32';

/**
 * Contextes qui tiennent le verrou d'un dossier : réentrance pour un appel
 * IMBRIQUÉ (une mise à jour du registre qui resynchronise locks.json). Une
 * tâche détachée qui survit à la section perd la réentrance à la libération
 * (`active = false`) et reprend réellement le verrou.
 */
const heldContext = new AsyncLocalStorage<Map<string, { active: boolean; token: string }>>();

/**
 * File FIFO en mémoire par fichier de verrou : un seul contexte de ce
 * process prend part à la course inter-process à la fois.
 */
const localTails = new Map<string, Promise<void>>();

/**
 * Verrous tenus par CE process, retirés à sa sortie même brutale
 * (`process.exit` saute les `finally`). Synchrone par nécessité : un
 * gestionnaire `exit` ne peut rien attendre. Le jeton est relu : jamais le
 * verrou d'un autre. Fichier → jeton.
 */
const ownedLocks = new Map<string, string>();
process.on('exit', () => {
  for (const [file, token] of ownedLocks) {
    try {
      if (JSON.parse(readFileSync(file, 'utf8'))?.token === token) rmSync(file, { force: true });
    } catch {
      // Déjà absent ou illisible : rien à nous à retirer.
    }
  }
});

/**
 * Vitalité d'un PID, chargée à la demande : process-tree tire le binaire
 * natif et execa, que le chemin nominal (verrou libre) ne paie jamais — la
 * complétion shell écrit aussi des fichiers d'état.
 */
async function isAlive(pid: unknown): Promise<boolean> {
  const { isProcessAlive } = await import('./process-tree.ts');
  return isProcessAlive(pid as number);
}

function lockFileOf(dir: string): string {
  return path.join(path.resolve(dir), STATE_LOCK_FILE);
}

/** Nom du script lancé par node : critère d'identité du détenteur (PID recyclé). */
function currentScriptName(): string | null {
  const entry = process.argv[1];
  return entry ? path.win32.basename(entry) : null;
}

/** Erreur passagère de Windows (fichier en suppression, ouvert sans partage). */
function isTransientWindowsError(error: unknown): boolean {
  return (
    IS_WINDOWS && ['EPERM', 'EACCES', 'EBUSY'].includes((error as { code?: string })?.code ?? '')
  );
}

/**
 * Contexte du verrou de cassure `<verrou d'état>.break` pour la brique
 * partagée break-lock.js (prise de contrôle atomique d'un débris, critère de
 * débris avec identité, suppression à quatre états).
 * @param file verrou d'état
 */
function breakContext(file: string): BreakContext {
  return {
    file: `${file}.break`,
    ensureDir: null,
    ioError: stateIoError,
    ownedFiles: ownedLocks,
    isAlive,
    checkInstance: async (pid, expected, options) => {
      // Chargé à la demande : chemin rare, et process-info tire le binaire natif.
      const { checkProcessInstance } = await import('./process-info.ts');
      return checkProcessInstance(pid, expected, options);
    },
    scriptName: currentScriptName(),
    invalidMs: UNREADABLE_DEBRIS_MS,
    staleMs: BREAK_STALE_MS,
    isTransientOpenError: isTransientWindowsError,
  };
}

/**
 * Exécute `fn` sous le verrou de cassure du verrou d'état de `dir` : une seule
 * cassure à la fois, tous process confondus. `false` si un autre casseur
 * légitime opère. Exportée pour les tests de course
 * (tests/integration/state-lock-faults.test.js).
 * `dir` : dossier d'état (`.striart/`).
 */
export function underBreakLock(dir: string, fn: () => Promise<void>): Promise<boolean> {
  return underBreakLockAt(breakContext(lockFileOf(dir)), fn);
}

/**
 * Erreur d'E/S du verrou d'état, nommée : jamais avalée.
 */
function stateIoError(operation: string, file: string, error: unknown): StriartError {
  const cause = (error as { code?: string })?.code ?? 'UNKNOWN';
  return new StriartError(
    `Opération « ${operation} » impossible sur le verrou d'état (${file}) : ${cause}.`,
    {
      code: 'STATE_LOCK_FAILED',
      hint: 'striart doctor',
      details: { lockFile: file, operation, cause },
      cause: error,
    },
  );
}

/**
 * Le verrou présent est-il un débris ?
 * Rend la raison du cassage, null si le verrou est légitime.
 */
async function judge(
  file: string,
  current: LockFileRead,
  fileMtimeMs: number | null,
): Promise<string | null> {
  // Illisible (droits, partage Windows) : présent, jamais cassé à l'aveugle.
  if (current.state === 'unreadable') return null;
  const age = fileMtimeMs === null ? 0 : Date.now() - fileMtimeMs;
  const info = current.state === 'ok' ? current.info : null;
  if (info === null || typeof info.token !== 'string') {
    return age > UNREADABLE_DEBRIS_MS ? 'UNREADABLE' : null;
  }
  if (info.pid === process.pid) {
    // Notre propre PID, mais pas notre jeton : un process mort avant nous
    // portait ce numéro (la file en mémoire exclut tout autre contexte d'ici).
    return [...ownedLocks.values()].includes(info.token) ? null : 'PID_RECYCLED';
  }
  if (!(await isAlive(info.pid))) return 'HOLDER_DEAD';
  if (age <= IDENTITY_CHECK_AFTER_MS || typeof info.script !== 'string' || info.script === '') {
    return null;
  }
  // Une lecture d'identité au plus par IDENTITY_RECHECK_MS et par verrou
  // jugé : le sondage (quelques dizaines de ms) ne doit pas interroger l'OS
  // à chaque tour. Le verdict n'est jamais réutilisé pour un autre jeton.
  const memo = identityMemo.get(file);
  if (memo && memo.token === info.token && Date.now() - memo.at < IDENTITY_RECHECK_MS) {
    return memo.reason;
  }
  try {
    const verdict = await breakContext(file).checkInstance(
      info.pid,
      { scriptName: info.script, args: [], startedAt: info.createdAt ?? null },
      { cache: false },
    );
    const reason =
      verdict === 'foreign' ? 'IDENTITY_FOREIGN' : verdict === 'dead' ? 'HOLDER_DEAD' : null;
    identityMemo.set(file, { token: info.token, at: Date.now(), reason });
    if (reason) return reason;
  } catch (error) {
    // Identité illisible : jamais une preuve d'étrangeté — on attend (fail closed).
    logger.warn(
      { err: error.message, pid: info.pid },
      "Identité du détenteur du verrou d'état illisible",
    );
  }
  return null;
}

/** Attente croissante avec gigue complète (évite les sondages synchronisés). */
function pollDelay(attempt: number): number {
  const cap = Math.min(POLL_MIN_MS * 2 ** attempt, POLL_MAX_MS);
  return POLL_MIN_MS + Math.random() * (cap - POLL_MIN_MS);
}

/**
 * Erreur de délai : le verrou est toujours là. `verdict` dit pourquoi on n'a
 * pas pu le prendre (détenteur légitime, cassure en cours ou impossible,
 * fichier illisible) — la cause système du dernier échec en fait partie.
 * `mtime` : mtime du verrou (null : inconnu).
 */
function timeoutError(
  file: string,
  current: LockFileRead | null,
  mtime: number | null,
  verdict: { reason: string; cause?: string | null },
): StriartError {
  const info = current?.state === 'ok' ? current.info : null;
  const heldForMs = mtime === null ? null : Math.max(0, Date.now() - mtime);
  const pid = info?.pid ?? null;
  const why =
    verdict.reason === 'BREAK_FAILED'
      ? `périmé (son détenteur n'existe plus) mais impossible à supprimer (${verdict.cause ?? 'erreur système'})`
      : verdict.reason === 'BREAK_IN_PROGRESS'
        ? "périmé, cassure en cours par un autre process qui n'a pas fini"
        : verdict.reason === 'LOCK_UNREADABLE'
          ? `illisible (${verdict.cause ?? 'erreur système'}), jamais cassé à l'aveugle`
          : `toujours tenu par le PID ${pid ?? '?'}`;
  return new StriartError(`Verrou d'état (${file}) ${why} : écriture d'état abandonnée.`, {
    code: 'STATE_LOCK_TIMEOUT',
    hint: 'striart doctor',
    details: {
      lockFile: file,
      pid,
      heldForMs,
      reason: verdict.reason,
      ...(verdict.cause ? { cause: verdict.cause } : {}),
    },
  });
}

/** Rend le jeton. */
async function acquireFile(file: string, deadline: number): Promise<string> {
  let lastVerdict: { reason: string; cause?: string | null } = { reason: 'HELD' };
  for (let attempt = 0; ; attempt += 1) {
    // Borne EN TÊTE de boucle : tout `continue` (cassure réussie, verrou
    // libéré entre-temps) repasse ici — aucun chemin ne peut tourner au-delà
    // du délai, quoi qu'il arrive au disque.
    if (attempt > 0 && Date.now() >= deadline) {
      throw timeoutError(file, await readLockFile(file), await mtimeMs(file), lastVerdict);
    }
    const token = randomUUID();
    let handle = null;
    try {
      handle = await open(file, 'wx');
    } catch (error) {
      if (error.code === 'ENOENT') {
        const dir = path.dirname(file);
        // Seul l'absence du dossier d'état RACINE (`.striart/`) veut dire « pas initialisé ». Le
        // verrou d'un sous-dossier (`reviews/`, `collab/`…) y vit aussi : son absence veut dire
        // « rien n'a encore été écrit là », pas « lance striart init » (hint qui ne règle rien).
        if (path.basename(dir) === STATE_ROOT_DIR_NAME) {
          throw new StriartError(
            `Dossier d'état introuvable (${dir}) : lance d'abord "striart init".`,
            {
              code: 'NOT_INITIALIZED',
              hint: 'striart init',
              details: { root: path.dirname(dir) },
            },
          );
        }
        throw new StriartError(
          `Verrou d'état impossible à créer (${file}) : le dossier n'existe pas.`,
          {
            code: 'STATE_LOCK_FAILED',
            hint: 'striart doctor',
            details: { lockFile: file, cause: 'ENOENT' },
          },
        );
      }
      if (error.code !== 'EEXIST' && !isTransientWindowsError(error)) {
        throw new StriartError(`Verrou d'état impossible à créer (${file}) : ${error.code}.`, {
          code: 'STATE_LOCK_FAILED',
          hint: 'striart doctor',
          details: { lockFile: file, cause: error.code ?? null },
        });
      }
    }
    if (handle) {
      try {
        await handle.writeFile(
          serializeRecord({
            pid: process.pid,
            token,
            createdAt: new Date().toISOString(),
            script: currentScriptName(),
          }),
          'utf8',
        );
      } catch (error) {
        await handle.close().catch(logIgnored("Fermeture du verrou d'état inachevé", { file }));
        await rm(file, { force: true }).catch(
          logIgnored("Retrait du verrou d'état inachevé", { file }),
        );
        throw new StriartError(`Verrou d'état impossible à écrire (${file}) : ${error.code}.`, {
          code: 'STATE_LOCK_FAILED',
          hint: 'striart doctor',
          details: { lockFile: file, cause: error.code ?? null },
        });
      }
      await handle.close();
      ownedLocks.set(file, token);
      return token;
    }

    lastVerdict = { reason: 'HELD' };
    const current = await readLockFile(file);
    if (current === null) continue; // libéré entre-temps : on retente aussitôt
    const mtime = await mtimeMs(file);
    if (current.state === 'unreadable') {
      lastVerdict = { reason: 'LOCK_UNREADABLE', cause: current.cause };
    } else {
      const reason = await judge(file, current, mtime);
      if (reason) {
        const info = current.state === 'ok' ? current.info : null;
        const removal = await removeIfUnchangedAt(
          breakContext(file),
          file,
          current,
          mtime,
          { reason, pid: info?.pid ?? null, lockFile: file },
          "Verrou d'état orphelin cassé",
        );
        // Reprise immédiate du `wx` (le noyau arbitre) SEULEMENT si le
        // fichier a réellement disparu ; sinon on attend le prochain sondage.
        if (removal.status === 'removed') continue;
        if (removal.status === 'failed') {
          warnFailureOnce(
            file,
            removal.error,
            "Verrou d'état périmé impossible à supprimer — nouvelle tentative au prochain sondage",
          );
          lastVerdict = {
            reason: 'BREAK_FAILED',
            cause: (removal.error as { code?: string })?.code ?? 'UNKNOWN',
          };
        } else if (removal.status === 'busy') {
          lastVerdict = { reason: 'BREAK_IN_PROGRESS' };
        }
        // `abstained` : le fichier a changé depuis le jugement, le sondage suivant le rejuge.
      }
    }
    await sleep(Math.min(pollDelay(attempt), Math.max(0, deadline - Date.now())));
  }
}

async function releaseFile(file: string, token: string): Promise<void> {
  const current = await readLockFile(file);
  if (current?.state === 'ok' && current.info.token === token) {
    try {
      await rm(file, { force: true });
      ownedLocks.delete(file);
    } catch (error) {
      // Windows : un lecteur concurrent peut retarder la suppression. Le
      // fichier reste à notre jeton, PID vivant : le prochain l'attend, puis
      // le casse à notre sortie (HOLDER_DEAD) — jamais un blocage durable.
      // Gardé dans ownedLocks : le retrait de sortie de process retentera.
      logger.warn({ err: error.code, lockFile: file }, "Libération du verrou d'état retardée");
    }
    return;
  }
  // Durablement illisible : propriété invérifiable, rien n'est supprimé à
  // l'aveugle — le retrait de sortie (jeton relu) retentera.
  if (current?.state !== 'unreadable') ownedLocks.delete(file);
  logger.error(
    {
      lockFile: file,
      holderPid: current?.state === 'ok' ? (current.info.pid ?? null) : null,
      readState: current?.state ?? 'absent',
    },
    "Verrou d'état plus à nous (ou illisible) à la libération : laissé en place",
  );
}

/**
 * Exécute `fn` sous le verrou d'état du dossier `dir`. Réentrant pour un
 * appel imbriqué du même contexte asynchrone. `fn` doit être COURTE : aucune
 * opération git, LLM, process, ni `withMainLock` (ordre de prise fixe).
 * `dir` : dossier d'état (`.striart/`).
 */
export async function withStateLock<T>(
  dir: string,
  fn: () => Promise<T>,
  { timeoutMs = DEFAULT_TIMEOUT_MS }: { timeoutMs?: number } = {},
): Promise<T> {
  return withFileLock(lockFileOf(dir), fn, { timeoutMs });
}

/**
 * Même verrou à jeton (création exclusive, débris cassés sous le verrou de
 * cassure partagé, réentrance, file locale équitable) pour un AUTRE fichier de
 * verrou — ex. le verrou du PID file d'un daemon (`watch.pid.lock`), qui
 * protégeait un `wx` nu cassé sur le seul âge du fichier. Le fichier se trouve
 * dans un dossier existant ; `file` est un chemin complet.
 * `slowHoldWarnMs` : seuil d'avertissement d'une section trop longue (défaut :
 * le contrat du verrou d'état, 1 s).
 */
export async function withFileLock<T>(
  file: string,
  fn: () => Promise<T>,
  {
    timeoutMs = DEFAULT_TIMEOUT_MS,
    slowHoldWarnMs = SLOW_HOLD_WARN_MS,
  }: { timeoutMs?: number; slowHoldWarnMs?: number } = {},
): Promise<T> {
  file = path.resolve(file);
  const store = heldContext.getStore();
  if (store?.get(file)?.active) return fn();

  const previous = localTails.get(file) ?? Promise.resolve();
  let releaseTurn: () => void = () => {};
  const turn = new Promise<void>((resolve) => {
    releaseTurn = () => resolve(undefined);
  });
  const tail = previous.then(() => turn);
  localTails.set(file, tail);
  try {
    await previous;
    const token = await acquireFile(file, Date.now() + timeoutMs);
    const holding = { active: true, token };
    const scope = new Map(store ?? []);
    scope.set(file, holding);
    const startedAt = Date.now();
    try {
      return await heldContext.run(scope, fn);
    } finally {
      holding.active = false;
      const heldMs = Date.now() - startedAt;
      if (heldMs > slowHoldWarnMs) {
        logger.warn({ lockFile: file, heldMs }, "Verrou d'état tenu anormalement longtemps");
      }
      await releaseFile(file, token);
    }
  } finally {
    releaseTurn();
    if (localTails.get(file) === tail) localTails.delete(file);
  }
}

/**
 * Vérifie, juste avant une écriture d'état, que le contexte courant tient
 * TOUJOURS le verrou du dossier `dir` (fichier présent, à notre jeton).
 * Sinon STATE_LOCK_LOST : l'écriture n'a pas lieu.
 */
export async function assertStateLockHeld(dir: string): Promise<void> {
  const file = lockFileOf(dir);
  const holding = heldContext.getStore()?.get(file);
  const current = holding?.active ? await readLockFile(file) : null;
  const ours = current?.state === 'ok' && current.info.token === holding?.token;
  if (holding?.active && ours) return;
  throw new StriartError(
    `Verrou d'état perdu avant l'écriture (${file}) : écriture abandonnée, l'état précédent est intact.`,
    {
      code: 'STATE_LOCK_LOST',
      hint: 'striart doctor',
      details: {
        lockFile: file,
        holderPid: current?.state === 'ok' ? (current.info.pid ?? null) : null,
      },
    },
  );
}

/** Vrai si le contexte courant tient le verrou d'état de `dir`. */
export function isStateLockHeld(dir: string): boolean {
  return Boolean(heldContext.getStore()?.get(lockFileOf(dir))?.active);
}

/**
 * État du verrou d'état d'un dossier, pour l'affichage (`striart doctor`).
 */
export async function readStateLockStatus(
  dir: string,
): Promise<
  | { present: false }
  | { present: true; pid: number | null; alive: boolean; ageMs: number; readable: boolean }
> {
  const file = lockFileOf(dir);
  const current = await readLockFile(file);
  if (current === null) return { present: false };
  const mtime = await mtimeMs(file);
  const pid =
    current.state === 'ok' && Number.isSafeInteger(current.info.pid) ? current.info.pid : null;
  return {
    present: true,
    pid,
    alive: pid !== null && (await isAlive(pid)),
    ageMs: mtime === null ? 0 : Math.max(0, Date.now() - mtime),
    readable: current.state === 'ok',
  };
}

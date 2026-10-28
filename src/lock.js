/**
 * Verrou global du repo principal (`.striart/main.lock`).
 *
 * Trois couches, de la plus proche à la plus large :
 *
 *  1. RÉENTRANCE PAR CONTEXTE ASYNCHRONE (AsyncLocalStorage). Un appel
 *     `withMainLock` fait DEPUIS la section critique d'un autre — directement
 *     ou par une chaîne d'`await` (stop → retryQueue, merge → sync) — la
 *     traverse sans rien reprendre. Un appel venu d'un AUTRE contexte du même
 *     process (requête parallèle du serveur MCP, tâche de fond du dashboard)
 *     n'hérite de rien : il attend son tour. L'ancien compteur global `depth`
 *     laissait deux sections critiques de premier niveau s'exécuter en même
 *     temps dans un même process (prouvé par l'audit L1).
 *     Sémantique exacte d'un travail LANCÉ SANS ÊTRE ATTENDU depuis une
 *     section critique (`void f()`, `setTimeout`, abonnement à un événement) :
 *     il hérite du contexte, donc
 *       - tant que la section dure, ses `withMainLock` sont RÉENTRANTS : il
 *         s'exécute EN MÊME TEMPS que la section, sans exclusion ;
 *       - dès la libération (`holding.held = false`), il perd la réentrance et
 *         reprend réellement le verrou.
 *     `runOutsideMainLock(fn)` est donc REQUIS pour tout travail détaché
 *     depuis une section critique qui prend le verrou ou touche au repo
 *     principal (merge, sync, session autonome…) : il le fait partir sans
 *     contexte, comme un appelant de premier niveau.
 *
 *  2. FILE FIFO EN MÉMOIRE par repo : un seul contexte de ce process prend
 *     part à la course inter-process à la fois, dans l'ordre d'arrivée.
 *
 *  3. EXCLUSION INTER-PROCESS par création exclusive (`wx`, arbitrée par le
 *     noyau), précédée d'une FILE ÉQUITABLE (`.striart/lock-queue/`, un
 *     ticket numéroté par process en attente, servi par numéro croissant —
 *     plus de famine par sondage désordonné). Seule la tête de file tente le
 *     `wx`.
 *
 * Tenue : le détenteur BAT (mtime + `heartbeatAt` rafraîchis toutes les
 * HEARTBEAT_MS par un timer `unref`). Un verrou présent n'est cassé que sur
 * PREUVE que son détenteur n'existe plus :
 *  - détenteur mort (HOLDER_DEAD) ;
 *  - battement expiré ET PID porté par un process étranger — PID recyclé,
 *    identité relue auprès de l'OS sans cache, heure de création comprise
 *    (IDENTITY_FOREIGN) ;
 *  - format HÉRITÉ (écrit par une version qui ne bat pas) au-delà de l'ancien
 *    TTL de 30 min (LEGACY_TTL) ;
 *  - contenu invalide (vide, JSON tronqué : crash entre création et
 *    écriture) ET ancien (INVALID_CONTENT). Un fichier ILLISIBLE (erreur de
 *    lecture : droits, partage Windows) n'est jamais cassé.
 * Un détenteur VIVANT dont le battement est figé (process gelé : débogueur,
 * SIGSTOP, boucle synchrone) n'est PAS cassé par défaut : le casser, c'est
 * laisser deux process dans la section dès son dégel (reproduit en revue).
 * L'attente se termine en LOCK_TIMEOUT `HOLDER_FROZEN` avec le PID à
 * arrêter. Relâcher cette protection est un choix explicite :
 * `lock.breakFrozenHolderAfterMs` (config, `null` = jamais) autorise la
 * cassure d'un détenteur figé au-delà de ce délai, après une observation
 * ACTIVE de STALE_OBSERVATION_MS (chaque intervalle plafonné : une veille de
 * la machine ne compte pas) ; chaque cassure est journalisée et `striart
 * doctor` affiche l'option.
 *
 * Cassures SÉRIALISÉES : toute suppression d'un fichier d'autrui (main.lock
 * périmé, ticket orphelin) se fait sous le verrou de cassure
 * `lock-queue/break.lock` (création exclusive), en relisant le fichier et en
 * comparant contenu ET mtime à ceux jugés. Deux casseurs simultanés ne
 * peuvent donc plus supprimer l'un le verrou neuf de l'autre : le second
 * relit le verrou neuf, qui diffère, et s'abstient. (Alternative écartée :
 * renommer vers une pierre tombale puis vérifier — quand le fichier renommé
 * se révèle être un verrou neuf, le remettre en place n'est pas atomique
 * face à un troisième process qui a déjà recréé main.lock : deux détenteurs.)
 *
 * Propriété : un jeton aléatoire (`crypto.randomUUID`) est écrit dans le
 * fichier et relu avant toute suppression — la libération, la sortie du
 * process et le cassage ne retirent jamais le verrou d'un autre.
 * `assertMainLockHeld` permet à une opération longue de vérifier, juste
 * avant un effet irréversible (commit, écriture dans le principal), qu'elle
 * tient toujours le verrou (LOCK_LOST sinon).
 *
 * Format (JSON, une ligne) : `{pid, startedAt, label, token, heartbeatAt,
 * script}` — les trois premiers champs sont ceux de l'ancien format, qui
 * reste donc lisible par l'ancien code (`striart doctor`, attente) ; comme
 * l'ancien code juge l'âge sur le mtime, le battement le protège aussi.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { readFileSync, rmSync } from 'node:fs';
import { mkdir, open, readFile, readdir as fsReaddir, rm, stat, utimes } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { simpleGit } from 'simple-git';
import { striartDir } from './paths.js';
import { ensureStateProtection } from './state-protection.ts';
import { StriartError } from './errors.js';
import { logger } from './logger.js';
import { readMainSession, startMainSession } from './main-session.js';
import {
  assessDeclaringShell,
  checkProcessInstance,
  declaringShellName,
  pidHintForShell,
  readProcessChain,
} from './process-info.ts';
import { isProcessAlive } from './process-tree.js';
import { quoteForShell } from './terminal.js';
import { withTransientRetry, writeJsonAtomic } from './json-file.js';
import {
  logIgnored,
  mtimeMs,
  readLockFile,
  removeIfUnchangedAt,
  serializeRecord,
  underBreakLockAt,
  warnFailureOnce,
} from './break-lock.ts';

const POLL_MS = 300;
const DEFAULT_TIMEOUT_MS = 120_000;
/** Période du battement de cœur du détenteur. */
const HEARTBEAT_MS = 5_000;
/** Battement plus vieux que ça : expiré (12 battements manqués). */
export const HEARTBEAT_STALE_MS = 60_000;
/**
 * Observation active exigée d'un battement figé avant de casser (option
 * `lock.breakFrozenHolderAfterMs` seulement). Chaque intervalle de sondage
 * compte au plus OBSERVATION_STEP_CAP_MS : un saut d'horloge (veille) ne
 * compte presque pas.
 */
const STALE_OBSERVATION_MS = 15_000;
const OBSERVATION_STEP_CAP_MS = 4 * POLL_MS;
/** TTL du format HÉRITÉ uniquement (verrou sans jeton, version qui ne bat pas). */
const LEGACY_STALE_TTL_MS = 30 * 60 * 1000;
/** Contenu invalide (création interrompue) ET plus vieux que ça : débris. */
const INVALID_DEBRIS_MS = 10_000;
/** Ticket d'attente non rafraîchi depuis ça : son process a cessé d'attendre. */
const TICKET_STALE_MS = 30_000;
/**
 * Rafraîchissement du ticket, par un timer INDÉPENDANT de la boucle
 * d'attente (une itération peut durer : lecture d'identité, disque lent).
 * TICKET_STALE_MS couvre 15 rafraîchissements manqués.
 */
const TICKET_REFRESH_MS = 2_000;
/** Premier message d'attente, puis rappel périodique. */
const WAIT_NOTICE_AFTER_MS = 2_000;
const WAIT_NOTICE_EVERY_MS = 30_000;
/** Réessais bornés d'une relecture de verrou illisible (EPERM/EBUSY transitoires sous Windows). */
const IO_RETRY_DELAYS_MS = [50, 100, 200, 400];
/** Codes d'E/S passagers retentés à la lecture de la file. */
const TRANSIENT_IO_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);
/** Bornes de la prise de ticket (numéros disputés par d'autres process). */
const TICKET_MAX_ATTEMPTS = 50;

const QUEUE_DIR = 'lock-queue';
const TICKET_RE = /^(\d{12})\.json$/;
const BREAK_LOCK_NAME = 'break.lock';
/** Marqueur posé par MERGE_STATE_CHANGED : bloque l'auto-récupération d'un merge tiers. */
const MERGE_STATE_MARKER = 'merge-state-changed.json';

/**
 * @typedef {object} Holding
 * @property {string} key       Racine résolue du repo.
 * @property {string} file      Chemin de main.lock.
 * @property {string} token     Jeton écrit dans le fichier.
 * @property {string} label
 * @property {import('node:fs/promises').FileHandle} handle
 * @property {Record<string, unknown>} record  Contenu courant du fichier.
 * @property {boolean} held     Faux dès la libération (contextes détachés).
 * @property {boolean} lost     Vrai si le fichier n'est plus le nôtre.
 * @property {NodeJS.Timeout | null} timer
 * @property {Promise<void> | null} beating  Battement en cours (jamais deux à la fois).
 */

/**
 * État lu d'un fichier de verrou ou de ticket (`null` = absent) — défini dans
 * break-lock.js, partagé avec le verrou d'état.
 * @typedef {import('./break-lock.ts').LockFileRead} LockFileRead
 */

/**
 * Ticket d'attente tenu par CE process dans la file inter-process.
 * @typedef {object} Ticket
 * @property {string} dir
 * @property {string} file
 * @property {number} number
 * @property {string} token     Jeton écrit dans le fichier : l'identité du ticket (le numéro peut être repris).
 * @property {boolean} lost     Vrai si le fichier n'est plus le nôtre (retiré, ou repris au même numéro).
 * @property {NodeJS.Timeout | null} timer
 * @property {Promise<void> | null} refreshing  Rafraîchissement en cours (jamais deux à la fois).
 */

/** @type {AsyncLocalStorage<Map<string, Holding>>} */
const lockContext = new AsyncLocalStorage();

/**
 * File FIFO en mémoire, par repo.
 * @type {Map<string, {busy: {label: string, since: number} | null, waiters: Array<{grant: () => void}>}>}
 */
const localQueues = new Map();

/**
 * Verrous et tickets tenus par CE process, retirés à sa sortie même brutale
 * (Ctrl+C → `process.exit(130)` de la CLI, qui saute les `finally`). Sans
 * ça, le fichier resterait jusqu'à ce qu'un autre process le casse (PID
 * mort) — correct, mais avec un avertissement « verrou orphelin » qui ferait
 * croire à un crash. Chaque retrait vérifie le jeton : jamais le verrou d'un
 * autre. L'état git éventuellement laissé en plein merge reste traité par
 * recoverOrphanMerge à la prochaine acquisition.
 * @type {Map<string, string>} fichier → jeton
 */
const ownedFiles = new Map();
process.on('exit', () => {
  for (const [file, token] of ownedFiles) {
    try {
      const info = JSON.parse(readFileSync(file, 'utf8'));
      if (info?.token === token) rmSync(file, { force: true });
    } catch {
      // Fichier déjà absent ou illisible : rien à nous à retirer.
    }
  }
});

function lockPath(root) {
  return path.join(striartDir(root), 'main.lock');
}

function queueDirOf(root) {
  return path.join(striartDir(root), QUEUE_DIR);
}

/**
 * Erreur d'E/S du verrou, nommée : jamais avalée en « personne devant » ni
 * en « verrou libre ».
 * @param {string} operation
 * @param {string} file
 * @param {unknown} error
 */
function lockIoError(operation, file, error) {
  const cause = /** @type {{code?: string}} */ (error)?.code ?? 'UNKNOWN';
  return new StriartError(
    `Opération « ${operation} » impossible sur ${file} (${cause}) : le verrou du repo principal ne peut pas être géré en sécurité.`,
    {
      code: 'LOCK_IO_FAILED',
      hint: 'striart doctor',
      details: { operation, path: file, cause },
      cause: error,
    },
  );
}

/** Dernier signe de vie d'un détenteur au nouveau format : le plus récent des deux. */
function lastBeatMs(info, fileMtimeMs) {
  const declared = Date.parse(info?.heartbeatAt ?? '');
  return Math.max(Number.isFinite(declared) ? declared : 0, fileMtimeMs ?? 0);
}

/** Nom du script lancé par node, critère d'identité du détenteur (PID recyclé). */
function currentScriptName() {
  const entry = process.argv[1];
  return entry ? path.win32.basename(entry) : null;
}

/** Commande qui arrête un PID, dans la syntaxe de la plateforme. */
function stopPidCommand(pid) {
  return process.platform === 'win32' ? `taskkill /PID ${pid} /F` : `kill ${pid}`;
}

/**
 * `lock.breakFrozenHolderAfterMs` de la config du repo (null = jamais).
 * Chargée à la demande (seulement face à un détenteur figé). Config
 * illisible → null : on ne relâche jamais une protection sur une config
 * qu'on n'a pas pu lire (fail closed), et on le dit.
 * @param {string} root
 * @returns {Promise<number | null>}
 */
export async function readFrozenBreakPolicy(root) {
  try {
    const { loadConfig } = await import('./config.js');
    const value = (await loadConfig(root))?.lock?.breakFrozenHolderAfterMs ?? null;
    return Number.isInteger(value) ? value : null;
  } catch (error) {
    logger.warn(
      { err: error?.message },
      'Config illisible : la cassure de détenteur figé reste désactivée',
    );
    return null;
  }
}

// ─── Battement de cœur ────────────────────────────────────────────────────

/**
 * Rafraîchit le verrou tenu : `heartbeatAt` réécrit EN PLACE (longueur
 * identique — une date ISO fait toujours 24 caractères — donc jamais de
 * troncature visible par un lecteur concurrent) puis mtime forcé. Vérifie au
 * passage que le fichier est toujours le nôtre : sinon `lost`, sans jamais
 * le recréer ni l'écraser. Une lecture impossible n'est pas une perte.
 * @param {Holding} holding
 */
async function beat(holding) {
  if (!holding.held || holding.lost) return;
  const current = await readLockFile(holding.file);
  if (current === null || (current.state === 'ok' && current.info.token !== holding.token)) {
    holding.lost = true;
    logger.error(
      {
        operation: holding.label,
        lockFile: holding.file,
        holderPid: current?.state === 'ok' ? (current.info.pid ?? null) : null,
      },
      'Verrou du repo principal perdu pendant la tenue (cassé ou remplacé par un autre process)',
    );
    return;
  }
  if (!holding.held) return; // libéré pendant la lecture : plus rien à rafraîchir
  const now = new Date();
  holding.record = { ...holding.record, heartbeatAt: now.toISOString() };
  const buffer = Buffer.from(serializeRecord(holding.record), 'utf8');
  await holding.handle.write(buffer, 0, buffer.length, 0);
  await holding.handle.utimes(now, now);
}

/** @param {Holding} holding */
function startHeartbeat(holding) {
  holding.timer = setInterval(() => {
    if (holding.beating) return; // un battement lent ne se chevauche pas
    holding.beating = beat(holding)
      .catch((error) => {
        // Un battement raté n'est pas une perte de verrou : le suivant
        // rattrape. Journalisé, jamais tu (un disque plein finirait par le
        // figer — et un détenteur figé n'est pas cassé par défaut).
        logger.warn({ err: error, operation: holding.label }, 'Battement du verrou en échec');
      })
      .finally(() => {
        holding.beating = null;
      });
  }, HEARTBEAT_MS);
  holding.timer.unref();
}

// ─── Verrou de cassure ────────────────────────────────────────────────────

/**
 * Contexte du verrou de cassure de ce repo (`lock-queue/break.lock`) pour la
 * brique partagée break-lock.js — qui porte la prise de contrôle atomique d'un
 * débris, le critère de débris avec identité et la suppression à quatre états.
 * @param {string} root
 * @returns {import('./break-lock.ts').BreakContext}
 */
function breakContext(root) {
  const dir = queueDirOf(root);
  return {
    file: path.join(dir, BREAK_LOCK_NAME),
    ensureDir: dir,
    ioError: lockIoError,
    ownedFiles,
    isAlive: isProcessAlive,
    checkInstance: checkProcessInstance,
    scriptName: currentScriptName(),
    invalidMs: INVALID_DEBRIS_MS,
    staleMs: TICKET_STALE_MS,
  };
}

/**
 * Exécute `fn` sous le verrou de cassure (`lock-queue/break.lock`, création
 * exclusive) : une seule suppression de fichier d'autrui à la fois, tous
 * process confondus. Rend `false` sans rien exécuter si un AUTRE casseur
 * vivant le tient (l'appelant retente au sondage suivant). Un verrou de
 * cassure débris est repris atomiquement (break-lock.js).
 * Exportée pour les tests de course (tests/integration/lock-faults.test.js).
 * @param {string} root
 * @param {() => Promise<void>} fn
 * @returns {Promise<boolean>}
 */
export function underBreakLock(root, fn) {
  return underBreakLockAt(breakContext(root), fn);
}

/**
 * Supprime `file` seulement s'il est toujours EXACTEMENT celui qui a été jugé
 * (contenu ET mtime), sous le verrou de cassure — issue à quatre états
 * (break-lock.js : removed / abstained / busy / failed).
 * @param {string} root
 * @param {string} file
 * @param {LockFileRead} judged
 * @param {number | null} judgedMtimeMs
 * @param {Record<string, unknown>} logFields
 * @param {string} message
 */
function removeIfUnchanged(root, file, judged, judgedMtimeMs, logFields, message) {
  return removeIfUnchangedAt(breakContext(root), file, judged, judgedMtimeMs, logFields, message);
}

// ─── File équitable inter-process ─────────────────────────────────────────

/**
 * Tickets de la file, par numéro croissant. Dossier absent = file vide. Toute
 * AUTRE erreur de lecture est réessayée (bornée), puis remonte nommée
 * (LOCK_IO_FAILED) : conclure « personne devant » sur une erreur ferait
 * doubler toute la file.
 * @param {string} dir
 * @param {{readdir?: (dir: string) => Promise<string[]>}} [deps]
 * @returns {Promise<Array<{number: number, file: string}>>}
 */
export async function listTickets(dir, { readdir = fsReaddir } = {}) {
  let names;
  try {
    names = await withTransientRetry(() => readdir(dir), {
      budgetMs: 1_000,
      // Partage Windows et droits passagers, quelle que soit la plateforme :
      // un réessai court ne coûte rien, une conclusion fausse coûte la file.
      isTransient: (error) => TRANSIENT_IO_CODES.has(error?.code),
    });
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw lockIoError('readdir', dir, error);
  }
  return names
    .map((name) => TICKET_RE.exec(name))
    .filter((match) => match !== null)
    .map((match) => ({ number: Number(match[1]), file: path.join(dir, match[0]) }))
    .sort((a, b) => a.number - b.number);
}

/**
 * Prend un ticket numéroté dans `.striart/lock-queue/` (numéro = plus grand
 * présent + 1, création exclusive : deux process ne peuvent pas avoir le
 * même). null si `.striart/` n'existe pas. Borné : un numéro disputé est
 * repris avec un court délai, au plus TICKET_MAX_ATTEMPTS fois.
 * @returns {Promise<Ticket | null>}
 */
async function takeTicket(root, label) {
  const dir = queueDirOf(root);
  try {
    await mkdir(dir);
  } catch (error) {
    if (error.code === 'ENOENT') return null; // .striart/ absent : striart init tranchera
    if (error.code !== 'EEXIST') throw lockIoError('mkdir', dir, error);
  }
  const token = randomUUID();
  for (let attempt = 0; attempt < TICKET_MAX_ATTEMPTS; attempt += 1) {
    const numbers = (await listTickets(dir)).map((t) => t.number);
    const number = (numbers.length > 0 ? Math.max(...numbers) : 0) + 1;
    const file = path.join(dir, `${String(number).padStart(12, '0')}.json`);
    let handle;
    try {
      handle = await open(file, 'wx');
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      if (error.code !== 'EEXIST') throw lockIoError('open', file, error);
      // Numéro pris entre la lecture et la création : on relit, sans s'emballer.
      await sleep(Math.min(10 * (attempt + 1), 200));
      continue;
    }
    try {
      await handle.writeFile(
        serializeRecord({ pid: process.pid, token, label, createdAt: new Date().toISOString() }),
        'utf8',
      );
    } catch (error) {
      await handle.close().catch(logIgnored('Fermeture du ticket', { file }));
      await rm(file, { force: true }).catch(logIgnored('Retrait du ticket inachevé', { file }));
      throw lockIoError('write', file, error);
    }
    await handle.close().catch(logIgnored('Fermeture du ticket', { file }));
    ownedFiles.set(file, token);
    /** @type {Ticket} */
    const ticket = { dir, file, number, token, lost: false, timer: null, refreshing: null };
    startTicketRefresh(ticket);
    return ticket;
  }
  // Numéros disputés sans fin : cause système EEXIST (création exclusive refusée).
  const contended = /** @type {Error & {code?: string}} */ (new Error('ticket contended'));
  contended.code = 'EEXIST';
  throw lockIoError('ticket', dir, contended);
}

/**
 * Rafraîchit le ticket par un timer indépendant de la boucle d'attente : une
 * itération lente (lecture d'identité, disque) ne le fait plus passer pour
 * orphelin. Le fichier est vérifié à chaque battement : disparu, ou repris au
 * même numéro par un AUTRE process (jeton différent) → `lost` (la boucle se
 * réinscrit) ; le mtime d'un ticket d'autrui n'est jamais rafraîchi.
 * @param {Ticket} ticket
 */
function startTicketRefresh(ticket) {
  ticket.timer = setInterval(() => {
    if (ticket.refreshing) return; // un rafraîchissement lent ne se chevauche pas
    ticket.refreshing = refreshTicket(ticket).finally(() => {
      ticket.refreshing = null;
    });
  }, TICKET_REFRESH_MS);
  ticket.timer.unref();
}

/** @param {Ticket} ticket */
async function refreshTicket(ticket) {
  try {
    const current = await readLockFile(ticket.file);
    if (current === null || (current.state === 'ok' && current.info.token !== ticket.token)) {
      ticket.lost = true;
      return;
    }
    const now = new Date();
    await utimes(ticket.file, now, now);
  } catch (error) {
    if (/** @type {{code?: string}} */ (error)?.code === 'ENOENT') ticket.lost = true;
    else
      logger.warn(
        { err: /** @type {Error} */ (error)?.message, ticket: ticket.file },
        "Rafraîchissement du ticket d'attente en échec",
      );
  }
}

/** @param {Ticket | null} ticket */
async function dropTicket(ticket) {
  if (!ticket) return;
  if (ticket.timer) clearInterval(ticket.timer);
  const current = await readLockFile(ticket.file);
  if (current?.state === 'ok' && current.info.token === ticket.token) {
    try {
      await rm(ticket.file, { force: true });
    } catch (error) {
      // Le ticket reste (visible des autres, retiré comme orphelin après
      // TICKET_STALE_MS) : nommé, et le retrait de sortie de process retentera.
      warnFailureOnce(ticket.file, error, "Retrait du ticket d'attente impossible");
      return;
    }
  }
  ownedFiles.delete(ticket.file);
}

/**
 * Tickets vivants AVANT le nôtre. Parcourt la file dans l'ordre et S'ARRÊTE au
 * premier ticket vivant : seul « y a-t-il quelqu'un devant ? » décide de notre
 * tour, et lire toute la file à chaque sondage de chaque waiter coûterait
 * O(N²) E/S. Retire au passage (sous le verrou de cassure, contenu et mtime
 * comparés) les tickets rencontrés avant lui dont le process a cessé d'attendre :
 * PID mort, ou ticket non rafraîchi depuis TICKET_STALE_MS. Retirer à tort un
 * ticket ne coûte que sa place à son process, qui le constate et reprend un
 * ticket : l'exclusion, elle, reste au `wx`. Un ticket illisible compte comme
 * vivant (on ne double pas sur une erreur). L'équité est inchangée : on ne
 * passe qu'en l'absence de tout ticket vivant devant nous.
 *
 * Vérifie aussi que NOTRE ticket est toujours le nôtre — par le JETON, pas par
 * le numéro (un ticket retiré puis repris au même numéro par un autre process
 * porte un autre jeton).
 * @param {string} root
 * @param {Ticket} ticket
 * @returns {Promise<{ahead: Array<{pid: number | null, label: string | null}>, waitingAhead: number}>}
 *   `ahead` : vide (personne de vivant devant) ou le premier ticket vivant ;
 *   `waitingAhead` : tickets encore présents devant nous.
 */
async function liveTicketsAhead(root, ticket) {
  const entries = await listTickets(ticket.dir);
  // Notre propre ticket a disparu ou a été repris (retiré comme orphelin) :
  // se réinscrire AVANT de se croire en tête — sans ticket, on serait
  // invisible des autres.
  const own = entries.find((entry) => entry.number === ticket.number);
  if (!own) ticket.lost = true;
  else {
    const mine = await readLockFile(own.file);
    if (mine === null || (mine.state === 'ok' && mine.info.token !== ticket.token)) {
      ticket.lost = true;
    }
  }
  const before = entries.filter((entry) => entry.number < ticket.number);
  let gone = 0;
  for (const entry of before) {
    const current = await readLockFile(entry.file);
    if (current === null) {
      gone += 1;
      continue;
    }
    if (current.state === 'unreadable') {
      return { ahead: [{ pid: null, label: null }], waitingAhead: before.length - gone };
    }
    const mtime = await mtimeMs(entry.file);
    const age = Date.now() - (mtime ?? Date.now());
    const pid = current.state === 'ok' ? current.info.pid : null;
    const stale =
      (current.state === 'ok' && !isProcessAlive(pid)) ||
      age > TICKET_STALE_MS ||
      (current.state === 'invalid' && age > INVALID_DEBRIS_MS);
    if (stale) {
      const removal = await removeIfUnchanged(
        root,
        entry.file,
        current,
        mtime,
        { pid: pid ?? null, label: current.state === 'ok' ? (current.info.label ?? null) : null },
        "Ticket d'attente orphelin retiré",
      );
      if (removal.status === 'failed') {
        warnFailureOnce(
          entry.file,
          removal.error,
          "Retrait d'un ticket d'attente orphelin impossible",
        );
      }
      // Périmé (retiré ou non) : il ne nous précède pas en vie, le suivant décide.
      gone += 1;
      continue;
    }
    return {
      ahead: [
        { pid: pid ?? null, label: current.state === 'ok' ? (current.info.label ?? null) : null },
      ],
      waitingAhead: before.length - gone,
    };
  }
  return { ahead: [], waitingAhead: 0 };
}

// ─── Détection d'un verrou périmé ─────────────────────────────────────────

/**
 * Observation active d'un même battement figé, d'un sondage à l'autre.
 * Exportée pour les tests unitaires du jugement.
 */
export function createStaleObservation() {
  return {
    /** @type {string | null} */
    signature: null,
    /** @type {string | null} */
    verdict: null,
    observedMs: 0,
    /** @type {number | null} */
    lastAt: null,
    reset(signature = null) {
      this.signature = signature;
      this.verdict = null;
      this.observedMs = 0;
      this.lastAt = null;
    },
    accumulate(now) {
      if (this.lastAt !== null) {
        this.observedMs += Math.min(Math.max(now - this.lastAt, 0), OBSERVATION_STEP_CAP_MS);
      }
      this.lastAt = now;
    },
  };
}

/**
 * Juge un main.lock présent. Pur sur l'état lu : horloge, vitalité, identité
 * et politique de cassure sont injectables (tests unitaires).
 * @param {LockFileRead} current
 * @param {number | null} fileMtimeMs
 * @param {ReturnType<typeof createStaleObservation>} observation
 * @param {{now?: () => number, isAlive?: (pid: number) => boolean, checkInstance?: typeof checkProcessInstance, frozenBreakAfterMs?: () => Promise<number | null>}} [deps]
 * @returns {Promise<{stale: true, reason: 'HOLDER_DEAD'|'IDENTITY_FOREIGN'|'LEGACY_TTL'|'INVALID_CONTENT'|'FROZEN_HOLDER_BROKEN', heartbeatAgeMs?: number, breakFrozenHolderAfterMs?: number} | {stale: false, reason: 'HELD'|'HOLDER_FROZEN'|'LOCK_UNREADABLE', heartbeatAgeMs?: number}>}
 */
export async function judgeLock(current, fileMtimeMs, observation, deps = {}) {
  const {
    now: clock = Date.now,
    isAlive = isProcessAlive,
    checkInstance = checkProcessInstance,
    frozenBreakAfterMs = async () => null,
  } = deps;
  const now = clock();
  const age = fileMtimeMs === null ? 0 : now - fileMtimeMs;
  if (current.state === 'unreadable') return { stale: false, reason: 'LOCK_UNREADABLE' };
  if (current.state === 'invalid') {
    return age > INVALID_DEBRIS_MS
      ? { stale: true, reason: 'INVALID_CONTENT' }
      : { stale: false, reason: 'HELD' };
  }
  const { info } = current;
  if (!isAlive(info.pid)) return { stale: true, reason: 'HOLDER_DEAD' };
  if (typeof info.token !== 'string') {
    // Format hérité : son détenteur ne bat pas, l'ancien TTL reste la seule parade.
    return age > LEGACY_STALE_TTL_MS
      ? { stale: true, reason: 'LEGACY_TTL' }
      : { stale: false, reason: 'HELD' };
  }

  const beatAt = lastBeatMs(info, fileMtimeMs);
  const heartbeatAgeMs = Math.max(0, now - beatAt);
  if (heartbeatAgeMs <= HEARTBEAT_STALE_MS) {
    observation.reset();
    return { stale: false, reason: 'HELD', heartbeatAgeMs };
  }
  // Battement expiré : le même PID vit, mais est-ce encore NOTRE détenteur ?
  const signature = `${info.token}\0${beatAt}`;
  if (observation.signature !== signature) {
    observation.reset(signature);
    if (typeof info.script === 'string' && info.script !== '') {
      try {
        // Identité relue sans cache (décision destructive). startedAt : écrit
        // APRÈS la création du détenteur — un process né plus tard porte un
        // numéro recyclé (heure de création lue à l'OS).
        observation.verdict = await checkInstance(
          info.pid,
          { scriptName: info.script, args: [], startedAt: info.startedAt ?? null },
          { cache: false },
        );
      } catch (error) {
        // Identité illisible (outil système en échec) : jamais une preuve
        // d'étrangeté.
        observation.verdict = 'unverified';
        logger.warn(
          { err: error?.message, pid: info.pid },
          'Identité du détenteur du verrou illisible — traité comme vivant',
        );
      }
    }
  }
  if (observation.verdict === 'foreign') {
    return { stale: true, reason: 'IDENTITY_FOREIGN', heartbeatAgeMs };
  }
  if (observation.verdict === 'dead') return { stale: true, reason: 'HOLDER_DEAD' };

  // Vivant (ou identité invérifiable) et figé : pas une preuve d'absence.
  observation.accumulate(now);
  const policy = await frozenBreakAfterMs();
  if (
    policy !== null &&
    heartbeatAgeMs >= policy &&
    observation.observedMs >= STALE_OBSERVATION_MS
  ) {
    return {
      stale: true,
      reason: 'FROZEN_HOLDER_BROKEN',
      heartbeatAgeMs,
      breakFrozenHolderAfterMs: policy,
    };
  }
  return { stale: false, reason: 'HOLDER_FROZEN', heartbeatAgeMs };
}

/**
 * Attente du verrou annulée par l'appelant (AbortSignal) AVANT acquisition :
 * rien n'a été tenu, rien n'a été écrit, le ticket d'attente est retiré.
 * @param {string} operation
 * @param {string} file
 */
function lockWaitCancelledError(operation, file) {
  return new StriartError(
    `Attente du verrou du repo principal annulée pour « ${operation} » : l'opération n'a pas démarré, rien n'a été modifié.`,
    { code: 'LOCK_WAIT_CANCELLED', details: { operation, lockFile: file } },
  );
}

/**
 * @param {string} file
 * @param {LockFileRead | null} current
 * @param {number} waitingAhead
 * @param {{reason?: string, heartbeatAgeMs?: number | null, cause?: string | null}} [verdict]
 */
function lockTimeoutError(file, current, waitingAhead, verdict = {}) {
  const info = current?.state === 'ok' ? current.info : null;
  const startedAtMs = Date.parse(info?.startedAt ?? '');
  const heldForMs = Number.isFinite(startedAtMs) ? Math.max(0, Date.now() - startedAtMs) : null;
  const since = heldForMs === null ? '' : ` depuis ${Math.round(heldForMs / 1000)}s`;
  const queue = waitingAhead > 0 ? `, ${waitingAhead} opération(s) en attente avant celle-ci` : '';
  const reason = verdict.reason ?? 'HELD';
  const pid = info?.pid ?? null;
  let why = '';
  let hint = 'striart doctor';
  if (reason === 'HOLDER_FROZEN' && pid !== null) {
    why =
      ` Son détenteur est VIVANT mais figé (aucun battement depuis ${Math.round((verdict.heartbeatAgeMs ?? 0) / 1000)}s) : ` +
      "il n'est pas cassé (le casser laisserait deux process dans la section à son dégel). " +
      `Arrête ce process s'il est bloqué, ou autorise la cassure via lock.breakFrozenHolderAfterMs.`;
    hint = stopPidCommand(pid);
  } else if (reason === 'LOCK_UNREADABLE') {
    why = ` Le fichier ${file} est illisible (${current?.state === 'unreadable' ? current.cause : '?'}) : jamais cassé à l'aveugle.`;
  } else if (reason === 'BREAK_IN_PROGRESS') {
    why = " Un autre process est en train de casser un verrou périmé et n'a pas fini.";
  } else if (reason === 'BREAK_FAILED') {
    why =
      ` Le verrou est périmé (son détenteur n'existe plus) mais il ne peut pas être supprimé (${verdict.cause ?? 'erreur système'}) : ` +
      "vérifie les droits de .striart/ et qu'aucun antivirus ou indexeur ne retient ce fichier.";
  }
  return new StriartError(
    `Impossible d'obtenir le verrou du repo principal : détenu par "${info?.label ?? 'inconnu'}" (pid ${pid ?? '?'})${since}${queue}.${why}`,
    {
      code: 'LOCK_TIMEOUT',
      hint,
      details: {
        reason,
        holder: info?.label ?? null,
        pid,
        startedAt: info?.startedAt ?? null,
        heldForMs,
        heartbeatAgeMs: verdict.heartbeatAgeMs ?? null,
        ...(verdict.cause ? { cause: verdict.cause } : {}),
        waitingAhead,
        lockFile: file,
      },
    },
  );
}

// ─── Acquisition ──────────────────────────────────────────────────────────

/**
 * Tour de ce contexte dans la file FIFO en mémoire du repo `key`.
 * @returns {Promise<() => void>} libération (passe la main au suivant)
 */
function takeLocalTurn(key, label, deadline, file, signal = null, contention = null) {
  let queue = localQueues.get(key);
  if (!queue) {
    queue = { busy: null, waiters: [] };
    localQueues.set(key, queue);
  }
  const q = queue;
  let released = false;
  const release = () => {
    if (released) return; // idempotente : jamais deux tours accordés pour une libération
    released = true;
    const next = q.waiters.shift();
    if (next) next.grant();
    else {
      q.busy = null;
      localQueues.delete(key);
    }
  };
  if (!q.busy) {
    q.busy = { label, since: Date.now() };
    return Promise.resolve(release);
  }
  if (contention) {
    // Mesure seule (lock:contention) : qui occupe le tour, depuis quand, combien devant nous.
    contention.contended = true;
    contention.holderLabel = q.busy.label;
    contention.holderSince = q.busy.since;
    contention.queued = Math.max(contention.queued, q.waiters.length + 1);
  }
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      clearTimeout(notice);
      const index = q.waiters.indexOf(waiter);
      if (index !== -1) q.waiters.splice(index, 1);
      reject(lockWaitCancelledError(label, file));
    };
    const waiter = {
      grant: () => {
        clearTimeout(timer);
        clearTimeout(notice);
        signal?.removeEventListener('abort', onAbort);
        q.busy = { label, since: Date.now() };
        resolve(release);
      },
    };
    const timer = setTimeout(
      () => {
        clearTimeout(notice);
        signal?.removeEventListener('abort', onAbort);
        const index = q.waiters.indexOf(waiter);
        if (index !== -1) q.waiters.splice(index, 1);
        const busy = q.busy;
        reject(
          lockTimeoutError(
            file,
            busy
              ? {
                  state: 'ok',
                  raw: '',
                  info: {
                    label: busy.label,
                    pid: process.pid,
                    startedAt: new Date(busy.since).toISOString(),
                  },
                }
              : null,
            index === -1 ? 0 : index,
            { reason: 'HELD_IN_PROCESS' },
          ),
        );
      },
      Math.max(0, deadline - Date.now()),
    );
    // Attente dans ce process : dit qui occupe le verrou, une fois.
    const notice = setTimeout(() => {
      logger.info(
        {
          operation: label,
          holder: q.busy?.label ?? null,
          heldSince: q.busy ? new Date(q.busy.since).toISOString() : null,
          waitingAhead: q.waiters.indexOf(waiter),
        },
        `En attente du verrou du repo principal (tenu dans ce process par "${q.busy?.label ?? 'inconnu'}")`,
      );
    }, WAIT_NOTICE_AFTER_MS);
    notice.unref();
    q.waiters.push(waiter);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Création exclusive de main.lock ('wx' : atomique au niveau du noyau).
 * @returns {Promise<{file: string, handle: import('node:fs/promises').FileHandle, token: string, record: Record<string, unknown>} | 'EXISTS' | null>}
 *   null si `.striart/` n'existe pas.
 */
async function tryCreateLock(file, label) {
  const token = randomUUID();
  const now = new Date().toISOString();
  const record = {
    pid: process.pid,
    startedAt: now,
    label,
    token,
    heartbeatAt: now,
    script: currentScriptName(),
  };
  let handle;
  try {
    handle = await open(file, 'wx');
  } catch (error) {
    if (error.code === 'ENOENT') return null; // .striart/ absent : striart init tranchera
    if (error.code === 'EEXIST') return 'EXISTS';
    throw lockIoError('open', file, error);
  }
  try {
    await handle.writeFile(serializeRecord(record), 'utf8');
  } catch (error) {
    // Verrou créé mais inutilisable : retiré (il est à nous), l'erreur remonte.
    await handle.close().catch(logIgnored('Fermeture du verrou inachevé', { file }));
    await rm(file, { force: true }).catch(logIgnored('Retrait du verrou inachevé', { file }));
    throw lockIoError('write', file, error);
  }
  return { file, handle, token, record };
}

/**
 * Acquiert main.lock entre process : ticket dans la file équitable, puis,
 * en tête de file, création exclusive ('wx'). Sur EEXIST : casse un verrou
 * périmé (voir judgeLock, sous le verrou de cassure), sinon attend jusqu'au
 * délai.
 * @returns {Promise<{file: string, handle: import('node:fs/promises').FileHandle, token: string, record: Record<string, unknown>} | null>}
 *   null si `.striart/` n'existe pas.
 */
async function acquire(root, label, deadline, signal = null, contention = null) {
  const file = lockPath(root);
  if (signal?.aborted) throw lockWaitCancelledError(label, file);
  // Chemin rapide : personne en file → tentative directe, sans ticket.
  // Équitable : qui arrive après nous trouve soit notre verrou, soit (si nous
  // échouons) notre ticket ; un waiter apparu entre notre lecture et notre
  // 'wx' était arrivé après nous.
  if ((await listTickets(queueDirOf(root))).length === 0) {
    const fast = await tryCreateLock(file, label);
    if (fast !== 'EXISTS') return fast;
  }
  let ticket = await takeTicket(root, label);
  if (ticket === null) return null;
  // Chemin lent : un verrou ou une file existait à notre arrivée (mesure seule, lock:contention).
  if (contention) contention.contended = true;
  const observation = createStaleObservation();
  /** @type {Promise<number | null> | null} */
  let policy = null;
  const frozenBreakAfterMs = () => (policy ??= readFrozenBreakPolicy(root));
  const waitStartedAt = Date.now();
  let nextNoticeAt = waitStartedAt + WAIT_NOTICE_AFTER_MS;
  // Dernier constat, pour le LOCK_TIMEOUT levé en tête de boucle.
  let lastWaitingAhead = 0;
  /** @type {{reason?: string, heartbeatAgeMs?: number | null, cause?: string | null}} */
  let lastVerdict = {};
  let polls = 0;
  try {
    for (;;) {
      if (signal?.aborted) throw lockWaitCancelledError(label, file);
      // Borne EN TÊTE de boucle : tout `continue` (réinscription, cassure
      // réussie, verrou libéré entre-temps) repasse ici — aucun chemin ne
      // peut tourner au-delà du délai, quoi qu'il arrive au disque.
      if (polls > 0 && Date.now() >= deadline) {
        throw lockTimeoutError(file, await readLockFile(file), lastWaitingAhead, lastVerdict);
      }
      polls += 1;
      if (ticket.lost) {
        // Retiré comme orphelin (process gelé trop longtemps) : on reprend
        // un ticket, en fin de file.
        logger.warn({ operation: label }, "Ticket d'attente du verrou perdu — réinscription");
        await dropTicket(ticket);
        ticket = await takeTicket(root, label);
        if (ticket === null) return null;
      }
      const { ahead, waitingAhead } = await liveTicketsAhead(root, ticket);
      if (ticket.lost) continue; // réinscription en tête de boucle
      if (contention) {
        contention.queued = Math.max(contention.queued, waitingAhead + 1);
        if (ahead[0]?.label) contention.holderLabel = ahead[0].label;
      }
      /** @type {LockFileRead | null} */
      let current = null;
      /** @type {{reason?: string, heartbeatAgeMs?: number | null, cause?: string | null}} */
      let verdict = {};
      if (ahead.length === 0) {
        const lock = await tryCreateLock(file, label);
        if (lock !== 'EXISTS') return lock;
        current = await readLockFile(file);
        if (current === null) continue; // libéré entre-temps : on retente aussitôt
        if (contention && current.state === 'ok') {
          contention.holderLabel = current.info.label ?? contention.holderLabel;
          const since = Date.parse(current.info.startedAt ?? '');
          if (Number.isFinite(since)) contention.holderSince = since;
        }
        const mtime = await mtimeMs(file);
        const judged = await judgeLock(current, mtime, observation, { frozenBreakAfterMs });
        verdict = judged;
        if (judged.stale) {
          const info = current.state === 'ok' ? current.info : null;
          const removal = await removeIfUnchanged(
            root,
            file,
            current,
            mtime,
            {
              holder: info?.label ?? 'inconnu',
              pid: info?.pid ?? null,
              reason: judged.reason,
              heartbeatAgeMs: judged.heartbeatAgeMs ?? null,
              ...(judged.reason === 'FROZEN_HOLDER_BROKEN'
                ? { breakFrozenHolderAfterMs: judged.breakFrozenHolderAfterMs }
                : {}),
            },
            judged.reason === 'FROZEN_HOLDER_BROKEN'
              ? 'Détenteur VIVANT mais figé cassé (lock.breakFrozenHolderAfterMs) — protection relâchée par la config'
              : 'Verrou orphelin détecté — cassé',
          );
          // Reprise immédiate du 'wx' (le noyau arbitre) SEULEMENT si le
          // fichier a réellement disparu ; sinon on attend le prochain sondage.
          if (removal.status === 'removed') continue;
          if (removal.status === 'failed') {
            warnFailureOnce(
              file,
              removal.error,
              'Verrou périmé impossible à supprimer — nouvelle tentative au prochain sondage',
            );
            verdict = {
              reason: 'BREAK_FAILED',
              heartbeatAgeMs: judged.heartbeatAgeMs ?? null,
              cause: /** @type {{code?: string}} */ (removal.error)?.code ?? 'UNKNOWN',
            };
          } else if (removal.status === 'busy') {
            verdict = {
              reason: 'BREAK_IN_PROGRESS',
              heartbeatAgeMs: judged.heartbeatAgeMs ?? null,
            };
          } else {
            // Le fichier a changé depuis le jugement : le prochain sondage le juge de nouveau.
            verdict = { reason: 'HELD', heartbeatAgeMs: judged.heartbeatAgeMs ?? null };
          }
        }
      } else {
        observation.reset();
      }

      lastWaitingAhead = waitingAhead;
      lastVerdict = verdict;
      const now = Date.now();
      if (now >= deadline) {
        throw lockTimeoutError(file, current ?? (await readLockFile(file)), waitingAhead, verdict);
      }
      if (now >= nextNoticeAt) {
        nextNoticeAt = now + WAIT_NOTICE_EVERY_MS;
        const read = current ?? (await readLockFile(file));
        const info = read?.state === 'ok' ? read.info : null;
        logger.info(
          {
            operation: label,
            holder: info?.label ?? null,
            holderPid: info?.pid ?? null,
            heldSince: info?.startedAt ?? null,
            reason: verdict.reason ?? 'HELD',
            heartbeatAgeMs: verdict.heartbeatAgeMs ?? null,
            waitingAhead,
            waitedMs: now - waitStartedAt,
          },
          `En attente du verrou du repo principal (détenu par "${info?.label ?? 'inconnu'}")`,
        );
      }
      try {
        await sleep(POLL_MS, undefined, signal ? { signal } : undefined);
      } catch (error) {
        if (error?.name === 'AbortError') throw lockWaitCancelledError(label, file);
        throw error;
      }
    }
  } finally {
    await dropTicket(ticket);
  }
}

/**
 * Libère main.lock seulement s'il porte encore notre jeton. Un verrou qui
 * n'est plus le nôtre n'est jamais supprimé (il appartient à un autre
 * process qui l'a cassé puis repris) : c'est signalé, la protection des
 * effets irréversibles étant `assertMainLockHeld`.
 * @param {Holding} holding
 */
async function releaseLock(holding) {
  await holding.handle
    .close()
    .catch(logIgnored('Fermeture du verrou principal', { file: holding.file }));
  const current = await readLockFileSteady(holding.file);
  if (current?.state === 'ok' && current.info.token === holding.token) {
    try {
      await rm(holding.file, { force: true });
      ownedFiles.delete(holding.file);
    } catch (error) {
      // Le verrou reste en place : son détenteur (nous) est vivant tant que ce
      // process l'est, puis il est cassé comme orphelin. Gardé dans
      // ownedFiles : le retrait de sortie de process retentera.
      logger.error(
        {
          operation: holding.label,
          lockFile: holding.file,
          cause: /** @type {{code?: string}} */ (error)?.code ?? 'UNKNOWN',
        },
        'Verrou du repo principal impossible à supprimer à la libération : laissé en place',
      );
    }
    return;
  }
  // Durablement illisible : propriété invérifiable, rien n'est supprimé à
  // l'aveugle — le retrait de sortie (jeton relu) retentera.
  if (current?.state !== 'unreadable') ownedFiles.delete(holding.file);
  logger.error(
    {
      operation: holding.label,
      lockFile: holding.file,
      holderPid: current?.state === 'ok' ? (current.info.pid ?? null) : null,
      readState: current?.state ?? 'absent',
    },
    'Verrou du repo principal plus à nous (ou illisible) à la libération : laissé en place',
  );
}

/**
 * Refuse toute opération tant qu'une session déclarée sur le REPO PRINCIPAL
 * lui-même est vivante (`main-session.js` : un agent lancé directement dans
 * son worktree via `runMainSession`, ou un humain via `striart lock --start`).
 *
 * Généralise au principal la garde SESSION_LIVE déjà éprouvée par agent
 * (décision architecturale n°6.4) : sans elle, `recoverOrphanMerge`
 * ci-dessous traiterait un `MERGE_HEAD` posé par une résolution manuelle en
 * cours comme un débris de crash et l'annulerait — l'incident exact qui a
 * motivé cette garde. Un PID mort ne bloque rien (relu à chaque appel, pas de
 * nettoyage actif requis) ; `striart lock --stop` reste la sortie de secours
 * si le nettoyage automatique n'a pas eu lieu.
 *
 * Aucun TTL ici (contrairement au battement de cœur de main.lock ci-dessus) :
 * un agent lancé directement sur le principal peut légitimement tourner des
 * heures, et un disjoncteur automatique risquerait de désarmer une session
 * encore réelle — choix délibéré, fail-closed, symétrique de l'absence de
 * TTL sur `sessionPid` par agent. `striart lock --stop` est la seule sortie
 * si le PID a été recyclé par l'OS avant qu'un nettoyage n'ait eu lieu.
 *
 * Exportée : c'est la SEULE implémentation de « lire la session, vérifier
 * isProcessAlive, refuser » — `runMainSession` (orchestrator.js) et
 * `striart lock --start` (cli.js) la réutilisent au lieu de la recopier.
 */
export async function assertNoLiveMainSession(root) {
  const session = await readMainSession(root);
  if (!session || !isProcessAlive(session.pid)) return;
  const ageMin = Math.round((Date.now() - Date.parse(session.startedAt)) / 60_000);
  throw new StriartError(
    `Repo principal occupé : "${session.reason}" (pid ${session.pid}, depuis ${ageMin} min). ` +
      'Attends la fin de cette session, ou libère-la si elle est terminée sans avoir nettoyé.',
    {
      code: 'MAIN_SESSION_LIVE',
      details: { reason: session.reason, pid: session.pid },
      hint: 'striart lock --stop',
    },
  );
}

/**
 * Réserve le repo principal pour une intervention directe (`striart lock
 * --start`) : publie la session déclarée sous le même verrou que les
 * opérations mutantes. `withMainLock` refuse déjà s'il existe une autre
 * session vivante (assertNoLiveMainSession) et attend la fin d'un
 * merge/sync/promote en cours avant de nous laisser publier — deux
 * réservations concurrentes ne peuvent donc pas passer toutes les deux.
 *
 * Une réservation qui ne protège rien est pire que pas de réservation : elle
 * fait croire à l'humain qu'il est à l'abri. D'où deux refus, fail closed :
 *  - PID mort → LOCK_PID_DEAD ;
 *  - PID implicite (le parent de la CLI) qui n'est pas un shell interactif
 *    durable → LOCK_PID_EPHEMERAL, avec la commande `--pid` adaptée au shell.
 *
 * @param {string} root
 * @param {{reason: string, pid: number, explicitPid: boolean}} params
 *   `explicitPid` : le PID a été désigné par l'appelant (`--pid`), il n'est
 *   alors contrôlé que pour sa vitalité — c'est un choix conscient.
 * @returns {Promise<{pid: number, reason: string, startedAt: string}>}
 */
export async function reserveMainSession(root, { reason, pid, explicitPid }) {
  if (typeof reason !== 'string' || reason.trim() === '') {
    throw new StriartError('La raison de la réservation est vide.', {
      code: 'LOCK_REASON_EMPTY',
      hint: 'striart lock --start "résolution du conflit sur app.js"',
    });
  }
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    throw new StriartError(`PID invalide : ${JSON.stringify(pid)}. Attendu : un entier positif.`, {
      code: 'INVALID_PID',
      details: { pid },
    });
  }
  if (!isProcessAlive(pid)) {
    throw new StriartError(
      `Le PID ${pid} ne correspond à aucun process vivant : la réservation ne protégerait rien.`,
      {
        code: 'LOCK_PID_DEAD',
        hint: 'striart lock --start "<raison>" --pid <PID vivant>',
        details: { pid },
      },
    );
  }
  if (!explicitPid) {
    const chain = await readProcessChain(pid, 3);
    const assessment = assessDeclaringShell(chain);
    if ('reason' in assessment) {
      // Le shell le plus proche dans la chaîne dit quelle syntaxe proposer.
      const shellName = declaringShellName(chain);
      const WHY = {
        UNKNOWN: "son identité n'a pas pu être lue auprès du système",
        NOT_A_SHELL: `c'est « ${assessment.process?.name} », pas un shell interactif`,
        NON_INTERACTIVE: 'ce shell exécute une seule commande puis se termine',
        FORK_WRAPPER:
          'c’est une copie éphémère du shell (Git Bash/MSYS), qui meurt avec la commande',
      };
      throw new StriartError(
        `Impossible de surveiller le process appelant (PID ${pid}) : ${WHY[assessment.reason]}. ` +
          'La réservation serait levée dès la fin de cette commande. Désigne le shell à surveiller avec --pid.',
        {
          code: 'LOCK_PID_EPHEMERAL',
          details: { pid, reason: assessment.reason, image: assessment.process?.name ?? null },
          // Raison citée dans la grammaire du shell qui la recevra : c'est de
          // la donnée utilisateur, jamais une ligne qui expanse `$(…)`.
          hint: `striart lock --start ${quoteForShell(reason, { shell: shellName })} --pid ${pidHintForShell(shellName)}`,
        },
      );
    }
  }
  // Sans récupération de merge : la réservation ne touche pas au repo. Un
  // merge ouvert est précisément ce que l'humain s'apprête à terminer (c'est
  // ce qu'on lui recommande après MERGE_STATE_CHANGED) — l'annuler le
  // détruirait, le refuser l'empêcherait de se protéger.
  return withMainLock(
    root,
    'lock:start',
    async () => {
      // withMainLock l'a déjà vérifié à l'acquisition ; répété ici pour rester
      // correct si la réservation est un jour appelée sous un verrou déjà tenu
      // (réentrance : withMainLock imbriqué ne refait aucun contrôle).
      await assertNoLiveMainSession(root);
      return startMainSession(root, { pid, reason });
    },
    { recoverMerge: false },
  );
}

function mergeStateMarkerPath(root) {
  return path.join(striartDir(root), MERGE_STATE_MARKER);
}

/**
 * Pose le marqueur MERGE_STATE_CHANGED (appelé sous le verrou par
 * l'orchestrateur, au moment où il refuse de commiter un merge qui n'est
 * plus le sien). Tant qu'il est posé ET qu'un merge est ouvert dans le
 * principal, aucune acquisition n'annule ce merge (MERGE_RECOVERY_BLOCKED) :
 * il appartient à quelqu'un d'autre. `details` : identifiants seulement.
 *
 * Le marqueur est LIÉ au merge qu'il désigne : `details.mergeHead` (SHA de
 * MERGE_HEAD au moment du constat). Un marqueur dont le SHA n'est pas celui du
 * merge actuellement ouvert est périmé et ne protège rien (voir
 * recoverOrphanMerge).
 * @param {string} root
 * @param {Record<string, unknown> & {mergeHead?: string | null}} details
 */
export async function recordMergeStateChanged(root, details) {
  await writeJsonAtomic(mergeStateMarkerPath(root), {
    at: new Date().toISOString(),
    ...details,
  });
}

async function readMergeStateMarker(root) {
  try {
    return JSON.parse(await readFile(mergeStateMarkerPath(root), 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    // Marqueur présent mais illisible : il bloque quand même (fail closed).
    return { unreadable: true };
  }
}

/**
 * Dossier git RÉEL du principal. `.git` est un FICHIER (`gitdir: <chemin>`) pour un
 * worktree lié, un submodule ou `--separate-git-dir` : MERGE_HEAD y vit dans le
 * dossier désigné, pas sous `<racine>/.git/`.
 * @param {string} root
 * @returns {Promise<string>}
 */
async function resolveGitDir(root) {
  const dotGit = path.join(root, '.git');
  let raw;
  try {
    raw = await readFile(dotGit, 'utf8');
  } catch (error) {
    // EISDIR (Linux/macOS) ou EPERM/EACCES (Windows) sur un dossier : `.git` ordinaire.
    const code = /** @type {{code?: string}} */ (error)?.code;
    if (code === 'EISDIR' || code === 'EPERM' || code === 'EACCES' || code === 'ENOENT')
      return dotGit;
    throw error;
  }
  const match = /^gitdir:\s*(.+?)\s*$/m.exec(raw);
  return match ? path.resolve(root, match[1]) : dotGit;
}

/**
 * SHA de MERGE_HEAD (première ligne), `null` si aucun merge n'est ouvert.
 * @param {string} root
 * @returns {Promise<string | null>}
 */
async function readOpenMergeHead(root) {
  try {
    const raw = await readFile(path.join(await resolveGitDir(root), 'MERGE_HEAD'), 'utf8');
    return raw.trim().split(/\s+/)[0] || '';
  } catch (error) {
    if (/** @type {{code?: string}} */ (error)?.code === 'ENOENT') return null;
    // Présent mais illisible : un merge est ouvert, son SHA est inconnu.
    return '';
  }
}

/**
 * Le marqueur désigne-t-il le merge ouvert ? Un marqueur illisible ou sans SHA
 * (écrit par une version antérieure) couvre tout merge ouvert — fail closed.
 * Un SHA enregistré qui diffère de MERGE_HEAD (ou `null` : le merge désigné
 * avait déjà disparu) désigne un AUTRE merge : le marqueur est périmé.
 * @param {Record<string, any>} marker
 * @param {string} openMergeHead
 */
function markerCoversMerge(marker, openMergeHead) {
  if (marker.unreadable === true) return true;
  if (!('mergeHead' in marker)) return true;
  if (typeof marker.mergeHead !== 'string' || marker.mergeHead === '') return false;
  return openMergeHead === '' || marker.mergeHead === openMergeHead;
}

/**
 * Retire le marqueur MERGE_STATE_CHANGED. Un échec n'est jamais fatal ici
 * (marqueur lié au merge : périmé, il ne bloque plus rien) mais il est nommé.
 * @param {string} root
 * @param {string} why
 */
async function clearMergeStateMarker(root, why) {
  const file = mergeStateMarkerPath(root);
  try {
    await rm(file, { force: true });
    logger.info(`Marqueur MERGE_STATE_CHANGED levé : ${why}`);
  } catch (error) {
    logger.warn(
      { file, cause: /** @type {{code?: string}} */ (error)?.code ?? 'UNKNOWN' },
      'Marqueur MERGE_STATE_CHANGED périmé impossible à supprimer — sans effet tant qu’il ne désigne aucun merge ouvert',
    );
  }
}

/**
 * Un merge --no-commit interrompu par un crash laisse le repo principal en
 * état de merge (MERGE_HEAD présent). Comme on vient d'obtenir le verrou,
 * aucune opération légitime n'est en cours (sauf session déclarée sur le
 * principal, écartée juste avant par assertNoLiveMainSession) : c'est un
 * débris → abort.
 *
 * SAUF si un MERGE_STATE_CHANGED l'a signalé : ce merge-là a été ouvert par
 * quelqu'un d'autre pendant une opération Striart, l'annuler détruirait son
 * travail → MERGE_RECOVERY_BLOCKED jusqu'à décision humaine (finir le merge,
 * ou `git merge --abort`). Le marqueur est LIÉ au SHA de MERGE_HEAD qu'il a
 * constaté : il se lève de lui-même dès qu'aucun merge n'est plus ouvert, et
 * un marqueur qui désigne un autre merge est périmé (il ne bloque rien).
 * Une annulation qui échoue lève MERGE_ABORT_FAILED (le principal reste en
 * état « merging » : jamais poursuivre dessus).
 */
async function recoverOrphanMerge(root) {
  const openMergeHead = await readOpenMergeHead(root);
  const merging = openMergeHead !== null;
  const marker = await readMergeStateMarker(root);
  if (marker && !merging) {
    await clearMergeStateMarker(root, 'plus aucun merge ouvert dans le principal');
    return;
  }
  if (!merging) return;
  if (marker) {
    if (markerCoversMerge(marker, openMergeHead)) {
      throw new StriartError(
        `Merge ouvert dans le repo principal que Striart n'annulera PAS : une opération précédente ` +
          `(${marker.operation ?? 'inconnue'}) a constaté qu'il ne lui appartenait pas (MERGE_STATE_CHANGED). ` +
          `Termine-le (git commit) ou annule-le (git merge --abort) toi-même ; supprimer ` +
          `${mergeStateMarkerPath(root)} autorise Striart à l'annuler.`,
        {
          code: 'MERGE_RECOVERY_BLOCKED',
          hint: 'git merge --abort',
          details: {
            operation: marker.operation ?? null,
            agent: marker.agent ?? null,
            marker: mergeStateMarkerPath(root),
          },
        },
      );
    }
    await clearMergeStateMarker(root, 'il désignait un autre merge que celui qui est ouvert');
  }
  logger.warn(
    'Merge orphelin détecté dans le repo principal (crash précédent ?) — merge --abort de récupération',
  );
  const git = simpleGit(root);
  try {
    await git.raw(['merge', '--abort']);
    return;
  } catch (error) {
    logger.warn(
      { err: /** @type {Error} */ (error)?.message },
      'git merge --abort de récupération en échec — état relu',
    );
  }
  // L'abort a échoué : soit il n'y avait plus de merge (course), soit le principal est bloqué.
  const stillMerging = await git.revparse(['-q', '--verify', 'MERGE_HEAD']).then(
    () => true,
    () => false,
  );
  if (stillMerging) {
    throw new StriartError(
      'git merge --abort a échoué : le repo principal est bloqué en état "merging". ' +
        'Intervention manuelle requise ("git merge --abort" puis vérifier "git status").',
      { code: 'MERGE_ABORT_FAILED', hint: 'git merge --abort' },
    );
  }
}

async function stateDirExists(root) {
  try {
    return (await stat(striartDir(root))).isDirectory();
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return false;
    throw error;
  }
}

/**
 * Ce qu'un appelant a constaté en attendant le verrou (lock:contention).
 * @typedef {{contended: boolean, holderLabel: string | null, holderSince: number | null, queued: number}} Contention
 */

/** Verbe seul d'une étiquette (`merge:agent-x` → `merge`) : jamais un identifiant, qui peut dériver d'un prompt. */
function operationVerb(label) {
  const verb = String(label ?? '').split(':')[0];
  return /^[a-z][a-z0-9-]{0,31}$/.test(verb) ? verb : 'unknown';
}

/**
 * Publie `lock:contention` sur le bus (events.js) quand l'acquisition n'a pas été immédiate.
 * Mesure pure, hors chemin de décision : chargement paresseux (la complétion shell et les
 * commandes sans contention ne paient pas le bus), émission différée, aucune erreur propagée.
 * @param {string} label @param {number} waitedMs @param {Contention} contention
 */
function reportContention(label, waitedMs, contention) {
  if (!contention.contended) return;
  const holderLabel = contention.holderLabel;
  const holderAgeMs =
    contention.holderSince === null ? null : Math.max(0, Date.now() - contention.holderSince);
  setImmediate(() => {
    import('./events.js')
      .then(({ emitLockContention }) =>
        emitLockContention({
          type: 'lock:contention',
          operation: operationVerb(label),
          waitedMs: Math.round(waitedMs * 100) / 100,
          holder:
            holderLabel === null && holderAgeMs === null
              ? null
              : {
                  operation: holderLabel === null ? null : operationVerb(holderLabel),
                  ageMs: holderAgeMs,
                },
          queued: Math.max(1, contention.queued),
        }),
      )
      .catch((error) => logger.debug({ err: error?.message }, 'lock:contention non publié'));
  });
}

/** Clé d'un repo dans les structures en mémoire : sa racine résolue. */
function lockKey(root) {
  return path.resolve(root);
}

/**
 * Exécute `fn` sous le verrou global du repo principal (.striart/main.lock).
 *
 * - exclusion mutuelle ENTRE processus (watch + CLI manuelle, deux CLI...),
 *   servie dans l'ordre d'arrivée (file équitable) ;
 * - exclusion mutuelle ENTRE contextes asynchrones d'un même process
 *   (requêtes parallèles du MCP, tâches de fond du dashboard) ;
 * - réentrant pour un appel fait depuis la section critique (même contexte
 *   asynchrone) — voir l'en-tête du module pour le cas d'un travail lancé
 *   sans être attendu, qui exige `runOutsideMainLock` ;
 * - verrous périmés cassés seulement sur preuve (en-tête du module) ;
 * - à l'acquisition, récupération d'un éventuel merge orphelin (sauf merge
 *   tiers signalé : MERGE_RECOVERY_BLOCKED).
 *
 * @template T
 * @param {string} root
 * @param {string} label   Nom de l'opération, affiché à qui attend le verrou.
 * @param {() => Promise<T>} fn
 * @param {{timeoutMs?: number, signal?: AbortSignal | null, recoverMerge?: boolean}} [opts]
 *   `signal` annule l'ATTENTE du verrou (file en mémoire, file inter-process,
 *   sondage) tant qu'il n'est pas acquis : ticket retiré, LOCK_WAIT_CANCELLED.
 *   Une fois le verrou acquis, il n'interrompt jamais la section critique.
 *   `recoverMerge: false` saute la récupération d'un merge ouvert (ni abort,
 *   ni MERGE_RECOVERY_BLOCKED) : réservé à `reserveMainSession`, qui ne touche
 *   pas au repo et ne doit ni annuler le merge de l'humain qu'elle protège, ni
 *   lui être refusée pendant qu'il le termine.
 * @returns {Promise<T>}
 */
export async function withMainLock(
  root,
  label,
  fn,
  { timeoutMs = DEFAULT_TIMEOUT_MS, signal = null, recoverMerge = true } = {},
) {
  const key = lockKey(root);
  const store = lockContext.getStore();
  // Réentrant : le verrou est déjà tenu, il n'y a aucune attente à annuler.
  if (store?.get(key)?.held) return fn();

  if (signal?.aborted) throw lockWaitCancelledError(label, lockPath(root));
  // Données locales réservées à l'utilisateur, AVANT le verrou : l'appel peut
  // coûter 1 à 3 s sous Windows (icacls) et n'a rien à faire sous un verrou
  // dont la durée gèle l'orchestrateur. Mémoïsé par racine et par process
  // (ensureStateProtection) ; échec = STATE_UNPROTECTED (fail closed), ou
  // relâchement explicite `privateStateDir: false` (journalisé, doctor).
  // Sans `.striart/` : rien à protéger (l'opération lèvera NOT_INITIALIZED) —
  // la protection ne crée jamais le dossier d'un dépôt non initialisé.
  if (await stateDirExists(root)) await ensureStateProtection(root);
  const deadline = Date.now() + timeoutMs;
  const arrivedAt = performance.now();
  /** @type {Contention} */
  const contention = {
    contended: false,
    holderLabel: null,
    holderSince: null,
    queued: 0,
  };
  const releaseTurn = await takeLocalTurn(key, label, deadline, lockPath(root), signal, contention);
  try {
    const lock = await acquire(root, label, deadline, signal, contention);
    // Acquis : à partir d'ici, le signal n'interrompt JAMAIS la section critique.
    if (lock !== null) reportContention(label, performance.now() - arrivedAt, contention);
    if (lock === null) return await fn(); // pas de .striart/ : l'opération lèvera NOT_INITIALIZED

    /** @type {Holding} */
    const holding = {
      key,
      file: lock.file,
      token: lock.token,
      label,
      handle: lock.handle,
      record: lock.record,
      held: true,
      lost: false,
      timer: null,
      beating: null,
    };
    ownedFiles.set(lock.file, lock.token);
    startHeartbeat(holding);
    const scope = new Map(store ?? []);
    scope.set(key, holding);
    try {
      return await lockContext.run(scope, async () => {
        await assertNoLiveMainSession(root);
        if (recoverMerge) await recoverOrphanMerge(root);
        return fn();
      });
    } finally {
      holding.held = false;
      if (holding.timer) clearInterval(holding.timer);
      // Un battement en vol écrit par le handle : il finit avant la fermeture.
      await holding.beating;
      await releaseLock(holding);
    }
  } finally {
    releaseTurn();
  }
}

/**
 * Exécute `fn` HORS de tout verrou tenu par le contexte courant : `fn` et ce
 * qu'elle lance prennent le verrou comme n'importe quel appelant de premier
 * niveau. REQUIS pour détacher depuis une section critique (sans l'attendre)
 * un travail qui prend le verrou ou touche au repo principal — sans lui, ce
 * travail serait réentrant et s'exécuterait EN MÊME TEMPS que la section.
 * @template T
 * @param {() => T} fn
 * @returns {T}
 */
export function runOutsideMainLock(fn) {
  return lockContext.exit(fn);
}

/** Relit un fichier de verrou en réessayant (borné) une lecture impossible. */
async function readLockFileSteady(file) {
  let current = await readLockFile(file);
  for (const delay of IO_RETRY_DELAYS_MS) {
    if (current?.state !== 'unreadable') return current;
    await sleep(delay);
    current = await readLockFile(file);
  }
  return current;
}

/**
 * Vérifie, juste avant un effet irréversible (commit, écriture dans le
 * principal, reset), que le contexte courant tient TOUJOURS le verrou du
 * repo `root` : section critique en cours, fichier présent et portant notre
 * jeton. Sinon LOCK_LOST — l'opération s'arrête sans rien écrire. Un fichier
 * durablement illisible ne prouve pas la tenue : refus (fail closed).
 * @param {string} root
 * @returns {Promise<void>}
 */
export async function assertMainLockHeld(root) {
  const holding = lockContext.getStore()?.get(lockKey(root));
  const lockFile = lockPath(root);
  if (!holding?.held) {
    throw new StriartError(
      'Verrou du repo principal non tenu par cette opération : effet irréversible refusé.',
      {
        code: 'LOCK_LOST',
        hint: 'striart doctor',
        details: { operation: holding?.label ?? null, reason: 'NOT_HELD', lockFile },
      },
    );
  }
  const current = holding.lost ? null : await readLockFileSteady(holding.file);
  const ours = current?.state === 'ok' && current.info.token === holding.token;
  if (holding.lost || !ours) {
    if (current?.state !== 'unreadable') holding.lost = true;
    const reason =
      current === null ? 'REMOVED' : current.state === 'unreadable' ? 'UNREADABLE' : 'REPLACED';
    throw new StriartError(
      `Verrou du repo principal perdu pendant « ${holding.label} » (${reason}) : un autre process l'a cassé ou repris, ` +
        "ou sa tenue n'est plus vérifiable. Opération interrompue sans rien écrire ; l'état reste récupérable.",
      {
        code: 'LOCK_LOST',
        hint: 'striart doctor',
        details: {
          operation: holding.label,
          reason,
          holderPid: current?.state === 'ok' ? (current.info.pid ?? null) : null,
          lockFile,
        },
      },
    );
  }
}

/**
 * État RÉEL du verrou, pour `striart doctor` (lecture seule, aucune cassure).
 * @param {string} root
 * @returns {Promise<{state: 'free'|'held'|'frozen'|'stale'|'unreadable'|'invalid', holder: string|null, pid: number|null, startedAt: string|null, heartbeatAgeMs: number|null, staleReason: string|null, queued: number, breakFrozenHolderAfterMs: number|null, recoveryBlocked: {operation: string|null, agent: string|null, marker: string}|null}>}
 */
export async function readMainLockStatus(root) {
  const file = lockPath(root);
  const breakFrozenHolderAfterMs = await readFrozenBreakPolicy(root);
  const queued = (await listTickets(queueDirOf(root)).catch(() => [])).length;
  const marker = await readMergeStateMarker(root);
  const openMergeHead = await readOpenMergeHead(root);
  const recoveryBlocked =
    marker && openMergeHead !== null && markerCoversMerge(marker, openMergeHead)
      ? {
          operation: marker.operation ?? null,
          agent: marker.agent ?? null,
          marker: mergeStateMarkerPath(root),
        }
      : null;
  const base = {
    holder: null,
    pid: null,
    startedAt: null,
    heartbeatAgeMs: null,
    staleReason: null,
    queued,
    breakFrozenHolderAfterMs,
    recoveryBlocked,
  };
  const current = await readLockFile(file);
  if (current === null) return { ...base, state: 'free' };
  if (current.state === 'unreadable') return { ...base, state: 'unreadable' };
  const mtime = await mtimeMs(file);
  const verdict = await judgeLock(current, mtime, createStaleObservation(), {
    // Lecture seule : la politique n'entre pas dans le constat.
    frozenBreakAfterMs: async () => null,
  });
  if (current.state === 'invalid') {
    return {
      ...base,
      state: verdict.stale ? 'stale' : 'invalid',
      staleReason: verdict.stale ? verdict.reason : null,
    };
  }
  const { info } = current;
  const facts = {
    ...base,
    holder: info.label ?? null,
    pid: info.pid ?? null,
    startedAt: info.startedAt ?? null,
    heartbeatAgeMs:
      typeof info.token === 'string' ? Math.max(0, Date.now() - lastBeatMs(info, mtime)) : null,
  };
  if (verdict.stale) return { ...facts, state: 'stale', staleReason: verdict.reason };
  return { ...facts, state: verdict.reason === 'HOLDER_FROZEN' ? 'frozen' : 'held' };
}

/** Commande qui arrête le détenteur `pid` (piste de doctor et de LOCK_TIMEOUT). */
export function stopHolderCommand(pid) {
  return stopPidCommand(pid);
}

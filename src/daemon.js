/**
 * Process détaché générique pour un sous-process `striart <cmd>` de longue
 * durée — sans pm2/systemd. Un process Node détaché exécute `striart <name>`
 * (le même code que le foreground : zéro divergence), sa sortie va dans
 * `.striart/logs/<name>.log`, son PID dans `.striart/<name>.pid`.
 * `--status`/`--stop` pilotent le cycle de vie ; un PID file orphelin
 * (crash, reboot) est détecté et nettoyé. Pour une reprise au boot,
 * enregistrer la commande `--daemon` dans le gestionnaire de l'OS
 * (Tâches planifiées / systemd / launchd) — Striart ne s'installe pas
 * lui-même comme service.
 *
 * Généralisé le 2026-09-09 pour `dashboard --daemon` : `watch --daemon` en
 * était l'unique consommateur, la logique (PID file, détection stale, spawn
 * détaché) ne dépendait de rien de spécifique à `watch` — extraite plutôt que
 * recopiée (règle n°0). Les wrappers `watch*Daemon*` ci-dessous gardent leurs
 * noms et signatures d'origine : `cli.js`/`dashboard.js`/`mcp.js` les
 * consomment déjà, aucune raison de les faire migrer vers l'API générique.
 */
import { spawn } from 'node:child_process';
import { mkdir, open, rm } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { striartDir } from './paths.js';
import { StriartError } from './errors.js';
import { readJson, writeJsonAtomic } from './json-file.js';
import { withFileLock } from './state-lock.ts';
import { loadConfig } from './config.js';
import { DAEMON_LOG_ENV, logger } from './logger.js';
import { rotateLogFileIfNeeded } from './log-rotation.ts';
import { checkProcessInstance } from './process-info.ts';
import { clearStopRequest, requestStop, watchStopRequest } from './stop-request.ts';

function pidFilePath(root, name) {
  return path.join(striartDir(root), `${name}.pid`);
}

function stopFilePath(root, name) {
  return path.join(striartDir(root), `${name}.stop`);
}

function pidLockPath(root, name) {
  return path.join(striartDir(root), `${name}.pid.lock`);
}

function logFilePath(root, name) {
  return path.join(striartDir(root), 'logs', `${name}.log`);
}

/**
 * Rotation du journal d'un daemon (`logMaxBytes`, `logGenerations`). Une
 * config invalide fait échouer le départ (CONFIG_INVALID) : le daemon
 * échouerait de toute façon à la charger.
 * @param {string} root
 */
async function daemonLogRotation(root) {
  const config = await loadConfig(root);
  return { maxBytes: config.logMaxBytes, generations: config.logGenerations };
}

/**
 * Lit le PID file du daemon `name`. SEUL ENOENT prouve l'absence de daemon
 * (null). Toute autre issue est nommée : lecture impossible → STATE_READ_FAILED
 * (après nouvelles tentatives sur les erreurs passagères de Windows), contenu
 * illisible ou sans PID → DAEMON_PIDFILE_CORRUPT. Un PID file illisible pris pour
 * « aucun daemon » (fail-open) lançait un second daemon et laissait `--stop`
 * sans effet sur le premier.
 * @param {string} root @param {string} name
 * @returns {Promise<{pid: number, startedAt?: string, url?: string} | null>}
 */
async function readPidFile(root, name) {
  const file = pidFilePath(root, name);
  const corrupt = (/** @type {unknown} */ cause) =>
    new StriartError(
      `Le PID file du ${name} daemon est illisible ou corrompu (${file}) : impossible de savoir si un daemon tourne.`,
      {
        code: 'DAEMON_PIDFILE_CORRUPT',
        hint: `inspecte ${file}, supprime-le si aucun daemon ne tourne, puis relance`,
        details: {
          name,
          path: file,
          cause: cause instanceof Error ? cause.message : String(cause),
        },
      },
    );
  let raw;
  try {
    raw = await readJson(file, { fallback: null, code: 'DAEMON_PIDFILE_CORRUPT' });
  } catch (error) {
    if (error instanceof StriartError && error.code === 'DAEMON_PIDFILE_CORRUPT')
      throw corrupt(error);
    throw error;
  }
  if (raw === null) return null;
  if (typeof raw !== 'object' || Array.isArray(raw) || !Number.isInteger(raw.pid) || raw.pid <= 0) {
    throw corrupt('contenu sans PID valide');
  }
  return raw;
}

/** Délai d'attente de la sortie effective du daemon après la demande d'arrêt. */
const STOP_WAIT_MS = 10_000;
/** Délai d'accusé de la demande d'arrêt (le daemon la lit toutes les 250 ms). */
const STOP_ACK_WAIT_MS = 5_000;
/** Délai d'attente du verrou du PID file (un détenteur légitime le tient le temps d'un lancement). */
const PID_LOCK_TIMEOUT_MS = 10_000;
/** Un lancement (identité relue auprès de l'OS, spawn) peut durer : seuil d'alerte propre à ce verrou. */
const PID_LOCK_SLOW_WARN_MS = 15_000;

/**
 * Exclusion mutuelle des écritures du PID file `name` (démarrage, retrait).
 * Sans elle, deux `--daemon` simultanés passaient tous deux le contrôle
 * « aucun daemon » et lançaient deux watchers ; un retrait pouvait effacer le
 * PID file qu'un démarrage venait d'écrire. Verrou à jeton partagé avec le
 * verrou d'état (state-lock.js, `withFileLock`) : un verrou laissé par un
 * démarreur MORT est repris tout de suite, les cassures sont sérialisées sous
 * le verrou de cassure (jamais deux casseurs qui s'effacent l'un l'autre), un
 * détenteur vivant n'est jamais cassé.
 * @template T @param {string} root @param {string} name @param {() => Promise<T>} fn
 * @param {number} [timeoutMs]
 * @returns {Promise<T>}
 */
async function withPidLock(root, name, fn, timeoutMs = PID_LOCK_TIMEOUT_MS) {
  const lock = pidLockPath(root, name);
  await mkdir(path.dirname(lock), { recursive: true });
  try {
    return await withFileLock(lock, fn, { timeoutMs, slowHoldWarnMs: PID_LOCK_SLOW_WARN_MS });
  } catch (error) {
    if (error instanceof StriartError && error.code === 'STATE_LOCK_TIMEOUT') {
      throw new StriartError(
        `Le PID file du ${name} daemon est verrouillé par une autre commande.`,
        {
          code: 'DAEMON_BUSY',
          hint: `striart ${name} --status`,
          details: { name },
          cause: error,
        },
      );
    }
    throw error;
  }
}

/**
 * Le PID publié désigne-t-il encore NOTRE daemon ? Un numéro recyclé par
 * l'OS (crash, reboot) peut appartenir à n'importe quel process : le croire
 * vivant refusait `--daemon` à vie, et `--stop` le tuait. Le daemon est
 * reconnu à sa ligne de commande (`node …/cli.js <name> …`, voir startDaemon).
 * @param {number} pid @param {string} name
 */
function checkDaemonProcess(pid, name, { fresh = false, startedAt = null } = {}) {
  // startedAt : un process créé après la publication du PID n'est pas le
  // daemon publié (PID recyclé), même si sa ligne de commande concorde.
  return checkProcessInstance(
    pid,
    { scriptName: 'cli.js', args: [name], startedAt },
    { cache: !fresh },
  );
}

/**
 * État du daemon `name`. Un PID file dont le process est mort — ou dont le
 * numéro appartient désormais à un autre process — est signalé stale
 * (nettoyé par start/stop, jamais silencieusement ici — fonction de
 * lecture). Une identité illisible (process d'un autre utilisateur) compte
 * comme vivante : on ne remplace pas ce qu'on ne peut pas identifier.
 * @param {{root: string, name: string, fresh?: boolean}} params
 * `url` : adresse publiée par le daemon lui-même une fois à l'écoute
 * (dashboard), null sinon.
 * `fresh` : relit l'identité sans cache — obligatoire avant une décision
 * destructive (tuer, oublier le PID file).
 * @returns {Promise<{running: boolean, stale: boolean, verified: boolean, pid: number|null, startedAt: string|null, logPath: string, url: string|null}>}
 */
export async function daemonStatus({ root, name, fresh = false }) {
  const info = await readPidFile(root, name);
  if (!info)
    return {
      running: false,
      stale: false,
      verified: false,
      pid: null,
      startedAt: null,
      logPath: logFilePath(root, name),
      url: null,
    };
  const verdict = await checkDaemonProcess(info.pid, name, {
    fresh,
    startedAt: info.startedAt ?? null,
  });
  const alive = verdict === 'alive' || verdict === 'unverified';
  return {
    running: alive,
    stale: !alive,
    // Vivant mais non identifiable : on s'abstient de le remplacer, et on
    // refuse de le tuer (stopDaemon).
    verified: verdict === 'alive',
    pid: info.pid,
    startedAt: info.startedAt ?? null,
    logPath: logFilePath(root, name),
    url: typeof info.url === 'string' ? info.url : null,
  };
}

/**
 * Appelé PAR le daemon en cours d'exécution pour publier une information
 * connue seulement après démarrage (l'URL réelle du dashboard). N'écrit que
 * si le PID file désigne bien ce process : un daemon remplacé entre-temps
 * ne doit jamais voir son PID file réécrit par l'ancien.
 * @param {{root: string, name: string, patch: Record<string, unknown>}} params
 */
export async function publishDaemonInfo({ root, name, patch }) {
  // Le parent écrit le PID file APRÈS le spawn : le daemon peut être prêt
  // avant. Quelques secondes d'attente au plus, puis abandon silencieux —
  // l'information est un confort d'affichage, jamais une décision.
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const info = await readPidFile(root, name);
    if (info?.pid === process.pid) {
      // Écriture atomique : `--status` ou un second `--daemon` lisant un
      // fichier tronqué le croiraient absent (et en lanceraient un autre).
      await writeJsonAtomic(pidFilePath(root, name), { ...info, ...patch });
      return;
    }
    if (info && info.pid !== process.pid) return; // un autre daemon a pris la place
    await sleep(100);
  }
}

/**
 * Démarre `striart <args[0]>` en process détaché. Refuse si un daemon du même
 * `name` tourne déjà. `extraMeta` est fusionné dans le PID file (ex :
 * `{ noMerge }` pour watch, `{ port }` pour dashboard) — informatif, jamais
 * relu pour une décision de sécurité.
 * `lockTimeoutMs` : attente maximale du verrou du PID file (défaut 10 s).
 * @param {{root: string, name: string, label: string, args: string[], extraMeta?: object, lockTimeoutMs?: number}} params
 * @returns {Promise<{pid: number, logPath: string}>}
 */
export async function startDaemon(params) {
  return withPidLock(
    params.root,
    params.name,
    () => startDaemonLocked(params),
    params.lockTimeoutMs ?? PID_LOCK_TIMEOUT_MS,
  );
}

/** @param {{root: string, name: string, label: string, args: string[], extraMeta?: object, lockTimeoutMs?: number}} params */
/** @param {string} name @param {unknown} cause */
function spawnFailed(name, cause) {
  const message = cause instanceof Error ? cause.message : String(cause);
  return new StriartError(`Le ${name} daemon n'a pas pu être lancé : ${message}.`, {
    code: 'DAEMON_SPAWN_FAILED',
    hint: 'striart doctor',
    details: { name, cause: message },
  });
}

async function startDaemonLocked({ root, name, label, args, extraMeta = {} }) {
  const status = await daemonStatus({ root, name });
  if (status.running) {
    throw new StriartError(
      `Un ${label} daemon tourne déjà (PID ${status.pid}). "striart ${name} --stop" pour l'arrêter.`,
      {
        code: 'DAEMON_RUNNING',
        hint: `striart ${name} --status`,
        details: { name, pid: status.pid },
      },
    );
  }
  if (status.stale) await rm(pidFilePath(root, name), { force: true });
  // Une demande d'arrêt restée d'un daemon précédent ne doit jamais viser le
  // nouveau (même numéro recyclé).
  await rm(stopFilePath(root, name), { force: true });

  const logPath = logFilePath(root, name);
  await mkdir(path.dirname(logPath), { recursive: true });
  const rotation = await daemonLogRotation(root);
  // Un journal hérité déjà trop gros est tourné AVANT d'être rouvert ; le
  // daemon tourne ensuite lui-même son journal (logger.js, DAEMON_LOG_ENV).
  await rotateLogFileIfNeeded(logPath, rotation).catch((error) => {
    // Journal tenu ouvert par un lecteur (Windows) : le daemon démarre quand
    // même, sa propre rotation retentera. Signalé, jamais tu.
    logger.warn({ err: error.code ?? error.message, logPath }, 'Rotation du journal reportée');
  });
  // Poignée du journal ouverte en asynchrone et FERMÉE ici dans tous les cas : le
  // fils en hérite une copie au lancement, le parent n'en a plus besoin.
  const logHandle = await open(logPath, 'a');
  /** @type {import('node:child_process').ChildProcess} */
  let child;
  try {
    const cliPath = fileURLToPath(new URL('./cli.js', import.meta.url));
    child = spawn(process.execPath, [cliPath, ...args], {
      cwd: root,
      detached: true,
      stdio: ['ignore', logHandle.fd, logHandle.fd],
      env: {
        ...process.env,
        STRIART_DAEMON: '1',
        [DAEMON_LOG_ENV.file]: logPath,
        [DAEMON_LOG_ENV.maxBytes]: String(rotation.maxBytes),
        [DAEMON_LOG_ENV.generations]: String(rotation.generations),
      },
    });
  } catch (error) {
    await logHandle.close().catch(() => {});
    throw spawnFailed(name, error);
  }
  // L'écouteur est posé AVANT tout `await` : un lancement raté émet `error` au tour
  // suivant, et un `error` sans écouteur ferait tomber le process. Il reste en place
  // après le détachement (erreur tardive journalisée, jamais fatale).
  const spawnError = new Promise((resolve) => {
    child.once('error', resolve);
  });
  child.on('error', (error) => {
    logger.warn({ name, err: error.message }, 'Erreur du process daemon détaché');
  });
  try {
    if (!Number.isInteger(child.pid)) {
      const cause = await Promise.race([spawnError, sleep(1_000).then(() => null)]);
      throw spawnFailed(name, cause ?? new Error('aucun PID reçu'));
    }
  } finally {
    await logHandle.close().catch(() => {});
  }
  child.unref();
  try {
    await writeJsonAtomic(pidFilePath(root, name), {
      pid: child.pid,
      startedAt: new Date().toISOString(),
      ...extraMeta,
    });
  } catch (error) {
    // Un daemon sans PID file serait invisible de `--status`/`--stop` : on ne le laisse pas vivre.
    try {
      process.kill(/** @type {number} */ (child.pid));
    } catch (killError) {
      logger.error(
        { name, pid: child.pid, err: killError },
        'Daemon lancé sans PID file, arrêt impossible',
      );
    }
    throw error;
  }
  return { pid: /** @type {number} */ (child.pid), logPath };
}

/**
 * Arrête le daemon `name` et attend sa sortie effective. Idempotent : sans
 * daemon vivant, nettoie un éventuel PID file orphelin et le signale.
 *
 * L'arrêt passe par la demande d'arrêt (`stop-request.js`) que le daemon
 * lit lui-même : il s'arrête comme sur SIGTERM — le watcher termine et
 * rapporte le merge en vol — y compris sous Windows, où un signal est un
 * TerminateProcess. Sans accusé (daemon d'une version antérieure, ou
 * bloqué), repli sur le signal.
 *
 * Le PID file n'est retiré qu'une fois le process sorti : le retirer tout de
 * suite laissait démarrer un second watcher pendant que le premier mergeait
 * encore. Passé `waitMs`, l'arrêt est rendu `stopping` et le PID file reste
 * en place — le daemon le retire en sortant (releaseDaemonPidFile). Un
 * second `--stop` pendant ce temps ne re-signale pas : il attend.
 *
 * Fail closed : un process non identifiable (`unverified`) n'est jamais
 * tué — DAEMON_IDENTITY_UNVERIFIED ; un process que l'on n'a pas le droit de
 * signaler (EPERM) non plus — DAEMON_STOP_DENIED. Dans les deux cas, le PID
 * file reste en place.
 * @param {{root: string, name: string, waitMs?: number, ackWaitMs?: number}} params
 * @returns {Promise<{stopped: boolean, stopping: boolean, wasStale: boolean, pid: number|null}>}
 */
export async function stopDaemon({
  root,
  name,
  waitMs = STOP_WAIT_MS,
  ackWaitMs = STOP_ACK_WAIT_MS,
}) {
  // Identité relue sans cache : la décision est destructive.
  const status = await daemonStatus({ root, name, fresh: true });
  if (!status.running) {
    if (status.stale) await releasePidFileOf(root, name, status.pid);
    return { stopped: false, stopping: false, wasStale: status.stale, pid: status.pid };
  }
  const pid = /** @type {number} */ (status.pid);
  if (!status.verified) {
    throw new StriartError(
      `Le PID ${pid} du ${name} daemon est vivant mais son identité est illisible : rien n'est tué à l'aveugle.`,
      {
        code: 'DAEMON_IDENTITY_UNVERIFIED',
        hint: `striart ${name} --status`,
        details: { name, pid },
      },
    );
  }
  let outcome;
  try {
    outcome = await requestStop({
      file: stopFilePath(root, name),
      pid,
      ackWaitMs,
      waitMs,
      fallback: () => process.kill(pid),
      // Le délai d'accusé est une fenêtre pendant laquelle le numéro peut changer de
      // propriétaire : identité relue SANS CACHE juste avant le signal de repli.
      confirmIdentity: async () =>
        (await checkDaemonProcess(pid, name, { fresh: true, startedAt: status.startedAt })) ===
        'alive',
    });
  } catch (error) {
    const code = /** @type {NodeJS.ErrnoException} */ (error)?.code;
    if (code === 'ESRCH') {
      // Sorti entre l'état et le signal : course bénigne, PID file orphelin.
      await releasePidFileOf(root, name, pid);
      return { stopped: false, stopping: false, wasStale: true, pid };
    }
    if (code === 'EPERM') {
      throw new StriartError(
        `Le ${name} daemon (PID ${pid}) appartient à un autre utilisateur : impossible de l'arrêter depuis ce compte.`,
        {
          code: 'DAEMON_STOP_DENIED',
          hint: `striart ${name} --status`,
          details: { name, pid },
        },
      );
    }
    throw error;
  }
  if (outcome === 'stopping') return { stopped: false, stopping: true, wasStale: false, pid };
  await releasePidFileOf(root, name, pid);
  return { stopped: true, stopping: false, wasStale: false, pid };
}

/**
 * Retire le PID file (et la demande d'arrêt) s'ils désignent toujours
 * `pid` — jamais ceux d'un daemon qui aurait pris la place entre-temps.
 * @param {string} root @param {string} name @param {number|null} pid
 */
async function releasePidFileOf(root, name, pid) {
  await withPidLock(root, name, async () => {
    const info = await readPidFile(root, name);
    if (info && info.pid !== pid) return;
    await rm(pidFilePath(root, name), { force: true });
    await clearStopRequest(stopFilePath(root, name), pid);
  });
}

/**
 * Appelé PAR le daemon à sa sortie : retire son propre PID file. Un arrêt
 * plus long que l'attente de `stopDaemon` (merge en cours) le laisse sinon
 * en place jusqu'à la détection stale suivante.
 * @param {{root: string, name: string}} params
 */
export async function releaseDaemonPidFile({ root, name }) {
  await releasePidFileOf(root, name, process.pid);
}

/**
 * Appelé PAR le daemon : `onStop` quand `stopDaemon` lui demande de
 * s'arrêter. Rend la fonction qui arrête la surveillance.
 * @param {{root: string, name: string, onStop: () => void}} params
 * @returns {() => void}
 */
export function watchDaemonStopRequest({ root, name, onStop }) {
  return watchStopRequest(stopFilePath(root, name), { onStop });
}

// --- watch --daemon --- (wrappers d'origine, noms/signatures inchangés)

/** @param {{root: string}} params */
export async function watchDaemonStatus({ root }) {
  return daemonStatus({ root, name: 'watch' });
}

/** @param {{root: string, noMerge?: boolean}} params */
export async function startWatchDaemon({ root, noMerge = false }) {
  return startDaemon({
    root,
    name: 'watch',
    label: 'watcher',
    args: ['watch', '--json', ...(noMerge ? ['--no-merge'] : [])],
    extraMeta: { noMerge },
  });
}

/** @param {{root: string}} params */
export async function stopWatchDaemon({ root }) {
  return stopDaemon({ root, name: 'watch' });
}

// --- dashboard --daemon ---

/** @param {{root: string}} params */
export async function dashboardDaemonStatus({ root }) {
  return daemonStatus({ root, name: 'dashboard' });
}

/** @param {{root: string, port?: number|null}} params */
export async function startDashboardDaemon({ root, port = null }) {
  return startDaemon({
    root,
    name: 'dashboard',
    label: 'dashboard',
    args: ['dashboard', '--json', ...(port != null ? ['--port', String(port)] : [])],
    extraMeta: { port },
  });
}

/** @param {{root: string}} params */
export async function stopDashboardDaemon({ root }) {
  return stopDaemon({ root, name: 'dashboard' });
}

/**
 * Signal d'arrêt d'une commande longue : le signal de la CLI (SIGINT /
 * SIGTERM), plus, quand elle tourne en daemon, la demande d'arrêt de
 * `stopDaemon` — le seul arrêt propre possible sous Windows.
 * @param {{root: string, name: string, signal: AbortSignal}} params
 * @returns {{signal: AbortSignal, dispose: () => void}}
 */
export function daemonStopSignal({ root, name, signal }) {
  if (process.env.STRIART_DAEMON !== '1') return { signal, dispose: () => {} };
  const requested = new AbortController();
  const dispose = watchDaemonStopRequest({ root, name, onStop: () => requested.abort() });
  return { signal: AbortSignal.any([signal, requested.signal]), dispose };
}

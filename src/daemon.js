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
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { openSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { striartDir } from './paths.js';
import { StriartError } from './errors.js';
import { isProcessAlive } from './process-tree.js';

function pidFilePath(root, name) {
  return path.join(striartDir(root), `${name}.pid`);
}

function logFilePath(root, name) {
  return path.join(striartDir(root), 'logs', `${name}.log`);
}

async function readPidFile(root, name) {
  try {
    const raw = JSON.parse(await readFile(pidFilePath(root, name), 'utf8'));
    return Number.isInteger(raw.pid) ? raw : null;
  } catch {
    return null;
  }
}

/**
 * État du daemon `name`. Un PID file dont le process est mort est signalé
 * stale (nettoyé par start/stop, jamais silencieusement ici — fonction de
 * lecture).
 * @param {{root: string, name: string}} params
 * @returns {Promise<{running: boolean, stale: boolean, pid: number|null, startedAt: string|null, logPath: string}>}
 */
export async function daemonStatus({ root, name }) {
  const info = await readPidFile(root, name);
  if (!info)
    return {
      running: false,
      stale: false,
      pid: null,
      startedAt: null,
      logPath: logFilePath(root, name),
    };
  const alive = isProcessAlive(info.pid);
  return {
    running: alive,
    stale: !alive,
    pid: info.pid,
    startedAt: info.startedAt ?? null,
    logPath: logFilePath(root, name),
  };
}

/**
 * Démarre `striart <args[0]>` en process détaché. Refuse si un daemon du même
 * `name` tourne déjà. `extraMeta` est fusionné dans le PID file (ex :
 * `{ noMerge }` pour watch, `{ port }` pour dashboard) — informatif, jamais
 * relu pour une décision de sécurité.
 * @param {{root: string, name: string, label: string, args: string[], extraMeta?: object}} params
 * @returns {Promise<{pid: number, logPath: string}>}
 */
export async function startDaemon({ root, name, label, args, extraMeta = {} }) {
  const status = await daemonStatus({ root, name });
  if (status.running) {
    throw new StriartError(
      `Un ${label} daemon tourne déjà (PID ${status.pid}). "striart ${name} --stop" pour l'arrêter.`,
      { code: 'DAEMON_RUNNING', details: { name, pid: status.pid } },
    );
  }
  if (status.stale) await rm(pidFilePath(root, name), { force: true });

  const logPath = logFilePath(root, name);
  await mkdir(path.dirname(logPath), { recursive: true });
  const logFd = openSync(logPath, 'a');

  const cliPath = fileURLToPath(new URL('./cli.js', import.meta.url));
  const child = spawn(process.execPath, [cliPath, ...args], {
    cwd: root,
    detached: true,
    stdio: ['ignore', logFd, logFd],
    env: { ...process.env, STRIART_DAEMON: '1' },
  });
  child.unref();

  await writeFile(
    pidFilePath(root, name),
    `${JSON.stringify({ pid: child.pid, startedAt: new Date().toISOString(), ...extraMeta })}\n`,
    'utf8',
  );
  return { pid: child.pid, logPath };
}

/**
 * Arrête le daemon `name` (SIGTERM) et nettoie le PID file. Idempotent :
 * sans daemon vivant, nettoie un éventuel PID file orphelin et le signale.
 * @param {{root: string, name: string}} params
 * @returns {Promise<{stopped: boolean, wasStale: boolean, pid: number|null}>}
 */
export async function stopDaemon({ root, name }) {
  const status = await daemonStatus({ root, name });
  if (!status.running) {
    if (status.stale) await rm(pidFilePath(root, name), { force: true });
    return { stopped: false, wasStale: status.stale, pid: status.pid };
  }
  process.kill(status.pid);
  await rm(pidFilePath(root, name), { force: true });
  return { stopped: true, wasStale: false, pid: status.pid };
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
    args: ['watch', ...(noMerge ? ['--no-merge'] : [])],
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
    args: ['dashboard', ...(port != null ? ['--port', String(port)] : [])],
    extraMeta: { port },
  });
}

/** @param {{root: string}} params */
export async function stopDashboardDaemon({ root }) {
  return stopDaemon({ root, name: 'dashboard' });
}

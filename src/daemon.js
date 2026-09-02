/**
 * striart watch --daemon — le watcher en arrière-plan, sans pm2/systemd.
 *
 * Un process Node détaché exécute `striart watch` (le même code que le
 * foreground : zéro divergence), sa sortie va dans .striart/logs/watch.log,
 * son PID dans .striart/watch.pid. --status et --stop pilotent le cycle de
 * vie ; un PID file orphelin (crash, reboot) est détecté et nettoyé.
 * Pour une reprise au boot, enregistrer `striart watch --daemon` dans le
 * gestionnaire de l'OS (Tâches planifiées / systemd / launchd) — Striart ne
 * s'installe pas lui-même comme service.
 */
import { spawn } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { openSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { striartDir } from './paths.js';
import { StriartError } from './errors.js';
import { isProcessAlive } from './process-tree.js';

function pidFilePath(root) {
  return path.join(striartDir(root), 'watch.pid');
}

function logFilePath(root) {
  return path.join(striartDir(root), 'logs', 'watch.log');
}

async function readPidFile(root) {
  try {
    const raw = JSON.parse(await readFile(pidFilePath(root), 'utf8'));
    return Number.isInteger(raw.pid) ? raw : null;
  } catch {
    return null;
  }
}

/**
 * État du daemon. Un PID file dont le process est mort est signalé stale
 * (nettoyé par start/stop, jamais silencieusement ici — fonction de lecture).
 * @param {{root: string}} params
 * @returns {Promise<{running: boolean, stale: boolean, pid: number|null, startedAt: string|null, logPath: string}>}
 */
export async function watchDaemonStatus({ root }) {
  const info = await readPidFile(root);
  if (!info)
    return { running: false, stale: false, pid: null, startedAt: null, logPath: logFilePath(root) };
  const alive = isProcessAlive(info.pid);
  return {
    running: alive,
    stale: !alive,
    pid: info.pid,
    startedAt: info.startedAt ?? null,
    logPath: logFilePath(root),
  };
}

/**
 * Démarre le watcher détaché. Refuse si un daemon tourne déjà.
 * @param {{root: string, noMerge?: boolean}} params
 * @returns {Promise<{pid: number, logPath: string}>}
 */
export async function startWatchDaemon({ root, noMerge = false }) {
  const status = await watchDaemonStatus({ root });
  if (status.running) {
    throw new StriartError(
      `Un watcher daemon tourne déjà (PID ${status.pid}). "striart watch --stop" pour l'arrêter.`,
      { code: 'DAEMON_RUNNING', details: { pid: status.pid } },
    );
  }
  if (status.stale) await rm(pidFilePath(root), { force: true });

  const logPath = logFilePath(root);
  await mkdir(path.dirname(logPath), { recursive: true });
  const logFd = openSync(logPath, 'a');

  const cliPath = fileURLToPath(new URL('./cli.js', import.meta.url));
  const args = [cliPath, 'watch', ...(noMerge ? ['--no-merge'] : [])];
  const child = spawn(process.execPath, args, {
    cwd: root,
    detached: true,
    stdio: ['ignore', logFd, logFd],
    env: { ...process.env, STRIART_DAEMON: '1' },
  });
  child.unref();

  await writeFile(
    pidFilePath(root),
    `${JSON.stringify({ pid: child.pid, startedAt: new Date().toISOString(), noMerge })}\n`,
    'utf8',
  );
  return { pid: child.pid, logPath };
}

/**
 * Arrête le daemon (SIGTERM) et nettoie le PID file. Idempotent : sans
 * daemon vivant, nettoie un éventuel PID file orphelin et le signale.
 * @param {{root: string}} params
 * @returns {Promise<{stopped: boolean, wasStale: boolean, pid: number|null}>}
 */
export async function stopWatchDaemon({ root }) {
  const status = await watchDaemonStatus({ root });
  if (!status.running) {
    if (status.stale) await rm(pidFilePath(root), { force: true });
    return { stopped: false, wasStale: status.stale, pid: status.pid };
  }
  process.kill(status.pid);
  await rm(pidFilePath(root), { force: true });
  return { stopped: true, wasStale: false, pid: status.pid };
}

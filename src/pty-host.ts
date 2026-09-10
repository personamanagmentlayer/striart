import { spawn } from 'node:child_process';
import { openSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { StriartError } from './errors.js';
import { loadConfig } from './config.js';
import { ptyDir, striartDir } from './paths.js';
import { isProcessAlive } from './process-tree.js';
import { readRegistry, validateAgentName } from './clone.js';
import type { AgentMeta } from './types.js';

/**
 * Cycle de vie du process hôte détaché d'un pty (roadmap : `watch`
 * interactif, Phase C). Distinct de `pty-attach.ts` : ce module ne possède
 * aucun pty lui-même, il démarre/surveille/arrête le PROCESS qui en
 * possède un — même patron que `daemon.js` (spawn détaché, PID file,
 * détection d'orphelin), mais un hôte PAR AGENT plutôt qu'un daemon
 * unique : `--open` doit pouvoir survivre indépendamment de la fenêtre qui
 * l'a demandé, donc le pty ne peut pas vivre dans le process CLI éphémère
 * (`striart start`/`run`) qui sort dès l'onglet ouvert.
 */

/** Shell hébergé par défaut quand `--open` ne précise pas d'outil dédié. */
export function defaultShell(): string {
  if (process.platform === 'win32') return 'powershell.exe';
  return process.env.SHELL || 'bash';
}

/**
 * Commande de l'outil de coding d'un agent supervisé : par-agent (registre)
 * > config globale > 'claude'. Seule implémentation (`cli.js` l'important
 * plutôt que de la dupliquer) — `--open` et le bus `@agent` de `watch`
 * (Phase D) doivent lancer exactement le même outil dans le pty.
 */
export async function resolveAttendedCommand(
  root: string,
  agentMeta: Pick<AgentMeta, 'command'>,
): Promise<string> {
  return agentMeta.command ?? (await loadConfig(root)).agentCommand ?? 'claude';
}

function pidFilePath(root: string, agent: string): string {
  return path.join(ptyDir(root), agent, 'host.pid');
}

function logFilePath(root: string, agent: string): string {
  return path.join(striartDir(root), 'logs', `pty-${agent}.log`);
}

interface PidFileContent {
  pid: number;
  startedAt: string;
}

async function readPidFile(root: string, agent: string): Promise<PidFileContent | null> {
  try {
    const raw = JSON.parse(await readFile(pidFilePath(root, agent), 'utf8'));
    return Number.isInteger(raw.pid) ? raw : null;
  } catch {
    return null;
  }
}

export interface PtyHostStatus {
  running: boolean;
  stale: boolean;
  pid: number | null;
  startedAt: string | null;
}

/** Un PID file dont le process est mort est signalé `stale`, jamais nettoyé silencieusement ici. */
export async function ptyHostStatus(root: string, agent: string): Promise<PtyHostStatus> {
  const info = await readPidFile(root, agent);
  if (!info) return { running: false, stale: false, pid: null, startedAt: null };
  const alive = isProcessAlive(info.pid);
  return { running: alive, stale: !alive, pid: info.pid, startedAt: info.startedAt };
}

export interface EnsurePtyHostOptions {
  shell: string;
  args?: string[];
  cwd: string;
  /** Écrite dans le pty juste après démarrage (ex : l'outil de coding de l'agent). */
  initialCommand?: string | null;
}

/**
 * Démarre le process hôte s'il n'est pas déjà vivant pour cet agent
 * (idempotent — un hôte déjà là est réutilisé, jamais dupliqué : c'est ce
 * qui permet à un second `--open` de rejoindre le même pty). Ne throw pas
 * sur un hôte déjà vivant, contrairement à `startWatchDaemon` (ici,
 * plusieurs appelants légitimes — `start --open`, `run --open` — visent le
 * même agent sans se coordonner entre eux).
 *
 * Exige un agent RÉELLEMENT enregistré (défense en profondeur, SECURITY.md) :
 * les deux appelants actuels (`announceAgent`, `routeAgentMessage`) le
 * garantissent déjà côté appelant, mais un process hôte détaché qui peut
 * spawn sur un nom arbitraire (charset valide, mais pas forcément un agent
 * réel) serait une primitive de spawn de process trop permissive à exposer
 * sans ce garde — jamais rien qui dépende du seul discernement de l'appelant
 * pour une primitive de ce niveau.
 */
export async function ensurePtyHost(
  root: string,
  agent: string,
  options: EnsurePtyHostOptions,
): Promise<{ pid: number; started: boolean }> {
  validateAgentName(agent);
  const registry = await readRegistry(root);
  if (!registry[agent]) {
    throw new StriartError(`Agent inconnu : "${agent}" n'est pas dans le registre.`, {
      code: 'PTY_HOST_UNKNOWN_AGENT',
      details: { agent },
    });
  }
  const status = await ptyHostStatus(root, agent);
  if (status.running && status.pid) return { pid: status.pid, started: false };
  if (status.stale) await rm(pidFilePath(root, agent), { force: true });

  const logPath = logFilePath(root, agent);
  await mkdir(path.dirname(logPath), { recursive: true });
  const logFd = openSync(logPath, 'a');

  const cliPath = fileURLToPath(new URL('./cli.js', import.meta.url));
  const args = [
    cliPath,
    'pty-host-run',
    agent,
    // Explicite, jamais dérivé de cwd : cwd est le clone de l'agent (un
    // repo git à part entière) — `findRepoRoot()` y résoudrait la racine du
    // CLONE, pas celle du repo principal où vit `.striart/pty/<agent>/`.
    '--root',
    root,
    '--shell',
    options.shell,
    '--cwd',
    options.cwd,
    ...(options.args ?? []).flatMap((a) => ['--shell-arg', a]),
    ...(options.initialCommand ? ['--initial', options.initialCommand] : []),
  ];
  const child = spawn(process.execPath, args, {
    cwd: options.cwd,
    detached: true,
    stdio: ['ignore', logFd, logFd],
    env: process.env,
  });
  child.unref();

  if (!child.pid) {
    throw new StriartError(`Échec du démarrage de l'hôte de pty pour "${agent}".`, {
      code: 'PTY_HOST_SPAWN_FAILED',
      details: { agent },
    });
  }

  await mkdir(path.dirname(pidFilePath(root, agent)), { recursive: true });
  await writeFile(
    pidFilePath(root, agent),
    `${JSON.stringify({ pid: child.pid, startedAt: new Date().toISOString() })}\n`,
    'utf8',
  );
  return { pid: child.pid, started: true };
}

/**
 * Arrête l'hôte (SIGTERM — le process attrape le signal pour arrêter le pty
 * proprement, cf. `pty-host-run`) et nettoie le PID file. Idempotent : sans
 * hôte vivant, nettoie un éventuel PID file orphelin et le signale.
 * Best-effort côté appelant (`stopAgentImpl`) : un hôte introuvable ou déjà
 * mort n'est jamais une raison de faire échouer `striart stop`.
 */
export async function stopPtyHost(
  root: string,
  agent: string,
): Promise<{ stopped: boolean; wasStale: boolean }> {
  const status = await ptyHostStatus(root, agent);
  if (!status.running || !status.pid) {
    if (status.stale) await rm(pidFilePath(root, agent), { force: true });
    return { stopped: false, wasStale: status.stale };
  }
  try {
    process.kill(status.pid, 'SIGTERM');
  } catch {
    // Déjà mort entre le status et le kill (course bénigne) : rien à faire de plus.
  }
  await rm(pidFilePath(root, agent), { force: true });
  return { stopped: true, wasStale: false };
}

import { closeSync, openSync } from 'node:fs';
import os from 'node:os';
import {
  access,
  constants as fsConstants,
  mkdir,
  open as openFile,
  rm,
  stat,
} from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { StriartError } from './errors.js';
import { DEFAULT_CONFIG, loadConfig } from './config.js';
import { attendedCommandOf } from './agents/catalog.ts';
import { striartDir } from './paths.js';
import { hostStartError, launchPtyHost, waitForPtyHostReady } from './pty-attach.ts';
import type { PtyHostSettings } from './pty-attach.ts';
import { PTY_HOST_EXIT_ALREADY_RUNNING } from './native.ts';
import { ptyHostPidFilePath, ptyHostStatus, ptyHostStopFilePath } from './pty-host-state.ts';
import { clearStopRequest, requestStop } from './stop-request.ts';
import { readRegistry, validateAgentName } from './clone.js';
import type { AgentMeta } from './types.js';

/**
 * Cycle de vie du process hôte détaché d'un pty (roadmap : `watch`
 * interactif, Phase C ; hôte natif `striart-native pty-host` depuis le lot
 * R2). Distinct de `pty-attach.ts` : ce module ne possède aucun pty
 * lui-même, il démarre/surveille/arrête le PROCESS qui en possède un — même
 * patron que `daemon.js` (spawn détaché, PID file, détection d'orphelin),
 * mais un hôte PAR AGENT plutôt qu'un daemon unique : `--open` doit pouvoir
 * survivre indépendamment de la fenêtre qui l'a demandé, donc le pty ne peut
 * pas vivre dans le process CLI éphémère (`striart start`/`run`) qui sort
 * dès l'onglet ouvert.
 *
 * Le PID file est écrit par l'hôte LUI-MÊME, atomiquement, une fois son
 * canal ouvert et son programme lancé : `ensurePtyHost` résout quand l'hôte
 * est joignable, plus seulement lancé. Un second hôte pour le même agent
 * est refusé par l'hôte (verrou exclusif, sortie 3) : deux `--open`
 * concurrents convergent sur le même.
 */

/** Shell hébergé par défaut quand `--open` ne précise pas d'outil dédié. */
export function defaultShell(): string {
  if (process.platform === 'win32') return 'powershell.exe';
  return process.env.SHELL || 'bash';
}

/** Extensions exécutables Windows quand PATHEXT est absent. */
const WINDOWS_DEFAULT_PATHEXT = '.COM;.EXE;.BAT;.CMD';

function pathExtensions(env: NodeJS.ProcessEnv): string[] {
  return (env.PATHEXT || WINDOWS_DEFAULT_PATHEXT)
    .split(';')
    .map((ext) => ext.trim().toLowerCase())
    .filter(Boolean);
}

function ptyShellInvalid(
  reason: 'NOT_FOUND' | 'NOT_EXECUTABLE' | 'RELATIVE_PATH',
  message: string,
) {
  return new StriartError(message, {
    code: 'PTY_SHELL_INVALID',
    hint: 'striart doctor',
    // Identifiant de raison seulement : jamais la valeur configurée.
    details: { reason },
  });
}

/** Fichier ordinaire exécutable : bit x (POSIX) ou extension de PATHEXT (Windows). */
async function isExecutableFile(file: string, platform: NodeJS.Platform, env: NodeJS.ProcessEnv) {
  const info = await stat(file).catch(() => null);
  if (!info?.isFile()) return false;
  if (platform === 'win32') return pathExtensions(env).includes(path.extname(file).toLowerCase());
  return access(file, fsConstants.X_OK).then(
    () => true,
    () => false,
  );
}

/**
 * Résout `pty.shell` (hors 'auto') en CHEMIN ABSOLU d'un exécutable. Un nom nu
 * est cherché dans les entrées ABSOLUES du PATH seulement — jamais le dossier
 * courant ni une entrée relative ou vide (sous Windows, CreateProcess
 * chercherait d'abord le dossier courant : un dépôt hostile y déposerait un
 * `pwsh.exe`). Un chemin doit être absolu. Le résultat est passé en argv au
 * lanceur natif, jamais à un shell.
 */
export async function resolveShellProgram(
  spec: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): Promise<string> {
  const flavour = platform === 'win32' ? path.win32 : path.posix;
  const hasSeparator = platform === 'win32' ? /[\\/]/.test(spec) : spec.includes('/');
  if (hasSeparator) {
    if (!flavour.isAbsolute(spec)) {
      throw ptyShellInvalid(
        'RELATIVE_PATH',
        'pty.shell is a relative path. Use a bare name (looked up in PATH) or an absolute path.',
      );
    }
    if (await isExecutableFile(spec, platform, env)) return flavour.normalize(spec);
    const exists = await stat(spec).catch(() => null);
    throw exists
      ? ptyShellInvalid(
          'NOT_EXECUTABLE',
          'pty.shell is not an executable file. Fix pty.shell in striart.config, or set it to "auto".',
        )
      : ptyShellInvalid(
          'NOT_FOUND',
          'pty.shell does not exist. Fix pty.shell in striart.config, or set it to "auto".',
        );
  }
  const pathKey = Object.keys(env).find((k) => k.toLowerCase() === 'path') ?? 'PATH';
  const dirs = (env[pathKey] ?? '')
    .split(platform === 'win32' ? ';' : ':')
    .map((d) => (platform === 'win32' ? d.replace(/^"(.*)"$/, '$1') : d))
    .filter((d) => d.length > 0 && flavour.isAbsolute(d));
  const extensions = platform === 'win32' ? ['', ...pathExtensions(env)] : [''];
  const hasExtension = platform === 'win32' && flavour.extname(spec) !== '';
  for (const dir of dirs) {
    for (const ext of hasExtension ? [''] : extensions) {
      const candidate = flavour.join(dir, spec + ext);
      if (await isExecutableFile(candidate, platform, env)) return candidate;
    }
  }
  throw ptyShellInvalid(
    'NOT_FOUND',
    'pty.shell was not found in PATH (only absolute PATH entries are searched, never the current directory). Install it, give an absolute path, or set pty.shell to "auto".',
  );
}

export interface ResolvedPtyShell {
  /** Programme à lancer : chemin absolu pour un shell configuré, `defaultShell()` pour 'auto'. */
  shell: string;
  args: string[];
  /** `config` : `pty.shell` explicite ; `auto` : comportement par défaut de la plateforme. */
  source: 'auto' | 'config';
}

/**
 * Shell hébergé par l'hôte de pty d'un dépôt : `pty.shell` / `pty.shellArgs`
 * (config complétée clé par clé des défauts). Ne s'applique qu'en l'absence
 * de shell explicite de l'appelant (agentProfile/commande > config > auto).
 * Un `pty.shell` inutilisable est un refus nommé, jamais un repli sur 'auto'.
 */
export async function resolvePtyShell(
  root: string,
  options: { env?: NodeJS.ProcessEnv; config?: { pty?: Record<string, unknown> } } = {},
): Promise<ResolvedPtyShell> {
  const config = options.config ?? (await loadConfig(root));
  const merged = { ...DEFAULT_CONFIG.pty, ...(config.pty ?? {}) };
  const args = [...(merged.shellArgs ?? [])];
  if (merged.shell === 'auto') return { shell: defaultShell(), args, source: 'auto' };
  return { shell: await resolveShellProgram(merged.shell, options.env), args, source: 'config' };
}

/**
 * Windows PowerShell 5.1 (`powershell`) lancé SANS `-NoProfile` : il charge
 * les profils de l'utilisateur à chaque démarrage (lent, et en échec sous une
 * politique d'exécution restrictive). PowerShell 7 (`pwsh`) n'est pas visé.
 */
export function windowsPowerShellProfileRisk(
  shell: string,
  args: readonly string[],
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (platform !== 'win32') return false;
  const base = path.win32
    .basename(shell)
    .toLowerCase()
    .replace(/\.exe$/, '');
  if (base !== 'powershell') return false;
  return !args.some((a) => /^-no?p(rofile)?$/i.test(a));
}

/**
 * Fichiers de profil que Windows PowerShell 5.1 chargerait au démarrage
 * (tous hôtes, utilisateur courant ; Documents peut être redirigé vers
 * OneDrive) qui EXISTENT : sans eux, le démarrage avec profil est sans coût.
 */
export async function windowsPowerShellProfiles(
  env: NodeJS.ProcessEnv = process.env,
  home: string = os.homedir(),
): Promise<string[]> {
  const documents = [path.win32.join(home, 'Documents')];
  if (env.OneDrive) documents.push(path.win32.join(env.OneDrive, 'Documents'));
  const candidates = documents.flatMap((dir) =>
    ['profile.ps1', 'Microsoft.PowerShell_profile.ps1'].map((name) =>
      path.win32.join(dir, 'WindowsPowerShell', name),
    ),
  );
  if (env.SystemRoot) {
    candidates.push(
      path.win32.join(env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'profile.ps1'),
    );
  }
  const found: string[] = [];
  for (const file of candidates) {
    if ((await stat(file).catch(() => null))?.isFile()) found.push(file);
  }
  return found;
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
  // Config lue seulement si l'agent n'a pas son propre outil.
  if (agentMeta.command) return agentMeta.command;
  return attendedCommandOf(null, (await loadConfig(root)).agentCommand);
}

function logFilePath(root: string, agent: string): string {
  return path.join(striartDir(root), 'logs', `pty-${agent}.log`);
}

export { ptyHostStatus } from './pty-host-state.ts';
export type { PtyHostStatus } from './pty-host-state.ts';

export interface EnsurePtyHostOptions extends PtyHostSettings {
  /**
   * Shell explicite de l'appelant (prime sur la config). Absent : `pty.shell`
   * du dépôt (`resolvePtyShell`), 'auto' par défaut. Dans les deux cas `args`
   * explicite prime sur `pty.shellArgs`.
   */
  shell?: string;
  args?: string[];
  cwd: string;
  /** Écrite dans le pty juste après démarrage (ex : l'outil de coding de l'agent). */
  initialCommand?: string | null;
  cols?: number;
  rows?: number;
}

/**
 * Réglages de l'hôte : config `pty` du dépôt complétée par clé des défauts
 * (une config qui ne fixe que `replayBytes` garde les autres défauts), puis
 * les options explicites de l'appelant.
 */
export async function resolvePtyHostSettings(
  root: string,
  overrides: PtyHostSettings = {},
): Promise<Required<PtyHostSettings>> {
  const config = await loadConfig(root);
  const merged = { ...DEFAULT_CONFIG.pty, ...(config.pty ?? {}) };
  return {
    replayBytes: overrides.replayBytes ?? merged.replayBytes,
    clientQueueBytes: overrides.clientQueueBytes ?? merged.clientQueueBytes,
    killGraceMs: overrides.killGraceMs ?? merged.killGraceMs,
  };
}

/** Dernière part du journal de l'hôte lue pour nommer un échec de démarrage. */
const LOG_TAIL_BYTES = 8 * 1024;

async function readLogTail(file: string): Promise<string> {
  try {
    const handle = await openFile(file, 'r');
    try {
      const { size } = await handle.stat();
      const length = Math.min(size, LOG_TAIL_BYTES);
      const buffer = Buffer.alloc(length);
      await handle.read(buffer, 0, length, size - length);
      return buffer.toString('utf8');
    } finally {
      await handle.close();
    }
  } catch {
    // Journal absent ou illisible : l'erreur reste nommée, sans code natif.
    return '';
  }
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
      hint: 'striart status',
      details: { agent },
    });
  }
  // Sans cache : réutiliser un hôte dont le numéro aurait été recyclé
  // laisserait l'onglet s'attacher à un pty inexistant.
  const status = await ptyHostStatus(root, agent, { fresh: true });
  if (status.running && status.pid) return { pid: status.pid, started: false };
  if (status.stale) await rm(ptyHostPidFilePath(root, agent), { force: true });
  await rm(ptyHostStopFilePath(root, agent), { force: true });

  const settings = await resolvePtyHostSettings(root, options);
  // Résolu AVANT d'ouvrir le journal : un pty.shell invalide échoue net.
  const resolvedShell =
    options.shell === undefined
      ? await resolvePtyShell(root)
      : { shell: options.shell, args: [] as string[] };
  const logPath = logFilePath(root, agent);
  await mkdir(path.dirname(logPath), { recursive: true });
  const logFd = openSync(logPath, 'a');
  let child: Awaited<ReturnType<typeof launchPtyHost>>;
  try {
    child = await launchPtyHost(root, agent, {
      shell: resolvedShell.shell,
      args: options.args ?? resolvedShell.args,
      cwd: options.cwd,
      cols: options.cols,
      rows: options.rows,
      initialCommand: options.initialCommand ?? null,
      ...settings,
      detached: true,
      stdio: ['ignore', logFd, logFd],
    });
  } finally {
    // L'enfant a dupliqué le descripteur : le nôtre se ferme (il fuyait à
    // chaque --open avec l'hôte Node).
    closeSync(logFd);
  }
  const readiness = await waitForPtyHostReady(root, agent, child);
  child.unref();
  if (readiness.state === 'ready') return { pid: child.pid as number, started: true };
  if (readiness.state === 'timeout') child.kill();
  if (readiness.state === 'exited' && readiness.exitCode === PTY_HOST_EXIT_ALREADY_RUNNING) {
    // Course entre deux --open : l'autre hôte a pris le verrou de l'agent mais
    // peut ne pas avoir publié son PID file / son identité : attente bornée
    // (jamais une lecture unique, qui échouait sous charge).
    const winner = await awaitRunningHost(root, agent);
    if (winner) return { pid: winner, started: false };
  }
  throw hostStartError(agent, readiness, await readLogTail(logPath), logPath);
}

/** Attente bornée du PID de l'hôte gagnant d'une course de démarrage. */
const WINNER_WAIT_MS = 15_000;
const WINNER_POLL_MS = 100;
async function awaitRunningHost(root: string, agent: string): Promise<number | null> {
  const deadline = Date.now() + WINNER_WAIT_MS;
  for (;;) {
    const status = await ptyHostStatus(root, agent, { fresh: true });
    if (status.running && status.pid) return status.pid;
    if (Date.now() >= deadline) return null;
    await new Promise((resolve) => setTimeout(resolve, WINNER_POLL_MS));
  }
}

/** Attente de l'accusé puis de la sortie de l'hôte (il arrête son pty en quelques ms). */
const HOST_STOP_ACK_WAIT_MS = 3_000;
const HOST_STOP_WAIT_MS = 5_000;

export interface PtyHostStopResult {
  stopped: boolean;
  wasStale: boolean;
  /** Arrêt demandé, hôte pas encore sorti : son PID file reste en place. */
  stopping: boolean;
  /** Hôte vivant mais non identifiable, ou non signalable (autre utilisateur) : intouché. */
  untouched: 'unverified' | 'denied' | null;
}

/**
 * Arrête l'hôte proprement (demande d'arrêt `host.stop`, accusée par
 * l'hôte natif comme par l'hôte Node d'une version antérieure ; repli sur
 * SIGTERM sans accusé — sous Windows un TerminateProcess, et le Job Object
 * de l'hôte natif emporte alors le shell) et attend sa sortie avant de retirer son PID
 * file : tant qu'il vit, son shell travaille dans le clone et la garde
 * SESSION_LIVE de `cleanClones` doit tenir. Idempotent : sans hôte vivant,
 * nettoie un éventuel PID file orphelin et le signale.
 *
 * Jamais un kill à l'aveugle : identité relue sans cache, un hôte non
 * identifiable ou non signalable est laissé en place (`untouched`) — le
 * résultat le dit, l'appelant (`stopAgent`) le remonte.
 */
export async function stopPtyHost(root: string, agent: string): Promise<PtyHostStopResult> {
  const result = (partial: Partial<PtyHostStopResult>): PtyHostStopResult => ({
    stopped: false,
    wasStale: false,
    stopping: false,
    untouched: null,
    ...partial,
  });
  const status = await ptyHostStatus(root, agent, { fresh: true });
  if (!status.running || !status.pid) {
    if (status.stale) await releaseHostFiles(root, agent);
    return result({ wasStale: status.stale });
  }
  if (!status.verified) return result({ untouched: 'unverified' });
  const pid = status.pid;
  let outcome: 'exited' | 'stopping';
  try {
    outcome = await requestStop({
      file: ptyHostStopFilePath(root, agent),
      pid,
      ackWaitMs: HOST_STOP_ACK_WAIT_MS,
      waitMs: HOST_STOP_WAIT_MS,
      fallback: () => process.kill(pid, 'SIGTERM'),
      confirmIdentity: async () => {
        const fresh = await ptyHostStatus(root, agent, { fresh: true });
        return fresh.verified && fresh.pid === pid;
      },
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EPERM') return result({ untouched: 'denied' });
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
    // Sorti entre l'état et le signal (course bénigne) : PID file orphelin.
    await releaseHostFiles(root, agent);
    return result({ wasStale: true });
  }
  if (outcome === 'stopping') return result({ stopping: true });
  await releaseHostFiles(root, agent);
  return result({ stopped: true });
}

async function releaseHostFiles(root: string, agent: string): Promise<void> {
  await rm(ptyHostPidFilePath(root, agent), { force: true });
  await clearStopRequest(ptyHostStopFilePath(root, agent));
}

/** Issue de l'ouverture d'un onglet `--open` (null : `--open` non demandé). */
export type AttendedTerminal =
  { launched: true; hostPid: number } | { launched: false; error: string; hostPid: number | null };

export interface AttendedSession {
  /** Outil de coding à lancer dans le clone (claude, aider…). */
  agentCommand: string;
  terminal: AttendedTerminal | null;
}

/**
 * Prépare la session supervisée d'un agent fraîchement démarré : résout son
 * outil et, avec `open`, démarre l'hôte de pty puis ouvre un onglet natif
 * qui s'y attache (`striart attach`). Ne lève jamais pour un échec
 * d'ouverture : l'agent est créé, le clone est utilisable à la main —
 * l'échec est un résultat (`terminal.launched: false`), affiché en
 * avertissement par l'appelant.
 *
 * Capacité réservée à la CLI : ouvrir un terminal local au nom du dashboard
 * ou d'un agent MCP franchirait une frontière de confiance (SECURITY.md).
 *
 * L'onglet lance `node <cli.js> attach <agent>` par chemins ABSOLUS : après
 * une installation locale (non globale), `striart` n'est pas dans le PATH.
 */
export async function openAttendedSession(
  root: string,
  info: AgentMeta & { name: string },
  { open = false }: { open?: boolean } = {},
): Promise<AttendedSession> {
  const agentCommand = await resolveAttendedCommand(root, info);
  if (!open) return { agentCommand, terminal: null };
  // Réglages du lanceur lus ICI, dans le dépôt de l'agent, et passés
  // explicitement à openAgentTerminal (avec root et agent) plutôt que
  // déduits du chemin du clone. Une config illisible est un échec
  // d'ouverture (lancer à la main), jamais un lanceur par défaut.
  let terminalSettings: unknown;
  try {
    terminalSettings = (await loadConfig(root)).terminal;
  } catch (error) {
    return {
      agentCommand,
      terminal: { launched: false, error: (error as Error).message, hostPid: null },
    };
  }

  let hostPid: number | null = null;
  try {
    ({ pid: hostPid } = await ensurePtyHost(root, info.name, {
      cwd: info.path,
      initialCommand: agentCommand,
    }));
  } catch (error) {
    return {
      agentCommand,
      terminal: { launched: false, error: (error as Error).message, hostPid: null },
    };
  }
  const { openAgentTerminal } = await import('./terminal.js');
  const cliPath = fileURLToPath(new URL('./cli.js', import.meta.url));
  const result = await openAgentTerminal({
    cwd: info.path,
    title: `STRIART: ${info.name}`,
    argv: [process.execPath, cliPath, 'attach', info.name],
    terminal: terminalSettings,
    root,
    agent: info.name,
  });
  return {
    agentCommand,
    terminal:
      'error' in result
        ? { launched: false, error: result.error, hostPid }
        : { launched: true, hostPid },
  };
}

import { StriartError } from '../errors.js';
import type { CustomLauncher, TerminalLauncher } from './config.ts';
import {
  assertNoDoubleQuoteForWindowsPowerShell,
  escapeForWt,
  posixCommandLine,
  powerShellCommandLine,
  quoteAppleScript,
  quotePosix,
} from './quote.ts';

/**
 * Commandes d'ouverture de chaque lanceur (fonctions pures). Chaque
 * élément d'argv est transmis selon la grammaire de SA cible :
 *  - lanceurs qui acceptent un programme + arguments (`-e`, `--`, …) : argv
 *    passé en paramètres positionnels de `<holdShell> -c '"$@"; exec <holdShell>'`
 *    — rien n'est réinterprété, et un shell interactif garde l'onglet ouvert
 *    pour lire une éventuelle erreur ;
 *  - lanceurs qui ne prennent qu'une ligne de shell (Terminal.app, iTerm2) :
 *    citation POSIX puis échappement AppleScript ;
 *  - Windows : ligne PowerShell (`&` + guillemets simples), `;` échappé pour
 *    Windows Terminal.
 */

export type ConcreteLauncher = Exclude<TerminalLauncher, 'auto' | 'warp'> | 'powershell';

export interface LauncherParams {
  platform: NodeJS.Platform;
  cwd: string;
  title: string;
  agent: string | null;
  argv: readonly string[];
  holdShell: string;
  custom: CustomLauncher | null;
}

export interface SpawnPlan {
  file: string;
  args: string[];
  spawnCwd: string | null;
}

/** OS sur lesquels chaque lanceur existe ; ailleurs, refus explicite. */
const SUPPORTED: Record<ConcreteLauncher, readonly NodeJS.Platform[] | 'all'> = {
  wt: ['win32'],
  powershell: ['win32'],
  'terminal-app': ['darwin'],
  iterm: ['darwin'],
  'gnome-terminal': ['linux', 'freebsd', 'openbsd', 'netbsd', 'sunos', 'aix'],
  konsole: ['linux', 'freebsd', 'openbsd', 'netbsd', 'sunos', 'aix'],
  kitty: ['darwin', 'linux', 'freebsd', 'openbsd', 'netbsd'],
  wezterm: 'all',
  alacritty: 'all',
  custom: 'all',
};

export function assertLauncherSupported(
  launcher: ConcreteLauncher | 'warp',
  platform: NodeJS.Platform,
): void {
  if (launcher === 'warp') return; // Warp : macOS, Windows, Linux (dossiers par OS dans warp.ts)
  const supported = SUPPORTED[launcher];
  if (supported === 'all' || supported.includes(platform)) return;
  throw new StriartError(
    `Lanceur de terminal « ${launcher} » indisponible sur cette plateforme (${platform}).`,
    {
      code: 'TERMINAL_LAUNCHER_UNSUPPORTED',
      details: { launcher, platform },
      hint: 'striart doctor',
    },
  );
}

/** argv « tenu ouvert » : `<sh> -c '"$@"; exec <sh>' striart <argv…>`. */
function heldArgv(holdShell: string, argv: readonly string[]): string[] {
  return [holdShell, '-c', `"$@"; exec ${holdShell}`, 'striart', ...argv];
}

/** Lancement natif Windows (PowerShell) : ligne `& '…' '…'`. */
function windowsPowerShellArgs(argv: readonly string[]): string[] {
  assertNoDoubleQuoteForWindowsPowerShell(argv);
  return ['powershell', '-NoLogo', '-NoExit', '-Command', powerShellCommandLine(argv)];
}

export function buildLauncherCommand(
  launcher: ConcreteLauncher,
  params: LauncherParams,
): SpawnPlan {
  const { platform, cwd, title, argv, holdShell } = params;
  assertLauncherSupported(launcher, platform);
  switch (launcher) {
    case 'wt': {
      assertNoDoubleQuoteForWindowsPowerShell(argv);
      return {
        file: 'wt',
        args: [
          '-w',
          '0',
          'new-tab',
          '-d',
          escapeForWt(cwd),
          '--title',
          escapeForWt(title),
          'powershell',
          '-NoLogo',
          '-NoExit',
          '-Command',
          escapeForWt(powerShellCommandLine(argv)),
        ],
        spawnCwd: null,
      };
    }
    case 'powershell': {
      // Console Windows : PowerShell lancé détaché obtient sa propre fenêtre ;
      // le répertoire passe par `cwd` de spawn (aucune interpolation).
      const [file, ...args] = windowsPowerShellArgs(argv);
      return { file, args, spawnCwd: cwd };
    }
    case 'terminal-app': {
      const shell = `cd ${quotePosix(cwd)} && ${posixCommandLine(argv)}`;
      return {
        file: 'osascript',
        args: [
          '-e',
          'tell application "Terminal" to activate',
          '-e',
          `tell application "Terminal" to do script ${quoteAppleScript(shell)}`,
        ],
        spawnCwd: null,
      };
    }
    case 'iterm': {
      // `write text` tape la ligne dans le shell de connexion du profil par
      // défaut (zsh, bash ou fish : la citation POSIX vaut pour les trois).
      const shell = `cd ${quotePosix(cwd)} && ${posixCommandLine(argv)}`;
      return {
        file: 'osascript',
        args: [
          '-e',
          'tell application "iTerm"',
          '-e',
          'activate',
          '-e',
          'set striartWindow to (create window with default profile)',
          '-e',
          `tell current session of striartWindow to write text ${quoteAppleScript(shell)}`,
          '-e',
          'end tell',
        ],
        spawnCwd: null,
      };
    }
    case 'gnome-terminal':
      return {
        file: 'gnome-terminal',
        args: [`--working-directory=${cwd}`, '--', ...heldArgv(holdShell, argv)],
        spawnCwd: null,
      };
    case 'konsole':
      return {
        file: 'konsole',
        // -e consomme tous les arguments suivants comme programme + arguments.
        args: ['--new-tab', '--workdir', cwd, '-e', ...heldArgv(holdShell, argv)],
        spawnCwd: null,
      };
    case 'kitty':
      return {
        file: 'kitty',
        args: ['--directory', cwd, '--title', title, ...heldArgv(holdShell, argv)],
        spawnCwd: null,
      };
    case 'wezterm':
      return {
        file: 'wezterm',
        args: [
          'start',
          '--cwd',
          cwd,
          '--',
          ...(platform === 'win32' ? windowsPowerShellArgs(argv) : heldArgv(holdShell, argv)),
        ],
        spawnCwd: null,
      };
    case 'alacritty':
      return {
        file: 'alacritty',
        args: [
          '--working-directory',
          cwd,
          '--title',
          title,
          '-e',
          ...(platform === 'win32' ? windowsPowerShellArgs(argv) : heldArgv(holdShell, argv)),
        ],
        spawnCwd: null,
      };
    case 'custom':
      return buildCustomCommand(params);
    default: {
      const never: never = launcher;
      throw new Error(`Lanceur inconnu : ${String(never)}`);
    }
  }
}

/**
 * Lanceur personnalisé : `custom.command` + `custom.args` (validés au
 * chargement de la config), placeholders substitués en UN passage — une
 * valeur substituée n'est jamais relue comme un placeholder. Lancé en argv,
 * `shell: false` : aucune ligne n'est interprétée par Striart.
 */
export function buildCustomCommand(params: LauncherParams): SpawnPlan {
  const { custom, cwd, title, agent, argv, platform } = params;
  if (!custom) {
    throw new StriartError('Lanceur « custom » sans commande (terminal.custom).', {
      code: 'CONFIG_INVALID',
      details: { reason: 'INVALID_VALUE', key: 'terminal' },
      hint: 'striart doctor',
    });
  }
  const values: Record<string, () => string> = {
    '{{cwd}}': () => cwd,
    '{{title}}': () => title,
    '{{agent}}': () => agent ?? '',
    '{{posixCommand}}': () => posixCommandLine(argv),
    '{{powershellCommand}}': () => {
      if (platform === 'win32') assertNoDoubleQuoteForWindowsPowerShell(argv);
      return powerShellCommandLine(argv);
    },
  };
  const args: string[] = [];
  for (const arg of custom.args) {
    if (arg === '{{argv}}') {
      args.push(...argv);
      continue;
    }
    args.push(arg.replace(/\{\{[A-Za-z]+\}\}/g, (token) => values[token]?.() ?? token));
  }
  return { file: custom.command, args, spawnCwd: cwd };
}

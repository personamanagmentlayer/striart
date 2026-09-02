import { spawn } from 'node:child_process';
import { StriartError } from './errors.js';
import { logger } from './logger.js';

/**
 * Construit la commande d'ouverture d'un onglet/fenêtre terminal dans `cwd`
 * qui lance `command`. Fonction pure (testable) : le spawn est fait à part.
 */
/**
 * L'ouverture d'onglet interpole `cwd` (et `command`) dans des lignes de
 * shell (PowerShell/AppleScript/bash) qui les entourent de guillemets
 * simples. Une apostrophe ou un saut de ligne dans le chemin — un projet
 * sous « C:\Users\O'Brien » — briserait le quoting. `cwd` vient du registre
 * (jamais d'une URL), mais un chemin de projet reste hors du contrôle de
 * Striart : on refuse au lieu d'émettre une ligne de shell malformée. Le
 * lanceur est best-effort (repli « lance à la main »), donc refuser ici est
 * sûr par construction.
 */
function isShellSafe(value) {
  return typeof value === 'string' && !/['"\r\n`$]/.test(value);
}

export function buildTerminalCommand({
  platform = process.platform,
  env = process.env,
  cwd,
  title,
  command,
}) {
  if (!isShellSafe(cwd) || !isShellSafe(command)) {
    throw new StriartError(
      "Ouverture de terminal refusée : le chemin ou la commande contient un caractère (apostrophe, guillemet, retour ligne) qui casserait la ligne de shell. Lance l'outil manuellement dans le clone.",
      { code: 'TERMINAL_UNSAFE', details: { cwd } },
    );
  }
  if (platform === 'win32') {
    if (env.WT_SESSION) {
      // Windows Terminal : nouvel onglet dans la fenêtre courante, avec titre.
      return {
        file: 'wt',
        args: [
          '-w',
          '0',
          'new-tab',
          '-d',
          cwd,
          '--title',
          title,
          'powershell',
          '-NoExit',
          '-Command',
          command,
        ],
      };
    }
    // Fallback : nouvelle fenêtre PowerShell.
    return {
      file: 'cmd',
      args: ['/c', 'start', 'powershell', '-NoExit', '-Command', `cd '${cwd}'; ${command}`],
    };
  }

  if (platform === 'darwin') {
    return {
      file: 'osascript',
      args: [
        '-e',
        'tell application "Terminal" to activate',
        '-e',
        `tell application "Terminal" to do script "cd '${cwd}' && ${command}"`,
      ],
    };
  }

  // Linux : gnome-terminal est le plus répandu ; l'échec est géré par l'appelant.
  return {
    file: 'gnome-terminal',
    args: ['--', 'bash', '-c', `cd '${cwd}' && ${command}; exec bash`],
  };
}

/**
 * Ouvre un onglet/fenêtre terminal détaché dans le clone de l'agent et y
 * lance sa commande. Best-effort : retourne { launched, error? } — en cas
 * d'échec, l'appelant affiche la commande à lancer manuellement.
 * `spawnFn` est injectable pour les tests (ouvrir un vrai terminal dans une
 * suite de tests n'est pas une option) — même valeur par défaut au runtime.
 */
export function openAgentTerminal({ cwd, title, command, spawnFn = spawn }) {
  return new Promise((resolve) => {
    try {
      // Dans le try : un chemin non sûr (TERMINAL_UNSAFE) devient un repli
      // « lance à la main », pas une erreur qui remonte au CLI.
      const { file, args } = buildTerminalCommand({ cwd, title, command });
      const child = spawnFn(file, args, { detached: true, stdio: 'ignore' });
      child.on('error', (error) => {
        logger.warn({ err: error.message, file }, "Impossible d'ouvrir le terminal");
        resolve({ launched: false, error: error.message });
      });
      child.on('spawn', () => {
        child.unref();
        resolve({ launched: true });
      });
    } catch (error) {
      resolve({ launched: false, error: error.message });
    }
  });
}

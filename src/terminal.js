import { spawn } from 'node:child_process';
import os from 'node:os';
import { StriartError } from './errors.js';
import { logger } from './logger.js';
import { inferCloneContext } from './terminal/clone-context.ts';
import { resolveTerminalSettings } from './terminal/config.ts';
import { buildLauncherCommand } from './terminal/launchers.ts';
import { assertRepresentable } from './terminal/quote.ts';
import {
  buildWarpLaunch,
  isWarpSession,
  removeWarpTabConfig,
  writeWarpTabConfig,
} from './terminal/warp.ts';

export { quoteForShell, quotePosix, quotePowerShell } from './terminal/quote.ts';

/**
 * Ouverture d'un onglet/fenêtre de terminal dans le clone d'un agent, qui y
 * exécute un programme donné en ARGV (exécutable + arguments) — jamais une
 * ligne de commande libre.
 *
 * Le lanceur est configurable (`terminal.launcher`, voir
 * src/terminal/config.ts) : `auto` garde le comportement historique —
 * Windows Terminal si la session courante en est un (WT_SESSION), sinon une
 * console PowerShell ; Terminal.app sous macOS ; gnome-terminal ailleurs —
 * augmenté d'une seule détection, désactivable : une session Warp
 * (TERM_PROGRAM=WarpTerminal, `terminal.detectWarp`) ouvre un onglet Warp.
 *
 * Chaque cible a sa propre grammaire ; chaque élément d'argv y est cité
 * selon CELLE-CI (src/terminal/quote.ts, src/terminal/launchers.ts,
 * src/terminal/warp.ts). Seuls les caractères qu'aucune grammaire ne sait
 * représenter sur une ligne (NUL, CR, LF) sont refusés (TERMINAL_UNSAFE) :
 * le lanceur est best-effort et l'appelant affiche alors la commande à
 * lancer à la main.
 */

/**
 * Lanceur effectif : explicite, ou déduit en `auto` de la session courante.
 * @param {import('./terminal/config.ts').TerminalSettings} settings
 * @param {NodeJS.Platform} platform
 * @param {NodeJS.ProcessEnv} env
 * @returns {import('./terminal/launchers.ts').ConcreteLauncher | 'warp'}
 */
export function resolveLauncher(settings, platform, env) {
  if (settings.launcher !== 'auto') return settings.launcher;
  if (settings.detectWarp && isWarpSession(env)) return 'warp';
  if (platform === 'win32') return env.WT_SESSION ? 'wt' : 'powershell';
  if (platform === 'darwin') return 'terminal-app';
  return 'gnome-terminal';
}

/**
 * Commande d'ouverture (fonction pure, testable) : programme à lancer, ses
 * arguments, le répertoire de travail à donner à `spawn` le cas échéant et,
 * pour Warp, la Tab Config à écrire AVANT de lancer l'ouverture.
 * @param {{
 *   platform?: NodeJS.Platform,
 *   env?: NodeJS.ProcessEnv,
 *   home?: string,
 *   cwd: string,
 *   title: string,
 *   argv: string[],
 *   terminal?: unknown,
 *   root?: string | null,
 *   agent?: string | null,
 * }} params
 * @returns {{file: string, args: string[], spawnCwd: string | null, launcher: string, tabConfig?: import('./terminal/warp.ts').WarpTabConfigFile}}
 */
export function buildTerminalCommand({
  platform = process.platform,
  env = process.env,
  home = os.homedir(),
  cwd,
  title,
  argv,
  terminal = undefined,
  root = null,
  agent = null,
}) {
  if (!Array.isArray(argv) || argv.length === 0) {
    throw new StriartError('Ouverture de terminal : programme à lancer manquant.', {
      code: 'TERMINAL_UNSAFE',
      details: {},
    });
  }
  assertRepresentable([cwd, title, ...argv]);
  const settings = resolveTerminalSettings(terminal);
  const launcher = resolveLauncher(settings, platform, env);
  const context = root && agent ? { root, agent } : inferCloneContext(cwd, { platform });

  if (launcher === 'warp') {
    if (!context) {
      throw new StriartError(
        'Ouverture Warp impossible : le répertoire n’est pas le clone d’un agent Striart (racine et agent introuvables).',
        { code: 'TERMINAL_CONTEXT_MISSING', details: {} },
      );
    }
    const plan = buildWarpLaunch({
      platform,
      env,
      home,
      root: context.root,
      agent: context.agent,
      cwd,
      title,
      argv,
      settings: settings.warp,
    });
    return {
      file: plan.file,
      args: plan.args,
      spawnCwd: null,
      launcher,
      tabConfig: plan.tabConfig,
    };
  }

  const plan = buildLauncherCommand(launcher, {
    platform,
    cwd,
    title,
    agent: context?.agent ?? null,
    argv,
    holdShell: settings.holdShell,
    custom: settings.custom,
  });
  return { ...plan, launcher };
}

/**
 * Réglages `terminal` de la config du dépôt qui possède le clone. Le clone
 * vient du registre (`<racine>/.striart/agents/<agent>`) : la racine s'en
 * déduit. Hors d'un clone (aucun appelant actuel), les défauts s'appliquent
 * — signalé au journal, jamais en silence.
 * @param {string} cwd
 * @param {(root: string) => Promise<{terminal?: unknown}>} loadConfigFn
 */
async function settingsForClone(cwd, loadConfigFn) {
  const context = inferCloneContext(cwd);
  if (!context) {
    logger.warn(
      { cwd },
      'Ouverture de terminal hors d’un clone d’agent : réglages terminal par défaut',
    );
    return { terminal: undefined, context: null };
  }
  const config = await loadConfigFn(context.root);
  return { terminal: config.terminal, context };
}

/**
 * Ouvre un onglet/fenêtre de terminal détaché dans le clone de l'agent et y
 * lance `argv`. Best-effort : retourne { launched, error? } — en cas
 * d'échec, l'appelant affiche la commande à lancer manuellement.
 *
 * `terminal` (réglages) est facultatif : absent, il est lu dans la config du
 * dépôt propriétaire du clone. Une config illisible est un ÉCHEC
 * d'ouverture (repli « lance à la main »), jamais un lanceur par défaut
 * choisi à la place de celui que l'utilisateur a configuré.
 *
 * `spawnFn` et `loadConfigFn` sont injectables pour les tests (ouvrir un vrai
 * terminal dans une suite de tests n'est pas une option).
 * @param {{
 *   cwd: string,
 *   title: string,
 *   argv: string[],
 *   terminal?: unknown,
 *   root?: string | null,
 *   agent?: string | null,
 *   platform?: NodeJS.Platform,
 *   env?: NodeJS.ProcessEnv,
 *   home?: string,
 *   spawnFn?: typeof spawn,
 *   loadConfigFn?: (root: string) => Promise<{terminal?: unknown}>,
 * }} params
 * @returns {Promise<{launched: true} | {launched: false, error: string}>}
 */
export async function openAgentTerminal({
  cwd,
  title,
  argv,
  terminal = undefined,
  root = null,
  agent = null,
  platform = process.platform,
  env = process.env,
  home = os.homedir(),
  spawnFn = spawn,
  loadConfigFn = defaultLoadConfig,
}) {
  let plan;
  try {
    // Dans le try : un argument non représentable (TERMINAL_UNSAFE), un
    // lanceur indisponible ou une config illisible deviennent un repli
    // « lance à la main », pas une erreur qui remonte au CLI.
    let settings = terminal;
    if (settings === undefined)
      ({ terminal: settings } = await settingsForClone(cwd, loadConfigFn));
    plan = buildTerminalCommand({
      platform,
      env,
      home,
      cwd,
      title,
      argv,
      terminal: settings,
      root,
      agent,
    });
    if (plan.tabConfig) await writeWarpTabConfig(plan.tabConfig);
  } catch (error) {
    logger.warn({ err: error.message, code: error.code }, "Impossible d'ouvrir le terminal");
    return { launched: false, error: error.message };
  }
  return new Promise((resolve) => {
    try {
      const child = spawnFn(plan.file, plan.args, {
        detached: true,
        stdio: 'ignore',
        ...(plan.spawnCwd ? { cwd: plan.spawnCwd } : {}),
      });
      child.on('error', (error) => {
        logger.warn({ err: error.message, file: plan.file }, "Impossible d'ouvrir le terminal");
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

/** @param {string} root */
async function defaultLoadConfig(root) {
  const { loadConfig } = await import('./config.js');
  return loadConfig(root);
}

/**
 * Nettoyage des artefacts de terminal d'un agent (aujourd'hui : ses Tab
 * Configs Warp). À appeler quand l'agent quitte le registre (`striart
 * stop`) et quand son clone est supprimé (`striart clean`). Idempotent ;
 * rend les chemins supprimés.
 * @param {{root: string, agent: string, terminal?: unknown, platform?: NodeJS.Platform, env?: NodeJS.ProcessEnv, home?: string}} params
 * @returns {Promise<string[]>}
 */
export async function removeAgentTerminalArtifacts({
  root,
  agent,
  terminal = undefined,
  platform = process.platform,
  env = process.env,
  home = os.homedir(),
}) {
  const settings = resolveTerminalSettings(terminal);
  return removeWarpTabConfig({ root, agent, settings: settings.warp, platform, env, home });
}

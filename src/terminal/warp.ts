import { createHash } from 'node:crypto';
import { lstat, mkdir, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { StriartError } from '../errors.ts';
import { AGENT_NAME_RE } from '../agent-name.ts';
import type { WarpSettings, WarpShell } from './config.ts';
import { writePrivateFileAtomic } from './private-file.ts';
import {
  assertNoDoubleQuoteForWindowsPowerShell,
  assertRepresentable,
  posixCommandLine,
  powerShellCommandLine,
  fishCommandLine,
  quotePowerShell,
} from './quote.ts';

/**
 * Lanceur Warp (https://docs.warp.dev).
 *
 * Le schéma d'URI de Warp (`warp://action/new_tab?path=…`) n'exécute AUCUNE
 * commande (documenté). Seule une Tab Config — fichier TOML dans le dossier
 * de données de Warp — porte des commandes de démarrage ; elle s'ouvre par
 * `warp://tab_config/<nom>` (nom = radical du fichier, comparé sans casse).
 *
 * Donc : on écrit `striart-<agent>-<empreinte>.toml` (0600) dont l'unique
 * volet a pour `directory` le clone, un `shell` explicite et pour `commands`
 * l'argv d'attache cité pour CE shell (quoteForShell) PUIS échappé en chaîne
 * TOML ; on l'ouvre par l'URI via `open` (macOS), `xdg-open` (Linux) ou
 * `Start-Process` (Windows), toujours en argv.
 *
 * Le nom du fichier dérive du SEUL nom d'agent validé, plus une empreinte de
 * (racine, agent) : deux dépôts ouverts en même temps avec un `agent-a`
 * chacun n'écrasent ni ne nettoient le fichier de l'autre, et Warp compare
 * les noms sans casse (`Agent-A` et `agent-a` d'un même dépôt Linux restent
 * distincts grâce à l'empreinte, calculée sur le nom exact).
 *
 * Le fichier vit tant que l'agent vit : `removeWarpTabConfig` le retire
 * (branché sur `striart stop` / `striart clean`).
 */

/** Valeur de TERM_PROGRAM posée par Warp dans ses sessions. */
export const WARP_TERM_PROGRAM = 'WarpTerminal';

export type WarpChannel = 'stable' | 'preview';

export function isWarpSession(env: NodeJS.ProcessEnv): boolean {
  return env.TERM_PROGRAM === WARP_TERM_PROGRAM;
}

/**
 * Canal de Warp visé : réglage explicite, sinon celui de la session courante
 * (TERM_PROGRAM_VERSION de Warp Preview contient « preview »), sinon stable.
 */
export function resolveWarpChannel(
  setting: WarpSettings['channel'],
  env: NodeJS.ProcessEnv,
): WarpChannel {
  if (setting === 'stable' || setting === 'preview') return setting;
  if (isWarpSession(env) && /preview/i.test(env.TERM_PROGRAM_VERSION ?? '')) return 'preview';
  return 'stable';
}

export function warpUriScheme(channel: WarpChannel): string {
  return channel === 'preview' ? 'warppreview' : 'warp';
}

/** Shell du volet : réglage explicite, sinon celui que Warp propose par défaut sur l'OS. */
export function resolveWarpShell(setting: WarpShell | null, platform: NodeJS.Platform): WarpShell {
  if (setting) return setting;
  if (platform === 'win32') return 'pwsh';
  if (platform === 'darwin') return 'zsh';
  return 'bash';
}

interface DirParams {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  home: string;
  channel: WarpChannel;
}

/**
 * Dossier de données de Warp (doit exister : Warp installé) et son
 * sous-dossier `tab_configs` (créé au besoin), emplacements documentés :
 *  - macOS   : ~/.warp/tab_configs/                         (Preview : ~/.warp-preview/)
 *  - Windows : %APPDATA%\warp\Warp\data\tab_configs\       (Preview : WarpPreview)
 *  - Linux   : ${XDG_DATA_HOME:-~/.local/share}/warp-terminal/tab_configs/ (Preview : warp-terminal-preview)
 */
export function warpDirectories({ platform, env, home, channel }: DirParams): {
  appDir: string;
  tabConfigDir: string;
} {
  const preview = channel === 'preview';
  if (platform === 'darwin') {
    const appDir = path.posix.join(home, preview ? '.warp-preview' : '.warp');
    return { appDir, tabConfigDir: path.posix.join(appDir, 'tab_configs') };
  }
  if (platform === 'win32') {
    const appData = env.APPDATA;
    if (!appData || !path.win32.isAbsolute(appData)) {
      throw new StriartError(
        'Ouverture Warp impossible : %APPDATA% est absent, le dossier des Tab Configs est introuvable.',
        { code: 'WARP_NOT_FOUND', details: {}, hint: 'striart doctor' },
      );
    }
    const appDir = path.win32.join(appData, 'warp', preview ? 'WarpPreview' : 'Warp');
    return { appDir, tabConfigDir: path.win32.join(appDir, 'data', 'tab_configs') };
  }
  // XDG : une valeur relative est invalide par la spécification, ignorée.
  const xdg =
    env.XDG_DATA_HOME && path.posix.isAbsolute(env.XDG_DATA_HOME) ? env.XDG_DATA_HOME : null;
  const dataHome = xdg ?? path.posix.join(home, '.local', 'share');
  const appDir = path.posix.join(dataHome, preview ? 'warp-terminal-preview' : 'warp-terminal');
  return { appDir, tabConfigDir: path.posix.join(appDir, 'tab_configs') };
}

/** Radical du fichier (et nom de l'URI) : `striart-<agent en minuscules>-<8 hex>`. */
export function warpTabConfigName(root: string, agent: string): string {
  if (!AGENT_NAME_RE.test(agent)) {
    throw new StriartError('Tab Config Warp : nom d’agent invalide.', {
      code: 'INVALID_AGENT_NAME',
      details: {},
    });
  }
  const digest = createHash('sha256').update(`${root}\0${agent}`).digest('hex').slice(0, 8);
  return `striart-${agent.toLowerCase()}-${digest}`;
}

/**
 * Chaîne TOML « basic » : `\` et `"` échappés, tout caractère de contrôle en
 * `\uXXXX` (TOML interdit les contrôles bruts dans une chaîne). L'Unicode
 * passe tel quel (le fichier est en UTF-8).
 */
export function tomlString(value: string): string {
  let out = '"';
  for (const ch of value) {
    const code = ch.codePointAt(0)!;
    if (ch === '\\') out += '\\\\';
    else if (ch === '"') out += '\\"';
    else if (ch === '\t') out += '\\t';
    else if (code < 0x20 || code === 0x7f) out += `\\u${code.toString(16).padStart(4, '0')}`;
    else out += ch;
  }
  return `${out}"`;
}

/** Ligne de commande tapée dans le volet, citée pour son shell. */
export function warpPaneCommand(
  argv: readonly string[],
  shell: WarpShell,
  platform: NodeJS.Platform,
): string {
  if (shell === 'pwsh') {
    if (platform === 'win32') assertNoDoubleQuoteForWindowsPowerShell(argv);
    return powerShellCommandLine(argv);
  }
  if (shell === 'fish') return fishCommandLine(argv);
  return posixCommandLine(argv);
}

export interface WarpLaunchParams {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  home: string;
  root: string;
  agent: string;
  cwd: string;
  title: string;
  argv: readonly string[];
  settings: WarpSettings;
}

export interface WarpTabConfigFile {
  name: string;
  /** Dossier de données de Warp, dont l'existence prouve l'installation. */
  appDir: string;
  dir: string;
  path: string;
  content: string;
}

export interface WarpLaunchPlan {
  tabConfig: WarpTabConfigFile;
  uri: string;
  file: string;
  args: string[];
}

/**
 * Plan complet (fonction pure) : contenu de la Tab Config, son chemin, l'URI
 * et la commande d'ouverture en argv.
 */
export function buildWarpLaunch(params: WarpLaunchParams): WarpLaunchPlan {
  const { platform, env, home, root, agent, cwd, title, argv, settings } = params;
  assertRepresentable([cwd, title, root, ...argv]);
  // Warp substitue `{{param}}` dans les champs d'une Tab Config : une
  // accolade double dans un chemin ou un argument serait réinterprétée.
  for (const value of [cwd, title, ...argv]) {
    if (value.includes('{{') || value.includes('}}')) {
      throw new StriartError(
        'Ouverture Warp refusée : un chemin ou un argument contient « {{ » ou « }} », que Warp interpréterait comme un paramètre de Tab Config.',
        { code: 'TERMINAL_UNSAFE', details: {} },
      );
    }
  }
  const channel = resolveWarpChannel(settings.channel, env);
  const shell = resolveWarpShell(settings.shell, platform);
  const name = warpTabConfigName(root, agent);
  const dirs = warpDirectories({ platform, env, home, channel });
  const dir = settings.tabConfigDir ?? dirs.tabConfigDir;
  const appDir = settings.tabConfigDir ? path.dirname(settings.tabConfigDir) : dirs.appDir;
  const filePath = (platform === 'win32' ? path.win32 : path.posix).join(dir, `${name}.toml`);
  const command = warpPaneCommand(argv, shell, platform);
  const content = [
    `# Généré par Striart pour l'agent ${agent} — retiré par « striart stop » / « striart clean ».`,
    '# Aucun secret ici : chemins et commande d’attache seulement.',
    `name = ${tomlString(title)}`,
    `title = ${tomlString(title)}`,
    '',
    '[[panes]]',
    'id = "striart"',
    'type = "terminal"',
    `directory = ${tomlString(cwd)}`,
    `shell = ${tomlString(shell)}`,
    `commands = [${tomlString(command)}]`,
    'is_focused = true',
    '',
  ].join('\n');
  const uri = `${warpUriScheme(channel)}://tab_config/${name}${settings.newWindow ? '?new_window=true' : ''}`;
  return {
    tabConfig: { name, appDir, dir, path: filePath, content },
    uri,
    ...uriOpener(uri, platform),
  };
}

/** Ouverture d'une URI par le gestionnaire de l'OS, en argv (jamais une ligne de shell libre). */
export function uriOpener(
  uri: string,
  platform: NodeJS.Platform,
): { file: string; args: string[] } {
  if (platform === 'darwin') return { file: 'open', args: [uri] };
  if (platform === 'win32') {
    return {
      file: 'powershell',
      args: [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `Start-Process -FilePath ${quotePowerShell(uri)}`,
      ],
    };
  }
  return { file: 'xdg-open', args: [uri] };
}

/**
 * Écrit la Tab Config : Warp installé (dossier de données présent), dossier
 * `tab_configs` créé au besoin (0700), cible qui n'est pas autre chose
 * qu'un fichier ordinaire (lien symbolique refusé), écriture atomique d'un
 * temporaire créé exclusivement (`wx`, 0600) puis renommé.
 */
export async function writeWarpTabConfig(file: WarpTabConfigFile): Promise<void> {
  const app = await stat(file.appDir).catch(() => null);
  if (!app?.isDirectory()) {
    throw new StriartError(
      'Ouverture Warp impossible : le dossier de données de Warp est introuvable (Warp est-il installé pour cet utilisateur ?).',
      { code: 'WARP_NOT_FOUND', details: { path: file.appDir }, hint: 'striart doctor' },
    );
  }
  await mkdir(file.dir, { recursive: true, mode: 0o700 });
  await writePrivateFileAtomic(file.path, file.content, { mode: 0o600, code: 'TERMINAL_UNSAFE' });
}

/**
 * Retire les Tab Configs d'un agent (les deux canaux, et le dossier
 * personnalisé s'il est réglé). Idempotent. Rend les chemins réellement
 * supprimés. Une erreur autre que « absent » remonte : un fichier qui
 * survit doit se voir.
 */
export async function removeWarpTabConfig({
  root,
  agent,
  settings,
  platform = process.platform,
  env = process.env,
  home = os.homedir(),
}: {
  root: string;
  agent: string;
  settings: WarpSettings;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  home?: string;
}): Promise<string[]> {
  const name = warpTabConfigName(root, agent);
  const p = platform === 'win32' ? path.win32 : path.posix;
  const dirs = new Set<string>();
  if (settings.tabConfigDir) dirs.add(settings.tabConfigDir);
  for (const channel of ['stable', 'preview'] as const) {
    try {
      dirs.add(warpDirectories({ platform, env, home, channel }).tabConfigDir);
    } catch (error) {
      // %APPDATA% absent : aucun dossier documenté où Warp aurait pu lire un fichier.
      if (!(error instanceof StriartError && error.code === 'WARP_NOT_FOUND')) throw error;
    }
  }
  const removed: string[] = [];
  for (const dir of dirs) {
    const target = p.join(dir, `${name}.toml`);
    const info = await lstat(target).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (!info) continue;
    await rm(target, { force: true });
    removed.push(target);
  }
  return removed;
}

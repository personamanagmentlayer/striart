/**
 * Configuration du lanceur de terminal (`terminal` dans striart.config) :
 * valeurs par défaut, validation stricte, résolution des valeurs partielles.
 *
 * Module sans dépendance (importé par config.js au chargement de la config).
 *
 * Forme :
 *
 *   terminal: {
 *     launcher: 'auto',         // ou un lanceur explicite (TERMINAL_LAUNCHERS)
 *     detectWarp: true,         // en 'auto' : TERM_PROGRAM=WarpTerminal → Warp
 *     holdShell: 'bash',        // shell POSIX qui garde l'onglet ouvert (Linux, kitty…)
 *     warp: {
 *       channel: 'auto',        // 'stable' | 'preview' | 'auto' (TERM_PROGRAM_VERSION)
 *       shell: null,            // shell du volet : 'pwsh' | 'bash' | 'zsh' | 'fish' (null : défaut de l'OS)
 *       newWindow: false,       // warp://tab_config/<nom>?new_window=true
 *       tabConfigDir: null,     // dossier tab_configs de Warp (null : emplacement documenté par OS)
 *     },
 *     custom: null,             // { command, args } — argv, JAMAIS un shell
 *   }
 *
 * Placeholders de `custom.args` (substitués dans l'élément, en un seul
 * passage — une valeur substituée n'est jamais réinterprétée) :
 *  - `{{argv}}` : ÉLÉMENT ENTIER uniquement, remplacé par l'argv à lancer
 *    (plusieurs éléments) ;
 *  - `{{posixCommand}}` / `{{powershellCommand}}` : la même commande, citée
 *    pour un shell POSIX / PowerShell, à passer à un `-c`/`-Command` ;
 *  - `{{cwd}}`, `{{title}}`, `{{agent}}` : répertoire du clone, titre, agent.
 * Au moins un des trois premiers est obligatoire : sans lui, l'onglet
 * s'ouvrirait sans jamais s'attacher à l'agent — un faux succès.
 */

export const TERMINAL_LAUNCHERS = Object.freeze([
  'auto',
  'wt',
  'warp',
  'terminal-app',
  'iterm',
  'gnome-terminal',
  'konsole',
  'kitty',
  'wezterm',
  'alacritty',
  'custom',
] as const);

export type TerminalLauncher = (typeof TERMINAL_LAUNCHERS)[number];

export const WARP_SHELLS = Object.freeze(['pwsh', 'bash', 'zsh', 'fish'] as const);
export type WarpShell = (typeof WARP_SHELLS)[number];

export const WARP_CHANNELS = Object.freeze(['auto', 'stable', 'preview'] as const);
export type WarpChannelSetting = (typeof WARP_CHANNELS)[number];

export const CUSTOM_PLACEHOLDERS = Object.freeze([
  '{{argv}}',
  '{{posixCommand}}',
  '{{powershellCommand}}',
  '{{cwd}}',
  '{{title}}',
  '{{agent}}',
] as const);

/** Placeholders qui transportent la commande d'attache (au moins un requis). */
const COMMAND_PLACEHOLDERS = ['{{argv}}', '{{posixCommand}}', '{{powershellCommand}}'];

export interface WarpSettings {
  channel: WarpChannelSetting;
  shell: WarpShell | null;
  newWindow: boolean;
  tabConfigDir: string | null;
}

export interface CustomLauncher {
  command: string;
  args: string[];
}

export interface TerminalSettings {
  launcher: TerminalLauncher;
  detectWarp: boolean;
  holdShell: string;
  warp: WarpSettings;
  custom: CustomLauncher | null;
}

export const DEFAULT_WARP_SETTINGS: Readonly<WarpSettings> = Object.freeze({
  channel: 'auto',
  shell: null,
  newWindow: false,
  tabConfigDir: null,
});

export const DEFAULT_TERMINAL_SETTINGS: Readonly<TerminalSettings> = Object.freeze({
  launcher: 'auto',
  detectWarp: true,
  holdShell: 'bash',
  warp: DEFAULT_WARP_SETTINGS,
  custom: null,
});

/** Nom ou chemin de shell sans espace ni caractère interprété (il est écrit dans `-c '…; exec <shell>'`). */
const HOLD_SHELL_RE = /^[A-Za-z0-9._/-]{1,200}$/;

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const onlyKeys = (v: Record<string, unknown>, keys: readonly string[]) =>
  Object.keys(v).every((k) => keys.includes(k));

/** Chemin absolu POSIX ou Windows (lecteur ou UNC), sans saut de ligne ni NUL. */
function isAbsolutePathString(v: unknown): boolean {
  if (typeof v !== 'string' || v.length === 0 || /[\0\r\n]/.test(v)) return false;
  return v.startsWith('/') || /^[A-Za-z]:[\\/]/.test(v) || v.startsWith('\\\\');
}

/** Placeholders `{{…}}` présents dans une chaîne. */
function placeholdersIn(value: string): string[] {
  return value.match(/\{\{[^{}]*\}\}/g) ?? [];
}

export function isValidCustomLauncher(v: unknown): boolean {
  if (!isPlainObject(v) || !onlyKeys(v, ['command', 'args'])) return false;
  if (typeof v.command !== 'string' || v.command.trim() === '' || /[\0\r\n]/.test(v.command)) {
    return false;
  }
  if (placeholdersIn(v.command).length > 0) return false;
  if (!Array.isArray(v.args) || !v.args.every((a) => typeof a === 'string' && !/[\0\r\n]/.test(a)))
    return false;
  const args = v.args as string[];
  for (const arg of args) {
    for (const p of placeholdersIn(arg)) {
      if (!(CUSTOM_PLACEHOLDERS as readonly string[]).includes(p)) return false;
    }
    // {{argv}} se développe en PLUSIEURS éléments : seul dans son élément.
    if (arg.includes('{{argv}}') && arg !== '{{argv}}') return false;
  }
  return args.some((a) => COMMAND_PLACEHOLDERS.some((p) => a.includes(p)));
}

export function isValidWarpSettings(v: unknown): boolean {
  if (!isPlainObject(v) || !onlyKeys(v, ['channel', 'shell', 'newWindow', 'tabConfigDir']))
    return false;
  if (v.channel !== undefined && !(WARP_CHANNELS as readonly unknown[]).includes(v.channel))
    return false;
  if (
    v.shell !== undefined &&
    v.shell !== null &&
    !(WARP_SHELLS as readonly unknown[]).includes(v.shell)
  )
    return false;
  if (v.newWindow !== undefined && typeof v.newWindow !== 'boolean') return false;
  if (
    v.tabConfigDir !== undefined &&
    v.tabConfigDir !== null &&
    !isAbsolutePathString(v.tabConfigDir)
  )
    return false;
  return true;
}

/**
 * Validation de la clé `terminal` (valeur partielle acceptée, complétée par
 * `resolveTerminalSettings`). Clés inconnues refusées : une faute de frappe
 * (`lancher`) serait sinon ignorée en silence et le comportement par défaut
 * s'appliquerait à l'insu de l'utilisateur.
 */
export function isValidTerminalSettings(v: unknown): boolean {
  if (!isPlainObject(v)) return false;
  if (!onlyKeys(v, ['launcher', 'detectWarp', 'holdShell', 'warp', 'custom'])) return false;
  if (v.launcher !== undefined && !(TERMINAL_LAUNCHERS as readonly unknown[]).includes(v.launcher))
    return false;
  if (v.detectWarp !== undefined && typeof v.detectWarp !== 'boolean') return false;
  if (
    v.holdShell !== undefined &&
    (typeof v.holdShell !== 'string' || !HOLD_SHELL_RE.test(v.holdShell))
  )
    return false;
  if (v.warp !== undefined && !isValidWarpSettings(v.warp)) return false;
  if (v.custom !== undefined && v.custom !== null && !isValidCustomLauncher(v.custom)) return false;
  // Un lanceur 'custom' sans commande n'aurait rien à lancer.
  if (v.launcher === 'custom' && !isPlainObject(v.custom)) return false;
  return true;
}

/** Complète une valeur partielle (déjà validée) avec les défauts. */
export function resolveTerminalSettings(value: unknown): TerminalSettings {
  const v = isPlainObject(value) ? value : {};
  const warp = isPlainObject(v.warp) ? v.warp : {};
  return {
    launcher: (v.launcher as TerminalLauncher | undefined) ?? DEFAULT_TERMINAL_SETTINGS.launcher,
    detectWarp: (v.detectWarp as boolean | undefined) ?? DEFAULT_TERMINAL_SETTINGS.detectWarp,
    holdShell: (v.holdShell as string | undefined) ?? DEFAULT_TERMINAL_SETTINGS.holdShell,
    warp: {
      channel: (warp.channel as WarpChannelSetting | undefined) ?? DEFAULT_WARP_SETTINGS.channel,
      shell: (warp.shell as WarpShell | null | undefined) ?? DEFAULT_WARP_SETTINGS.shell,
      newWindow: (warp.newWindow as boolean | undefined) ?? DEFAULT_WARP_SETTINGS.newWindow,
      tabConfigDir:
        (warp.tabConfigDir as string | null | undefined) ?? DEFAULT_WARP_SETTINGS.tabConfigDir,
    },
    custom: isPlainObject(v.custom)
      ? { command: v.custom.command as string, args: [...(v.custom.args as string[])] }
      : null,
  };
}

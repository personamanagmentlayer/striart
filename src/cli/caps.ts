/**
 * Sonde UNIQUE des capacités de sortie (couche L4).
 *
 * Toutes les décisions de présentation dépendent d'ici et de nulle part
 * ailleurs : couleur, glyphes Unicode, largeur, liens cliquables, barre de
 * progression du terminal. Fonction pure sur un environnement injecté :
 * testable sans terminal réel.
 *
 * Principe : le FORMAT ne bascule jamais tout seul (un script qui veut du
 * JSON demande `--json`) ; seuls les ornements dépendent du terminal.
 */

export interface StreamLike {
  isTTY?: boolean;
  columns?: number;
}

export interface CapsInput {
  env: Record<string, string | undefined>;
  platform: NodeJS.Platform;
  stdout: StreamLike;
  stderr: StreamLike;
  stdin: StreamLike;
  /** `--plain` : texte nu, ni couleur ni glyphe ni lien (logs CI, lecteurs d'écran, consoles anciennes). */
  plain: boolean;
  /** `--no-color` → false ; absent → null (décidé par l'environnement). */
  color: boolean | null;
}

export type ThemeName = 'default' | 'colorblind' | 'mono';

export interface Capabilities {
  stdoutIsTTY: boolean;
  stderrIsTTY: boolean;
  stdinIsTTY: boolean;
  /** Couleur sur stdout / stderr (décidées séparément : `striart status | less` garde la couleur de ses erreurs). */
  colorStdout: boolean;
  colorStderr: boolean;
  /** Glyphes Unicode (✓ ✗ → …) ; sinon équivalents ASCII. */
  unicode: boolean;
  /** Largeur disponible pour les tableaux ; null = pas de limite (hors terminal). */
  columns: number | null;
  /** Liens cliquables OSC 8 (chemins des tickets et clones). */
  hyperlinks: boolean;
  /** Barre de progression du terminal OSC 9;4 (Windows Terminal, ConEmu). */
  taskbarProgress: boolean;
  /** Animation (spinner) autorisée : terminal interactif, hors CI, hors mode réduit. */
  animate: boolean;
  plain: boolean;
  ci: boolean;
  theme: ThemeName;
}

function flag(value: string | undefined): boolean {
  return value !== undefined && value !== '' && value !== '0' && value.toLowerCase() !== 'false';
}

/**
 * Couleur pour un flux : `--plain`/`--no-color`/`NO_COLOR` l'interdisent
 * (https://no-color.org : toute valeur non vide), `FORCE_COLOR` la force
 * (`0` l'interdit), `TERM=dumb` l'interdit, sinon elle suit `isTTY`.
 */
function colorFor(stream: StreamLike, input: CapsInput): boolean {
  if (input.plain || input.color === false) return false;
  const { env } = input;
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== '') return false;
  if (env.FORCE_COLOR !== undefined) return env.FORCE_COLOR !== '0' && env.FORCE_COLOR !== 'false';
  if (env.TERM === 'dumb') return false;
  return Boolean(stream.isTTY);
}

/**
 * Unicode : les terminaux modernes (Windows Terminal, VS Code, ConEmu, tout
 * terminal Unix en locale UTF-8) rendent ✓ ✗ → … ; la console Windows
 * historique (conhost, police raster) et `TERM=linux` (console texte) non.
 * `STRIART_ASCII=1` force l'ASCII.
 */
function unicodeFor(input: CapsInput): boolean {
  const { env, platform } = input;
  if (input.plain || flag(env.STRIART_ASCII) || env.TERM === 'dumb') return false;
  if (platform === 'win32') {
    return Boolean(
      env.WT_SESSION ||
      env.TERM_PROGRAM === 'vscode' ||
      env.ConEmuANSI === 'ON' ||
      env.TERMINAL_EMULATOR === 'JetBrains-JediTerm' ||
      (env.TERM && /xterm|alacritty|wezterm|kitty/i.test(env.TERM)),
    );
  }
  if (env.TERM === 'linux') return false;
  const locale = env.LC_ALL || env.LC_CTYPE || env.LANG || '';
  return locale === '' || /utf-?8/i.test(locale);
}

function hyperlinksFor(input: CapsInput, ci: boolean): boolean {
  const { env } = input;
  if (env.FORCE_HYPERLINK !== undefined) return flag(env.FORCE_HYPERLINK);
  if (input.plain || ci || !input.stdout.isTTY || env.TERM === 'dumb') return false;
  const vte = Number.parseInt(env.VTE_VERSION ?? '', 10);
  return Boolean(
    env.WT_SESSION ||
    env.KITTY_WINDOW_ID ||
    env.DOMTERM ||
    ['vscode', 'iTerm.app', 'WezTerm', 'ghostty'].includes(env.TERM_PROGRAM ?? '') ||
    (Number.isInteger(vte) && vte >= 5000),
  );
}

function columnsFor(input: CapsInput): number | null {
  if (input.stdout.isTTY && input.stdout.columns && input.stdout.columns > 0) {
    return input.stdout.columns;
  }
  const fromEnv = Number.parseInt(input.env.COLUMNS ?? '', 10);
  return Number.isInteger(fromEnv) && fromEnv > 0 ? fromEnv : null;
}

function themeFor(env: CapsInput['env']): ThemeName {
  const raw = (env.STRIART_THEME ?? '').toLowerCase();
  if (raw === 'colorblind' || raw === 'daltonien') return 'colorblind';
  if (raw === 'mono' || raw === 'monochrome') return 'mono';
  return 'default';
}

export function detectCapabilities(input: CapsInput): Capabilities {
  const { env } = input;
  const ci = flag(env.CI) || Boolean(env.GITHUB_ACTIONS || env.GITEA_ACTIONS || env.BUILD_NUMBER);
  const stderrIsTTY = Boolean(input.stderr.isTTY);
  return {
    stdoutIsTTY: Boolean(input.stdout.isTTY),
    stderrIsTTY,
    stdinIsTTY: Boolean(input.stdin.isTTY),
    colorStdout: colorFor(input.stdout, input),
    colorStderr: colorFor(input.stderr, input),
    unicode: unicodeFor(input),
    columns: columnsFor(input),
    hyperlinks: hyperlinksFor(input, ci),
    taskbarProgress:
      !input.plain && !ci && stderrIsTTY && Boolean(env.WT_SESSION || env.ConEmuANSI === 'ON'),
    animate:
      !input.plain && !ci && stderrIsTTY && env.TERM !== 'dumb' && !flag(env.STRIART_NO_ANIMATION),
    plain: input.plain || env.TERM === 'dumb',
    ci,
    theme: themeFor(env),
  };
}

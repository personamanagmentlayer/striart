import { parseEnv } from 'node:util';

/**
 * Filtre du `.env` de la racine du dépôt (S-I1 / C-I6).
 *
 * Le `.env` d'un dépôt est une donnée non fiable : un dépôt cloné peut en
 * fournir un. Charger toutes ses variables dans `process.env` (hérité par
 * TOUS les enfants : daemons, sessions, hôte de pty, hooks) permettrait
 * `NODE_OPTIONS=--require ./evil.js`, `LD_PRELOAD`, `STRIART_NATIVE_BIN`,
 * `STRIART_CONFIG_HOME`… = exécution de code. Seule une LISTE BLANCHE est
 * appliquée ; une liste noire de préfixes l'emporte TOUJOURS (même sur une
 * extension demandée par l'utilisateur) ; une variable déjà définie dans le
 * shell n'est jamais écrasée.
 *
 * Module pur : aucun accès disque ni à `process.env` (l'appelant passe
 * l'environnement et lit le fichier).
 */

/** Variables d'API et de webhooks du catalogue `.env.example`, STRIART_* d'affichage. */
export const ENV_ALLOW_EXACT: readonly string[] = Object.freeze([
  'STRIART_LANG',
  'STRIART_THEME',
  'STRIART_ASCII',
  'STRIART_NO_ANIMATION',
  'SLACK_WEBHOOK_URL',
  'DISCORD_WEBHOOK_URL',
  'INTERNAL_WEBHOOK_URL',
  'AZURE_OPENAI_ENDPOINT',
]);

/** Motifs de la liste blanche : `*_API_KEY` couvre le catalogue et les fournisseurs à venir. */
const ALLOW_PATTERNS: readonly RegExp[] = Object.freeze([/^[A-Z][A-Z0-9]*(_[A-Z0-9]+)*_API_KEY$/]);

/**
 * Liste noire : jamais appliquée, même si l'utilisateur l'ajoute à sa liste
 * (la validation de la config utilisateur la refuse aussi).
 */
const DENY_PATTERNS: readonly RegExp[] = Object.freeze([
  /^NODE_/i,
  /^NPM_CONFIG_/i,
  /^LD_/i,
  /^DYLD_/i,
  /^(?:ALL_|HTTPS?_|NO_|FTP_|SOCKS_)?PROXY$/i,
  /_PROXY$/i,
  /^SSL_/i,
  /^(?:REQUESTS|CURL)_CA_BUNDLE$/i,
  /^PATH/i,
  /^HOME$/i,
  /^USERPROFILE$/i,
  /^(?:TMP|TEMP|TMPDIR)$/i,
  /^XDG_/i,
  /^APPDATA$/i,
  /^LOCALAPPDATA$/i,
  /^GIT_/i,
  /^COMSPEC$/i,
  /^SHELL$/i,
  /^STRIART_CONFIG_HOME$/i,
  /^STRIART_NATIVE_BIN$/i,
  /^STRIART_HOOK_BIN_DIR$/i,
  /^STRIART_LOG_/i,
  /^STRIART_SESSION$/i,
  /^STRIART_DAEMON$/i,
  /^STRIART_TOKENS_/i,
]);

const NAME_RE = /^[A-Z][A-Z0-9_]{0,127}$/;
/** Motif d'extension accepté : nom exact, `PREFIXE_*` ou `*_SUFFIXE`. */
const EXTENSION_RE =
  /^(?:[A-Z][A-Z0-9_]{0,127}|[A-Z][A-Z0-9_]{1,126}_\*|\*_[A-Z][A-Z0-9_]{1,126})$/;

export function isDeniedEnvName(name: string): boolean {
  return DENY_PATTERNS.some((re) => re.test(name));
}

/** Un motif d'extension de la liste blanche est-il valide ET non interdit ? */
export function validateEnvAllowPattern(pattern: string): string | null {
  if (!EXTENSION_RE.test(pattern)) return 'doit être un nom MAJUSCULES, `PREFIXE_*` ou `*_SUFFIXE`';
  const probe = pattern.replace('*', 'X');
  if (isDeniedEnvName(probe) || isDeniedEnvName(pattern.replace('*', '')))
    return 'cible une variable dangereuse (liste noire non relâchable)';
  return null;
}

function matchesExtension(name: string, pattern: string): boolean {
  if (pattern.startsWith('*')) return name.endsWith(pattern.slice(1));
  if (pattern.endsWith('*')) return name.startsWith(pattern.slice(0, -1));
  return name === pattern;
}

export interface EnvFilterResult {
  /** Variables à appliquer (clé → valeur). */
  applied: Record<string, string>;
  /** Noms ignorés parce que hors liste blanche ou interdits (jamais les valeurs). */
  ignored: string[];
  /** Noms valides mais déjà définis dans l'environnement : le shell l'emporte. */
  shadowed: string[];
}

export interface EnvFilterOptions {
  /** Environnement courant : une variable déjà définie n'est jamais écrasée. */
  env: Readonly<Record<string, string | undefined>>;
  /** Extension de la liste blanche (config UTILISATEUR validée). */
  extraAllow?: readonly string[];
}

/** Parse le contenu d'un `.env` et ne retient que ce que la liste blanche permet. */
export function filterEnvFile(content: string, options: EnvFilterOptions): EnvFilterResult {
  const parsed = parseEnv(content) as Record<string, string>;
  const extra = options.extraAllow ?? [];
  const applied: Record<string, string> = {};
  const ignored: string[] = [];
  const shadowed: string[] = [];
  for (const [name, value] of Object.entries(parsed)) {
    const allowed =
      NAME_RE.test(name) &&
      !isDeniedEnvName(name) &&
      (ENV_ALLOW_EXACT.includes(name) ||
        ALLOW_PATTERNS.some((re) => re.test(name)) ||
        extra.some((pattern) => matchesExtension(name, pattern)));
    if (!allowed) {
      ignored.push(name);
      continue;
    }
    if (options.env[name] !== undefined) {
      shadowed.push(name);
      continue;
    }
    applied[name] = value;
  }
  return { applied, ignored, shadowed };
}

/** Racine d'un clone d'agent : `<dépôt>/.striart/agents/<nom>`. */
export function isAgentCloneRoot(dir: string): boolean {
  return /[\\/]\.striart[\\/]agents[\\/][^\\/]+[\\/]?$/.test(dir);
}

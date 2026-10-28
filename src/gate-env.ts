/**
 * Environnement du Test Gate.
 *
 * Le Test Gate exécute `testCommand` — c'est-à-dire des tests que l'AGENT a pu
 * écrire ou modifier. Leur donner tout l'environnement de l'orchestrateur
 * (clés d'API des LLM, URL de webhooks, jetons) revient à les offrir à du code
 * non fiable. L'environnement du gate est donc une LISTE BLANCHE minimale :
 * ce qu'il faut pour que `npm test`, `git`, un compilateur ou `pytest`
 * tournent (chemins, répertoires temporaires, locale, proxy et autorités de
 * certification pour `npm install`, `NODE_*`, `npm_config_*`), rien d'autre.
 *
 * Trois niveaux, du plus sûr au plus ouvert :
 *  1. Défaut : la liste blanche intégrée, SANS ce qui ressemble à un secret
 *     (jeton, mot de passe…), ET sans — quoi qu'il arrive — les clés d'API
 *     (`*_API_KEY`), les variables nommées par la config pour porter une clé
 *     (`apiKeyEnv`) ou une URL de webhook (`urlEnv`) ;
 *  2. Variables supplémentaires : le dépôt les DEMANDE (`gateEnv: ['MON_*']`),
 *     la config de l'UTILISATEUR (`gate.envAllow`, hors dépôt) les AUTORISE. Une
 *     demande hors autorisation est écartée et rapportée (`refused`), jamais
 *     acceptée en silence : le dépôt ne peut pas élargir au-delà de ce que
 *     l'utilisateur permet — même philosophie que le filtre `.env`
 *     (`cli/env-file.ts`). Une variable nommée ainsi l'emporte sur le filtre
 *     « ressemble à un secret » (décision explicite de l'utilisateur), mais
 *     JAMAIS sur la liste des variables toujours retirées ;
 *  3. `gateEnv: 'inherit'` : tout l'environnement. Relâchement EXPLICITE,
 *     journalisé et affiché par `striart doctor` (nom `gateEnv`).
 *
 * Module pur : aucun accès disque ni à `process.env` (l'appelant passe l'environnement).
 */

/** Noms exacts de la liste blanche (comparés sans casse sous Windows). */
const DEFAULT_EXACT: readonly string[] = Object.freeze([
  // Résolution des programmes et des dossiers de l'utilisateur.
  'PATH',
  'HOME',
  'USERPROFILE',
  'HOMEDRIVE',
  'HOMEPATH',
  'APPDATA',
  'LOCALAPPDATA',
  'ALLUSERSPROFILE',
  'PROGRAMDATA',
  'PROGRAMFILES',
  'PROGRAMFILES(X86)',
  'PROGRAMW6432',
  'COMMONPROGRAMFILES',
  'COMMONPROGRAMFILES(X86)',
  'COMMONPROGRAMW6432',
  // Windows : sans ceux-là, cmd.exe, les DLL système et .cmd ne se résolvent pas.
  'SYSTEMROOT',
  'SYSTEMDRIVE',
  'WINDIR',
  'COMSPEC',
  'PATHEXT',
  'OS',
  'COMPUTERNAME',
  'USERNAME',
  'USERDOMAIN',
  'NUMBER_OF_PROCESSORS',
  'PROCESSOR_ARCHITECTURE',
  // Répertoires temporaires, identité, terminal, locale.
  'TEMP',
  'TMP',
  'TMPDIR',
  'USER',
  'LOGNAME',
  'SHELL',
  'TERM',
  'COLORTERM',
  'NO_COLOR',
  'FORCE_COLOR',
  'LANG',
  'LANGUAGE',
  'TZ',
  'CI',
  // Réseau du gate (`npm install`) : proxy et autorités de certification.
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'ALL_PROXY',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'REQUESTS_CA_BUNDLE',
  'CURL_CA_BUNDLE',
  // Emplacements des chaînes d'outils (pas des identifiants).
  'PNPM_HOME',
  'VOLTA_HOME',
  'NVM_DIR',
  'NVM_BIN',
  'CARGO_HOME',
  'RUSTUP_HOME',
  'GOPATH',
  'GOROOT',
  'GOCACHE',
  'JAVA_HOME',
  'VIRTUAL_ENV',
]);

/** Préfixes de la liste blanche (comparés sans casse : `npm_config_*` est en minuscules). */
const DEFAULT_PREFIXES: readonly string[] = Object.freeze([
  'LC_',
  'NODE_',
  'NPM_CONFIG_',
  'XDG_',
  'STRIART_',
]);

/** Variables de Striart qui ne doivent jamais atteindre le code testé (garde de profondeur d'orchestration). */
const NEVER_PASSED: readonly string[] = Object.freeze(['STRIART_SESSION']);

/** Noms évoquant un secret : retirés de la liste blanche par défaut. */
const SECRET_LOOKING_RE =
  /(?:API_?KEY|SECRET|TOKEN|PASSW(?:OR)?D|CREDENTIAL|PRIVATE_?KEY|WEBHOOK|AUTH(?:ORI[SZ]ATION)?$|_AUTH$|_AUTHTOKEN$)/i;

/**
 * Toujours retirées, quelle que soit la liste de l'utilisateur : clés d'API
 * (`*_API_KEY`, `*_APIKEY`) et URL de webhook.
 */
const ALWAYS_REMOVED_RE = /(?:API_?KEY$|WEBHOOK)/i;

const NAME_PATTERN_RE =
  /^(?:[A-Za-z][A-Za-z0-9_]{0,127}|[A-Za-z][A-Za-z0-9_]{1,126}_\*|\*_[A-Za-z][A-Za-z0-9_]{1,126})$/;

/** Motif accepté pour `gateEnv` (dépôt) et `gate.envAllow` (utilisateur) : nom, `PREFIXE_*` ou `*_SUFFIXE`. Rend un message d'erreur ou null. */
export function validateGateEnvPattern(pattern: unknown): string | null {
  if (typeof pattern !== 'string') return 'doit être une chaîne';
  if (!NAME_PATTERN_RE.test(pattern)) return 'doit être un nom, `PREFIXE_*` ou `*_SUFFIXE`';
  if (ALWAYS_REMOVED_RE.test(pattern.replace('*', 'X')))
    return 'cible une clé d’API ou un webhook (toujours retirés du gate)';
  return null;
}

function matches(name: string, pattern: string, insensitive: boolean): boolean {
  const n = insensitive ? name.toUpperCase() : name;
  const p = insensitive ? pattern.toUpperCase() : pattern;
  if (p.startsWith('*')) return n.endsWith(p.slice(1));
  if (p.endsWith('*')) return n.startsWith(p.slice(0, -1));
  return n === p;
}

export interface GateEnvInput {
  /** Environnement de l'orchestrateur (jamais lu sur `process.env` ici). */
  baseEnv: Readonly<Record<string, string | undefined>>;
  /** Valeur de la clé `gateEnv` de la config du dépôt. */
  repo?: 'inherit' | readonly string[] | null;
  /** `gate.envAllow` de la config UTILISATEUR : plafond des demandes du dépôt. */
  userAllow?: readonly string[];
  /** Variables nommées par la config pour porter une clé d'API ou une URL de webhook. */
  secretNames?: readonly string[];
  platform?: NodeJS.Platform;
}

export interface GateEnvResult {
  /** Environnement complet à donner au gate (à utiliser avec `extendEnv: false`). */
  env: Record<string, string>;
  /** `gateEnv: 'inherit'` : aucun filtrage (relâchement). */
  inherited: boolean;
  /** Demandes du dépôt non autorisées par la config utilisateur (noms/motifs, jamais de valeurs). */
  refused: string[];
  /** Noms des variables retirées parce qu'elles portent une clé d'API ou un webhook (jamais de valeurs). */
  removedSecrets: string[];
}

export function buildGateEnv(input: GateEnvInput): GateEnvResult {
  const platform = input.platform ?? process.platform;
  const insensitive = platform === 'win32';
  const entries = Object.entries(input.baseEnv).filter(
    (e): e is [string, string] => typeof e[1] === 'string',
  );

  if (input.repo === 'inherit') {
    return {
      env: Object.fromEntries(entries),
      inherited: true,
      refused: [],
      removedSecrets: [],
    };
  }

  const requested = Array.isArray(input.repo) ? [...(input.repo as readonly string[])] : [];
  const userAllow = input.userAllow ?? [];
  const granted: string[] = [];
  const refused: string[] = [];
  // Un motif demandé (`APP_*`) est autorisé s'il est couvert par un motif
  // utilisateur au moins aussi large ; un nom exact (`APP_REGION`) par un motif
  // qui le désigne (voir `covers`).
  const covered = (pattern: string) =>
    userAllow.some((allowed) => covers(allowed, pattern, insensitive));
  for (const pattern of requested) {
    if (validateGateEnvPattern(pattern) === null && covered(pattern)) granted.push(pattern);
    else refused.push(String(pattern));
  }

  const secretSet = new Set(
    (input.secretNames ?? []).map((n) => (insensitive ? n.toUpperCase() : n)),
  );
  const env: Record<string, string> = {};
  const removedSecrets: string[] = [];
  for (const [name, value] of entries) {
    const key = insensitive ? name.toUpperCase() : name;
    if (secretSet.has(key) || ALWAYS_REMOVED_RE.test(name)) {
      removedSecrets.push(name);
      continue;
    }
    // Liste blanche intégrée comparée sans casse partout : `http_proxy` et
    // `npm_config_*` sont en minuscules sous Linux.
    const upper = name.toUpperCase();
    if (NEVER_PASSED.includes(upper)) continue;
    const byDefault =
      (DEFAULT_EXACT.includes(upper) || DEFAULT_PREFIXES.some((p) => upper.startsWith(p))) &&
      !SECRET_LOOKING_RE.test(name);
    const byRequest = granted.some((pattern) => matches(name, pattern, insensitive));
    if (byDefault || byRequest) env[name] = value;
  }
  return { env, inherited: false, refused, removedSecrets: removedSecrets.sort() };
}

/**
 * `allowed` (motif de l'utilisateur) couvre-t-il `requested` (motif du dépôt) ?
 * Nom exact : `allowed` le désigne ; `PRE_*` : `allowed` est identique ou un
 * préfixe plus court ; `*_SUF` : `allowed` identique ou un suffixe plus court.
 */
function covers(allowed: string, requested: string, insensitive: boolean): boolean {
  const a = insensitive ? allowed.toUpperCase() : allowed;
  const r = insensitive ? requested.toUpperCase() : requested;
  if (a === r) return true;
  if (r.endsWith('*')) return a.endsWith('*') && r.startsWith(a.slice(0, -1));
  if (r.startsWith('*')) return a.startsWith('*') && r.endsWith(a.slice(1));
  return matches(requested, allowed, insensitive);
}

/**
 * Noms des variables que la CONFIG désigne comme porteuses d'un secret : clé
 * d'API du LLM et de chaque rôle (`apiKeyEnv`), URL de webhook des canaux de
 * notification (`urlEnv`). Elles sont retirées du gate même si leur nom ne
 * ressemble pas à une clé (`MON_JETON_INTERNE`).
 */
export function collectConfiguredSecretEnvNames(config: {
  llm?: { apiKeyEnv?: unknown } | null;
  llmRoles?: Record<string, { apiKeyEnv?: unknown } | null | undefined> | null;
  notifiers?: ReadonlyArray<{ urlEnv?: unknown }> | null;
}): string[] {
  const names = new Set<string>();
  const add = (value: unknown) => {
    if (typeof value === 'string' && value.length > 0) names.add(value);
  };
  add(config.llm?.apiKeyEnv);
  for (const role of Object.values(config.llmRoles ?? {})) add(role?.apiKeyEnv);
  for (const notifier of config.notifiers ?? []) add(notifier?.urlEnv);
  return [...names].sort();
}

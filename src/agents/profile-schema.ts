import { acpOptionsProblem } from '../acp/protocol.ts';
import { MAX_TIMER_MS } from '../timer-limits.ts';

/**
 * Schéma des profils d'agent et des consignes — validation PURE, sans
 * dépendance : importé par config.js au chargement de toute commande, il ne
 * doit tirer ni git, ni pino, ni execa (budget de démarrage de la CLI).
 */

/** Marqueur substitué par le prompt de la tâche (élément d'argv). */
export const PROMPT_PLACEHOLDER = '{{prompt}}';
/** Emplacement optionnel : le texte des consignes, comme élément d'argv. */
export const INSTRUCTIONS_PLACEHOLDER = '{{striartInstructions}}';
/** Emplacement optionnel : le chemin du fichier de consignes (hors clone). */
export const INSTRUCTIONS_FILE_PLACEHOLDER = '{{striartInstructionsFile}}';
/** Emplacement optionnel : la commande du Test Gate (règles d'autorisation d'un preset). */
export const TEST_COMMAND_PLACEHOLDER = '{{striartTestCommand}}';

/** Placeholders reconnus dans un gabarit de consignes. */
export const INSTRUCTION_PLACEHOLDERS = [
  '{{agent}}',
  '{{mode}}',
  '{{tool}}',
  '{{profile}}',
  '{{branch}}',
  '{{targetBranch}}',
  '{{testCommand}}',
  '{{commitRules}}',
  '{{commitConvention}}',
  '{{mcpRules}}',
  '{{protectedPaths}}',
  '{{extra}}',
] as const;

/** Taille max d'un gabarit ou d'un ajout (un prompt système n'est pas un document). */
export const INSTRUCTIONS_MAX_CHARS = 32 * 1024;

export const WRITE_MODES = ['workspace', 'read-only', 'unrestricted'] as const;
/**
 * Contrat de commit (global `config.commitPolicy`, surchargeable par profil).
 * Source unique : config.js en réexporte la liste (COMMIT_POLICY_VALUES).
 */
export const COMMIT_POLICIES = ['agent', 'agent-then-striart', 'striart', 'human'] as const;

/** Placeholders reconnus dans un gabarit de message de commit Striart. */
export const COMMIT_MESSAGE_PLACEHOLDERS = [
  '{{agent}}',
  '{{profile}}',
  '{{task}}',
  '{{taskId}}',
  '{{branch}}',
] as const;

/** Gabarit de message de commit : borné, sujet non vide, placeholders connus seulement. */
export function isValidCommitMessageTemplate(v: unknown): v is string {
  return (
    typeof v === 'string' &&
    v.trim().length > 0 &&
    v.length <= 4000 &&
    !v.includes('\0') &&
    // Première ligne = sujet : jamais vide.
    v.split('\n')[0].trim().length > 0 &&
    (v.match(/\{\{[^{}]*\}\}/g) ?? []).every((p) =>
      (COMMIT_MESSAGE_PLACEHOLDERS as readonly string[]).includes(p),
    )
  );
}

/**
 * Auteur des commits Striart d'un profil. Le nom ne peut ni ouvrir/fermer
 * l'adresse (`<`, `>`) ni casser la ligne : il finit dans un en-tête de
 * commit, une injection y fabriquerait un autre auteur.
 */
export function isValidCommitAuthor(v: unknown): boolean {
  if (!isObject(v)) return false;
  if (Object.keys(v).some((k) => k !== 'name' && k !== 'email')) return false;
  if (v.name != null && !(nonEmpty(v.name) && v.name.length <= 200 && !/[<>\n\r\0]/.test(v.name)))
    return false;
  if (
    v.email != null &&
    !(typeof v.email === 'string' && v.email.length <= 254 && /^[^\s<>@]+@[^\s<>@]+$/.test(v.email))
  )
    return false;
  return true;
}

export const STRUCTURED_OUTPUTS = [
  'none',
  'claude-stream-json',
  'codex-jsonl',
  'gemini-stream-json',
  'ndjson',
] as const;
export const INSTRUCTION_CHANNELS = [
  'auto',
  'acp-prompt',
  'system-prompt-file',
  'prompt',
  'none',
] as const;

type Obj = Record<string, unknown>;

const isObject = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const nonEmpty = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;
const oneOf = (list: readonly string[], v: unknown) => typeof v === 'string' && list.includes(v);
/** Un drapeau est un drapeau : jamais un argument libre qui deviendrait une valeur positionnelle. */
const isFlag = (v: unknown) => nonEmpty(v) && /^--?[A-Za-z0-9][\w-]*$/.test(v);

/** Taille max d'un fichier de réglages de session (sérialisé). */
export const SETTINGS_FILE_MAX_BYTES = 64 * 1024;

function isValidSettingsFile(v: unknown): boolean {
  if (!isObject(v)) return false;
  if (Object.keys(v).some((k) => !['flag', 'json', 'claudeMdExcludes'].includes(k))) return false;
  if (!isFlag(v.flag) || !isObject(v.json)) return false;
  if (v.claudeMdExcludes != null && typeof v.claudeMdExcludes !== 'boolean') return false;
  try {
    return JSON.stringify(v.json).length <= SETTINGS_FILE_MAX_BYTES;
  } catch {
    // Cycle ou valeur non sérialisable : le fichier ne pourrait pas être écrit.
    return false;
  }
}

/** Gabarit borné, sans placeholder inconnu (une faute de frappe partirait telle quelle au modèle). */
export function isValidInstructionsTemplate(template: unknown): template is string {
  if (!nonEmpty(template) || template.length > INSTRUCTIONS_MAX_CHARS) return false;
  const used = template.match(/\{\{[^{}]*\}\}/g) ?? [];
  return used.every((p) => (INSTRUCTION_PLACEHOLDERS as readonly string[]).includes(p));
}

const isOptionalText = (v: unknown) =>
  v == null || (typeof v === 'string' && v.length <= INSTRUCTIONS_MAX_CHARS);

/** Bloc `instructions` d'un profil, cohérent avec son transport et ses args. */
function isValidInstructionsSpec(spec: unknown, profile: Obj): boolean {
  if (spec == null) return true;
  if (!isObject(spec)) return false;
  if (spec.channel != null && !oneOf(INSTRUCTION_CHANNELS, spec.channel)) return false;
  if (spec.template != null && !isValidInstructionsTemplate(spec.template)) return false;
  if (!isOptionalText(spec.append)) return false;
  // Un drapeau est un drapeau : jamais un argument libre qui deviendrait
  // une valeur positionnelle (et donc une seconde tâche).
  if (spec.flag != null && !isFlag(spec.flag)) return false;
  if (spec.encoding != null && !oneOf(['raw', 'toml-string'], spec.encoding)) return false;
  const args = Array.isArray(profile.args) ? (profile.args as string[]) : [];
  if (spec.channel === 'acp-prompt' && !profile.acp) return false;
  if (profile.acp && (spec.channel === 'system-prompt-file' || spec.channel === 'prompt'))
    return false;
  if (
    spec.channel === 'system-prompt-file' &&
    !spec.flag &&
    !args.some((a) => a.includes(INSTRUCTIONS_FILE_PLACEHOLDER))
  )
    return false;
  return true;
}

/**
 * Options ACP d'un profil : MÊME règle que la session (acpOptionsProblem,
 * src/acp/protocol.ts — source unique), appliquée dès le chargement de la
 * config (fail closed). Rend la raison et le champ fautif, ou null.
 */
export function acpProfileProblem(p: unknown): { reason: string; field: string } | null {
  if (!isObject(p)) return null;
  return acpOptionsProblem(p.acp);
}

/**
 * Profil MATÉRIALISÉ valide (commande + args concrets). Mêmes règles que
 * l'historique (marqueur {{prompt}} obligatoire en argv, interdit en ACP),
 * plus les champs déclaratifs du catalogue.
 */
export function isValidAgentProfile(p: unknown): boolean {
  if (!isObject(p)) return false;
  if (!nonEmpty(p.command)) return false;
  if (!Array.isArray(p.args) || !p.args.every((a) => typeof a === 'string')) return false;
  const args = p.args as string[];
  if (acpOptionsProblem(p.acp) !== null) return false;
  // Le marqueur {{prompt}} suit le transport, un seul canal par profil.
  // Argv : OBLIGATOIRE — sans lui le prompt ne serait jamais transmis et
  // l'agent sortirait en 0 sans rien faire, un faux succès. ACP : INTERDIT —
  // le prompt passe par le protocole.
  const hasPrompt = args.some((a) => a.includes(PROMPT_PLACEHOLDER));
  if (p.acp ? hasPrompt : !hasPrompt) return false;
  // Les emplacements de consignes n'ont pas de sens en ACP (bloc de prompt).
  if (
    p.acp &&
    args.some(
      (a) => a.includes(INSTRUCTIONS_PLACEHOLDER) || a.includes(INSTRUCTIONS_FILE_PLACEHOLDER),
    )
  )
    return false;
  if (
    p.env != null &&
    !(isObject(p.env) && Object.values(p.env).every((x) => typeof x === 'string'))
  )
    return false;
  // `envAllow` (lot O, priorité 5) : null = héritage complet (défaut, inchangé) ;
  // un tableau, même vide, restreint l'environnement hérité à ces noms EXACTS
  // (en plus de `env`, toujours appliqué après — jamais retiré par la liste).
  if (
    p.envAllow != null &&
    !(
      Array.isArray(p.envAllow) &&
      p.envAllow.every((x) => typeof x === 'string' && x.length > 0) &&
      new Set(p.envAllow).size === p.envAllow.length
    )
  )
    return false;
  if (
    p.timeout != null &&
    !(
      Number.isInteger(p.timeout) &&
      (p.timeout as number) >= 1000 &&
      (p.timeout as number) <= MAX_TIMER_MS
    )
  )
    return false;
  if (p.preset != null && !nonEmpty(p.preset)) return false;
  if (p.experimental != null && typeof p.experimental !== 'boolean') return false;
  if (p.writeMode != null && !oneOf(WRITE_MODES, p.writeMode)) return false;
  if (p.commitPolicy != null && !oneOf(COMMIT_POLICIES, p.commitPolicy)) return false;
  if (p.commitAuthor != null && !isValidCommitAuthor(p.commitAuthor)) return false;
  if (p.commitMessage != null && !isValidCommitMessageTemplate(p.commitMessage)) return false;
  if (p.structuredOutput != null && !oneOf(STRUCTURED_OUTPUTS, p.structuredOutput)) return false;
  if (p.settingsFile != null && !isValidSettingsFile(p.settingsFile)) return false;
  // Une sortie structurée suppose un flux sur stdout : sans objet en ACP.
  if (p.acp && p.structuredOutput != null && p.structuredOutput !== 'none') return false;
  return isValidInstructionsSpec(p.instructions, p);
}

/** Réglages `agentInstructions` (fusion par clé avec les défauts : chaque champ est optionnel). */
export function isValidAgentInstructionsConfig(v: unknown): boolean {
  if (!isObject(v)) return false;
  const known = [
    'enabled',
    'template',
    'append',
    'commitConvention',
    'agentsMd',
    'attendedFiles',
    'genericFiles',
    'neutralizeParentInstructions',
  ];
  // Une clé inconnue ici est une faute de frappe sur un réglage de sécurité
  // de fait (consignes) : refus plutôt que réglage ignoré en silence.
  if (Object.keys(v).some((k) => !known.includes(k))) return false;
  if (v.enabled != null && typeof v.enabled !== 'boolean') return false;
  if (v.template != null && !isValidInstructionsTemplate(v.template)) return false;
  if (!isOptionalText(v.append)) return false;
  if (
    v.commitConvention != null &&
    !(nonEmpty(v.commitConvention) && v.commitConvention.length <= 2000)
  )
    return false;
  if (v.agentsMd != null && !oneOf(['override', 'non-file'], v.agentsMd)) return false;
  if (
    v.attendedFiles != null &&
    !(
      isObject(v.attendedFiles) &&
      Object.values(v.attendedFiles).every((list) => isRelativePathList(list))
    )
  )
    return false;
  if (v.genericFiles != null && !isRelativePathList(v.genericFiles)) return false;
  if (v.neutralizeParentInstructions != null && typeof v.neutralizeParentInstructions !== 'boolean')
    return false;
  return true;
}

/** Liste de chemins RELATIFS au clone, sans remontée ni `.git`. */
export function isRelativePathList(list: unknown): list is string[] {
  return (
    Array.isArray(list) &&
    list.every(
      (p) =>
        nonEmpty(p) &&
        !/^([A-Za-z]:)?[\\/]/.test(p) &&
        !p.split(/[\\/]/).some((seg) => seg === '..' || seg === '.git' || seg === ''),
    )
  );
}

/**
 * Variables qui changent ce que le process lancé EXÉCUTE ou CHARGE
 * (interpréteurs, chargeur dynamique, résolution de commandes, proxy/CA,
 * git). Un registre ne les pose jamais, même listées dans `acpRegistry.allowEnv`.
 */
const LOADER_ENV_RE =
  /^(PATH|PATHEXT|COMSPEC|SHELL|IFS|ENV|BASH_ENV|HOME|USERPROFILE|TMPDIR|TEMP|TMP|NODE_.*|NPM_.*|NPX_.*|LD_.*|DYLD_.*|PYTHON.*|UV_.*|PIP_.*|RUBY.*|GEM_.*|PERL.*|JAVA_TOOL_OPTIONS|_JAVA_OPTIONS|JDK_JAVA_OPTIONS|CLASSPATH|GIT_.*|SSL_CERT_.*|CURL_CA_BUNDLE|REQUESTS_CA_BUNDLE|(HTTP|HTTPS|ALL|NO)_PROXY)$/i;
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

/** Nom de variable d'environnement refusé quoi qu'en dise la config. */
export function isForbiddenRegistryEnvName(name: string): boolean {
  return !ENV_NAME_RE.test(name) || LOADER_ENV_RE.test(name);
}

/** Nom que `acpRegistry.allowEnv` a le droit de lister. */
export function isAllowableRegistryEnvName(name: string): boolean {
  return !isForbiddenRegistryEnvName(name);
}

/** Réglages `acpRegistry`. */
export function isValidAcpRegistryConfig(v: unknown): boolean {
  if (!isObject(v)) return false;
  if (Object.keys(v).some((k) => !['url', 'allowBinaryDownload', 'allowEnv'].includes(k)))
    return false;
  if (
    v.allowEnv != null &&
    !(
      Array.isArray(v.allowEnv) &&
      v.allowEnv.every((n) => typeof n === 'string' && isAllowableRegistryEnvName(n))
    )
  )
    return false;
  // https seulement : des métadonnées qui décident d'une commande à lancer
  // ne transitent pas en clair.
  if (v.url != null && !(typeof v.url === 'string' && /^https:\/\/[^\s]+$/.test(v.url)))
    return false;
  if (v.allowBinaryDownload != null && typeof v.allowBinaryDownload !== 'boolean') return false;
  return true;
}

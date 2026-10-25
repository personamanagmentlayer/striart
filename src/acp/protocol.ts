import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { StriartError } from '../errors.js';
import type { AgentProfile } from '../types.js';

/**
 * Vocabulaire du protocole ACP v1 côté client (agentclientprotocol.com,
 * vérifié le 2026-10-24) et fonctions PURES partagées par la connexion
 * (`connection.ts`), le déroulé de session (`session.ts`), l'hôte persistant
 * (`host-run.ts`) et la façade historique `src/acp.ts`. Aucun effet de bord
 * ici hormis la résolution de chemins (`realpath`).
 */

/** Version du protocole parlée par ce client (la v1 stable). */
export const ACP_PROTOCOL_VERSION = 1;

/** Codes d'erreur JSON-RPC utilisés par ACP v1 (schema.md, ErrorCode). */
export const JSONRPC = Object.freeze({
  INVALID_PARAMS: -32602,
  METHOD_NOT_FOUND: -32601,
  INTERNAL_ERROR: -32603,
  /** `auth_required` : l'agent exige une authentification avant la session. */
  AUTH_REQUIRED: -32000,
  RESOURCE_NOT_FOUND: -32002,
});

export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

export interface JsonRpcMessage {
  jsonrpc?: string;
  id?: number | string | null;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: JsonRpcError;
}

export interface PermissionOption {
  optionId: string;
  name?: string;
  kind?: string;
}

/** Méthode d'authentification annoncée par l'agent à `initialize`. */
export interface AuthMethod {
  id: string;
  name?: string;
  description?: string;
  /** Absent = 'agent' (flux piloté par le protocole, via `authenticate`). */
  type?: string;
  args?: string[];
  env?: Record<string, string>;
}

/** Bloc de contenu d'un prompt (sous-ensemble texte utilisé par Striart). */
export interface TextContentBlock {
  type: 'text';
  text: string;
}

/** Serveur MCP transmis à `session/new` (transport stdio, seul obligatoire). */
export interface McpServerSpec {
  name: string;
  command: string;
  args: string[];
  env: Array<{ name: string; value: string }>;
}

/** Options effectives d'un profil ACP, après défauts et validation. */
export interface AcpOptions {
  permissions: 'allow' | 'reject' | 'ask';
  /** Politique 'ask' : délai d'arbitrage humain avant le fail closed. */
  askTimeoutMs: number;
  /** Seule voie vers `authenticate` : une décision explicite de la config. */
  authMethodId: string | null;
  /** Session portée par un hôte détaché, adressable par le bus (Phase E). */
  persistentHost: boolean;
  /** L'hôte accepte les messages humains du bus `@agent`. */
  bus: boolean;
  terminal: { enabled: boolean; timeoutMs: number; outputByteLimit: number; maxTerminals: number };
  /** Taille maximale d'un fichier servi à `fs/read_text_file` (octets). */
  fsReadMaxBytes: number;
  mcp: 'striart' | 'none';
  /** Modes d'elicitation ANNONCÉS — jamais sans humain pour répondre (politique 'ask'). */
  elicitation: { form: boolean; url: boolean };
}

/** Délai d'arbitrage humain par défaut de la politique 'ask'. */
export const DEFAULT_ASK_TIMEOUT_MS = 120_000;

export const DEFAULT_TERMINAL = Object.freeze({
  timeoutMs: 600_000,
  outputByteLimit: 1_000_000,
  maxTerminals: 8,
});

/** Plafond par défaut d'une lecture `fs/read_text_file` (octets). */
export const DEFAULT_FS_READ_MAX_BYTES = 4 * 1024 * 1024;

const ACP_KEYS = new Set([
  'fsReadMaxBytes',
  'permissions',
  'askTimeoutMs',
  'auth',
  'persistentHost',
  'bus',
  'terminal',
  'mcp',
  'elicitation',
]);
const TERMINAL_KEYS = new Set(['timeoutMs', 'outputByteLimit', 'maxTerminals']);
const ELICITATION_KEYS = new Set(['form', 'url']);

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const isIntIn = (v: unknown, min: number, max: number) =>
  Number.isInteger(v) && (v as number) >= min && (v as number) <= max;

/**
 * Valide le champ `acp` d'un profil. Rend la cause et le CHAMP fautif —
 * jamais la valeur (contrat de PROFILE_INVALID : un profil porte des clés
 * d'API dans son env). Exportée pour que `config.js` valide au chargement
 * avec la même règle que la session (une seule source).
 */
export function acpOptionsProblem(acp: unknown): { reason: string; field: string } | null {
  if (acp == null || typeof acp === 'boolean') return null;
  const bad = (field: string) => ({ reason: 'ACP_OPTION_INVALID', field: `acp.${field}` });
  if (!isPlainObject(acp)) return { reason: 'ACP_OPTION_INVALID', field: 'acp' };
  for (const key of Object.keys(acp)) if (!ACP_KEYS.has(key)) return bad(key);
  if (acp.permissions != null && !['allow', 'reject', 'ask'].includes(acp.permissions as string))
    return bad('permissions');
  if (acp.askTimeoutMs != null && !isIntIn(acp.askTimeoutMs, 1_000, 86_400_000))
    return bad('askTimeoutMs');
  if (acp.auth != null) {
    if (
      !isPlainObject(acp.auth) ||
      Object.keys(acp.auth).some((k) => k !== 'methodId') ||
      typeof acp.auth.methodId !== 'string' ||
      !/^[\w.:@/-]{1,128}$/.test(acp.auth.methodId)
    )
      return bad('auth');
  }
  if (acp.persistentHost != null && typeof acp.persistentHost !== 'boolean')
    return bad('persistentHost');
  if (acp.bus != null && typeof acp.bus !== 'boolean') return bad('bus');
  if (acp.fsReadMaxBytes != null && !isIntIn(acp.fsReadMaxBytes, 1_024, 268_435_456))
    return bad('fsReadMaxBytes');
  if (acp.mcp != null && !['striart', 'none'].includes(acp.mcp as string)) return bad('mcp');
  if (acp.terminal != null && typeof acp.terminal !== 'boolean') {
    if (!isPlainObject(acp.terminal)) return bad('terminal');
    for (const key of Object.keys(acp.terminal))
      if (!TERMINAL_KEYS.has(key)) return bad(`terminal.${key}`);
    const t = acp.terminal;
    if (t.timeoutMs != null && !isIntIn(t.timeoutMs, 1_000, 86_400_000))
      return bad('terminal.timeoutMs');
    if (t.outputByteLimit != null && !isIntIn(t.outputByteLimit, 1_024, 64_000_000))
      return bad('terminal.outputByteLimit');
    if (t.maxTerminals != null && !isIntIn(t.maxTerminals, 1, 64))
      return bad('terminal.maxTerminals');
  }
  if (acp.elicitation != null) {
    if (!isPlainObject(acp.elicitation)) return bad('elicitation');
    for (const key of Object.keys(acp.elicitation))
      if (!ELICITATION_KEYS.has(key)) return bad(`elicitation.${key}`);
    const e = acp.elicitation;
    if (e.form != null && typeof e.form !== 'boolean') return bad('elicitation.form');
    if (e.url != null && typeof e.url !== 'boolean') return bad('elicitation.url');
    // Demander explicitement l'elicitation sans humain pour répondre est une
    // contradiction : refus plutôt qu'une capacité annoncée puis morte.
    if ((e.form === true || e.url === true) && acp.permissions !== 'ask')
      return { reason: 'ACP_ELICITATION_NEEDS_ASK', field: 'acp.elicitation' };
  }
  return null;
}

/**
 * Normalise le champ `acp` d'un profil (`true` ou objet) vers ses options
 * effectives. `allow` par défaut : c'est le niveau de confiance des profils
 * headless existants — l'isolation vient du clone et l'autorité du Test
 * Gate, pas de la politique de permission. Une option invalide est refusée
 * (PROFILE_INVALID), jamais ignorée : fail closed.
 */
export function resolveAcpOptions(profile: AgentProfile): AcpOptions {
  const acp = profile.acp;
  const problem = acpOptionsProblem(acp);
  if (problem) {
    throw new StriartError(`Profil ACP invalide : option "${problem.field}" refusée.`, {
      code: 'PROFILE_INVALID',
      hint: 'striart profiles',
      details: problem,
    });
  }
  const o = isPlainObject(acp) ? (acp as Record<string, unknown>) : {};
  const permissions = (o.permissions as AcpOptions['permissions']) ?? 'allow';
  const terminal = o.terminal as boolean | Record<string, number> | undefined;
  const t = isPlainObject(terminal) ? terminal : {};
  const e = (isPlainObject(o.elicitation) ? o.elicitation : {}) as {
    form?: boolean;
    url?: boolean;
  };
  const ask = permissions === 'ask';
  return {
    permissions,
    askTimeoutMs: (o.askTimeoutMs as number) ?? DEFAULT_ASK_TIMEOUT_MS,
    authMethodId: (o.auth as { methodId?: string } | undefined)?.methodId ?? null,
    persistentHost: (o.persistentHost as boolean | undefined) ?? true,
    bus: (o.bus as boolean | undefined) ?? true,
    terminal: {
      enabled: terminal !== false,
      timeoutMs: (t.timeoutMs as number) ?? DEFAULT_TERMINAL.timeoutMs,
      outputByteLimit: (t.outputByteLimit as number) ?? DEFAULT_TERMINAL.outputByteLimit,
      maxTerminals: (t.maxTerminals as number) ?? DEFAULT_TERMINAL.maxTerminals,
    },
    fsReadMaxBytes: (o.fsReadMaxBytes as number | undefined) ?? DEFAULT_FS_READ_MAX_BYTES,
    mcp: (o.mcp as AcpOptions['mcp']) ?? 'striart',
    elicitation: { form: ask && (e.form ?? true), url: ask && (e.url ?? false) },
  };
}

/**
 * Protections RELÂCHÉES par la config d'un profil ACP, par rapport aux
 * défauts sûrs — à journaliser au démarrage de chaque session et à afficher
 * par `striart doctor` (principe : relâcher une protection est explicite,
 * journalisé, visible). Rend des identifiants stables (`acp.<clé>`).
 */
export function acpRelaxedProtections(options: AcpOptions): string[] {
  const relaxed: string[] = [];
  if (options.authMethodId) relaxed.push('acp.auth.methodId');
  if (options.elicitation.url) relaxed.push('acp.elicitation.url');
  if (options.terminal.enabled && options.terminal.timeoutMs > DEFAULT_TERMINAL.timeoutMs)
    relaxed.push('acp.terminal.timeoutMs');
  if (
    options.terminal.enabled &&
    options.terminal.outputByteLimit > DEFAULT_TERMINAL.outputByteLimit
  )
    relaxed.push('acp.terminal.outputByteLimit');
  if (options.terminal.enabled && options.terminal.maxTerminals > DEFAULT_TERMINAL.maxTerminals)
    relaxed.push('acp.terminal.maxTerminals');
  if (options.fsReadMaxBytes > DEFAULT_FS_READ_MAX_BYTES) relaxed.push('acp.fsReadMaxBytes');
  return relaxed;
}

/**
 * Un chemin demandé par l'agent (fs/read, fs/write) est-il DANS le clone ?
 * Contrôle lexical : refus de tout ce qui en sort — par `..` ou chemin
 * absolu tiers. Même philosophie que `isSafeProjectPath` côté Router : la
 * sortie d'un process externe est un identifiant à contraindre.
 */
export function isPathInsideClone(cloneRoot: string, candidate: string): boolean {
  if (typeof candidate !== 'string' || candidate.trim().length === 0) return false;
  if (candidate.includes('\0')) return false;
  const resolved = path.resolve(cloneRoot, candidate);
  return isInside(path.resolve(cloneRoot), resolved);
}

function isInside(base: string, target: string): boolean {
  const relative = path.relative(base, target);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/**
 * Résout un chemin demandé par l'agent en chemin absolu DANS le clone, liens
 * symboliques compris : le contrôle lexical seul laisserait un lien
 * `clone/sortie -> /ailleurs` servir de tremplin hors du clone. Le plus
 * profond ancêtre EXISTANT est résolu (`realpath`) — un fichier à créer n'a
 * pas encore de chemin réel, son dossier parent si. Rend null pour tout
 * chemin qui sort du clone.
 */
export async function resolvePathInsideClone(
  cloneRoot: string,
  candidate: string,
): Promise<string | null> {
  const realRoot = await realpath(cloneRoot);
  // Pré-contrôle lexical contre le clone TEL QUE DÉSIGNÉ et contre son chemin
  // réel : un agent dont le cwd est le clone cite ses fichiers par le chemin
  // canonique (process.cwd()), alors que Striart a pu désigner le clone par un
  // chemin passant par un lien (macOS : /var → /private/var). Le contrôle réel
  // ci-dessous reste, lui, la garde — liens et jonctions suivis.
  if (!isPathInsideClone(cloneRoot, candidate) && !isPathInsideClone(realRoot, candidate)) {
    return null;
  }
  const target = path.resolve(cloneRoot, candidate);
  let probe = target;
  const tail: string[] = [];
  for (;;) {
    try {
      const real = await realpath(probe);
      const full = tail.length > 0 ? path.join(real, ...tail.reverse()) : real;
      return isInside(realRoot, full) ? target : null;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return null;
      // `realpath` d'un lien PENDANT (cible absente) lève aussi ENOENT : sans
      // ce contrôle, le chemin passait pour « à créer » et l'écriture suivante
      // suivait le lien hors du clone. Une entrée qui existe (lstat) sans
      // pouvoir être résolue est refusée.
      if (
        await lstat(probe).then(
          () => true,
          () => false,
        )
      )
        return null;
      const parent = path.dirname(probe);
      if (parent === probe) return null;
      tail.push(path.basename(probe));
      probe = parent;
    }
  }
}

/** Un chemin (relatif à `base`) passe-t-il par un dossier `.git` (casse ignorée : NTFS/APFS) ? */
function passesThroughGitDir(base: string, full: string): boolean {
  return path
    .relative(base, full)
    .split(/[\\/]/)
    .some((segment) => segment.toLowerCase() === '.git');
}

/**
 * Comme `resolvePathInsideClone`, pour une ÉCRITURE : refuse en plus tout chemin
 * qui passe par un dossier `.git` — la config et les hooks du clone y font
 * exécuter un programme choisi par l'agent à la prochaine commande git de
 * Striart. Le chemin RÉEL (liens et jonctions suivis) est contrôlé aussi : un
 * raccourci vers `.git` ne contourne pas la garde. La lecture de `.git/` reste
 * permise.
 */
export async function resolveWritablePathInsideClone(
  cloneRoot: string,
  candidate: string,
): Promise<string | null> {
  const target = await resolvePathInsideClone(cloneRoot, candidate);
  if (!target) return null;
  if (passesThroughGitDir(path.resolve(cloneRoot), target)) return null;
  const realRoot = await realpath(cloneRoot);
  let probe = target;
  const tail: string[] = [];
  for (;;) {
    try {
      const real = await realpath(probe);
      const full = tail.length > 0 ? path.join(real, ...tail.reverse()) : real;
      return passesThroughGitDir(realRoot, full) ? null : target;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return null;
      const parent = path.dirname(probe);
      if (parent === probe) return null;
      tail.push(path.basename(probe));
      probe = parent;
    }
  }
}

/**
 * Choisit la réponse à une demande de permission selon la politique du
 * profil. `allow` privilégie l'accord ponctuel (`allow_once`) sur l'accord
 * permanent : la politique re-décide à chaque demande, l'agent n'obtient
 * jamais un blanc-seing qu'un arbitrage humain ne pourrait retirer.
 */
export function selectPermissionOption(
  options: PermissionOption[],
  policy: AcpOptions['permissions'],
): PermissionOption | null {
  if (!Array.isArray(options) || options.length === 0) return null;
  const byKind = (kinds: string[]) =>
    kinds.map((k) => options.find((o) => o.kind === k)).find(Boolean) ?? null;
  if (policy === 'allow') {
    return byKind(['allow_once', 'allow_always']) ?? options[0];
  }
  return byKind(['reject_once', 'reject_always']);
}

/** Extrait le texte des blocs de contenu d'une mise à jour de session. */
function contentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (content && typeof content === 'object' && 'text' in content) {
    const text = (content as { text?: unknown }).text;
    return typeof text === 'string' ? text : '';
  }
  return '';
}

/**
 * Transcrit une notification `session/update` en ligne(s) de log lisibles.
 * C'est le gain d'observabilité du transport : le log raconte le déroulé
 * (messages, plan, appels d'outils), pas seulement la fin de la session.
 */
export function formatSessionUpdate(update: Record<string, unknown>): string | null {
  const kind = update?.sessionUpdate;
  switch (kind) {
    case 'agent_message_chunk':
      return contentText(update.content) || null;
    case 'agent_thought_chunk':
      return null; // Le raisonnement interne n'est pas du déroulé : bruit.
    case 'tool_call': {
      const title = typeof update.title === 'string' ? update.title : '(outil)';
      const status = typeof update.status === 'string' ? update.status : 'pending';
      return `\n[outil] ${title} — ${status}\n`;
    }
    case 'tool_call_update': {
      const status = typeof update.status === 'string' ? update.status : null;
      return status ? `[outil] → ${status}\n` : null;
    }
    case 'plan': {
      const entries = Array.isArray(update.entries) ? update.entries : [];
      const lines = entries
        .map((e) => {
          const entry = e as { content?: unknown; status?: unknown };
          const text = contentText(entry.content) || String(entry.content ?? '');
          return `  - [${entry.status ?? '?'}] ${text}`;
        })
        .join('\n');
      return lines ? `\n[plan]\n${lines}\n` : null;
    }
    default:
      return null; // user_message_chunk, available_commands_update… : écho ou méta.
  }
}

/** Normalise la liste `authMethods` d'une réponse `initialize` (données non fiables). */
export function parseAuthMethods(raw: unknown): AuthMethod[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((m): m is Record<string, unknown> => isPlainObject(m) && typeof m.id === 'string')
    .map((m) => ({
      id: m.id as string,
      name: typeof m.name === 'string' ? m.name : undefined,
      description: typeof m.description === 'string' ? m.description : undefined,
      type: typeof m.type === 'string' ? m.type : undefined,
      args: Array.isArray(m.args) ? m.args.filter((a): a is string => typeof a === 'string') : [],
    }));
}

/** Une méthode est-elle passable à `authenticate` ? (jamais 'terminal', protocole v1). */
export function isProtocolAuthMethod(method: AuthMethod): boolean {
  return method.type == null || method.type === 'agent';
}

/** Neutralise les caractères de contrôle d'un texte venu de l'agent avant de le citer. */
function clean(text: string): string {
  return text.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').slice(0, 200);
}

/**
 * Message (anglais, actionnable) d'un agent ACP qui exige une
 * authentification : chaque méthode annoncée, et pour chacune la voie
 * concrète — appel `authenticate` sur décision explicite de la config, ou la
 * commande interactive à lancer soi-même pour une méthode 'terminal' (que le
 * protocole interdit de passer à `authenticate`).
 */
export function buildAuthRequiredMessage({
  profileKey,
  command,
  args,
  methods,
}: {
  profileKey: string;
  command: string;
  args: string[];
  methods: AuthMethod[];
}): string {
  const lines = [
    'The ACP agent requires authentication before it can open a session; Striart never signs in on its own.',
  ];
  if (methods.length === 0) {
    lines.push(
      `It advertised no authentication method: sign in with the agent's own CLI ("${clean(command)}"), then rerun.`,
    );
    return lines.join(' ');
  }
  const described = methods.map((m) => {
    const label = m.name ? ` ("${clean(m.name)}")` : '';
    if (isProtocolAuthMethod(m)) return `${clean(m.id)}${label}`;
    const login = [command, ...args, ...(m.args ?? [])].map(clean).join(' ');
    return `${clean(m.id)}${label}, interactive: run "${login}" in a terminal`;
  });
  lines.push(`Advertised methods: ${described.join('; ')}.`);
  const protocolIds = methods.filter(isProtocolAuthMethod).map((m) => clean(m.id));
  if (protocolIds.length > 0) {
    lines.push(
      `Either sign in with the agent's own CLI, or set agentProfiles.${clean(profileKey)}.acp.auth.methodId to ${protocolIds.map((id) => `"${id}"`).join(' or ')} to let Striart call "authenticate" (explicit decision).`,
    );
  } else {
    lines.push('Sign in interactively as shown, then rerun.');
  }
  return lines.join(' ');
}

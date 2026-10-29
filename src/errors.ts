/**
 * Erreur métier Striart.
 *
 * - `code` : machine-readable et stable (ex: NOT_A_GIT_REPO, AGENT_EXISTS) —
 *   fait partie du contrat public (sortie `--json`, MCP, dashboard), documenté
 *   dans docs/fr/depannage.md et docs/en/troubleshooting.md.
 * - `details` : contexte utile au debug. Exposé tel quel en `--json` : n'y
 *   mettre ni valeur d'environnement ni contenu de fichier, seulement des
 *   identifiants (nom d'agent, id de ticket, chemin, PID…).
 * - `hint` : la prochaine action concrète, idéalement une commande exacte
 *   (« striart status »). Affichée sous le message par la CLI, renvoyée
 *   telle quelle par le MCP et le dashboard.
 * - `kind` : la NATURE de l'échec, qui décide du code de sortie de la CLI
 *   (voir ERROR_KINDS ci-dessous).
 */

/**
 * Nature d'un échec :
 *  - 'usage'   : l'entrée de l'appelant est invalide quel que soit l'état du
 *                dépôt (nom mal formé, valeur hors bornes, options
 *                incompatibles) — rejetée avant toute action. Sortie 2.
 *  - 'refusal' : une garde de Striart a refusé l'opération pour protéger du
 *                travail ou une session (travail non mergé, session vivante,
 *                secret historique…). Relancer telle quelle ne changera rien :
 *                il faut une décision humaine. Sortie 3.
 *  - 'failure' : l'exécution a échoué (git, LLM, disque, config, cible
 *                introuvable). Peut être transitoire. Sortie 1.
 */
export type ErrorKind = 'usage' | 'refusal' | 'failure';

/**
 * Classification des codes — source unique, auditée par
 * tests/unit/cli-exit.test.js (« nature des erreurs du domaine »). Un code
 * absent est un 'failure' : le défaut le plus sûr pour un script appelant
 * (échec, potentiellement relançable).
 */
export const ERROR_KINDS: Readonly<Record<string, ErrorKind>> = Object.freeze({
  // Usage : invalide quel que soit l'état du dépôt.
  ATTACH_WRONG_CWD: 'usage',
  EXCESS_ARGUMENTS: 'usage',
  MISSING_ARGUMENT: 'usage',
  MISSING_COMMAND: 'usage',
  MISSING_OPTION: 'usage',
  MISSING_OPTION_VALUE: 'usage',
  UNKNOWN_COMMAND: 'usage',
  UNKNOWN_OPTION: 'usage',
  EMPTY_PROMPT: 'usage',
  INVALID_AGENT_NAME: 'usage',
  INVALID_ARGUMENT: 'usage',
  INVALID_PID: 'usage',
  INVALID_RETENTION_DAYS: 'usage',
  LOCK_PID_DEAD: 'usage',
  LOCK_PID_EPHEMERAL: 'usage',
  LOCK_REASON_EMPTY: 'usage',
  // `striart mcp --root` ne désigne pas un dépôt Striart initialisé, ou
  // --agent contredit le clone désigné par le cwd.
  MCP_ROOT_INVALID: 'usage',
  MCP_SCOPE_CONFLICT: 'usage',
  OPTION_CONFLICT: 'usage',
  PERMISSION_ID_INVALID: 'usage',
  // Réponse humaine non conforme au formulaire demandé par l'agent.
  ELICITATION_CONTENT_INVALID: 'usage',
  ACP_PROMPT_INVALID: 'usage',
  // Lot I10 (proxy `striart acp`) : requête de l'IDE mal formée ou hors
  // protocole — option de session inconnue/invalide, session inconnue,
  // `initialize` manquant, méthode non servie (fs/*, terminal/* compris),
  // répertoire de session hors du dépôt servi (--root).
  ACP_PROXY_OPTION_UNKNOWN: 'usage',
  ACP_PROXY_OPTION_INVALID: 'usage',
  ACP_PROXY_SESSION_UNKNOWN: 'usage',
  ACP_PROXY_NOT_INITIALIZED: 'usage',
  ACP_PROXY_AUTH_METHOD_UNKNOWN: 'usage',
  ACP_PROXY_METHOD_UNSUPPORTED: 'usage',
  ACP_PROXY_CWD_OUTSIDE_ROOT: 'usage',
  PLAN_INVALID: 'usage',
  // Lot O : message de collaboration mal formé, destinataire inconnu,
  // groupe/rôle ambigu (l'appelant doit préciser), verdict humain mal
  // formé, option de `striart orchestrate` hors de son mode.
  COLLAB_MESSAGE_INVALID: 'usage',
  COLLAB_RECIPIENT_UNKNOWN: 'usage',
  COLLAB_GROUP_AMBIGUOUS: 'usage',
  COLLAB_ROLE_AMBIGUOUS: 'usage',
  REVIEW_VERDICT_INVALID: 'usage',
  ORCHESTRATE_USAGE: 'usage',
  // `striart usage` : période (--since/--until) mal formée ou incohérente.
  USAGE_PERIOD_INVALID: 'usage',
  REUSE_NEEDS_AGENT: 'usage',
  UI_REQUIRES_TTY: 'usage',
  UNSUPPORTED_OUTPUT_FORMAT: 'usage',
  // `striart hook install|uninstall` : outil inconnu, portée (--user/--agent) absente.
  HOOK_SCOPE_REQUIRED: 'usage',
  // Outil hors de l'ensemble FERMÉ de la CLI (claude, codex…) : invalide quel que
  // soit l'état du dépôt, rejeté avant toute action (sortie 2). Contraste
  // PROFILE_UNKNOWN, qui dépend de la config de la cible : échec (1).
  HOOK_TOOL_UNKNOWN: 'usage',
  // Striart Control Protocol : message mal formé ou hors contrat (le client
  // doit corriger sa requête ; relancer telle quelle ne changera rien).
  CONTROL_INVALID_REQUEST: 'usage',
  CONTROL_MESSAGE_TOO_LARGE: 'usage',
  CONTROL_METHOD_UNAVAILABLE: 'usage',
  CONTROL_METHOD_UNKNOWN: 'usage',
  CONTROL_PARSE_ERROR: 'usage',
  CONTROL_SUBSCRIPTION_UNKNOWN: 'usage',
  CONTROL_VERSION_UNSUPPORTED: 'usage',

  // Refus : une garde protège du travail, une session ou le dépôt.
  // Plan humain : session absente, origine ou contexte non autorisé.
  CONTROL_CSRF_REFUSED: 'refusal',
  CONTROL_NESTED_SESSION: 'refusal',
  CONTROL_ORIGIN_REFUSED: 'refusal',
  CONTROL_UNAUTHENTICATED: 'refusal',
  // Import ACP : version non épinglée, intégrité absente ou fausse, archive
  // dangereuse — relancer telle quelle ne changera rien.
  ACP_DOWNLOAD_INTEGRITY_MISMATCH: 'refusal',
  ACP_EXTRACT_UNSAFE: 'refusal',
  ACP_IMPORT_NO_INTEGRITY: 'refusal',
  ACP_IMPORT_UNPINNED: 'refusal',
  AFTER_CYCLE: 'refusal',
  // Lot O : le canal de collaboration refuse (hors groupe, verdict hors du
  // tour d'un relecteur, borne atteinte, canal coupé) ; verdict humain
  // demandé sur une relecture qui n'attend plus.
  COLLAB_DISABLED: 'refusal',
  COLLAB_KIND_FORBIDDEN: 'refusal',
  COLLAB_LIMIT_REACHED: 'refusal',
  COLLAB_NOT_MEMBER: 'refusal',
  REVIEW_NOT_PENDING: 'refusal',
  AGENT_EXISTS: 'refusal',
  AGENT_HAS_PENDING: 'refusal',
  AGENT_QUEUED: 'refusal',
  // Suppression de clone entamée : le nom n'est réutilisable qu'après sa fin.
  CLONE_REMOVAL_PENDING: 'refusal',
  DAEMON_RUNNING: 'refusal',
  DAEMON_IDENTITY_UNVERIFIED: 'refusal',
  DAEMON_STOP_DENIED: 'refusal',
  HISTORICAL_SECRETS_FOUND: 'refusal',
  // `striart hook install` : la cible est versionnée par le dépôt (la garde
  // des chemins protégés refuserait le merge), n'est pas de Striart, ou un
  // chemin ne peut pas être écrit fidèlement dans la commande du hook.
  HOOK_PATH_UNSAFE: 'refusal',
  HOOK_TARGET_FOREIGN: 'refusal',
  HOOK_TARGET_TRACKED: 'refusal',
  // Exclusivité perdue / état du principal changé sous une opération : rien
  // n'est commité, une décision humaine (qui a agi ?) précède toute relance.
  LOCK_LOST: 'refusal',
  // Verrou principal — échecs d'EXÉCUTION, relançables (classés explicitement,
  // pas par le défaut : un code absent de la table est un oubli, pas un choix) :
  //  - LOCK_WAIT_CANCELLED : attente annulée par l'appelant avant toute
  //    acquisition, rien n'a démarré ni changé. Sur Ctrl+C/SIGTERM la CLI sort
  //    en 130/143 (main.ts : le signal l'emporte sur la nature) ; sans signal
  //    (annulation MCP/dashboard), c'est un échec relançable ;
  //  - LOCK_IO_FAILED : E/S du verrou ou de sa file impossible (droits,
  //    antivirus, disque) ;
  //  - LOCK_TIMEOUT : délai dépassé (détenteur lent, figé ou débris indélébile).
  LOCK_WAIT_CANCELLED: 'failure',
  LOCK_IO_FAILED: 'failure',
  LOCK_TIMEOUT: 'failure',
  MAIN_DIRTY: 'refusal',
  MAIN_DIVERGED: 'refusal',
  MAIN_SESSION_LIVE: 'refusal',
  // GC d'inactivité (src/idle/) : une fermeture que les gardes refusent est un REFUS (sortie 3),
  // jamais un succès silencieux — l'agent reste vivant, son clone intact. Ces codes sont portés
  // par le rapport (`closed[].code`, `refused[].code`), pas levés : le balayage ne s'arrête pas
  // sur un agent.
  //  - UNVERIFIED     : le process visé n'est pas identifiable (PID recyclé, autre utilisateur) ;
  //  - NOT_ACKNOWLEDGED : le superviseur de la session n'a pas accusé la demande d'arrêt propre ;
  //  - BLOCKED        : une garde (demande humaine, ticket, merge, plan, session du principal).
  IDLE_CLOSE_UNVERIFIED: 'refusal',
  IDLE_CLOSE_NOT_ACKNOWLEDGED: 'refusal',
  IDLE_CLOSE_BLOCKED: 'refusal',
  IDLE_CLOSE_FAILED: 'failure',
  IDLE_STATE_CORRUPT: 'failure',
  // Serveur MCP : outil mutant refusé par le niveau de l'appelant (D6) —
  // lecture seule demandée, profondeur d'orchestration, ou hors du périmètre
  // de l'agent appelant. Relancer tel quel ne change rien.
  MCP_DEPTH_LIMIT: 'refusal',
  MCP_READ_ONLY: 'refusal',
  MCP_SCOPE_DENIED: 'refusal',
  MCP_PROTECTED_TICKET: 'refusal',
  ACP_SOCKET_DIR_UNSAFE: 'refusal',
  SECRET_PATTERN_INVALID: 'usage',
  MERGE_STATE_CHANGED: 'refusal',
  // Lot T (tokens) : plafond de dépense atteint (appel LLM refusé AVANT envoi,
  // session d'agent arrêtée), coût plafonné sans prix déclaré pour le modèle,
  // conflit trop volumineux pour la fenêtre du Merger. Relancer tel quel ne
  // change rien : relever le plafond / déclarer le prix / résoudre à la main.
  TOKEN_BUDGET_EXCEEDED: 'refusal',
  TOKEN_PRICE_MISSING: 'refusal',
  // Relevé d'usage ou cumuls de budget illisibles avec tokens.onAccountingError
  // 'fail' : comptabilité aveugle refusée (panne disque, droits) — défaillance.
  TOKEN_ACCOUNTING_FAILED: 'failure',
  MERGE_WINDOW_EXCEEDED: 'refusal',
  MERGE_RECOVERY_BLOCKED: 'refusal',
  // Binaire natif altéré ou non vérifiable : jamais exécuté, relancer n'y
  // change rien (réinstaller). Les autres NATIVE_* sont des 'failure'.
  NATIVE_INTEGRITY_FAILED: 'refusal',
  // Le nettoyage d'un conteneur de process natif n'a pas abouti (process
  // survivants) et le Test Gate rouge GATE_ORPHAN_PROCESS (un descendant du
  // test vivait encore après la sortie et le délai de grâce) : l'exécution
  // est en cause, pas la décision de l'utilisateur — 'failure'.
  JOB_TERMINATE_INCOMPLETE: 'failure',
  GATE_ORPHAN_PROCESS: 'failure',
  NOT_A_STRIART_MERGE: 'refusal',
  // Lot I10 (proxy `striart acp`) : option figée après le premier prompt,
  // session finie, prompt déjà en cours, collision du Router (aucun clone
  // créé), aucun profil ACP disponible ou profil hors de la liste blanche.
  ACP_PROXY_OPTION_LOCKED: 'refusal',
  ACP_PROXY_SESSION_ENDED: 'refusal',
  ACP_PROXY_PROMPT_BUSY: 'refusal',
  ACP_PROXY_COLLISION: 'refusal',
  ACP_PROXY_NO_PROFILE: 'refusal',
  ACP_PROXY_PROFILE_UNAVAILABLE: 'refusal',
  // Garde I2 : un chemin protégé changé par l'agent n'est jamais appliqué
  // sans une résolution humaine explicite de ce chemin.
  PROTECTED_PATHS_CHANGED: 'refusal',
  RESOLUTION_INCOMPLETE: 'refusal',
  REUSE_DIRTY: 'refusal',
  REUSE_IN_USE: 'refusal',
  REUSE_UNMERGED: 'refusal',
  SESSION_LIVE: 'refusal',
  // Un hôte de pty natif tient déjà l'agent (verrou exclusif de l'hôte) :
  // s'y attacher (`striart attach`) plutôt que d'en lancer un second.
  PTY_HOST_ALREADY_RUNNING: 'refusal',
  // `pty.shell` (config) désigne un shell inutilisable (introuvable, non
  // exécutable, chemin relatif) : refus explicite (jamais de repli sur auto),
  // mais de nature « config invalide » = échec, comme CONFIG_INVALID — c'est
  // le fichier qu'il faut corriger, pas une garde qui protège du travail.
  PTY_SHELL_INVALID: 'failure',
  // Une session ACP vit déjà pour cet agent (hôte persistant) : une à la fois.
  ACP_HOST_BUSY: 'refusal',
  // Agent ACP non connecté : un humain doit s'authentifier (jamais automatique).
  ACP_AUTH_REQUIRED: 'refusal',
  ACP_BUS_DISABLED: 'refusal',
  ACP_SESSION_CLOSING: 'refusal',
  ACP_HOST_AUTH_FAILED: 'refusal',
  STALE_TICKET: 'refusal',
  TARGET_BRANCH_MISMATCH: 'refusal',
  TERMINAL_UNSAFE: 'refusal',
  TICKET_ALREADY_RESOLVED: 'refusal',
  // Ticket illisible : rien à appliquer, l'humain l'inspecte puis le ferme.
  TICKET_CORRUPT: 'refusal',
  TICKET_NOT_APPLICABLE: 'refusal',
  UNTRACKED_COLLISION: 'refusal',
  // Gardes qui refusent en attendant une décision humaine (identité git,
  // jeton de dashboard non protégeable, config utilisateur lisible par
  // d'autres, promotion non configurée, commit Striart défait, résolution
  // d'un genre non supporté, demande qui n'attend plus, dépôt sans commit,
  // plateforme sans binaire) ; --after vers un agent inconnu comme vers un
  // cycle : la file refuse la dépendance déclarée.
  ACP_IMPORT_PLATFORM_UNSUPPORTED: 'refusal',
  // Variable d'environnement fournie par le registre ACP : refusée hors liste
  // `acpRegistry.allowEnv` (et toujours pour NODE_OPTIONS, PATH, LD_*…).
  ACP_IMPORT_ENV_FORBIDDEN: 'refusal',
  // Écriture de Striart dans un clone qui suivrait un lien symbolique/une jonction
  // (src/safe-write.ts) : refusée, jamais contournée.
  SAFE_WRITE_UNSAFE: 'refusal',
  AFTER_UNKNOWN: 'refusal',
  COMMITTER_IDENTITY_MISSING: 'refusal',
  CONTROL_TOKEN_UNPROTECTED: 'refusal',
  ELICITATION_NOT_PENDING: 'refusal',
  EMPTY_REPO: 'refusal',
  PERMISSION_NOT_PENDING: 'refusal',
  PROMOTION_DISABLED: 'refusal',
  STRIART_COMMIT_UNSAFE: 'refusal',
  // Chemin de ticket falsifié (hors dépôt, dans .git) ; PID file de daemon corrompu.
  TICKET_PATH_UNSAFE: 'refusal',
  DAEMON_PIDFILE_CORRUPT: 'refusal',
  UNSUPPORTED_RESOLUTION_KIND: 'refusal',
  USER_CONFIG_UNSAFE: 'refusal',
  NET_OFFLINE: 'refusal',
  NET_HOST_NOT_ALLOWED: 'refusal',
  NET_INSECURE_TRANSPORT: 'refusal',
  NET_REDIRECT_REFUSED: 'refusal',

  // Échecs d'exécution, CLASSÉS EXPLICITEMENT : un code levé et absent de
  // cette table est un oubli (tests/unit/cli-contract.test.js l'exige). Une
  // cible introuvable (agent, relecture, profil, ticket, outil de hook,
  // agent du registre ACP, hôte) est un échec — jamais un usage — pour toute
  // la famille « *_UNKNOWN », comme AGENT_UNKNOWN depuis la 0.10.
  ACP_AGENT_UNKNOWN: 'failure',
  ACP_AUTH_METHOD_UNAVAILABLE: 'failure',
  ACP_EXTRACT_FAILED: 'failure',
  ACP_HOST_FAILED: 'failure',
  ACP_HOST_LOST: 'failure',
  ACP_HOST_PROTOCOL: 'failure',
  ACP_HOST_SPAWN_FAILED: 'failure',
  ACP_HOST_UNREACHABLE: 'failure',
  ACP_PROXY_QUEUE_TOOK_OVER: 'failure',
  ACP_PROXY_UPSTREAM_ENDED: 'failure',
  ACP_REGISTRY_FETCH_FAILED: 'failure',
  ACP_REGISTRY_INVALID: 'failure',
  ACP_SESSION_NOT_FOUND: 'failure',
  AGENT_UNKNOWN: 'failure',
  CLONE_FAILED: 'failure',
  CLONE_NOT_FOUND: 'failure',
  COLLAB_CORRUPT: 'failure',
  COLLAB_GROUP_UNKNOWN: 'failure',
  CONFIG_INVALID: 'failure',
  CONTROL_INSTANCE_NOT_FOUND: 'failure',
  DAEMON_BUSY: 'failure',
  DAEMON_SPAWN_FAILED: 'failure',
  MERGE_COMMIT_FAILED: 'failure',
  // Hook de la cible (pre-commit, commit-msg…) ou signature qui rejette / bloque le
  // commit de merge : ticket + merge annulé.
  COMMIT_HOOK_REJECTED: 'failure',
  // Nom de branche de livraison non dérivable. Les échecs de PUSH (PUSH_TIMEOUT,
  // PUSH_NON_FAST_FORWARD, PUSH_REJECTED, PUSH_SUPERSEDED, PUSH_FAILED) ne sont PAS
  // levés : ce sont des codes du rapport `delivery` / de `pushError` (le merge local
  // reste valide).
  DELIVERY_REF_INVALID: 'failure',
  TICKETS_UNREADABLE: 'failure',
  ELICITATION_INVALID: 'failure',
  HOOK_CONFIG_UNREADABLE: 'failure',
  LLM_CONFIG_INVALID: 'failure',
  LOCKS_CORRUPT: 'failure',
  MAIN_SESSION_CORRUPT: 'failure',
  MCP_OVERLOADED: 'failure',
  MCP_RESOURCE_UNKNOWN: 'failure',
  MEMORY_FAILED: 'failure',
  MERGE_ABORT_FAILED: 'failure',
  MERGE_FAILED: 'failure',
  NATIVE_COMMAND_FAILED: 'failure',
  NATIVE_PROTOCOL_ERROR: 'failure',
  NATIVE_UNAVAILABLE: 'failure',
  NOT_A_GIT_REPO: 'failure',
  NOT_INITIALIZED: 'failure',
  ORCHESTRATION_STATE_CORRUPT: 'failure',
  PERMISSION_OPTION_UNKNOWN: 'failure',
  PLAN_NOT_FOUND: 'failure',
  PORT_IN_USE: 'failure',
  PROFILE_INVALID: 'failure',
  PROFILE_UNKNOWN: 'failure',
  PTY_ATTACH_LISTEN_FAILED: 'failure',
  PTY_HOST_SPAWN_FAILED: 'failure',
  PTY_HOST_UNKNOWN_AGENT: 'failure',
  PTY_SESSION_NOT_FOUND: 'failure',
  QUEUE_CORRUPT: 'failure',
  RACE_JUDGE_FAILED: 'failure',
  REGISTRY_CORRUPT: 'failure',
  REUSE_FETCH_FAILED: 'failure',
  REUSE_NO_CLONE: 'failure',
  REVIEW_CORRUPT: 'failure',
  REVIEW_UNKNOWN: 'failure',
  ROUTER_FAILED: 'failure',
  SECRETS_EXCLUSION_FAILED: 'failure',
  SEMANTIC_MERGE_FAILED: 'failure',
  SESSION_LOG_UNAVAILABLE: 'failure',
  STATE_CORRUPT: 'failure',
  STATE_LOCK_FAILED: 'failure',
  STATE_LOCK_LOST: 'failure',
  STATE_LOCK_TIMEOUT: 'failure',
  STATE_READ_FAILED: 'failure',
  STATE_UNPROTECTED: 'refusal',
  STATE_WRITE_FAILED: 'failure',
  TERMINAL_CONTEXT_MISSING: 'failure',
  TERMINAL_LAUNCHER_UNSUPPORTED: 'failure',
  TICKET_UNKNOWN: 'failure',
  UNKNOWN_BRANCH: 'failure',
  USER_CONFIG_INVALID: 'failure',
  NET_URL_INVALID: 'failure',
  NET_PROXY_UNSUPPORTED: 'failure',
  NET_TLS_UNTRUSTED: 'failure',
  NET_CA_INVALID: 'failure',
  WARP_NOT_FOUND: 'failure',
});

export function errorKindOf(code: string): ErrorKind {
  return ERROR_KINDS[code] ?? 'failure';
}

/**
 * Champs dont le CONTENU n'est jamais rendu public, quel que soit le niveau
 * d'imbrication : env et profils (clés d'API), valeurs de config brutes, URL
 * (webhooks = secrets porteurs), et tout nom évoquant un secret.
 */
const REDACTED_FIELD =
  /^(env|value|profile|headers?|cookies?)$|url$|secret|token|password|passwd|api_?key|authori[sz]ation|credential/i;

/**
 * `profile` désigne tantôt la DÉFINITION d'un profil (objet : commande, env —
 * masquée), tantôt son NOM (identifiant de config, publié par `striart
 * profiles`) : un nom bien formé reste lisible, tout le reste est masqué.
 */
const PROFILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/**
 * `details` tel qu'exposé hors du process (`--json`). Défense en
 * profondeur : la règle reste de n'y mettre que des identifiants (voir
 * StriartError), ce filtre rattrape un oubli plutôt que de laisser fuir un
 * secret sur stdout — d'où un caviardage par nom de champ, récursif.
 */
export function publicErrorDetails(details: unknown): Record<string, unknown> {
  const scrub = (value: unknown, depth: number): unknown => {
    if (depth > 8) return '[truncated]';
    if (Array.isArray(value)) return value.map((v) => scrub(v, depth + 1));
    if (value === null || typeof value !== 'object') return value;
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => {
        if (k === 'profile' && typeof v === 'string' && PROFILE_NAME.test(v)) return [k, v];
        return [k, REDACTED_FIELD.test(k) ? '[redacted]' : scrub(v, depth + 1)];
      }),
    );
  };
  if (details === null || typeof details !== 'object' || Array.isArray(details)) return {};
  return scrub(details, 0) as Record<string, unknown>;
}

export interface StriartErrorOptions {
  code?: string;
  details?: Record<string, unknown>;
  hint?: string | null;
  /** À passer seulement pour déroger à la table ERROR_KINDS (rare : un même
   * code dont la nature dépend du contexte). */
  kind?: ErrorKind;
  cause?: unknown;
}

export class StriartError extends Error {
  code: string;
  details: Record<string, unknown>;
  hint: string | null;
  kind: ErrorKind;

  constructor(
    message: string,
    { code = 'STRIART_ERROR', details = {}, hint = null, kind, cause }: StriartErrorOptions = {},
  ) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'StriartError';
    this.code = code;
    this.details = details;
    this.hint = hint;
    this.kind = kind ?? errorKindOf(code);
  }
}

/**
 * Agent absent du registre. Une seule fabrique pour les modules qui la
 * lèvent (clone, sync, orchestrateur) : même message, même `details`, même
 * piste de sortie — un texte recopié à six endroits finit par diverger.
 * @param context précision ajoutée au message
 */
export function agentUnknownError(agent: string, { context }: { context?: string } = {}) {
  return new StriartError(`Agent inconnu : « ${agent} »${context ? ` (${context})` : ''}.`, {
    code: 'AGENT_UNKNOWN',
    details: { agent },
    hint: 'striart status',
  });
}

/**
 * Ticket de conflit introuvable (ni ouvert ni résolu).
 */
export function ticketUnknownError(ticketId: string) {
  return new StriartError(`Ticket inconnu : « ${ticketId} ».`, {
    code: 'TICKET_UNKNOWN',
    details: { ticketId },
    hint: 'striart resolve --all',
  });
}

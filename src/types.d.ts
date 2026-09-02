/**
 * Contrats de données de Striart — TypeScript pur (déclarations uniquement).
 * Aucun impact runtime : le code exécuté reste du JavaScript, les JSDoc
 * référencent ces types via `import('./types.js')` (résolu vers ce .d.ts).
 * Vérifié par `npm run typecheck`.
 */

export interface LlmSpec {
  provider?: 'ollama' | 'openai' | 'anthropic' | 'azure';
  /** Pour azure : nom du deployment. */
  model?: string;
  baseUrl?: string;
  /** Nom de variable d'environnement — JAMAIS la clé elle-même. */
  apiKeyEnv?: string;
  /** Azure uniquement (défaut '2024-10-21'). */
  apiVersion?: string;
}

export interface StriartConfig {
  testCommand: string;
  targetBranch: string;
  autoPush: boolean;
  autoRebase: boolean;
  autoStash: boolean;
  semanticMerge: boolean;
  /** Retentatives du Merger avec le log du gate en feedback (0 = ticket immédiat). */
  semanticGateRetries: number;
  /** Secrets trackés retirés du worktree des clones (sparse-checkout, [] = désactivé). */
  secretPatterns: string[];
  /** Mémoire sémantique partagée entre agents (résumé LLM après chaque merge). */
  memoryLayer: boolean;
  memoryMaxEntries: number;
  /** Fenêtre (minutes) où l'activité disque d'un clone vaut présence de session. */
  presenceMinutes: number;
  llm: LlmSpec | null;
  agentCommand: string | null;
  /** Profils d'invocation non interactive, par fournisseur (mode autonome). */
  agentProfiles: Record<string, AgentProfile>;
  /** Délai max d'une session autonome avant kill de l'arbre de process. */
  autonomousTimeoutMs: number;
  /** Clone partiel des agents (ex: 'blob:none') — null = clone local complet hardlinké. */
  cloneFilter: string | null;
  /** Rétention de striart prune (jours d'inactivité avant suppression). */
  pruneDays: number;
  webhookUrl: string | null;
  /** Table multi-canaux de notification — s'ajoute à webhookUrl. */
  notifiers: NotifierSpec[];
  dashboardPort: number;
  /** Promotion staging → main (null = désactivée). */
  mainBranch: string | null;
  /** Gate global de promotion (null → testCommand). */
  promoteTestCommand: string | null;
  testTimeoutMs: number;
  fetchIntervalMs: number;
  ollamaModel: string;
  ollamaHost: string;
  /**
   * Prompts LLM surchargeables intégralement (null → défaut dans le module).
   * Placeholders obligatoires, validés au chargement (PROMPT_PLACEHOLDERS) :
   * router {{task}}+{{files}} ; merger {{file}}+{{base}}+{{ours}}+{{theirs}}+{{feedback}}.
   */
  prompts: { router: string | null; merger: string | null };
  /** Chemin du fichier de config trouvé. */
  configPath?: string | null;
}

export interface AgentMeta {
  /** striart/<agent>/task-<uuid> */
  branch: string;
  taskId: string;
  /** Chemin absolu du clone. */
  path: string;
  baseCommit: string;
  prompt: string | null;
  predictedFiles: string[];
  /** Outil de coding propre à cet agent. */
  command: string | null;
  /** Filtre de clone partiel utilisé à la création (null = clone complet). */
  cloneFilter?: string | null;
  /** Secrets trackés retirés du worktree au clonage. */
  secretsExcluded?: string[];
  createdAt: string;
  lastMergedCommit?: string;
  /**
   * Mode d'exécution de la session.
   *  - 'attended'   : l'humain lance et pilote l'agent (défaut historique).
   *  - 'autonomous' : Striart lance, supervise et nettoie.
   * Absent = 'attended' (registres créés avant l'introduction du mode).
   */
  mode?: 'attended' | 'autonomous';
  /** Clé de config.agentProfiles utilisée en mode autonome. */
  profile?: string | null;
  /** Clone réhabilité par `--reuse` (archive d'un agent arrêté resynchronisée). */
  reused?: boolean;
  /**
   * PID de la session autonome tant qu'elle tourne, null sinon. Tant qu'il
   * désigne un process vivant, le clone est intouchable (pas de rebase
   * concurrent). Un PID resté là après un crash est neutralisé par le
   * contrôle de vitalité.
   */
  sessionPid?: number | null;
  sessionStartedAt?: string | null;
}

export type AgentRegistry = Record<string, AgentMeta>;

/**
 * Profil d'invocation non interactive d'un outil de coding. `args` doit
 * contenir au moins une occurrence de `{{prompt}}`, substituée comme élément
 * d'argv (jamais via un shell).
 */
export interface AgentProfile {
  command: string;
  args: string[];
  /**
   * Transport ACP (Agent Client Protocol) : Striart dialogue avec l'outil en
   * JSON-RPC sur son stdio au lieu de lui passer le prompt en argv. `true`
   * (politique de permissions 'allow') ou `{ permissions, askTimeoutMs }`.
   * Politiques : 'allow' (accord ponctuel systématique), 'reject' (lecture
   * seule de fait), 'ask' (SEMI-AUTONOME — chaque demande est arbitrée par
   * l'humain via le dashboard ; sans réponse sous `askTimeoutMs`, fail
   * closed : reject). Avec ACP, `args` ne doit PAS contenir `{{prompt}}`
   * (le prompt passe par le protocole) — c'est l'inverse d'un profil argv.
   */
  acp?: boolean | { permissions?: 'allow' | 'reject' | 'ask'; askTimeoutMs?: number };
  /**
   * Variables d'environnement PROPRES à ce profil, fusionnées par-dessus
   * l'environnement du process au lancement (jamais STRIART_SESSION, qui
   * reste autoritaire). Sert à cloisonner : donner à chaque outil sa clé
   * (`OPENAI_API_KEY` pour l'un, `ANTHROPIC_API_KEY` pour l'autre) ou à
   * fixer un réglage (`MODEL`, région…). Valeurs littérales — pour référencer
   * un secret depuis l'environnement, utiliser un `striart.config.mjs`
   * (`env: { KEY: process.env.SOURCE }`), jamais inliner un secret en clair.
   */
  env?: Record<string, string>;
  /**
   * Délai max de session PROPRE à ce profil (ms). Précédence :
   * `--timeout` explicite > `profile.timeout` > `config.autonomousTimeoutMs`.
   */
  timeout?: number;
}

/**
 * Canal de notification sortant. Le `type` est explicite (le format du
 * payload en dérive : slack → {text}, discord → {content}, generic →
 * {message}) ; l'URL vient de `url` OU de `urlEnv` (nom d'une variable
 * d'environnement — préférable : une URL de webhook est un secret),
 * jamais des deux.
 */
export interface NotifierSpec {
  type: 'slack' | 'discord' | 'generic';
  url?: string;
  urlEnv?: string;
}

/**
 * Événement du bus d'observabilité (src/events.js) — émis par le kernel
 * APRÈS coup, consommé par des abonnés qui informent sans jamais décider.
 * `message` est le texte humain construit au site d'émission (le pont notify
 * le relaie tel quel) ; le reste est le payload machine pour les futurs
 * consommateurs (SSE du dashboard). Les erreurs ne passent jamais par ce
 * bus : elles remontent à l'appelant (StriartError, résultats typés).
 */
export type StriartEvent = { message?: string } & (
  | {
      type: 'task:queued';
      agent: string;
      taskId: string;
      collisions: Collision[];
      after?: string | null;
    }
  | { type: 'task:started'; agent: string; taskId: string; branch: string }
  | { type: 'router:semantic-link'; agent: string; other: string }
  | { type: 'router:workspace-link'; agent: string; other: string }
  | { type: 'session:failed'; agent: string; status: 'FAILED' | 'TIMEOUT'; logPath: string }
  | { type: 'session:empty'; agent: string }
  | { type: 'merge:unmergeable'; agent: string; ticketId: string }
  | { type: 'merge:conflict-ticket'; agent: string; ticketId: string; files: string[] }
  | { type: 'merge:semantic-failed'; agent: string; ticketId: string; files: string[] }
  | { type: 'merge:gate-red'; agent: string; ticketId: string; exitCode: number | null }
  | { type: 'merge:rename-hazard'; agent: string; source: string; ours: string; theirs: string }
  | { type: 'merge:manual-mode' }
  | { type: 'sync:rebase-conflict'; agent: string }
  | { type: 'sync:stash-conflict'; agent: string }
  | { type: 'sync:overlap'; agent: string; files: string[] }
  | { type: 'rollback:done'; agent: string; sha: string; pushed: boolean }
  | { type: 'promote:done'; sha: string; commits: number }
  | { type: 'promote:gate-red'; ticketId: string; rolledBack: boolean }
);

/** Issue d'une session autonome supervisée par Striart. */
export interface SessionResult {
  /**
   *  - 'COMPLETED' : sortie 0.
   *  - 'FAILED'    : sortie non nulle (y compris binaire introuvable — execa
   *                  ne permet pas de l'isoler de façon portable ; `error`
   *                  porte le détail).
   *  - 'TIMEOUT'   : délai dépassé, arbre de process tué.
   */
  status: 'COMPLETED' | 'FAILED' | 'TIMEOUT';
  agent: string;
  exitCode: number | null;
  durationMs: number;
  timedOut: boolean;
  /** Log de session, sous .striart/logs/ — survit à la suppression du clone. */
  logPath: string;
  command: string;
  /**
   * Sessions ACP uniquement : `stopReason` du protocole ('end_turn',
   * 'refusal', 'cancelled'…). C'est lui qui décide du statut — le code de
   * sortie de l'adaptateur n'est qu'informatif. Absent en transport argv.
   */
  stopReason?: string | null;
  error: string | null;
}

/** Résultat de syncAgentWithMain — union discriminée sur `status`. */
export type SyncResult =
  | { status: 'UP_TO_DATE'; agent: string; mainHead: string }
  | { status: 'REBASED'; agent: string; mainHead: string; rebasedCommits: number; stashed: boolean }
  | { status: 'SKIPPED_DIRTY'; agent: string; files: string[]; overlap?: string[] }
  /** Session autonome en cours dans le clone : rebase ajourné à sa fin de cycle. */
  | { status: 'SKIPPED_SESSION'; agent: string; pid: number | null }
  | {
      status: 'REBASE_CONFLICT';
      agent: string;
      mainHead: string;
      error: string;
      stashKept?: boolean;
    }
  | { status: 'STASH_CONFLICT'; agent: string; mainHead: string; error: string };

/**
 * Double-renommage probable non détecté par git (merge propre) : `source` a
 * été supprimé des deux côtés et son contenu réapparaît sous deux noms.
 */
export interface RenameHazard {
  source: string;
  /** Héritier côté branche cible (main). */
  ours: string;
  /** Héritier côté agent. */
  theirs: string;
}

export interface GateResult {
  /** Règle d'or n°2 : jamais de commit si false. */
  success: boolean;
  exitCode: number | undefined;
  timedOut: boolean;
  log: string;
}

export type TicketReason =
  | 'MERGE_CONFLICT'
  | 'UNMERGEABLE_CONFLICT'
  | 'GATE_FAILED'
  | 'SEMANTIC_MERGE_FAILED'
  | 'SEMANTIC_GATE_FAILED'
  | 'PROMOTION_GATE_FAILED';

/** Modes Git des stages 1/2/3 d'un fichier en conflit (`git ls-files -u`). */
export interface StageModes {
  base?: string;
  ours?: string;
  theirs?: string;
}

/**
 * Classification d'un conflit avant fusion sémantique (classifyConflict).
 * Seul 'text' part au LLM ; le reste va directement en ticket humain.
 */
export type ConflictClass =
  | { kind: 'text' }
  | { kind: 'delete'; deletedBy: 'ours' | 'theirs' }
  | { kind: 'path' }
  | { kind: 'binary' }
  | { kind: 'lockfile' }
  | { kind: 'oversized'; chars: number }
  | { kind: 'submodule' }
  | { kind: 'symlink' }
  | { kind: 'mode'; ours: string; theirs: string }
  | { kind: 'opaque' };

export interface Ticket {
  id: string;
  agent: string;
  branch: string;
  sha: string;
  reason: TicketReason;
  conflictedFiles: string[];
  /** Conflits hors de portée du Merger, avec leur nature (UNMERGEABLE_CONFLICT). */
  unmergeable?: Array<{ path: string } & ConflictClass>;
  prompt: string | null;
  createdAt: string;
  dir: string;
  resolved?: boolean;
}

export interface Collision {
  agent: string;
  files: string[];
}

export interface QueueTask {
  id: string;
  status: 'WAITING';
  agent: string;
  prompt: string;
  predictedFiles: string[];
  collisions: Collision[];
  command: string | null;
  /**
   * Dépendance déclarée (id de tâche en file ou nom d'agent) : la tâche ne
   * démarre pas tant que ce travail est actif. Absent/null = aucune.
   */
  after?: string | null;
  /** Au dégagement de la file : réhabiliter l'archive au lieu de cloner. */
  reuse?: boolean;
  /**
   * Motif d'ajournement posé EN MÉMOIRE par retryQueue (ex: REUSE_DIRTY),
   * jamais persisté dans queue.json.
   */
  blockedReason?: string;
  createdAt: string;
}

/** Résultat de mergeAgentCommit — union discriminée sur `status`. */
export type MergeResult =
  | { status: 'UP_TO_DATE'; agent: string; sha: string; rebase: SyncResult | null }
  | {
      status: 'MERGED';
      agent: string;
      sha: string;
      gate: GateResult;
      pushError: string | null;
      semantic: boolean;
      resolvedFiles: string[];
      /** Retentatives du Merger après un gate rouge (0 = fusion passée du premier coup). */
      gateRetries: number;
      /** Doubles-renommages probables non détectés par git (avertissement). */
      renameHazards: RenameHazard[];
      /** Memory Layer : null si désactivé, sinon issue de la génération (advisory). */
      memory: { updated: boolean; entry?: string; error?: string } | null;
      rebase: SyncResult | null;
    }
  | {
      status: 'CONFLICT';
      reason: 'MERGE_CONFLICT' | 'UNMERGEABLE_CONFLICT' | 'SEMANTIC_MERGE_FAILED';
      agent: string;
      sha: string;
      conflictedFiles: string[];
      /** Présent quand reason === 'UNMERGEABLE_CONFLICT'. */
      unmergeable?: Array<{ path: string } & ConflictClass>;
      ticket: Ticket;
      manualMode: boolean;
      error?: string;
      rebase: SyncResult | null;
    }
  | {
      status: 'GATE_FAILED';
      agent: string;
      sha: string;
      gate: GateResult;
      ticket: Ticket;
      semantic: boolean;
      manualMode: boolean;
      rebase: SyncResult | null;
    };

/**
 * Issue d'un cycle autonome complet : session → merge → Test Gate → nettoyage.
 *
 * `cleaned` n'est vrai que sur le chemin entièrement vert. Tout autre chemin
 * conserve le clone : c'est le seul matériel de diagnostic, et le supprimer
 * détruirait du travail que personne n'a relu.
 */
export interface AutonomousResult {
  /**
   *  - 'QUEUED'         : collision Router, aucune session lancée.
   *  - 'MERGED'         : session OK, merge OK, gate vert → clone supprimé.
   *  - 'EMPTY'          : session sortie en 0 sans aucun commit.
   *  - 'SESSION_FAILED' : sortie non nulle, délai dépassé ou lancement impossible.
   *  - 'MERGE_BLOCKED'  : commits présents mais merge en conflit ou gate rouge.
   */
  status: 'QUEUED' | 'MERGED' | 'EMPTY' | 'SESSION_FAILED' | 'MERGE_BLOCKED';
  agent: string;
  session: SessionResult | null;
  merge: MergeResult | null;
  cleaned: boolean;
  /** Renseigné dès que le clone est conservé : pourquoi il l'est. */
  keptReason: string | null;
  clonePath: string | null;
  task?: QueueTask;
}

/**
 * Lien sémantique entre deux agents via le graphe d'imports :
 * `importedBy` importe `file`. Advisory — jamais bloquant.
 */
export interface SemanticWarning {
  agent: string;
  links: Array<{ file: string; importedBy: string }>;
}

/**
 * Lien inter-packages d'un monorepo entre deux agents :
 * `mine` dépend de `theirs` (depends-on) ou l'inverse (dependency-of).
 */
export interface WorkspaceWarning {
  agent: string;
  links: Array<{ mine: string; theirs: string; direction: 'depends-on' | 'dependency-of' }>;
}

/**
 * Une tâche déclarée dans un plan « tâches-as-code » (src/plan.js).
 * `id` est un alias LOCAL au plan (cible d'un `after`), résolu en nom d'agent
 * réel au moment de l'application.
 */
export interface PlanTask {
  id: string | null;
  agent: string | null;
  prompt: string;
  autonomous: boolean;
  profile: string | null;
  command: string | null;
  timeout: number | null;
  /** Dépendance : id de plan (défini plus haut) OU agent/tâche déjà vivant. */
  after: string | null;
}

/** Un plan « tâches-as-code » validé (src/plan.ts). */
export interface StriartPlan {
  version: 1;
  tasks: PlanTask[];
}

/** Résultat de runTask. */
export type RunResult =
  | {
      status: 'STARTED';
      info: AgentMeta & { name: string };
      predictedFiles: string[];
      collisions: [];
      semanticWarnings: SemanticWarning[];
      workspaceWarnings: WorkspaceWarning[];
    }
  | { status: 'QUEUED'; task: QueueTask; predictedFiles: string[]; collisions: Collision[] };

/** Résultat de rollbackLastMerge. */
export interface RollbackResult {
  status: 'ROLLED_BACK';
  /** reset = merge local défait ; revert = historique publié conservé. */
  mode: 'reset' | 'revert';
  agent: string;
  undoneSha: string;
  newHead: string;
  /** lastMergedCommit de l'agent recalé (mode reset, agent encore actif). */
  agentResynced: boolean;
}

/** Résultat de promoteStaging — union discriminée sur `status`. */
export type PromoteResult =
  | { status: 'UP_TO_DATE'; sha: string }
  | { status: 'PROMOTED'; sha: string; commits: number; gate: GateResult; pushError: string | null }
  | { status: 'GATE_FAILED'; sha: string; gate: GateResult; ticket: Ticket; rolledBack: boolean };

export interface StriartState {
  semanticFailureStreak: number;
  manualMode: boolean;
}

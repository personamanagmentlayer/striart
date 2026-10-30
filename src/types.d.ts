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
  /**
   * Livraison vers `origin` (exige autoPush) : 'push' = SHA testé vers la branche
   * cible ; 'branch' = vers `striart/<agent>/<tâche>`, la forge reste l'autorité
   * d'approbation. Toujours hors verrou, jamais forcée.
   */
  delivery: 'push' | 'branch';
  /** Délai dur du push (ms) ; au-delà : arbre de process tué, PUSH_TIMEOUT. */
  pushTimeoutMs: number;
  /** Délai dur du commit de merge (hooks de la cible, signature) ; au-delà : COMMIT_HOOK_REJECTED. */
  commitTimeoutMs: number;
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
  /** Consignes Striart remises aux agents (gabarit, canaux, AGENTS.md — lot I5). */
  agentInstructions: AgentInstructionsConfig;
  /** Registre ACP pour `striart profiles --import-acp` (métadonnées seules par défaut). */
  acpRegistry: AcpRegistryConfig;
  /** Clone partiel des agents (ex: 'blob:none') — null = clone local complet hardlinké. */
  cloneFilter: string | null;
  /** Rétention de striart prune (jours d'inactivité avant suppression). */
  pruneDays: number;
  /** Taille (octets) au-delà de laquelle un journal long tourne (log-rotation.js). */
  logMaxBytes: number;
  /** Générations conservées par journal tourné (`<nom>.log.1` … `.log.N`). */
  logGenerations: number;
  webhookUrl: string | null;
  /** Table multi-canaux de notification — s'ajoute à webhookUrl. */
  notifiers: NotifierSpec[];
  dashboardPort: number;
  /**
   * Hôtes (en-tête Host) admis EN PLUS de la boucle locale : nom exact ou
   * joker en tête de sous-domaine (`*.app.github.dev`), port facultatif. [] =
   * strict. Ne relâche que le contrôle Host.
   */
  dashboardAllowedHosts: string[];
  /**
   * Nom sous lequel le dashboard est servi. 'instance' (défaut) :
   * `<id-aléatoire>.localhost`, le cookie de session n'est jamais envoyé aux
   * autres serveurs localhost:*. 'localhost' : repli (navigateur sans
   * résolution de *.localhost), risque documenté, affiché par doctor.
   */
  dashboardHostname: 'instance' | 'localhost';
  /** Durée de vie d'un lien de connexion au dashboard (usage unique), en ms. */
  dashboardLinkTtlMs: number;
  /** Durée d'une session navigateur du dashboard, en ms. */
  dashboardSessionTtlMs: number;
  /** Octets en attente au-delà desquels un abonné du flux d'état est jugé lent. */
  controlSseMaxBufferedBytes: number;
  /** Délai maximal entre un changement d'état et sa notification, en ms. */
  controlStateMaxDelayMs: number;
  /** Promotion staging → main (null = désactivée). */
  mainBranch: string | null;
  /** Gate global de promotion (null → testCommand). */
  promoteTestCommand: string | null;
  testTimeoutMs: number;
  /** Délai de grâce des descendants du Test Gate (ms) ; au-delà : orphelin, gate rouge. */
  gateOrphanGraceMs: number;
  /** Plafond du journal du Test Gate conservé (octets) ; la fin de la sortie est gardée. */
  gateMaxOutputBytes: number;
  /** 'native' : conteneur de process natif ; 'process' : relâchement explicite (sans détection d'orphelins). */
  gateContainer: 'native' | 'process';
  /**
   * Environnement du Test Gate : null = liste blanche minimale sans clé d'API ni
   * webhook ; tableau de noms/motifs = variables DEMANDÉES en plus (valables si
   * la config utilisateur `gate.envAllow` les autorise) ; 'inherit' = tout
   * l'environnement (relâchement explicite).
   */
  gateEnv: null | 'inherit' | string[];
  /** Données locales de `.striart/` réservées à l'utilisateur (false = relâchement explicite). */
  privateStateDir: boolean;
  fetchIntervalMs: number;
  ollamaModel: string;
  ollamaHost: string;
  /**
   * Prompts LLM surchargeables intégralement (null → défaut dans le module).
   * Placeholders obligatoires, validés au chargement (PROMPT_PLACEHOLDERS) :
   * router {{task}}+{{files}} ; merger {{file}}+{{base}}+{{ours}}+{{theirs}}+{{feedback}}.
   */
  prompts: { router: string | null; merger: string | null };
  /**
   * Lanceur de terminal de `--open` — valeur partielle acceptée, complétée
   * par `resolveTerminalSettings` (src/terminal/config.ts).
   */
  terminal: Partial<Omit<import('./terminal/config.ts').TerminalSettings, 'warp'>> & {
    warp?: Partial<import('./terminal/config.ts').WarpSettings>;
  };
  /** Hooks advisory des outils de coding (src/hooks/config.ts), valeur partielle acceptée. */
  hooks: Partial<import('./hooks/config.ts').HookSettings>;
  /**
   * Verrou principal. `breakFrozenHolderAfterMs` : null = un détenteur vivant
   * figé n'est jamais cassé ; sinon délai (ms, ≥ 60 000) au-delà duquel il l'est.
   */
  lock: { breakFrozenHolderAfterMs: number | null };
  /**
   * Hôte de pty natif (`striart-native pty-host`) : rejeu à l'attache,
   * seuil d'éviction d'un client lent, délai de grâce du shell à l'arrêt.
   * Complété par clé des défauts (resolvePtyHostSettings).
   * `shell` : 'auto' (défaut : PowerShell sous Windows, $SHELL/bash ailleurs),
   * un nom nu (résolu dans les dossiers absolus du PATH) ou un chemin absolu ;
   * `shellArgs` : arguments de ce shell (argv, jamais un shell).
   */
  pty: {
    replayBytes?: number;
    clientQueueBytes?: number;
    killGraceMs?: number;
    shell?: string;
    shellArgs?: string[];
  };
  /**
   * Chemins protégés (src/protected-paths.ts) : tout changement par un agent
   * refuse le merge et ouvre un ticket PROTECTED_PATHS_CHANGED. `extend`
   * ajoute des motifs ; seul `allow` en retire (relâchement journalisé à
   * chaque merge et affiché par doctor) ; `matchCase: 'platform'` rend la
   * comparaison sensible à la casse hors Windows/macOS (relâchement aussi).
   */
  protectedAgentPaths: ProtectedAgentPathsConfig;
  /** Contrat de commit des sessions autonomes (surchargeable par profil). */
  commitPolicy: CommitPolicy;
  /** Gabarit du message d'un commit Striart (COMMIT_MESSAGE_PLACEHOLDERS). */
  commitMessage: string;
  /**
   * Serveur MCP. Objet PARTIEL côté utilisateur (fusionné avec les défauts
   * par `resolveMcpSettings`, src/mcp/settings.ts — loadConfig ne fusionne
   * qu'en surface).
   */
  mcp?: Partial<McpSettings>;
  /** Modes d'orchestration (lot O) — objet PARTIEL, fusionné par resolveOrchestrationSettings. */
  orchestration?: Partial<OrchestrationSettings>;
  /**
   * Proxy ACP `striart acp` (lot I10) — objet PARTIEL, complété par
   * `resolveAcpAgentSettings` (src/acp-agent/settings.ts).
   */
  acpAgent?: Partial<import('./acp-agent/settings.ts').AcpAgentSettings>;
  /** Canal de collaboration (lot O) — objet PARTIEL, fusionné par resolveCollabSettings. */
  collab?: Partial<CollabSettings>;
  /** LLM par rôle (lot O) — objet partiel, chaque rôle absent/null replie sur `llm`. */
  llmRoles?: Partial<LlmRoles>;
  /** Économie et comptabilité des tokens (lot T) — objet PARTIEL, fusionné par resolveTokensSettings. */
  tokens?: import('./tokens/settings.ts').TokensConfigInput;
  /** Résilience des appels LLM (backoff, disjoncteur) — objet PARTIEL, fusionné par resolveLlmResilience. */
  llmResilience?: import('./llm-resilience.ts').LlmResilienceInput;
  /** Filet à l'exécution (chevauchement observé, rattrapage) — objet PARTIEL, fusionné par resolveOverlapSettings. */
  overlap?: import('./overlap.ts').OverlapSettingsInput;
  /** GC d'agents et de sessions inactifs (src/idle/) — objet PARTIEL, fusionné par resolveIdleSettings. */
  idle?: import('./idle/settings.ts').IdleSettingsInput;
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
  /**
   * PID du process qui SUPERVISE la session autonome (argv) : celui qui tient le handle de l'agent.
   * Publié avec `sessionPid` (qui désigne l'agent) ; le GC d'inactivité lui adresse la demande de
   * fermeture propre. Absent = session non supervisée identifiable (jamais fermée par kill).
   */
  sessionOwnerPid?: number | null;
  /**
   * Fin de session autonome EN ÉCHEC (écrit par `concludeAutonomousSession`, effacé par une fin
   * réussie). Preuve, avec `hasCommits: false`, que le clone conservé n'a rien à merger : la
   * sentinelle WHOLE_REPO du Router ne l'attend plus (voir session-failure.ts). Absent = aucune.
   */
  sessionFailure?: {
    status: string;
    at: string;
    hasCommits: boolean;
    sessionStartedAt: string | null;
  } | null;
  /**
   * Suppression du clone entamée (`removeClone`, clone.js) et pas encore
   * terminée : le `rm` a échoué ou a été interrompu. La réconciliation la
   * termine (`resumeCloneRemovals`). Absent = pas de suppression en cours.
   */
  removing?: boolean;
  removingSince?: string;
  /** Collaboration orchestrée portée par ce clone (lot O) — absent hors mode orchestré. */
  collab?: AgentCollabInfo | null;
  /** Détail du Router au lancement (informatif, additif) — voir src/router-details.ts. */
  routing?: import('./router-details.ts').PublicRouterDetails | null;
}

export type AgentRegistry = Record<string, AgentMeta>;

/**
 * Options d'un profil ACP (`agentProfiles.<nom>.acp`), validées par
 * `acpOptionsProblem` (src/acp/protocol.ts) — défauts sûrs :
 *  - `permissions` ('allow') / `askTimeoutMs` (120 000) : politique de
 *    permission ; 'ask' = semi-autonome, arbitrage humain, fail closed ;
 *  - `auth.methodId` : SEULE voie vers `authenticate` (décision explicite) —
 *    sans elle, un agent non connecté échoue en ACP_AUTH_REQUIRED ;
 *  - `persistentHost` (true) : session portée par un hôte détaché,
 *    adressable par le bus `@agent` de `watch --ui` (Phase E) ;
 *  - `bus` (true) : l'hôte accepte les messages humains du bus ;
 *  - `terminal` (activé ; timeoutMs 600 000, outputByteLimit 1 000 000,
 *    maxTerminals 8) : capacité terminal bornée au clone, `false` la retire ;
 *  - `fsReadMaxBytes` (4 194 304) : taille maximale d'un fichier servi à
 *    `fs/read_text_file` ; au-delà, la lecture est refusée (jamais tronquée en
 *    silence) ;
 *  - `mcp` ('striart') : serveur MCP Striart en lecture seule borné au clone
 *    transmis à `session/new` ; 'none' n'en transmet aucun ;
 *  - `elicitation` ({ form: true, url: false } — politique 'ask' seulement) :
 *    modes de questions structurées routées vers l'humain.
 */
export interface AcpProfileOptions {
  permissions?: 'allow' | 'reject' | 'ask';
  askTimeoutMs?: number;
  auth?: { methodId: string };
  persistentHost?: boolean;
  bus?: boolean;
  terminal?: boolean | { timeoutMs?: number; outputByteLimit?: number; maxTerminals?: number };
  fsReadMaxBytes?: number;
  mcp?: 'striart' | 'none';
  elicitation?: { form?: boolean; url?: boolean };
}

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
  acp?: boolean | AcpProfileOptions;
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
  /**
   * Preset du catalogue (src/agents/catalog.ts) dont ce profil dérive. En
   * config, `{ preset: 'claude-code', commitPolicy: 'human' }` suffit : le
   * profil est matérialisé au chargement, les champs donnés l'emportent.
   */
  preset?: string;
  /** Preset non vérifiable en documentation officielle : à utiliser en connaissance de cause. */
  experimental?: boolean;
  /** Ce que l'outil peut écrire, tel que l'invocation le configure (déclaratif, affiché). */
  writeMode?: AgentWriteMode;
  /** Qui commite : l'agent lui-même ('agent'), ou personne — revue humaine ('human'). */
  commitPolicy?: AgentCommitPolicy;
  /** Format de la sortie structurée de l'outil, transcrite dans le log de session. */
  structuredOutput?: StructuredOutputFormat;
  /** Canal et gabarit des consignes Striart pour ce profil. */
  instructions?: AgentInstructionsSpec;
  /**
   * Fichier de réglages de SESSION écrit par Striart hors du clone
   * (.striart/logs/) et passé à l'outil par `flag` (ex. Claude Code
   * `--settings`, Aider `--config`). `claudeMdExcludes: true` y ajoute les
   * CLAUDE.md du worktree principal (dossiers parents du clone) à exclure.
   */
  settingsFile?: { flag: string; json: Record<string, unknown>; claudeMdExcludes?: boolean };
  /**
   * Auteur des commits Striart de ce profil (commitPolicy 'agent-then-striart'
   * ou 'striart'). Défaut dérivé de la clé du profil :
   * `<clé> (Striart agent) <<clé>.agent@striart.invalid>`. Le committer reste
   * l'identité git de l'utilisateur (lue dans le repo principal).
   */
  commitAuthor?: { name?: string; email?: string };
  /** Gabarit du message de commit Striart propre à ce profil (prime sur `config.commitMessage`). */
  commitMessage?: string;
}

/** Portée d'écriture configurée par l'invocation d'un outil. */
export type AgentWriteMode = 'workspace' | 'read-only' | 'unrestricted';

/**
 * Contrat de commit d'une session (global `config.commitPolicy`, surchargeable
 * par profil) :
 *  - 'agent'              : l'agent committe lui-même (défaut historique) ;
 *  - 'agent-then-striart' : l'agent committe ; s'il n'a rien committé, Striart
 *                           committe ce qu'il a laissé ;
 *  - 'striart'            : Striart committe toujours le reste non committé ;
 *  - 'human'              : personne ne committe — revue humaine, clone conservé.
 * Commit Striart seulement après une session COMPLETED, jamais d'un fichier
 * exclu (secretPatterns, fichiers injectés exclus via .git/info/exclude).
 */
export type CommitPolicy = 'agent' | 'agent-then-striart' | 'striart' | 'human';
/** Alias historique (lot I4). */
export type AgentCommitPolicy = CommitPolicy;

export interface ProtectedAgentPathsConfig {
  extend?: string[];
  allow?: string[];
  matchCase?: 'insensitive' | 'platform';
}

/** Changement d'un chemin protégé par l'agent (garde I2, src/protected-paths.ts). */
export interface ProtectedPathChange {
  path: string;
  /** Statut git côté agent (A ajouté, M modifié, D supprimé, T type changé). */
  status: string;
  /** Motif qui protège ce chemin (`package.json#striart,cosmiconfig` pour une clé de manifeste). */
  pattern: string;
  kind: 'instructions' | 'agent-config' | 'striart-config';
}

/** Commit fait par Striart en fin de session autonome (contrat de commit). */
export interface StriartCommitResult {
  policy: CommitPolicy;
  /**
   *  - 'COMMITTED'               : Striart a committé `files` ;
   *  - 'NOTHING_TO_COMMIT'       : rien de committable (voir `excluded`) ;
   *  - 'SKIPPED_AGENT_COMMITTED' : agent-then-striart, l'agent a committé lui-même.
   */
  status: 'COMMITTED' | 'NOTHING_TO_COMMIT' | 'SKIPPED_AGENT_COMMITTED';
  sha: string | null;
  files: string[];
  /** Laissés hors du commit : secrets (secretPatterns) et fichiers injectés par Striart. */
  excluded: { secrets: string[]; injected: string[] };
  author: { name: string; email: string } | null;
  committer: { name: string; email: string } | null;
}

/** Formats de sortie structurée connus (transcription du log de session argv). */
export type StructuredOutputFormat =
  'none' | 'claude-stream-json' | 'codex-jsonl' | 'gemini-stream-json' | 'ndjson';

/**
 * Canal des consignes d'un profil autonome :
 *  - 'auto' : 'acp-prompt' pour un profil ACP, 'system-prompt-file' si `flag`
 *    est déclaré, 'prompt' sinon ;
 *  - 'acp-prompt' : bloc en tête du prompt ACP ;
 *  - 'system-prompt-file' : fichier sous .striart/logs/ (hors clone) passé
 *    par `flag` ou par l'argument `{{striartInstructionsFile}}` ;
 *  - 'prompt' : argument `{{striartInstructions}}`, sinon enveloppe du prompt ;
 *  - 'none' : aucune consigne pour ce profil.
 */
export type InstructionsChannel = 'auto' | 'acp-prompt' | 'system-prompt-file' | 'prompt' | 'none';

export interface AgentInstructionsSpec {
  channel?: InstructionsChannel;
  /** Gabarit propre au profil (placeholders de INSTRUCTION_PLACEHOLDERS). */
  template?: string | null;
  /** Texte ajouté à la fin des consignes pour ce profil. */
  append?: string | null;
  /** Drapeau de l'outil qui reçoit le chemin du fichier de consignes. */
  flag?: string | null;
  /**
   * Encodage du texte dans l'emplacement `{{striartInstructions}}` :
   * 'raw' (défaut) ou 'toml-string' (chaîne TOML entre guillemets, pour un
   * `-c clé=valeur` de Codex).
   */
  encoding?: 'raw' | 'toml-string';
}

export interface AgentInstructionsConfig {
  /** false → aucune consigne, sur aucun canal. */
  enabled: boolean;
  /** Gabarit complet (null → gabarit par défaut, src/agents/instructions.ts). */
  template: string | null;
  /** Texte ajouté à la fin des consignes de tous les profils. */
  append: string | null;
  /** Convention de message de commit citée aux agents. */
  commitConvention: string;
  /**
   * D11 — dépôt avec un AGENTS.md racine suivi : 'override' (défaut) écrit un
   * AGENTS.override.md composite (AGENTS.md du commit + bloc Striart) pour les
   * outils qui le lisent ; 'non-file' n'écrit rien à côté et avertit.
   */
  agentsMd: 'override' | 'non-file';
  /** Fichiers candidats par outil (id de preset ou nom de commande), relatifs au clone. */
  attendedFiles: Record<string, string[]>;
  /** Candidats pour un outil absent du catalogue. */
  genericFiles: string[];
  /** Exclure les CLAUDE.md du worktree principal (dossiers parents du clone). */
  neutralizeParentInstructions: boolean;
}

export interface AcpRegistryConfig {
  /** URL https du registre ACP (JSON). */
  url: string;
  /**
   * Autoriser `--import-acp` à TÉLÉCHARGER une distribution binaire (épinglée,
   * empreinte vérifiée). false par défaut : métadonnées seules.
   */
  allowBinaryDownload: boolean;
  /**
   * Noms de variables d'environnement qu'un agent du registre PEUT poser dans
   * son profil à l'import. Vide par défaut : toute variable fournie par le
   * registre est refusée (`ACP_IMPORT_ENV_FORBIDDEN`) — un registre compromis
   * ne doit pas pouvoir injecter de l'environnement dans le process lancé.
   * Les variables d'interpréteur/chargeur (NODE_OPTIONS, PATH, LD_*…) sont
   * refusées même listées ici.
   */
  allowEnv?: string[];
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
  | {
      type: 'task:serialization-relaxed';
      agent: string;
      taskId: string | null;
      relaxedBlockers: RelaxedBlocker[];
    }
  | { type: 'router:semantic-link'; agent: string; other: string }
  | { type: 'router:workspace-link'; agent: string; other: string }
  /**
   * Filet à l'exécution (src/overlap.ts) : deux agents (`agents`) ou un agent et la
   * branche cible (`target`) ont RÉELLEMENT modifié les mêmes fichiers, hors prédiction du
   * Router. `files` : les 10 premiers ; `fileCount` : le total.
   */
  | {
      type: 'overlap:observed';
      kind: 'agents' | 'target';
      agents: string[];
      files: string[];
      fileCount: number;
    }
  /** Rebase anticipé tenté (ou refusé) pour un agent dont la cible a avancé sur ses fichiers. */
  | { type: 'overlap:catch-up'; agent: string; status: string }
  /**
   * GC d'inactivité (src/idle/) : un agent a franchi `idle.warnAfterMs` sans aucun signal d'activité
   * (rapport seulement, l'événement n'est émis qu'une fois par période d'inactivité).
   */
  | {
      type: 'idle:detected';
      agent: string;
      idleMs: number;
      session: 'live' | 'ended' | 'none';
      host: 'acp' | 'pty' | 'process' | 'none';
    }
  /** Avertissement avant fermeture : la session de `agent` sera fermable à `closeNotBefore` (ISO) sans activité. */
  | {
      type: 'idle:warned';
      agent: string;
      idleMs: number;
      closeNotBefore: string | null;
      willClose: boolean;
    }
  /** Session fermée proprement (`CLOSED`) ou en cours de fermeture (`CLOSING`) ; le clone et son travail sont conservés. */
  | { type: 'idle:closed'; agent: string; host: 'acp' | 'pty' | 'process'; code: string }
  /** Fermeture REFUSÉE par une garde (code IDLE_CLOSE_*) : la session reste vivante, intacte. */
  | {
      type: 'idle:close-refused';
      agent: string;
      host: 'acp' | 'pty' | 'process';
      code: string;
      detail: string | null;
    }
  /**
   * La liste de fichiers soumise au Router a été coupée (`tokens.router.tree.maxFiles`) :
   * `kept` fichiers lus sur `total` suivis par git. `policy` : ce que le Router en a fait
   * ('serialize' : sentinelle « tout le dépôt », aucun appel LLM ; 'predict' : prédiction
   * sur la vue partielle).
   */
  | {
      type: 'router:tree-truncated';
      agent: string;
      kept: number;
      total: number;
      policy: 'serialize' | 'predict';
    }
  | {
      type: 'session:failed';
      agent: string;
      status: 'FAILED' | 'TIMEOUT' | 'CANCELLED' | 'BUDGET_EXCEEDED';
      logPath: string;
    }
  | { type: 'session:empty'; agent: string }
  /** Cycle réussi dont le commit était déjà dans la cible : rien mergé, Test Gate non rejoué. */
  | { type: 'session:already-integrated'; agent: string; sha: string }
  /** Fin d'une session SUPERVISÉE signalée par le hook de l'outil (`striart hook`). */
  | { type: 'session:ended'; agent: string; tool: string; reason: string | null }
  | { type: 'session:striart-commit'; agent: string; sha: string; files: number }
  | {
      type: 'merge:protected-paths';
      agent: string;
      ticketId: string;
      files: string[];
    }
  | { type: 'merge:unmergeable'; agent: string; ticketId: string }
  | { type: 'merge:conflict-ticket'; agent: string; ticketId: string; files: string[] }
  | { type: 'merge:semantic-failed'; agent: string; ticketId: string; files: string[] }
  | { type: 'merge:gate-red'; agent: string; ticketId: string; exitCode: number | null }
  | { type: 'merge:rename-hazard'; agent: string; source: string; ours: string; theirs: string }
  | { type: 'merge:commit-rejected'; agent: string; ticketId: string | null; timedOut: boolean }
  | { type: 'delivery:failed'; sha: string; ref: string | null; code: string }
  /**
   * Un appelant a dû ATTENDRE le verrou principal (L8). Mesure pure : le bus informe, il ne décide
   * jamais. Aucun contenu, aucun chemin, aucun identifiant d'agent ou de ticket : seulement le
   * VERBE de l'opération (`merge`, `resolve-apply`…) — le nom d'un agent peut dériver d'un prompt.
   */
  | {
      type: 'lock:contention';
      /** Opération en attente (verbe seul). */
      operation: string;
      /** Durée d'attente jusqu'à l'acquisition (horloge monotone). */
      waitedMs: number;
      /** Opération détentrice au moment de l'arrivée, et depuis combien de temps (null : inconnue). */
      holder: { operation: string | null; ageMs: number | null } | null;
      /** Opérations en file à l'arrivée, la nôtre comprise. */
      queued: number;
    }
  | { type: 'delivery:branch'; sha: string; ref: string }
  | { type: 'merge:manual-mode' }
  | { type: 'merge:manual-resolution'; agent: string; ticketId: string; files: string[] }
  | { type: 'sync:rebase-conflict'; agent: string }
  | { type: 'sync:stash-conflict'; agent: string }
  | { type: 'sync:overlap'; agent: string; files: string[] }
  | { type: 'rollback:done'; agent: string; sha: string; pushed: boolean }
  | { type: 'promote:done'; sha: string; commits: number }
  | { type: 'promote:gate-red'; ticketId: string; rolledBack: boolean }
  /** Lot O : départ/fin d'un nœud de plan v2. */
  | {
      type: 'orchestration:node';
      runId: string;
      nodeId: string | null;
      kind: PlanNodeKind;
      phase: 'started' | 'finished';
      status: OrchestrationStatus | null;
      agent: string | null;
    }
  /** Lot O : tour de parole d'un rôle dans un clone partagé. */
  | {
      type: 'collab:turn';
      group: string;
      agent: string;
      role: string;
      round: number;
      phase: 'started' | 'finished';
      status: string | null;
    }
  /** Lot O : message accepté sur le canal (jamais son corps : non fiable). */
  | {
      type: 'collab:message';
      group: string;
      from: string;
      to: string;
      kind: CollabMessageKind;
      seq: number;
    }
  | {
      type: 'review:verdict';
      group: string;
      agent: string;
      reviewer: string;
      round: number;
      verdict: ReviewVerdictValue | 'invalid';
    }
  | { type: 'review:human-pending'; group: string; agent: string; reviewId: string }
  | { type: 'race:winner'; group: string; agent: string | null; candidates: string[] }
  /**
   * Lot T : seuil d'alerte (level 'warn') ou plafond franchi (level 'exceeded')
   * d'un budget de tokens/coût. Informatif : le refus effectif est une erreur
   * TOKEN_BUDGET_EXCEEDED / un statut de session BUDGET_EXCEEDED, jamais ce bus.
   */
  | {
      type: 'tokens:alert';
      level: 'warn' | 'exceeded';
      scope: BudgetScope;
      metric: BudgetBreach['metric'];
      used: number;
      limit: number;
      role: UsageRole | null;
      agent: string | null;
      taskId: string | null;
    }
);

/** Issue d'une session autonome supervisée par Striart. */
export interface SessionResult {
  /**
   *  - 'COMPLETED' : sortie 0.
   *  - 'FAILED'    : sortie non nulle (y compris binaire introuvable — execa
   *                  ne permet pas de l'isoler de façon portable ; `error`
   *                  porte le détail).
   *  - 'TIMEOUT'   : délai dépassé, arbre de process tué.
   *  - 'CANCELLED' : arrêt demandé par l'appelant (Ctrl+C, SIGTERM — signal
   *                  d'annulation), arbre de process tué. Jamais un succès.
   *  - 'BUDGET_EXCEEDED' : plafond de tokens/coût atteint (config `tokens.budgets`),
   *                  arbre de process tué. Jamais un succès : le travail interrompu
   *                  n'est pas mergé, le clone est conservé (keptDetail = statut).
   *                  `usage` porte le relevé, `budget` le plafond franchi.
   */
  status: 'COMPLETED' | 'FAILED' | 'TIMEOUT' | 'CANCELLED' | 'BUDGET_EXCEEDED';
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
  /** Relevé d'usage de la session (lot T) — absent quand la comptabilité est désactivée. */
  usage?: SessionUsageSummary;
  /** Plafond franchi (statut BUDGET_EXCEEDED seulement). */
  budget?: BudgetBreach;
  /**
   * Sessions ACP : nombre de tours joués (le prompt de tâche, puis chaque
   * message humain du bus `@agent` — Phase E). Absent en transport argv.
   */
  turns?: number;
  /**
   * Cause NOMMÉE d'un échec quand elle est connue (ACP_AUTH_REQUIRED,
   * ACP_AUTH_METHOD_UNAVAILABLE, ACP_HOST_LOST…), null sinon. `error` reste
   * le message lisible.
   */
  errorCode?: string | null;
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
  /**
   * Raison stable d'un rouge qui n'est pas un échec de test : l'exécution
   * elle-même est en cause (fail closed). Absent pour un vert ou un rouge
   * ordinaire (code de sortie non nul, délai).
   */
  code?: GateFailureCode;
  /** Descendants encore vivants après la sortie du test et le délai de grâce (tués). */
  orphanPids?: number[];
  /** Le journal a été tronqué au plafond (`gateMaxOutputBytes`) : seule la fin est conservée. */
  truncated?: boolean;
}

export type GateFailureCode =
  | 'GATE_ORPHAN_PROCESS'
  | 'JOB_TERMINATE_INCOMPLETE'
  | 'GATE_INTERRUPTED'
  | 'GATE_NATIVE_UNAVAILABLE';

/** Issue d'une livraison vers `origin` (push du SHA testé), rapportée dans le résultat et en --json. */
export interface DeliveryReport {
  mode: 'push' | 'branch';
  remote: 'origin';
  /** Branche distante (sans `refs/heads/`) ; null si aucun nom valide n'a pu être dérivé. */
  ref: string | null;
  /** SHA EXACT testé qui a été (ou aurait été) poussé. */
  sha: string;
  pushed: boolean;
  /** Le remote portait déjà ce SHA (push concurrent) : succès sans nouveau push. */
  alreadyDelivered: boolean;
  /** PUSH_TIMEOUT | PUSH_NON_FAST_FORWARD | PUSH_REJECTED | PUSH_FAILED | PUSH_SUPERSEDED | DELIVERY_REF_INVALID ; null si livré. */
  code: string | null;
  message: string | null;
  hint: string | null;
  durationMs: number;
}

export type TicketReason =
  | 'MERGE_CONFLICT'
  | 'UNMERGEABLE_CONFLICT'
  | 'GATE_FAILED'
  | 'SEMANTIC_MERGE_FAILED'
  | 'SEMANTIC_GATE_FAILED'
  | 'PROMOTION_GATE_FAILED'
  /** Un hook de la cible (pre-commit, commit-msg…) ou la signature a rejeté / bloqué le commit de merge. */
  | 'COMMIT_HOOK_REJECTED'
  /** Garde I2 : l'agent change un chemin protégé — résolution humaine, fichier par fichier. */
  | 'PROTECTED_PATHS_CHANGED';

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
  | { kind: 'encoding' }
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
  /** Convention de nommage des fichiers du ticket (safeFileName) : 2 = injective ; absent = 1 (antérieur). */
  fileNaming?: 1 | 2;
  conflictedFiles: string[];
  /** Conflits hors de portée du Merger, avec leur nature (UNMERGEABLE_CONFLICT). */
  unmergeable?: Array<{ path: string } & ConflictClass>;
  /**
   * PROTECTED_PATHS_CHANGED : les chemins protégés que l'agent change. Ils
   * figurent aussi dans `conflictedFiles` — l'humain fixe le contenu final de
   * chacun (`.resolved`/`.delete`), c'est ce qui distingue sa décision de
   * celle de l'agent au `resolve --apply`.
   */
  protectedChanges?: ProtectedPathChange[];
  /**
   * PROTECTED_PATHS_CHANGED : fichiers en conflit TEXTUEL au merge (sous-ensemble
   * de `conflictedFiles`) — rejoués à l'identique par `--apply`, sinon ticket périmé.
   */
  mergeConflictedFiles?: string[];
  /** Rouge d'exécution du Test Gate : code stable, PID orphelins tués, journal tronqué. */
  gate?: { code?: GateFailureCode; orphanPids?: number[]; truncated?: boolean };
  prompt: string | null;
  createdAt: string;
  /** Nombre de tentatives de merge de ce même commit (absent = 1, tickets antérieurs). */
  attempts?: number;
  /** Dernière tentative, quand le ticket a été rafraîchi par un nouvel essai. */
  updatedAt?: string;
  dir: string;
  resolved?: boolean;
  /** Absent sur un ticket lisible ; discriminant de TicketEntry (voir CorruptTicket). */
  status?: undefined;
}

/** Cause d'un ticket illisible (voir CorruptTicket). */
export type TicketCorruption = 'MISSING' | 'UNREADABLE' | 'INVALID_JSON' | 'INCOMPLETE';

/**
 * Ticket dont le ticket.json est illisible ou absent (listConflictTickets) :
 * listé au lieu d'être ignoré en silence. Ses champs métier sont inconnus
 * (null) ; il ne peut qu'être fermé (`resolve --close`) — préparer,
 * appliquer ou lire son détail lève TICKET_CORRUPT. `createdAt` est la date
 * du dossier.
 */
export interface CorruptTicket {
  id: string;
  dir: string;
  resolved: boolean;
  status: 'CORRUPT';
  cause: TicketCorruption;
  createdAt: string;
  agent: null;
  branch: null;
  sha: null;
  reason: null;
  conflictedFiles: string[];
  prompt: null;
}

/** Entrée de `listConflictTickets` : ticket lisible, ou illisible (status 'CORRUPT'). */
export type TicketEntry = Ticket | CorruptTicket;

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
  /** Détail du Router à la mise en file (informatif, additif) : pourquoi la tâche attend. */
  routing?: import('./router-details.ts').PublicRouterDetails | null;
  /** Au dégagement de la file : réhabiliter l'archive au lieu de cloner. */
  reuse?: boolean;
  /**
   * Décision consciente prise à l'enfilage : cloner/réhabiliter malgré des
   * secrets historiques détectés (voir HISTORICAL_SECRETS_FOUND). Persistée
   * comme `reuse` — sans quoi le dégagement de file redemanderait une
   * confirmation qu'aucun humain n'est là pour donner. Le consentement à
   * PERDRE du travail (`--force`) n'est, lui, jamais persisté.
   */
  allowHistoricalSecrets?: boolean;
  /**
   * @deprecated Écrit par les builds de développement postérieurs à v0.10.0
   * (jamais publiés — la v0.10.0 ne persistait aucun consentement en file),
   * où `--force` valait à la fois secrets historiques et perte de travail
   * (`--reuse`). Relu uniquement comme `allowHistoricalSecrets` : jamais
   * comme consentement à perdre du travail (fail closed).
   */
  force?: boolean;
  /**
   * Motif d'ajournement posé EN MÉMOIRE par retryQueue (ex: REUSE_DIRTY),
   * jamais persisté dans queue.json.
   */
  blockedReason?: string;
  createdAt: string;
}

/**
 * Présence d'une session dans le clone d'un agent (`listAgents`), du signal
 * le plus fort au plus faible : PID vivant (session autonome ou hôte de pty
 * `--open`), puis simple activité disque récente, puis rien.
 */
export type AgentSession =
  | { state: 'running'; via: 'autonomous' | 'pty'; pid: number }
  | { state: 'recent-activity'; via: null; pid: null }
  | { state: 'idle'; via: null; pid: null };

/** Résultat de mergeAgentCommit — union discriminée sur `status`. */
export type MergeResult = (
  | {
      status: 'UP_TO_DATE';
      agent: string;
      sha: string;
      rebase: SyncResult | null;
      /** Vrai si le SHA de l'agent était déjà contenu dans la cible (aucun merge, aucun gate). */
      alreadyMerged?: boolean;
      /**
       * Avec `alreadyMerged` : le commit de la cible qui porte déjà le travail (la pointe
       * elle-même si c'est le commit de l'agent, sinon son premier descendant vers la pointe).
       */
      mergeSha?: string;
    }
  | {
      status: 'MERGED';
      agent: string;
      /** Commit de l'agent qui a été mergé. */
      sha: string;
      /** Commit de merge créé sur la branche cible (celui que rollback défait). */
      mergeSha: string;
      gate: GateResult;
      pushError: string | null;
      /** Livraison vers origin (push différé hors verrou) ; absent si autoPush est désactivé. */
      delivery?: DeliveryReport;
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
      reason:
        | 'MERGE_CONFLICT'
        | 'UNMERGEABLE_CONFLICT'
        | 'SEMANTIC_MERGE_FAILED'
        | 'PROTECTED_PATHS_CHANGED';
      agent: string;
      sha: string;
      conflictedFiles: string[];
      /** Présent quand reason === 'UNMERGEABLE_CONFLICT'. */
      unmergeable?: Array<{ path: string } & ConflictClass>;
      /** Présent quand reason === 'PROTECTED_PATHS_CHANGED'. */
      protectedChanges?: ProtectedPathChange[];
      ticket: Ticket;
      manualMode: boolean;
      /** Texte français du noyau (compat) ; le contrat stable est `errorCode`. */
      error?: string;
      /** Code stable de l'échec de fusion sémantique (ex. `SEMANTIC_MERGE_FAILED`, `TOKEN_BUDGET_EXCEEDED`). */
      errorCode?: string;
      /** Détails publics (identifiants seulement) de l'échec : `causeCode`, `provider`, `status`… */
      errorDetails?: Record<string, unknown>;
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
    }
) & {
  /** Durées par phase de l'opération (L8) — ajout additif, absent des résultats construits hors orchestrateur. */
  timings?: import('./timings.ts').Timings;
};

/** Résolution préparée pour un fichier en conflit (voir conflicts.js). */
export type ResolutionInput =
  | { path: string; kind: 'content'; content: Buffer }
  | { path: string; kind: 'delete' }
  | { path: string; kind: 'missing' };

/** Résultat de applyTicketResolution — union discriminée sur `status`. */
export type ManualResolutionResult = (
  | { status: 'ALREADY_CLEAN'; ticketId: string; agent: string; sha: string }
  | { status: 'GATE_FAILED'; ticketId: string; agent: string; sha: string; gate: GateResult }
  | {
      status: 'MERGED';
      ticketId: string;
      agent: string;
      /** Commit de l'agent dont le conflit a été résolu. */
      sha: string;
      /** Commit de merge créé sur la branche cible. */
      mergeSha: string;
      gate: GateResult;
      pushError: string | null;
      /** Livraison vers origin (push différé hors verrou) ; absent si autoPush est désactivé. */
      delivery?: DeliveryReport;
      memory: { updated: boolean; entry?: string; error?: string } | null;
      resolvedFiles: string[];
      /** [ticketId, ...doublons du même conflit fermés au passage]. */
      closedTickets: string[];
    }
) & { timings?: import('./timings.ts').Timings };

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
   *                       Aussi quand le commit de l'agent était DÉJÀ dans la
   *                       cible (`merge.status === 'UP_TO_DATE'`, `merge.alreadyMerged`) :
   *                       travail intégré par un autre chemin, aucun commit de merge
   *                       créé par ce cycle ; clone nettoyé sous les garde-fous
   *                       habituels de cleanClones (jamais de force).
   *  - 'EMPTY'          : session sortie en 0 sans aucun commit.
   *  - 'SESSION_FAILED' : sortie non nulle, délai dépassé ou lancement impossible.
   *  - 'MERGE_BLOCKED'  : commits présents mais merge en conflit ou gate rouge.
   *  - 'COMMIT_REFUSED' : commit Striart refusé (clone hors de sa branche,
   *                       opération git en cours, chemins non fusionnés).
   *  - 'COMMIT_FAILED'  : commit Striart en échec (git, hook, identité).
   *  - 'KEPT'           : `commitPolicy: 'human'` et l'agent a committé — AUCUN merge
   *                       automatique, clone conservé pour revue (HUMAN_REVIEW_REQUIRED).
   */
  status:
    | 'QUEUED'
    | 'MERGED'
    | 'EMPTY'
    | 'SESSION_FAILED'
    | 'MERGE_BLOCKED'
    | 'COMMIT_REFUSED'
    | 'COMMIT_FAILED'
    | 'KEPT';
  agent: string;
  session: SessionResult | null;
  merge: MergeResult | null;
  /** Commit Striart (contrat de commit) — null avec commitPolicy 'agent'. */
  commit: StriartCommitResult | null;
  cleaned: boolean;
  /** Renseigné dès que le clone est conservé : pourquoi il l'est (texte, français). */
  keptReason: string | null;
  /** Même raison, en code stable (rendu localisé de la CLI, --json). */
  keptCode: AutonomousKeptCode | null;
  /** Avertissements non bloquants du cycle (succès « bruyant »). */
  warnings?: AutonomousWarningCode[];
  /** Clones en échec que la sérialisation prudente du Router n'a pas attendus (additif). */
  relaxedBlockers?: RelaxedBlocker[];
  /** Détail machine du keptCode (statut de session/merge, motif de nettoyage, code d'erreur). */
  keptDetail: string | null;
  clonePath: string | null;
  task?: QueueTask;
}

/**
 * Raison stable de conservation d'un clone autonome :
 *  - SESSION_FAILED        : session non COMPLETED (keptDetail = statut) ;
 *  - NO_COMMIT             : commitPolicy 'agent', l'agent n'a rien committé ;
 *  - NO_CHANGES            : sorti sans aucune modification ;
 *  - ONLY_EXCLUDED_CHANGES : seuls des fichiers exclus (secrets, injectés) restaient ;
 *  - COMMIT_REFUSED / COMMIT_FAILED : commit Striart impossible (keptDetail = code) ;
 *  - MERGE_BLOCKED         : keptDetail = statut du merge ;
 *  - CLEANUP_SKIPPED       : merge réussi, nettoyage refusé (keptDetail = motif).
 */
export type AutonomousKeptCode =
  | 'SESSION_FAILED'
  | 'NO_COMMIT'
  | 'NO_CHANGES'
  | 'ONLY_EXCLUDED_CHANGES'
  | 'COMMIT_REFUSED'
  | 'COMMIT_FAILED'
  | 'MERGE_BLOCKED'
  | 'CLEANUP_SKIPPED'
  | 'HUMAN_REVIEW_REQUIRED';

/**
 * Avertissement d'un cycle réussi :
 *  - ALREADY_INTEGRATED : le commit de l'agent était DÉJÀ dans la cible (arrivé par un
 *    autre chemin) — rien n'a été mergé, le Test Gate n'a pas été rejoué, clone nettoyé ;
 *  - SERIALIZATION_RELAXED : la sentinelle WHOLE_REPO n'a pas attendu un clone en échec
 *    (détail dans `relaxedBlockers`).
 */
export type AutonomousWarningCode = 'ALREADY_INTEGRATED' | 'SERIALIZATION_RELAXED';

/**
 * Issue d'une session IDE du proxy ACP `striart acp` (lot I10) : le même
 * contrat que le cycle autonome (`AutonomousResult`), plus un cas propre au
 * proxy — `KEPT` : session close sans merge, par choix (merge manuel ou IDE
 * déconnecté avec `acpAgent.onDisconnect: 'keep'`), clone conservé.
 */
export interface AcpProxyResult extends Omit<AutonomousResult, 'status' | 'keptCode' | 'task'> {
  status: Exclude<AutonomousResult['status'], 'QUEUED'> | 'KEPT' | 'NOTHING_STARTED';
  /** `MERGE_DEFERRED` : merge laissé à l'humain (keptDetail : 'MANUAL' | 'DISCONNECTED'). */
  keptCode: AutonomousKeptCode | 'MERGE_DEFERRED' | null;
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

/** Un plan « tâches-as-code » v1 validé (src/plan.ts) — sémantique historique (file, --after). */
export interface StriartPlanV1 {
  version: 1;
  tasks: PlanTask[];
}

/** Un plan validé, toutes versions (union discriminée par `version`). */
export type StriartPlan = StriartPlanV1 | StriartPlanV2;

// ─── Lot O : modes d'orchestration et collaboration (src/orchestration, src/collab) ───

/** Enchaînement des tâches d'un plan v2. */
export type OrchestrationMode = 'sequential' | 'parallel';
/** Sort des tâches restantes quand une tâche échoue. */
export type PlanFailurePolicy = 'stop' | 'skip-dependents';
/** Mode d'une tâche (nœud) d'un plan v2. */
export type PlanNodeKind = 'task' | 'review' | 'pipeline' | 'race' | 'team';
export type ReviewQuorum = 'all' | 'any' | 'majority';
export type RacePick = 'first-green' | 'smallest-diff' | 'judge';
export type RaceLosers = 'keep' | 'archive' | 'clean';
export type TeamCadence = 'turns' | 'parallel';
export type PipelineHandoff = 'merge' | 'clone';

/** Agent autonome d'un nœud (auteur, candidat) : profil et délai propres. */
export interface PlanAgentSpec {
  /** Clé de config.agentProfiles (null → DEFAULT_PROFILE). */
  profile: string | null;
  timeout: number | null;
}

/** Relecteur d'un nœud `review` : un agent (profil) ou un humain (`striart review`). */
export interface PlanReviewerSpec {
  name: string;
  kind: 'agent' | 'human';
  profile: string | null;
  timeout: number | null;
  /** Consignes de relecture propres à ce relecteur (ajoutées au briefing). */
  prompt: string | null;
}

/** Rôle d'un nœud `team` (collaboration intra-clone). */
export interface PlanRoleSpec {
  name: string;
  profile: string | null;
  timeout: number | null;
  prompt: string | null;
  /** Périmètre d'écriture (globs de la garde I2). null = libre, [] = lecture seule. */
  files: string[] | null;
}

/** Étape d'un nœud `pipeline`. */
export interface PlanStepSpec {
  id: string;
  prompt: string;
  profile: string | null;
  timeout: number | null;
}

interface PlanNodeBase {
  id: string | null;
  agent: string | null;
  /** Dépendances : ids de plan définis plus haut, ou références d'exécution (agent/tâche vivants). */
  after: string[];
}

export type PlanNode =
  | (PlanNodeBase & {
      kind: 'task';
      prompt: string;
      autonomous: boolean;
      profile: string | null;
      command: string | null;
      timeout: number | null;
    })
  | (PlanNodeBase & {
      kind: 'review';
      prompt: string;
      author: PlanAgentSpec;
      reviewers: PlanReviewerSpec[];
      quorum: ReviewQuorum | null;
      maxRounds: number | null;
    })
  | (PlanNodeBase & {
      kind: 'pipeline';
      handoff: PipelineHandoff | null;
      steps: PlanStepSpec[];
    })
  | (PlanNodeBase & {
      kind: 'race';
      prompt: string;
      candidates: PlanAgentSpec[];
      pick: RacePick | null;
      losers: RaceLosers | null;
    })
  | (PlanNodeBase & {
      kind: 'team';
      prompt: string;
      cadence: TeamCadence | null;
      rounds: number | null;
      roles: PlanRoleSpec[];
    });

/** Un plan v2 validé : modes d'orchestration explicites (src/plan.ts). */
export interface StriartPlanV2 {
  version: 2;
  mode: OrchestrationMode;
  /** Tâches simultanées en mode parallel (null → orchestration.concurrency). */
  concurrency: number | null;
  onFailure: PlanFailurePolicy | null;
  tasks: PlanNode[];
}

/**
 * Issue d'un nœud orchestré. Les statuts du cycle autonome sont repris tels
 * quels ; les autres sont propres aux modes :
 *  - STARTED / QUEUED : tâche supervisée démarrée / en file (plan v1-like) ;
 *  - FINISHED         : tâche supervisée attendue jusqu'à la sortie de son agent ;
 *  - REVIEW_REJECTED / REVIEW_EXHAUSTED / VERDICT_INVALID : nœud review ;
 *  - READ_ONLY_VIOLATION : un relecteur/rôle en lecture seule a modifié le clone ;
 *  - SCOPE_VIOLATION / TEAM_COMMIT_FORBIDDEN : nœud team ;
 *  - RACE_NO_WINNER / JUDGE_FAILED : nœud race ;
 *  - SKIPPED : non lancé (dépendance en échec, onFailure) ;
 *  - CANCELLED : arrêt demandé ; WAIT_TIMEOUT : attente bornée dépassée ;
 *  - ERROR : une primitive du noyau a levé (detail = code de l'erreur).
 */
export type OrchestrationStatus =
  | 'MERGED'
  | 'STARTED'
  | 'QUEUED'
  | 'FINISHED'
  | 'EMPTY'
  /** `commitPolicy: 'human'` : travail committé conservé pour revue, aucun merge. */
  | 'KEPT'
  | 'SESSION_FAILED'
  | 'MERGE_BLOCKED'
  | 'COMMIT_REFUSED'
  | 'COMMIT_FAILED'
  | 'REVIEW_REJECTED'
  | 'REVIEW_EXHAUSTED'
  | 'VERDICT_INVALID'
  | 'READ_ONLY_VIOLATION'
  | 'SCOPE_VIOLATION'
  | 'TEAM_COMMIT_FORBIDDEN'
  | 'RACE_NO_WINNER'
  | 'JUDGE_FAILED'
  | 'SKIPPED'
  | 'CANCELLED'
  | 'WAIT_TIMEOUT'
  | 'ERROR';

export type ReviewVerdictValue = 'approve' | 'request-changes' | 'reject';

export interface ReviewComment {
  /** Chemin relatif au projet (isSafeProjectPath), null = remarque générale. */
  file: string | null;
  line: number | null;
  severity: 'blocker' | 'major' | 'minor' | 'info';
  body: string;
}

/** Verdict structuré d'un relecteur — contenu NON FIABLE, validé positivement. */
export interface ReviewVerdict {
  verdict: ReviewVerdictValue;
  summary: string;
  comments: ReviewComment[];
}

export interface ReviewVerdictRecord extends ReviewVerdict {
  reviewer: string;
  kind: 'agent' | 'human';
  round: number;
  source: 'mcp' | 'outbox' | 'log' | 'human';
}

/** Résultat d'un nœud orchestré (src/orchestration/scheduler.ts). */
export interface OrchestrationNodeResult {
  id: string | null;
  kind: PlanNodeKind;
  /** Mode d'exécution : supervisé seulement pour un `task` non autonome. */
  mode: 'attended' | 'autonomous';
  status: OrchestrationStatus;
  /** Agent principal (auteur, gagnant d'une course, clone de l'équipe). */
  agent: string | null;
  /** Tous les clones impliqués. */
  agents: string[];
  /** Groupe de collaboration (null pour un `task`). */
  group: string | null;
  /** Tours joués (review, team). */
  rounds: number;
  /** Détail machine (statut de merge, keptCode, motif). */
  detail: string | null;
  /** Un clone est conservé pour décision humaine. */
  kept: boolean;
  merge: { sha: string; mergeSha: string; alreadyMerged?: boolean } | null;
  verdicts: ReviewVerdictRecord[];
  /** Tâche supervisée démarrée : de quoi ouvrir sa session. */
  info?: (AgentMeta & { name: string }) | null;
  /** Clones en échec que la sentinelle WHOLE_REPO du Router n'a pas attendus (additif). */
  relaxedBlockers?: RelaxedBlocker[];
  /**
   * Preuve du nœud (lot O, priorité 2) — src/orchestration/evidence.ts.
   * Construite depuis des données déjà mesurées (jamais recalculées) :
   * absente seulement pour un nœud qui n'a jamais tourné (dépendance
   * échouée, interruption, collision du Router avant tout lancement).
   */
  evidence?: EvidenceBundle | null;
}

/**
 * Ce qu'un nœud de plan a VRAIMENT produit et vérifié (lot O, priorité 2) —
 * jamais une déclaration de l'agent, toujours une mesure du noyau. Un nœud
 * `MERGED`/`FINISHED` sans bundle exploitable est un bug de l'orchestrateur,
 * jamais un succès silencieux (voir AGENTS.md — fail closed).
 */
export interface EvidenceBundle {
  /** Consigne initiale du nœud (ce qui définissait « fait ») — absente pour un pipeline (consigne par étape). */
  objective: string | null;
  /** Commit de l'agent mergé et commit de merge sur la cible ; `null` si rien n'a été mergé. */
  commit: { sha: string; mergeSha: string; alreadyMerged?: boolean } | null;
  /** Test Gate exécuté pour ce merge — déjà mesuré par mergeAgentCommit, jamais relancé ici. */
  gate: { success: boolean; exitCode: number | undefined; timedOut: boolean; log: string } | null;
  /** Fusion sémantique (LLM) employée à la place d'une fusion Git ordinaire. */
  semantic: boolean;
  /** Fichiers d'un conflit résolu manuellement (vide hors conflit). */
  resolvedFiles: string[];
  /** Verdicts humains/IA déjà collectés (review, team) — jamais recalculés. */
  verdicts: ReviewVerdictRecord[];
  /** Travail conservé pour revue humaine au lieu d'être perdu (limitation déclarée). */
  kept: boolean;
  /**
   * Usage et coût connus pour cet agent (src/tokens/ledger.ts, `currentTotals`
   * — déjà mesuré, jamais recalculé). Cumul **de l'agent** depuis l'origine
   * du registre, pas isolé à ce nœud seul (aucune frontière plus fine
   * n'existe encore côté usage) ; `null` si le nœud n'a jamais eu d'agent.
   */
  usage: { tokens: number; costUsd: number; unpriced: number } | null;
}

export type CollabMessageKind = 'note' | 'question' | 'answer' | 'handoff' | 'verdict' | 'done';

export interface CollabMember {
  agent: string;
  role: string;
}

/** Message du canal de collaboration — `body` est du texte d'agent NON FIABLE. */
export interface CollabMessage {
  seq: number;
  id: string;
  group: string;
  /** Expéditeur DÉDUIT par Striart (jamais lu dans le message) ; rôle 'striart' = Striart. */
  from: CollabMember;
  /** Rôle destinataire, ou '*' pour tous les membres. */
  to: string;
  kind: CollabMessageKind;
  body: string;
  /** Corps tronqué à collab.maxBodyBytes. */
  truncated: boolean;
  source: 'mcp' | 'outbox' | 'log' | 'striart';
  createdAt: string;
}

/** Groupe de collaboration persistant (.striart/collab/<id>.json). */
export interface CollabGroup {
  version: 1;
  id: string;
  kind: Exclude<PlanNodeKind, 'task'>;
  members: CollabMember[];
  /** Rôles relecteurs : un verdict n'est recevable que d'eux, pendant leur tour. */
  verdictRoles: string[];
  /** Rôles dont c'est le tour (posés par l'orchestrateur). */
  activeRoles: string[];
  /**
   * Clé aléatoire du groupe (jamais transmise aux agents) : dérive le jeton
   * d'enceinte de chaque message rendu dans l'inbox — stable pour l'écriture
   * idempotente, imprévisible pour un message futur.
   */
  fenceKey?: string;
  messages: CollabMessage[];
  seq: number;
  /** Messages acceptés par expéditeur (agent:rôle) — borne maxMessagesPerSender. */
  perSender: Record<string, number>;
  /** Messages refusés (bornes atteintes) — jamais silencieux. */
  dropped: number;
  createdAt: string;
  closedAt: string | null;
}

/** Demande de relecture humaine (.striart/reviews/<id>.json). */
export interface HumanReviewRequest {
  id: string;
  group: string;
  agent: string;
  reviewer: string;
  round: number;
  branch: string;
  sha: string;
  baseCommit: string;
  /** Résumé `git diff --stat` (sortie git, non fiable à l'affichage). */
  diffstat: string;
  status: 'PENDING' | 'ANSWERED' | 'EXPIRED';
  verdict: ReviewVerdict | null;
  createdAt: string;
  answeredAt: string | null;
  expiresAt: string;
  /** PID du process qui attend le verdict (vivant = demande servie). */
  pid: number;
}

/**
 * Périmètre d'écriture par rôle, publié avec la collaboration d'un clone :
 * `null` = libre, `[]` = lecture seule, sinon les globs autorisés. Une clé
 * absente = périmètre inconnu (rien n'est affirmé aux consignes).
 */
export type AgentCollabFiles = Record<string, string[] | null>;

/**
 * Collaboration portée par un clone (registre, observabilité) — union par
 * cadence : un seul écrivain à la fois (`turns`) ou plusieurs (`parallel`).
 */
export type AgentCollabInfo =
  | {
      group: string;
      kind: 'review' | 'team' | 'pipeline';
      cadence: 'turns';
      roles: string[];
      activeRole: string | null;
      round: number;
      /** Périmètre d'écriture par rôle (absent = non renseigné) : voir `AgentCollabFiles`. */
      files?: AgentCollabFiles;
    }
  | {
      group: string;
      kind: 'team';
      cadence: 'parallel';
      roles: string[];
      activeRoles: string[];
      round: number;
      files?: AgentCollabFiles;
    }
  | { group: string; kind: 'race'; cadence: 'candidate'; candidate: number };

/** État persistant d'un groupe orchestré (.striart/orchestration/groups/<id>.json). */
export interface OrchestrationGroupState {
  id: string;
  kind: Exclude<PlanNodeKind, 'task'>;
  runId: string | null;
  nodeId: string | null;
  agents: string[];
  status: 'running' | 'done';
  result: OrchestrationStatus | null;
  round: number;
  activeRoles: string[];
  verdicts: ReviewVerdictRecord[];
  /** Demande de relecture humaine en attente (id), sinon null. */
  humanReview: string | null;
  pid: number;
  startedAt: string;
  updatedAt: string;
}

/** État persistant d'une application de plan v2 (.striart/orchestration/runs/<id>.json). */
export interface OrchestrationRunState {
  id: string;
  mode: OrchestrationMode;
  concurrency: number;
  /** Politique d'échec EFFECTIVE de ce run (overrides déjà résolus) — reprise fidèle sans reconfig. */
  onFailure: PlanFailurePolicy;
  status: 'running' | 'done' | 'interrupted';
  nodes: Array<{
    id: string | null;
    kind: PlanNodeKind;
    state: 'pending' | 'running' | 'done' | 'skipped';
    status: OrchestrationStatus | null;
    agent: string | null;
    /**
     * Résultat complet du nœud une fois `state` à `done`/`skipped` — jamais
     * recalculé, relu tel quel par `striart plan --resume` pour ne jamais
     * relancer une tâche déjà terminée (merge compris). `null` tant que le
     * nœud n'a pas fini — y compris après un crash en plein `running`.
     */
    result: OrchestrationNodeResult | null;
  }>;
  pid: number;
  startedAt: string;
  updatedAt: string;
}

/** Réglages des modes d'orchestration (`config.orchestration`, partiel côté utilisateur). */
export interface OrchestrationSettings {
  concurrency: number;
  maxConcurrency: number;
  onFailure: PlanFailurePolicy;
  collisionPolicy: 'wait' | 'fail';
  pollIntervalMs: number;
  waitTimeoutMs: number;
  keepRuns: number;
  review: {
    maxRounds: number;
    verdictRetries: number;
    quorum: ReviewQuorum;
    reviewerWrites: 'fail' | 'discard';
    humanTimeoutMs: number;
  };
  race: {
    pick: RacePick;
    losers: RaceLosers;
    maxCandidates: number;
    judgeFallback: 'fail' | 'first-green';
  };
  team: {
    cadence: TeamCadence;
    rounds: number;
    maxRounds: number;
    onScopeViolation: 'fail' | 'warn';
  };
  pipeline: { handoff: PipelineHandoff };
}

/** Réglages du canal de collaboration (`config.collab`, partiel côté utilisateur). */
export interface CollabSettings {
  enabled: boolean;
  maxMessages: number;
  maxBodyBytes: number;
  maxMessagesPerSender: number;
  inboxFile: boolean;
  outboxFile: boolean;
  maxOutboxBytes: number;
  briefingMaxChars: number;
  logMarkers: boolean;
}

/** LLM par rôle de Striart (`config.llmRoles`) — null = bloc `llm` global. */
export interface LlmRoles {
  router: LlmSpec | null;
  merger: LlmSpec | null;
  memory: LlmSpec | null;
  judge: LlmSpec | null;
}

/**
 * Clone que la sentinelle WHOLE_REPO du Router n'attend pas : session terminée en échec, clone
 * conservé sans commit à merger (voir src/session-failure.ts). Visible, jamais silencieux.
 */
export interface RelaxedBlocker {
  agent: string;
  reason: 'SESSION_FAILED';
  status: string;
}

/** Résultat de runTask. */
export type RunResult = (
  | {
      status: 'STARTED';
      info: AgentMeta & { name: string };
      predictedFiles: string[];
      collisions: [];
      semanticWarnings: SemanticWarning[];
      workspaceWarnings: WorkspaceWarning[];
      routing?: import('./router-details.ts').PublicRouterDetails | null;
      /** Clones en échec que la sentinelle WHOLE_REPO n'a pas attendus (additif, absent si aucun). */
      relaxedBlockers?: RelaxedBlocker[];
    }
  | {
      status: 'QUEUED';
      task: QueueTask;
      predictedFiles: string[];
      collisions: Collision[];
      routing?: import('./router-details.ts').PublicRouterDetails | null;
      relaxedBlockers?: RelaxedBlocker[];
    }
) & { timings?: import('./timings.ts').Timings };

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
export type PromoteResult = (
  | { status: 'UP_TO_DATE'; sha: string }
  | {
      status: 'PROMOTED';
      sha: string;
      commits: number;
      gate: GateResult;
      pushError: string | null;
      /** Livraison vers origin (push différé hors verrou) ; absent si autoPush est désactivé. */
      delivery?: DeliveryReport;
    }
  | { status: 'GATE_FAILED'; sha: string; gate: GateResult; ticket: Ticket; rolledBack: boolean }
) & { timings?: import('./timings.ts').Timings };

export interface StriartState {
  semanticFailureStreak: number;
  manualMode: boolean;
}

/** Session déclarée sur le repo principal lui-même — voir main-session.js. */
export interface MainSession {
  pid: number | null;
  reason: string;
  startedAt: string;
}

/** Réglages du serveur MCP (`config.mcp`, défauts dans DEFAULT_CONFIG.mcp). */
export interface McpSettings {
  /** 'agent' (défaut, D6) : borné au clone appelant ; 'orchestrator' : élargi hors clone. */
  scope: 'agent' | 'orchestrator';
  /** Vue MCP Apps (lecture seule) des tickets de conflit. */
  apps: boolean;
  /** Extension Tasks pour striart_merge / striart_resolve_apply. */
  tasks: boolean;
  taskTtlMs: number;
  taskPollIntervalMs: number;
  maxLineBytes: number;
  maxConcurrentRequests: number;
  maxQueuedRequests: number;
}

// ---------------------------------------------------------------------------
// Lot T — économie et comptabilité des tokens (src/tokens/)
// ---------------------------------------------------------------------------

/** Rôle d'un appel dépensant des tokens (champ `role` du registre). */
export type UsageRole = 'router' | 'merger' | 'memory' | 'judge' | 'review' | 'agent';

/** Origine d'un relevé : réponse API, flux structuré d'agent, estimation locale, session sans relevé. */
export type UsageSource = 'api' | 'agent-stream' | 'acp' | 'estimate' | 'unmetered';

/**
 * Usage normalisé d'un appel. `input` = jetons d'entrée NON servis par le cache
 * (facturés plein tarif) ; le total d'entrée est input + cacheRead + cacheWrite.
 * `output` inclut le raisonnement quand le fournisseur le compte ainsi ;
 * `reasoning` en est l'information détaillée (sous-ensemble), jamais ajoutée.
 */
export interface TokenUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning: number;
}

/** Ligne du registre `.striart/usage/YYYY-MM-DD.ndjson` — jamais de prompt, de contenu ni de clé. */
export interface UsageRecord {
  v: 1;
  ts: string;
  role: UsageRole;
  provider: string | null;
  model: string | null;
  agent: string | null;
  taskId: string | null;
  durationMs: number;
  source: UsageSource;
  outcome: 'ok' | 'rejected' | 'error' | 'cache-hit' | 'budget' | 'stopped';
  /** Estimé localement (le fournisseur n'a rien rapporté) : à lire comme un ordre de grandeur. */
  estimated: boolean;
  input: number | null;
  output: number | null;
  cacheRead: number | null;
  cacheWrite: number | null;
  reasoning: number | null;
  /** Coût en USD, null si le modèle n'a pas de prix déclaré (jamais 0 par défaut). */
  costUsd: number | null;
  /** Caractères « effectifs » du prompt (calibration de l'estimateur) — un nombre, jamais le texte. */
  promptChars?: number;
  /** Taille estimée des consignes injectées (sessions). */
  instructionsTokens?: number;
  /** Fenêtre de contexte utilisée rapportée par l'agent (ACP usage_update). */
  contextUsed?: number;
  detail?: string;
}

export interface SessionUsageSummary {
  source: UsageSource;
  metered: boolean;
  input: number | null;
  output: number | null;
  cacheRead: number | null;
  cacheWrite: number | null;
  costUsd: number | null;
  instructionsTokens: number | null;
}

export type BudgetScope = 'perCall' | 'perTask' | 'perAgent' | 'perDay' | 'global';

export interface BudgetBreach {
  scope: BudgetScope;
  metric: 'inputTokens' | 'outputTokens' | 'tokens' | 'costUsd';
  limit: number;
  used: number;
}

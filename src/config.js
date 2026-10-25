import path from 'node:path';
import { cosmiconfig } from 'cosmiconfig';
import { StriartError } from './errors.js';
import { logger } from './logger.js';
import { MAX_TIMER_MS } from './timer-limits.ts';
import { assertSecretPatternSyntax } from './secret-patterns.ts';
import { parseAllowedHosts } from './control/hosts.ts';
import { DEFAULT_TERMINAL_SETTINGS, isValidTerminalSettings } from './terminal/config.ts';
import { DEFAULT_HOOK_SETTINGS, isValidHookSettings } from './hooks/config.ts';
import { DEFAULT_ACP_AGENT_SETTINGS, acpAgentSettingsProblem } from './acp-agent/settings.ts';
import {
  DEFAULT_COLLAB_SETTINGS,
  DEFAULT_LLM_ROLES,
  DEFAULT_ORCHESTRATION_SETTINGS,
  isValidCollabSettings,
  isValidLlmRoles,
  isValidOrchestrationSettings,
} from './orchestration/settings.ts';
import { isValidLlmResilience } from './llm-resilience.ts';
import { PTY_MIN_CLIENT_QUEUE_BYTES, ptyMinClientQueueBytes } from './pty-limits.ts';
import { isValidTokensSettings } from './tokens/settings.ts';
import { DEFAULT_LOG_GENERATIONS, DEFAULT_LOG_MAX_BYTES, isValidRotation } from './log-rotation.ts';
import {
  defaultAgentProfileRefs,
  defaultAgentProfiles,
  expandAgentProfiles,
  getPreset,
} from './agents/catalog.ts';
import {
  COMMIT_MESSAGE_PLACEHOLDERS as SCHEMA_COMMIT_MESSAGE_PLACEHOLDERS,
  COMMIT_POLICIES,
  acpProfileProblem,
  isValidAcpRegistryConfig,
  isValidAgentInstructionsConfig,
  isValidAgentProfile,
  isValidCommitMessageTemplate,
} from './agents/profile-schema.ts';

export const DEFAULT_CONFIG = {
  // Clé de premier niveau inconnue dans la config (faute de frappe : `testComand`,
  // `commitPolcy` → la protection visée resterait à son défaut sans bruit) :
  // 'error' (défaut sûr) = CONFIG_INVALID ; 'warn' = relâchement explicite,
  // journalisé à chaque chargement et affiché par `striart doctor`.
  unknownConfigKeys: 'error',
  testCommand: 'npm test',
  targetBranch: 'main',
  autoPush: false,
  semanticMerge: true,
  // Clone partiel des agents pour les très gros historiques : 'blob:none'
  // (les blobs anciens sont récupérés à la demande depuis le repo principal,
  // conservé comme remote fetch-only). null → clone local complet, dont les
  // objets sont hardlinkés nativement par git (immuables, donc sûrs).
  cloneFilter: null,
  // Rétention de striart prune : clones arrêtés inactifs et tickets résolus
  // depuis plus de N jours. 0 → tout ce qui est arrêté/résolu est éligible.
  // Vaut aussi pour les journaux de session (.striart/logs/session-*.log) et
  // les journaux de terminal (pty-*.log) des agents qui ne sont plus actifs.
  pruneDays: 14,
  // Rotation par taille des journaux longs (watch.log, dashboard.log,
  // watch-ui.log) : au-delà de logMaxBytes octets, le journal devient
  // <nom>.log.1 (… jusqu'à .log.<logGenerations>, la plus ancienne supprimée).
  // Bornes : 64 Kio à 1 Gio ; 1 à 100 générations.
  logMaxBytes: DEFAULT_LOG_MAX_BYTES,
  logGenerations: DEFAULT_LOG_GENERATIONS,
  // Rebase automatique des clones agents sur targetBranch avant chaque merge.
  autoRebase: true,
  // Stash auto pendant le rebase quand le worktree agent a du travail en
  // cours — UNIQUEMENT si ses fichiers sont disjoints des commits entrants
  // (vérifié, pas supposé). false → worktree occupé = rebase reporté.
  autoStash: true,
  // Webhook Slack/Discord pour les événements importants (tâche bloquée,
  // merge échoué, mode manuel). null → log terminal uniquement.
  // Canal unique historique — pour plusieurs canaux, voir `notifiers`.
  webhookUrl: null,
  // Table multi-canaux : [{ type: 'slack'|'discord'|'generic', url | urlEnv }].
  // `urlEnv` (nom d'une variable d'environnement) est préférable à `url` :
  // une URL de webhook est un secret. S'ajoute à webhookUrl, ne le remplace pas.
  notifiers: [],
  dashboardPort: 3456,
  // Striart Control Protocol (dashboard HTTP, `striart api --stdio`) :
  //  - durée de vie d'un lien de connexion à usage unique (5 min) ;
  //  - durée d'une session navigateur ouverte par ce lien (12 h) ;
  //  - octets en attente au-delà desquels un client du flux d'état est jugé
  //    lent (SSE : déconnecté, il se reconnecte ; stdio : coalescence) ;
  //  - délai maximal entre un changement et sa notification (2 s).
  // Hôtes Host supplémentaires admis par le dashboard (Codespaces, proxy) :
  // [] = boucle locale seule. Relâche UNIQUEMENT le contrôle Host (jeton,
  // cookie, anti-CSRF et Origin restent exigés) ; voir src/control/hosts.ts.
  dashboardAllowedHosts: [],
  // 'instance' (défaut) : le dashboard est servi sous <id-aléatoire>.localhost, le cookie de
  // session n'est jamais envoyé aux autres serveurs localhost:* (S-I4). 'localhost' : repli
  // pour un navigateur qui ne résout pas *.localhost (risque documenté, affiché par doctor).
  dashboardHostname: 'instance',
  dashboardLinkTtlMs: 300_000,
  dashboardSessionTtlMs: 43_200_000,
  controlSseMaxBufferedBytes: 4_194_304,
  controlStateMaxDelayMs: 2_000,
  // Pipeline staging → main : si mainBranch est défini, targetBranch joue le
  // rôle de staging (ex: 'striart/staging') et `striart promote` fait avancer
  // mainBranch en fast-forward après un Test Gate global. null → désactivé.
  mainBranch: null,
  // Gate global de la promotion (tests d'intégration complets).
  // null → réutilise testCommand.
  promoteTestCommand: null,
  // Délai max du Test Gate : au-delà, le process de test est tué → gate rouge.
  testTimeoutMs: 600000,
  // Test Gate dans un conteneur de process natif (Job Object / groupe) :
  //  - gateOrphanGraceMs : délai laissé aux descendants du test pour finir
  //    seuls après la sortie de la commande. Un descendant encore vivant
  //    passé ce délai est un ORPHELIN : tué, et le gate est ROUGE
  //    (GATE_ORPHAN_PROCESS) même si la commande a rendu 0 — un orphelin qui
  //    tient la sortie est un test qui fuit. 0 – 600 000 ms.
  //  - gateMaxOutputBytes : plafond du journal conservé (la fin de la sortie
  //    est gardée, le reste écarté) — 1 Kio – 1 Gio.
  //  - gateContainer : 'native' (défaut, fail closed si le binaire natif est
  //    indisponible) | 'process' (relâchement EXPLICITE : pas de détection
  //    d'orphelins, arbre tué au délai seulement).
  gateOrphanGraceMs: 2000,
  gateMaxOutputBytes: 104857600,
  gateContainer: 'native',
  // Fetch silencieux périodique en mode watch : mesure le retard des agents
  // sur targetBranch sans toucher leurs working trees. 0 → désactivé.
  fetchIntervalMs: 20000,
  // Secrets TRACKÉS retirés du worktree des clones agents (sparse-checkout,
  // sémantique gitignore). Les untracked (.env classique) ne sont jamais
  // clonés par git. [] → désactivé.
  secretPatterns: ['.env', '.env.*', '*.pem', '*.key', 'credentials.json'],
  // Après une fusion sémantique dont le Test Gate échoue : nombre de
  // nouvelles tentatives du Merger avec le log d'erreur du gate en feedback,
  // avant le ticket humain. 0 → ticket immédiat (comportement historique).
  semanticGateRetries: 1,
  // Memory Layer : après chaque merge, un LLM résume les API changées dans
  // .striart/memory.md, recopié dans chaque clone (.striart-memory.md,
  // untracked + ignoré localement). Advisory : n'interrompt jamais un merge.
  // Opt-in — coût LLM par merge.
  memoryLayer: false,
  memoryMaxEntries: 30,
  // Présence de session : un clone dont le disque a été modifié il y a
  // moins de N minutes est considéré comme occupé par une session de coding.
  // striart clean le saute alors (règle d'or n°3) — heuristique mtime,
  // contournable uniquement par --force en connaissance de cause.
  presenceMinutes: 10,
  // Provider LLM : null → Ollama local via ollamaModel/ollamaHost.
  // Voir src/llm.js pour la forme { provider, model, baseUrl, apiKeyEnv }.
  llm: null,
  // Commande de l'agent de coding affichée après striart start/run
  // (claude, cursor, aider, ...). null → 'claude' en exemple.
  agentCommand: null,
  // Profils d'invocation NON INTERACTIVE, utilisés par le mode autonome
  // (striart run --autonomous --profile <clé>). Chaque fournisseur a sa
  // propre syntaxe headless, d'où une table : c'est ce qui permet de
  // superviser des agents Claude, OpenAI, Ollama ou Kimi sur le même projet.
  // {{prompt}} est substitué comme ÉLÉMENT d'argv — jamais de shell, donc
  // aucune injection possible depuis le texte du prompt.
  // Défauts = presets PRÊTS du catalogue (src/agents/catalog.ts), vérifiés
  // en documentation officielle : chacun configure l'outil pour qu'il puisse
  // réussir (éditer, commiter selon commitPolicy) et neutralise la config
  // d'agent du dépôt quand l'outil le permet. `{ preset: '<id>', … }` en
  // config dérive un profil d'un preset (y compris expérimental).
  agentProfiles: defaultAgentProfiles(),
  // Consignes Striart remises aux agents (src/agents/instructions.ts) :
  // gabarit complet par défaut, canal par profil, fichier non suivi et
  // exclu localement en mode supervisé. Fusion par clé avec ces défauts.
  agentInstructions: {
    enabled: true,
    template: null,
    append: null,
    commitConvention:
      'Conventional Commits — "<type>(<scope>): <summary>" with type among feat, fix, refactor, test, docs, chore; imperative mood; one logical change per commit.',
    // D11 : AGENTS.md racine suivi → AGENTS.override.md composite (outils qui
    // le lisent) ; 'non-file' → rien à côté d'AGENTS.md, avertissement.
    agentsMd: 'override',
    attendedFiles: {},
    genericFiles: ['AGENTS.md'],
    neutralizeParentInstructions: true,
  },
  // Registre ACP de `striart profiles --import-acp` : métadonnées seules par
  // défaut. allowBinaryDownload: true autorise le téléchargement d'une
  // distribution binaire épinglée à empreinte sha256 vérifiée (journalisé).
  // Proxy ACP `striart acp` (lot I10, src/acp-agent/settings.ts) : profil
  // amont proposé, politique de permission (défaut 'ask' : l'humain tranche
  // DANS l'éditeur), merge auto/manuel, IDE déconnecté → clone conservé,
  // collision Router → refus. Objet PARTIEL, complété par les défauts.
  acpAgent: DEFAULT_ACP_AGENT_SETTINGS,
  acpRegistry: {
    url: 'https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json',
    allowBinaryDownload: false,
    allowEnv: [],
  },
  // Délai max d'une session autonome : au-delà, l'arbre de process de l'agent
  // est tué et le clone est CONSERVÉ pour diagnostic. Borne le temps, pas la
  // dépense en tokens — un agent autonome consomme sans surveillance.
  autonomousTimeoutMs: 1_800_000,
  ollamaModel: 'llama3.1:8b',
  ollamaHost: 'http://localhost:11434',
  // Prompts du Router et du Merger, surchargeables intégralement (ex: les
  // réécrire en anglais pour un modèle local qui y est plus fiable, ou les
  // durcir pour un modèle faible). null → prompt par défaut (dans router.js /
  // merger.js). Chaque template doit porter TOUS ses placeholders — un
  // template sans {{base}} produirait une fusion aveugle : refus au
  // chargement, même politique que {{prompt}} dans agentProfiles.
  //  - router : {{task}} (la tâche) et {{files}} (fichiers du projet, un par
  //    ligne). Réponse attendue : JSON {"files": [...]}.
  //  - merger : {{file}}, {{base}}, {{ours}}, {{theirs}} (les 3 versions) et
  //    {{feedback}} (section de retry post-gate, vide au premier essai).
  //    Réponse attendue : le code fusionné seul.
  prompts: { router: null, merger: null },
  // Verrou principal (src/lock.js). breakFrozenHolderAfterMs : null (défaut
  // sûr) = un détenteur VIVANT dont le battement est figé n'est JAMAIS cassé
  // (LOCK_TIMEOUT HOLDER_FROZEN, PID à arrêter) — le casser laisserait deux
  // process dans la section à son dégel. Un entier ≥ 60 000 ms autorise la
  // cassure au-delà de ce délai sans battement : protection relâchée,
  // journalisée à chaque cassure et affichée par `striart doctor`.
  lock: { breakFrozenHolderAfterMs: null },
  // Hôte de pty natif (`striart-native pty-host`, src/pty-attach.ts) —
  // complété par clé des défauts (src/pty-host.ts, resolvePtyHostSettings) :
  //  - replayBytes : sortie récente rejouée à un client qui s'attache
  //    (1 Kio – 16 Mio, coupée à une frontière de séquence ANSI/UTF-8) ;
  //  - clientQueueBytes : sortie en attente au-delà de laquelle un client
  //    trop lent est évincé explicitement puis se reconnecte (32 Kio –
  //    256 Mio, au moins ⌈replayBytes×4/3⌉ + deux frames de sortie) — borne la mémoire de l'hôte ;
  //  - killGraceMs : délai laissé au shell et à ses descendants pour sortir
  //    à la fermeture du pty avant qu'ils soient tués (0 – 60 000) ;
  //  - shell : shell hébergé par l'hôte. 'auto' (défaut) = PowerShell sous
  //    Windows, $SHELL/bash ailleurs. Sinon un nom nu (résolu dans les
  //    dossiers ABSOLUS du PATH seulement, jamais le dossier courant) ou un
  //    chemin absolu vers un exécutable — jamais passé à un shell (argv).
  //    Choisir un exécutable est un relâchement (config-as-code), affiché par
  //    `striart doctor` ; un agentProfile/une commande explicite prime ;
  //  - shellArgs : arguments passés à ce shell (≤ 64, chacun ≤ 4096 octets,
  //    sans saut de ligne ni NUL), ex. ['-NoLogo', '-NoProfile'].
  pty: {
    replayBytes: 65_536,
    clientQueueBytes: 4_194_304,
    killGraceMs: 1_000,
    shell: 'auto',
    shellArgs: [],
  },
  // Lanceur de terminal de `--open` (src/terminal/config.ts) : 'auto' garde
  // le comportement historique (+ détection de Warp, désactivable par
  // detectWarp: false) ; sinon un lanceur explicite, ou 'custom' (argv avec
  // placeholders, jamais un shell). Valeur partielle complétée par les défauts.
  terminal: DEFAULT_TERMINAL_SETTINGS,
  // Hooks advisory des outils de coding (`striart hook`, src/hooks/) : ils
  // INFORMENT (collision de fichier, fin de session), ne bloquent jamais.
  hooks: DEFAULT_HOOK_SETTINGS,
  // Serveur MCP (`striart mcp`), voir src/mcp/.
  //  - scope : 'agent' (défaut, D6) → un appelant lancé depuis un clone (ou
  //    `--agent`) n'agit que sur SON agent ; hors clone, aucun outil mutant.
  //    'orchestrator' → hors clone, run/merge/résolution sur tout le dépôt
  //    (relâchement : journalisé au démarrage et affiché par doctor). Jamais,
  //    à aucun niveau : fermer un ticket ni arbitrer une permission.
  //  - apps : vue MCP Apps (lecture seule) des tickets de conflit 3-way.
  //  - tasks : extension Tasks pour les opérations longues (merge, apply).
  //  - taskTtlMs / taskPollIntervalMs : rétention et cadence suggérée.
  //  - maxLineBytes : borne d'une requête JSON-RPC (ligne stdin).
  //  - maxConcurrentRequests : outils/lectures exécutés en parallèle ;
  //    maxQueuedRequests : en attente au-delà (refus "overloaded" ensuite).
  mcp: {
    scope: 'agent',
    apps: true,
    tasks: true,
    taskTtlMs: 3_600_000,
    taskPollIntervalMs: 2000,
    maxLineBytes: 1_048_576,
    maxConcurrentRequests: 4,
    maxQueuedRequests: 64,
  },
  // Garde des chemins protégés (src/protected-paths.ts) : un agent qui change
  // un fichier d'instructions/config d'agent ou la config de Striart voit son
  // merge refusé (ticket PROTECTED_PATHS_CHANGED). `extend` ajoute des motifs
  // (globs ancrés) ; seul `allow` en retire — relâchement journalisé à chaque
  // merge et affiché par doctor. matchCase 'insensitive' (défaut) compare sans
  // casse partout ; 'platform' seulement sous Windows/macOS (relâchement).
  protectedAgentPaths: { extend: [], allow: [], matchCase: 'insensitive' },
  // Contrat de commit des sessions autonomes (surchargeable par profil) :
  // 'agent' (défaut, l'agent committe), 'agent-then-striart' (Striart committe
  // le reste si l'agent n'a rien committé), 'striart' (Striart committe
  // toujours le reste), 'human' (personne — revue humaine, clone conservé).
  commitPolicy: 'agent',
  // Gabarit du message d'un commit Striart. Placeholders :
  // COMMIT_MESSAGE_PLACEHOLDERS. Des trailers Striart-* sont toujours ajoutés.
  commitMessage: 'striart({{agent}}): {{task}}',
  // Lot O — modes d'orchestration (plans v2, `striart orchestrate`), canal de
  // collaboration entre agents, LLM par rôle. Objets PARTIELS côté
  // utilisateur, fusionnés en profondeur par resolveOrchestrationSettings /
  // resolveCollabSettings (src/orchestration/settings.ts). Défauts sûrs :
  // échec → plus rien ne démarre, perdants d'une course conservés, relecteur
  // qui écrit → échec, canal borné.
  orchestration: DEFAULT_ORCHESTRATION_SETTINGS,
  collab: DEFAULT_COLLAB_SETTINGS,
  llmRoles: DEFAULT_LLM_ROLES,
  // Lot T — économie et comptabilité des tokens (src/tokens/settings.ts). Objet
  // PARTIEL fusionné en profondeur par resolveTokensSettings : comptabilité
  // toujours active, plafonds (tokens.budgets) opt-in, alertes à seuils
  // absolus, Merger par régions au-delà de 16 000 caractères, arbre du Router
  // compacté s'il déborde, cache de prompt et de résultats. Relâcher une
  // protection (accounting: false, enforcement: 'alert-only') s'affiche dans doctor.
  tokens: {},
  // Résilience des appels LLM (src/llm-resilience.ts) : backoff exponentiel à
  // gigue complète, Retry-After, disjoncteur par fournisseur. Objet partiel.
  llmResilience: {},
};

/**
 * Placeholders d'un message de commit Striart et valeurs de `commitPolicy` :
 * source unique dans src/agents/profile-schema.ts (validation des profils),
 * réexportées ici pour les consommateurs historiques.
 */
export const COMMIT_MESSAGE_PLACEHOLDERS = [...SCHEMA_COMMIT_MESSAGE_PLACEHOLDERS];

/** Valeurs de `commitPolicy` (global et par profil). */
export const COMMIT_POLICY_VALUES = [...COMMIT_POLICIES];

/** Placeholders obligatoires par template surchargeable. */
export const PROMPT_PLACEHOLDERS = {
  router: ['{{task}}', '{{files}}'],
  merger: ['{{file}}', '{{base}}', '{{ours}}', '{{theirs}}', '{{feedback}}'],
};

/** Borne d'une chaîne de `pty.shell`/`pty.shellArgs` (chemin ou argument). */
const PTY_SHELL_STRING_MAX = 4096;
const PTY_SHELL_ARGS_MAX = 64;
const CONTROL_CHARS = /[\0\r\n]/;

/**
 * `pty.shell` : 'auto', un nom nu, ou un chemin ABSOLU (POSIX ou Windows : la
 * config peut être partagée entre machines, c'est la résolution réelle qui
 * dit si le fichier existe ici). Un chemin avec séparateur mais relatif est
 * refusé : il dépendrait du dossier courant.
 * @param {unknown} v
 */
function isValidPtyShell(v) {
  if (typeof v !== 'string' || v.length === 0 || v.length > PTY_SHELL_STRING_MAX) return false;
  if (CONTROL_CHARS.test(v) || v !== v.trim()) return false;
  if (!/[\\/]/.test(v)) return true;
  return path.posix.isAbsolute(v) || path.win32.isAbsolute(v);
}

/** @param {unknown} v */
function isValidPtyShellArgs(v) {
  return (
    Array.isArray(v) &&
    v.length <= PTY_SHELL_ARGS_MAX &&
    v.every(
      (a) => typeof a === 'string' && a.length <= PTY_SHELL_STRING_MAX && !CONTROL_CHARS.test(a),
    )
  );
}

const VALIDATORS = {
  testCommand: (v) => typeof v === 'string' && v.trim().length > 0,
  targetBranch: (v) => typeof v === 'string' && v.trim().length > 0,
  autoPush: (v) => typeof v === 'boolean',
  semanticMerge: (v) => typeof v === 'boolean',
  cloneFilter: (v) => v === null || (typeof v === 'string' && v.trim().length > 0),
  pruneDays: (v) => Number.isInteger(v) && v >= 0,
  logMaxBytes: (v) => isValidRotation(v, DEFAULT_LOG_GENERATIONS),
  logGenerations: (v) => isValidRotation(DEFAULT_LOG_MAX_BYTES, v),
  autoRebase: (v) => typeof v === 'boolean',
  autoStash: (v) => typeof v === 'boolean',
  webhookUrl: (v) => v === null || (typeof v === 'string' && /^https?:\/\//.test(v)),
  notifiers: (v) =>
    Array.isArray(v) &&
    v.every(
      (n) =>
        typeof n === 'object' &&
        n !== null &&
        !Array.isArray(n) &&
        ['slack', 'discord', 'generic'].includes(n.type) &&
        // Exactement une source d'URL : les deux à la fois est une ambiguïté
        // (laquelle prime ?), aucune des deux est une entrée morte.
        (typeof n.url === 'string'
          ? /^https?:\/\//.test(n.url) && n.urlEnv === undefined
          : typeof n.urlEnv === 'string' && n.urlEnv.trim().length > 0),
    ),
  dashboardPort: (v) => Number.isInteger(v) && v >= 0 && v <= 65535,
  // Bornes : un lien de plus de 24 h ou une session de plus de 30 jours ne
  // sont plus des secrets éphémères ; un seuil sous 64 Kio couperait des
  // clients sains sur un état ordinaire.
  // Motifs stricts (hosts.ts). Le refus nomme la raison et l'INDEX de l'entrée,
  // jamais sa valeur (details part tel quel en --json et dans les logs).
  dashboardHostname: (v) => v === 'instance' || v === 'localhost',
  dashboardAllowedHosts: (v) => {
    const parsed = parseAllowedHosts(v);
    if ('rules' in parsed) return true;
    throw new StriartError('Valeur invalide pour "dashboardAllowedHosts" dans la config Striart', {
      code: 'CONFIG_INVALID',
      hint: 'striart doctor',
      details: {
        reason: 'HOST_PATTERN',
        key: 'dashboardAllowedHosts',
        problem: parsed.problem,
        field:
          parsed.index === null
            ? 'dashboardAllowedHosts'
            : `dashboardAllowedHosts[${parsed.index}]`,
      },
    });
  },
  dashboardLinkTtlMs: (v) => Number.isInteger(v) && v >= 10_000 && v <= 86_400_000,
  dashboardSessionTtlMs: (v) => Number.isInteger(v) && v >= 60_000 && v <= 2_592_000_000,
  controlSseMaxBufferedBytes: (v) => Number.isInteger(v) && v >= 65_536 && v <= 268_435_456,
  controlStateMaxDelayMs: (v) => Number.isInteger(v) && v >= 300 && v <= 60_000,
  fetchIntervalMs: (v) => Number.isInteger(v) && (v === 0 || v >= 1000),
  testTimeoutMs: (v) => Number.isInteger(v) && v >= 1000 && v <= MAX_TIMER_MS,
  gateOrphanGraceMs: (v) => Number.isInteger(v) && v >= 0 && v <= 600_000,
  gateMaxOutputBytes: (v) => Number.isInteger(v) && v >= 1_024 && v <= 1_073_741_824,
  gateContainer: (v) => v === 'native' || v === 'process',
  mainBranch: (v) => v === null || (typeof v === 'string' && v.trim().length > 0),
  promoteTestCommand: (v) => v === null || (typeof v === 'string' && v.trim().length > 0),
  semanticGateRetries: (v) => Number.isInteger(v) && v >= 0 && v <= 5,
  // Syntaxe gitignore sans négation ni commentaire (secret-patterns.ts) : un
  // motif que les deux évaluateurs (git, JS) liraient différemment est refusé.
  secretPatterns: (v) =>
    Array.isArray(v) &&
    v.every((p) => {
      if (typeof p !== 'string') return false;
      try {
        assertSecretPatternSyntax(p);
        return true;
      } catch {
        // Motif non supporté : la validation répond « invalide » (CONFIG_INVALID).
        return false;
      }
    }),
  memoryLayer: (v) => typeof v === 'boolean',
  memoryMaxEntries: (v) => Number.isInteger(v) && v >= 1 && v <= 500,
  presenceMinutes: (v) => Number.isInteger(v) && v >= 1 && v <= 1440,
  llm: (v) => v === null || (typeof v === 'object' && !Array.isArray(v)),
  agentCommand: (v) => v === null || (typeof v === 'string' && v.trim().length > 0),
  // Source unique de validation d'un profil : src/agents/profile-schema.ts
  // (marqueur {{prompt}} obligatoire en argv / interdit en ACP, env, timeout,
  // champs du catalogue, contrat de commit). Une entrée `{ preset }` sans
  // `command` doit nommer un preset connu ; elle est validée UNE FOIS
  // matérialisée — ce que la session exécutera vraiment.
  agentProfiles: (v) =>
    typeof v === 'object' &&
    v !== null &&
    !Array.isArray(v) &&
    Object.entries(v).every(([name, p]) => {
      if (typeof p !== 'object' || p === null || Array.isArray(p)) return false;
      const profile =
        p.preset !== undefined && p.command === undefined
          ? typeof p.preset === 'string' && getPreset(p.preset)
            ? expandAgentProfiles({ x: p }).x
            : null
          : p;
      if (!profile) return false;
      // Options ACP : la raison et le champ remontent (mêmes règles que la
      // session, src/acp/protocol.ts) — jamais la valeur.
      const acpProblem = acpProfileProblem(profile);
      if (acpProblem) {
        throw new StriartError(
          `Valeur invalide pour "agentProfiles.${name}.${acpProblem.field}" dans la config Striart`,
          {
            code: 'CONFIG_INVALID',
            hint: 'striart doctor',
            details: {
              reason: 'INVALID_VALUE',
              key: 'agentProfiles',
              profile: name,
              field: acpProblem.field,
            },
          },
        );
      }
      return isValidAgentProfile(profile);
    }),
  agentInstructions: (v) => isValidAgentInstructionsConfig(v),
  acpRegistry: (v) => isValidAcpRegistryConfig(v),
  // Proxy `striart acp` (lot I10) : le champ fautif remonte, jamais la valeur.
  acpAgent: (v) => {
    const field = acpAgentSettingsProblem(v);
    if (field) {
      throw new StriartError(`Valeur invalide pour "${field}" dans la config Striart`, {
        code: 'CONFIG_INVALID',
        hint: 'striart doctor',
        details: { reason: 'INVALID_VALUE', key: 'acpAgent', field },
      });
    }
    return true;
  },
  autonomousTimeoutMs: (v) => Number.isInteger(v) && v >= 1000 && v <= MAX_TIMER_MS,
  unknownConfigKeys: (v) => v === 'error' || v === 'warn',
  ollamaModel: (v) => typeof v === 'string' && v.trim().length > 0,
  ollamaHost: (v) => typeof v === 'string' && /^https?:\/\//.test(v),
  mcp: (v) => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
    const intIn = (x, min, max) => x === undefined || (Number.isInteger(x) && x >= min && x <= max);
    const known = new Set([
      'scope',
      'apps',
      'tasks',
      'taskTtlMs',
      'taskPollIntervalMs',
      'maxLineBytes',
      'maxConcurrentRequests',
      'maxQueuedRequests',
    ]);
    return (
      // Clé inconnue refusée : une faute de frappe (« scop ») laisserait le
      // défaut s'appliquer en silence alors que l'utilisateur croit avoir
      // configuré autre chose.
      Object.keys(v).every((k) => known.has(k)) &&
      (v.scope === undefined || v.scope === 'agent' || v.scope === 'orchestrator') &&
      (v.apps === undefined || typeof v.apps === 'boolean') &&
      (v.tasks === undefined || typeof v.tasks === 'boolean') &&
      intIn(v.taskTtlMs, 60_000, 7 * 24 * 3_600_000) &&
      intIn(v.taskPollIntervalMs, 100, 60_000) &&
      intIn(v.maxLineBytes, 4096, 64 * 1_048_576) &&
      intIn(v.maxConcurrentRequests, 1, 64) &&
      intIn(v.maxQueuedRequests, 0, 4096)
    );
  },
  terminal: (v) => isValidTerminalSettings(v),
  hooks: (v) => isValidHookSettings(v),
  // Clés connues seulement (une faute de frappe ne doit pas laisser croire à
  // un relâchement actif) ; 60 000 ms = délai d'expiration du battement.
  pty: (v) => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
    const bounds = {
      replayBytes: [1_024, 16_777_216],
      clientQueueBytes: [PTY_MIN_CLIENT_QUEUE_BYTES, 268_435_456],
      killGraceMs: [0, 60_000],
    };
    const keysOk = Object.entries(v).every(([k, n]) => {
      if (Object.hasOwn(bounds, k)) {
        return Number.isInteger(n) && n >= bounds[k][0] && n <= bounds[k][1];
      }
      if (k === 'shell') return isValidPtyShell(n);
      if (k === 'shellArgs') return isValidPtyShellArgs(n);
      return false;
    });
    const merged = { ...DEFAULT_CONFIG.pty, ...v };
    // La file doit accueillir le rejeu (base64) ET deux frames de sortie.
    return keysOk && merged.clientQueueBytes >= ptyMinClientQueueBytes(merged.replayBytes);
  },
  lock: (v) =>
    typeof v === 'object' &&
    v !== null &&
    !Array.isArray(v) &&
    Object.keys(v).every((k) => k === 'breakFrozenHolderAfterMs') &&
    (v.breakFrozenHolderAfterMs == null ||
      (Number.isInteger(v.breakFrozenHolderAfterMs) && v.breakFrozenHolderAfterMs >= 60_000)),
  prompts: (v) =>
    typeof v === 'object' &&
    v !== null &&
    !Array.isArray(v) &&
    Object.entries(v).every(
      ([key, tpl]) =>
        key in PROMPT_PLACEHOLDERS &&
        (tpl === null ||
          (typeof tpl === 'string' &&
            tpl.trim().length > 0 &&
            // Tous les placeholders, ou rien : un template qui en oublie un
            // enverrait au LLM un prompt amputé de ses données — silencieux
            // et faux. Refus au chargement.
            PROMPT_PLACEHOLDERS[key].every((p) => tpl.includes(p)))),
    ),
  protectedAgentPaths: (v) =>
    typeof v === 'object' &&
    v !== null &&
    !Array.isArray(v) &&
    // Une clé inconnue est une faute de frappe sur un réglage de sécurité
    // (« alow ») : refus plutôt que protection silencieusement inchangée.
    Object.keys(v).every((k) => ['extend', 'allow', 'matchCase'].includes(k)) &&
    ['extend', 'allow'].every(
      (k) =>
        v[k] === undefined ||
        (Array.isArray(v[k]) &&
          v[k].every(
            (p) =>
              typeof p === 'string' &&
              p.trim().length > 0 &&
              p === p.trim() &&
              !/[\0\\[\]{}]/.test(p) &&
              !p.startsWith('!') &&
              !p.startsWith('/') &&
              p.split('/').every((seg) => seg !== '' && seg !== '.' && seg !== '..') &&
              p.split('/').every((seg) => !seg.includes('**') || seg === '**'),
          )),
    ) &&
    (v.matchCase === undefined || ['insensitive', 'platform'].includes(v.matchCase)),
  commitPolicy: (v) => COMMIT_POLICY_VALUES.includes(v),
  orchestration: (v) => isValidOrchestrationSettings(v),
  collab: (v) => isValidCollabSettings(v),
  llmRoles: (v) => isValidLlmRoles(v),
  tokens: (v) => isValidTokensSettings(v),
  llmResilience: (v) => isValidLlmResilience(v),
  // Même règle que le `commitMessage` d'un profil (profile-schema.ts).
  commitMessage: (v) => isValidCommitMessageTemplate(v),
};

/**
 * Clés de premier niveau d'une config que Striart ne connaît pas (ni défaut ni
 * validateur). Par défaut le chargement les REFUSE (CONFIG_INVALID UNKNOWN_KEY) ;
 * sous le relâchement explicite `unknownConfigKeys: 'warn'` (config partagée entre
 * versions), elles sont tolérées et `striart doctor` les signale : une faute de frappe sur un réglage de sécurité
 * (« secretPattern ») laisserait croire à une protection active. `$schema`
 * (référence de schéma JSON de l'éditeur) n'est pas un réglage.
 * @param {Record<string, unknown>} config
 * @returns {string[]}
 */
export function listUnknownConfigKeys(config) {
  return Object.keys(config)
    .filter(
      (key) =>
        key !== 'configPath' &&
        key !== '$schema' &&
        !Object.hasOwn(DEFAULT_CONFIG, key) &&
        !Object.hasOwn(VALIDATORS, key),
    )
    .sort();
}

/** Clés de premier niveau admises sans validateur (référence de schéma JSON de l'éditeur). */
const META_KEYS = new Set(['$schema']);

/** Distance d'édition (Levenshtein) bornée : suffisant pour suggérer une faute de frappe. */
function editDistance(a, b) {
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= b.length; j += 1) {
      current[j] = Math.min(
        previous[j] + 1,
        current[j - 1] + 1,
        previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    previous = current;
  }
  return previous[b.length];
}

/** La clé connue la plus proche (distance <= 3), null si rien ne ressemble. */
function closestKnownKey(key) {
  let best = null;
  let bestDistance = 4;
  for (const known of new Set([...Object.keys(DEFAULT_CONFIG), ...Object.keys(VALIDATORS)])) {
    const distance = editDistance(key.toLowerCase(), known.toLowerCase());
    if (distance < bestDistance) {
      best = known;
      bestDistance = distance;
    }
  }
  return best;
}

export function validateConfig(userConfig) {
  const knownKeys = new Set([...Object.keys(DEFAULT_CONFIG), ...Object.keys(VALIDATORS)]);
  const unknownMode = userConfig.unknownConfigKeys ?? DEFAULT_CONFIG.unknownConfigKeys;
  for (const [key, value] of Object.entries(userConfig)) {
    const validator = VALIDATORS[key];
    if (!validator) {
      if (knownKeys.has(key) || META_KEYS.has(key)) continue;
      // Clé inconnue : une faute de frappe sur un réglage de sécurité laisserait
      // la protection à son défaut sans que personne le voie → refus, sauf
      // relâchement explicite (`unknownConfigKeys: 'warn'`, journalisé).
      const suggestion = closestKnownKey(key);
      if (unknownMode === 'warn') {
        logger.warn(
          { key, suggestion },
          'Clé de config inconnue ignorée (unknownConfigKeys: warn)',
        );
        continue;
      }
      throw new StriartError(
        `Clé inconnue "${key}" dans la config Striart${suggestion ? ` (voulais-tu "${suggestion}" ?)` : ''}`,
        {
          code: 'CONFIG_INVALID',
          hint: 'striart doctor',
          details: { reason: 'UNKNOWN_KEY', key, suggestion },
        },
      );
    }
    if (!validator(value)) {
      throw new StriartError(`Valeur invalide pour "${key}" dans la config Striart`, {
        code: 'CONFIG_INVALID',
        hint: 'striart doctor',
        // La clé seule : la valeur peut porter un secret (env de profil, URL
        // de webhook) et details part tel quel en --json et dans les logs.
        details: { reason: 'INVALID_VALUE', key },
      });
    }
  }
}

/** Posé par les chargeurs neutralisés à la place d'un fichier exécutable. */
const CODE_CONFIG_MARKER = '__striartCodeConfig';
/** @param {string} filepath */
const refuseToExecute = (filepath) => ({ [CODE_CONFIG_MARKER]: filepath });

/**
 * Trouve la config Striart EXACTEMENT comme loadConfig (mêmes emplacements,
 * même ordre de recherche), sans jamais exécuter de code : les formats
 * exécutables (.js/.mjs/.cjs/.ts, y compris atteints par un `$import`) sont
 * repérés sans être chargés. Pour les contextes où exécuter la config du
 * dépôt n'est pas une décision de l'utilisateur — la complétion Tab, que
 * rien ne signale comme un déclencheur d'exécution.
 * @param {string} cwd
 * @returns {Promise<{kind: 'none'} | {kind: 'code', filepath: string} | {kind: 'data', filepath: string, config: Record<string, unknown>}>}
 */
export async function findConfigWithoutExecuting(cwd) {
  const explorer = cosmiconfig('striart', {
    loaders: {
      '.js': refuseToExecute,
      '.mjs': refuseToExecute,
      '.cjs': refuseToExecute,
      '.ts': refuseToExecute,
    },
  });
  const result = await explorer.search(cwd);
  if (!result) return { kind: 'none' };
  if (result.config && Object.hasOwn(result.config, CODE_CONFIG_MARKER)) {
    return { kind: 'code', filepath: result.filepath };
  }
  return { kind: 'data', filepath: result.filepath, config: result.config ?? {} };
}

/**
 * Charge striart.config.js / .striartrc.* via cosmiconfig,
 * fusionne avec les valeurs par défaut.
 */
/** @param {string} [cwd] @returns {Promise<import('./types.js').StriartConfig>} */
export async function loadConfig(cwd = process.cwd()) {
  const explorer = cosmiconfig('striart');
  let result;
  try {
    result = await explorer.search(cwd);
  } catch (error) {
    throw new StriartError(`Impossible de lire la config Striart : ${error.message}`, {
      code: 'CONFIG_INVALID',
      hint: 'striart doctor',
      details: { reason: 'UNREADABLE', cause: error.message },
    });
  }
  const userConfig = result?.config ?? {};
  validateConfig(userConfig);
  return {
    ...DEFAULT_CONFIG,
    ...userConfig,
    // Fusion par clé, contrairement au reste de la config : déclarer un
    // profil "kimi" doit AJOUTER un fournisseur, pas effacer claude/codex/
    // aider/ollama. Redéfinir une clé existante l'emporte toujours.
    // Les entrées `{ preset }` sont matérialisées ici, une fois : tous les
    // consommateurs (session, ACP, dashboard, doctor) voient le profil réel.
    // Défauts relus comme références de preset : un `commitPolicy` global
    // DÉCLARÉ par l'utilisateur s'y applique (sinon le défaut du preset).
    agentProfiles: expandAgentProfiles(
      { ...defaultAgentProfileRefs(), ...(userConfig.agentProfiles ?? {}) },
      { commitPolicy: userConfig.commitPolicy ?? null },
    ),
    // Fusion par clé : surcharger le gabarit ne doit pas effacer la
    // convention de commit ni la politique AGENTS.md par défaut.
    agentInstructions: {
      ...DEFAULT_CONFIG.agentInstructions,
      ...(userConfig.agentInstructions ?? {}),
    },
    acpRegistry: { ...DEFAULT_CONFIG.acpRegistry, ...(userConfig.acpRegistry ?? {}) },
    // Même fusion par clé : surcharger le prompt du Router ne doit pas faire
    // disparaître celui du Merger (le shallow-merge global l'écraserait).
    prompts: { ...DEFAULT_CONFIG.prompts, ...(userConfig.prompts ?? {}) },
    configPath: result?.filepath ?? null,
  };
}

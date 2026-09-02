import { cosmiconfig } from 'cosmiconfig';
import { StriartError } from './errors.js';

export const DEFAULT_CONFIG = {
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
  pruneDays: 14,
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
  // Pipeline staging → main : si mainBranch est défini, targetBranch joue le
  // rôle de staging (ex: 'striart/staging') et `striart promote` fait avancer
  // mainBranch en fast-forward après un Test Gate global. null → désactivé.
  mainBranch: null,
  // Gate global de la promotion (tests d'intégration complets).
  // null → réutilise testCommand.
  promoteTestCommand: null,
  // Délai max du Test Gate : au-delà, le process de test est tué → gate rouge.
  testTimeoutMs: 600000,
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
  agentProfiles: {
    claude: { command: 'claude', args: ['-p', '{{prompt}}'] },
    codex: { command: 'codex', args: ['exec', '{{prompt}}'] },
    aider: { command: 'aider', args: ['--yes', '--message', '{{prompt}}'] },
    ollama: { command: 'ollama', args: ['run', 'qwen2.5-coder', '{{prompt}}'] },
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
};

/** Placeholders obligatoires par template surchargeable. */
export const PROMPT_PLACEHOLDERS = {
  router: ['{{task}}', '{{files}}'],
  merger: ['{{file}}', '{{base}}', '{{ours}}', '{{theirs}}', '{{feedback}}'],
};

const VALIDATORS = {
  testCommand: (v) => typeof v === 'string' && v.trim().length > 0,
  targetBranch: (v) => typeof v === 'string' && v.trim().length > 0,
  autoPush: (v) => typeof v === 'boolean',
  semanticMerge: (v) => typeof v === 'boolean',
  cloneFilter: (v) => v === null || (typeof v === 'string' && v.trim().length > 0),
  pruneDays: (v) => Number.isInteger(v) && v >= 0,
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
  fetchIntervalMs: (v) => Number.isInteger(v) && (v === 0 || v >= 1000),
  testTimeoutMs: (v) => Number.isInteger(v) && v >= 1000,
  mainBranch: (v) => v === null || (typeof v === 'string' && v.trim().length > 0),
  promoteTestCommand: (v) => v === null || (typeof v === 'string' && v.trim().length > 0),
  semanticGateRetries: (v) => Number.isInteger(v) && v >= 0 && v <= 5,
  secretPatterns: (v) =>
    Array.isArray(v) && v.every((p) => typeof p === 'string' && p.trim().length > 0),
  memoryLayer: (v) => typeof v === 'boolean',
  memoryMaxEntries: (v) => Number.isInteger(v) && v >= 1 && v <= 500,
  presenceMinutes: (v) => Number.isInteger(v) && v >= 1 && v <= 1440,
  llm: (v) => v === null || (typeof v === 'object' && !Array.isArray(v)),
  agentCommand: (v) => v === null || (typeof v === 'string' && v.trim().length > 0),
  agentProfiles: (v) =>
    typeof v === 'object' &&
    v !== null &&
    !Array.isArray(v) &&
    Object.values(v).every(
      (p) =>
        typeof p === 'object' &&
        p !== null &&
        !Array.isArray(p) &&
        typeof p.command === 'string' &&
        p.command.trim().length > 0 &&
        Array.isArray(p.args) &&
        p.args.every((a) => typeof a === 'string') &&
        // acp optionnel : true (politique par défaut) ou
        // { permissions, askTimeoutMs } — 'ask' = arbitrage humain (Phase F).
        (p.acp == null ||
          typeof p.acp === 'boolean' ||
          (typeof p.acp === 'object' &&
            !Array.isArray(p.acp) &&
            (p.acp.permissions == null || ['allow', 'reject', 'ask'].includes(p.acp.permissions)) &&
            (p.acp.askTimeoutMs == null ||
              (Number.isInteger(p.acp.askTimeoutMs) && p.acp.askTimeoutMs >= 1000)))) &&
        // Le marqueur {{prompt}} suit le transport, un seul canal par profil.
        // Argv : OBLIGATOIRE — sans lui le prompt ne serait jamais transmis et
        // l'agent sortirait en 0 sans rien faire, un faux succès. ACP :
        // INTERDIT — le prompt passe par le protocole, un placeholder signale
        // une config recopiée d'un profil argv. Refus au chargement.
        (p.acp
          ? !p.args.some((a) => a.includes('{{prompt}}'))
          : p.args.some((a) => a.includes('{{prompt}}'))) &&
        // env optionnel : table de chaînes → chaînes (valeurs littérales).
        (p.env == null ||
          (typeof p.env === 'object' &&
            !Array.isArray(p.env) &&
            Object.values(p.env).every((x) => typeof x === 'string'))) &&
        // timeout optionnel : entier de millisecondes ≥ 1000.
        (p.timeout == null || (Number.isInteger(p.timeout) && p.timeout >= 1000)),
    ),
  autonomousTimeoutMs: (v) => Number.isInteger(v) && v >= 1000,
  ollamaModel: (v) => typeof v === 'string' && v.trim().length > 0,
  ollamaHost: (v) => typeof v === 'string' && /^https?:\/\//.test(v),
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
};

export function validateConfig(userConfig) {
  for (const [key, value] of Object.entries(userConfig)) {
    const validator = VALIDATORS[key];
    if (!validator) continue; // clé inconnue : tolérée, réservée aux phases suivantes
    if (!validator(value)) {
      throw new StriartError(`Valeur invalide pour "${key}" dans la config Striart`, {
        code: 'CONFIG_INVALID',
        details: { key, value },
      });
    }
  }
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
      details: { cause: error.message },
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
    agentProfiles: { ...DEFAULT_CONFIG.agentProfiles, ...(userConfig.agentProfiles ?? {}) },
    // Même fusion par clé : surcharger le prompt du Router ne doit pas faire
    // disparaître celui du Merger (le shallow-merge global l'écraserait).
    prompts: { ...DEFAULT_CONFIG.prompts, ...(userConfig.prompts ?? {}) },
    configPath: result?.filepath ?? null,
  };
}

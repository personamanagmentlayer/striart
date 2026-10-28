/**
 * Réglages `config.tokens` (lot T) : comptabilité, budgets, optimisation.
 *
 * Principe : chaque seuil et chaque stratégie est une clé validée avec un
 * défaut SÛR ; relâcher une protection (comptabilité coupée, plafonds en
 * alerte seule, cache de décisions élargi…) est explicite, journalisé et
 * affiché par `striart doctor` (`tokensRelaxations`). Une clé inconnue est
 * refusée au chargement : une faute de frappe sur un plafond laisserait
 * croire à une protection absente.
 *
 * Défauts : comptabilité TOUJOURS active, plafonds OPT-IN (null), alertes à
 * des seuils absolus documentés (warn seulement, jamais bloquants).
 */
import { globPatternProblem } from '../glob-lite.ts';
import { DEFAULT_SHARED_PATTERNS } from '../router-shared.ts';
import type { BudgetScope } from '../types.js';

type Rec = Record<string, unknown>;

export interface BudgetLimits {
  /** Plafond cumulé (entrée + sortie, cache inclus) ; null = pas de plafond. */
  maxTokens: number | null;
  /** Plafond de coût en USD ; exige un prix déclaré (`pricing`) ; null = pas de plafond. */
  maxCostUsd: number | null;
}

export interface CallLimits extends BudgetLimits {
  /** Entrée maximale d'UN appel (estimée avant envoi, refus fail closed). */
  maxInputTokens: number | null;
  /** Sortie maximale d'UN appel (transmise au fournisseur ; une sortie coupée est une erreur). */
  maxOutputTokens: number | null;
}

export interface PriceEntry {
  inputPerMTok: number;
  outputPerMTok: number;
  cacheReadPerMTok?: number;
  cacheWritePerMTok?: number;
  /** Date de relevé du prix (YYYY-MM-DD) — obligatoire : un prix non daté ne vaut rien. */
  asOf: string;
}

export interface TokensSettings {
  /** false = relâchement : plus aucun relevé (budgets et usage aveugles). */
  accounting: boolean;
  /**
   * Que faire quand le relevé d'usage ou la relecture des cumuls échoue :
   * 'warn' (défaut) journalise avec le code TOKEN_ACCOUNTING_FAILED et ne perd
   * jamais la réponse d'un appel payé ; 'fail' refuse (budgets jamais aveugles).
   */
  onAccountingError: 'warn' | 'fail';
  /** Rétention du registre `.striart/usage/` (jours), appliquée par `striart prune`. */
  retentionDays: number;
  /** `provider:model` ou `model` → prix. Vide par défaut : aucun prix en dur. */
  pricing: Record<string, PriceEntry>;
  /** Âge (jours) au-delà duquel un prix est signalé périmé par doctor. */
  pricingStaleAfterDays: number;
  estimator: {
    /** Marge de prudence multipliée à l'estimation (>= 1). */
    safetyFactor: number;
    /** Caractères par jeton avant calibration (bas = prudent). */
    charsPerToken: number;
  };
  budgets: {
    /** 'hard' : un plafond posé refuse ; 'alert-only' : relâchement, il ne fait qu'alerter. */
    enforcement: 'hard' | 'alert-only';
    /** Fraction d'un plafond qui déclenche l'alerte « warn ». */
    warnAtRatio: number;
    perCall: CallLimits;
    perTask: BudgetLimits;
    perAgent: BudgetLimits;
    perDay: BudgetLimits;
    global: BudgetLimits;
  };
  /** Seuils d'alerte absolus (warn seulement) tant qu'aucun plafond n'est posé ; null = désactivé. */
  alerts: {
    callInputTokens: number | null;
    taskTokens: number | null;
    dayTokens: number | null;
  };
  router: {
    /** Que faire quand un budget interdit l'appel du Router : sérialiser prudemment ou échouer. */
    onBudgetExceeded: 'serialize' | 'fail';
    /**
     * Que faire quand la liste de fichiers soumise au Router a dû être coupée
     * (plus de `tree.maxFiles` fichiers suivis) : 'serialize' (défaut, prudent) —
     * sentinelle « tout le dépôt », la tâche attend les agents actifs, aucun appel
     * LLM sur une vue partielle ; 'predict' — le LLM prédit sur la vue partielle,
     * dont le prompt déclare la troncature (un faux négatif reste rattrapé par le
     * Merger et le Test Gate).
     */
    onTreeTruncated: 'serialize' | 'predict';
    tree: {
      /**
       * Nombre maximal de fichiers suivis lus avant le Router (garde mémoire/temps
       * sur les très gros dépôts). Au-delà : troncature DÉCLARÉE, jamais silencieuse
       * (événement, journal, prompt) et `onTreeTruncated` s'applique.
       */
      maxFiles: number;
      mode: 'auto' | 'full' | 'compact';
      /** Au-delà (estimé), l'arbre est classé par pertinence et le reste résumé par dossier. */
      maxTreeTokens: number;
      /** Motifs (globs simples * et **) retirés de l'arbre soumis au LLM. */
      exclude: string[];
      /** Étend les candidats par le graphe d'imports quand l'arbre déborde. */
      importExpansion: boolean;
    };
    /**
     * Réglage d'ensemble : 'balanced' (défaut, mesuré par `bench:router`), 'recall' (rappel
     * maximal : plus d'expansion, plus de sérialisation) ou 'legacy' (comportement d'avant
     * le lot de fiabilité du Router, à l'identique). Les clés explicites priment sur le préréglage.
     */
    preset: 'balanced' | 'recall' | 'legacy';
    /**
     * Gabarit de prompt : 'legacy' = consignes historiques (liste de chemins, 1 à 5) ;
     * 'v3' = demande de confiance par fichier, d'exhaustivité (tests, types, contrats) et de portée.
     */
    prompt: 'legacy' | 'v3';
    /** Carte du dépôt (symboles + première ligne de doc) des fichiers les plus proches de la tâche. */
    map: {
      /** 'off' ou 'candidates' (carte des `candidates` meilleurs candidats lexicaux, ajoutée à la demande). */
      mode: 'off' | 'candidates';
      candidates: number;
    };
    /** Récupération lexicale déterministe (BM25 sur chemins + symboles + docs ; pont français → anglais). */
    retrieval: { enabled: boolean; bilingual: boolean };
    /** Expansion déterministe après le LLM (tests, imports, jumeaux, historique). */
    expansion: {
      imports: 'off' | 'importees' | 'importers' | 'both';
      depth: 1 | 2;
      tests: boolean;
      siblings: boolean;
      contracts: boolean;
      coChange: boolean;
      /** Nombre maximal de fichiers ajoutés par l'expansion. */
      maxAdded: number;
    };
    /** Fichiers du LLM de confiance inférieure à ce seuil : écartés (0 = tous gardés). */
    minFileConfidence: number;
    /** Au plus ce nombre de fichiers retenus parmi ceux du LLM (les plus sûrs d'abord). */
    maxFiles: number;
    /** Détection des tâches vagues/transverses → sérialisation prudente (sentinelle « tout le dépôt »). */
    vague: {
      enabled: boolean;
      /** Confiance globale du LLM en dessous de laquelle la tâche est jugée vague. */
      minConfidence: number;
      /** Plus de fichiers que cela retenus par le LLM : tâche transverse. null = pas de seuil. */
      maxFiles: number | null;
      /** Verbes/expressions transverses (refactor, renommer, migrer, partout…) — signal faible. */
      verbs: boolean;
    };
    /** Fichiers de tenue de livre (CHANGELOG, README, docs, manifestes, verrous). */
    sharedFiles: {
      /** 'exclude' : retirés de la prédiction de collision (conservés dans les détails) ; 'keep' : historique. */
      mode: 'exclude' | 'keep';
      patterns: string[];
    };
    /** Historique de co-modification : nombre de commits récents relus. */
    history: { limit: number };
    /**
     * Au-delà de ce nombre de fichiers suivis, le contenu n'est PAS lu (carte, symboles,
     * graphe d'imports) : la récupération lexicale et l'appariement par nom restent
     * disponibles sur les seuls chemins. Borne le coût du premier passage sur un très gros dépôt.
     */
    maxScanFiles: number;
  };
  merger: {
    /** 'auto' : par hunk au-delà de hunkThresholdChars ; 'full' : trois versions entières ; 'hunk' : toujours par hunk. */
    mode: 'auto' | 'full' | 'hunk';
    hunkThresholdChars: number;
    /** Lignes de contexte autour de chaque région en conflit. */
    contextLines: number;
    /** Fenêtre max (jetons estimés) d'un appel de fusion ; au-delà → ticket, jamais de troncature. */
    maxWindowTokens: number;
  };
  memory: {
    maxEntryChars: number;
    maxTotalChars: number;
    /** Taille max du diff filtré envoyé au LLM (marqué explicitement s'il est coupé). */
    diffMaxChars: number;
    /** Retire/remplace les puces déjà connues au lieu de les empiler. */
    dedupe: boolean;
  };
  promptCache: {
    /** Marque le préfixe stable avec cache_control (Anthropic) ; les autres fournisseurs cachent automatiquement. */
    enabled: boolean;
    ttl: '5m' | '1h';
    /** En deçà (estimé), aucun point de cache n'est posé (inutile et coûteux). */
    minPrefixTokens: number;
  };
  /** Cache de résultats LLM idempotents. Jamais pour une décision de sécurité. */
  cache: {
    enabled: boolean;
    roles: Array<'router' | 'merger' | 'memory'>;
    ttlMs: number;
    maxEntries: number;
  };
  instructions: {
    /** 'compact' : gabarit court de consignes (sauf gabarit explicite de l'utilisateur). */
    mode: 'full' | 'compact';
  };
}

export type TokensConfigInput = DeepPartial<TokensSettings>;

type DeepPartial<T> = T extends readonly unknown[]
  ? T
  : T extends object
    ? { [K in keyof T]?: DeepPartial<T[K]> }
    : T;

const NO_LIMITS: BudgetLimits = Object.freeze({ maxTokens: null, maxCostUsd: null });

export const DEFAULT_TOKENS_SETTINGS: TokensSettings = Object.freeze({
  accounting: true,
  onAccountingError: 'warn',
  retentionDays: 90,
  pricing: Object.freeze({}) as Record<string, PriceEntry>,
  pricingStaleAfterDays: 90,
  estimator: Object.freeze({ safetyFactor: 1.15, charsPerToken: 3 }),
  budgets: Object.freeze({
    enforcement: 'hard',
    warnAtRatio: 0.8,
    perCall: Object.freeze({
      maxInputTokens: null,
      maxOutputTokens: null,
      maxTokens: null,
      maxCostUsd: null,
    }),
    perTask: NO_LIMITS,
    perAgent: NO_LIMITS,
    perDay: NO_LIMITS,
    global: NO_LIMITS,
  }),
  alerts: Object.freeze({
    callInputTokens: 150_000,
    taskTokens: 20_000_000,
    dayTokens: 100_000_000,
  }),
  router: Object.freeze({
    onBudgetExceeded: 'serialize',
    onTreeTruncated: 'serialize',
    tree: Object.freeze({
      maxFiles: 50_000,
      mode: 'auto',
      maxTreeTokens: 6000,
      exclude: Object.freeze([
        '**/node_modules/**',
        '**/dist/**',
        '**/build/**',
        '**/coverage/**',
        '**/vendor/**',
        '**/*.min.js',
        '**/*.map',
        ...[
          'png',
          'jpg',
          'jpeg',
          'gif',
          'webp',
          'ico',
          'pdf',
          'woff',
          'woff2',
          'ttf',
          'eot',
          'mp3',
          'mp4',
          'zip',
          'gz',
          'tgz',
        ].map((ext) => `**/*.${ext}`),
      ]) as unknown as string[],
      importExpansion: true,
    }),
    preset: 'balanced',
    prompt: 'v3',
    map: Object.freeze({ mode: 'candidates', candidates: 40 }),
    retrieval: Object.freeze({ enabled: true, bilingual: true }),
    expansion: Object.freeze({
      imports: 'off',
      depth: 1,
      tests: true,
      siblings: false,
      contracts: false,
      coChange: false,
      maxAdded: 6,
    }),
    minFileConfidence: 0.5,
    maxFiles: 6,
    vague: Object.freeze({ enabled: true, minConfidence: 0.3, maxFiles: null, verbs: false }),
    sharedFiles: Object.freeze({
      mode: 'exclude',
      patterns: Object.freeze([...DEFAULT_SHARED_PATTERNS]) as unknown as string[],
    }),
    history: Object.freeze({ limit: 400 }),
    maxScanFiles: 5000,
  }),
  merger: Object.freeze({
    mode: 'auto',
    hunkThresholdChars: 16_000,
    contextLines: 5,
    maxWindowTokens: 30_000,
  }),
  memory: Object.freeze({
    maxEntryChars: 1200,
    maxTotalChars: 12_000,
    diffMaxChars: 8000,
    dedupe: true,
  }),
  promptCache: Object.freeze({ enabled: true, ttl: '5m', minPrefixTokens: 1024 }),
  cache: Object.freeze({
    enabled: true,
    roles: Object.freeze(['router', 'memory']) as unknown as Array<'router' | 'memory'>,
    ttlMs: 600_000,
    maxEntries: 200,
  }),
  instructions: Object.freeze({ mode: 'full' }),
}) as TokensSettings;

const isObject = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v);
const onlyKeys = (v: Rec, keys: readonly string[]) => Object.keys(v).every((k) => keys.includes(k));
const intIn = (x: unknown, min: number, max: number) =>
  x === undefined || (Number.isInteger(x) && (x as number) >= min && (x as number) <= max);
const numIn = (x: unknown, min: number, max: number) =>
  x === undefined ||
  (typeof x === 'number' && Number.isFinite(x) && (x as number) >= min && (x as number) <= max);
const nullableInt = (x: unknown, min: number, max: number) =>
  x === undefined || x === null || intIn(x, min, max);
const nullableNum = (x: unknown, min: number, max: number) =>
  x === undefined || x === null || numIn(x, min, max);
const oneOf = (x: unknown, values: readonly string[]) =>
  x === undefined || (typeof x === 'string' && values.includes(x));
const bool = (x: unknown) => x === undefined || typeof x === 'boolean';
const sub = (v: unknown, check: (s: Rec) => boolean) =>
  v === undefined || (isObject(v) && check(v));

const MAX_TOKENS = 1_000_000_000_000;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function validLimits(s: Rec, extra: readonly string[] = []): boolean {
  return (
    onlyKeys(s, ['maxTokens', 'maxCostUsd', ...extra]) &&
    nullableInt(s.maxTokens, 1, MAX_TOKENS) &&
    nullableNum(s.maxCostUsd, 0, 1_000_000_000)
  );
}

function validPrice(p: unknown): boolean {
  if (!isObject(p)) return false;
  if (
    !onlyKeys(p, ['inputPerMTok', 'outputPerMTok', 'cacheReadPerMTok', 'cacheWritePerMTok', 'asOf'])
  ) {
    return false;
  }
  const price = (x: unknown) =>
    typeof x === 'number' && Number.isFinite(x) && x >= 0 && x <= 100_000;
  if (!price(p.inputPerMTok) || !price(p.outputPerMTok)) return false;
  if (p.cacheReadPerMTok !== undefined && !price(p.cacheReadPerMTok)) return false;
  if (p.cacheWritePerMTok !== undefined && !price(p.cacheWritePerMTok)) return false;
  if (typeof p.asOf !== 'string' || !DATE_RE.test(p.asOf)) return false;
  return !Number.isNaN(Date.parse(`${p.asOf}T00:00:00Z`));
}

/** Motif de glob ancré (grammaire de src/glob-lite.ts, partagée avec la garde des chemins protégés). */
function validGlob(p: unknown): boolean {
  return typeof p === 'string' && p.length <= 300 && globPatternProblem(p) === null;
}

/** Valide `config.tokens` (objet partiel, clés connues seulement). */
export function isValidTokensSettings(v: unknown): boolean {
  if (!isObject(v)) return false;
  const top = [
    'accounting',
    'onAccountingError',
    'retentionDays',
    'pricing',
    'pricingStaleAfterDays',
    'estimator',
    'budgets',
    'alerts',
    'router',
    'merger',
    'memory',
    'promptCache',
    'cache',
    'instructions',
  ];
  if (!onlyKeys(v, top)) return false;
  return (
    bool(v.accounting) &&
    oneOf(v.onAccountingError, ['warn', 'fail']) &&
    intIn(v.retentionDays, 1, 3650) &&
    intIn(v.pricingStaleAfterDays, 1, 3650) &&
    sub(v.pricing, (s) =>
      Object.entries(s).every(([k, p]) => k.trim().length > 0 && validPrice(p)),
    ) &&
    sub(
      v.estimator,
      (s) =>
        onlyKeys(s, ['safetyFactor', 'charsPerToken']) &&
        numIn(s.safetyFactor, 1, 5) &&
        numIn(s.charsPerToken, 1, 8),
    ) &&
    sub(
      v.budgets,
      (b) =>
        onlyKeys(b, [
          'enforcement',
          'warnAtRatio',
          'perCall',
          'perTask',
          'perAgent',
          'perDay',
          'global',
        ]) &&
        oneOf(b.enforcement, ['hard', 'alert-only']) &&
        numIn(b.warnAtRatio, 0.01, 1) &&
        sub(
          b.perCall,
          (s) =>
            validLimits(s, ['maxInputTokens', 'maxOutputTokens']) &&
            nullableInt(s.maxInputTokens, 1, MAX_TOKENS) &&
            nullableInt(s.maxOutputTokens, 1, MAX_TOKENS),
        ) &&
        sub(b.perTask, (s) => validLimits(s)) &&
        sub(b.perAgent, (s) => validLimits(s)) &&
        sub(b.perDay, (s) => validLimits(s)) &&
        sub(b.global, (s) => validLimits(s)),
    ) &&
    sub(
      v.alerts,
      (a) =>
        onlyKeys(a, ['callInputTokens', 'taskTokens', 'dayTokens']) &&
        nullableInt(a.callInputTokens, 1, MAX_TOKENS) &&
        nullableInt(a.taskTokens, 1, MAX_TOKENS) &&
        nullableInt(a.dayTokens, 1, MAX_TOKENS),
    ) &&
    sub(
      v.router,
      (r) =>
        onlyKeys(r, [
          'onBudgetExceeded',
          'onTreeTruncated',
          'tree',
          'preset',
          'prompt',
          'map',
          'retrieval',
          'expansion',
          'minFileConfidence',
          'maxFiles',
          'vague',
          'sharedFiles',
          'history',
          'maxScanFiles',
        ]) &&
        oneOf(r.preset, ['balanced', 'recall', 'legacy']) &&
        oneOf(r.prompt, ['legacy', 'v3']) &&
        numIn(r.minFileConfidence, 0, 1) &&
        intIn(r.maxFiles, 1, 50) &&
        sub(
          r.map,
          (m) =>
            onlyKeys(m, ['mode', 'candidates']) &&
            oneOf(m.mode, ['off', 'candidates']) &&
            intIn(m.candidates, 1, 500),
        ) &&
        sub(
          r.retrieval,
          (x) => onlyKeys(x, ['enabled', 'bilingual']) && bool(x.enabled) && bool(x.bilingual),
        ) &&
        sub(
          r.expansion,
          (x) =>
            onlyKeys(x, [
              'imports',
              'depth',
              'tests',
              'siblings',
              'contracts',
              'coChange',
              'maxAdded',
            ]) &&
            oneOf(x.imports, ['off', 'importees', 'importers', 'both']) &&
            (x.depth === undefined || x.depth === 1 || x.depth === 2) &&
            bool(x.tests) &&
            bool(x.siblings) &&
            bool(x.contracts) &&
            bool(x.coChange) &&
            intIn(x.maxAdded, 0, 50),
        ) &&
        sub(
          r.vague,
          (x) =>
            onlyKeys(x, ['enabled', 'minConfidence', 'maxFiles', 'verbs']) &&
            bool(x.enabled) &&
            numIn(x.minConfidence, 0, 1) &&
            nullableInt(x.maxFiles, 1, 1000) &&
            bool(x.verbs),
        ) &&
        sub(
          r.sharedFiles,
          (x) =>
            onlyKeys(x, ['mode', 'patterns']) &&
            oneOf(x.mode, ['exclude', 'keep']) &&
            (x.patterns === undefined ||
              (Array.isArray(x.patterns) &&
                x.patterns.length <= 200 &&
                x.patterns.every(validGlob))),
        ) &&
        sub(r.history, (x) => onlyKeys(x, ['limit']) && intIn(x.limit, 10, 5000)) &&
        intIn(r.maxScanFiles, 100, 1_000_000) &&
        oneOf(r.onBudgetExceeded, ['serialize', 'fail']) &&
        oneOf(r.onTreeTruncated, ['serialize', 'predict']) &&
        sub(
          r.tree,
          (t) =>
            onlyKeys(t, ['mode', 'maxTreeTokens', 'exclude', 'importExpansion', 'maxFiles']) &&
            intIn(t.maxFiles, 100, 10_000_000) &&
            oneOf(t.mode, ['auto', 'full', 'compact']) &&
            intIn(t.maxTreeTokens, 200, 1_000_000) &&
            (t.exclude === undefined || (Array.isArray(t.exclude) && t.exclude.every(validGlob))) &&
            bool(t.importExpansion),
        ),
    ) &&
    sub(
      v.merger,
      (m) =>
        onlyKeys(m, ['mode', 'hunkThresholdChars', 'contextLines', 'maxWindowTokens']) &&
        oneOf(m.mode, ['auto', 'full', 'hunk']) &&
        intIn(m.hunkThresholdChars, 1000, 10_000_000) &&
        intIn(m.contextLines, 0, 100) &&
        intIn(m.maxWindowTokens, 1000, 5_000_000),
    ) &&
    sub(
      v.memory,
      (m) =>
        onlyKeys(m, ['maxEntryChars', 'maxTotalChars', 'diffMaxChars', 'dedupe']) &&
        intIn(m.maxEntryChars, 100, 100_000) &&
        intIn(m.maxTotalChars, 500, 1_000_000) &&
        intIn(m.diffMaxChars, 500, 1_000_000) &&
        bool(m.dedupe),
    ) &&
    sub(
      v.promptCache,
      (p) =>
        onlyKeys(p, ['enabled', 'ttl', 'minPrefixTokens']) &&
        bool(p.enabled) &&
        oneOf(p.ttl, ['5m', '1h']) &&
        intIn(p.minPrefixTokens, 1, 1_000_000),
    ) &&
    sub(
      v.cache,
      (c) =>
        onlyKeys(c, ['enabled', 'roles', 'ttlMs', 'maxEntries']) &&
        bool(c.enabled) &&
        // Seuls les rôles dont la sortie est une aide à la décision validée en
        // aval (Router → collisions, Merger → Test Gate, Memory → advisory) :
        // 'judge' et 'review' arbitrent, ils ne sont JAMAIS mis en cache.
        (c.roles === undefined ||
          (Array.isArray(c.roles) &&
            c.roles.every((r) => ['router', 'merger', 'memory'].includes(r as string)))) &&
        intIn(c.ttlMs, 1000, 30 * 86_400_000) &&
        intIn(c.maxEntries, 1, 100_000),
    ) &&
    sub(v.instructions, (i) => onlyKeys(i, ['mode']) && oneOf(i.mode, ['full', 'compact']))
  );
}

function merge<T extends object>(base: T, given: unknown): T {
  if (!isObject(given)) return base;
  const out: Rec = { ...(base as Rec) };
  for (const [k, v] of Object.entries(given)) {
    if (v === undefined) continue;
    const b = (base as Rec)[k];
    out[k] = isObject(v) && isObject(b) && k !== 'pricing' ? merge(b, v) : v;
  }
  return out as T;
}

/**
 * Préréglages du Router, EXPLICITES et complets : ils ne dépendent pas des
 * défauts du jour (un défaut qui évolue ne change pas silencieusement 'legacy').
 * 'balanced' = les défauts. Chaque valeur est mesurée par `npm run bench:router`.
 */
const ROUTER_PRESETS: Record<'recall' | 'legacy', Rec> = {
  legacy: {
    prompt: 'legacy',
    map: { mode: 'off' },
    retrieval: { enabled: false },
    expansion: {
      imports: 'off',
      tests: false,
      siblings: false,
      contracts: false,
      coChange: false,
    },
    minFileConfidence: 0,
    maxFiles: 50,
    vague: { enabled: false, maxFiles: null, verbs: false },
    sharedFiles: { mode: 'keep' },
  },
  recall: {
    minFileConfidence: 0,
    expansion: {
      imports: 'importers',
      tests: true,
      siblings: true,
      contracts: true,
      coChange: true,
      maxAdded: 8,
    },
    vague: { enabled: true, minConfidence: 0.4, maxFiles: 10 },
  },
};

/** Réglages effectifs : défauts, puis préréglage choisi, puis clés explicites de la config. */
export function resolveTokensSettings(
  config: { tokens?: unknown } | null | undefined,
): TokensSettings {
  const given = config?.tokens;
  const router = isObject(given) && isObject(given.router) ? given.router : null;
  const preset = router?.preset;
  const overrides = preset === 'legacy' || preset === 'recall' ? ROUTER_PRESETS[preset] : null;
  const base = overrides
    ? merge(DEFAULT_TOKENS_SETTINGS, { router: overrides })
    : DEFAULT_TOKENS_SETTINGS;
  return merge(base, given);
}

/**
 * Relâchements portés par `tokens`, pour `striart doctor` (anglais, comme
 * les messages d'erreur). Resserrer (poser un plafond, compacter) n'est pas
 * listé.
 */
export function tokensRelaxations(
  config: { tokens?: unknown } | null | undefined,
): Array<{ key: string; summary: string }> {
  const s = resolveTokensSettings(config);
  const out: Array<{ key: string; summary: string }> = [];
  if (!s.accounting) {
    out.push({
      key: 'tokens.accounting',
      summary:
        'tokens.accounting is false: no usage is recorded, every budget is blind and `striart usage` stays empty.',
    });
  }
  if (s.budgets.enforcement === 'alert-only' && hasAnyLimit(s)) {
    out.push({
      key: 'tokens.budgets.enforcement',
      summary:
        "tokens.budgets.enforcement is 'alert-only': configured token/cost ceilings only raise alerts, they never refuse a call or stop a session.",
    });
  }
  if (s.cache.enabled && s.cache.roles.includes('merger')) {
    out.push({
      key: 'tokens.cache.roles',
      summary:
        "tokens.cache.roles includes 'merger': an identical conflict is answered from the local cache without a model call (the Test Gate still judges the result).",
    });
  }
  // Posé EXPLICITEMENT par le dépôt (le défaut implicite n'est pas un relâchement : il
  // ferait apparaître une « protection relâchée » sur toute config vierge) : la tenue de
  // livre ne sert plus à détecter les collisions — le filet à l'exécution (src/overlap.ts)
  // applique la même politique, donc ne la voit pas non plus.
  const rawSharedMode = (
    config as { tokens?: { router?: { sharedFiles?: { mode?: unknown } } } } | null | undefined
  )?.tokens?.router?.sharedFiles?.mode;
  if (rawSharedMode === 'exclude' && s.router.sharedFiles.mode === 'exclude') {
    out.push({
      key: 'tokens.router.sharedFiles',
      summary:
        "tokens.router.sharedFiles.mode is 'exclude': bookkeeping files (CHANGELOG, README, docs, manifests, lockfiles) are left out of collision detection, both in the Router prediction and in the runtime overlap net — two agents really editing them are not signalled; the Merger resolves them.",
    });
  }
  if (s.router.onTreeTruncated === 'predict') {
    out.push({
      key: 'tokens.router.onTreeTruncated',
      summary:
        "tokens.router.onTreeTruncated is 'predict': when a repository has more tracked files than tokens.router.tree.maxFiles, the Router predicts from a PARTIAL file list (declared in its prompt) instead of serializing the task behind every active agent.",
    });
  }
  return out;
}

export function hasAnyLimit(s: TokensSettings): boolean {
  const b = s.budgets;
  return (
    Object.values(b.perCall).some((x) => x !== null) ||
    ([b.perTask, b.perAgent, b.perDay, b.global] as BudgetLimits[]).some(
      (l) => l.maxTokens !== null || l.maxCostUsd !== null,
    )
  );
}

export const BUDGET_SCOPES: readonly BudgetScope[] = [
  'perCall',
  'perTask',
  'perAgent',
  'perDay',
  'global',
];

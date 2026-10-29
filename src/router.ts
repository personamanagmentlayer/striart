import { StriartError } from './errors.ts';
import { buildImportGraph, invertImportGraph } from './imports.ts';
import { fillPromptTemplate, llmGenerate } from './llm.ts';
import { logger } from './logger.ts';
import { isSafeProjectPath, normalizeFilePath } from './project-path.ts';
import { buildCoChange, loadCoChange } from './router-cochange.ts';
import { expandPrediction } from './router-expand.ts';
import { buildRepoMap, renderMapLine } from './router-map.ts';
import { buildRetrievalIndex, retrieve } from './router-retrieval.ts';
import { compileSharedMatcher, partitionShared } from './router-shared.ts';
import { fsSources } from './router-sources.ts';
import { COMPACT_TREE_LEGEND, buildRouterTree } from './router-tree.ts';
import { vagueReasons } from './router-vague.ts';
import { sha256 } from './tokens/cache.ts';
import { resolveRoot } from './tokens/call.ts';
import { resolveTokensSettings } from './tokens/settings.ts';
import { redactSecrets } from './redact-secrets.ts';
import { compileSecretPattern, secretPatternMatches } from './secret-patterns.ts';

const ROUTER_INSTRUCTIONS = `Tu es un analyste de code. Voici la liste des fichiers d'un projet, puis une tâche de développement.
Liste UNIQUEMENT les fichiers que cette tâche va réellement modifier (1 à 5 maximum).
N'inclus PAS les fichiers voisins ou improbables : chaque fichier listé bloque les autres agents qui le touchent.
Un fichier de test n'est inclus que s'il teste directement le code modifié.
Réponds UNIQUEMENT en JSON : {"files": ["src/..."]}`;

/** Nombre maximal de fichiers demandés au LLM par le gabarit v3. */
const V3_MAX_FILES = 12;

/**
 * Consignes du gabarit v3 : la demande est supposée VAGUE (formulée avant le
 * code, sans noms de fichiers), la réponse porte une confiance par fichier, une
 * portée et une confiance globale (entrées de la détection des tâches vagues).
 */
function v3Instructions({ excludeShared }) {
  return `Tu es un analyste de code. Voici les fichiers d'un projet, puis une demande de développement formulée comme le ferait un humain AVANT d'écrire le code : elle est souvent vague et ne nomme pas les fichiers.
Prédis les fichiers que cette demande va probablement modifier ou créer, du plus certain au moins certain, avec pour chacun une confiance entre 0 et 1.
- Pense au changement COMPLET : le code principal, mais aussi les tests dont le comportement change, les fichiers de types, de contrats ou de schémas partagés, les points d'entrée (CLI, configuration, enregistrement) et les traductions jumelles qui doivent évoluer avec lui.
- N'inclus pas un fichier simplement voisin ou « peut-être utile » : chaque fichier listé bloque les autres agents qui le touchent. En dessous de 0,3 de confiance, ne le liste pas.${
    excludeShared
      ? `
- N'inclus PAS la tenue de livre (journal des changements, README, documentation, feuille de route, manifestes et verrous de dépendances) : elle est gérée à part.`
      : ''
  }
- ${V3_MAX_FILES} fichiers au maximum. Si la demande est transverse (renommage global, migration, refactor large) ou trop floue pour que tu puisses désigner les fichiers, mets "scope":"broad" et une confiance globale basse.
Réponds UNIQUEMENT en JSON : {"files":[{"path":"src/…","confidence":0.9}],"scope":"narrow","confidence":0.8}
où "scope" vaut "narrow" ou "broad" et "confidence" est ta confiance (0 à 1) que la liste est complète et juste.`;
}

export { isSafeProjectPath, normalizeFilePath };

/** Version du gabarit de prompt du Router : à incrémenter si ROUTER_INSTRUCTIONS change (invalide le cache). */
const ROUTER_PROMPT_VERSION = 'router-v2';
/** Version du gabarit v3 (consignes, schéma de réponse). */
const ROUTER_V3_PROMPT_VERSION = 'router-v3.1';

/** Sortie maximale d'une prédiction (liste de chemins ≈ quelques dizaines de jetons ; marge pour les modèles à raisonnement). */
const ROUTER_MAX_OUTPUT_TOKENS = 2048;
const ROUTER_V3_MAX_OUTPUT_TOKENS = 3072;

/**
 * Sentinelle « tout le dépôt » : prédiction rendue quand le budget interdit
 * d'appeler le LLM (`tokens.router.onBudgetExceeded: 'serialize'`) ou quand la
 * tâche est trop vague/transverse pour être prédite (`tokens.router.vague`).
 * Elle entre en collision avec TOUT agent actif (voir detectCollisions) : la
 * tâche attend que les autres finissent — la sérialisation prudente, le chemin
 * sûr du Router quand il ne sait pas.
 */
export const WHOLE_REPO = '**';

/** Mention placée sous la liste de fichiers quand elle a été coupée avant le Router. */
function truncationNote({ kept, total }) {
  return `NOTE : liste tronquée — ${kept} fichiers montrés sur ${total} suivis par git. Les autres ne sont pas listés : ne prédis que des fichiers de cette liste ou explicitement nommés par la tâche.`;
}

/**
 * Réponse du LLM → `{files: [{path, confidence}], scope, confidence}`.
 * Accepte les deux formes de `files` (chemins nus, historique ; objets avec
 * confiance, gabarit v3). Les chemins sont du contenu NON FIABLE : normalisés,
 * dédoublonnés et filtrés par isSafeProjectPath (absolus, `..` écartés).
 */
function parseRouterResponse(response) {
  const parsed = JSON.parse(response);
  if (!Array.isArray(parsed.files)) {
    throw new Error('la réponse ne contient pas de tableau "files"');
  }
  const unit = (x) => (typeof x === 'number' && x >= 0 && x <= 1 ? x : null);
  const byPath = new Map();
  for (const entry of parsed.files) {
    const raw = typeof entry === 'string' ? entry : entry?.path;
    if (typeof raw !== 'string') continue;
    const path = normalizeFilePath(raw);
    // Les chemins hallucinés hors de l'arbre (absolus, `..`) n'ont pas de sens
    // comme clés de verrou/collision.
    if (!path || !isSafeProjectPath(path)) continue;
    const confidence = typeof entry === 'string' ? null : unit(entry.confidence);
    const known = byPath.get(path);
    if (!known || (confidence ?? -1) > (known.confidence ?? -1))
      byPath.set(path, { path, confidence });
  }
  return {
    files: [...byPath.values()],
    scope: parsed.scope === 'broad' ? 'broad' : parsed.scope === 'narrow' ? 'narrow' : null,
    confidence: unit(parsed.confidence),
  };
}

/**
 * Lecteur de sources BORNÉ : jamais le contenu d'un fichier de secrets
 * (`config.secretPatterns`), et rien du tout au-delà de `tokens.router.maxScanFiles`
 * (null → les signaux fondés sur le contenu sont simplement absents).
 */
function scanGuard(reader, allowed, secretPatterns) {
  if (!reader || !allowed) return null;
  const compiled = [];
  for (const pattern of Array.isArray(secretPatterns) ? secretPatterns : []) {
    try {
      compiled.push(compileSecretPattern(pattern));
    } catch {
      // Motif invalide : refusé au chargement de la config ; ici, on ne lit simplement pas plus.
    }
  }
  const secret = (file) => compiled.some((c) => secretPatternMatches(c, file));
  // Mémo LE TEMPS D'UNE PRÉDICTION : la carte et le graphe d'imports lisent les mêmes fichiers.
  const reads = new Map();
  return {
    version: async (file) => (secret(file) ? null : reader.version(file)),
    read: (file) => {
      if (secret(file)) return Promise.resolve(null);
      let hit = reads.get(file);
      if (!hit) reads.set(file, (hit = reader.read(file)));
      return hit;
    },
  };
}

/**
 * Prédit via le LLM les fichiers qu'une tâche va toucher.
 * Contrat historique : tableau de chemins ; throw StriartError(ROUTER_FAILED)
 * si toutes les tentatives échouent. Voir predictFilesDetailed pour la version
 * qui rend en plus confiances, raisons d'expansion et fichiers de tenue de livre.
 *
 * @param {Parameters<typeof predictFilesDetailed>[0]} params
 * @returns {Promise<string[]>}
 */
export async function predictFiles(params) {
  return (await predictFilesDetailed(params)).files;
}

/**
 * Prédiction détaillée. `files` est LE tableau utilisé pour détecter les
 * collisions (`predictFiles` ne rend que lui) ; `details` est additif (--json,
 * débogage, banc) et ne conditionne aucune décision en aval.
 *
 * Lot T : l'arbre de fichiers est filtré/compacté/classé (router-tree.ts), le
 * prompt place le préfixe STABLE (consignes + arbre) avant la tâche variable
 * (cache de prompt), les prédictions identiques sont servies par le cache local
 * (clé = tâche normalisée + empreinte de l'arbre [+ HEAD]), et un budget de
 * tokens épuisé replie sur la sérialisation prudente au lieu d'échouer.
 *
 * Lot fiabilité (réglages `tokens.router.*`, tous mesurés par `bench:router`) :
 * carte du dépôt et candidats lexicaux (BM25) dans le prompt, confiance par fichier, détection des tâches vagues (→ sérialisation
 * prudente), expansion déterministe (tests, imports, jumeaux, co-modification)
 * et politique des fichiers de tenue de livre. Un échec reste un échec :
 * ROUTER_FAILED ou la sentinelle, jamais un tableau vide trompeur.
 *
 * Liste tronquée (`treeTruncated` : l'appelant n'a pu lire que `kept` fichiers
 * sur `total`) : le Router ne voit qu'une partie du dépôt, jamais en silence.
 * `tokens.router.onTreeTruncated` choisit — 'serialize' (défaut) : sentinelle
 * « tout le dépôt » sans appel LLM ; 'predict' : prédiction sur la vue partielle,
 * dont le prompt DÉCLARE la troncature.
 *
 * @param {{prompt: string, projectFiles: string[], config: any, timeoutMs?: number, retries?: number, retryDelayMs?: number|null, root?: string|null, agent?: string|null, taskId?: string|null, headSha?: string|null, treeTruncated?: {kept: number, total: number}|null, sources?: import('./router-sources.ts').ProjectSources|null, history?: string[][]|null}} params
 * `sources` : lecteur des sources (défaut : disque sous `root`) ; `history` :
 * fichiers de chaque commit récent (défaut : lu par git depuis `headSha`).
 * @returns {Promise<{files: string[], details: any}>}
 */
export async function predictFilesDetailed({
  prompt,
  projectFiles,
  config,
  timeoutMs = 60_000,
  retries = 2,
  retryDelayMs = null,
  root = null,
  agent = null,
  taskId = null,
  headSha = null,
  treeTruncated = null,
  sources = null,
  history = null,
}) {
  const settings = resolveTokensSettings(config);
  const rs = settings.router;
  const details = {
    promptVersion: rs.prompt === 'legacy' ? ROUTER_PROMPT_VERSION : ROUTER_V3_PROMPT_VERSION,
    sample: null,
    files: [],
    shared: [],
    serialized: null,
    retrieval: [],
    tree: null,
    map: null,
    expansion: [],
  };
  const whole = (reason) => {
    details.serialized = reason;
    details.files = [{ path: WHOLE_REPO, confidence: 1, source: 'policy', reason: reason.kind }];
    return { files: [WHOLE_REPO], details };
  };

  if (treeTruncated && rs.onTreeTruncated === 'serialize') {
    logger.warn(
      { ...treeTruncated, policy: 'serialize' },
      "Router : liste de fichiers tronquée — sérialisation prudente (la tâche attend les agents actifs ; tokens.router.onTreeTruncated: 'predict' pour prédire sur la vue partielle)",
    );
    return whole({ kind: 'tree-truncated', ...treeTruncated });
  }

  const resolvedRoot = root ?? (await resolveRoot(null, config));
  const files = projectFiles.map(normalizeFilePath);
  const reader = scanGuard(
    sources ?? (resolvedRoot ? fsSources(resolvedRoot) : null),
    files.length <= rs.maxScanFiles,
    config.secretPatterns,
  );
  if (files.length > rs.maxScanFiles) {
    logger.info(
      { files: files.length, maxScanFiles: rs.maxScanFiles },
      'Router : dépôt trop grand pour lire les sources — récupération sur les chemins seuls',
    );
  }

  // --- Signaux déterministes (carte, récupération lexicale) -----------------
  const wantsMap = rs.map.mode !== 'off';
  const wantsRetrieval = rs.retrieval.enabled || wantsMap;
  let summaries = null;
  let ranking = [];
  if (wantsMap || wantsRetrieval) {
    try {
      // Sans lecteur de sources (hors dépôt, dépôt trop grand), la carte est vide : le
      // classement lexical s'appuie sur les seuls chemins.
      summaries = reader ? await buildRepoMap(files, reader) : new Map();
      if (wantsRetrieval) {
        const index = buildRetrievalIndex(files, summaries);
        ranking = retrieve(index, prompt, {
          topK: Math.max(rs.map.candidates, 40),
          bilingual: rs.retrieval.bilingual,
        });
      }
    } catch (error) {
      // Signal advisory : sans carte, le Router retombe sur l'arbre seul.
      summaries = null;
      logger.warn({ err: error }, 'Router : carte du dépôt indisponible — arbre seul');
    }
  }
  details.retrieval = ranking.slice(0, 10);
  const scores = new Map(ranking.map((r) => [r.path, r.score]));

  const tree = await buildRouterTree({
    files,
    task: prompt,
    settings: rs.tree,
    estimator: settings.estimator,
    root: resolvedRoot,
    sources: reader,
    scores: scores.size > 0 ? scores : null,
  });
  details.tree = {
    mode: tree.mode,
    total: tree.total,
    shown: tree.shown,
    omitted: tree.omitted,
    estimatedTokens: tree.estimatedTokens,
  };
  // Troncature déclarée AU LLM : sans elle il croirait voir tout le dépôt et
  // prédirait « ce qu'il voit » avec une fausse assurance.
  const treeText = treeTruncated
    ? `${tree.text}
${truncationNote(treeTruncated)}`
    : tree.text;
  if (tree.mode !== 'full') {
    logger.info(
      {
        mode: tree.mode,
        total: tree.total,
        shown: tree.shown,
        omitted: tree.omitted,
        tokens: tree.estimatedTokens,
      },
      'Router : arbre de fichiers réduit pour le prompt',
    );
  }

  // Carte des meilleurs candidats lexicaux : partie VARIABLE du prompt (après le préfixe stable).
  let candidatesText = '';
  if (summaries && rs.map.mode === 'candidates' && ranking.length > 0) {
    const top = ranking.slice(0, rs.map.candidates);
    // Le contenu des commentaires part chez le fournisseur du LLM : secrets caviardés.
    candidatesText = `Candidats les plus proches de la demande (classés par similarité lexicale — un INDICE, pas une vérité ; la liste complète des fichiers est ci-dessus) :
${top
  .map((r) =>
    redactSecrets(
      renderMapLine(r.path, summaries.get(r.path) ?? { symbols: [], doc: null, index: '' }),
    ),
  )
  .join('\n')}`;
    details.map = { mode: 'candidates', shown: top.length };
  }

  // --- Prompt ---------------------------------------------------------------
  // Template surchargé (config.prompts.router, placeholders validés au
  // chargement) ou prompt par défaut — même contrat de sortie dans les deux
  // cas : le transform ci-dessous valide {"files": [...]} quoi qu'il arrive.
  // Le préfixe stable s'arrête avant la tâche (donnée variable).
  const excludeShared = rs.sharedFiles.mode === 'exclude';
  const legacy = rs.prompt === 'legacy';
  let stablePrefix;
  let fullPrompt;
  if (config.prompts?.router) {
    const template = config.prompts.router;
    const at = template.indexOf('{{task}}');
    const before = fillPromptTemplate(template.slice(0, at), { files: treeText });
    const after = fillPromptTemplate(template.slice(at), { task: prompt, files: treeText });
    stablePrefix = template.slice(0, at).includes('{{files}}') ? before : '';
    fullPrompt = before + after;
  } else {
    const instructions = legacy ? ROUTER_INSTRUCTIONS : v3Instructions({ excludeShared });
    const head = `${instructions}${tree.mode === 'full' ? '' : `\n${COMPACT_TREE_LEGEND}`}

Fichiers du projet :
${treeText}

`;
    stablePrefix = tree.mode === 'ranked' ? instructions : head;
    fullPrompt = `${head}${candidatesText ? `${candidatesText}\n\n` : ''}${legacy ? 'Tâche' : 'Demande'} : ${prompt}`;
  }

  const normalizedTask = prompt.replace(/\s+/g, ' ').trim();
  const baseMaterial = [
    normalizedTask,
    sha256(treeText),
    headSha ?? '',
    config.prompts?.router ? sha256(config.prompts.router) : '',
  ];
  // Prompt historique : matière de cache INCHANGÉE (les entrées existantes restent valides).
  const material =
    legacy && !candidatesText
      ? baseMaterial
      : [...baseMaterial, rs.prompt, excludeShared ? 'x' : '', sha256(candidatesText)];

  // --- Appel du LLM ---------------------------------------------------------
  let sample;
  try {
    sample = await llmGenerate({
      config,
      prompt: fullPrompt,
      stablePrefix,
      format: 'json',
      timeoutMs,
      retries,
      retryDelayMs,
      role: 'router',
      root,
      agent,
      taskId,
      maxOutputTokens: legacy ? ROUTER_MAX_OUTPUT_TOKENS : ROUTER_V3_MAX_OUTPUT_TOKENS,
      resultCache: {
        promptVersion: legacy ? ROUTER_PROMPT_VERSION : ROUTER_V3_PROMPT_VERSION,
        material,
      },
      errorCode: 'ROUTER_FAILED',
      errorMessage: `Le Router n'a pas pu prédire les fichiers`,
      transform: parseRouterResponse,
    });
  } catch (error) {
    const budgetRefusal =
      error instanceof StriartError &&
      (error.code === 'TOKEN_BUDGET_EXCEEDED' || error.code === 'TOKEN_PRICE_MISSING');
    if (budgetRefusal && rs.onBudgetExceeded === 'serialize') {
      logger.warn(
        { code: error.code, details: error.details },
        'Router : budget de tokens refusé — sérialisation prudente (la tâche attend les agents actifs)',
      );
      return whole({ kind: 'budget', code: error.code });
    }
    throw error;
  }
  details.sample = sample;

  // --- Confiance, tâche vague ----------------------------------------------
  let core = sample.files.map((f) => ({ ...f }));
  if (rs.minFileConfidence > 0) {
    core = core.filter((f) => f.confidence === null || f.confidence >= rs.minFileConfidence);
  }
  const reasons = vagueReasons({
    task: prompt,
    fileCount: core.length,
    confidence: sample.confidence,
    scope: sample.scope,
    settings: rs.vague,
  });
  if (reasons.length > 0) {
    logger.info({ reasons }, 'Router : tâche vague ou transverse — sérialisation prudente');
    return whole({ kind: 'vague', reasons });
  }

  if (core.length > rs.maxFiles) {
    // Les plus sûrs d'abord (sans confiance : 0,5), ordre du LLM conservé à égalité.
    core = core
      .map((f, i) => ({ f, i }))
      .sort((a, b) => (b.f.confidence ?? 0.5) - (a.f.confidence ?? 0.5) || a.i - b.i)
      .slice(0, rs.maxFiles)
      .map(({ f }) => f);
  }

  // --- Expansion déterministe ----------------------------------------------
  const exp = rs.expansion;
  let added = [];
  const wantsGraph = exp.imports !== 'off' || exp.tests;
  if (core.length > 0 && (wantsGraph || exp.siblings || exp.contracts || exp.coChange)) {
    try {
      const fileSet = new Set<string>(files);
      let graph = null;
      let inverse = null;
      if (wantsGraph && reader) {
        graph = await buildImportGraph(resolvedRoot ?? '', files, reader);
        inverse = invertImportGraph(graph);
      }
      let coChange = null;
      if (exp.coChange) {
        if (history) coChange = buildCoChange(history);
        else if (resolvedRoot && headSha) {
          coChange = await loadCoChange(resolvedRoot, headSha, { limit: rs.history.limit }).catch(
            (error) => {
              logger.warn(
                { err: error },
                'Router : historique git indisponible — co-modification ignorée',
              );
              return null;
            },
          );
        }
      }
      added = expandPrediction({
        core: core.map((f) => ({ path: f.path, confidence: f.confidence ?? 0.5 })),
        files: fileSet,
        graph,
        inverse,
        coChange,
        settings: exp,
      });
    } catch (error) {
      // L'expansion est un signal advisory : sa panne ne dégrade jamais la prédiction du LLM.
      logger.warn(
        { err: error },
        'Router : expansion déterministe indisponible — prédiction du LLM seule',
      );
    }
  }
  details.expansion = added;

  // --- Tenue de livre partagée ---------------------------------------------
  const all = [
    ...core.map((f) => ({ ...f, source: 'llm' })),
    ...added.map((a) => ({ ...a, source: 'expansion' })),
  ];
  details.files = all;
  if (rs.sharedFiles.mode === 'exclude') {
    const { own, shared } = partitionShared(
      all.map((f) => f.path),
      compileSharedMatcher(rs.sharedFiles.patterns),
    );
    details.shared = shared;
    // Une prédiction réduite à de la tenue de livre n'est pas une prédiction.
    if (own.length === 0 && shared.length > 0 && rs.vague.enabled) {
      return whole({ kind: 'vague', reasons: ['only-shared-files'] });
    }
    return { files: own, details };
  }
  return { files: all.map((f) => f.path), details };
}

/**
 * Intersection entre les fichiers prédits d'une nouvelle tâche
 * et ceux des agents déjà actifs.
 * Retourne [{ agent, files }] — vide si aucun chevauchement.
 */
export function detectCollisions(predictedFiles, agents) {
  return detectCollisionsDetailed(predictedFiles, agents).collisions;
}

/**
 * Comme `detectCollisions`, plus les agents que la sentinelle WHOLE_REPO a cessé de retenir.
 *
 * Un agent portant `sessionFailed` (statut de session échouée : clone conservé après un échec,
 * sans commit à merger, voir session-failure.ts) n'est PAS un blocage quand la collision ne
 * tient QU'À la sentinelle — l'une ou l'autre des deux prédictions est `**`. Une intersection
 * de fichiers précis des deux côtés bloque dans tous les cas. Les agents relâchés sont
 * rendus (`relaxed`) : l'appelant a le devoir de les rendre visibles.
 *
 * @param {string[]} predictedFiles
 * @param {Array<{name: string, predictedFiles?: string[], sessionFailed?: string|null}>} agents
 * @returns {{collisions: Array<{agent: string, files: string[]}>, relaxed: Array<{agent: string, reason: 'SESSION_FAILED', status: string}>}}
 */
export function detectCollisionsDetailed(predictedFiles, agents) {
  const mine = new Set(predictedFiles.map(normalizeFilePath));
  const collisions = [];
  const relaxed = [];
  for (const agent of agents) {
    const theirs = (agent.predictedFiles ?? []).map(normalizeFilePath);
    // WHOLE_REPO (budget épuisé → sérialisation prudente) : d'un côté comme de
    // l'autre, la tâche entre en collision avec tout agent actif.
    if (mine.has(WHOLE_REPO) || theirs.includes(WHOLE_REPO)) {
      if (agent.sessionFailed) {
        relaxed.push({ agent: agent.name, reason: 'SESSION_FAILED', status: agent.sessionFailed });
        continue;
      }
      collisions.push({ agent: agent.name, files: [WHOLE_REPO] });
      continue;
    }
    const files = theirs.filter((f) => mine.has(f));
    if (files.length > 0) collisions.push({ agent: agent.name, files });
  }
  return { collisions, relaxed };
}

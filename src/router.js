import { StriartError } from './errors.js';
import { fillPromptTemplate, llmGenerate } from './llm.js';
import { logger } from './logger.js';
import { isSafeProjectPath } from './project-path.ts';
import { COMPACT_TREE_LEGEND, buildRouterTree } from './router-tree.ts';
import { sha256 } from './tokens/cache.ts';
import { resolveRoot } from './tokens/call.ts';
import { resolveTokensSettings } from './tokens/settings.ts';

const ROUTER_INSTRUCTIONS = `Tu es un analyste de code. Voici la liste des fichiers d'un projet, puis une tâche de développement.
Liste UNIQUEMENT les fichiers que cette tâche va réellement modifier (1 à 5 maximum).
N'inclus PAS les fichiers voisins ou improbables : chaque fichier listé bloque les autres agents qui le touchent.
Un fichier de test n'est inclus que s'il teste directement le code modifié.
Réponds UNIQUEMENT en JSON : {"files": ["src/..."]}`;

export function normalizeFilePath(p) {
  return p.replaceAll('\\', '/').replace(/^\.\//, '').trim();
}

/** Filtre des chemins prédits (source unique : project-path.ts, partagée avec la CLI). */
export { isSafeProjectPath };

/** Version du gabarit de prompt du Router : à incrémenter si ROUTER_INSTRUCTIONS change (invalide le cache). */
const ROUTER_PROMPT_VERSION = 'router-v2';

/** Sortie maximale d'une prédiction (5 chemins ≈ quelques dizaines de jetons ; marge pour les modèles à raisonnement). */
const ROUTER_MAX_OUTPUT_TOKENS = 2048;

/**
 * Sentinelle « tout le dépôt » : prédiction rendue quand le budget interdit
 * d'appeler le LLM (`tokens.router.onBudgetExceeded: 'serialize'`). Elle
 * entre en collision avec TOUT agent actif (voir detectCollisions) : la tâche
 * attend que les autres finissent — la sérialisation prudente, le chemin sûr
 * du Router quand il ne sait pas.
 */
export const WHOLE_REPO = '**';

/** Mention placée sous la liste de fichiers quand elle a été coupée avant le Router. */
function truncationNote({ kept, total }) {
  return `NOTE : liste tronquée — ${kept} fichiers montrés sur ${total} suivis par git. Les autres ne sont pas listés : ne prédis que des fichiers de cette liste ou explicitement nommés par la tâche.`;
}

/**
 * Prédit via le LLM les fichiers qu'une tâche va toucher.
 * Throw StriartError(ROUTER_FAILED) si toutes les tentatives échouent.
 *
 * Lot T : l'arbre de fichiers est filtré/compacté/classé (router-tree.ts), le
 * prompt place le préfixe STABLE (consignes + arbre) avant la tâche variable
 * (cache de prompt), les prédictions identiques sont servies par le cache local
 * (clé = tâche normalisée + empreinte de l'arbre [+ HEAD]), et un budget de
 * tokens épuisé replie sur la sérialisation prudente au lieu d'échouer.
 *
 * Liste tronquée (`treeTruncated` : l'appelant n'a pu lire que `kept` fichiers
 * sur `total`) : le Router ne voit qu'une partie du dépôt, jamais en silence.
 * `tokens.router.onTreeTruncated` choisit — 'serialize' (défaut) : sentinelle
 * « tout le dépôt » sans appel LLM ; 'predict' : prédiction sur la vue partielle,
 * dont le prompt DÉCLARE la troncature.
 *
 * @param {{prompt: string, projectFiles: string[], config: any, timeoutMs?: number, retries?: number, retryDelayMs?: number|null, root?: string|null, agent?: string|null, taskId?: string|null, headSha?: string|null, treeTruncated?: {kept: number, total: number}|null}} params
 */
export async function predictFiles({
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
}) {
  const settings = resolveTokensSettings(config);
  if (treeTruncated && settings.router.onTreeTruncated === 'serialize') {
    logger.warn(
      { ...treeTruncated, policy: 'serialize' },
      "Router : liste de fichiers tronquée — sérialisation prudente (la tâche attend les agents actifs ; tokens.router.onTreeTruncated: 'predict' pour prédire sur la vue partielle)",
    );
    return [WHOLE_REPO];
  }
  const tree = await buildRouterTree({
    files: projectFiles,
    task: prompt,
    settings: settings.router.tree,
    estimator: settings.estimator,
    root: root ?? (await resolveRoot(null, config)),
  });
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

  // Template surchargé (config.prompts.router, placeholders validés au
  // chargement) ou prompt par défaut — même contrat de sortie dans les deux
  // cas : le transform ci-dessous valide {"files": [...]} quoi qu'il arrive.
  // Le préfixe stable s'arrête avant la tâche (donnée variable).
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
    const head = `${ROUTER_INSTRUCTIONS}${tree.mode === 'full' ? '' : `\n${COMPACT_TREE_LEGEND}`}

Fichiers du projet :
${treeText}

`;
    stablePrefix = tree.mode === 'ranked' ? ROUTER_INSTRUCTIONS : head;
    fullPrompt = `${head}Tâche : ${prompt}`;
  }

  const normalizedTask = prompt.replace(/\s+/g, ' ').trim();
  const resultCache = {
    promptVersion: ROUTER_PROMPT_VERSION,
    material: [
      normalizedTask,
      sha256(treeText),
      headSha ?? '',
      config.prompts?.router ? sha256(config.prompts.router) : '',
    ],
  };

  try {
    return await llmGenerate({
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
      maxOutputTokens: ROUTER_MAX_OUTPUT_TOKENS,
      resultCache,
      errorCode: 'ROUTER_FAILED',
      errorMessage: `Le Router n'a pas pu prédire les fichiers`,
      transform: (response) => {
        const parsed = JSON.parse(response);
        if (!Array.isArray(parsed.files)) {
          throw new Error('la réponse ne contient pas de tableau "files"');
        }
        return [
          ...new Set(
            parsed.files
              .filter((f) => typeof f === 'string')
              .map(normalizeFilePath)
              .filter(Boolean)
              // Écarte les chemins hallucinés hors de l'arbre (absolus, `..`) :
              // ils n'ont pas de sens comme clés de verrou/collision.
              .filter(isSafeProjectPath),
          ),
        ];
      },
    });
  } catch (error) {
    const budgetRefusal =
      error instanceof StriartError &&
      (error.code === 'TOKEN_BUDGET_EXCEEDED' || error.code === 'TOKEN_PRICE_MISSING');
    if (budgetRefusal && settings.router.onBudgetExceeded === 'serialize') {
      logger.warn(
        { code: error.code, details: error.details },
        'Router : budget de tokens refusé — sérialisation prudente (la tâche attend les agents actifs)',
      );
      return [WHOLE_REPO];
    }
    throw error;
  }
}

/**
 * Intersection entre les fichiers prédits d'une nouvelle tâche
 * et ceux des agents déjà actifs.
 * Retourne [{ agent, files }] — vide si aucun chevauchement.
 */
export function detectCollisions(predictedFiles, agents) {
  const mine = new Set(predictedFiles.map(normalizeFilePath));
  const collisions = [];
  for (const agent of agents) {
    const theirs = (agent.predictedFiles ?? []).map(normalizeFilePath);
    // WHOLE_REPO (budget épuisé → sérialisation prudente) : d'un côté comme de
    // l'autre, la tâche entre en collision avec tout agent actif.
    if (mine.has(WHOLE_REPO) || theirs.includes(WHOLE_REPO)) {
      collisions.push({ agent: agent.name, files: [WHOLE_REPO] });
      continue;
    }
    const files = theirs.filter((f) => mine.has(f));
    if (files.length > 0) collisions.push({ agent: agent.name, files });
  }
  return collisions;
}

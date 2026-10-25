import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { simpleGit } from 'simple-git';
import { StriartError, agentUnknownError } from './errors.js';
import { formatMergeSubject, parseMergeSubject } from './merge-subject.ts';
import { loadConfig } from './config.js';
import {
  assertInitialized,
  cloneGit,
  compareAndUpdateAgentMeta,
  createAgent,
  readRegistry,
  resumeCloneRemovals,
  reuseAgent,
  removeAgentFromRegistry,
  updateAgentMeta,
  validateAgentName,
} from './clone.js';
import { sweepOrphanTempFiles } from './json-file.js';
import { striartDir } from './paths.js';
import { DEFAULT_PROFILE, resolveAgentProfile, runAgentSession } from './session.js';
import { prunePermissions } from './permissions.ts';
import { detectCollisions, predictFiles } from './router.js';
import { buildImportGraph, detectSemanticNeighbors } from './imports.js';
import { computeWorkspaceWarnings } from './workspaces.js';
import { enqueueTask, readQueue, removeTask } from './queue.js';
import { runTestGate } from './gate.js';
import {
  createConflictTicket,
  readTicketDetail,
  closeConflictTicket,
  listConflictTickets,
  readResolutionInputs,
  safeFileName,
  assertTicketPathSafe,
} from './conflicts.js';
import { startMainSession, stopMainSession } from './main-session.js';
import {
  MAX_MERGE_INPUT_CHARS,
  classifyConflict,
  extractConflictVersions,
  isExecutableMode,
  lineOverlap,
  maxMergeInputChars,
  semanticMerge,
} from './merger.js';
import { readState, recordSemanticFailure, recordSemanticSuccess } from './state.js';
import { emitStriartEvent } from './events.js';
import { fetchBranchToRef, incomingRef, resolveBranchHead, syncAgentWithMain } from './sync.js';
import { refreshCloneMemories, updateMemoryAfterMerge } from './memory.js';
import { logger } from './logger.js';
import {
  assertMainLockHeld,
  assertNoLiveMainSession,
  recordMergeStateChanged,
  withMainLock,
} from './lock.js';
import { isProcessAlive } from './process-tree.js';
import { parsePlan } from './plan.ts';
import { describePlanV2, runPlanV2, validatePlanAgainstConfig } from './orchestration/scheduler.ts';
import { releaseAgentArtifacts } from './agent-artifacts.ts';
import { stopPtyHost } from './pty-host.ts';
import { findProtectedChanges, resolveProtectedPathsPolicy } from './protected-paths.ts';
import { concludeAutonomousSession } from './autonomous-cycle.ts';
import { withTokenContext } from './tokens/context.ts';
import { resolveTokensSettings } from './tokens/settings.ts';

/**
 * Options du conteneur du Test Gate tirées de la config (`gateOrphanGraceMs`,
 * `gateMaxOutputBytes`, `gateContainer`) — les quatre sites d'appel (merge, retry
 * sémantique, résolution manuelle, promotion) passent par ici : aucun ne peut
 * oublier le délai de grâce des orphelins ni le plafond du journal.
 * @param {import('./types.js').StriartConfig} config
 */
function gateContainerOptions(config) {
  return {
    orphanGraceMs: config.gateOrphanGraceMs,
    maxOutputBytes: config.gateMaxOutputBytes,
    container: config.gateContainer,
  };
}

/**
 * Effets DIFFÉRÉS d'une opération sous le verrou principal.
 *
 * Invariant n°1 : le verrou n'est jamais tenu pendant un appel LLM ou réseau
 * (webhooks : 5 s chacun ; résumé de la Memory Layer : un appel LLM). Les
 * sites d'émission restent là où vit le contexte (`emitEvent`), mais l'envoi
 * est reporté APRÈS la libération du verrou par `runWithDeferredEffects` — dans
 * l'ordre d'émission, y compris quand l'opération échoue (un ticket créé avant
 * l'erreur doit toujours être annoncé).
 * @typedef {{events: Array<{config: import('./types.js').StriartConfig, event: import('./types.js').StriartEvent}>, memory: null | {root: string, config: import('./types.js').StriartConfig, agent: string, taskId: string|null, sha: string, diff: string}}} DeferredEffects
 */
/** @type {AsyncLocalStorage<DeferredEffects>} */
const effectsContext = new AsyncLocalStorage();

/**
 * Émet un événement : différé si une opération sous verrou est en cours,
 * immédiat sinon.
 * @param {import('./types.js').StriartConfig} config
 * @param {import('./types.js').StriartEvent} event
 */
async function emitEvent(config, event) {
  const effects = effectsContext.getStore();
  if (effects) {
    effects.events.push({ config, event });
    return;
  }
  await emitStriartEvent(config, event);
}

/**
 * Exécute `fn` (qui prend le verrou principal) puis, une fois le verrou
 * libéré, envoie les événements différés et lance la mise à jour de la Memory
 * Layer (résultat reporté dans `result.memory`). Réentrant : une opération
 * imbriquée dépose ses effets chez l'appelant le plus externe.
 * @template T
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
async function runWithDeferredEffects(fn) {
  if (effectsContext.getStore()) return fn();
  /** @type {DeferredEffects} */
  const effects = { events: [], memory: null };
  /** @type {T} */
  let result;
  try {
    result = await effectsContext.run(effects, fn);
  } finally {
    for (const { config, event } of effects.events) await emitStriartEvent(config, event);
  }
  if (effects.memory && result && typeof result === 'object') {
    const { root, config, agent, taskId, sha, diff } = effects.memory;
    const memory = await withTokenContext({ root, agent, taskId }, () =>
      updateMemoryAfterMerge({ root, config, agent, sha, diff }),
    );
    await refreshLiveMemory(root, config);
    /** @type {any} */ (result).memory = memory;
  }
  return result;
}

/**
 * Fichiers suivis par git soumis au Router. La liste n'est PLUS coupée à 400
 * fichiers : l'arbre du Router (router-tree.ts) filtre, compacte et classe lui-même
 * les gros dépôts. Seule borne : `tokens.router.tree.maxFiles` (garde mémoire/temps
 * sur les très gros dépôts) — au-delà, la troncature est rendue À L'APPELANT
 * (`truncated`), jamais appliquée en silence : le Router la déclare à son prompt
 * ou sérialise prudemment (`tokens.router.onTreeTruncated`).
 * @param {string} root
 * @param {import('./types.js').StriartConfig} config
 * @returns {Promise<{files: string[], truncated: {kept: number, total: number}|null}>}
 */
async function listProjectFiles(root, config) {
  const max = resolveTokensSettings(config).router.tree.maxFiles;
  const out = await simpleGit(root).raw(['ls-files']);
  const files = out
    .split('\n')
    .map((f) => f.trim())
    .filter(Boolean);
  if (files.length <= max) return { files, truncated: null };
  logger.warn(
    { total: files.length, kept: max },
    'Liste de fichiers tronquée avant le Router (tokens.router.tree.maxFiles)',
  );
  return { files: files.slice(0, max), truncated: { kept: max, total: files.length } };
}

/**
 * Slug de nom d'agent dérivé du prompt : "Faire le login" → "faire-le-login".
 * Accents retirés, alphanumérique + tirets, tronqué à 24 caractères.
 */
/** @param {string} prompt @returns {string} */
export function slugifyPrompt(prompt) {
  const slug = prompt
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24)
    .replace(/-+$/, '');
  return /^[a-z0-9][a-z0-9_-]*$/.test(slug) ? slug : 'agent';
}

/** Nom unique vs agents actifs ET tâches en attente (suffixe -2, -3...). */
async function generateAgentName(root, prompt) {
  const registry = await readRegistry(root);
  const queue = await readQueue(root);
  const taken = new Set([...Object.keys(registry), ...queue.map((t) => t.agent)]);
  const base = slugifyPrompt(prompt);
  if (!taken.has(base)) return base;
  for (let i = 2; ; i += 1) {
    if (!taken.has(`${base}-${i}`)) return `${base}-${i}`;
  }
}

function activeAgents(registry) {
  return Object.entries(registry).map(([name, meta]) => ({
    name,
    predictedFiles: meta.predictedFiles ?? [],
  }));
}

/**
 * striart run : Router préventif puis lancement (ou mise en file d'attente).
 *
 * 1. Le prompt est envoyé à Ollama qui prédit les fichiers touchés.
 * 2. Intersection avec les prédictions des agents actifs.
 * 3. Intersection vide → clone + branche de tâche. Sinon → queue.json.
 *
 * Le Router est un filtre grossier : un faux négatif sera rattrapé
 * par le Merger Sémantique (Phase 3).
 */
/**
 * Le travail référencé par `--after` est-il encore actif ?
 * Actif = agent au registre, ou tâche en file (par id OU par nom d'agent).
 * @param {Record<string, import('./types.js').AgentMeta>} registry
 * @param {import('./types.js').QueueTask[]} queue
 * @param {string} ref
 */
function isWorkActive(registry, queue, ref) {
  return Boolean(registry[ref]) || queue.some((t) => t.id === ref || t.agent === ref);
}

/**
 * Détecte un cycle de dépendances `after` : suit la chaîne à travers la file
 * (une réf pointe une tâche par id ou par nom d'agent). Deux tâches qui
 * s'attendent mutuellement ne partiraient jamais — refus au run plutôt
 * qu'une famine silencieuse. Le set `visited` borne la marche : une file
 * corrompue à la main ne peut pas faire boucler l'orchestrateur.
 * @param {import('./types.js').QueueTask[]} queue
 * @param {string} newAgent Nom d'agent de la tâche qu'on s'apprête à enfiler.
 * @param {string} firstRef Sa référence `after`.
 * @returns {boolean}
 */
function hasAfterCycle(queue, newAgent, firstRef) {
  const visited = new Set();
  let ref = firstRef;
  while (ref) {
    if (ref === newAgent) return true; // la chaîne revient sur la nouvelle tâche
    if (visited.has(ref)) return true; // cycle préexistant dans la file
    visited.add(ref);
    const next = queue.find((t) => t.id === ref || t.agent === ref);
    ref = next?.after ?? null;
  }
  return false;
}

/**
 * `striart start` : un agent supervisé, sans Router. Compose la config
 * (filtre de clone, motifs de secrets) à la place de l'appelant, et refuse
 * d'emblée une branche cible inexistante — l'agent démarrerait, mais aucun
 * de ses merges ne pourrait aboutir.
 * @param {{root: string, name: string, command?: string|null, reuse?: boolean, force?: boolean, allowHistoricalSecrets?: boolean}} params
 * @returns {Promise<import('./types.js').AgentMeta & {name: string}>}
 */
export async function startAgent({
  root,
  name,
  command = null,
  reuse = false,
  force = false,
  allowHistoricalSecrets = false,
}) {
  await assertInitialized(root);
  const config = await loadConfig(root);
  await resolveBranchHead(simpleGit(root), config.targetBranch);
  if (reuse) {
    return reuseAgent({
      root,
      name,
      command,
      secretPatterns: config.secretPatterns,
      force,
      allowHistoricalSecrets,
    });
  }
  return createAgent({
    root,
    name,
    command,
    cloneFilter: config.cloneFilter,
    secretPatterns: config.secretPatterns,
    allowHistoricalSecrets,
  });
}

/**
 * Admission d'une tâche : l'agent n'est ni actif ni en file, et sa dépendance
 * `--after` (si elle existe) est vivante et sans cycle. Pure : appelée sur un
 * instantané AVANT le Router (échec à vide, sans payer l'appel LLM) puis de
 * nouveau sous le verrou sur l'état frais (c'est ce second contrôle qui fait foi).
 * @param {{agent: string, after: string|null, registry: Record<string, import('./types.js').AgentMeta>, queue: import('./types.js').QueueTask[]}} params
 */
function assertTaskAdmissible({ agent, after, registry, queue }) {
  if (registry[agent]) {
    throw new StriartError(`L'agent "${agent}" est déjà actif.`, {
      code: 'AGENT_EXISTS',
      hint: 'striart status',
      details: { agent },
    });
  }
  if (queue.some((t) => t.agent === agent)) {
    throw new StriartError(`L'agent "${agent}" a déjà une tâche en file d'attente.`, {
      code: 'AGENT_QUEUED',
      hint: 'striart queue',
      details: { agent },
    });
  }
  if (!after) return;
  if (!isWorkActive(registry, queue, after)) {
    // Une réf inconnue acceptée serait, au choix, un départ immédiat sous
    // fausse garantie ou une attente éternelle. Refus explicite.
    throw new StriartError(
      `--after "${after}" ne correspond à aucune tâche en file ni agent actif.`,
      { code: 'AFTER_UNKNOWN', hint: 'striart queue', details: { after } },
    );
  }
  if (hasAfterCycle(queue, agent, after)) {
    throw new StriartError(
      `--after "${after}" créerait un cycle de dépendances : ces tâches s'attendraient mutuellement pour toujours.`,
      { code: 'AFTER_CYCLE', hint: 'striart queue', details: { agent, after } },
    );
  }
}

/**
 * Démarre ou met en file une tâche (voir la doc de `runTaskLocked`).
 *
 * Invariant n°1 : tout ce qui est LENT (appel LLM du Router, lecture de l'arbre
 * du projet, graphe d'imports) se fait AVANT la prise du verrou, sur un
 * instantané du registre ; les décisions (collision, file, clone) se prennent
 * sous le verrou sur l'état frais. Les webhooks partent APRÈS sa libération.
 * @param {{root: string, agent?: string|null, prompt: string, command?: string|null, mode?: 'attended'|'autonomous', profile?: string|null, after?: string|null, reuse?: boolean, force?: boolean, allowHistoricalSecrets?: boolean, signal?: AbortSignal|null}} params
 * @returns {Promise<import('./types.js').RunResult>}
 */
export async function runTask(params) {
  const { root } = params;
  await assertInitialized(root);

  if (typeof params.prompt !== 'string' || params.prompt.trim().length === 0) {
    throw new StriartError('Le prompt de la tâche est vide.', {
      code: 'EMPTY_PROMPT',
      hint: 'striart run "<tâche>"',
    });
  }

  // --reuse cible une archive PRÉCISE : un nom dérivé du prompt tomberait
  // presque toujours à côté (REUSE_NO_CLONE au mieux, mauvaise archive au
  // pire). Refus explicite plutôt qu'un comportement hasardeux.
  if (params.reuse && !params.agent) {
    throw new StriartError('--reuse exige un nom d’agent explicite (--agent).', {
      code: 'REUSE_NEEDS_AGENT',
      hint: 'striart run --reuse --agent <agent> "<tâche>"',
    });
  }

  // Pas de nom fourni → dérivé du prompt (striart run "Faire le login").
  const generatedName = !params.agent;
  const agent = params.agent ?? (await generateAgentName(root, params.prompt));
  validateAgentName(agent);

  // Contrôle d'admission SUR INSTANTANÉ : une demande vouée à l'échec ne paie
  // pas l'appel au Router. L'état est relu et recontrôlé sous le verrou.
  const snapshotRegistry = await readRegistry(root);
  const snapshotQueue = await readQueue(root);
  assertTaskAdmissible({
    agent,
    after: params.after ?? null,
    registry: snapshotRegistry,
    queue: snapshotQueue,
  });

  const config = await loadConfig(root);
  // Fail fast : sans branche cible, l'agent démarrerait mais aucun merge
  // ne pourrait jamais aboutir. Vérifié AVANT l'appel au Router (LLM).
  const headSha = await resolveBranchHead(simpleGit(root), config.targetBranch);
  const { files: projectFiles, truncated: treeTruncated } = await listProjectFiles(root, config);
  if (treeTruncated) {
    const policy = resolveTokensSettings(config).router.onTreeTruncated;
    await emitStriartEvent(config, {
      type: 'router:tree-truncated',
      agent,
      ...treeTruncated,
      policy,
      message: `⚠️ [Striart] Router : ${treeTruncated.kept} fichiers lus sur ${treeTruncated.total} suivis (tokens.router.tree.maxFiles) — ${policy === 'serialize' ? 'sérialisation prudente : la tâche attend les agents actifs' : 'prédiction sur une vue partielle'}.`,
    });
  }
  // Le Router est un appel LLM comme les autres : relevé à CE dépôt et à CET
  // agent (budgets perAgent/perDay, `striart usage`). Pas de taskId : la tâche
  // n'existe qu'une fois le clone créé, après la prédiction. `headSha` lie le
  // cache des prédictions à l'état de la cible : un nouveau commit l'invalide.
  const predictedFiles = await withTokenContext({ root, agent }, () =>
    predictFiles({
      prompt: params.prompt,
      projectFiles,
      config,
      root,
      agent,
      headSha,
      treeTruncated,
    }),
  );

  // Graphe d'imports (lecture disque, potentiellement long) : construit hors
  // verrou dès que la tâche a une chance de démarrer — pas pour une tâche que
  // l'instantané voit déjà en collision ou en attente d'un `--after`.
  let graph = null;
  const wouldQueue =
    detectCollisions(predictedFiles, activeAgents(snapshotRegistry)).length > 0 ||
    Boolean(params.after);
  if (!wouldQueue) graph = await tryBuildImportGraph(root, projectFiles);

  return runWithDeferredEffects(() =>
    withMainLock(
      root,
      `run:${params.agent ?? 'auto'}`,
      () =>
        runTaskLocked({
          ...params,
          agent,
          generatedName,
          config,
          projectFiles,
          predictedFiles,
          graph,
        }),
      // `signal` n'annule que l'ATTENTE du verrou, jamais une tâche commencée.
      { signal: params.signal ?? null },
    ),
  );
}

/**
 * Graphe d'imports, best effort : un graphe imparfait ne doit pas empêcher un
 * start (avertissements sémantiques seulement, jamais bloquants).
 * @param {string} root @param {string[]} projectFiles
 */
async function tryBuildImportGraph(root, projectFiles) {
  try {
    return await buildImportGraph(root, projectFiles);
  } catch (error) {
    logger.warn(
      { err: error },
      "Graphe d'imports indisponible (avertissements sémantiques ignorés)",
    );
    return null;
  }
}

/**
 * Memory Layer temps réel : rafraîchit dans chaque clone la section « qui
 * travaille sur quoi » (fichiers prédits des tâches actives et en file) après
 * une mutation du registre ou de la file. Advisory strict et best effort —
 * n'interrompt jamais l'opération appelante. Gaté par `memoryLayer`, comme le
 * reste de la mémoire partagée. L'écriture est idempotente (voir memory.js) :
 * appeler ceci à chaque tick ne touche pas les worktrees si rien n'a changé.
 */
async function refreshLiveMemory(root, config) {
  if (!config.memoryLayer) return;
  try {
    await refreshCloneMemories(root, await readRegistry(root), await readQueue(root));
  } catch (error) {
    logger.warn({ err: error }, 'Memory Layer temps réel : rafraîchissement impossible (ignoré)');
  }
}

/**
 * Partie sous verrou de `runTask` : état frais, collision, file ou clone. Tout
 * ce qui est lent a déjà été fait (prédiction, graphe) ; les événements sont
 * différés (`emitEvent`).
 * @param {{root: string, agent: string, generatedName: boolean, prompt: string, config: import('./types.js').StriartConfig, projectFiles: string[], predictedFiles: string[], graph: any, command?: string|null, mode?: 'attended'|'autonomous', profile?: string|null, after?: string|null, reuse?: boolean, force?: boolean, allowHistoricalSecrets?: boolean}} params
 * @returns {Promise<import('./types.js').RunResult>}
 */
async function runTaskLocked({
  root,
  agent: requestedAgent,
  generatedName,
  prompt,
  config,
  projectFiles,
  predictedFiles,
  graph: prebuiltGraph,
  command = null,
  mode = 'attended',
  profile = null,
  after = null,
  reuse = false,
  force = false,
  allowHistoricalSecrets = false,
}) {
  await assertInitialized(root);
  const registry = await readRegistry(root);
  const queue = await readQueue(root);
  // Un nom DÉRIVÉ du prompt qui a été pris entre-temps est régénéré (suffixe -2,
  // -3…) ; un nom explicite pris entre-temps est refusé (AGENT_EXISTS).
  const agent =
    generatedName && (registry[requestedAgent] || queue.some((t) => t.agent === requestedAgent))
      ? await generateAgentName(root, prompt)
      : requestedAgent;
  assertTaskAdmissible({ agent, after, registry, queue });

  const collisions = detectCollisions(predictedFiles, activeAgents(registry));
  if (collisions.length > 0 || after) {
    const task = await enqueueTask(root, {
      agent,
      prompt,
      predictedFiles,
      collisions,
      command,
      after,
      reuse,
      // Seul le consentement « secrets historiques » survit à la file : il
      // porte sur le repo, qui ne change pas de nature en attendant. Celui de
      // perdre du travail (`force`) porte sur l'état d'un clone À CET
      // INSTANT — rejoué plus tard, il couvrirait un travail apparu entre-temps
      // que personne n'a accepté de perdre.
      allowHistoricalSecrets,
    });
    const blockers = collisions.map((c) => `${c.agent} (${c.files.join(', ')})`).join(' ; ');
    const cause = [
      collisions.length > 0 ? `bloquée par ${blockers}` : '',
      after ? `attend la fin de ${after}` : '',
    ]
      .filter(Boolean)
      .join(' et ');
    await emitEvent(config, {
      type: 'task:queued',
      agent,
      taskId: task.id,
      collisions,
      after,
      message: `⛔ [Striart] Tâche ${task.id} (agent ${agent}) ${cause} — mise en file d'attente.`,
    });
    await refreshLiveMemory(root, config);
    return { status: 'QUEUED', task, predictedFiles, collisions };
  }

  // Voisinage sémantique (graphe d'imports) : AVERTIT quand la tâche touche
  // des fichiers importés par ceux d'un autre agent (ou l'inverse) — deux
  // agents peuvent se casser mutuellement sans aucun conflit Git. Jamais
  // bloquant (décision archi n°4). Le graphe est normalement déjà construit
  // (hors verrou) ; s'il manque parce que l'instantané voyait une collision
  // qui s'est levée entre-temps, il est construit ici, une fois.
  /** @type {import('./types.js').SemanticWarning[]} */
  let semanticWarnings = [];
  const graph = prebuiltGraph ?? (await tryBuildImportGraph(root, projectFiles));
  if (graph) {
    semanticWarnings = detectSemanticNeighbors({
      graph,
      predictedFiles,
      agents: activeAgents(registry),
    });
  }
  for (const warning of semanticWarnings) {
    const detail = warning.links.map((l) => `${l.importedBy} importe ${l.file}`).join(' ; ');
    await emitEvent(config, {
      type: 'router:semantic-link',
      agent,
      other: warning.agent,
      message: `⚠️ [Striart] Agent ${agent} et agent ${warning.agent} sont sémantiquement liés (${detail}) — pas de conflit Git attendu, mais le Test Gate tranchera.`,
    });
  }

  // Monorepo : les dépendances inter-packages passent par des bare
  // specifiers, invisibles pour le graphe d'imports relatif — le champ
  // workspaces les déclare. Même politique : avertir, jamais bloquer.
  const workspaceWarnings = await computeWorkspaceWarnings({
    root,
    predictedFiles,
    agents: activeAgents(registry),
  });
  for (const warning of workspaceWarnings) {
    const detail = warning.links
      .map((l) =>
        l.direction === 'depends-on'
          ? `${l.mine} dépend de ${l.theirs}`
          : `${l.theirs} dépend de ${l.mine}`,
      )
      .join(' ; ');
    await emitEvent(config, {
      type: 'router:workspace-link',
      agent,
      other: warning.agent,
      message: `⚠️ [Striart] Agent ${agent} et agent ${warning.agent} travaillent sur des packages liés (${detail}).`,
    });
  }

  const info = reuse
    ? await reuseAgent({
        root,
        name: agent,
        prompt,
        predictedFiles,
        command,
        secretPatterns: config.secretPatterns,
        mode,
        profile,
        force,
        allowHistoricalSecrets,
      })
    : await createAgent({
        root,
        name: agent,
        prompt,
        predictedFiles,
        command,
        cloneFilter: config.cloneFilter,
        secretPatterns: config.secretPatterns,
        mode,
        profile,
        allowHistoricalSecrets,
      });
  await refreshLiveMemory(root, config);
  return {
    status: 'STARTED',
    info,
    predictedFiles,
    collisions: [],
    semanticWarnings,
    workspaceWarnings,
  };
}

/**
 * Le watcher doit-il merger le commit de cet agent ?
 *
 * Non pour un agent AUTONOME : son merge appartient à `runAutonomousTask`,
 * qui le déclenche une fois, à la sortie de la session. Laisser le watcher
 * merger en parallèle produirait deux dégâts distincts :
 *
 *  - Les commits INTERMÉDIAIRES de la session partiraient dans la branche
 *    cible au fil de l'eau. Un agent qui commite trois fois en cours de route
 *    verrait du travail incomplet mergé, chaque fois avec un passage du Test
 *    Gate — alors que le contrat du mode autonome est un merge unique, en fin
 *    de session, sur un état que l'agent considère comme terminé.
 *  - Course avec la fin de cycle : si le watcher gagne, le merge final
 *    retourne UP_TO_DATE (`alreadyMerged`). `runAutonomousTask` le traite
 *    comme un travail déjà intégré (voir son merge de fin de cycle), mais le
 *    watcher aurait quand même mergé un état que l'agent n'avait pas déclaré
 *    terminé.
 *
 * Un agent absent du registre (arrêté entre l'événement et ce contrôle) ne
 * doit pas être mergé non plus.
 *
 * @param {{root: string, agent: string}} params
 * @returns {Promise<boolean>}
 */
export async function shouldWatcherMerge({ root, agent }) {
  const meta = (await readRegistry(root))[agent];
  if (!meta) return false;
  return (meta.mode ?? 'attended') !== 'autonomous';
}

/**
 * Cycle autonome complet : Router → clone → session supervisée → merge →
 * Test Gate → nettoyage. C'est le second mode d'exécution de Striart, en
 * regard du mode supervisé où l'humain lance l'outil lui-même.
 *
 * Deux invariants gouvernent cette fonction.
 *
 * 1. **Le verrou principal n'est JAMAIS tenu pendant la session.** Une session
 *    dure des minutes voire des heures ; garder `.striart/main.lock` gèlerait
 *    tout le reste de l'orchestrateur (merges des autres agents, watch,
 *    dashboard). On compose donc des primitives qui prennent le verrou
 *    chacune de leur côté, brièvement — jamais un verrou global sur le cycle.
 *
 * 2. **Le clone n'est supprimé que sur le chemin entièrement vert** : session
 *    sortie en 0, au moins un commit (de l'agent, ou de Striart selon
 *    `commitPolicy` — voir commit-policy.ts), merge réussi (garde des chemins
 *    protégés comprise), gate vert. Tout autre
 *    chemin le conserve, avec `keptReason` renseigné. Un clone est le seul
 *    matériel de diagnostic d'une session que personne n'a regardée ; le
 *    supprimer sur un échec détruirait la seule trace exploitable.
 *
 * La suite « session terminée → contrat de commit → merge → nettoyage → statut »
 * est la primitive unique `concludeAutonomousSession` (autonomous-cycle.ts),
 * partagée avec les modes orchestrés (orchestration/unit.ts) et le proxy ACP
 * (acp-agent/cycle.ts). Une session arrêtée par un plafond de tokens
 * (`BUDGET_EXCEEDED`) suit le chemin des sessions non COMPLETED : SESSION_FAILED,
 * clone conservé, `keptDetail` = 'BUDGET_EXCEEDED'.
 *
 * `signal` (Ctrl+C de la CLI) arrête la SESSION : arbre tué, statut
 * CANCELLED, clone conservé comme pour tout échec. Un arrêt demandé après la
 * session (merge, gate) n'interrompt pas ces étapes — elles prennent le
 * verrou brièvement et un second Ctrl+C reste couvert par la récupération
 * après coupure (verrou orphelin, merge orphelin).
 *
 * @param {{root: string, agent?: string|null, prompt: string, profile?: string|null, timeoutMs?: number|null, after?: string|null, reuse?: boolean, force?: boolean, allowHistoricalSecrets?: boolean, signal?: AbortSignal|null}} params
 * @returns {Promise<import('./types.js').AutonomousResult>}
 */
export async function runAutonomousTask({
  root,
  agent = null,
  prompt,
  profile = null,
  timeoutMs = null,
  after = null,
  reuse = false,
  force = false,
  allowHistoricalSecrets = false,
  signal = null,
}) {
  await assertInitialized(root);
  const config = await loadConfig(root);

  // Résolution du profil AVANT toute création de clone : un profil inconnu ou
  // mal formé doit échouer à vide, pas laisser un clone orphelin derrière lui.
  const profileKey = profile ?? DEFAULT_PROFILE;
  const resolved = resolveAgentProfile(config, profileKey);

  const started = await runTask({
    root,
    agent,
    prompt,
    command: resolved.command,
    mode: 'autonomous',
    profile: profileKey,
    after,
    reuse,
    force,
    allowHistoricalSecrets,
    // Ctrl+C pendant l'attente du verrou de démarrage : rien n'est encore créé.
    signal,
  });

  if (started.status === 'QUEUED') {
    // Collision Router : aucune session n'est lancée. La tâche repartira par
    // striart queue --retry, en mode supervisé (le mode ne survit pas à la
    // file : relancer un agent autonome est une décision humaine).
    return {
      status: 'QUEUED',
      agent: started.task.agent,
      session: null,
      merge: null,
      commit: null,
      cleaned: false,
      keptReason: null,
      keptCode: null,
      keptDetail: null,
      clonePath: null,
      task: started.task,
    };
  }

  const meta = started.info;
  const name = meta.name;

  let session;
  try {
    await updateAgentMeta(root, name, { sessionPid: process.pid });
    session = await runAgentSession({
      root,
      agent: name,
      taskId: meta.taskId,
      cwd: meta.path,
      profile: resolved,
      // Config déjà chargée et clé de profil résolue : session.js/acp.ts ne
      // relisent pas la config et appliquent les consignes du BON profil.
      config,
      profileKey,
      prompt,
      // Précédence : --timeout explicite > profile.timeout > config global.
      timeoutMs: timeoutMs ?? resolved.timeout ?? config.autonomousTimeoutMs,
      signal,
      // Le PID publié au registre rend la session visible : tant qu'il vit,
      // le clone est intouchable (pas de rebase concurrent sous les pieds
      // d'un agent que personne ne surveille). Publié en deux temps : le PID de
      // CE process AVANT le lancement (aucune fenêtre sans garde), remplacé dès
      // le spawn par celui de l'AGENT — si l'orchestrateur meurt, un agent
      // orphelin encore vivant garde son clone.
      onSpawn: async (pid) => {
        await updateAgentMeta(root, name, {
          sessionPid: pid ?? process.pid,
          sessionStartedAt: new Date().toISOString(),
        });
      },
    });
  } catch (error) {
    // Toujours dépublié, y compris si la session lève : un PID fantôme
    // gèlerait les rebases de ce clone jusqu'à son retrait du registre.
    // (Le contrôle de vitalité rattraperait le cas, mais un PID recyclé par
    // l'OS pourrait le faire mentir — mieux vaut nettoyer explicitement.)
    await updateAgentMeta(root, name, { sessionPid: null }).catch((unpublishError) => {
      logger.warn(
        { agent: name, err: unpublishError },
        'Dépublication du PID de session impossible',
      );
    });
    throw error;
  }

  // Fin de session : contrat de commit → merge (garde des chemins protégés
  // comprise) → nettoyage sans force → statut. Primitive UNIQUE du noyau
  // (autonomous-cycle.ts), partagée avec les modes orchestrés et le proxy ACP.
  // `UP_TO_DATE` + `alreadyMerged` (commit déjà dans la cible) = travail intégré :
  // MERGED, mais bruyant (`warnings: ['ALREADY_INTEGRATED']`, événement dédié).
  // Sans mergeMode différé, jamais KEPT / NOTHING_STARTED / MERGE_DEFERRED
  // (cas propres au proxy ACP) : le résultat est bien un AutonomousResult.
  return /** @type {import('./types.js').AutonomousResult} */ (
    await concludeAutonomousSession({
      root,
      config,
      meta,
      profileKey,
      profile: resolved,
      session,
      prompt,
      wording: 'runner',
    })
  );
}

/**
 * Lance un agent de coding EN DEHORS de tout clone, directement dans le
 * worktree du repo principal — supervisé exactement comme un agent autonome
 * (`runAgentSession`), mais sans merge de fin de cycle : il n'y a rien à
 * fusionner, l'agent travaille déjà sur la branche cible.
 *
 * Publie une SESSION PRINCIPALE (main-session.js) pendant toute la durée :
 * `withMainLock` (voir lock.js, `assertNoLiveMainSession`) refuse alors toute
 * autre opération mutante — merge d'un autre agent, sync, promote, resolve
 * --apply, l'auto-merge de watch — tant qu'elle vit. Symétrique de ce que
 * `sessionPid` fait déjà pour un clone (décision architecturale n°6.4) : ce
 * n'était pas décliné pour le principal, ce qui a permis à une résolution
 * manuelle en cours (raw `git merge`) d'être traitée comme un débris de
 * crash par `recoverOrphanMerge` et annulée.
 *
 * Le PID publié est CELUI DE CE PROCESS (`process.pid`), pas celui de
 * l'agent — il n'est pas encore spawné au moment de la réservation, et sa
 * durée de vie ne couvrirait pas exactement celle de cette fonction. Le
 * process courant, lui, vit exactement le temps de tout `runMainSession`
 * (spawn + attente + nettoyage compris) : c'est la bonne horloge.
 *
 * La vérification ET la réservation sont faites ATOMIQUEMENT sous
 * `withMainLock` — pas seulement lues puis publiées à part — pour deux
 * raisons à la fois : (1) empêcher deux appels concurrents de passer tous
 * les deux le contrôle avant que l'un des deux ne publie ; (2) empêcher
 * cette fonction de démarrer PENDANT qu'un merge/sync/promote/resolve
 * --apply tient déjà le verrou — `withMainLock` attend alors leur fin avant
 * de nous laisser réserver, on ne peut plus se glisser en dessous d'une
 * opération déjà en vol (l'inverse de l'incident d'origine, tout aussi réel).
 *
 * Ne tient PAS `withMainLock` pendant la session elle-même (elle dure des
 * minutes ou des heures) — seule cette réservation initiale, quasi
 * instantanée, passe par le verrou ; la dépublication en fin de session est
 * un accès direct au fichier, sans verrou (même principe que
 * `updateAgentMeta` pour un clone).
 *
 * `signal` (Ctrl+C de la CLI) tue l'agent avant la dépublication : jamais
 * une session principale dépubliée pendant que l'agent écrit encore dans le
 * worktree du principal.
 *
 * @param {{root: string, prompt: string, profile?: string|null, timeoutMs?: number|null, reason?: string|null, signal?: AbortSignal|null}} params
 * @returns {Promise<import('./types.js').SessionResult>}
 */
export async function runMainSession({
  root,
  prompt,
  profile = null,
  timeoutMs = null,
  reason = null,
  signal = null,
}) {
  await assertInitialized(root);
  const config = await loadConfig(root);
  // Profil validé AVANT toute réservation : un profil inconnu ne doit pas
  // laisser une session principale publiée sans agent qui la justifie.
  const profileKey = profile ?? DEFAULT_PROFILE;
  const resolved = resolveAgentProfile(config, profileKey);

  await withMainLock(
    root,
    'main-session:reserve',
    async () => {
      await assertNoLiveMainSession(root);
      await startMainSession(root, { pid: process.pid, reason: reason ?? prompt });
    },
    // Ctrl+C pendant l'attente de la réservation : rien n'est encore publié.
    { signal },
  );

  const taskId = `main-${Date.now().toString(36)}`;
  try {
    return await runAgentSession({
      root,
      agent: 'main',
      taskId,
      cwd: root,
      profile: resolved,
      config,
      profileKey,
      // Repo principal : aucune consigne de clone n'y est injectée.
      onMain: true,
      prompt,
      timeoutMs: timeoutMs ?? resolved.timeout ?? config.autonomousTimeoutMs,
      signal,
    });
  } finally {
    // Retrait CONDITIONNEL à notre PID : un humain a pu libérer puis
    // re-réserver le principal pendant la session (`lock --stop` puis
    // `lock --start`) — sa réservation n'est jamais retirée ici. Un échec
    // est journalisé, jamais tu : la session déclarée reste et bloque tant
    // que ce process vit (`striart lock --stop` est la sortie de secours).
    await stopMainSession(root, { expectPid: process.pid }).catch((error) => {
      logger.warn({ err: error }, 'Dépublication de la session principale impossible');
    });
  }
}

/**
 * Annule le merge en cours du repo principal. Garde : le verrou doit être
 * toujours à nous (LOCK_LOST sinon) — annuler sous un verrou perdu
 * détruirait le merge de l'opération qui l'a repris.
 * @param {import('simple-git').SimpleGit} git
 * @param {string} root
 */
async function abortMerge(git, root) {
  await assertMainLockHeld(root);
  try {
    await git.raw(['merge', '--abort']);
    return;
  } catch {
    // Soit pas de merge en cours (rien à annuler), soit abort échoué : on vérifie.
  }
  const stillMerging = await git.revparse(['-q', '--verify', 'MERGE_HEAD']).then(
    () => true,
    () => false,
  );
  if (stillMerging) {
    // Repo principal bloqué en état "merging" : tout merge suivant échouerait
    // silencieusement — alerte critique plutôt que try/catch muet.
    throw new StriartError(
      'git merge --abort a échoué : le repo principal est bloqué en état "merging". ' +
        'Intervention manuelle requise ("git merge --abort" puis vérifier "git status").',
      { code: 'MERGE_ABORT_FAILED', hint: 'git merge --abort' },
    );
  }
}

/** Taille max du log de gate réinjecté dans le prompt du Merger (fin du log). */
const GATE_FEEDBACK_MAX_CHARS = 4000;

/**
 * Le Merger a-t-il été REFUSÉ par un budget (plafond de tokens, prix manquant
 * pour un plafond de coût, fenêtre du Merger dépassée) plutôt que mis en échec ?
 * Un refus n'est pas un échec du LLM : aucun appel n'est parti. Il ouvre le
 * ticket humain comme tout échec de fusion, mais ne compte PAS dans la série
 * d'échecs sémantiques — trois refus de budget ne doivent pas basculer le dépôt
 * en mode manuel (règle d'or n°4), sinon un plafond atteint verrouillerait la
 * fusion sémantique jusqu'à `striart resolve --unlock` alors que le LLM va bien.
 * @param {unknown} error
 * @returns {boolean}
 */
function isBudgetRefusal(error) {
  const code = /** @type {{code?: unknown}|null} */ (error)?.code;
  return (
    code === 'TOKEN_BUDGET_EXCEEDED' ||
    code === 'TOKEN_PRICE_MISSING' ||
    code === 'MERGE_WINDOW_EXCEEDED'
  );
}

/**
 * Fusionne un fichier en conflit via le Merger LLM et applique le résultat
 * au worktree + index du repo principal (bit exécutable préservé).
 * `feedback` : log d'un Test Gate rouge à réinjecter (retry post-gate).
 *
 * `integrity` (retry post-gate) : le contrôle d'intégrité du merge en cours.
 * Avant d'écrire, l'état est vérifié contre lui (un tiers qui a touché au
 * principal pendant l'appel LLM n'est pas absorbé) ; APRÈS chaque écriture,
 * l'empreinte d'index attendue est relevée ici — seul endroit qui connaît la
 * dernière écriture de Striart. Sans cela, un LLM qui échoue sur le fichier 2
 * après l'écriture du fichier 1 laisserait l'empreinte datée d'avant le retry :
 * l'abort propre verrait « quelqu'un a agi » et laisserait le merge ouvert.
 *
 * `agent` / `taskId` : attribution de l'appel du Merger dans le registre d'usage
 * (`withTokenContext`) — sans eux les budgets perTask / perAgent seraient aveugles
 * à ces appels.
 * @param {{mainGit: import('simple-git').SimpleGit, root: string, config: import('./types.js').StriartConfig, agent?: string|null, taskId?: string|null, res: {path: string, base: string, ours: string, theirs: string, modes: import('./types.js').StageModes, llmAttempt?: string}, feedback?: string|null, integrity?: Parameters<typeof assertMergeIntact>[0]|null}} params
 */
async function mergeResolutionWithLlm({
  mainGit,
  root,
  config,
  agent = null,
  taskId = null,
  res,
  feedback = null,
  integrity = null,
}) {
  res.llmAttempt = await withTokenContext({ root, agent, taskId }, () =>
    semanticMerge({
      filePath: res.path,
      base: res.base,
      ours: res.ours,
      theirs: res.theirs,
      config,
      feedback,
    }),
  );
  // L'appel LLM peut durer des minutes : un détenteur qui aurait perdu le
  // verrou pendant ce temps (cassé pendant un gel) ne doit pas écrire dans
  // le worktree ni l'index d'un merge qui n'est plus le sien.
  // Dès la PREMIÈRE passe : verrou toujours à nous, MERGE_HEAD et HEAD inchangés
  // (un merge annulé pendant l'appel ne reçoit pas la fusion). L'empreinte de
  // l'index n'est contrôlée qu'une fois relevée (après notre première écriture).
  if (integrity) await assertMergeIntact(integrity);
  else await assertMainLockHeld(root);
  assertTicketPathSafe(null, res.path);
  await writeFile(path.join(root, res.path), res.llmAttempt, 'utf8');
  // --literal-pathspecs : `[id].tsx` est un nom, jamais un motif.
  await mainGit.raw(['--literal-pathspecs', 'add', '--', res.path]);
  // writeFile ne préserve pas le bit exécutable (et il n'existe pas sur
  // NTFS) : on le repose dans l'index quand les deux côtés l'avaient —
  // la classification a déjà routé les modes divergents en ticket.
  if (isExecutableMode(res.modes.ours)) {
    await mainGit.raw(['update-index', '--chmod=+x', '--', res.path]);
  }
  if (integrity) integrity.expectedIndex = await indexFingerprint(mainGit);
}

/**
 * Parse `git ls-files -u -z` (entrées NUL-séparées "mode sha stage\tpath") en
 * map chemin → modes des stages { base, ours, theirs }.
 * @param {string} raw
 * @returns {Record<string, import('./types.js').StageModes>}
 */
function parseStageModes(raw) {
  /** @type {Record<string, import('./types.js').StageModes>} */
  const modes = {};
  /** @type {Record<string, 'base'|'ours'|'theirs'>} */
  const STAGE_KEYS = { 1: 'base', 2: 'ours', 3: 'theirs' };
  for (const entry of raw.split(String.fromCharCode(0))) {
    const match = entry.match(/^(\d{6}) \S+ ([123])\t(.+)$/s);
    if (!match) continue;
    const [, mode, stage, filePath] = match;
    const normalized = filePath.replaceAll('\\', '/');
    (modes[normalized] ??= {})[STAGE_KEYS[stage]] = mode;
  }
  return modes;
}

/** Recouvrement de lignes minimal pour désigner l'héritier probable d'un fichier disparu. */
const RENAME_HAZARD_MIN_OVERLAP = 0.5;
/** Nombre max de fichiers ajoutés comparés par côté (borne le coût du scan). */
const RENAME_HAZARD_MAX_ADDED = 20;
const NUL = String.fromCharCode(0);

/** `git diff --name-status --no-renames -z` → { deleted: string[], added: string[] }. */
async function sideChanges(git, mergeBase, ref) {
  const raw = await git.raw([
    'diff',
    '--name-status',
    '--no-renames',
    '-z',
    `${mergeBase}..${ref}`,
  ]);
  const tokens = raw.split(NUL).filter(Boolean);
  const deleted = [];
  const added = [];
  for (let i = 0; i + 1 < tokens.length; i += 2) {
    if (tokens[i] === 'D') deleted.push(tokens[i + 1]);
    else if (tokens[i] === 'A') added.push(tokens[i + 1]);
  }
  return { deleted, added };
}

async function showOrNull(git, ref, filePath) {
  try {
    const content = await git.show([`${ref}:${filePath}`]);
    // Binaire ou trop gros : pas de comparaison de lignes fiable.
    if (content.includes(NUL) || content.length > MAX_MERGE_INPUT_CHARS) return null;
    return content;
  } catch {
    return null;
  }
}

/**
 * Détecte le double-renommage invisible pour git, sur un merge PROPRE :
 * quand un renommage passe sous le seuil de rename detection (petits fichiers,
 * grosses réécritures), chaque côté apparaît comme suppression + ajout, les
 * deux suppressions se fondent, et le fichier ressort EN DOUBLE sans aucun
 * conflit signalé. Signature recherchée : un fichier supprimé des deux côtés
 * depuis l'ancêtre commun, dont le contenu se retrouve majoritairement
 * (recouvrement de lignes, insensible aux chunks git) dans un fichier ajouté
 * de CHAQUE côté, sous deux noms différents.
 * Avertissement non bloquant : deux suppressions volontaires identiques sont
 * légitimes — on signale, le Test Gate et l'humain tranchent.
 * `oursRef`/`theirsRef` : main et la tête d'agent AVANT rebase (le rebase
 * absorbe la double-suppression et efface la signature).
 * @param {import('simple-git').SimpleGit} git
 * @param {string} oursRef
 * @param {string} theirsRef
 * @returns {Promise<import('./types.js').RenameHazard[]>}
 */
async function detectSilentRenameHazards(git, oursRef, theirsRef) {
  const mergeBase = (await git.raw(['merge-base', oursRef, theirsRef])).trim();
  const [ours, theirs] = await Promise.all([
    sideChanges(git, mergeBase, oursRef),
    sideChanges(git, mergeBase, theirsRef),
  ]);
  const dualDeleted = ours.deleted.filter((f) => theirs.deleted.includes(f));
  if (dualDeleted.length === 0) return [];

  const bestHeir = async (baseContent, ref, addedFiles) => {
    let best = null;
    for (const added of addedFiles.slice(0, RENAME_HAZARD_MAX_ADDED)) {
      const content = await showOrNull(git, ref, added);
      if (content == null) continue;
      const overlap = lineOverlap(baseContent, content);
      if (overlap >= RENAME_HAZARD_MIN_OVERLAP && (best == null || overlap > best.overlap)) {
        best = { path: added, overlap };
      }
    }
    return best;
  };

  const hazards = [];
  for (const source of dualDeleted) {
    const baseContent = await showOrNull(git, mergeBase, source);
    if (baseContent == null) continue;
    const [oursHeir, theirsHeir] = await Promise.all([
      bestHeir(baseContent, oursRef, ours.added),
      bestHeir(baseContent, theirsRef, theirs.added),
    ]);
    if (oursHeir && theirsHeir && oursHeir.path !== theirsHeir.path) {
      hazards.push({ source, ours: oursHeir.path, theirs: theirsHeir.path });
    }
  }
  return hazards;
}

// La synchronisation (rebase, fetch silencieux) vit dans sync.js ;
// ré-exportée ici pour les consommateurs historiques (CLI, tests).
export { checkAgentsBehind, syncAgentWithMain, syncAllAgents } from './sync.js';

/**
 * Garde-fous partagés merge/promotion :
 *  - aucune modification non commitée de fichiers SUIVIS dans le repo
 *    principal (le travail de l'humain serait mélangé à l'opération ;
 *    les untracked ne bloquent pas, git ne les touche pas) ;
 *  - repo principal sur la branche attendue — pas de checkout silencieux.
 * @param {import('simple-git').SimpleGit} mainGit
 * @param {string} expectedBranch
 */
async function assertMainReady(mainGit, expectedBranch) {
  const status = await mainGit.status();
  const dirtyFiles = [
    ...status.staged,
    ...status.created,
    ...status.modified,
    ...status.deleted,
    ...status.renamed.map((r) => r.to),
    ...status.conflicted,
  ];
  if (dirtyFiles.length > 0) {
    throw new StriartError(
      "Le repo principal a des modifications non commitées. Commit ou stash d'abord.",
      { code: 'MAIN_DIRTY', hint: 'git status', details: { files: [...new Set(dirtyFiles)] } },
    );
  }
  const currentBranch = (await mainGit.revparse(['--abbrev-ref', 'HEAD'])).trim();
  if (currentBranch !== expectedBranch) {
    throw new StriartError(
      `Le repo principal est sur "${currentBranch}" mais la branche attendue est "${expectedBranch}". Checkout la branche ou ajuste striart.config.`,
      {
        code: 'TARGET_BRANCH_MISMATCH',
        hint: `git switch ${expectedBranch}`,
        details: { currentBranch, expectedBranch },
      },
    );
  }
}

/**
 * `ancestor` est-il ancêtre de (ou égal à) `descendant` ? Pas de `merge-base
 * --is-ancestor` : simple-git ne distingue pas son code de sortie 1 (« pas
 * ancêtre ») d'un succès (voir aussi clone.js). Le comptage rev-list est sans
 * ambiguïté ; une ref inconnue lève (à l'appelant de trancher).
 * @param {import('simple-git').SimpleGit} git @param {string} ancestor @param {string} descendant
 */
async function isAncestorCommit(git, ancestor, descendant) {
  const ahead = Number.parseInt(
    (await git.raw(['rev-list', '--count', `${descendant}..${ancestor}`])).trim(),
    10,
  );
  return ahead === 0;
}

/**
 * Le commit de la cible (HEAD) qui porte déjà `sha` : `sha` lui-même s'il est la
 * pointe (fast-forward), sinon son premier descendant sur le chemin vers la
 * pointe (le commit de merge qui l'a intégré). null si `sha` n'est pas dans la cible.
 * @param {import('simple-git').SimpleGit} git @param {string} sha
 * @returns {Promise<string|null>}
 */
async function findTargetCarrier(git, sha) {
  const head = (await git.revparse(['HEAD'])).trim();
  if (head === sha) return sha;
  const out = await git
    .raw(['rev-list', '--reverse', '--ancestry-path', `${sha}..HEAD`])
    .catch(() => '');
  return out.split('\n')[0]?.trim() || null;
}

/**
 * Commit du merge ouvert par l'opération. Un refus de git (hook pre-commit /
 * commit-msg, identité absente) n'abandonne pas le principal en état « merging »
 * avec une erreur brute : le merge est annulé (s'il est toujours le nôtre) et
 * l'échec est nommé. Si l'annulation elle-même est refusée (état changé, verrou
 * perdu), CETTE erreur-là prime : l'état n'est plus le nôtre.
 * @param {Parameters<typeof assertMergeIntact>[0]} integrity
 * @param {string} message
 */
async function commitMergeOrAbort(integrity, message) {
  try {
    await integrity.mainGit.commit(message);
  } catch (error) {
    await abortOwnMerge(integrity);
    const cause = String(/** @type {Error} */ (error)?.message ?? error)
      .replace(/\s+/g, ' ')
      .slice(0, 500);
    throw new StriartError(
      `git a refusé le commit de merge de "${integrity.agent}" (${cause}) : merge annulé, rien n'a été commité.`,
      {
        code: 'MERGE_COMMIT_FAILED',
        hint: 'git config user.name / user.email, ou corrige le hook pre-commit / commit-msg du dépôt, puis relance le merge',
        details: { agent: integrity.agent, operation: integrity.operation, cause },
        cause: error,
      },
    );
  }
}

/** MERGE_HEAD du repo principal, null hors merge. */
async function readMergeHead(git) {
  const out = await git.raw(['rev-parse', '-q', '--verify', 'MERGE_HEAD']).catch(() => '');
  return out.trim() || null;
}

/**
 * Contrôle d'intégrité juste avant un effet irréversible sur un merge ouvert
 * par l'opération courante (commit, ou abort qui le défait) : verrou
 * toujours à nous (LOCK_LOST), MERGE_HEAD = le SHA exact que NOUS avons
 * mergé, HEAD = celui d'avant notre merge (MERGE_STATE_CHANGED). Un Test
 * Gate ou un appel LLM peut durer des minutes : quelqu'un a pu agir sur le
 * principal entre-temps. En cas d'écart, rien n'est commité NI annulé —
 * l'état n'est plus le nôtre, le défaire détruirait le travail d'un autre ;
 * il reste récupérable (la prochaine acquisition annule un merge orphelin).
 * @param {{root: string, mainGit: import('simple-git').SimpleGit, operation: string, agent: string, expectedMergeHead: string, expectedHead: string, expectedIndex?: string | null}} params
 */
async function assertMergeIntact({
  root,
  mainGit,
  operation,
  agent,
  expectedMergeHead,
  expectedHead,
  expectedIndex = null,
}) {
  await assertMainLockHeld(root);
  const actualMergeHead = await readMergeHead(mainGit);
  const actualHead = (await mainGit.revparse(['HEAD']).catch(() => '')).trim() || null;
  // L'index est ce que le commit emportera : s'il a bougé depuis notre
  // dernière écriture (process fantôme dégelé, `git add` d'un tiers ou du
  // gate), le commit mélangerait un travail que personne n'a validé.
  const indexChanged =
    expectedIndex !== null && (await indexFingerprint(mainGit).catch(() => null)) !== expectedIndex;
  if (actualMergeHead === expectedMergeHead && actualHead === expectedHead && !indexChanged) return;
  // Le merge ouvert n'est plus (seulement) le nôtre : la prochaine
  // acquisition ne doit PAS l'annuler en le prenant pour un débris.
  let markerWritten = true;
  await recordMergeStateChanged(root, { operation, agent, mergeHead: actualMergeHead }).catch(
    (error) => {
      markerWritten = false;
      logger.error({ err: error.message }, 'Marqueur MERGE_STATE_CHANGED non posé');
    },
  );
  throw new StriartError(
    `L'état du repo principal a changé pendant « ${operation} » : MERGE_HEAD ` +
      `${actualMergeHead?.slice(0, 8) ?? 'absent'} (attendu ${expectedMergeHead.slice(0, 8)}), HEAD ` +
      `${actualHead?.slice(0, 8) ?? 'absent'} (attendu ${expectedHead.slice(0, 8)})` +
      `${indexChanged ? ', index modifié depuis la dernière écriture de Striart' : ''}. Rien n'a été commité : ` +
      "quelqu'un a agi sur le repo principal entre-temps — vérifie avant de relancer. " +
      (markerWritten
        ? "Striart n'annulera pas ce merge lui-même tant qu'il reste ouvert (MERGE_RECOVERY_BLOCKED)."
        : "Le marqueur de protection n'a PAS pu être écrit : la prochaine opération Striart pourrait " +
          'annuler ce merge ouvert — termine-le ou annule-le toi-même avant de relancer.'),
    {
      code: 'MERGE_STATE_CHANGED',
      hint: 'git status',
      details: {
        operation,
        agent,
        expectedMergeHead,
        actualMergeHead,
        expectedHead,
        actualHead,
        indexChanged,
        markerWritten,
      },
    },
  );
}

/**
 * Empreinte de l'index du repo principal (entrées, modes, blobs, stages) :
 * relevée après la dernière écriture de Striart dans l'index, comparée
 * avant le commit (assertMergeIntact).
 * @param {import('simple-git').SimpleGit} git
 */
async function indexFingerprint(git) {
  const listing = await git.raw(['ls-files', '--stage', '-z']);
  return createHash('sha256').update(listing).digest('hex');
}

/**
 * Annule un merge ouvert par l'opération courante, après avoir vérifié
 * qu'il est toujours le sien (assertMergeIntact).
 * @param {Parameters<typeof assertMergeIntact>[0]} params
 */
async function abortOwnMerge(params) {
  await assertMergeIntact(params);
  await abortMerge(params.mainGit, params.root);
}

/**
 * Post-commit partagé entre `mergeAgentCommitImpl` et
 * `applyTicketResolutionImpl` : push (si `autoPush`) et Memory Layer (si
 * `memoryLayer`). Factorisé pour que la résolution manuelle ait exactement
 * le même comportement que le merge automatique — un oubli ici privait
 * silencieusement `striart resolve --apply` du push et de la Memory Layer.
 * @param {{mainGit: import('simple-git').SimpleGit, root: string, config: import('./types.js').StriartConfig, agent: string, taskId?: string|null, sha: string}} params
 * @returns {Promise<{mergeSha: string, pushError: string|null, memory: {updated: boolean, entry?: string, error?: string}|null}>}
 */
async function finalizeMergeCommit({ mainGit, root, config, agent, taskId = null, sha }) {
  // Le commit de merge lui-même (sur la branche cible) — distinct de `sha`,
  // le commit de l'agent qui a été mergé. C'est lui qu'un rollback défait.
  const mergeSha = (await mainGit.revparse(['HEAD'])).trim();
  let pushError = null;
  if (config.autoPush) {
    try {
      await mainGit.push('origin', config.targetBranch);
    } catch (error) {
      // Le merge local reste valide : on remonte l'erreur de push sans le défaire.
      pushError = error.message;
      logger.error({ err: error }, `Push vers origin/${config.targetBranch} échoué`);
    }
  }

  // Memory Layer (advisory) : résumé LLM du merge, diffusé à tous les clones
  // avec la section temps réel « qui travaille sur quoi ».
  let memory = null;
  if (config.memoryLayer) {
    const diff = await mainGit.raw(['diff', 'HEAD^1', 'HEAD']).catch(() => '');
    const effects = effectsContext.getStore();
    if (effects) {
      // Le résumé est un appel LLM : il part APRÈS la libération du verrou
      // (invariant n°1) et son résultat est reporté dans `result.memory`
      // par runWithDeferredEffects. Attribué à l'agent et à sa tâche.
      effects.memory = { root, config, agent, taskId, sha, diff };
    } else {
      memory = await withTokenContext({ root, agent, taskId }, () =>
        updateMemoryAfterMerge({ root, config, agent, sha, diff }),
      );
      await refreshLiveMemory(root, config);
    }
  }
  return { mergeSha, pushError, memory };
}

/**
 * Relâchements de la garde des chemins protégés : journalisés à CHAQUE merge
 * (D12) — un `allow` oublié dans la config ne devient jamais invisible.
 * @param {import('./protected-paths.ts').ProtectedPathsPolicy} policy
 * @param {string} agent
 */
function logProtectedPathsRelaxation(policy, agent) {
  if (policy.relaxed.allow.length === 0 && !policy.relaxed.caseSensitive) return;
  logger.warn(
    { agent, allow: policy.relaxed.allow, caseSensitive: policy.relaxed.caseSensitive },
    'Garde des chemins protégés RELÂCHÉE par la config (protectedAgentPaths.allow / matchCase)',
  );
}

/**
 * Contenu d'un fichier à une révision, null s'il n'y existe pas.
 * @param {import('simple-git').SimpleGit} git @param {string} rev @param {string} filePath
 * @returns {Promise<string|null>}
 */
async function showAtRev(git, rev, filePath) {
  try {
    return await git.show([`${rev}:${filePath}`]);
  } catch {
    return null;
  }
}

/**
 * Garde I2 : si le merge de `sha` changerait un chemin protégé, le merge est
 * REFUSÉ et un ticket PROTECTED_PATHS_CHANGED est ouvert — avant toute fusion
 * LLM et avant le Test Gate (fail closed, décision D4). Le merge est ouvert
 * puis annulé le temps de relever aussi les conflits textuels : le ticket
 * couvre ainsi TOUT ce que l'humain doit trancher pour que `resolve --apply`
 * aboutisse (chaque chemin protégé + chaque conflit), sans aller-retour.
 * Rend null quand rien de protégé ne change.
 * @param {{root: string, mainGit: import('simple-git').SimpleGit, config: import('./types.js').StriartConfig, policy: import('./protected-paths.ts').ProtectedPathsPolicy, agent: string, meta: import('./types.js').AgentMeta, sha: string, rebase: import('./types.js').SyncResult|null}} params
 * @returns {Promise<import('./types.js').MergeResult|null>}
 */
async function refuseProtectedPathsMerge({
  root,
  mainGit,
  config,
  policy,
  agent,
  meta,
  sha,
  rebase,
}) {
  const scan = await findProtectedChanges({ git: mainGit, ours: 'HEAD', theirs: sha, policy });
  for (const exempt of scan.exempted) {
    logger.warn(
      { agent, sha, path: exempt.path, pattern: exempt.pattern, allow: exempt.exemptedBy },
      'Chemin protégé changé par un agent, laissé passer par protectedAgentPaths.allow',
    );
  }
  if (scan.changes.length === 0) return null;

  const mergeBase = (await mainGit.raw(['merge-base', 'HEAD', sha])).trim();
  const headBefore = (await mainGit.revparse(['HEAD'])).trim();
  let mergeError = null;
  try {
    await mainGit.raw(['merge', sha, '--no-commit', '--no-ff']);
  } catch (error) {
    mergeError = error;
  }
  const conflicted = (await mainGit.status()).conflicted;
  const opened = (await readMergeHead(mainGit)) === sha;
  /** @type {Array<{path: string, base: string|null, ours: string|null, theirs: string|null}>} */
  const resolutions = [];
  try {
    for (const file of conflicted) {
      resolutions.push({ path: file, ...(await extractConflictVersions(mainGit, file)) });
    }
    for (const change of scan.changes) {
      if (conflicted.includes(change.path)) continue;
      resolutions.push({
        path: change.path,
        base: await showAtRev(mainGit, mergeBase, change.path),
        ours: await showAtRev(mainGit, headBefore, change.path),
        theirs: await showAtRev(mainGit, sha, change.path),
      });
    }
  } finally {
    if (opened) {
      await abortOwnMerge({
        root,
        mainGit,
        operation: `merge:${agent}`,
        agent,
        expectedMergeHead: sha,
        expectedHead: headBefore,
      });
    } else if (mergeError || conflicted.length > 0) {
      await abortMerge(mainGit, root);
    }
  }

  const protectedFiles = scan.changes.map((c) => c.path);
  const conflictedFiles = [...new Set([...protectedFiles, ...conflicted])];
  const ticket = await createConflictTicket(root, {
    agent,
    branch: meta.branch,
    sha,
    reason: 'PROTECTED_PATHS_CHANGED',
    conflictedFiles,
    prompt: meta.prompt,
    resolutions,
    protectedChanges: scan.changes,
    mergeConflictedFiles: conflicted,
  });
  await emitEvent(config, {
    type: 'merge:protected-paths',
    agent,
    ticketId: ticket.id,
    files: protectedFiles,
    message: `⛔ [Striart] Merge de ${agent} refusé : chemins protégés modifiés (${protectedFiles.join(', ')}) — ticket ${ticket.id}, décision humaine requise.`,
  });
  const state = await readState(root);
  return {
    status: 'CONFLICT',
    reason: 'PROTECTED_PATHS_CHANGED',
    manualMode: state.manualMode,
    agent,
    sha,
    conflictedFiles,
    protectedChanges: scan.changes,
    ticket,
    rebase,
  };
}
/**
 * Merge le dernier commit d'un agent dans le repo principal,
 * derrière le Test Gate bloquant (Phase 2).
 *
 *   git fetch <clone> <branche>  →  git merge FETCH_HEAD --no-commit --no-ff
 *   Test Gate vert  → commit (+ push si autoPush)
 *   Test Gate rouge → merge --abort + ticket GATE_FAILED
 *   Conflit textuel → fusion sémantique via Ollama (Phase 3) puis re-Test Gate ;
 *                     si LLM ou gate échoue → merge --abort + ticket humain.
 *                     3 échecs sémantiques d'affilée → mode manuel (règle d'or n°4).
 *
 * Retourne { status: 'UP_TO_DATE'|'MERGED'|'CONFLICT'|'GATE_FAILED', ... }.
 */
/** @param {{root: string, agent: string, signal?: AbortSignal|null}} params @returns {Promise<import('./types.js').MergeResult>} */
export async function mergeAgentCommit(params) {
  // `signal` n'annule que l'ATTENTE du verrou, jamais un merge commencé.
  return runWithDeferredEffects(() =>
    withMainLock(params.root, `merge:${params.agent}`, () => mergeAgentCommitImpl(params), {
      signal: params.signal ?? null,
    }),
  );
}

/** @returns {Promise<import('./types.js').MergeResult>} */
async function mergeAgentCommitImpl({ root, agent }) {
  await assertInitialized(root);
  const config = await loadConfig(root);
  const registry = await readRegistry(root);
  let meta = registry[agent];
  if (!meta) {
    throw agentUnknownError(agent);
  }

  // Merger une session vivante enverrait ses commits INTERMÉDIAIRES dans la
  // branche cible et ferait courir ce merge contre le merge final du cycle —
  // la course peut laisser le repo principal en état « merging » (raison pour
  // laquelle le watcher ignore déjà les agents autonomes, shouldWatcherMerge).
  assertNoLiveSession(agent, meta, 'Merge');

  const mainGit = simpleGit(root);

  await assertMainReady(mainGit, config.targetBranch);

  // Traque du double-renommage invisible AVANT le rebase : le rebase rejoue
  // "suppression + ajout" de l'agent sur main et absorbe la double-suppression —
  // après lui, la signature a disparu. Best effort, jamais bloquant.
  /** @type {import('./types.js').RenameHazard[]} */
  let renameHazards = [];
  /** @type {string|null} */
  let preRebaseHead = null;
  try {
    preRebaseHead = await fetchBranchToRef(mainGit, meta.path, meta.branch, incomingRef(agent));
  } catch (error) {
    // Le fetch qui fait foi est refait après le rebase : il tranchera.
    logger.warn({ err: error }, 'Fetch du clone avant rebase échoué (refait après)');
  }
  const pendingBeforeRebase =
    preRebaseHead !== null && preRebaseHead !== (meta.lastMergedCommit ?? meta.baseCommit);
  if (pendingBeforeRebase) {
    try {
      renameHazards = await detectSilentRenameHazards(mainGit, 'HEAD', preRebaseHead);
    } catch (error) {
      logger.warn({ err: error }, 'Détection de renommage divergent échouée (ignorée)');
    }
  }
  for (const hazard of renameHazards) {
    await emitEvent(config, {
      type: 'merge:rename-hazard',
      agent,
      source: hazard.source,
      ours: hazard.ours,
      theirs: hazard.theirs,
      message: `⚠️ [Striart] Merge de ${agent} : ${hazard.source} supprimé des deux côtés et son contenu réapparaît sous DEUX noms (main: ${hazard.ours}, agent: ${hazard.theirs}) — probable double-renommage non détecté par git, le fichier existera en double.`,
    });
  }

  // Garde des chemins protégés (I2), AVANT le rebase : un merge refusé ne
  // réécrit pas le clone. Réévaluée plus bas sur le SHA exact mergé (le
  // rebase a pu le changer) — c'est ce second contrôle qui fait foi.
  const protectedPolicy = resolveProtectedPathsPolicy(config);
  logProtectedPathsRelaxation(protectedPolicy, agent);
  /** @param {string} sha @param {import('./types.js').SyncResult|null} rebaseResult */
  const protectedGuard = (sha, rebaseResult) =>
    refuseProtectedPathsMerge({
      root,
      mainGit,
      config,
      policy: protectedPolicy,
      agent,
      meta,
      sha,
      rebase: rebaseResult,
    });
  if (pendingBeforeRebase) {
    const refused = await protectedGuard(/** @type {string} */ (preRebaseHead), null);
    if (refused) return refused;
  }

  // Rebase préalable (Phase 4) : l'agent repart du code le plus récent,
  // le merge devient trivial dans le cas nominal. En cas de conflit de
  // rebase, on retombe sur le merge classique + fusion sémantique.
  let rebase = null;
  if (config.autoRebase) {
    rebase = await syncAgentWithMain({ root, agent, config });
    if (rebase.status === 'REBASED') {
      meta = (await readRegistry(root))[agent]; // baseCommit/lastMergedCommit mis à jour
    }
  }

  // UN seul SHA pour tout le cycle : celui que le fetch a déposé dans la ref
  // privée de l'agent. C'est lui qui est mergé, mis dans le sujet du commit,
  // dans les tickets et dans lastMergedCommit. Lire la tête du clone à part
  // laissait un commit de l'agent s'intercaler entre la lecture et le fetch :
  // le SHA enregistré n'était alors plus celui mergé (audit L1).
  const agentHead = await fetchBranchToRef(mainGit, meta.path, meta.branch, incomingRef(agent));
  const lastMerged = meta.lastMergedCommit ?? meta.baseCommit;
  if (agentHead === lastMerged) {
    // `lastMergedCommit` explicite : ce travail a DÉJÀ été mergé (par le watcher,
    // une résolution manuelle…). Sans lui, `lastMerged` est la base du clone :
    // l'agent n'a simplement rien de neuf.
    if (meta.lastMergedCommit) {
      const mergeSha = await findTargetCarrier(mainGit, agentHead);
      return {
        status: 'UP_TO_DATE',
        agent,
        sha: agentHead,
        rebase,
        alreadyMerged: true,
        ...(mergeSha ? { mergeSha } : {}),
      };
    }
    return { status: 'UP_TO_DATE', agent, sha: agentHead, rebase };
  }
  // Déjà contenu dans la cible (arrivé par un autre chemin, ou agent
  // fast-forwardé sur la cible par son rebase) : `merge --no-commit --no-ff`
  // dirait « Already up to date » sans poser de MERGE_HEAD — Test Gate
  // dépensé pour rien, puis faux MERGE_STATE_CHANGED. Rien à merger :
  // UP_TO_DATE, et la référence de comptage suit (le travail EST mergé).
  const notInTarget = Number.parseInt(
    (await mainGit.raw(['rev-list', '--count', agentHead, '^HEAD'])).trim(),
    10,
  );
  if (notInTarget === 0) {
    await updateAgentMeta(root, agent, { lastMergedCommit: agentHead });
    const mergeSha = await findTargetCarrier(mainGit, agentHead);
    return {
      status: 'UP_TO_DATE',
      agent,
      sha: agentHead,
      rebase,
      alreadyMerged: true,
      ...(mergeSha ? { mergeSha } : {}),
    };
  }
  if (!pendingBeforeRebase || agentHead !== preRebaseHead) {
    const refused = await protectedGuard(agentHead, rebase);
    if (refused) return refused;
  }

  const headBefore = (await mainGit.revparse(['HEAD'])).trim();
  const mergeIntegrity = {
    root,
    mainGit,
    operation: `merge:${agent}`,
    agent,
    expectedMergeHead: agentHead,
    expectedHead: headBefore,
    /** Empreinte de l'index après la dernière écriture de Striart (null : pas encore relevée). */
    expectedIndex: /** @type {string | null} */ (null),
  };
  // Un merge en conflit ne throw pas toujours côté simple-git avec --no-commit :
  // on vérifie l'état de conflit dans tous les cas, exception ou non.
  let mergeError = null;
  try {
    await mainGit.raw(['merge', agentHead, '--no-commit', '--no-ff']);
  } catch (error) {
    mergeError = error;
  }
  const conflicted = (await mainGit.status()).conflicted;
  let semantic = null;
  if (conflicted.length > 0) {
    // Les 3 versions sont extraites AVANT tout merge --abort : après, l'index est vidé.
    // Les modes des stages (`git ls-files -u`) portent ce que le contenu ne dit
    // pas : submodule (160000), symlink (120000), bit exécutable (100755).
    const stageModes = parseStageModes(await mainGit.raw(['ls-files', '-u', '-z']));
    const resolutions = [];
    for (const file of conflicted) {
      resolutions.push({
        path: file,
        modes: stageModes[file] ?? {},
        ...(await extractConflictVersions(mainGit, file)),
      });
    }
    const ticketBase = {
      agent,
      branch: meta.branch,
      sha: agentHead,
      conflictedFiles: conflicted,
      prompt: meta.prompt,
      resolutions,
    };

    // Garde de classification : seuls les conflits textuels fusionnables partent
    // au LLM. Suppression/modification, binaire, lockfile, oversize, submodule →
    // décision humaine directe (le Merger ne sait ni supprimer un fichier, ni
    // fusionner du binaire, ni tenir un lockfile cohérent). Pas d'incrément du
    // streak d'échecs sémantiques : ce n'est pas un échec du LLM.
    const state = await readState(root);
    const unmergeable = resolutions
      .map((res) => ({
        path: res.path,
        ...classifyConflict({
          filePath: res.path,
          base: res.base,
          ours: res.ours,
          theirs: res.theirs,
          modes: res.modes,
          // Fusion par régions : le fichier entier n'est lu que par le diff local,
          // pas par le LLM — sans ce plafond relevé un conflit de plus de 120 000
          // caractères resterait « oversized » avant même d'être tenté.
          maxInputChars: maxMergeInputChars(config),
        }),
      }))
      .filter((c) => c.kind !== 'text');
    if (unmergeable.length > 0) {
      await abortOwnMerge(mergeIntegrity);
      const ticket = await createConflictTicket(root, {
        ...ticketBase,
        reason: 'UNMERGEABLE_CONFLICT',
        unmergeable,
      });
      const detail = unmergeable
        .map((c) => {
          const who =
            c.kind === 'delete'
              ? `: supprimé côté ${c.deletedBy === 'ours' ? 'main' : 'agent'}`
              : '';
          return `${c.path} (${c.kind}${who})`;
        })
        .join(', ');
      await emitEvent(config, {
        type: 'merge:unmergeable',
        agent,
        ticketId: ticket.id,
        message: `⛔ [Striart] Conflit non fusionnable par LLM pour ${agent} : ${detail} — ticket ${ticket.id}, résolution humaine requise.`,
      });
      return {
        status: 'CONFLICT',
        reason: 'UNMERGEABLE_CONFLICT',
        manualMode: state.manualMode,
        agent,
        sha: agentHead,
        conflictedFiles: conflicted,
        unmergeable,
        ticket,
        rebase,
      };
    }

    if (!config.semanticMerge || state.manualMode) {
      await abortOwnMerge(mergeIntegrity);
      const ticket = await createConflictTicket(root, { ...ticketBase, reason: 'MERGE_CONFLICT' });
      await emitEvent(config, {
        type: 'merge:conflict-ticket',
        agent,
        ticketId: ticket.id,
        files: conflicted,
        message: `⛔ [Striart] Conflit sur ${conflicted.join(', ')} (agent ${agent}) — ticket ${ticket.id}, résolution humaine requise.`,
      });
      return {
        status: 'CONFLICT',
        reason: 'MERGE_CONFLICT',
        manualMode: state.manualMode,
        agent,
        sha: agentHead,
        conflictedFiles: conflicted,
        ticket,
        rebase,
      };
    }

    try {
      for (const res of resolutions) {
        await mergeResolutionWithLlm({
          mainGit,
          root,
          config,
          agent,
          taskId: meta.taskId,
          res,
          integrity: mergeIntegrity,
        });
      }
    } catch (error) {
      // Verrou perdu ou état changé : le merge ouvert n'est plus (forcément) le
      // nôtre — ni l'annuler ni le compter comme un échec du LLM.
      if (error?.code === 'LOCK_LOST' || error?.code === 'MERGE_STATE_CHANGED') throw error;
      await abortOwnMerge(mergeIntegrity);
      // Un refus de budget ouvre le même ticket SEMANTIC_MERGE_FAILED mais ne
      // compte pas comme un échec du LLM (voir isBudgetRefusal).
      const state2 = isBudgetRefusal(error) ? state : await recordSemanticFailure(root);
      const ticket = await createConflictTicket(root, {
        ...ticketBase,
        reason: 'SEMANTIC_MERGE_FAILED',
      });
      await emitEvent(config, {
        type: 'merge:semantic-failed',
        agent,
        ticketId: ticket.id,
        files: conflicted,
        message: `⛔ [Striart] Fusion sémantique échouée pour ${agent} (${conflicted.join(', ')}) — ticket ${ticket.id}.`,
      });
      if (state2.manualMode) {
        await emitEvent(config, {
          type: 'merge:manual-mode',
          message: `🔒 [Striart] 3 échecs sémantiques d'affilée : passage en mode manuel jusqu'à "striart resolve --unlock".`,
        });
      }
      return {
        status: 'CONFLICT',
        reason: 'SEMANTIC_MERGE_FAILED',
        error: error.message,
        manualMode: state2.manualMode,
        agent,
        sha: agentHead,
        conflictedFiles: conflicted,
        ticket,
        rebase,
      };
    }
    semantic = { resolutions, resolvedFiles: conflicted };
  } else if (mergeError) {
    await abortMerge(mainGit, root);
    // Collision de création : l'agent a commité un fichier qui existe en
    // untracked dans le repo principal (faux négatif du Router sur un ajout).
    // Ce n'est pas un conflit 3-way — git refuse d'écraser le fichier local.
    if (/untracked working tree files would be overwritten/i.test(mergeError.message)) {
      throw new StriartError(
        `Merge de "${agent}" refusé : des fichiers untracked du repo principal seraient écrasés par le merge. ` +
          'Commit, déplace ou supprime ces fichiers, puis relance le merge.',
        {
          code: 'UNTRACKED_COLLISION',
          hint: 'git status',
          details: { agent, cause: mergeError.message },
        },
      );
    }
    throw new StriartError(`Échec du merge de "${agent}" : ${mergeError.message}`, {
      code: 'MERGE_FAILED',
      hint: 'striart doctor',
      details: { agent, cause: mergeError.message },
    });
  }

  // Dernière écriture de Striart dans l'index : son empreinte doit être
  // intacte au commit (garde d'index de assertMergeIntact).
  mergeIntegrity.expectedIndex = await indexFingerprint(mainGit);
  let gate = await runTestGate({
    cwd: root,
    testCommand: config.testCommand,
    timeoutMs: config.testTimeoutMs,
    ...gateContainerOptions(config),
  });

  // Retry post-gate (fusion sémantique uniquement) : le Merger reçoit le log
  // d'échec des tests et corrige sa propre fusion avant le ticket humain.
  // Un gate rouge sur merge propre = le code de l'AGENT est cassé — pas de
  // retry, le LLM n'y changerait rien.
  let gateRetries = 0;
  // Un retry refusé par un budget laisse le gate rouge, mais n'est pas un échec du LLM.
  let retryBudgetRefused = false;
  if (!gate.success && semantic && config.semanticGateRetries > 0) {
    for (let attempt = 1; attempt <= config.semanticGateRetries && !gate.success; attempt += 1) {
      const feedback = gate.log.slice(-GATE_FEEDBACK_MAX_CHARS);
      try {
        for (const res of semantic.resolutions) {
          await mergeResolutionWithLlm({
            mainGit,
            root,
            config,
            agent,
            taskId: meta.taskId,
            res,
            feedback,
            integrity: mergeIntegrity,
          });
        }
      } catch (error) {
        // LLM en échec pendant le retry : on garde le gate rouge courant,
        // le chemin ticket ci-dessous s'applique.
        // Verrou perdu ou état changé : jamais déguisé en échec du LLM.
        if (error?.code === 'LOCK_LOST' || error?.code === 'MERGE_STATE_CHANGED') throw error;
        retryBudgetRefused = isBudgetRefusal(error);
        logger.warn(
          { err: error, budgetRefusal: retryBudgetRefused },
          `Retry sémantique ${attempt} interrompu (${retryBudgetRefused ? 'refus de budget' : 'LLM en échec'})`,
        );
        break;
      }
      mergeIntegrity.expectedIndex = await indexFingerprint(mainGit);
      gateRetries = attempt;
      gate = await runTestGate({
        cwd: root,
        testCommand: config.testCommand,
        timeoutMs: config.testTimeoutMs,
        ...gateContainerOptions(config),
      });
      logger.info(
        `Retry sémantique ${attempt}/${config.semanticGateRetries} : Test Gate ${gate.success ? 'vert' : 'rouge'}`,
      );
    }
  }

  if (!gate.success) {
    await abortOwnMerge(mergeIntegrity);
    let manualMode = false;
    if (semantic) {
      ({ manualMode } = retryBudgetRefused
        ? await readState(root)
        : await recordSemanticFailure(root));
    }
    const ticket = await createConflictTicket(root, {
      agent,
      branch: meta.branch,
      sha: agentHead,
      reason: semantic ? 'SEMANTIC_GATE_FAILED' : 'GATE_FAILED',
      conflictedFiles: semantic?.resolvedFiles ?? [],
      prompt: meta.prompt,
      log: gate.log,
      gate,
      resolutions: semantic?.resolutions ?? [],
    });
    await emitEvent(config, {
      type: 'merge:gate-red',
      agent,
      ticketId: ticket.id,
      exitCode: gate.exitCode,
      message: `⛔ [Striart] Test Gate rouge pour ${agent} (exit ${gate.exitCode}) — merge annulé, ticket ${ticket.id}.`,
    });
    if (manualMode) {
      await emitEvent(config, {
        type: 'merge:manual-mode',
        message: `🔒 [Striart] 3 échecs sémantiques d'affilée : passage en mode manuel jusqu'à "striart resolve --unlock".`,
      });
    }
    return {
      status: 'GATE_FAILED',
      agent,
      sha: agentHead,
      gate,
      ticket,
      semantic: Boolean(semantic),
      manualMode,
      rebase,
    };
  }

  // Le Test Gate (et les retries LLM) ont pu durer des minutes : avant
  // l'effet irréversible, le merge ouvert doit être toujours le nôtre.
  await assertMergeIntact(mergeIntegrity);
  await commitMergeOrAbort(
    mergeIntegrity,
    formatMergeSubject({
      agent,
      branch: meta.branch,
      agentSha: agentHead,
      semanticFiles: semantic?.resolvedFiles ?? [],
    }),
  );
  if (semantic) await recordSemanticSuccess(root);

  const { mergeSha, pushError, memory } = await finalizeMergeCommit({
    mainGit,
    root,
    config,
    agent,
    taskId: meta.taskId,
    sha: agentHead,
  });

  await updateAgentMeta(root, agent, { lastMergedCommit: agentHead });
  return {
    status: 'MERGED',
    agent,
    sha: agentHead,
    mergeSha,
    gate,
    pushError,
    semantic: Boolean(semantic),
    resolvedFiles: semantic?.resolvedFiles ?? [],
    gateRetries,
    renameHazards,
    memory,
    rebase,
  };
}

/** Tickets pour lesquels --apply a un sens : un ou plusieurs fichiers en
 * conflit, chacun résolu individuellement. GATE_FAILED (sans fusion
 * sémantique) n'en fait pas partie : le merge lui-même n'a produit aucun
 * conflit, c'est l'arbre fusionné dans son ensemble qui casse les tests —
 * rien à appliquer fichier par fichier, la correction se fait côté agent. */
const MANUALLY_APPLICABLE_REASONS = new Set([
  'MERGE_CONFLICT',
  'UNMERGEABLE_CONFLICT',
  'SEMANTIC_MERGE_FAILED',
  'SEMANTIC_GATE_FAILED',
  // Garde I2 : l'humain fixe le contenu final de chaque chemin protégé
  // (`.resolved`/`.delete`) — c'est ce qui rend le changement le sien.
  'PROTECTED_PATHS_CHANGED',
]);

/**
 * Applique la résolution humaine d'un ticket de conflit (règle d'or n°3 :
 * jamais de commit final sans Test Gate vert, ici comme ailleurs).
 *
 * Rejoue EXACTEMENT le merge qui a produit le ticket (`ticket.sha`, pas la
 * tête courante de l'agent qui a pu avancer depuis) : la résolution humaine
 * a été préparée contre cette version précise, préparée via
 * `<ticket.dir>/<fichier>.resolved` (contenu final, binaire supporté) ou
 * `<ticket.dir>/<fichier>.delete` (résolution = suppression) pour chaque
 * fichier de `conflictedFiles` — voir `readResolutionInputs` /
 * `prepareResolutionScaffold` dans conflicts.js.
 *
 * Tourne entièrement sous `withMainLock`, du fetch au commit (Test Gate
 * inclus) : c'est le chemin qui manquait pour qu'une résolution manuelle ne
 * puisse jamais entrer en collision avec un merge automatique concurrent
 * (watch, ou une autre résolution) — la seule alternative avant cette
 * fonction était un `git merge` fait à la main HORS du verrou.
 */
/** @param {{root: string, ticketId: string, signal?: AbortSignal|null}} params @returns {Promise<import('./types.js').ManualResolutionResult>} */
export async function applyTicketResolution(params) {
  return runWithDeferredEffects(() =>
    withMainLock(
      params.root,
      `resolve-apply:${params.ticketId}`,
      () => applyTicketResolutionImpl(params),
      { signal: params.signal ?? null },
    ),
  );
}

/** @returns {Promise<import('./types.js').ManualResolutionResult>} */
async function applyTicketResolutionImpl({ root, ticketId }) {
  await assertInitialized(root);
  const config = await loadConfig(root);
  const ticket = await readTicketDetail(root, ticketId);

  if (ticket.resolved) {
    throw new StriartError(`Ticket "${ticketId}" déjà marqué résolu.`, {
      code: 'TICKET_ALREADY_RESOLVED',
      hint: 'striart resolve --all',
      details: { ticketId },
    });
  }
  if (!MANUALLY_APPLICABLE_REASONS.has(ticket.reason) || ticket.conflictedFiles.length === 0) {
    throw new StriartError(
      `Ticket "${ticketId}" (${ticket.reason}) : --apply ne couvre que les conflits fichier par ` +
        "fichier. Ici le merge n'a produit aucun conflit de ce type — corrige le code de l'agent " +
        'puis relance un merge normal ("striart merge <agent>").',
      {
        code: 'TICKET_NOT_APPLICABLE',
        hint: `striart resolve --close ${ticketId}`,
        details: { ticketId, reason: ticket.reason },
      },
    );
  }

  // Certains kinds d'UNMERGEABLE_CONFLICT ne peuvent pas être résolus par un
  // simple writeFile+add : un symlink écrit ainsi devient un fichier régulier
  // (dégradation silencieuse du mode 120000 → 100644, invisible à l'humain),
  // et un submodule (gitlink 160000) est un répertoire dans le worktree —
  // writeFile y échoue avec EISDIR une fois le merge déjà ouvert. Refusé tôt,
  // avant tout `git merge`, plutôt que découvert au milieu de l'application.
  const UNSUPPORTED_RESOLUTION_KINDS = new Set(['symlink', 'submodule']);
  const unmergeableKindByPath = new Map((ticket.unmergeable ?? []).map((u) => [u.path, u.kind]));
  const unsupported = ticket.conflictedFiles.filter((f) =>
    UNSUPPORTED_RESOLUTION_KINDS.has(unmergeableKindByPath.get(f)),
  );
  if (unsupported.length > 0) {
    throw new StriartError(
      `Ticket "${ticketId}" : ${unsupported.join(', ')} — résolution de type symlink/submodule ` +
        'non supportée par --apply (le mode ne se restaure pas via un simple contenu de fichier). ' +
        'Résous ces fichiers avec git directement dans le repo principal, puis "striart resolve --close ' +
        `${ticketId}".`,
      { code: 'UNSUPPORTED_RESOLUTION_KIND', details: { ticketId, unsupported } },
    );
  }

  const inputs = await readResolutionInputs(root, ticketId);
  const missing = inputs.filter((i) => i.kind === 'missing').map((i) => i.path);
  if (missing.length > 0) {
    const hint = missing.map((f) => path.join(ticket.dir, `${safeFileName(f)}.resolved`));
    throw new StriartError(
      `Résolution incomplète pour "${ticketId}" : ${missing.join(', ')}. Écris le contenu final ` +
        `dans ${hint.join(', ')} (ou un fichier ".delete" à la place pour supprimer), ou lance ` +
        `"striart resolve --prepare ${ticketId}" pour amorcer depuis la version de l'agent.`,
      {
        code: 'RESOLUTION_INCOMPLETE',
        hint: `striart resolve --prepare ${ticketId}`,
        details: { ticketId, missing },
      },
    );
  }

  const registry = await readRegistry(root);
  const meta = registry[ticket.agent];
  if (!meta) {
    throw agentUnknownError(ticket.agent, {
      context: 'clone supprimé depuis la création du ticket ?',
    });
  }
  assertNoLiveSession(ticket.agent, meta, 'Résolution manuelle');

  const mainGit = simpleGit(root);
  await assertMainReady(mainGit, config.targetBranch);

  // Refetch avant de vérifier l'accessibilité : après un merge --abort, les
  // objets fetchés restent en général en place, mais rien ne le garantit
  // (gc). Un fetch réhydrate sans coût si c'est déjà là.
  await fetchBranchToRef(mainGit, meta.path, meta.branch, incomingRef(ticket.agent)).catch(
    (error) => {
      // Pas bloquant : le contrôle d'accessibilité ci-dessous tranche (STALE_TICKET).
      logger.warn(
        { agent: ticket.agent, err: error.message },
        'Refetch du clone avant --apply échoué',
      );
    },
  );
  const shaReachable = await mainGit.raw(['cat-file', '-e', ticket.sha]).then(
    () => true,
    () => false,
  );
  if (!shaReachable) {
    throw new StriartError(
      `Commit "${ticket.sha.slice(0, 8)}" du ticket "${ticketId}" introuvable dans le repo ` +
        `principal — l'historique de "${ticket.agent}" a peut-être été réécrit. Ce ticket est ` +
        'périmé, relance un merge normal pour en régénérer un à jour.',
      { code: 'STALE_TICKET', hint: 'striart resolve', details: { ticketId, sha: ticket.sha } },
    );
  }

  // Garde des chemins protégés (I2), appliquée ici comme à tout merge. Ce qui
  // distingue l'humain de l'agent : le contenu FINAL d'un chemin protégé vient
  // d'un fichier `.resolved`/`.delete` que l'humain a préparé dans le dossier
  // du ticket, pas du commit de l'agent. Tout chemin protégé que le commit
  // changerait SANS résolution humaine préparée est refusé, avant d'ouvrir
  // le moindre merge (ex. ticket MERGE_CONFLICT dont le commit touche aussi
  // AGENTS.md hors conflit : un --apply le ferait passer en silence).
  const isProtectedTicket = ticket.reason === 'PROTECTED_PATHS_CHANGED';
  const alreadyMerged = await isAncestorCommit(mainGit, ticket.sha, 'HEAD');
  if (!alreadyMerged) {
    const protectedPolicy = resolveProtectedPathsPolicy(config);
    logProtectedPathsRelaxation(protectedPolicy, ticket.agent);
    const scan = await findProtectedChanges({
      git: mainGit,
      ours: 'HEAD',
      theirs: ticket.sha,
      policy: protectedPolicy,
    });
    const humanResolved = new Set(inputs.filter((i) => i.kind !== 'missing').map((i) => i.path));
    const unreviewed = scan.changes.filter((c) => !humanResolved.has(c.path)).map((c) => c.path);
    if (unreviewed.length > 0) {
      throw new StriartError(
        `Ticket "${ticketId}" : le commit de "${ticket.agent}" change aussi des chemins protégés ` +
          `(${unreviewed.join(', ')}) sans résolution humaine préparée. Relance "striart merge ` +
          `${ticket.agent}" : le ticket est rafraîchi avec ces chemins, à trancher un par un.`,
        {
          code: 'PROTECTED_PATHS_CHANGED',
          hint: `striart merge ${ticket.agent}`,
          details: { ticketId, agent: ticket.agent, files: unreviewed },
        },
      );
    }
  }

  const headBefore = (await mainGit.revparse(['HEAD'])).trim();
  const mergeIntegrity = {
    root,
    mainGit,
    operation: `resolve-apply:${ticketId}`,
    agent: ticket.agent,
    expectedMergeHead: ticket.sha,
    expectedHead: headBefore,
    /** Empreinte de l'index après la dernière écriture de Striart (null : pas encore relevée). */
    expectedIndex: /** @type {string | null} */ (null),
  };
  let mergeError = null;
  try {
    await mainGit.raw(['merge', ticket.sha, '--no-commit', '--no-ff']);
  } catch (error) {
    mergeError = error;
  }
  const status = await mainGit.status();
  // Un ticket de chemins protégés se rejoue normalement SANS conflit : seul
  // « déjà mergé » le rend sans objet.
  if (alreadyMerged || (!isProtectedTicket && status.conflicted.length === 0 && !mergeError)) {
    // Déjà mergé, ou le conflit ne se reproduit plus : rien à appliquer, et
    // le ticket (et ses doublons éventuels) n'a plus de raison de rester ouvert.
    await abortMerge(mainGit, root);
    await closeConflictTicket(root, ticketId);
    const staleDuplicates = (await listConflictTickets(root)).filter(
      (t) =>
        t.id !== ticketId &&
        t.agent === ticket.agent &&
        t.conflictedFiles.some((f) => ticket.conflictedFiles.includes(f)),
    );
    for (const dup of staleDuplicates) await closeConflictTicket(root, dup.id);
    return { status: 'ALREADY_CLEAN', ticketId, agent: ticket.agent, sha: ticket.sha };
  }

  const ticketFiles = new Set(ticket.conflictedFiles);
  const expectedConflicted = isProtectedTicket
    ? new Set(ticket.mergeConflictedFiles ?? [])
    : ticketFiles;
  const actualConflicted = new Set(status.conflicted);
  const sameSet =
    actualConflicted.size === expectedConflicted.size &&
    [...actualConflicted].every((f) => expectedConflicted.has(f));
  if (!sameSet) {
    await abortMerge(mainGit, root);
    throw new StriartError(
      `Le conflit a changé depuis la création du ticket "${ticketId}" (le repo principal a bougé ` +
        `entre-temps) : attendu {${[...expectedConflicted].join(', ')}}, obtenu ` +
        `{${[...actualConflicted].join(', ')}}. Ce ticket est périmé — relance un merge normal ` +
        'pour en régénérer un à jour.',
      {
        code: 'STALE_TICKET',
        hint: 'striart resolve',
        details: { ticketId, expected: [...expectedConflicted], actual: [...actualConflicted] },
      },
    );
  }
  // Merge réellement ouvert sur le SHA du ticket : un échec sans conflit
  // (fichiers untracked écrasés…) n'ouvre rien, et écrire les résolutions
  // puis committer produirait un commit ordinaire, sans le travail de l'agent.
  if ((await readMergeHead(mainGit)) !== ticket.sha) {
    await abortMerge(mainGit, root);
    throw new StriartError(
      `Le merge du ticket "${ticketId}" n'a pas pu être rejoué : ${mergeError?.message ?? 'aucun merge ouvert'}.`,
      {
        code: 'MERGE_FAILED',
        hint: 'git status',
        details: { agent: ticket.agent, ticketId, cause: mergeError?.message ?? null },
      },
    );
  }

  // Le merge est déjà ouvert (MERGE_HEAD posé) à ce stade : toute exception
  // dans cette boucle (permission refusée, disque plein, chemin invalide)
  // doit annuler le merge avant de remonter — sinon le repo principal reste
  // bloqué en état "merging" jusqu'à intervention manuelle, exactement
  // l'incident que cette fonction devait éliminer.
  try {
    const stageModes = parseStageModes(await mainGit.raw(['ls-files', '-u', '-z']));
    for (const input of inputs) {
      // Défense en profondeur : readResolutionInputs a déjà refusé les chemins hors
      // dépôt / dans .git ; le chemin écrit reste confiné à la racine.
      assertTicketPathSafe(ticketId, input.path, root);
      if (input.kind === 'delete') {
        // --literal-pathspecs : `[id].tsx` est un nom, jamais un motif — sans lui
        // `git rm` emportait aussi `i.tsx` et `d.tsx`.
        await mainGit.raw([
          '--literal-pathspecs',
          'rm',
          '-f',
          '--ignore-unmatch',
          '--',
          input.path,
        ]);
        continue;
      }
      if (input.kind === 'missing') continue; // impossible ici (garde plus haut) — pour le typage
      // Le dossier parent peut manquer (chemin protégé que l'agent supprimait
      // avec son dossier, et que l'humain conserve).
      await mkdir(path.dirname(path.join(root, input.path)), { recursive: true });
      await writeFile(path.join(root, input.path), input.content);
      await mainGit.raw(['--literal-pathspecs', 'add', '--', input.path]);
      const modes = stageModes[input.path] ?? {};
      // writeFile ne préserve pas le bit exécutable (et il n'existe pas sur
      // NTFS) : reposé dans l'index si l'un des deux côtés l'avait.
      if (isExecutableMode(modes.ours) || isExecutableMode(modes.theirs)) {
        await mainGit.raw(['update-index', '--chmod=+x', '--', input.path]);
      }
    }
  } catch (error) {
    await abortMerge(mainGit, root);
    throw error;
  }

  const stillConflicted = (await mainGit.status()).conflicted;
  if (stillConflicted.length > 0) {
    await abortMerge(mainGit, root);
    throw new StriartError(
      `Fichier(s) encore en conflit après application : ${stillConflicted.join(', ')}.`,
      {
        code: 'RESOLUTION_INCOMPLETE',
        hint: `striart resolve --prepare ${ticketId}`,
        details: { ticketId, stillConflicted },
      },
    );
  }

  mergeIntegrity.expectedIndex = await indexFingerprint(mainGit);
  const gate = await runTestGate({
    cwd: root,
    testCommand: config.testCommand,
    timeoutMs: config.testTimeoutMs,
    ...gateContainerOptions(config),
  });
  if (!gate.success) {
    await abortOwnMerge(mergeIntegrity);
    // Pas un échec du LLM : le compteur de fusion sémantique n'est pas touché,
    // une résolution manuelle ratée ne doit pas pousser vers le mode manuel.
    return { status: 'GATE_FAILED', ticketId, agent: ticket.agent, sha: ticket.sha, gate };
  }

  await assertMergeIntact(mergeIntegrity);
  await commitMergeOrAbort(
    mergeIntegrity,
    formatMergeSubject({
      agent: ticket.agent,
      branch: ticket.branch,
      agentSha: ticket.sha,
      ticketId,
    }),
  );
  await recordSemanticSuccess(root);

  const { mergeSha, pushError, memory } = await finalizeMergeCommit({
    mainGit,
    root,
    config,
    agent: ticket.agent,
    // L'agent peut avoir disparu du registre depuis le ticket : alors sans tâche.
    taskId: (await readRegistry(root))[ticket.agent]?.taskId ?? null,
    sha: ticket.sha,
  });

  await updateAgentMeta(root, ticket.agent, { lastMergedCommit: ticket.sha });

  await closeConflictTicket(root, ticketId);
  // Referme aussi les autres tickets ouverts du même agent portant sur (au
  // moins un) des mêmes fichiers : des tentatives successives du même
  // conflit (l'agent a recommité avant que le précédent soit traité), pas
  // des conflits distincts.
  const otherOpenTickets = (await listConflictTickets(root)).filter(
    (t) =>
      t.id !== ticketId &&
      t.agent === ticket.agent &&
      t.conflictedFiles.some((f) => ticketFiles.has(f)),
  );
  for (const other of otherOpenTickets) await closeConflictTicket(root, other.id);

  await emitEvent(config, {
    type: 'merge:manual-resolution',
    agent: ticket.agent,
    ticketId,
    files: ticket.conflictedFiles,
    message:
      `✅ [Striart] Résolution manuelle appliquée pour ${ticket.agent} (ticket ${ticketId}) — ` +
      `${ticket.conflictedFiles.join(', ')}.`,
  });

  return {
    status: 'MERGED',
    ticketId,
    agent: ticket.agent,
    sha: ticket.sha,
    mergeSha,
    gate,
    pushError,
    memory,
    resolvedFiles: ticket.conflictedFiles,
    closedTickets: [ticketId, ...otherOpenTickets.map((t) => t.id)],
  };
}

/**
 * Supprime les refs privées `refs/striart/incoming/<agent>` (voir sync.js)
 * des agents absents de `keep`. Hygiène : jamais bloquante, un échec est
 * journalisé (une ref restante ne coûte que de l'espace disque).
 * @param {string} root
 * @param {Set<string>} keep
 */
async function pruneIncomingRefs(root, keep) {
  const git = simpleGit(root);
  try {
    const prefix = incomingRef('');
    const refs = (await git.raw(['for-each-ref', '--format=%(refname)', prefix]))
      .split('\n')
      .map((ref) => ref.trim())
      .filter(Boolean);
    for (const ref of refs) {
      if (keep.has(ref.slice(prefix.length))) continue;
      await git.raw(['update-ref', '-d', ref]);
    }
  } catch (error) {
    logger.warn({ err: error.message }, 'Nettoyage des refs privées des agents retirés échoué');
  }
}

/**
 * Refuse toute opération sur un clone dont la session autonome VIT encore
 * (décision architecturale n°6.4 : « un clone dont la session vit est
 * intouchable »). C'est un fait vérifié, pas une heuristique : comme dans
 * cleanClones, `force` ne passe pas outre. Un PID mort ne bloque rien (le
 * contrôle de vitalité neutralise les crashs), et le cycle autonome dépublie
 * son PID avant son merge de fin — il n'est donc jamais gêné par ce garde.
 */
function assertNoLiveSession(agent, meta, operation) {
  if (!isProcessAlive(meta.sessionPid)) return;
  throw new StriartError(
    `${operation} refusé : la session autonome de "${agent}" est encore en cours (PID ${meta.sessionPid}). ` +
      'Attends sa fin de cycle (elle merge et nettoie elle-même), ou termine le process avant de réessayer.',
    { code: 'SESSION_LIVE', hint: 'striart status', details: { agent, pid: meta.sessionPid } },
  );
}

/**
 * Marque un agent comme terminé : retrait du registre (le clone reste
 * sur disque, règle d'or n°3) puis déblocage de la file d'attente.
 * Refuse si des commits ne sont pas mergés, sauf --force — et refuse SANS
 * dérogation possible tant que la session autonome du clone est vivante :
 * toutes les protections en aval (SESSION_LIVE de cleanClones, abstention de
 * rebase) reposent sur l'entrée au registre ; la retirer sous une session
 * vivante les désarmerait toutes et ferait échouer son merge de fin de cycle.
 */
/** @param {{root: string, agent: string, force?: boolean, signal?: AbortSignal|null}} params */
export async function stopAgent(params) {
  // `signal` n'annule que l'ATTENTE du verrou, jamais un arrêt commencé.
  const result = await runWithDeferredEffects(() =>
    withMainLock(params.root, `stop:${params.agent}`, () => stopAgentImpl(params), {
      signal: params.signal ?? null,
    }),
  );
  // HORS verrou : l'hôte de pty peut mettre quelques secondes à sortir, et
  // le verrou gèle tout l'orchestrateur. Son PID file reste en place tant
  // qu'il vit — la garde SESSION_LIVE de cleanClones tient pendant ce temps.
  // Best-effort : un hôte absent (jamais ouvert via --open) ou déjà mort ne
  // fait jamais échouer un stop par ailleurs valide ; un hôte laissé vivant
  // est remonté dans le résultat, pas tu.
  const ptyHost = await stopPtyHost(params.root, params.agent).catch((error) => {
    logger.warn({ agent: params.agent, err: error.message }, "Arrêt de l'hôte de pty en échec");
    return { stopped: false, wasStale: false, stopping: false, untouched: 'error' };
  });
  // Artefacts périphériques (hôte ACP persistant, Tab Configs Warp) : rapportés,
  // jamais bloquants ni avalés.
  const artifacts = await releaseAgentArtifacts({ root: params.root, agent: params.agent });
  return { ...result, ptyHost, artifacts };
}

async function stopAgentImpl({ root, agent, force = false }) {
  await assertInitialized(root);
  const registry = await readRegistry(root);
  const meta = registry[agent];
  if (!meta) {
    throw agentUnknownError(agent);
  }

  assertNoLiveSession(agent, meta, 'Stop');

  // Clone disparu du disque (statut MISSING) : il n'y a plus aucun travail à
  // perdre — le retirer du registre est la seule issue, sans --force. Avant,
  // simple-git levait sur le dossier absent et l'agent restait inscrit pour
  // toujours (collisions du Router, file bloquée).
  // Seul ENOENT prouve l'absence. Toute autre erreur (EACCES, EPERM, E/S) :
  // présumé présent, la lecture git qui suit échouera et refusera (fail closed).
  const cloneExists = await stat(meta.path).then(
    () => true,
    (error) => error.code !== 'ENOENT',
  );
  if (cloneExists) {
    let agentHead;
    try {
      agentHead = (await cloneGit(meta.path).revparse(['HEAD'])).trim();
    } catch (error) {
      // Clone présent mais illisible (BROKEN) : le travail en attente est
      // inconnu, donc présumé existant — fail closed.
      if (!force) {
        throw new StriartError(
          `Le clone de "${agent}" est illisible par git (${error.message}) : impossible de vérifier qu'aucun travail ne serait perdu.`,
          {
            code: 'AGENT_HAS_PENDING',
            details: { agent, head: null, clonePath: meta.path },
            hint: `striart stop ${agent} --force`,
          },
        );
      }
    }
    const lastMerged = meta.lastMergedCommit ?? meta.baseCommit;
    if (agentHead !== undefined && agentHead !== lastMerged && !force) {
      throw new StriartError(
        `L'agent "${agent}" a des commits non mergés (${agentHead.slice(0, 8)}). Merge d'abord, ou --force pour abandonner ce travail.`,
        {
          code: 'AGENT_HAS_PENDING',
          details: { agent, head: agentHead, lastMerged },
          hint: `striart merge ${agent}`,
        },
      );
    }
  }

  await removeAgentFromRegistry(root, agent);
  await pruneIncomingRefs(root, new Set(Object.keys(await readRegistry(root))));
  // L'agent est retiré : l'arrêt est FAIT. Un dégagement de file en échec ne le
  // défait pas (et ne court-circuite pas l'arrêt de l'hôte de pty qui suit) : il
  // est RAPPORTÉ, la file reste en l'état pour `striart queue --retry`.
  /** @type {Awaited<ReturnType<typeof retryQueueImpl>>['started']} */
  let started;
  /** @type {Awaited<ReturnType<typeof retryQueueImpl>>['stillWaiting']} */
  let stillWaiting;
  /** @type {{code: string, message: string} | null} */
  let queueError = null;
  try {
    ({ started, stillWaiting } = await retryQueueImpl({ root }));
  } catch (error) {
    started = [];
    queueError = {
      code: error instanceof StriartError ? error.code : 'UNEXPECTED_ERROR',
      message: error instanceof Error ? error.message : String(error),
    };
    logger.error({ agent, err: error }, 'Dégagement de la file après arrêt en échec (rapporté)');
    stillWaiting = await readQueue(root).catch(() => []);
  }
  return {
    agent,
    clonePath: meta.path,
    cloneMissing: !cloneExists,
    started,
    stillWaiting,
    queueError,
  };
}

/**
 * Consentement « secrets historiques » d'une tâche en file. Les files
 * écrites par les builds de développement postérieurs à v0.10.0 (jamais
 * publiés) le stockaient sous `force`, qui y valait aussi consentement à
 * perdre du travail : relu UNIQUEMENT comme consentement aux secrets, jamais
 * comme consentement à perdre du travail, qui n'est plus persisté.
 * @param {import('./types.js').QueueTask} task
 */
function taskAllowsHistoricalSecrets(task) {
  return Boolean(task.allowHistoricalSecrets ?? task.force ?? false);
}

/**
 * Re-tente les tâches en attente dont les collisions ont disparu
 * (agent bloquant mergé puis retiré du registre).
 * Appelé par striart queue --retry et automatiquement par stopAgent.
 */
export async function retryQueue(params) {
  return runWithDeferredEffects(() =>
    withMainLock(params.root, 'queue-retry', () => retryQueueImpl(params), {
      signal: params.signal ?? null,
    }),
  );
}

/**
 * Erreur qui n'est pas propre à une tâche : verrous, fichiers d'état, session
 * principale déclarée, dépôt non initialisé. Elle avorte la passe de la file.
 * @param {unknown} error
 */
function isInfrastructureError(error) {
  if (!(error instanceof StriartError)) return false;
  return (
    error.code.startsWith('LOCK_') ||
    error.code.startsWith('STATE_') ||
    error.code === 'MAIN_SESSION_LIVE' ||
    error.code === 'NOT_INITIALIZED' ||
    error.code === 'REGISTRY_CORRUPT' ||
    error.code === 'QUEUE_CORRUPT'
  );
}

async function retryQueueImpl({ root }) {
  await assertInitialized(root);
  const config = await loadConfig(root);
  const started = [];
  const stillWaiting = [];

  for (const task of await readQueue(root)) {
    const registry = await readRegistry(root);
    const collisions = detectCollisions(task.predictedFiles, activeAgents(registry));
    // Une dépendance `after` encore active ajourne la tâche, collision ou
    // pas. La file est relue à chaque itération : une tâche démarrée dans ce
    // même passage (devenue agent au registre) bloque toujours ses suivantes.
    const afterActive = task.after && isWorkActive(registry, await readQueue(root), task.after);
    if (collisions.length > 0 || registry[task.agent] || afterActive) {
      stillWaiting.push({ ...task, collisions });
      continue;
    }
    let info;
    try {
      info = task.reuse
        ? await reuseAgent({
            root,
            name: task.agent,
            prompt: task.prompt,
            predictedFiles: task.predictedFiles,
            command: task.command ?? null,
            secretPatterns: config.secretPatterns,
            allowHistoricalSecrets: taskAllowsHistoricalSecrets(task),
          })
        : await createAgent({
            root,
            name: task.agent,
            prompt: task.prompt,
            predictedFiles: task.predictedFiles,
            command: task.command ?? null,
            cloneFilter: config.cloneFilter,
            secretPatterns: config.secretPatterns,
            allowHistoricalSecrets: taskAllowsHistoricalSecrets(task),
          });
    } catch (error) {
      // Une archive devenue inutilisable entre la mise en file et le
      // dégagement (travail non commité apparu, activité disque, clone
      // nettoyé) ne doit pas faire échouer TOUT le passage de la file : la
      // tâche reste en attente avec le motif, les suivantes sont examinées.
      // HISTORICAL_SECRETS_FOUND rejoint ce même traitement : un secret entré
      // dans l'historique du repo PENDANT que la tâche attendait (sans
      // consentement posé à l'enfilage) ne doit geler que cette tâche précise, pas
      // tout le dégagement de la file.
      //
      // Plus généralement, toute erreur PROPRE à cette tâche (nom d'agent invalide
      // écrit à la main, suppression de clone en cours, clone incomplet, secrets
      // non exclus…) la maintient en file avec son motif : une tâche empoisonnée
      // ne doit jamais geler le dégagement des suivantes. Seules les erreurs
      // d'INFRASTRUCTURE (verrous, fichiers d'état, dépôt non initialisé) avortent
      // la passe : elles frapperaient toutes les tâches.
      if (isInfrastructureError(error)) throw error;
      logger.warn({ err: error, task: task.id }, 'Démarrage impossible, tâche maintenue en file');
      stillWaiting.push({
        ...task,
        collisions,
        blockedReason: error instanceof StriartError ? error.code : 'UNEXPECTED_ERROR',
      });
      continue;
    }
    await removeTask(root, task.id);
    await emitEvent(config, {
      type: 'task:started',
      agent: task.agent,
      taskId: task.id,
      branch: info.branch,
      message: `🚀 [Striart] Tâche ${task.id} débloquée : agent ${task.agent} lancé (${info.branch}).`,
    });
    started.push({ task, info });
  }

  // La file et/ou le registre viennent potentiellement de changer (tâches
  // démarrées, appel depuis stopAgent après retrait) : la vue temps réel des
  // clones doit suivre. Idempotent — un passage sans changement n'écrit rien.
  await refreshLiveMemory(root, config);

  return { started, stillWaiting };
}

/**
 * Passe de RÉCONCILIATION — level-triggered, idempotente, sous verrou.
 *
 * Pattern k8s appliqué aux invariants INTERNES de Striart (jamais à un état
 * désiré global : le Test Gate et l'humain restent des transitions
 * délibérées, pas une dérive à corriger). Elle observe l'état RÉEL et le
 * fait converger, quel que soit l'événement qui l'a fait dériver :
 *
 *  1. **PID de session morts neutralisés au registre.** Un crash de la
 *     session autonome laisse `sessionPid` renseigné. Le contrôle de
 *     vitalité empêche déjà tout gel (sync/clean traitent un PID mort comme
 *     absent), mais le registre et le dashboard montreraient une session
 *     fantôme : on remet `sessionPid` à null.
 *  2. **File convergée.** `retryQueue` n'était rejoué que sur `stopAgent` ou
 *     sur `queue --retry` manuel : une tâche débloquée par un AUTRE chemin
 *     (un `striart clean` du bloqueur, un agent autonome dont le clone a été
 *     retiré) restait en file jusqu'à une action manuelle. La rejouer ici
 *     rend le déblocage level-triggered : n'importe quel changement d'état
 *     converge au prochain passage, sans dépendre de l'événement précis.
 *
 * Composée sur des primitives existantes (règle n°0). Idempotente : deux
 * passes de suite sur un état stable ne changent rien. Le verrou principal,
 * pris ici, exécute AU PASSAGE ses propres réparations (verrou orphelin
 * cassé, `MERGE_HEAD` abandonné annulé) — la réconciliation en hérite
 * gratuitement.
 *
 * @param {{root: string, signal?: AbortSignal|null}} params
 * Passe aussi (lot L2 fichiers d'état) : suppressions de clone inachevées
 * reprises (`removalsCompleted`/`removalsPending`, voir removeClone) et
 * temporaires d'écriture orphelins balayés (`tempFilesSwept`).
 *
 * @returns {Promise<{sessionPidsCleared: string[], started: Array<{task: import('./types.js').QueueTask, info: import('./types.js').AgentMeta}>, stillWaiting: import('./types.js').QueueTask[], permissionsPruned: number, removalsCompleted: string[], removalsPending: Array<{name: string, reason: 'SESSION_LIVE'|'BUSY'|'ACTIVE'}>, tempFilesSwept: number}>}
 */
export async function reconcile(params) {
  return runWithDeferredEffects(() =>
    withMainLock(params.root, 'reconcile', () => reconcileImpl(params), {
      signal: params.signal ?? null,
    }),
  );
}

async function reconcileImpl({ root }) {
  await assertInitialized(root);

  // 1. Neutraliser les PID de session morts (hygiène du registre). Effacement
  //    CONDITIONNEL : le process d'une session autonome publie son PID hors
  //    du verrou principal ; entre la lecture ci-dessous et l'écriture, une
  //    nouvelle session a pu publier le sien — il n'est jamais effacé.
  const registry = await readRegistry(root);
  const sessionPidsCleared = [];
  for (const [agent, meta] of Object.entries(registry)) {
    if (meta.sessionPid != null && !isProcessAlive(meta.sessionPid)) {
      const { applied } = await compareAndUpdateAgentMeta(
        root,
        agent,
        { sessionPid: meta.sessionPid },
        { sessionPid: null },
      );
      if (applied) sessionPidsCleared.push(agent);
    }
  }

  // 1bis. Suppressions de clone entamées et inachevées (rm interrompu,
  //       handle Windows tenu) : terminées, gardes de session comprises.
  const removals = await resumeCloneRemovals(root);

  // 2. Convergence de la file. Réentrant : retryQueue reprend le verrou déjà
  //    tenu, sans doubler la logique (une seule source de vérité du déblocage).
  const { started, stillWaiting } = await retryQueueImpl({ root });

  // 3. Hygiène des permissions semi-autonomes : une demande expirée dont la
  //    session est morte sans nettoyer (crash) resterait un bouton mort au
  //    dashboard. Best effort — l'hygiène ne fait jamais échouer la passe.
  const permissionsPruned = await prunePermissions(root).catch((error) => {
    logger.warn({ err: error }, 'Hygiène des permissions impossible (ignorée)');
    return 0;
  });

  // 4. Refs privées `refs/striart/incoming/<agent>` d'agents retirés par un
  //    autre chemin que stop (clean, reuse) : elles retiendraient des objets.
  await pruneIncomingRefs(root, new Set(Object.keys(await readRegistry(root))));

  // 5. Temporaires d'écriture orphelins (crash entre écriture et renommage).
  //    Jamais dans les clones : ce sont des worktrees, un `.tmp` y est à l'agent.
  const tempFilesSwept = (await sweepOrphanTempFiles(striartDir(root), { skip: ['agents'] }))
    .length;

  if (
    sessionPidsCleared.length > 0 ||
    started.length > 0 ||
    permissionsPruned > 0 ||
    removals.completed.length > 0 ||
    tempFilesSwept > 0
  ) {
    logger.info(
      {
        sessionPidsCleared,
        started: started.map((s) => s.task.agent),
        permissionsPruned,
        removalsCompleted: removals.completed,
        tempFilesSwept,
      },
      'Réconciliation : état convergé',
    );
  }
  if (removals.pending.length > 0) {
    logger.warn(
      { removalsPending: removals.pending },
      'Réconciliation : suppression(s) de clone toujours inachevée(s)',
    );
  }
  return {
    sessionPidsCleared,
    started,
    stillWaiting,
    permissionsPruned,
    removalsCompleted: removals.completed,
    removalsPending: removals.pending,
    tempFilesSwept,
  };
}

/**
 * Applique un plan « tâches-as-code » (voir src/plan.js).
 *
 * Équivaut EXACTEMENT à la séquence de `striart run` que le plan décrit, les
 * `id` de plan résolus en noms d'agents pour `--after`. Aucune sémantique
 * nouvelle : chaque tâche passe par `runTask`/`runAutonomousTask`, qui
 * prennent le verrou chacune de leur côté — ce n'est PAS une transaction, une
 * tâche autonome bloque le temps de sa session, exactement comme sa commande
 * `run` équivalente. La validation complète (parsePlan) tombe avant toute
 * application ; `dryRun` s'arrête là et retourne le plan résolu sans rien
 * lancer (la revue-avant-exécution).
 *
 * `signal` : arrêt demandé (Ctrl+C). Transmis à la session autonome en
 * cours, qui s'arrête comme `run --autonomous` (arbre de l'agent tué, PID
 * dépublié, clone conservé) ; aucune tâche suivante ne démarre. Les tâches
 * non appliquées sont rendues dans `notApplied` — rien n'est perdu en
 * silence.
 *
 * Plan `version: 2` (lot O) : modes d'orchestration explicites, délégués à
 * src/orchestration/scheduler.ts (`onProgress` : progression au fil de
 * l'eau ; `overrides` : mode, concurrence et politique d'échec imposés par
 * la ligne de commande). Le v1 ci-dessous garde exactement sa sémantique.
 *
 * @param {{root: string, planText: string, dryRun?: boolean, signal?: AbortSignal|null, onProgress?: ((event: import('./orchestration/unit.ts').ProgressEvent) => void)|null, overrides?: import('./orchestration/scheduler.ts').PlanOverrides}} params
 * @returns {Promise<{dryRun: boolean, version?: 1|2, tasks: Array<{id: string|null, agent: string|null, mode: 'attended'|'autonomous', after: string|null, kind?: import('./types.js').PlanNodeKind}>, results?: Array<{id: string|null, agent: string|null, mode: 'attended'|'autonomous', status: string, keptDetail?: string|null, warnings?: import('./types.js').AutonomousWarningCode[], errorCode?: string|null, kind?: import('./types.js').PlanNodeKind, info?: (import('./types.js').AgentMeta & {name: string}) | null}>, nodes?: import('./types.js').OrchestrationNodeResult[], run?: {id: string, mode: import('./types.js').OrchestrationMode, concurrency: number, onFailure: import('./types.js').PlanFailurePolicy}, interrupted?: boolean, notApplied?: Array<{id: string|null, agent: string|null}>}>}
 */
export async function applyPlan({
  root,
  planText,
  dryRun = false,
  signal = null,
  onProgress = null,
  overrides = {},
}) {
  await assertInitialized(root);
  const plan = parsePlan(planText); // lève PLAN_INVALID avant tout effet de bord
  const config = await loadConfig(root);
  if (plan.version === 2) {
    validatePlanAgainstConfig(plan, config); // profils et plafonds, --dry-run compris
    if (dryRun) return { dryRun: true, version: 2, tasks: describePlanV2(plan) };
    const v2 = await runPlanV2({ root, plan, config, signal, onProgress, overrides });
    return {
      dryRun: false,
      version: 2,
      tasks: [],
      run: v2.run,
      nodes: v2.nodes,
      results: v2.nodes.map((n) => ({
        id: n.id,
        agent: n.agent,
        mode: n.mode,
        kind: n.kind,
        status: n.status,
        info: n.info ?? null,
      })),
      interrupted: v2.interrupted,
      notApplied: v2.notApplied,
    };
  }
  // Les surcharges de mode n'ont pas de sens en v1 (file + --after) : les
  // ignorer laisserait croire à un enchaînement qui ne sera pas appliqué.
  if (overrides.mode || overrides.concurrency || overrides.onFailure) {
    throw new StriartError(
      'Plan invalide : --mode, --concurrency et --on-failure exigent un plan "version: 2".',
      {
        code: 'PLAN_INVALID',
        hint: 'striart plan <fichier> --dry-run',
        details: { reason: 'OVERRIDES_NEED_V2' },
      },
    );
  }

  // Valide AVANT tout effet de bord que chaque tâche autonome référence un
  // profil qui existe. C'est l'erreur la plus probable d'un plan multi-IA
  // (nom d'IA mal orthographié ou non configuré) : elle doit tomber à la
  // revue (`--dry-run`) et avant d'avoir lancé la moindre tâche, pas au
  // milieu de l'application. Réutilise resolveAgentProfile (règle n°0).
  for (const task of plan.tasks) {
    if (task.autonomous) resolveAgentProfile(config, task.profile ?? DEFAULT_PROFILE);
  }

  // Résout un `after` : un id de plan déjà appliqué → son nom d'agent réel ;
  // sinon on laisse la chaîne telle quelle (référence d'exécution que runTask
  // validera). Rempli au fil de l'application.
  const idToAgent = new Map();
  const resolveAfter = (after) => (after ? (idToAgent.get(after) ?? after) : null);

  if (dryRun) {
    return {
      dryRun: true,
      tasks: plan.tasks.map((t) => ({
        id: t.id,
        agent: t.agent,
        mode: t.autonomous ? 'autonomous' : 'attended',
        after: t.after,
      })),
    };
  }

  const results = [];
  const notApplied = [];
  for (const task of plan.tasks) {
    if (signal?.aborted) {
      notApplied.push({ id: task.id, agent: task.agent });
      continue;
    }
    const after = resolveAfter(task.after);
    if (task.autonomous) {
      const r = await runAutonomousTask({
        root,
        agent: task.agent,
        prompt: task.prompt,
        profile: task.profile,
        timeoutMs: task.timeout,
        after,
        signal,
      });
      const agentName = r.agent ?? task.agent;
      if (task.id) idToAgent.set(task.id, agentName);
      results.push({
        id: task.id,
        agent: agentName,
        mode: 'autonomous',
        status: r.status,
        keptDetail: r.keptDetail,
        // Avertissements du cycle (ALREADY_INTEGRATED…) et cause nommée d'un échec de
        // session : sans eux un plan v1 taisait le succès « bruyant » et la nature du refus.
        warnings: r.warnings ?? [],
        errorCode: r.session?.errorCode ?? null,
      });
    } else {
      const r = await runTask({
        root,
        agent: task.agent,
        prompt: task.prompt,
        command: task.command,
        after,
      });
      const agentName = r.status === 'STARTED' ? r.info.name : r.task.agent;
      if (task.id) idToAgent.set(task.id, agentName);
      results.push({
        id: task.id,
        agent: agentName,
        mode: 'attended',
        status: r.status,
        info: r.status === 'STARTED' ? r.info : null,
      });
    }
  }
  return {
    dryRun: false,
    tasks: [],
    results,
    interrupted: signal?.aborted ?? false,
    notApplied,
  };
}

/**
 * Défait le DERNIER merge Striart de la branche cible.
 *
 * Sécurités :
 *  - HEAD doit être un commit `merge(striart): ...` — on ne défait jamais un
 *    commit humain, ni un merge enfoui sous d'autres commits (résolution
 *    manuelle dans ce cas : l'historique intermédiaire serait perdu) ;
 *  - merge non poussé → `reset --hard HEAD^` (récupérable via reflog) ;
 *    merge présent sur origin → `revert -m 1` (l'histoire publiée est
 *    immuable, on ne réécrit jamais ce que d'autres ont pu fetch) ;
 *  - si l'agent mergé est encore actif : en mode reset, son pointeur
 *    lastMergedCommit est recalé sur l'ancêtre commun réel (ses commits
 *    redeviennent "en attente" et pourront être re-mergés) ; en mode revert,
 *    il est conservé (le code est annulé dans main, mais re-merger le même
 *    commit reproduirait l'état annulé — décision humaine).
 *
 * @param {{root: string, signal?: AbortSignal|null}} params
 * @returns {Promise<import('./types.js').RollbackResult>}
 */
export async function rollbackLastMerge(params) {
  return runWithDeferredEffects(() =>
    withMainLock(params.root, 'rollback', () => rollbackLastMergeImpl(params), {
      signal: params.signal ?? null,
    }),
  );
}

/**
 * HEAD est-il déjà publié sur `origin/<branche>` ? Décidé sur la référence
 * FRAÎCHE (fetch) : `origin/<branche>` locale peut dater d'avant une publication
 * faite par un autre chemin. Sans certitude (remote injoignable, erreur de
 * fetch), on répond « oui » : le choix sûr est `revert`, jamais de réécriture d'un
 * historique peut-être publié. Aucun remote `origin` : rien n'a pu être publié.
 * @param {import('simple-git').SimpleGit} git @param {string} branch
 */
async function isPublishedOnOrigin(git, branch) {
  const remotes = (await git.raw(['remote'])).split(/\s+/).filter(Boolean);
  if (!remotes.includes('origin')) return false;
  try {
    await git.raw([
      'fetch',
      '--quiet',
      '--no-tags',
      '--no-write-fetch-head',
      'origin',
      `+refs/heads/${branch}:refs/remotes/origin/${branch}`,
    ]);
  } catch (error) {
    const message = String(/** @type {Error} */ (error)?.message ?? error);
    // La branche n'existe pas sur le remote : jamais publiée, certitude acquise.
    if (/couldn't find remote ref/i.test(message)) return false;
    logger.warn(
      { err: message },
      'Remote origin injoignable : publication de HEAD invérifiable, rollback par revert',
    );
    return true;
  }
  try {
    return await isAncestorCommit(git, 'HEAD', `origin/${branch}`);
  } catch {
    return false;
  }
}

/** @returns {Promise<import('./types.js').RollbackResult>} */
async function rollbackLastMergeImpl({ root }) {
  await assertInitialized(root);
  const config = await loadConfig(root);
  const mainGit = simpleGit(root);
  await assertMainReady(mainGit, config.targetBranch);

  const head = (await mainGit.revparse(['HEAD'])).trim();
  const message = (await mainGit.raw(['log', '-1', '--format=%s', 'HEAD'])).trim();
  // Le sujet est FORGEABLE (un commit d'agent peut le porter) : seul un commit de
  // merge — au moins deux parents — est un merge Striart. Sans cela, `reset --hard`
  // défaisait un commit ordinaire au sujet imité.
  const parentCount =
    (await mainGit.raw(['rev-list', '--parents', '-n', '1', 'HEAD'])).trim().split(/\s+/).length -
    1;
  const parsed = parentCount >= 2 ? parseMergeSubject(message) : null;
  if (!parsed) {
    throw new StriartError(
      `Le dernier commit de ${config.targetBranch} n'est pas un merge Striart ("${message.slice(0, 60)}"). ` +
        'striart rollback ne défait que le merge en tête de branche — au-delà, résolution manuelle (git revert).',
      { code: 'NOT_A_STRIART_MERGE', hint: 'striart history', details: { head, message } },
    );
  }
  const { agent } = parsed;

  // Poussé sur origin ? → revert (jamais de réécriture d'historique publié).
  const pushed = await isPublishedOnOrigin(mainGit, config.targetBranch);

  // Le verrou doit toujours être à nous avant reset --hard / revert.
  await assertMainLockHeld(root);
  if (pushed) {
    await mainGit.raw(['revert', '-m', '1', '--no-edit', head]);
  } else {
    await mainGit.raw(['reset', '--hard', `${head}^1`]);
  }
  const newHead = (await mainGit.revparse(['HEAD'])).trim();

  // Recalage de l'agent mergé (mode reset uniquement — voir docstring).
  const registry = await readRegistry(root);
  const meta = registry[agent];
  let agentResynced = false;
  if (!pushed && meta) {
    try {
      const agentGit = cloneGit(meta.path);
      const agentHead = (await agentGit.revparse(['HEAD'])).trim();
      const commonAncestor = (await mainGit.raw(['merge-base', newHead, agentHead])).trim();
      await updateAgentMeta(root, agent, {
        lastMergedCommit: commonAncestor,
        baseCommit: commonAncestor,
      });
      agentResynced = true;
    } catch (error) {
      logger.warn(
        { err: error },
        `Recalage de l'agent ${agent} après rollback impossible (clone disparu ?)`,
      );
    }
  }

  await emitEvent(config, {
    type: 'rollback:done',
    agent,
    sha: head,
    pushed,
    message: `↩️ [Striart] Rollback du merge de ${agent} (${head.slice(0, 8)}) sur ${config.targetBranch} — ${pushed ? 'revert (historique publié conservé)' : 'reset local'}.`,
  });
  return {
    status: 'ROLLED_BACK',
    mode: pushed ? 'revert' : 'reset',
    agent,
    undoneSha: head,
    newHead,
    agentResynced,
  };
}

/**
 * Promotion staging → main (pipeline CQRS-like) :
 * les agents mergent en continu dans targetBranch (le staging), et main
 * n'avance QUE par fast-forward après un Test Gate global. main n'est
 * jamais dans un état intermédiaire, même une milliseconde.
 *
 *   staging vert (gate global) → git push . HEAD:mainBranch (ff-only)
 *   staging rouge → ticket PROMOTION_GATE_FAILED + décision humaine
 *                   (--rollback pour reset --hard staging sur main :
 *                    destructif, donc jamais par défaut)
 *
 * @param {{root: string, rollback?: boolean, signal?: AbortSignal|null}} params
 * @returns {Promise<import('./types.js').PromoteResult>}
 */
export async function promoteStaging(params) {
  return runWithDeferredEffects(() =>
    withMainLock(params.root, 'promote', () => promoteStagingImpl(params), {
      signal: params.signal ?? null,
    }),
  );
}

/**
 * Le Test Gate de promotion teste le WORKTREE, pas un SHA : avant de promouvoir
 * `stagingHead`, vérifie que ce qui a été testé est bien ce SHA — aucun fichier
 * suivi modifié par le gate (MAIN_DIRTY), et si le staging a bougé pendant le
 * gate, que son contenu est identique (sinon MERGE_STATE_CHANGED : rien n'est
 * promu). Un commit arrivé pendant le gate mais sans changement de contenu
 * (arbre identique) ne change pas ce qui a été testé.
 * @param {import('simple-git').SimpleGit} mainGit
 * @param {import('./types.js').StriartConfig} config
 * @param {string} stagingHead
 */
async function assertPromotedTreeIsTested(mainGit, config, stagingHead) {
  const headNow = (await mainGit.revparse(['HEAD'])).trim();
  if (headNow !== stagingHead) {
    const [testedTree, currentTree] = await Promise.all([
      mainGit.revparse([`${stagingHead}^{tree}`]),
      mainGit.revparse([`${headNow}^{tree}`]),
    ]);
    if (testedTree.trim() !== currentTree.trim()) {
      throw new StriartError(
        `${config.targetBranch} a changé de contenu pendant le Test Gate de promotion ` +
          `(${stagingHead.slice(0, 8)} → ${headNow.slice(0, 8)}) : ce qui a été testé n'est plus ` +
          "ce qui serait promu — rien n'a été promu.",
        {
          code: 'MERGE_STATE_CHANGED',
          hint: 'git log --oneline -5',
          details: {
            operation: 'promote',
            agent: null,
            expectedMergeHead: null,
            actualMergeHead: null,
            expectedHead: stagingHead,
            actualHead: headNow,
          },
        },
      );
    }
  }
  const dirty = (await mainGit.raw(['status', '--porcelain', '--untracked-files=no'])).trim();
  if (dirty.length > 0) {
    const files = dirty
      .split('\n')
      .map((line) => line.slice(3).trim())
      .filter(Boolean);
    throw new StriartError(
      'Le Test Gate de promotion a modifié des fichiers suivis du repo principal : ce qui a été ' +
        "testé n'est pas le SHA à promouvoir — rien n'a été promu.",
      { code: 'MAIN_DIRTY', hint: 'git status', details: { files } },
    );
  }
}

/** @returns {Promise<import('./types.js').PromoteResult>} */
async function promoteStagingImpl({ root, rollback = false }) {
  await assertInitialized(root);
  const config = await loadConfig(root);
  if (!config.mainBranch) {
    throw new StriartError(
      'La promotion nécessite mainBranch dans la config (ex: targetBranch: "striart/staging", mainBranch: "main").',
      { code: 'PROMOTION_DISABLED', hint: 'docs/fr/configuration.md (mainBranch)' },
    );
  }
  if (config.mainBranch === config.targetBranch) {
    throw new StriartError('mainBranch et targetBranch doivent différer pour la promotion.', {
      code: 'CONFIG_INVALID',
      hint: 'striart doctor',
      details: {
        reason: 'SAME_BRANCH',
        mainBranch: config.mainBranch,
        targetBranch: config.targetBranch,
      },
    });
  }

  const mainGit = simpleGit(root);
  await assertMainReady(mainGit, config.targetBranch);

  const stagingHead = (await mainGit.revparse(['HEAD'])).trim();
  const mainSha = await resolveBranchHead(mainGit, config.mainBranch, 'mainBranch');

  const ahead = Number.parseInt(
    (await mainGit.raw(['rev-list', '--count', `${config.mainBranch}..HEAD`])).trim(),
    10,
  );
  if (ahead === 0) return { status: 'UP_TO_DATE', sha: stagingHead };

  // Fast-forward uniquement : si main a avancé hors pipeline, on refuse.
  const behind = Number.parseInt(
    (await mainGit.raw(['rev-list', '--count', `HEAD..${config.mainBranch}`])).trim(),
    10,
  );
  if (behind > 0) {
    throw new StriartError(
      `"${config.mainBranch}" a ${behind} commit(s) hors pipeline : fast-forward impossible. Réconcilie manuellement (merge ${config.mainBranch} dans ${config.targetBranch}).`,
      {
        code: 'MAIN_DIVERGED',
        hint: 'git log --oneline --graph -20',
        details: { mainBranch: config.mainBranch, behind, mainSha },
      },
    );
  }

  const gate = await runTestGate({
    cwd: root,
    testCommand: config.promoteTestCommand ?? config.testCommand,
    timeoutMs: config.testTimeoutMs,
    ...gateContainerOptions(config),
  });
  // Le gate global a pu durer longtemps : verrou toujours à nous avant tout
  // effet irréversible (reset --hard, avance de mainBranch).
  await assertMainLockHeld(root);
  if (gate.success) await assertPromotedTreeIsTested(mainGit, config, stagingHead);
  if (!gate.success) {
    let rolledBack = false;
    if (rollback) {
      // reset --hard sur un staging qui a bougé pendant le gate détruirait
      // des commits que personne n'a vus passer : refus explicite.
      const headNow = (await mainGit.revparse(['HEAD'])).trim();
      if (headNow !== stagingHead) {
        throw new StriartError(
          `${config.targetBranch} a bougé pendant le Test Gate de promotion (${stagingHead.slice(0, 8)} → ` +
            `${headNow.slice(0, 8)}) : rollback refusé, rien n'a été réinitialisé.`,
          {
            code: 'MERGE_STATE_CHANGED',
            hint: 'git log --oneline -5',
            details: {
              operation: 'promote',
              agent: null,
              expectedMergeHead: null,
              actualMergeHead: null,
              expectedHead: stagingHead,
              actualHead: headNow,
            },
          },
        );
      }
      await mainGit.reset(['--hard', config.mainBranch]);
      rolledBack = true;
    }
    const ticket = await createConflictTicket(root, {
      agent: 'staging',
      branch: config.targetBranch,
      sha: stagingHead,
      reason: 'PROMOTION_GATE_FAILED',
      prompt: null,
      log: gate.log,
      gate,
    });
    await emitEvent(config, {
      type: 'promote:gate-red',
      ticketId: ticket.id,
      rolledBack,
      message: `⛔ [Striart] Test Gate global rouge sur ${config.targetBranch} — promotion vers ${config.mainBranch} refusée (ticket ${ticket.id}${rolledBack ? ', staging rollback' : ''}).`,
    });
    return { status: 'GATE_FAILED', sha: stagingHead, gate, ticket, rolledBack };
  }

  // push interne : sémantique fast-forward-only garantie par git lui-même.
  // Le SHA EXACT qui a passé le gate, pas `HEAD` : un commit arrivé sur le
  // staging pendant le gate n'a pas été testé et ne doit pas être promu.
  await mainGit.raw(['push', '.', `${stagingHead}:refs/heads/${config.mainBranch}`]);

  let pushError = null;
  if (config.autoPush) {
    try {
      await mainGit.push('origin', config.mainBranch);
    } catch (error) {
      pushError = error.message;
      logger.error({ err: error }, `Push vers origin/${config.mainBranch} échoué`);
    }
  }

  await emitEvent(config, {
    type: 'promote:done',
    sha: stagingHead,
    commits: ahead,
    message: `🎉 [Striart] ${ahead} commit(s) promus : ${config.mainBranch} ← ${config.targetBranch} (${stagingHead.slice(0, 8)}).`,
  });
  return { status: 'PROMOTED', sha: stagingHead, commits: ahead, gate, pushError };
}

/**
 * Vue scheduler (striart queue) : agents actifs + tâches en attente,
 * avec fichiers prédits et raison du blocage.
 */
/** @param {{root: string}} params @returns {Promise<Array<{id: string, agent: string, status: 'RUNNING'|'WAITING', files: string[], blockedBy: import('./types.js').Collision[], after?: string|null, ready?: boolean}>>} */
export async function getQueueDashboard({ root }) {
  await assertInitialized(root);
  const registry = await readRegistry(root);
  const queue = await readQueue(root);

  const rows = [];
  for (const [name, meta] of Object.entries(registry)) {
    rows.push({
      id: `task-${meta.taskId}`,
      agent: name,
      status: 'RUNNING',
      files: meta.predictedFiles ?? [],
      blockedBy: [],
    });
  }
  for (const task of queue) {
    // Blocage recalculé en direct : les collisions stockées peuvent dater.
    const collisions = detectCollisions(task.predictedFiles, activeAgents(registry));
    rows.push({
      id: task.id,
      agent: task.agent,
      status: 'WAITING',
      files: task.predictedFiles,
      blockedBy: collisions,
      after: task.after ?? null,
      // Plus rien ne la retient : `striart queue --retry` (ou watch) la démarrera.
      ready:
        collisions.length === 0 &&
        !registry[task.agent] &&
        !(task.after && isWorkActive(registry, queue, task.after)),
    });
  }
  return rows;
}

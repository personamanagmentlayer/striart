import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { simpleGit } from 'simple-git';
import { StriartError } from './errors.js';
import { loadConfig } from './config.js';
import {
  assertInitialized,
  cleanClones,
  createAgent,
  readRegistry,
  reuseAgent,
  removeAgentFromRegistry,
  updateAgentMeta,
  validateAgentName,
} from './clone.js';
import { DEFAULT_PROFILE, resolveAgentProfile, runAgentSession } from './session.js';
import { prunePermissions } from './permissions.ts';
import { detectCollisions, predictFiles } from './router.js';
import { buildImportGraph, detectSemanticNeighbors } from './imports.js';
import { computeWorkspaceWarnings } from './workspaces.js';
import { enqueueTask, readQueue, removeTask } from './queue.js';
import { runTestGate } from './gate.js';
import { createConflictTicket } from './conflicts.js';
import {
  MAX_MERGE_INPUT_CHARS,
  classifyConflict,
  extractConflictVersions,
  isExecutableMode,
  lineOverlap,
  semanticMerge,
} from './merger.js';
import { readState, recordSemanticFailure, recordSemanticSuccess } from './state.js';
import { emitStriartEvent } from './events.js';
import { syncAgentWithMain } from './sync.js';
import { refreshCloneMemories, updateMemoryAfterMerge } from './memory.js';
import { logger } from './logger.js';
import { withMainLock } from './lock.js';
import { isProcessAlive } from './process-tree.js';
import { parsePlan } from './plan.ts';

const MAX_PROJECT_FILES = 400;

async function listProjectFiles(root) {
  const out = await simpleGit(root).raw(['ls-files']);
  const files = out
    .split('\n')
    .map((f) => f.trim())
    .filter(Boolean);
  if (files.length > MAX_PROJECT_FILES) {
    logger.warn(
      { total: files.length, kept: MAX_PROJECT_FILES },
      'Liste de fichiers tronquée pour le prompt du Router',
    );
  }
  return files.slice(0, MAX_PROJECT_FILES);
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

/** @param {{root: string, agent?: string|null, prompt: string, command?: string|null, mode?: 'attended'|'autonomous', profile?: string|null, after?: string|null, reuse?: boolean}} params @returns {Promise<import('./types.js').RunResult>} */
export async function runTask(params) {
  return withMainLock(params.root, `run:${params.agent ?? 'auto'}`, () => runTaskImpl(params));
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

/** @param {{root: string, agent?: string|null, prompt: string, command?: string|null, mode?: 'attended'|'autonomous', profile?: string|null, after?: string|null, reuse?: boolean}} params @returns {Promise<import('./types.js').RunResult>} */
async function runTaskImpl({
  root,
  agent = null,
  prompt,
  command = null,
  mode = 'attended',
  profile = null,
  after = null,
  reuse = false,
}) {
  await assertInitialized(root);

  if (typeof prompt !== 'string' || prompt.trim().length === 0) {
    throw new StriartError('Le prompt de la tâche est vide.', { code: 'EMPTY_PROMPT' });
  }

  // --reuse cible une archive PRÉCISE : un nom dérivé du prompt tomberait
  // presque toujours à côté (REUSE_NO_CLONE au mieux, mauvaise archive au
  // pire). Refus explicite plutôt qu'un comportement hasardeux.
  if (reuse && !agent) {
    throw new StriartError('--reuse exige un nom d’agent explicite (--agent).', {
      code: 'REUSE_NEEDS_AGENT',
    });
  }

  // Pas de nom fourni → dérivé du prompt (striart run "Faire le login").
  agent = agent ?? (await generateAgentName(root, prompt));
  validateAgentName(agent);

  const registry = await readRegistry(root);
  if (registry[agent]) {
    throw new StriartError(`L'agent "${agent}" est déjà actif.`, {
      code: 'AGENT_EXISTS',
      details: { agent },
    });
  }
  const queue = await readQueue(root);
  if (queue.some((t) => t.agent === agent)) {
    throw new StriartError(`L'agent "${agent}" a déjà une tâche en file d'attente.`, {
      code: 'AGENT_QUEUED',
      details: { agent },
    });
  }

  // Dépendance déclarée : validée AVANT l'appel au Router (qui coûte un
  // appel LLM) — une référence morte ou cyclique doit échouer à vide.
  if (after) {
    if (!isWorkActive(registry, queue, after)) {
      // Une réf inconnue acceptée serait, au choix, un départ immédiat sous
      // fausse garantie ou une attente éternelle. Refus explicite.
      throw new StriartError(
        `--after "${after}" ne correspond à aucune tâche en file ni agent actif.`,
        { code: 'AFTER_UNKNOWN', details: { after } },
      );
    }
    if (hasAfterCycle(queue, agent, after)) {
      throw new StriartError(
        `--after "${after}" créerait un cycle de dépendances : ces tâches s'attendraient mutuellement pour toujours.`,
        { code: 'AFTER_CYCLE', details: { agent, after } },
      );
    }
  }

  const config = await loadConfig(root);
  const projectFiles = await listProjectFiles(root);
  const predictedFiles = await predictFiles({ prompt, projectFiles, config });

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
    });
    const blockers = collisions.map((c) => `${c.agent} (${c.files.join(', ')})`).join(' ; ');
    const cause = [
      collisions.length > 0 ? `bloquée par ${blockers}` : '',
      after ? `attend la fin de ${after}` : '',
    ]
      .filter(Boolean)
      .join(' et ');
    await emitStriartEvent(config, {
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
  // bloquant (décision archi n°4), et best effort : un graphe imparfait ne
  // doit pas empêcher un start.
  /** @type {import('./types.js').SemanticWarning[]} */
  let semanticWarnings = [];
  try {
    const graph = await buildImportGraph(root, projectFiles);
    semanticWarnings = detectSemanticNeighbors({
      graph,
      predictedFiles,
      agents: activeAgents(registry),
    });
  } catch (error) {
    logger.warn(
      { err: error },
      "Graphe d'imports indisponible (avertissements sémantiques ignorés)",
    );
  }
  for (const warning of semanticWarnings) {
    const detail = warning.links.map((l) => `${l.importedBy} importe ${l.file}`).join(' ; ');
    await emitStriartEvent(config, {
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
    await emitStriartEvent(config, {
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
 *    retourne UP_TO_DATE, `runAutonomousTask` conclut à un échec et conserve
 *    le clone. Un faux négatif, sur un cycle pourtant réussi.
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
 *    sortie en 0, au moins un commit, merge réussi, gate vert. Tout autre
 *    chemin le conserve, avec `keptReason` renseigné. Un clone est le seul
 *    matériel de diagnostic d'une session que personne n'a regardée ; le
 *    supprimer sur un échec détruirait la seule trace exploitable.
 *
 * @param {{root: string, agent?: string|null, prompt: string, profile?: string|null, timeoutMs?: number|null, after?: string|null, reuse?: boolean}} params
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
      cleaned: false,
      keptReason: null,
      clonePath: null,
      task: started.task,
    };
  }

  const meta = started.info;
  const name = meta.name;
  const base = { agent: name, session: null, merge: null, cleaned: false, clonePath: meta.path };

  let session;
  try {
    session = await runAgentSession({
      root,
      agent: name,
      taskId: meta.taskId,
      cwd: meta.path,
      profile: resolved,
      prompt,
      // Précédence : --timeout explicite > profile.timeout > config global.
      timeoutMs: timeoutMs ?? resolved.timeout ?? config.autonomousTimeoutMs,
      // Le PID publié au registre rend la session visible : tant qu'il vit,
      // le clone est intouchable (pas de rebase concurrent sous les pieds
      // d'un agent que personne ne surveille).
      onSpawn: async (pid) => {
        await updateAgentMeta(root, name, {
          sessionPid: pid ?? null,
          sessionStartedAt: new Date().toISOString(),
        });
      },
    });
  } finally {
    // Toujours dépublié, y compris si la session lève : un PID fantôme
    // gèlerait les rebases de ce clone jusqu'à son retrait du registre.
    // (Le contrôle de vitalité rattraperait le cas, mais un PID recyclé par
    // l'OS pourrait le faire mentir — mieux vaut nettoyer explicitement.)
    await updateAgentMeta(root, name, { sessionPid: null }).catch(() => {});
  }
  base.session = session;

  if (session.status !== 'COMPLETED') {
    await emitStriartEvent(config, {
      type: 'session:failed',
      agent: name,
      status: /** @type {'FAILED'|'TIMEOUT'} */ (session.status),
      logPath: session.logPath,
      message: `⛔ [Striart] Session autonome de ${name} : ${session.status}. Clone conservé, log : ${session.logPath}`,
    });
    return {
      ...base,
      status: 'SESSION_FAILED',
      keptReason: `Session ${session.status} — clone conservé pour diagnostic (log : ${session.logPath}).`,
    };
  }

  // Sortie 0 sans le moindre commit : ni succès ni échec, un troisième cas.
  // Le traiter comme un succès serait un faux positif silencieux (on
  // supprimerait un clone en croyant avoir mergé du travail inexistant).
  const head = (await simpleGit(meta.path).revparse(['HEAD'])).trim();
  if (head === meta.baseCommit) {
    await emitStriartEvent(config, {
      type: 'session:empty',
      agent: name,
      message: `⚠️ [Striart] Agent ${name} sorti sans produire de commit — clone conservé.`,
    });
    return {
      ...base,
      status: 'EMPTY',
      keptReason: "L'agent est sorti en 0 sans produire de commit — rien à merger, clone conservé.",
    };
  }

  const merge = await mergeAgentCommit({ root, agent: name });
  base.merge = merge;
  if (merge.status !== 'MERGED') {
    return {
      ...base,
      status: 'MERGE_BLOCKED',
      keptReason: `Merge ${merge.status} — clone conservé, le travail de l'agent n'est pas perdu.`,
    };
  }

  // Nettoyage. `force` reste FAUX : les garde-fous de cleanClones (travail non
  // mergé, clone verrouillé) gardent le dernier mot. Si l'un d'eux refuse, ce
  // n'est pas un obstacle à contourner mais un signal à remonter.
  const cleanup = await cleanClones({
    root,
    agent: name,
    all: true,
    force: false,
    sessionEnded: true,
  });
  const removed = cleanup.removed.some((r) => r.name === name);
  const skipped = cleanup.skipped.find((s) => s.name === name);

  return {
    ...base,
    status: 'MERGED',
    cleaned: removed,
    keptReason: removed
      ? null
      : `Merge réussi mais nettoyage sauté (${skipped?.reason ?? 'raison inconnue'}) — clone conservé.`,
  };
}

async function abortMerge(git) {
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
      { code: 'MERGE_ABORT_FAILED' },
    );
  }
}

/** Taille max du log de gate réinjecté dans le prompt du Merger (fin du log). */
const GATE_FEEDBACK_MAX_CHARS = 4000;

/**
 * Fusionne un fichier en conflit via le Merger LLM et applique le résultat
 * au worktree + index du repo principal (bit exécutable préservé).
 * `feedback` : log d'un Test Gate rouge à réinjecter (retry post-gate).
 * @param {{mainGit: import('simple-git').SimpleGit, root: string, config: import('./types.js').StriartConfig, res: {path: string, base: string, ours: string, theirs: string, modes: import('./types.js').StageModes, llmAttempt?: string}, feedback?: string|null}} params
 */
async function mergeResolutionWithLlm({ mainGit, root, config, res, feedback = null }) {
  res.llmAttempt = await semanticMerge({
    filePath: res.path,
    base: res.base,
    ours: res.ours,
    theirs: res.theirs,
    config,
    feedback,
  });
  await writeFile(path.join(root, res.path), res.llmAttempt, 'utf8');
  await mainGit.add(res.path);
  // writeFile ne préserve pas le bit exécutable (et il n'existe pas sur
  // NTFS) : on le repose dans l'index quand les deux côtés l'avaient —
  // la classification a déjà routé les modes divergents en ticket.
  if (isExecutableMode(res.modes.ours)) {
    await mainGit.raw(['update-index', '--chmod=+x', '--', res.path]);
  }
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
      { code: 'MAIN_DIRTY', details: { files: [...new Set(dirtyFiles)] } },
    );
  }
  const currentBranch = (await mainGit.revparse(['--abbrev-ref', 'HEAD'])).trim();
  if (currentBranch !== expectedBranch) {
    throw new StriartError(
      `Le repo principal est sur "${currentBranch}" mais la branche attendue est "${expectedBranch}". Checkout la branche ou ajuste striart.config.`,
      { code: 'TARGET_BRANCH_MISMATCH', details: { currentBranch, expectedBranch } },
    );
  }
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
/** @param {{root: string, agent: string}} params @returns {Promise<import('./types.js').MergeResult>} */
export async function mergeAgentCommit(params) {
  return withMainLock(params.root, `merge:${params.agent}`, () => mergeAgentCommitImpl(params));
}

/** @returns {Promise<import('./types.js').MergeResult>} */
async function mergeAgentCommitImpl({ root, agent }) {
  await assertInitialized(root);
  const config = await loadConfig(root);
  const registry = await readRegistry(root);
  let meta = registry[agent];
  if (!meta) {
    throw new StriartError(`Agent inconnu : "${agent}".`, {
      code: 'AGENT_UNKNOWN',
      details: { agent },
    });
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
  try {
    await mainGit.fetch(meta.path, meta.branch);
    const preRebaseHead = (await mainGit.revparse(['FETCH_HEAD'])).trim();
    if (preRebaseHead !== (meta.lastMergedCommit ?? meta.baseCommit)) {
      renameHazards = await detectSilentRenameHazards(mainGit, 'HEAD', preRebaseHead);
    }
  } catch (error) {
    logger.warn({ err: error }, 'Détection de renommage divergent échouée (ignorée)');
  }
  for (const hazard of renameHazards) {
    await emitStriartEvent(config, {
      type: 'merge:rename-hazard',
      agent,
      source: hazard.source,
      ours: hazard.ours,
      theirs: hazard.theirs,
      message: `⚠️ [Striart] Merge de ${agent} : ${hazard.source} supprimé des deux côtés et son contenu réapparaît sous DEUX noms (main: ${hazard.ours}, agent: ${hazard.theirs}) — probable double-renommage non détecté par git, le fichier existera en double.`,
    });
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

  const agentGit = simpleGit(meta.path);
  const agentHead = (await agentGit.revparse(['HEAD'])).trim();
  const lastMerged = meta.lastMergedCommit ?? meta.baseCommit;
  if (agentHead === lastMerged) {
    return { status: 'UP_TO_DATE', agent, sha: agentHead, rebase };
  }

  await mainGit.fetch(meta.path, meta.branch);
  // Un merge en conflit ne throw pas toujours côté simple-git avec --no-commit :
  // on vérifie l'état de conflit dans tous les cas, exception ou non.
  let mergeError = null;
  try {
    await mainGit.raw(['merge', 'FETCH_HEAD', '--no-commit', '--no-ff']);
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
        }),
      }))
      .filter((c) => c.kind !== 'text');
    if (unmergeable.length > 0) {
      await abortMerge(mainGit);
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
      await emitStriartEvent(config, {
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
      await abortMerge(mainGit);
      const ticket = await createConflictTicket(root, { ...ticketBase, reason: 'MERGE_CONFLICT' });
      await emitStriartEvent(config, {
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
        await mergeResolutionWithLlm({ mainGit, root, config, res });
      }
    } catch (error) {
      await abortMerge(mainGit);
      const state2 = await recordSemanticFailure(root);
      const ticket = await createConflictTicket(root, {
        ...ticketBase,
        reason: 'SEMANTIC_MERGE_FAILED',
      });
      await emitStriartEvent(config, {
        type: 'merge:semantic-failed',
        agent,
        ticketId: ticket.id,
        files: conflicted,
        message: `⛔ [Striart] Fusion sémantique échouée pour ${agent} (${conflicted.join(', ')}) — ticket ${ticket.id}.`,
      });
      if (state2.manualMode) {
        await emitStriartEvent(config, {
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
    await abortMerge(mainGit);
    // Collision de création : l'agent a commité un fichier qui existe en
    // untracked dans le repo principal (faux négatif du Router sur un ajout).
    // Ce n'est pas un conflit 3-way — git refuse d'écraser le fichier local.
    if (/untracked working tree files would be overwritten/i.test(mergeError.message)) {
      throw new StriartError(
        `Merge de "${agent}" refusé : des fichiers untracked du repo principal seraient écrasés par le merge. ` +
          'Commit, déplace ou supprime ces fichiers, puis relance le merge.',
        { code: 'UNTRACKED_COLLISION', details: { agent, cause: mergeError.message } },
      );
    }
    throw new StriartError(`Échec du merge de "${agent}" : ${mergeError.message}`, {
      code: 'MERGE_FAILED',
      details: { agent, cause: mergeError.message },
    });
  }

  let gate = await runTestGate({
    cwd: root,
    testCommand: config.testCommand,
    timeoutMs: config.testTimeoutMs,
  });

  // Retry post-gate (fusion sémantique uniquement) : le Merger reçoit le log
  // d'échec des tests et corrige sa propre fusion avant le ticket humain.
  // Un gate rouge sur merge propre = le code de l'AGENT est cassé — pas de
  // retry, le LLM n'y changerait rien.
  let gateRetries = 0;
  if (!gate.success && semantic && config.semanticGateRetries > 0) {
    for (let attempt = 1; attempt <= config.semanticGateRetries && !gate.success; attempt += 1) {
      const feedback = gate.log.slice(-GATE_FEEDBACK_MAX_CHARS);
      try {
        for (const res of semantic.resolutions) {
          await mergeResolutionWithLlm({ mainGit, root, config, res, feedback });
        }
      } catch (error) {
        // LLM en échec pendant le retry : on garde le gate rouge courant,
        // le chemin ticket ci-dessous s'applique.
        logger.warn({ err: error }, `Retry sémantique ${attempt} interrompu (LLM en échec)`);
        break;
      }
      gateRetries = attempt;
      gate = await runTestGate({
        cwd: root,
        testCommand: config.testCommand,
        timeoutMs: config.testTimeoutMs,
      });
      logger.info(
        `Retry sémantique ${attempt}/${config.semanticGateRetries} : Test Gate ${gate.success ? 'vert' : 'rouge'}`,
      );
    }
  }

  if (!gate.success) {
    await abortMerge(mainGit);
    let manualMode = false;
    if (semantic) ({ manualMode } = await recordSemanticFailure(root));
    const ticket = await createConflictTicket(root, {
      agent,
      branch: meta.branch,
      sha: agentHead,
      reason: semantic ? 'SEMANTIC_GATE_FAILED' : 'GATE_FAILED',
      conflictedFiles: semantic?.resolvedFiles ?? [],
      prompt: meta.prompt,
      log: gate.log,
      resolutions: semantic?.resolutions ?? [],
    });
    await emitStriartEvent(config, {
      type: 'merge:gate-red',
      agent,
      ticketId: ticket.id,
      exitCode: gate.exitCode,
      message: `⛔ [Striart] Test Gate rouge pour ${agent} (exit ${gate.exitCode}) — merge annulé, ticket ${ticket.id}.`,
    });
    if (manualMode) {
      await emitStriartEvent(config, {
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

  const mergeNote = semantic ? ` [fusion sémantique: ${semantic.resolvedFiles.join(', ')}]` : '';
  await mainGit.commit(
    `merge(striart): ${agent} ${meta.branch} (${agentHead.slice(0, 8)})${mergeNote}`,
  );
  if (semantic) await recordSemanticSuccess(root);

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
    memory = await updateMemoryAfterMerge({ root, config, agent, sha: agentHead, diff });
    await refreshLiveMemory(root, config);
  }

  await updateAgentMeta(root, agent, { lastMergedCommit: agentHead });
  return {
    status: 'MERGED',
    agent,
    sha: agentHead,
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
    { code: 'SESSION_LIVE', details: { agent, pid: meta.sessionPid } },
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
/** @param {{root: string, agent: string, force?: boolean}} params */
export async function stopAgent(params) {
  return withMainLock(params.root, `stop:${params.agent}`, () => stopAgentImpl(params));
}

async function stopAgentImpl({ root, agent, force = false }) {
  await assertInitialized(root);
  const registry = await readRegistry(root);
  const meta = registry[agent];
  if (!meta) {
    throw new StriartError(`Agent inconnu : "${agent}".`, {
      code: 'AGENT_UNKNOWN',
      details: { agent },
    });
  }

  assertNoLiveSession(agent, meta, 'Stop');

  const agentHead = (await simpleGit(meta.path).revparse(['HEAD'])).trim();
  const lastMerged = meta.lastMergedCommit ?? meta.baseCommit;
  if (agentHead !== lastMerged && !force) {
    throw new StriartError(
      `L'agent "${agent}" a des commits non mergés (${agentHead.slice(0, 8)}). Merge d'abord, ou --force pour abandonner ce travail.`,
      { code: 'AGENT_HAS_PENDING', details: { agent, head: agentHead, lastMerged } },
    );
  }

  await removeAgentFromRegistry(root, agent);
  const { started, stillWaiting } = await retryQueue({ root });
  return { agent, clonePath: meta.path, started, stillWaiting };
}

/**
 * Re-tente les tâches en attente dont les collisions ont disparu
 * (agent bloquant mergé puis retiré du registre).
 * Appelé par striart queue --retry et automatiquement par stopAgent.
 */
export async function retryQueue(params) {
  return withMainLock(params.root, 'queue-retry', () => retryQueueImpl(params));
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
          })
        : await createAgent({
            root,
            name: task.agent,
            prompt: task.prompt,
            predictedFiles: task.predictedFiles,
            command: task.command ?? null,
            cloneFilter: config.cloneFilter,
            secretPatterns: config.secretPatterns,
          });
    } catch (error) {
      // Une archive devenue inutilisable entre la mise en file et le
      // dégagement (travail non commité apparu, activité disque, clone
      // nettoyé) ne doit pas faire échouer TOUT le passage de la file : la
      // tâche reste en attente avec le motif, les suivantes sont examinées.
      if (error instanceof StriartError && error.code?.startsWith('REUSE_')) {
        logger.warn(
          { err: error, task: task.id },
          'Réutilisation impossible, tâche maintenue en file',
        );
        stillWaiting.push({ ...task, collisions, blockedReason: error.code });
        continue;
      }
      throw error;
    }
    await removeTask(root, task.id);
    await emitStriartEvent(config, {
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
 * @param {{root: string}} params
 * @returns {Promise<{sessionPidsCleared: string[], started: Array<{task: import('./types.js').QueueTask, info: import('./types.js').AgentMeta}>, stillWaiting: import('./types.js').QueueTask[], permissionsPruned: number}>}
 */
export async function reconcile(params) {
  return withMainLock(params.root, 'reconcile', () => reconcileImpl(params));
}

async function reconcileImpl({ root }) {
  await assertInitialized(root);

  // 1. Neutraliser les PID de session morts (hygiène du registre).
  const registry = await readRegistry(root);
  const sessionPidsCleared = [];
  for (const [agent, meta] of Object.entries(registry)) {
    if (meta.sessionPid != null && !isProcessAlive(meta.sessionPid)) {
      await updateAgentMeta(root, agent, { sessionPid: null });
      sessionPidsCleared.push(agent);
    }
  }

  // 2. Convergence de la file. Réentrant : retryQueue reprend le verrou déjà
  //    tenu, sans doubler la logique (une seule source de vérité du déblocage).
  const { started, stillWaiting } = await retryQueueImpl({ root });

  // 3. Hygiène des permissions semi-autonomes : une demande expirée dont la
  //    session est morte sans nettoyer (crash) resterait un bouton mort au
  //    dashboard. Best effort — l'hygiène ne fait jamais échouer la passe.
  const permissionsPruned = await prunePermissions(root).catch(() => 0);

  if (sessionPidsCleared.length > 0 || started.length > 0 || permissionsPruned > 0) {
    logger.info(
      { sessionPidsCleared, started: started.map((s) => s.task.agent), permissionsPruned },
      'Réconciliation : état convergé',
    );
  }
  return { sessionPidsCleared, started, stillWaiting, permissionsPruned };
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
 * @param {{root: string, planText: string, dryRun?: boolean}} params
 * @returns {Promise<{dryRun: boolean, tasks: Array<{id: string|null, agent: string|null, mode: 'attended'|'autonomous', after: string|null}>, results?: Array<{id: string|null, agent: string|null, mode: 'attended'|'autonomous', status: string, info?: (import('./types.js').AgentMeta & {name: string}) | null}>}>}
 */
export async function applyPlan({ root, planText, dryRun = false }) {
  await assertInitialized(root);
  const plan = parsePlan(planText); // lève PLAN_INVALID avant tout effet de bord
  const config = await loadConfig(root);

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
  for (const task of plan.tasks) {
    const after = resolveAfter(task.after);
    if (task.autonomous) {
      const r = await runAutonomousTask({
        root,
        agent: task.agent,
        prompt: task.prompt,
        profile: task.profile,
        timeoutMs: task.timeout,
        after,
      });
      const agentName = r.agent ?? task.agent;
      if (task.id) idToAgent.set(task.id, agentName);
      results.push({ id: task.id, agent: agentName, mode: 'autonomous', status: r.status });
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
  return { dryRun: false, tasks: [], results };
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
 * @param {{root: string}} params
 * @returns {Promise<import('./types.js').RollbackResult>}
 */
export async function rollbackLastMerge(params) {
  return withMainLock(params.root, 'rollback', () => rollbackLastMergeImpl(params));
}

/** @returns {Promise<import('./types.js').RollbackResult>} */
async function rollbackLastMergeImpl({ root }) {
  await assertInitialized(root);
  const config = await loadConfig(root);
  const mainGit = simpleGit(root);
  await assertMainReady(mainGit, config.targetBranch);

  const head = (await mainGit.revparse(['HEAD'])).trim();
  const message = (await mainGit.raw(['log', '-1', '--format=%s', 'HEAD'])).trim();
  const match = message.match(/^merge\(striart\): (\S+) /);
  if (!match) {
    throw new StriartError(
      `Le dernier commit de ${config.targetBranch} n'est pas un merge Striart ("${message.slice(0, 60)}"). ` +
        'striart rollback ne défait que le merge en tête de branche — au-delà, résolution manuelle (git revert).',
      { code: 'NOT_A_STRIART_MERGE', details: { head, message } },
    );
  }
  const agent = match[1];

  // Poussé sur origin ? → revert (jamais de réécriture d'historique publié).
  let pushed = false;
  try {
    await mainGit.raw(['merge-base', '--is-ancestor', 'HEAD', `origin/${config.targetBranch}`]);
    pushed = true;
  } catch {
    // Pas de remote, ou HEAD pas encore poussé : reset autorisé.
  }

  if (pushed) {
    await mainGit.raw(['revert', '-m', '1', '--no-edit', 'HEAD']);
  } else {
    await mainGit.raw(['reset', '--hard', 'HEAD^']);
  }
  const newHead = (await mainGit.revparse(['HEAD'])).trim();

  // Recalage de l'agent mergé (mode reset uniquement — voir docstring).
  const registry = await readRegistry(root);
  const meta = registry[agent];
  let agentResynced = false;
  if (!pushed && meta) {
    try {
      const agentGit = simpleGit(meta.path);
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

  await emitStriartEvent(config, {
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
 * @param {{root: string, rollback?: boolean}} params
 * @returns {Promise<import('./types.js').PromoteResult>}
 */
export async function promoteStaging(params) {
  return withMainLock(params.root, 'promote', () => promoteStagingImpl(params));
}

/** @returns {Promise<import('./types.js').PromoteResult>} */
async function promoteStagingImpl({ root, rollback = false }) {
  await assertInitialized(root);
  const config = await loadConfig(root);
  if (!config.mainBranch) {
    throw new StriartError(
      'La promotion nécessite mainBranch dans la config (ex: targetBranch: "striart/staging", mainBranch: "main").',
      { code: 'PROMOTION_DISABLED' },
    );
  }
  if (config.mainBranch === config.targetBranch) {
    throw new StriartError('mainBranch et targetBranch doivent différer pour la promotion.', {
      code: 'CONFIG_INVALID',
      details: { mainBranch: config.mainBranch, targetBranch: config.targetBranch },
    });
  }

  const mainGit = simpleGit(root);
  await assertMainReady(mainGit, config.targetBranch);

  const stagingHead = (await mainGit.revparse(['HEAD'])).trim();
  let mainSha;
  try {
    mainSha = (await mainGit.revparse([config.mainBranch])).trim();
  } catch {
    throw new StriartError(
      `La branche "${config.mainBranch}" n'existe pas dans le repo principal.`,
      {
        code: 'UNKNOWN_BRANCH',
        details: { branch: config.mainBranch },
      },
    );
  }

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
      { code: 'MAIN_DIVERGED', details: { mainBranch: config.mainBranch, behind, mainSha } },
    );
  }

  const gate = await runTestGate({
    cwd: root,
    testCommand: config.promoteTestCommand ?? config.testCommand,
    timeoutMs: config.testTimeoutMs,
  });
  if (!gate.success) {
    let rolledBack = false;
    if (rollback) {
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
    });
    await emitStriartEvent(config, {
      type: 'promote:gate-red',
      ticketId: ticket.id,
      rolledBack,
      message: `⛔ [Striart] Test Gate global rouge sur ${config.targetBranch} — promotion vers ${config.mainBranch} refusée (ticket ${ticket.id}${rolledBack ? ', staging rollback' : ''}).`,
    });
    return { status: 'GATE_FAILED', sha: stagingHead, gate, ticket, rolledBack };
  }

  // push interne : sémantique fast-forward-only garantie par git lui-même.
  await mainGit.raw(['push', '.', `HEAD:refs/heads/${config.mainBranch}`]);

  let pushError = null;
  if (config.autoPush) {
    try {
      await mainGit.push('origin', config.mainBranch);
    } catch (error) {
      pushError = error.message;
      logger.error({ err: error }, `Push vers origin/${config.mainBranch} échoué`);
    }
  }

  await emitStriartEvent(config, {
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
/** @param {{root: string}} params @returns {Promise<Array<{id: string, agent: string, status: 'RUNNING'|'WAITING', files: string[], blockedBy: import('./types.js').Collision[], after?: string|null}>>} */
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
    });
  }
  return rows;
}

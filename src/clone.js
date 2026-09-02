import { mkdir, readdir, rm, stat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { simpleGit } from 'simple-git';
import { StriartError } from './errors.js';
import { readJson, writeJsonAtomic } from './json-file.js';
import { agentsDir, striartDir } from './paths.js';
import { syncLocks } from './locks.js';
import { withMainLock } from './lock.js';
import { CLONE_MEMORY_FILE, syncMemoryToClone } from './memory.js';
import { isProcessAlive } from './process-tree.js';

// Ré-export : les modules historiques importent ces helpers depuis clone.js.
export { agentsDir, striartDir } from './paths.js';

const AGENT_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/i;

/** Séparateur des sorties git -z. */
const NUL_BYTE = String.fromCharCode(0);

function registryPath(root) {
  return path.join(striartDir(root), 'agents.json');
}

export function validateAgentName(name) {
  if (typeof name !== 'string' || !AGENT_NAME_RE.test(name)) {
    throw new StriartError(
      `Nom d'agent invalide : "${name}". Attendu : alphanumérique, tirets et underscores (max 64 caractères).`,
      { code: 'INVALID_AGENT_NAME', details: { name } },
    );
  }
  return name;
}

/**
 * Racine du repo Git courant. Throw si on n'est pas dans un repo.
 */
export async function findRepoRoot(cwd = process.cwd()) {
  try {
    const top = await simpleGit(cwd).revparse(['--show-toplevel']);
    return path.resolve(top.trim());
  } catch {
    throw new StriartError(`Aucun dépôt Git trouvé depuis ${cwd}. Lance d'abord "git init".`, {
      code: 'NOT_A_GIT_REPO',
      details: { cwd },
    });
  }
}

export async function assertInitialized(root) {
  try {
    await stat(striartDir(root));
  } catch {
    throw new StriartError(`.striart/ introuvable dans ${root}. Lance d'abord "striart init".`, {
      code: 'NOT_INITIALIZED',
      details: { root },
    });
  }
}

/** @param {string} root @returns {Promise<import('./types.js').AgentRegistry>} */
export async function readRegistry(root) {
  return readJson(registryPath(root), { fallback: {}, code: 'REGISTRY_CORRUPT' });
}

async function writeRegistry(root, registry) {
  await writeJsonAtomic(registryPath(root), registry);
}

/** @param {string} root @param {string} name @param {Partial<import('./types.js').AgentMeta>} patch @returns {Promise<import('./types.js').AgentMeta>} */
export async function updateAgentMeta(root, name, patch) {
  const registry = await readRegistry(root);
  if (!registry[name]) {
    throw new StriartError(`Agent inconnu : "${name}".`, {
      code: 'AGENT_UNKNOWN',
      details: { name },
    });
  }
  registry[name] = { ...registry[name], ...patch };
  await writeRegistry(root, registry);
  return registry[name];
}

/**
 * Retire l'agent du registre. Le clone sur disque n'est JAMAIS supprimé
 * ici (règle d'or n°3) : le cleanup physique est une décision humaine.
 */
export async function removeAgentFromRegistry(root, name) {
  const registry = await readRegistry(root);
  if (!registry[name]) {
    throw new StriartError(`Agent inconnu : "${name}".`, {
      code: 'AGENT_UNKNOWN',
      details: { name },
    });
  }
  delete registry[name];
  await writeRegistry(root, registry);
  await syncLocks(root, registry);
}

/**
 * Statistiques d'un dossier en un seul parcours :
 *  - sizeBytes : espace ADDITIONNEL — les fichiers hardlinkés depuis le repo
 *    principal (nlink > 1, ex: .git/objects d'un clone local) comptent 0 ;
 *  - latestMtimeMs : dernière activité (mtime le plus récent, fichiers et
 *    dossiers confondus) — sert à la rétention de striart prune.
 * Les symlinks ne sont pas suivis.
 * @returns {Promise<{sizeBytes: number, latestMtimeMs: number}>}
 */
export async function dirStats(dir) {
  let sizeBytes = 0;
  let latestMtimeMs = 0;
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const p = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) continue;
    const stats = await stat(p).catch(() => null);
    if (!stats) continue;
    latestMtimeMs = Math.max(latestMtimeMs, stats.mtimeMs);
    if (entry.isDirectory()) {
      const sub = await dirStats(p);
      sizeBytes += sub.sizeBytes;
      latestMtimeMs = Math.max(latestMtimeMs, sub.latestMtimeMs);
    } else if (entry.isFile() && stats.nlink <= 1) {
      sizeBytes += stats.size;
    }
  }
  return { sizeBytes, latestMtimeMs };
}

export async function dirSizeBytes(dir) {
  return (await dirStats(dir)).sizeBytes;
}

export function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} o`;
  const units = ['Ko', 'Mo', 'Go', 'To'];
  let value = bytes;
  let unit = -1;
  do {
    value /= 1024;
    unit += 1;
  } while (value >= 1024 && unit < units.length - 1);
  return `${value.toFixed(value >= 100 ? 0 : 1)} ${units[unit]}`;
}

/**
 * Crée un clone agent isolé :
 *   git clone <root> .striart/agents/<name>   (chemin local : git hardlinke
 *     nativement .git/objects — sûr car les objets sont immuables, un gc du
 *     principal fait des unlink qui ne touchent pas les inodes des clones)
 *   checkout -b striart/<name>/task-<uuid>
 *   sans cloneFilter : suppression du remote origin (clone orphelin, règle d'or n°1)
 *   avec cloneFilter (ex: 'blob:none') : origin conservé comme promisor
 *     fetch-only (pushurl neutralisé — l'interdiction porte sur le push)
 */
/**
 * Retire du worktree du clone les fichiers de secrets TRACKÉS (`.env` commité
 * par erreur, clés, certificats…) via sparse-checkout non-cone : le bit
 * SKIP_WORKTREE fait disparaître le fichier du disque SANS salir `git status`
 * (contrairement à une suppression, qui finirait commitée par l'agent).
 * Les fichiers untracked ne sont jamais clonés par git : rien à faire pour eux.
 * Sémantique gitignore : un motif sans `/` matche à toute profondeur.
 * @param {import('simple-git').SimpleGit} agentGit
 * @param {string[]} patterns
 * @returns {Promise<string[]>} fichiers exclus du worktree
 */
async function excludeTrackedSecrets(agentGit, patterns) {
  if (!patterns || patterns.length === 0) return [];
  const raw = await agentGit.raw(['ls-files', '-z']);
  const tracked = raw.split(NUL_BYTE).filter(Boolean);
  const matchers = patterns.map(gitignorePatternToRegExp);
  const excluded = tracked.filter((file) => matchers.some((re) => re.test(file)));
  if (excluded.length === 0) return [];
  await agentGit.raw([
    'sparse-checkout',
    'set',
    '--no-cone',
    '--',
    '/*',
    ...patterns.map((p) => `!${p}`),
  ]);
  return excluded;
}

/** Motif gitignore simplifié → RegExp (sans `/` : matche le nom de base à toute profondeur). */
function gitignorePatternToRegExp(pattern) {
  const glob = pattern
    .replaceAll(/[.+^${}()|[\]\\]/g, '\\$&')
    .replaceAll('*', '[^/]*')
    .replaceAll('?', '[^/]');
  return pattern.includes('/')
    ? new RegExp(`^${glob.replace(/^\\\//, '')}$`)
    : new RegExp(`(^|/)${glob}$`);
}

/** @param {{root: string, name: string, prompt?: string|null, predictedFiles?: string[], command?: string|null, cloneFilter?: string|null, secretPatterns?: string[]|null, mode?: 'attended'|'autonomous', profile?: string|null}} params @returns {Promise<import('./types.js').AgentMeta & {name: string}>} */
export async function createAgent(params) {
  return withMainLock(params.root, `start:${params.name}`, () => createAgentImpl(params));
}

/** @param {{root: string, name: string, prompt?: string|null, predictedFiles?: string[], command?: string|null, cloneFilter?: string|null, secretPatterns?: string[]|null, mode?: 'attended'|'autonomous', profile?: string|null}} params */
async function createAgentImpl({
  root,
  name,
  prompt = null,
  predictedFiles = [],
  command = null,
  cloneFilter = null,
  secretPatterns = null,
  mode = 'attended',
  profile = null,
}) {
  validateAgentName(name);
  await assertInitialized(root);

  const registry = await readRegistry(root);
  const dest = path.join(agentsDir(root), name);

  if (registry[name] || (await stat(dest).catch(() => null))) {
    throw new StriartError(`L'agent "${name}" existe déjà (${dest}).`, {
      code: 'AGENT_EXISTS',
      details: { name, path: dest },
    });
  }

  const mainGit = simpleGit(root);
  let baseCommit;
  try {
    baseCommit = (await mainGit.revparse(['HEAD'])).trim();
  } catch {
    throw new StriartError(
      'Le repo principal ne contient aucun commit. Crée au moins un commit avant de démarrer un agent.',
      { code: 'EMPTY_REPO', details: { root } },
    );
  }

  await mkdir(agentsDir(root), { recursive: true });

  const taskId = randomUUID().slice(0, 8);
  const branch = `striart/${name}/task-${taskId}`;

  try {
    // Chemin local (pas file://) : git hardlinke les objets immuables — le
    // clone est quasi instantané et l'historique ne coûte qu'une fois.
    await simpleGit().clone(root, dest, cloneFilter ? [`--filter=${cloneFilter}`] : []);
    const agentGit = simpleGit(dest);
    await agentGit.checkoutLocalBranch(branch);
    if (cloneFilter) {
      // Clone partiel : origin doit rester comme promisor pour les blobs à la
      // demande. Fetch-only : le push est neutralisé (règle d'or n°1).
      await agentGit.raw(['remote', 'set-url', '--push', 'origin', 'push-disabled://striart']);
    } else {
      await agentGit.removeRemote('origin');
    }
  } catch (error) {
    throw new StriartError(`Échec du clonage de l'agent "${name}" : ${error.message}`, {
      code: 'CLONE_FAILED',
      details: { name, dest, cause: error.message },
    });
  }

  // Question ouverte n°4 tranchée : les secrets trackés sont retirés du
  // worktree du clone. Échec = échec — une mesure de sécurité ne se dégrade
  // pas en silence (le clone incomplet est supprimé).
  let secretsExcluded;
  try {
    secretsExcluded = await excludeTrackedSecrets(simpleGit(dest), secretPatterns ?? []);
  } catch (error) {
    await rm(dest, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
    throw new StriartError(
      `Exclusion des secrets impossible pour l'agent "${name}" (git 2.35+ requis pour sparse-checkout --no-cone) : ${error.message}. ` +
        'Mets git à jour, ou désactive explicitement avec secretPatterns: [] dans striart.config.',
      { code: 'SECRETS_EXCLUSION_FAILED', details: { name, cause: error.message } },
    );
  }

  // Memory Layer : le nouvel agent démarre avec la connaissance des merges
  // passés (no-op si la mémoire n'existe pas encore).
  await syncMemoryToClone(root, dest);

  registry[name] = {
    branch,
    taskId,
    path: dest,
    baseCommit,
    prompt,
    predictedFiles,
    command, // outil de coding propre à cet agent (claude, aider, cursor...)
    cloneFilter,
    secretsExcluded,
    mode, // 'attended' (l'humain pilote) | 'autonomous' (Striart pilote)
    profile, // clé de config.agentProfiles en mode autonome
    createdAt: new Date().toISOString(),
  };
  await writeRegistry(root, registry);
  await syncLocks(root, registry);

  return { name, ...registry[name] };
}

/**
 * Réhabilite le clone d'un agent ARRÊTÉ (archive hors registre) pour une
 * nouvelle tâche, au lieu d'exiger `clean` + `start` : resynchronisation sur
 * le main courant (fetch par chemin local + checkout forcé), nouvelle branche
 * de tâche, ré-application des exclusions de secrets, ré-enregistrement.
 * Les untracked du worktree (node_modules, .env local…) sont CONSERVÉS —
 * c'est le bénéfice du reuse : repartir chaud.
 *
 * Garde-fous, du plus solide au plus heuristique :
 *  - agent encore au registre → AGENT_EXISTS (reuse ne s'applique qu'à une
 *    archive) ; pas de clone sur disque → REUSE_NO_CLONE ;
 *  - travail non commité (REUSE_DIRTY) ou commits absents du main courant
 *    (REUSE_UNMERGED) : le reset les détruirait — refus sans `force` ;
 *  - activité disque récente (fenêtre `presenceMinutes`) → REUSE_IN_USE :
 *    heuristique mtime (règle d'or n°3), contournable par `force` explicite.
 *
 * @param {{root: string, name: string, prompt?: string|null, predictedFiles?: string[], command?: string|null, secretPatterns?: string[]|null, mode?: 'attended'|'autonomous', profile?: string|null, force?: boolean}} params
 * @returns {Promise<import('./types.js').AgentMeta & {name: string}>}
 */
export async function reuseAgent(params) {
  return withMainLock(params.root, `reuse:${params.name}`, () => reuseAgentImpl(params));
}

/** @param {{root: string, name: string, prompt?: string|null, predictedFiles?: string[], command?: string|null, secretPatterns?: string[]|null, mode?: 'attended'|'autonomous', profile?: string|null, force?: boolean}} params */
async function reuseAgentImpl({
  root,
  name,
  prompt = null,
  predictedFiles = [],
  command = null,
  secretPatterns = null,
  mode = 'attended',
  profile = null,
  force = false,
}) {
  validateAgentName(name);
  await assertInitialized(root);

  const registry = await readRegistry(root);
  if (registry[name]) {
    throw new StriartError(
      `L'agent "${name}" est encore actif : --reuse ne réhabilite qu'un clone ARRÊTÉ. Merge/stop d'abord.`,
      { code: 'AGENT_EXISTS', details: { name } },
    );
  }
  const dest = path.join(agentsDir(root), name);
  if (!(await stat(dest).catch(() => null))) {
    throw new StriartError(
      `Aucun clone à réutiliser pour "${name}" (${dest}). Utilise striart start sans --reuse.`,
      { code: 'REUSE_NO_CLONE', details: { name, dest } },
    );
  }

  // Présence : une archive qui vient d'écrire sur disque héberge peut-être
  // encore un process. Heuristique mtime — force explicite pour passer outre.
  const { workActivityMs } = await cloneStats(dest);
  if (Date.now() - workActivityMs < (await presenceWindowMs(root)) && !force) {
    throw new StriartError(
      `Le clone de "${name}" a une activité disque récente (IN_USE). Vérifie qu'aucun process n'y travaille, ou --force.`,
      { code: 'REUSE_IN_USE', details: { name, dest } },
    );
  }

  const agentGit = simpleGit(dest);
  // « Sale » = changements sur des fichiers TRACKÉS. Les untracked ne
  // comptent pas : ils survivent au reuse (c'est même son intérêt — repartir
  // avec node_modules et l'outillage local en place).
  const status = await agentGit.status();
  const dirty = status.files.some((f) => f.index !== '?' || f.working_dir !== '?');
  if (dirty && !force) {
    throw new StriartError(
      `Le clone de "${name}" contient du travail non commité : le réutiliser le détruirait. Commit/stash d'abord, ou --force pour l'abandonner.`,
      { code: 'REUSE_DIRTY', details: { name, dest } },
    );
  }

  const mainGit = simpleGit(root);
  const baseCommit = (await mainGit.revparse(['HEAD'])).trim();
  try {
    // Fetch par chemin local (mêmes propriétés que le clone initial) du seul
    // HEAD du principal : rien à nettoyer, aucune ref permanente créée.
    await agentGit.raw(['fetch', '--quiet', root, 'HEAD']);
  } catch (error) {
    throw new StriartError(`Resynchronisation de "${name}" impossible : ${error.message}`, {
      code: 'REUSE_FETCH_FAILED',
      details: { name, dest, cause: error.message },
    });
  }
  // Commits de l'archive absents du main courant. Pas de `merge-base
  // --is-ancestor` : simple-git ne distingue pas son code de sortie 1 (« pas
  // ancêtre ») d'un succès — le comptage rev-list, lui, est sans ambiguïté.
  const ahead = Number.parseInt(
    (await agentGit.raw(['rev-list', '--count', `${baseCommit}..HEAD`])).trim(),
    10,
  );
  if (ahead > 0 && !force) {
    throw new StriartError(
      `Le clone de "${name}" porte des commits absents du main courant : les réécrire les perdrait. Merge d'abord, ou --force pour les abandonner.`,
      { code: 'REUSE_UNMERGED', details: { name, dest, baseCommit } },
    );
  }

  const taskId = randomUUID().slice(0, 8);
  const branch = `striart/${name}/task-${taskId}`;
  // -f : en force, le travail non commité est volontairement écrasé (refusé
  // plus haut sinon). Les untracked survivent — jamais de clean ici.
  await agentGit.raw(['checkout', '-f', '-B', branch, baseCommit]);

  // Les exclusions de secrets suivent la CONFIG COURANTE, pas celle du
  // premier clonage (elle a pu changer entre-temps).
  let secretsExcluded = [];
  if (secretPatterns && secretPatterns.length > 0) {
    secretsExcluded = await excludeTrackedSecrets(agentGit, secretPatterns);
  } else {
    // Plus de motifs : lever un éventuel sparse-checkout hérité de l'ancienne
    // vie du clone (sinon des fichiers resteraient invisibles sans raison).
    await agentGit.raw(['sparse-checkout', 'disable']).catch(() => {});
  }

  await syncMemoryToClone(root, dest);

  // Un clone partiel (promisor) le reste : on relit le filtre depuis sa
  // config plutôt que d'inventer une valeur (l'entrée de registre d'origine
  // a disparu au stop).
  const partialFilter =
    (
      await agentGit.raw(['config', '--get', 'remote.origin.partialclonefilter']).catch(() => '')
    ).trim() || null;

  registry[name] = {
    branch,
    taskId,
    path: dest,
    baseCommit,
    prompt,
    predictedFiles,
    command,
    cloneFilter: partialFilter,
    secretsExcluded,
    mode,
    profile,
    reused: true,
    createdAt: new Date().toISOString(),
  };
  await writeRegistry(root, registry);
  await syncLocks(root, registry);

  return { name, ...registry[name] };
}

/** Fenêtre de présence par défaut si la config est illisible. */
const DEFAULT_PRESENCE_MINUTES = 10;

/**
 * Statistiques d'un clone : taille additionnelle totale (worktree + .git),
 * mais activité mesurée sur le WORKTREE SEUL. Striart écrit lui-même dans
 * .git en continu (fetch silencieux du watch, status…) : l'inclure rendrait
 * tous les clones "occupés" à perpétuité. Ce qui signale une session de
 * coding, ce sont les écritures de fichiers de travail.
 * @returns {Promise<{sizeBytes: number, workActivityMs: number}>}
 */
async function cloneStats(clonePath) {
  let sizeBytes = 0;
  let workActivityMs = 0;
  const entries = await readdir(clonePath, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const p = path.join(clonePath, entry.name);
    if (entry.isSymbolicLink()) continue;
    const sub = entry.isDirectory()
      ? await dirStats(p)
      : await stat(p).then(
          (s) => ({ sizeBytes: s.nlink <= 1 ? s.size : 0, latestMtimeMs: s.mtimeMs }),
          () => null,
        );
    if (!sub) continue;
    sizeBytes += sub.sizeBytes;
    // .git : Striart y écrit en continu (fetch, status). CLONE_MEMORY_FILE :
    // écrit par Striart aussi (mémoire partagée) — ni l'un ni l'autre ne
    // signale une session de coding.
    if (entry.name !== '.git' && entry.name !== CLONE_MEMORY_FILE)
      workActivityMs = Math.max(workActivityMs, sub.latestMtimeMs);
  }
  return { sizeBytes, workActivityMs };
}

/** La config est lue best effort — un état consultable ne doit jamais échouer sur elle. */
async function presenceWindowMs(root) {
  try {
    const { loadConfig } = await import('./config.js');
    return (await loadConfig(root)).presenceMinutes * 60_000;
  } catch {
    return DEFAULT_PRESENCE_MINUTES * 60_000;
  }
}

/**
 * État de chaque agent enregistré : branche courante, HEAD, nombre de
 * commits en attente de merge (depuis baseCommit), et PRÉSENCE DE SESSION —
 * activité disque du clone (écriture worktree ou .git) dans la fenêtre
 * `presenceMinutes`. Signal volontairement conservateur : tout process qui
 * écrit dans le clone (éditeur, agent de coding, npm install) compte.
 */
export async function listAgents(root) {
  await assertInitialized(root);
  const registry = await readRegistry(root);
  const presenceMs = await presenceWindowMs(root);
  const agents = [];

  for (const [name, meta] of Object.entries(registry)) {
    const exists = await stat(meta.path).catch(() => null);
    if (!exists) {
      agents.push({
        name,
        ...meta,
        status: 'MISSING',
        head: null,
        pendingCommits: 0,
        lastMessage: null,
      });
      continue;
    }

    const git = simpleGit(meta.path);
    // Les commits "en attente" sont comptés depuis le dernier merge réussi.
    const mergeBase = meta.lastMergedCommit ?? meta.baseCommit;
    try {
      const [currentBranch, head, count, log] = await Promise.all([
        git.revparse(['--abbrev-ref', 'HEAD']),
        git.revparse(['HEAD']),
        git.raw(['rev-list', '--count', `${mergeBase}..HEAD`]),
        git.log({ maxCount: 1 }),
      ]);
      const { sizeBytes, workActivityMs } = await cloneStats(meta.path);
      agents.push({
        name,
        ...meta,
        status: 'ACTIVE',
        currentBranch: currentBranch.trim(),
        head: head.trim(),
        pendingCommits: Number.parseInt(count.trim(), 10),
        lastMessage: log.latest?.message ?? null,
        sizeBytes,
        lastActivity: workActivityMs > 0 ? new Date(workActivityMs).toISOString() : null,
        sessionActive: Date.now() - workActivityMs < presenceMs,
      });
    } catch (error) {
      agents.push({
        name,
        ...meta,
        status: 'BROKEN',
        head: null,
        pendingCommits: 0,
        lastMessage: error.message,
      });
    }
  }

  return agents;
}

/**
 * Un agent actif est "au repos" si tout son travail est mergé (HEAD ==
 * dernier merge) ET son worktree propre — le supprimer ne perd rien.
 */
async function agentHasPendingWork(meta) {
  const agentGit = simpleGit(meta.path);
  const head = (await agentGit.revparse(['HEAD'])).trim();
  const lastMerged = meta.lastMergedCommit ?? meta.baseCommit;
  if (head !== lastMerged) return true;
  return !(await agentGit.status()).isClean();
}

/**
 * Supprime des clones pour récupérer l'espace disque.
 *
 * Par défaut (mode --stopped) : uniquement les clones d'agents ARRÊTÉS
 * (absents du registre) — un agent actif n'est jamais touché (règle d'or n°3).
 *
 * `all: true` : les agents actifs SANS travail en attente (tout mergé,
 * worktree propre) sont aussi arrêtés puis supprimés ; ceux qui ont du
 * travail non mergé sont ignorés (raison PENDING), sauf `force: true` qui
 * assume l'abandon. Un clone verrouillé par une session ouverte (EBUSY/
 * EPERM) est ignoré avec la raison BUSY — garde-fou naturel en attendant
 * la détection de présence (backlog V2).
 *
 * `sessionEnded: true` (mode autonome uniquement) : le contrôle de PRÉSENCE
 * est sauté. Ce n'est pas un contournement de la règle d'or n°3 — c'est une
 * meilleure information. La présence est une heuristique d'activité disque qui
 * *approxime* « un process travaille peut-être encore ici » ; quand Striart a
 * lui-même lancé le process et constaté sa sortie, il connaît la réponse
 * exacte, et l'approximation est périmée (le worktree vient forcément d'être
 * écrit, donc elle dirait toujours IN_USE). Le contrôle PENDING, lui, reste
 * appliqué : c'est le garde-fou qui protège réellement du travail non mergé.
 *
 * Une session autonome VIVANTE (PID au registre, process encore là) bloque la
 * suppression même avec `force` — seul garde-fou non contournable. `force`
 * existe pour passer outre des HEURISTIQUES (activité disque, travail en
 * cours) en connaissance de cause ; ici il ne s'agit pas d'une supposition
 * mais d'un fait vérifié, et supprimer des fichiers sous un process qui écrit
 * détruit son travail en plus de risquer de laisser le clone en vrac.
 * L'utilisateur doit d'abord arrêter la session.
 *
 * @param {{root: string, agent?: string|null, all?: boolean, force?: boolean, sessionEnded?: boolean}} params
 * @returns {Promise<{removed: Array<{name: string, freedBytes: number, wasActive: boolean}>, skipped: Array<{name: string, reason: 'ACTIVE'|'PENDING'|'IN_USE'|'BUSY'|'SESSION_LIVE'}>}>}
 */
export async function cleanClones(params) {
  return withMainLock(
    params.root,
    `clean:${params.agent ?? (params.all ? 'all' : 'stopped')}`,
    () => cleanClonesImpl(params),
  );
}

async function cleanClonesImpl({
  root,
  agent = null,
  all = false,
  force = false,
  sessionEnded = false,
}) {
  await assertInitialized(root);
  const dir = agentsDir(root);
  const presenceMs = await presenceWindowMs(root);
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);

  const removed = [];
  const skipped = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (agent && entry.name !== agent) continue;

    const registry = await readRegistry(root); // relu : les retraits précédents comptent
    const meta = registry[entry.name];
    const wasActive = Boolean(meta);

    if (wasActive) {
      // Session autonome en cours : fait vérifié, pas heuristique. `force` ne
      // passe pas outre (voir la doc de cleanClones).
      if (isProcessAlive(meta.sessionPid)) {
        skipped.push({ name: entry.name, reason: 'SESSION_LIVE' });
        continue;
      }
      if (!all) {
        skipped.push({ name: entry.name, reason: 'ACTIVE' });
        continue;
      }
      if (!force && (await agentHasPendingWork(meta).catch(() => true))) {
        skipped.push({ name: entry.name, reason: 'PENDING' });
        continue;
      }
    }

    const clonePath = path.join(dir, entry.name);
    // Présence de session (règle d'or n°3) : activité récente du WORKTREE =
    // quelqu'un travaille peut-être encore dedans. --force assume le risque.
    const { sizeBytes: freedBytes, workActivityMs } = await cloneStats(clonePath);
    if (!force && !sessionEnded && Date.now() - workActivityMs < presenceMs) {
      skipped.push({ name: entry.name, reason: 'IN_USE' });
      continue;
    }
    try {
      await rm(clonePath, { recursive: true, force: true, maxRetries: 5 });
    } catch (error) {
      // Un process (session de coding ouverte ?) verrouille le dossier.
      skipped.push({ name: entry.name, reason: 'BUSY' });
      continue;
    }
    if (wasActive) await removeAgentFromRegistry(root, entry.name);
    removed.push({ name: entry.name, freedBytes, wasActive });
  }

  if (agent && removed.length === 0 && skipped.length === 0) {
    throw new StriartError(`Aucun clone trouvé pour "${agent}".`, {
      code: 'CLONE_NOT_FOUND',
      details: { agent },
    });
  }
  return { removed, skipped };
}

/** @deprecated alias historique de cleanClones (mode --stopped). */
export const cleanStoppedClones = cleanClones;

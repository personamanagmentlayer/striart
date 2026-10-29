import { mkdir, readdir, readFile, stat, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { simpleGit } from 'simple-git';
import { StriartError, agentUnknownError } from './errors.ts';
import {
  assertSecretPatternSyntax,
  compileSecretPattern,
  secretPatternMatches,
} from './secret-patterns.ts';
import { AGENT_NAME_RE, validateAgentName } from './agent-name.ts';
import {
  UNCHANGED,
  readJson,
  removeTreeWithBackoff,
  updateJsonLocked,
  writeJsonAtomic,
} from './json-file.ts';
import { logger } from './logger.ts';
import { withStateLock } from './state-lock.ts';
import type { AgentMeta, AgentRegistry } from './types.js';
import { agentsDir, striartDir } from './paths.ts';
import { syncLocks } from './locks.ts';
import { withMainLock } from './lock.ts';
import { CLONE_MEMORY_FILE, syncMemoryToClone } from './memory.ts';
import { cloneDiskSize, cloneWorkScan } from './clone-disk.ts';
import { createSizeCache } from './clone-size-cache.ts';
import { syncAgentInstructionsToClone } from './agents/instructions.ts';
import { releaseAgentArtifacts } from './agent-artifacts.ts';
import { isProcessAlive } from './process-tree.ts';
import { ptyHostStatus } from './pty-host-state.ts';

// Ré-export : les modules historiques importent ces helpers depuis clone.js.
export { agentsDir, striartDir } from './paths.ts';

/** Séparateur des sorties git -z. */
const NUL_BYTE = String.fromCharCode(0);

function registryPath(root) {
  return path.join(striartDir(root), 'agents.json');
}

export { validateAgentName } from './agent-name.ts';

/**
 * Instance git BORNÉE au clone d'un agent. Un clone vit sous la racine du
 * dépôt principal (`.striart/agents/<nom>`) : si son `.git` manque ou est
 * corrompu, git remonterait l'arborescence et opérerait en silence sur le
 * DÉPÔT PRINCIPAL (un `stash` ou un `rebase` destiné au clone viserait le
 * principal). GIT_CEILING_DIRECTORIES interdit cette remontée : un clone
 * cassé échoue franchement (« not a git repository »).
 *
 * Le plafond ne borne que la DÉCOUVERTE : un dépôt désigné par
 * l'environnement (GIT_DIR, GIT_WORK_TREE… hérités d'un hook git, d'un
 * `rebase --exec` ou d'un IDE) l'emporterait sur le cwd. AUCUNE variable
 * `GIT_*` héritée n'est donc transmise : le clone est désigné par son
 * chemin, et par rien d'autre. C'est aussi la règle de simple-git 4, qui
 * retire les `GIT_*` ambiantes et REFUSE d'en recevoir une explicitement hors
 * `allowEnvironment` — d'où l'autorisation nominative du seul plafond.
 *
 * Toute commande git visant un clone passe par ici, jamais par
 * `simpleGit(meta.path)` directement.
 * @param {string} clonePath
 */
export function cloneGit(clonePath: string) {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value !== undefined && !isUnsafeCloneEnv(name)) env[name] = value;
  }
  env.GIT_CEILING_DIRECTORIES = path.dirname(path.resolve(clonePath));
  return simpleGit(clonePath, {
    allowEnvironment: ['GIT_CEILING_DIRECTORIES'],
    // La config d'un clone est ÉCRIVABLE par l'agent : `core.hooksPath` et
    // `core.fsmonitor` y font exécuter un programme de son choix à la prochaine
    // commande git de Striart (commit, rebase, status…), avec les droits de
    // l'utilisateur et hors de toute session surveillée. Neutralisés pour toute
    // commande sur un clone (les hooks git d'un clone n'ont aucun rôle dans
    // Striart ; fsmonitor n'est qu'une optimisation).
    config: ['core.hooksPath=', 'core.fsmonitor=false'],
    unsafe: { allowUnsafeHooksPath: true, allowUnsafeFsMonitor: true },
  }).env(env);
}

/**
 * Hors `GIT_*`, variables qui font exécuter un programme arbitraire à git
 * (éditeur, pager, askpass). Les opérations sur un clone (fetch par chemin
 * local, rebase, stash, status, log) n'en ont jamais besoin. VISUAL :
 * GHSA-v5rq-49vh-5v5c.
 */
const UNSAFE_NON_GIT_ENV = new Set(['editor', 'visual', 'pager', 'prefix', 'ssh_askpass']);

/** @param {string} name */
function isUnsafeCloneEnv(name) {
  const lower = name.toLowerCase();
  return lower.startsWith('git_') || UNSAFE_NON_GIT_ENV.has(lower);
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
      hint: 'git init',
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
      hint: 'striart init',
      details: { root },
    });
  }
}

export async function readRegistry(root: string): Promise<AgentRegistry> {
  return readJson(registryPath(root), { fallback: {}, code: 'REGISTRY_CORRUPT' });
}

/**
 * Lecture-modification-écriture du registre sous le verrou d'état
 * (state-lock.js) : le process d'une session autonome publie `sessionPid`
 * HORS du verrou principal pendant que `watch` écrit sous ce verrou — sans
 * exclusion commune, l'une des deux écritures était perdue.
 *
 * `syncLocks: true` (ajout/retrait d'agent) : locks.json est reconstruit DANS
 * la même section, depuis le registre qui vient d'être écrit — jamais depuis
 * un instantané périmé.
 * @param {string} root
 * @param {(registry: import('./types.js').AgentRegistry) => import('./types.js').AgentRegistry | typeof UNCHANGED} mutator
 * @param {{syncLocks?: boolean}} [options]
 * @returns {Promise<import('./types.js').AgentRegistry>}
 */
async function updateRegistry(root, mutator, { syncLocks: resyncLocks = false } = {}) {
  return withStateLock(striartDir(root), async () => {
    let changed = false;
    const registry = await updateJsonLocked(
      registryPath(root),
      { fallback: {}, code: 'REGISTRY_CORRUPT' },
      (current) => {
        const next = mutator(current);
        changed = next !== UNCHANGED;
        return next;
      },
    );
    if (resyncLocks && changed) await syncLocks(root, registry);
    return registry;
  });
}

/** @param {string} root @param {string} name @param {Partial<import('./types.js').AgentMeta>} patch @returns {Promise<import('./types.js').AgentMeta>} */
export async function updateAgentMeta(root, name, patch) {
  const registry = await updateRegistry(root, (current) => {
    if (!current[name]) throw agentUnknownError(name);
    current[name] = { ...current[name], ...patch };
    return current;
  });
  return registry[name];
}

/**
 * Mise à jour CONDITIONNELLE : `patch` n'est appliqué que si chaque champ de
 * `expect` vaut encore, sous le verrou d'état et au moment de l'écriture, la
 * valeur attendue (comparaison stricte, absent ≡ null). Sert aux décisions
 * prises sur une lecture antérieure — la réconciliation qui efface un
 * `sessionPid` jugé mort ne doit jamais effacer celui qu'une nouvelle
 * session vient de publier. Agent absent : rien n'est appliqué, sans erreur
 * (la condition est fausse).
 * @param {string} root @param {string} name
 * @param {Partial<import('./types.js').AgentMeta>} expect
 * @param {Partial<import('./types.js').AgentMeta>} patch
 * @returns {Promise<{applied: boolean, meta: import('./types.js').AgentMeta | null}>}
 */
export async function compareAndUpdateAgentMeta(root, name, expect, patch) {
  let applied = false;
  const registry = await updateRegistry(root, (current) => {
    const meta = current[name];
    if (!meta) return UNCHANGED;
    for (const [field, value] of Object.entries(expect)) {
      if ((meta[field] ?? null) !== (value ?? null)) return UNCHANGED;
    }
    current[name] = { ...meta, ...patch };
    applied = true;
    return current;
  });
  return { applied, meta: registry[name] ?? null };
}

/**
 * Retire l'agent du registre. Le clone sur disque n'est JAMAIS supprimé
 * ici (règle d'or n°3) : le cleanup physique est une décision humaine.
 */
export async function removeAgentFromRegistry(root, name) {
  await updateRegistry(
    root,
    (current) => {
      if (!current[name]) throw agentUnknownError(name);
      delete current[name];
      return current;
    },
    { syncLocks: true },
  );
}

/**
 * Inscrit un agent neuf au registre (création ou réhabilitation). La
 * présence est revérifiée SOUS le verrou d'état : jamais deux inscriptions
 * du même nom, même si le registre lu en début d'opération a vieilli.
 * @param {string} root @param {string} name @param {import('./types.js').AgentMeta} meta
 */
async function registerAgent(root, name, meta) {
  cloneSizeCache.invalidate(meta.path); // clone neuf ou réhabilité : aucune taille d'une vie antérieure
  await updateRegistry(
    root,
    (current) => {
      if (current[name]) {
        throw new StriartError(`L'agent "${name}" existe déjà (${meta.path}).`, {
          code: 'AGENT_EXISTS',
          hint: 'striart status',
          details: { name, path: meta.path },
        });
      }
      current[name] = meta;
      return current;
    },
    { syncLocks: true },
  );
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
 * Sémantique gitignore complète (`/.env`, `secrets/`, `**` …) : l'ensemble exclu
 * est calculé par git lui-même, puis vérifié après le sparse-checkout.
 * @param {import('simple-git').SimpleGit} agentGit
 * @param {string[]} patterns
 * @returns {Promise<string[]>} fichiers exclus du worktree
 */
async function excludeTrackedSecrets(agentGit, patterns) {
  if (!patterns || patterns.length === 0) return [];
  for (const pattern of patterns) assertSecretPatternSyntax(pattern);
  // L'ensemble exclu est calculé PAR GIT (UNIQUEMENT nos motifs : ni .gitignore
  // ni négation du dépôt ne peuvent les contredire), donc par le même moteur
  // gitignore que le sparse-checkout appliqué ensuite — jamais par une
  // réimplémentation JS qui pourrait diverger et laisser un secret en place.
  const raw = await agentGit.raw([
    '--literal-pathspecs',
    'ls-files',
    '-z',
    '--cached',
    '--ignored',
    ...patterns.map((p) => `--exclude=${p}`),
  ]);
  const excluded = raw.split(NUL_BYTE).filter(Boolean);
  if (excluded.length === 0) return [];
  await agentGit.raw([
    'sparse-checkout',
    'set',
    '--no-cone',
    '--',
    '/*',
    ...patterns.map((p) => `!${p}`),
  ]);
  await assertSkipWorktree(agentGit, excluded);
  return excluded;
}

/**
 * Vérifie, une fois le sparse-checkout appliqué, que CHAQUE fichier à exclure
 * porte bien le bit SKIP_WORKTREE (étiquette `S` de `ls-files -v`) : un motif
 * que le sparse-checkout lirait autrement que `ls-files --exclude` ne doit
 * jamais laisser un secret sur le disque en silence (fail closed).
 * @param {import('simple-git').SimpleGit} agentGit @param {string[]} excluded
 */
async function assertSkipWorktree(agentGit, excluded) {
  const CHUNK = 200;
  const exposed = [];
  for (let i = 0; i < excluded.length; i += CHUNK) {
    const raw = await agentGit.raw([
      '--literal-pathspecs',
      'ls-files',
      '-z',
      '-v',
      '--',
      ...excluded.slice(i, i + CHUNK),
    ]);
    for (const entry of raw.split(NUL_BYTE).filter(Boolean)) {
      if (!/^[Ss] /.test(entry)) exposed.push(entry.slice(2));
    }
  }
  if (exposed.length > 0) {
    throw new StriartError(
      `le sparse-checkout n'a pas masqué ${exposed.length} fichier(s) de secrets (${exposed.slice(0, 5).join(', ')})`,
      { code: 'SECRETS_EXCLUSION_FAILED', details: { count: exposed.length } },
    );
  }
}

/**
 * Recherche dans TOUT l'historique du repo principal (toutes refs, y compris
 * les commits qui ont depuis supprimé le fichier) des chemins qui ont un
 * jour existé et matchent `secretPatterns`.
 *
 * Angle mort de `excludeTrackedSecrets` : le sparse-checkout ne masque que le
 * WORKTREE courant d'un clone. Les objets `.git/`, eux, sont hardlinkés en
 * entier (décision d'architecture n°1) — un agent peut trivialement lire un
 * secret historique via `git show <sha>:<fichier>` ou `git log -p`, même
 * absent du disque aujourd'hui. Ce scan est la seule façon de savoir AVANT
 * de cloner si ce risque existe pour ce repo.
 *
 * Lecture : `-z` + `core.quotePath=false` (un nom non ASCII n'est jamais
 * rendu entre guillemets avec des octaux), `--no-renames` (un renommage vers
 * un nom de secret apparaît comme un ajout, il n'est pas filtré en `R`).
 * @param {string} root @param {string[]} patterns
 * @returns {Promise<string[]>} chemins historiques matchant, triés
 */
export async function scanHistoricalSecrets(root, patterns) {
  if (!patterns || patterns.length === 0) return [];
  const matchers = patterns.map(compileSecretPattern);
  const raw = await simpleGit(root).raw([
    '-c',
    'core.quotePath=false',
    'log',
    '--all',
    '--pretty=format:',
    '--name-only',
    '-z',
    '--no-renames',
    '--diff-filter=A',
  ]);
  // Avec -z les noms sont séparés par NUL ; un saut de ligne en tête d'entrée
  // n'est qu'un séparateur de commit (un nom de fichier ne le commence pas en pratique).
  const paths = new Set(
    raw
      .split(NUL_BYTE)
      .map((entry) => entry.replace(/^\n+/, ''))
      .filter(Boolean),
  );
  return [...paths]
    .filter((file) => matchers.some((matcher) => secretPatternMatches(matcher, file)))
    .sort();
}

/**
 * Fail closed : un secret qui a existé un jour dans l'historique reste
 * lisible par l'agent via `git show <sha>:<fichier>` (les objets sont
 * hardlinkés en entier, décision n°1) même si sparse-checkout le masque du
 * worktree courant — ce n'est pas une dégradation qu'on laisse passer en
 * silence. Seul `allowHistoricalSecrets` (décision consciente) l'écarte.
 * @param {string} root @param {string} name @param {string[]|null} secretPatterns
 */
async function assertNoHistoricalSecrets(root, name, secretPatterns) {
  if (!secretPatterns || secretPatterns.length === 0) return;
  const historical = await scanHistoricalSecrets(root, secretPatterns);
  if (historical.length === 0) return;
  throw new StriartError(
    `Secrets historiques détectés dans ce repo (${historical.join(', ')}) : un agent pourrait ` +
      "les lire via l'historique git de son clone, même si sparse-checkout les masque du " +
      'worktree. Vérifie ou révoque ces secrets, puis relance avec --allow-historical-secrets ' +
      '(décision consciente), ou mets secretPatterns: [] pour désactiver ce contrôle.',
    {
      code: 'HISTORICAL_SECRETS_FOUND',
      hint: 'striart doctor',
      details: { name, patterns: secretPatterns, historical },
    },
  );
}

/**
 * Supprime le dossier d'un clone dont la création a échoué avant son inscription
 * au registre. Un échec de suppression est journalisé (le dossier orphelin est
 * signalé par `status`, retiré par `clean`), jamais tu.
 * @param {string} dest @param {string} name @param {string} stage
 */
async function discardPartialClone(dest, name, stage) {
  await removeTreeWithBackoff(dest).catch((rmError) => {
    logger.warn(
      { err: rmError.code ?? rmError.message, agent: name, path: dest },
      `Clone incomplet non supprimé après l'échec ${stage}`,
    );
  });
}

/**
 * HEAD du repo principal, ou EMPTY_REPO s'il n'a aucun commit (source unique :
 * création et réutilisation d'un clone).
 * @param {import('simple-git').SimpleGit} mainGit @param {string} root
 */
async function readMainHeadOrRefuse(mainGit, root) {
  try {
    return (await mainGit.revparse(['HEAD'])).trim();
  } catch {
    throw new StriartError(
      'Le repo principal ne contient aucun commit. Crée au moins un commit avant de démarrer un agent.',
      {
        code: 'EMPTY_REPO',
        hint: 'git commit --allow-empty -m "chore: initial commit"',
        details: { root },
      },
    );
  }
}

export async function createAgent(params: {
  root: string;
  name: string;
  prompt?: string | null;
  predictedFiles?: string[];
  command?: string | null;
  cloneFilter?: string | null;
  secretPatterns?: string[] | null;
  mode?: 'attended' | 'autonomous';
  profile?: string | null;
  allowHistoricalSecrets?: boolean;
  signal?: AbortSignal | null;
}): Promise<AgentMeta & { name: string }> {
  // `signal` n'annule que l'ATTENTE du verrou, jamais un clonage commencé.
  return withMainLock(params.root, `start:${params.name}`, () => createAgentImpl(params), {
    signal: params.signal ?? null,
  });
}

/** @param {{root: string, name: string, prompt?: string|null, predictedFiles?: string[], command?: string|null, cloneFilter?: string|null, secretPatterns?: string[]|null, mode?: 'attended'|'autonomous', profile?: string|null, allowHistoricalSecrets?: boolean}} params */
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
  allowHistoricalSecrets = false,
}: {
  root: string;
  name: string;
  prompt?: string | null;
  predictedFiles?: string[];
  command?: string | null;
  cloneFilter?: string | null;
  secretPatterns?: string[] | null;
  mode?: 'attended' | 'autonomous';
  profile?: string | null;
  allowHistoricalSecrets?: boolean;
}): Promise<AgentMeta & { name: string }> {
  validateAgentName(name);
  await assertInitialized(root);

  const dest = path.join(agentsDir(root), name);
  await assertNoPendingRemoval(root, name, dest);
  const registry = await readRegistry(root);

  if (registry[name] || (await stat(dest).catch(() => null))) {
    throw new StriartError(`L'agent "${name}" existe déjà (${dest}).`, {
      code: 'AGENT_EXISTS',
      hint: `striart start ${name} --reuse`,
      details: { name, path: dest },
    });
  }

  const mainGit = simpleGit(root);
  const baseCommit = await readMainHeadOrRefuse(mainGit, root);

  // Scanné AVANT de cloner (mêmes objets, hardlinkés — inutile de créer le
  // clone pour découvrir qu'on doit le jeter).
  if (!allowHistoricalSecrets) await assertNoHistoricalSecrets(root, name, secretPatterns);

  await mkdir(agentsDir(root), { recursive: true });

  const taskId = randomUUID().slice(0, 8);
  const branch = `striart/${name}/task-${taskId}`;

  try {
    // Chemin local (pas file://) : git hardlinke les objets immuables — le
    // clone est quasi instantané et l'historique ne coûte qu'une fois.
    await simpleGit().clone(root, dest, cloneFilter ? [`--filter=${cloneFilter}`] : []);
    const agentGit = cloneGit(dest);
    await agentGit.checkoutLocalBranch(branch);
    if (cloneFilter) {
      // Clone partiel : origin doit rester comme promisor pour les blobs à la
      // demande. Fetch-only : le push est neutralisé (règle d'or n°1).
      await agentGit.raw(['remote', 'set-url', '--push', 'origin', 'push-disabled://striart']);
    } else {
      await agentGit.removeRemote('origin');
    }
  } catch (error) {
    // Un clone partiel ne survit pas : sans entrée au registre, rien ne le
    // retirerait et le nom serait inutilisable (AGENT_EXISTS).
    await discardPartialClone(dest, name, 'du clonage');
    throw new StriartError(`Échec du clonage de l'agent "${name}" : ${error.message}`, {
      code: 'CLONE_FAILED',
      hint: 'striart doctor',
      details: { name, dest, cause: error.message },
    });
  }

  // Question ouverte n°4 tranchée : les secrets trackés sont retirés du
  // worktree du clone. Échec = échec — une mesure de sécurité ne se dégrade
  // pas en silence (le clone incomplet est supprimé).
  let secretsExcluded;
  try {
    secretsExcluded = await excludeTrackedSecrets(cloneGit(dest), secretPatterns ?? []);
  } catch (error) {
    await removeTreeWithBackoff(dest).catch((rmError) => {
      // Jamais inscrit au registre : un reliquat de clone n'est qu'un
      // dossier orphelin, signalé (status le montrera, clean le retirera).
      logger.warn(
        { err: rmError.code ?? rmError.message, agent: name, path: dest },
        'Clone incomplet non supprimé après échec de l’exclusion des secrets',
      );
    });
    throw new StriartError(
      `Exclusion des secrets impossible pour l'agent "${name}" (git 2.35+ requis pour sparse-checkout --no-cone) : ${error.message}. ` +
        'Mets git à jour, ou désactive explicitement avec secretPatterns: [] dans striart.config.',
      {
        code: 'SECRETS_EXCLUSION_FAILED',
        hint: 'git --version',
        details: { name, cause: error.message },
      },
    );
  }

  // Memory Layer : le nouvel agent démarre avec la connaissance des merges
  // passés (no-op si la mémoire n'existe pas encore).
  await syncMemoryToClone(root, dest);

  const meta: AgentMeta = {
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
  try {
    await registerAgent(root, name, meta);
  } catch (error) {
    // Clone créé mais jamais inscrit : le retirer, sinon il bloque le nom.
    await discardPartialClone(dest, name, "de l'inscription au registre");
    throw error;
  }
  // Consignes Striart (lot I5) : fichier non suivi, exclu localement, au nom
  // que lit l'outil supervisé. Advisory — avertit, ne fait jamais échouer.
  await syncAgentInstructionsToClone({ root, agent: name, clonePath: dest, mode, command });

  return { name, ...meta };
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
 * Deux consentements DISTINCTS, jamais confondus : `force` accepte de perdre
 * du travail (les trois gardes ci-dessus) ; `allowHistoricalSecrets` accepte
 * qu'un agent puisse lire un secret présent dans l'historique. L'un
 * n'implique pas l'autre : un `--force` donné pour abandonner un brouillon
 * ne lève pas en silence le contrôle des secrets.
 *
 */
export async function reuseAgent(params: {
  root: string;
  name: string;
  prompt?: string | null;
  predictedFiles?: string[];
  command?: string | null;
  secretPatterns?: string[] | null;
  mode?: 'attended' | 'autonomous';
  profile?: string | null;
  force?: boolean;
  allowHistoricalSecrets?: boolean;
  signal?: AbortSignal | null;
}): Promise<AgentMeta & { name: string }> {
  // `signal` n'annule que l'ATTENTE du verrou, jamais une réhabilitation commencée.
  return withMainLock(params.root, `reuse:${params.name}`, () => reuseAgentImpl(params), {
    signal: params.signal ?? null,
  });
}

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
  allowHistoricalSecrets = false,
}: {
  root: string;
  name: string;
  prompt?: string | null;
  predictedFiles?: string[];
  command?: string | null;
  secretPatterns?: string[] | null;
  mode?: 'attended' | 'autonomous';
  profile?: string | null;
  force?: boolean;
  allowHistoricalSecrets?: boolean;
}): Promise<AgentMeta & { name: string }> {
  validateAgentName(name);
  await assertInitialized(root);

  const registry = await readRegistry(root);
  if (registry[name]) {
    throw new StriartError(
      `L'agent "${name}" est encore actif : --reuse ne réhabilite qu'un clone ARRÊTÉ. Merge/stop d'abord.`,
      { code: 'AGENT_EXISTS', hint: `striart stop ${name}`, details: { name } },
    );
  }
  const dest = path.join(agentsDir(root), name);
  await assertNoPendingRemoval(root, name, dest);
  if (!(await stat(dest).catch(() => null))) {
    throw new StriartError(
      `Aucun clone à réutiliser pour "${name}" (${dest}). Utilise striart start sans --reuse.`,
      { code: 'REUSE_NO_CLONE', hint: `striart start ${name}`, details: { name, dest } },
    );
  }

  // Les exclusions suivent la config COURANTE (voir plus bas) : un motif
  // ajouté depuis le premier clonage doit être vérifié ici aussi, pas
  // seulement au prochain "start" à froid.
  if (!allowHistoricalSecrets) await assertNoHistoricalSecrets(root, name, secretPatterns);

  // Hôte de terminal vivant (`--open`) : son shell a ce clone pour répertoire
  // courant — fait vérifié, comme pour cleanClones : même `force` ne passe pas
  // outre. Un état d'hôte impossible à établir lève (fail closed).
  if ((await ptyHostStatus(root, name)).running) {
    throw new StriartError(
      `Un terminal est ouvert sur le clone de "${name}" (hôte de pty vivant) : le réhabiliter écraserait son répertoire de travail. Ferme-le (striart attach, puis exit) avant de réutiliser ce clone.`,
      { code: 'SESSION_LIVE', hint: `striart attach ${name}`, details: { name, dest } },
    );
  }

  // Présence : une archive qui vient d'écrire sur disque héberge peut-être
  // encore un process. Heuristique mtime — force explicite pour passer outre.
  const workActivityMs = await cloneWorkActivityMs(dest);
  if (Date.now() - workActivityMs < (await presenceWindowMs(root)) && !force) {
    throw new StriartError(
      `Le clone de "${name}" a une activité disque récente (IN_USE). Vérifie qu'aucun process n'y travaille, ou --force.`,
      {
        code: 'REUSE_IN_USE',
        hint: `striart start ${name} --reuse --force`,
        details: { name, dest },
      },
    );
  }

  const agentGit = cloneGit(dest);
  // « Sale » = changements sur des fichiers TRACKÉS. Les untracked ne
  // comptent pas : ils survivent au reuse (c'est même son intérêt — repartir
  // avec node_modules et l'outillage local en place).
  const status = await agentGit.status();
  const dirty = status.files.some((f) => f.index !== '?' || f.working_dir !== '?');
  if (dirty && !force) {
    throw new StriartError(
      `Le clone de "${name}" contient du travail non commité : le réutiliser le détruirait. Commit/stash d'abord, ou --force pour l'abandonner.`,
      {
        code: 'REUSE_DIRTY',
        hint: `git -C .striart/agents/${name} status`,
        details: { name, dest },
      },
    );
  }

  const mainGit = simpleGit(root);
  const baseCommit = await readMainHeadOrRefuse(mainGit, root);
  try {
    // Fetch par chemin local (mêmes propriétés que le clone initial) du seul
    // HEAD du principal : rien à nettoyer, aucune ref permanente créée.
    await agentGit.raw(['fetch', '--quiet', root, 'HEAD']);
  } catch (error) {
    throw new StriartError(`Resynchronisation de "${name}" impossible : ${error.message}`, {
      code: 'REUSE_FETCH_FAILED',
      hint: 'striart doctor',
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
      {
        code: 'REUSE_UNMERGED',
        hint: `git -C .striart/agents/${name} log --oneline -10`,
        details: { name, dest, baseCommit },
      },
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

  const meta: AgentMeta = {
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
  await registerAgent(root, name, meta);
  // Consignes Striart (lot I5) : fichier non suivi, exclu localement, au nom
  // que lit l'outil supervisé. Advisory — avertit, ne fait jamais échouer.
  await syncAgentInstructionsToClone({ root, agent: name, clonePath: dest, mode, command });

  return { name, ...meta };
}

/** Fenêtre de présence par défaut si la config est illisible. */
const DEFAULT_PRESENCE_MINUTES = 10;

/**
 * Activité du WORKTREE d'un clone — SIGNAL DE SÉCURITÉ (`sessionActive`, gardes
 * de `cleanClones` et de `reuseAgent`) : exact, JAMAIS mis en cache, fail closed
 * (une partie illisible = « actif »). Mesurée sur le worktree seul : Striart
 * écrit lui-même dans .git en continu (fetch silencieux du watch, status…),
 * l'inclure rendrait tous les clones « occupés » à perpétuité ; CLONE_MEMORY_FILE
 * est écrit par Striart aussi (mémoire partagée). Ce qui signale une session de
 * coding, ce sont les écritures de fichiers de travail. Ne parcourt pas .git.
 * @param {string} clonePath
 * @returns {Promise<number>}
 */
export async function cloneWorkActivityMs(clonePath) {
  return (await scanWorktree(clonePath)).workActivityMs;
}

/**
 * Même mesure exacte que `cloneWorkActivityMs`, mais DISTINGUE « illisible »
 * (`complete: false`, l'activité vaut alors « maintenant ») de « récent » :
 * le GC d'inactivité (src/idle/) range un worktree illisible en signal INCONNU
 * (fail closed, nommé), pas en activité fraîche.
 * @param {string} clonePath
 * @returns {Promise<{workActivityMs: number, complete: boolean}>}
 */
export async function cloneWorktreeActivity(clonePath) {
  const { workActivityMs, complete } = await scanWorktree(clonePath);
  return { workActivityMs, complete };
}

/** Parcours unique du worktree (activité exacte + octets, voir `cloneWorkScan`). */
function scanWorktree(clonePath) {
  return cloneWorkScan(clonePath, { skipTop: ['.git', CLONE_MEMORY_FILE] });
}

/**
 * Cache des tailles (décision D4) : la taille est de l'AFFICHAGE. Servie du
 * cache tant que l'entrée a moins de `CLONE_SIZE_TTL_MS` et que rien n'a bougé
 * (signature), ou moins de `CLONE_SIZE_MIN_REFRESH_MS` quoi qu'il arrive (borne
 * le coût d'un clone qui écrit en continu). L'horodatage de la mesure est
 * exposé (`sizesComputedAt`). `clean`/`prune`/`reuse` ne lisent jamais ce cache.
 */
export const CLONE_SIZE_TTL_MS = 300_000;
export const CLONE_SIZE_MIN_REFRESH_MS = 10_000;
const cloneSizeCache = createSizeCache({
  ttlMs: CLONE_SIZE_TTL_MS,
  minRefreshMs: CLONE_SIZE_MIN_REFRESH_MS,
});

/** Vide le cache des tailles (tests, bancs). */
export function clearCloneSizeCache() {
  cloneSizeCache.clear();
}

/**
 * Empreinte de ce qui fait varier la taille d'un clone, à coût de quelques
 * `stat` : activité du worktree (déjà mesurée, exacte), références, index et
 * dossier des packs. Un fait non couvert (écriture isolée dans .git) est borné
 * par le TTL.
 * @param {string} clonePath @param {number} workActivityMs
 */
async function sizeSignature(clonePath, workActivityMs) {
  const gitDir = path.join(clonePath, '.git');
  return [
    workActivityMs,
    (await refsSignature(clonePath)) ?? '-',
    await fileSig(path.join(gitDir, 'index')),
    await fileSig(path.join(gitDir, 'objects', 'pack')),
  ].join('|');
}

/**
 * Taille additionnelle d'un clone, depuis le cache si valide. Sur un échec de
 * cache, le worktree n'est PAS reparcouru : ses octets viennent du parcours
 * d'activité déjà fait (`scan`) ; seuls .git et le fichier de mémoire sont lus.
 * @param {string} clonePath @param {import('./clone-disk.ts').WorkScan} scan
 * @returns {Promise<{sizeBytes: number, computedAt: number}>}
 */
async function cachedCloneSize(clonePath, scan) {
  const sig = await sizeSignature(clonePath, scan.workActivityMs);
  return cloneSizeCache.get(clonePath, sig, async () => {
    const git = await cloneDiskSize(path.join(clonePath, '.git'));
    const memory = await stat(path.join(clonePath, CLONE_MEMORY_FILE)).then(
      (s) => ({ bytes: s.nlink <= 1 ? s.size : 0, complete: true }),
      (error) => ({ bytes: 0, complete: error.code === 'ENOENT' }),
    );
    return {
      sizeBytes: scan.bytes + git.sizeBytes + memory.bytes,
      complete: scan.complete && git.complete && memory.complete,
    };
  });
}

/** La config est lue best effort — un état consultable ne doit jamais échouer sur elle. */
async function presenceWindowMs(root) {
  try {
    const { loadConfig } = await import('./config.ts');
    return (await loadConfig(root)).presenceMinutes * 60_000;
  } catch {
    return DEFAULT_PRESENCE_MINUTES * 60_000;
  }
}

/**
 * Présence d'une session dans le clone, du signal le plus fort au plus
 * faible : un PID vivant est un FAIT (session autonome publiée au registre,
 * ou hôte de pty ouvert par `--open`) ; l'activité disque récente n'est
 * qu'un indice — un agent juste créé, que personne n'a encore lancé, n'est
 * pas « en cours ».
 * @param {string} root @param {string} name @param {import('./types.js').AgentMeta} meta
 * @param {boolean} recentActivity
 * @returns {Promise<import('./types.js').AgentSession>}
 */
async function readAgentSession(root, name, meta, recentActivity) {
  if (isProcessAlive(meta.sessionPid)) {
    return { state: 'running', via: 'autonomous', pid: meta.sessionPid };
  }
  const host = await ptyHostStatus(root, name);
  if (host.running) return { state: 'running', via: 'pty', pid: host.pid };
  return recentActivity
    ? { state: 'recent-activity', via: null, pid: null }
    : { state: 'idle', via: null, pid: null };
}

/**
 * Faits git d'un clone (branche, HEAD, commits en attente, dernier message),
 * mémoïsés par PROCESS. La collecte d'état du dashboard est refaite à chaque
 * changement et coûtait 4 process git par agent (≈ 1 s chacun sous Windows :
 * 50 agents = 20 à 50 s avant le premier rendu). La clé est la signature des
 * fichiers de références (inode, mtime, taille de `HEAD`, de la référence
 * qu'il désigne et de `packed-refs`) + la base de comptage : tout commit, reset
 * ou rebase la change. Une entrée n'est jamais crue plus de FACTS_TTL_MS, pour
 * que la détection d'un clone illisible (BROKEN) ne soit jamais retardée de
 * plus. Affichage seulement : aucune garde ne décide sur ces valeurs (`stopAgent`,
 * `cleanClones` relisent git eux-mêmes). Signature illisible → pas de cache.
 */
const FACTS_TTL_MS = 30_000;
/** @type {Map<string, {sig: string, at: number, facts: {currentBranch: string, head: string, pendingCommits: number, lastMessage: string|null}}>} */
const gitFactsCache = new Map();

/** @param {string} file */
async function fileSig(file) {
  const s = await stat(file).catch(() => null);
  return s ? `${s.ino}:${s.mtimeMs}:${s.size}` : '-';
}

/** @param {string} clonePath @returns {Promise<string|null>} */
async function refsSignature(clonePath) {
  try {
    const gitDir = path.join(clonePath, '.git');
    const headText = (await readFile(path.join(gitDir, 'HEAD'), 'utf8')).trim();
    const symbolic = headText.startsWith('ref: ') ? headText.slice(5) : null;
    const parts = [headText, await fileSig(path.join(gitDir, 'packed-refs'))];
    if (symbolic) parts.push(await fileSig(path.join(gitDir, ...symbolic.split('/'))));
    return parts.join('|');
  } catch {
    // .git illisible ou non standard (fichier gitdir:, reftable) : pas de signature, pas de cache.
    return null;
  }
}

/**
 * `openGit` n'est appelée qu'APRÈS le test de cache : un fait servi par le cache
 * ne fabrique aucune instance git (copie de l'environnement, config). La clé de
 * validité (signature des références + base + TTL) est inchangée.
 * @param {string} clonePath @param {string} mergeBase
 * @param {() => ReturnType<typeof cloneGit>} openGit
 */
async function readGitFacts(clonePath, mergeBase, openGit) {
  const signature = await refsSignature(clonePath);
  const key = clonePath;
  const sig = signature === null ? null : `${signature}|${mergeBase}`;
  const hit = gitFactsCache.get(key);
  if (sig !== null && hit && hit.sig === sig && Date.now() - hit.at < FACTS_TTL_MS)
    return hit.facts;
  const git = openGit();
  const [currentBranch, head, count, log] = await Promise.all([
    git.revparse(['--abbrev-ref', 'HEAD']),
    git.revparse(['HEAD']),
    git.raw(['rev-list', '--count', `${mergeBase}..HEAD`]),
    git.log({ maxCount: 1 }),
  ]);
  const facts = {
    currentBranch: currentBranch.trim(),
    head: head.trim(),
    pendingCommits: Number.parseInt(count.trim(), 10),
    lastMessage: log.latest?.message ?? null,
  };
  if (sig !== null) gitFactsCache.set(key, { sig, at: Date.now(), facts });
  else gitFactsCache.delete(key);
  return facts;
}

/** Clones inspectés simultanément par `listAgents` (4 process git chacun). */
const LIST_AGENTS_CONCURRENCY = 6;

/**
 * État de chaque agent enregistré : branche courante, HEAD, nombre de
 * commits en attente de merge (depuis baseCommit), et PRÉSENCE DE SESSION
 * (`session`, voir readAgentSession). `sessionActive` (activité disque du
 * clone dans la fenêtre `presenceMinutes`) reste exposé : c'est le signal
 * conservateur des gardes de nettoyage, où tout process qui écrit dans le
 * clone (éditeur, agent, npm install) doit compter.
 */
export async function listAgents(root) {
  await assertInitialized(root);
  const registry = await readRegistry(root);
  const presenceMs = await presenceWindowMs(root);
  /** @param {string} name @param {any} meta */
  const inspect = async (name, meta) => {
    const exists = await stat(meta.path).catch(() => null);
    if (!exists) {
      return {
        name,
        ...meta,
        status: 'MISSING',
        head: null,
        pendingCommits: 0,
        lastMessage: null,
        session: await readAgentSession(root, name, meta, false),
      };
    }

    // Les commits "en attente" sont comptés depuis le dernier merge réussi.
    const mergeBase = meta.lastMergedCommit ?? meta.baseCommit;
    try {
      const facts = await readGitFacts(meta.path, mergeBase, () => cloneGit(meta.path));
      const scan = await scanWorktree(meta.path);
      const workActivityMs = scan.workActivityMs;
      const size = await cachedCloneSize(meta.path, scan);
      const sessionActive = Date.now() - workActivityMs < presenceMs;
      return {
        name,
        ...meta,
        status: 'ACTIVE',
        currentBranch: facts.currentBranch,
        head: facts.head,
        pendingCommits: facts.pendingCommits,
        lastMessage: facts.lastMessage,
        sizeBytes: size.sizeBytes,
        sizesComputedAt: new Date(size.computedAt).toISOString(),
        lastActivity: workActivityMs > 0 ? new Date(workActivityMs).toISOString() : null,
        sessionActive,
        session: await readAgentSession(root, name, meta, sessionActive),
      };
    } catch (error) {
      return {
        name,
        ...meta,
        status: 'BROKEN',
        head: null,
        pendingCommits: 0,
        lastMessage: error.message,
        session: await readAgentSession(root, name, meta, false),
      };
    }
  };

  // Inspection à concurrence BORNÉE, ordre du registre conservé : l'état du
  // dashboard est recollecté à chaque changement, et 4 process git par agent
  // pris l'un après l'autre rendaient la collecte linéaire (≈ 1 s par agent
  // mesuré sous Windows : 50 agents = 50 s avant le premier rendu).
  const entries = Object.entries(registry);
  const agents = new Array(entries.length);
  let next = 0;
  const worker = async () => {
    while (next < entries.length) {
      const index = next++;
      const [name, meta] = entries[index];
      agents[index] = await inspect(name, meta);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(LIST_AGENTS_CONCURRENCY, entries.length) }, worker),
  );

  return agents;
}

/**
 * Un agent actif est "au repos" si tout son travail est mergé (HEAD ==
 * dernier merge) ET son worktree propre — le supprimer ne perd rien.
 */
async function agentHasPendingWork(meta) {
  const agentGit = cloneGit(meta.path);
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
 * Même règle pour un terminal supervisé ouvert par `--open` (hôte de pty
 * vivant) : `striart stop` l'arrête, `clean` ne le force jamais.
 *
 * `signal` n'annule que l'ATTENTE du verrou, jamais un nettoyage commencé.
 *
 * @param {{root: string, agent?: string|null, all?: boolean, force?: boolean, sessionEnded?: boolean, signal?: AbortSignal|null}} params
 * Après la libération du verrou, les artefacts périphériques de chaque clone retiré
 * (hôte ACP résiduel, Tab Configs Warp) sont nettoyés ; leurs échecs sont rapportés
 * dans `artifactErrors`, jamais bloquants ni avalés.
 *
 * @returns {Promise<{removed: Array<{name: string, freedBytes: number, wasActive: boolean}>, skipped: Array<{name: string, reason: 'ACTIVE'|'PENDING'|'IN_USE'|'BUSY'|'SESSION_LIVE'}>, artifactErrors: Array<{name: string, what: string, message: string}>}>}
 */
export async function cleanClones(params) {
  const result = await withMainLock(
    params.root,
    `clean:${params.agent ?? (params.all ? 'all' : 'stopped')}`,
    () => cleanClonesImpl(params),
    { signal: params.signal ?? null },
  );
  /** @type {Array<{name: string, what: string, message: string}>} */
  const artifactErrors = [];
  for (const { name } of result.removed) {
    const report = await releaseAgentArtifacts({ root: params.root, agent: name });
    for (const error of report.errors) artifactErrors.push({ name, ...error });
  }
  return { ...result, artifactErrors };
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
    // Dossier hors alphabet d'agent : pas un clone de Striart, jamais touché
    // (son nom ne deviendra jamais un marqueur ni une clé de registre).
    if (!AGENT_NAME_RE.test(entry.name)) continue;

    const registry = await readRegistry(root); // relu : les retraits précédents comptent
    const meta = registry[entry.name];
    const wasActive = Boolean(meta);

    // Terminal supervisé ouvert (`--open` : hôte de pty vivant, son shell a
    // le clone pour répertoire courant) : fait vérifié, comme une session
    // autonome — jamais supprimé, même avec `force`.
    if ((await ptyHostStatus(root, entry.name)).running) {
      skipped.push({ name: entry.name, reason: 'SESSION_LIVE' });
      continue;
    }

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
    const workActivityMs = await cloneWorkActivityMs(clonePath);
    if (!force && !sessionEnded && Date.now() - workActivityMs < presenceMs) {
      skipped.push({ name: entry.name, reason: 'IN_USE' });
      continue;
    }
    // Taille libérée : mesurée à neuf (jamais le cache d'affichage), seulement
    // pour un clone qu'on va réellement supprimer.
    const freedBytes = (await cloneDiskSize(clonePath)).sizeBytes;
    const removal = await removeClone(root, entry.name, { wasActive });
    if (!removal.removed) {
      // Un process (session de coding ouverte ?) verrouille encore le
      // dossier après les nouvelles tentatives. La suppression, décidée et
      // déjà entamée, reste marquée : la réconciliation la terminera.
      skipped.push({ name: entry.name, reason: 'BUSY' });
      continue;
    }
    removed.push({ name: entry.name, freedBytes, wasActive });
  }

  if (agent && removed.length === 0 && skipped.length === 0) {
    throw new StriartError(`Aucun clone trouvé pour "${agent}".`, {
      code: 'CLONE_NOT_FOUND',
      hint: 'striart status',
      details: { agent },
    });
  }
  return { removed, skipped };
}

// ─── Suppression rejouable d'un clone ─────────────────────────────────────

function removalMarkersDir(root) {
  return path.join(striartDir(root), 'removing');
}

function removalMarkerPath(root, name) {
  return path.join(removalMarkersDir(root), `${name}.json`);
}

async function hasRemovalMarker(root, name) {
  return stat(removalMarkerPath(root, name)).then(
    () => true,
    (error) => error.code !== 'ENOENT', // illisible : présumé présent (fail closed)
  );
}

/**
 * Refuse de (ré)utiliser un nom dont la suppression du clone est entamée :
 * un clone recréé sous ce nom serait supprimé par la reprise de la
 * réconciliation. Un marqueur dont le dossier a disparu est un reliquat
 * (crash entre la suppression et le retrait du marqueur) : retiré ici.
 * @param {string} root @param {string} name @param {string} dest
 */
async function assertNoPendingRemoval(root, name, dest) {
  if (!(await hasRemovalMarker(root, name))) return;
  const registry = await readRegistry(root);
  const dirExists = await stat(dest).then(
    () => true,
    (error) => error.code !== 'ENOENT',
  );
  if (!dirExists && !registry[name]) {
    await unlink(removalMarkerPath(root, name)).catch((error) => {
      if (error.code !== 'ENOENT') throw error;
    });
    return;
  }
  throw new StriartError(
    `La suppression du clone de "${name}" est entamée et pas encore terminée : ce nom ne peut pas être réutilisé avant sa fin.`,
    {
      code: 'CLONE_REMOVAL_PENDING',
      hint: 'striart reconcile',
      details: { name, path: dest },
    },
  );
}

/**
 * Supprime le clone `name` en deux temps, REJOUABLE : un `rm` récursif
 * interrompu (crash, handle Windows tenu au-delà des nouvelles tentatives)
 * laissait un clone à moitié supprimé, encore inscrit au registre. Ici :
 *  1. marqueur `.striart/removing/<nom>.json` (+ `removing: true` au
 *     registre pour un agent actif, visible de status/dashboard) ;
 *  2. `rm` avec attente exponentielle ;
 *  3. retrait du registre, puis du marqueur.
 * Un échec en 2 laisse le marqueur : `resumeCloneRemovals` (réconciliation)
 * termine la suppression déjà décidée. Les gardes (session vivante, travail
 * en attente, présence) sont celles de l'appelant, évaluées AVANT.
 * Le chemin est reconstruit depuis le nom validé, jamais lu d'un fichier.
 * @param {string} root @param {string} name @param {{wasActive: boolean}} options
 * @returns {Promise<{removed: true} | {removed: false, cause: string}>}
 */
export async function removeClone(root, name, { wasActive }) {
  validateAgentName(name);
  const since = new Date().toISOString();
  await mkdir(removalMarkersDir(root), { recursive: true });
  await writeJsonAtomic(removalMarkerPath(root, name), {
    name,
    wasActive,
    since,
    pid: process.pid,
  });
  if (wasActive) {
    await compareAndUpdateAgentMeta(root, name, {}, { removing: true, removingSince: since });
  }
  return finishCloneRemoval(root, name);
}

/**
 * Étapes 2 et 3 de removeClone (voir plus haut).
 * @param {string} root @param {string} name
 * @returns {Promise<{removed: true} | {removed: false, cause: string}>}
 */
async function finishCloneRemoval(root, name) {
  const clonePath = path.join(agentsDir(root), name);
  cloneSizeCache.invalidate(clonePath); // le chemin pourra être recréé : jamais une taille d'avant
  try {
    await removeTreeWithBackoff(clonePath);
  } catch (error) {
    logger.warn(
      { err: error.code ?? error.message, agent: name, path: clonePath },
      'Suppression du clone inachevée — reprise par la prochaine réconciliation',
    );
    return { removed: false, cause: error.code ?? error.message };
  }
  await updateRegistry(
    root,
    (current) => {
      // Seule l'entrée marquée est retirée : jamais un agent réinscrit.
      if (!current[name]?.removing) return UNCHANGED;
      delete current[name];
      return current;
    },
    { syncLocks: true },
  );
  await unlink(removalMarkerPath(root, name)).catch((error) => {
    if (error.code !== 'ENOENT') throw error;
  });
  return { removed: true };
}

/**
 * Reprend les suppressions de clone entamées et inachevées (marqueurs de
 * `.striart/removing/`, entrées `removing: true` du registre). Appelée par
 * la réconciliation, sous le verrou principal. Une session vivante dans le
 * clone (PID au registre, hôte de pty) l'ajourne : fait vérifié, jamais
 * contourné. Un marqueur au nom invalide est ignoré (et signalé) : il ne
 * devient jamais un chemin.
 * @param {string} root
 * @returns {Promise<{completed: string[], pending: Array<{name: string, reason: 'SESSION_LIVE'|'BUSY'|'ACTIVE'}>}>}
 */
export async function resumeCloneRemovals(root: string) {
  const registry = await readRegistry(root);
  const names = new Set(
    Object.entries(registry)
      .filter(([, meta]) => meta.removing)
      .map(([name]) => name),
  );
  for (const file of await readdir(removalMarkersDir(root)).catch(() => [])) {
    if (file.endsWith('.json')) names.add(file.slice(0, -'.json'.length));
  }
  const completed = [];
  /** @type {Array<{name: string, reason: 'SESSION_LIVE'|'BUSY'|'ACTIVE'}>} */
  const pending = [];
  for (const name of names) {
    try {
      validateAgentName(name);
    } catch {
      logger.warn({ marker: name }, 'Marqueur de suppression au nom invalide ignoré');
      continue;
    }
    const meta = registry[name];
    if (meta && !meta.removing) {
      // Inscrit sans marque de suppression : jamais supprimé d'office.
      pending.push({ name, reason: 'ACTIVE' });
      continue;
    }
    if ((meta && isProcessAlive(meta.sessionPid)) || (await ptyHostStatus(root, name)).running) {
      pending.push({ name, reason: 'SESSION_LIVE' });
      continue;
    }
    const result = await finishCloneRemoval(root, name);
    if (result.removed) completed.push(name);
    else pending.push({ name, reason: 'BUSY' });
  }
  return { completed, pending };
}

/** @deprecated alias historique de cleanClones (mode --stopped). */
export const cleanStoppedClones = cleanClones;

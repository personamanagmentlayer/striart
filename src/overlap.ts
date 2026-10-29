/**
 * Filet à l'exécution : chevauchement OBSERVÉ entre agents, et entre un agent et
 * ce que la branche cible a avancé — indépendant de toute prédiction.
 *
 * Le Router est un filtre grossier : il ne voit qu'une partie des chevauchements
 * (mesuré : ~78 % des chevauchements de code, et ~26 % des fichiers touchés sont
 * invisibles à tout signal). Ici on ne prédit rien : on LIT, dans l'historique git
 * des clones, les fichiers que chaque agent a réellement modifiés (diff entre sa
 * base et sa tête), puis on intersecte.
 *
 * Contrat (non négociable) :
 *  - LECTURE SEULE : deux sources de faits, des `git diff` entre COMMITS (ni index,
 *    ni worktree : aucun verrou d'index, rien qui gêne une session vivante) ;
 *  - jamais de merge, jamais d'action destructrice : le seul geste automatique est
 *    un rebase anticipé par la primitive existante `syncAgentWithMain`, refusé sur
 *    une session vivante (`SESSION_LIVE`/`sessionPid`), annulé sur conflit ;
 *  - aucun verrou principal tenu ici : l'observation n'en prend pas, et le rebase
 *    anticipé passe par la primitive qui prend le sien, brièvement ;
 *  - coût BORNÉ et mesuré : au plus `maxGitCalls` appels git par cycle (rapportés),
 *    avec un cache par (tête de l'agent, base, tête de la cible) — un cycle sans
 *    changement ne coûte qu'un `rev-parse` par agent ;
 *  - mêmes politiques que le Router : `isSafeProjectPath`, tenue de livre ignorée
 *    selon `tokens.router.sharedFiles` (router-shared.ts).
 *
 * Limites DÉCLARÉES : les modifications NON COMMITÉES d'un agent ne sont pas vues
 * (les lire exigerait de parcourir le worktree, ce que ni le watcher ni ce module ne
 * font) ; l'heuristique de base est celle de `listAgents` (dernier merge ou base du
 * clone) ; un fichier que l'agent a déjà mergé puis retouché peut faire un signal
 * « agent ↔ cible » sans conflit réel (le rebase anticipé le lève).
 */
import { simpleGit } from 'simple-git';
import { cloneGit, readRegistry } from './clone.ts';
import { emitStriartEvent } from './events.ts';
import { isProcessAlive } from './process-tree.ts';
import { logger } from './logger.ts';
import { isSafeProjectPath, normalizeFilePath } from './project-path.ts';
import { redactSecrets } from './redact-secrets.ts';
import { compileSharedMatcher } from './router-shared.ts';
import type { SharedMatcher } from './router-shared.ts';
import {
  DEFAULT_OVERLAP_SETTINGS,
  isValidOverlapSettings,
  overlapRelaxations,
  resolveOverlapSettings,
} from './overlap-settings.ts';
import { mapLimit } from './router-sources.ts';
import { resolveTokensSettings } from './tokens/settings.ts';
import { syncAgentWithMain } from './sync.ts';

/** Sentinelle « tout le dépôt » du Router (router.js `WHOLE_REPO`) : tient lieu de prédiction de tout. */
const WHOLE_REPO = '**';
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

// Réglages : module feuille (la config les valide sans importer git) — ré-exportés ici.
export {
  DEFAULT_OVERLAP_SETTINGS,
  isValidOverlapSettings,
  overlapRelaxations,
  resolveOverlapSettings,
};
export type { OverlapSettings, OverlapSettingsInput } from './overlap-settings.ts';

// --- Logique pure -----------------------------------------------------------------

export interface SanitizedFiles {
  files: string[];
  /** Fichiers écartés par la politique `sharedFiles` (tenue de livre). */
  ignoredShared: number;
  /** Chemins refusés (absolus, `..`, caractères de contrôle). */
  skippedUnsafe: number;
  /** La liste a été coupée à `maxFiles`. */
  truncated: boolean;
}

/** Chemins git bruts → chemins de projet sûrs, hors tenue de livre, bornés. */
export function sanitizeTouched(
  raw: readonly string[],
  isShared: SharedMatcher | null,
  maxFiles: number,
): SanitizedFiles {
  const seen = new Set<string>();
  let ignoredShared = 0;
  let skippedUnsafe = 0;
  let truncated = false;
  for (const entry of raw) {
    const file = normalizeFilePath(entry);
    if (!file || CONTROL_CHARS.test(file) || !isSafeProjectPath(file)) {
      skippedUnsafe += 1;
      continue;
    }
    if (isShared?.(file)) {
      ignoredShared += 1;
      continue;
    }
    if (seen.has(file)) continue;
    if (seen.size >= maxFiles) {
      truncated = true;
      continue;
    }
    seen.add(file);
  }
  return { files: [...seen].sort(), ignoredShared, skippedUnsafe, truncated };
}

export interface ObservedAgent {
  agent: string;
  /** Fichiers réellement touchés depuis sa base (déjà assainis). */
  touched: readonly string[];
  /** Fichiers prédits par le Router (registre) ; `**` = tout le dépôt. */
  predicted: readonly string[];
  /** Fichiers que la cible a avancés depuis la base de cet agent (déjà assainis). */
  mainAdvance: readonly string[];
}

export interface ObservedOverlap {
  /** `agents` : deux agents ; `target` : un agent et la branche cible. */
  kind: 'agents' | 'target';
  /** Deux noms (kind `agents`, triés) ou un seul (kind `target`). */
  agents: string[];
  /** Fichiers en commun, triés, bornés à `maxFilesPerOverlap`. `agents` : seulement les NON PRÉDITS. */
  files: string[];
  fileCount: number;
  filesTruncated: boolean;
  /** Identifiant stable du signal (types + agents + fichiers) : déduplication entre cycles. */
  key: string;
}

function digest(parts: readonly string[]): string {
  // FNV-1a 32 bits : un identifiant de déduplication, pas une primitive de sécurité.
  let h = 0x811c9dc5;
  for (const ch of parts.join('\u0001')) {
    h ^= ch.codePointAt(0)!;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

const predictedBy = (agent: ObservedAgent) => {
  const set = new Set(agent.predicted.map(normalizeFilePath));
  return (file: string) => set.has(WHOLE_REPO) || set.has(file);
};

/**
 * Intersections réelles. Agent ↔ agent : seuls les fichiers que le Router n'avait PAS
 * vus des deux côtés comptent (un fichier prédit par les deux est un chevauchement
 * que la sérialisation connaissait déjà — pas un signal nouveau). Agent ↔ cible : tout
 * fichier commun, la cible n'étant jamais dans la prédiction du Router.
 */
export function computeOverlaps(
  agents: readonly ObservedAgent[],
  maxFilesPerOverlap = DEFAULT_OVERLAP_SETTINGS.maxFilesPerOverlap,
): ObservedOverlap[] {
  const build = (kind: 'agents' | 'target', names: string[], files: string[]) => {
    const sorted = [...files].sort();
    return {
      kind,
      agents: names,
      files: sorted.slice(0, maxFilesPerOverlap),
      fileCount: sorted.length,
      filesTruncated: sorted.length > maxFilesPerOverlap,
      key: `${kind}:${names.join('+')}:${digest(sorted)}`,
    } satisfies ObservedOverlap;
  };
  const out: ObservedOverlap[] = [];
  const ordered = [...agents].sort((a, b) => a.agent.localeCompare(b.agent));
  for (let i = 0; i < ordered.length; i += 1) {
    const a = ordered[i]!;
    const aTouched = new Set(a.touched);
    const aPredicted = predictedBy(a);
    for (let j = i + 1; j < ordered.length; j += 1) {
      const b = ordered[j]!;
      const bPredicted = predictedBy(b);
      const files = b.touched.filter((f) => aTouched.has(f) && !(aPredicted(f) && bPredicted(f)));
      if (files.length > 0) out.push(build('agents', [a.agent, b.agent], files));
    }
  }
  for (const a of ordered) {
    const advanced = new Set(a.mainAdvance);
    const files = a.touched.filter((f) => advanced.has(f));
    if (files.length > 0) out.push(build('target', [a.agent], files));
  }
  return out;
}

/** Texte humain d'un signal : chemins caviardés et neutralisés, jamais plus de 5 listés. */
export function describeOverlap(overlap: ObservedOverlap, targetBranch: string): string {
  const shown = overlap.files.slice(0, 5).map((f) => redactSecrets(f));
  const more = overlap.fileCount - shown.length;
  const list = `${shown.join(', ')}${more > 0 ? ` (+${more})` : ''}`;
  if (overlap.kind === 'agents') {
    return `⚠️ [Striart] Chevauchement observé : ${overlap.agents[0]} et ${overlap.agents[1]} ont tous deux modifié ${list} (non prévu par le Router) — conflit probable au merge ; le Merger et le Test Gate trancheront.`;
  }
  return `⚠️ [Striart] Agent ${overlap.agents[0]} a modifié ${list} que ${targetBranch} a aussi fait avancer depuis son départ (non prévu par le Router) — conflit probable à son merge.`;
}

// --- Observation (git, lecture seule) ----------------------------------------------

interface CacheEntry {
  head: string;
  base: string;
  baseCommit: string;
  mainHead: string;
  /** Listes BRUTES (avant assainissement), bornées à maxFilesPerAgent + 1. */
  touched: string[];
  mainAdvance: string[];
}

export type OverlapCache = Map<string, CacheEntry>;
const CACHE_MAX = 512;
const defaultCache: OverlapCache = new Map();

/** Pour les tests. */
export function resetOverlapCache(): void {
  defaultCache.clear();
}

export interface OverlapCost {
  /** Appels git réellement lancés par ce cycle. */
  gitCalls: number;
  /** Plafond du cycle (`overlap.maxGitCalls`). */
  budget: number;
  /** Agents servis par le cache (aucun `git diff` relancé). */
  cacheHits: number;
  durationMs: number;
}

export interface OverlapReport {
  /** Branche cible de l'observation (pour l'affichage). */
  targetBranch: string;
  overlaps: ObservedOverlap[];
  /** Agents dont l'observation a été différée faute de budget d'appels git (jamais en silence). */
  deferred: string[];
  /** Agents dont les faits git n'ont pas pu être lus (code seulement, jamais un message git). */
  errors: Array<{ agent: string; reason: string }>;
  agentsObserved: number;
  ignoredShared: number;
  skippedUnsafe: number;
  /** Au moins un agent a plus de fichiers touchés que `maxFilesPerAgent` : l'intersection est partielle. */
  truncated: boolean;
  /** Limites connues de cette observation, pour que l'affichage ne mente pas. */
  coverage: { committed: true; uncommitted: false };
  cost: OverlapCost;
  generatedAt: string;
}

const emptyReport = (
  targetBranch: string,
  budget: number,
  started: number,
  calls = 0,
): OverlapReport => ({
  targetBranch,
  overlaps: [],
  deferred: [],
  errors: [],
  agentsObserved: 0,
  ignoredShared: 0,
  skippedUnsafe: 0,
  truncated: false,
  coverage: { committed: true, uncommitted: false },
  cost: {
    gitCalls: calls,
    budget,
    cacheHits: 0,
    durationMs: Math.round(performance.now() - started),
  },
  generatedAt: new Date().toISOString(),
});

const nameOnly = (out: string, limit: number): string[] => {
  const files = out.split('\0').filter(Boolean);
  return files.length > limit ? files.slice(0, limit) : files;
};

/**
 * Observe les chevauchements. Ne lève que sur une erreur du dépôt principal
 * (branche cible absente) ; les faits d'un clone illisible sont rapportés dans
 * `errors`, sans empêcher l'observation des autres.
 */
export async function observeOverlaps({
  root,
  config,
  cache = defaultCache,
}: {
  root: string;
  config: {
    targetBranch: string;
    overlap?: unknown;
    tokens?: unknown;
  };
  cache?: OverlapCache;
}): Promise<OverlapReport> {
  const started = performance.now();
  const settings = resolveOverlapSettings(config);
  const registry = await readRegistry(root);
  const names = Object.keys(registry);
  let gitCalls = 0;
  if (!settings.enabled || names.length === 0) {
    return emptyReport(config.targetBranch, settings.maxGitCalls, started);
  }

  const shared = resolveTokensSettings(config).router.sharedFiles;
  const isShared = shared.mode === 'exclude' ? compileSharedMatcher(shared.patterns) : null;

  const mainGit = simpleGit(root);
  gitCalls += 1;
  const mainHead = (
    await mainGit.raw([
      'rev-parse',
      '--verify',
      '--quiet',
      `refs/heads/${config.targetBranch}^{commit}`,
    ])
  ).trim();
  if (!/^[0-9a-f]{40,64}$/.test(mainHead)) {
    // Branche cible absente : le verrou de config (UNKNOWN_BRANCH) est ailleurs, ici on ne devine rien.
    const report = emptyReport(config.targetBranch, settings.maxGitCalls, started, gitCalls);
    report.errors.push({ agent: '*', reason: 'unknown-target-branch' });
    return report;
  }

  let reserved = gitCalls;
  let cacheHits = 0;
  const deferred: string[] = [];
  const errors: Array<{ agent: string; reason: string }> = [];
  let truncatedAny = false;
  let ignoredShared = 0;
  let skippedUnsafe = 0;
  const observed: ObservedAgent[] = [];

  // Un agent coûte au plus 3 appels (HEAD, diff du clone, diff de la cible) : la
  // réservation se fait AVANT son démarrage, sans attente, donc sans course.
  await mapLimit(names, 3, async (name) => {
    const meta = registry[name]!;
    if (reserved + 3 > settings.maxGitCalls) {
      deferred.push(name);
      return;
    }
    reserved += 3;
    try {
      const git = cloneGit(meta.path);
      gitCalls += 1;
      const head = (await git.raw(['rev-parse', '--verify', 'HEAD'])).trim();
      const base = meta.lastMergedCommit ?? meta.baseCommit;
      const cacheKey = `${root}\0${name}`;
      let entry = cache.get(cacheKey);
      if (
        entry &&
        entry.head === head &&
        entry.base === base &&
        entry.baseCommit === meta.baseCommit &&
        entry.mainHead === mainHead
      ) {
        cacheHits += 1;
      } else {
        const limit = settings.maxFilesPerAgent + 1;
        let touched: string[] = [];
        if (head !== base) {
          gitCalls += 1;
          touched = nameOnly(
            await git.raw(['diff', '--name-only', '-z', '--no-renames', base, head, '--']),
            limit,
          );
        }
        let mainAdvance: string[] = [];
        if (touched.length > 0 && meta.baseCommit !== mainHead) {
          gitCalls += 1;
          mainAdvance = nameOnly(
            await mainGit.raw([
              'diff',
              '--name-only',
              '-z',
              '--no-renames',
              meta.baseCommit,
              mainHead,
              '--',
            ]),
            limit,
          );
        }
        entry = { head, base, baseCommit: meta.baseCommit, mainHead, touched, mainAdvance };
        if (cache.size >= CACHE_MAX) cache.clear();
        cache.set(cacheKey, entry);
      }
      const touched = sanitizeTouched(entry.touched, isShared, settings.maxFilesPerAgent);
      const advance = sanitizeTouched(entry.mainAdvance, isShared, settings.maxFilesPerAgent);
      truncatedAny ||= touched.truncated || advance.truncated;
      ignoredShared += touched.ignoredShared;
      skippedUnsafe += touched.skippedUnsafe + advance.skippedUnsafe;
      observed.push({
        agent: name,
        touched: touched.files,
        predicted: meta.predictedFiles ?? [],
        mainAdvance: advance.files,
      });
    } catch (error) {
      // Code seulement : un message git peut porter des chemins ou des URL.
      errors.push({ agent: name, reason: 'git-facts-unreadable' });
      logger.debug(
        { agent: name, err: (error as Error).message },
        'Chevauchement : faits git illisibles',
      );
    }
  });

  // Le cache ne retient que les agents encore inscrits.
  for (const key of cache.keys()) {
    if (key.startsWith(`${root}\0`) && !names.includes(key.slice(root.length + 1)))
      cache.delete(key);
  }

  return {
    targetBranch: config.targetBranch,
    overlaps: computeOverlaps(observed, settings.maxFilesPerOverlap),
    deferred: deferred.sort(),
    errors: errors.sort((a, b) => a.agent.localeCompare(b.agent)),
    agentsObserved: observed.length,
    ignoredShared,
    skippedUnsafe,
    truncated: truncatedAny,
    coverage: { committed: true, uncommitted: false },
    cost: {
      gitCalls,
      budget: settings.maxGitCalls,
      cacheHits,
      durationMs: Math.round(performance.now() - started),
    },
    generatedAt: new Date().toISOString(),
  };
}

/** Vue d'état (status, Control Protocol) : ne lève jamais, une panne se DÉCLARE. */
export async function overlapStatus(
  root: string,
  config: Parameters<typeof observeOverlaps>[0]['config'],
): Promise<OverlapReport | { unavailable: true; reason: string }> {
  try {
    return await observeOverlaps({ root, config });
  } catch (error) {
    return { unavailable: true, reason: (error as { code?: string }).code ?? 'OVERLAP_FAILED' };
  }
}

// --- Rattrapage et surveillance ------------------------------------------------------

export interface CatchUpResult {
  agent: string;
  /** Statut de `syncAgentWithMain`, ou `SKIPPED_SESSION` décidé ICI sans prendre le verrou. */
  status: string;
}

export interface OverlapCycleResult {
  report: OverlapReport;
  /** Signaux nouveaux depuis le cycle précédent. */
  fresh: ObservedOverlap[];
  caughtUp: CatchUpResult[];
}

export interface OverlapMonitor {
  cycle(): Promise<OverlapCycleResult>;
}

/**
 * Moniteur à état (déduplication des signaux, mémoire des rattrapages) pour la boucle
 * `watch`. `cycle()` observe, émet un événement par signal NOUVEAU (bus d'observabilité :
 * informe, ne décide jamais) et tente, si c'est permis, le rebase anticipé des agents
 * dont la cible a avancé sur les fichiers qu'ils touchent.
 */
export function createOverlapMonitor({
  root,
  config,
  allowSync,
  sync = syncAgentWithMain,
  cache = new Map(),
}: {
  root: string;
  config: Parameters<typeof observeOverlaps>[0]['config'] & { autoRebase?: boolean };
  /** `watch --no-merge` : aucune action automatique, seulement le signal. */
  allowSync: boolean;
  sync?: typeof syncAgentWithMain;
  cache?: OverlapCache;
}): OverlapMonitor {
  const settings = resolveOverlapSettings(config);
  let seen = new Set<string>();
  /** Dernier statut de rattrapage par signal : un refus d'attente (session, worktree occupé) se retente. */
  const attempts = new Map<string, string>();

  return {
    async cycle() {
      const report = await observeOverlaps({ root, config, cache });
      const current = new Set(report.overlaps.map((o) => o.key));
      const fresh = report.overlaps.filter((o) => !seen.has(o.key));
      seen = current;
      for (const key of [...attempts.keys()]) if (!current.has(key)) attempts.delete(key);

      for (const overlap of fresh) {
        await emitStriartEvent(config as never, {
          type: 'overlap:observed',
          kind: overlap.kind,
          agents: overlap.agents,
          files: overlap.files.slice(0, 10),
          fileCount: overlap.fileCount,
          message: describeOverlap(overlap, config.targetBranch),
        });
      }

      const caughtUp: CatchUpResult[] = [];
      if (allowSync && settings.autoSync && config.autoRebase !== false) {
        const registry = report.overlaps.some((o) => o.kind === 'target')
          ? await readRegistry(root)
          : {};
        for (const overlap of report.overlaps) {
          if (overlap.kind !== 'target') continue;
          const last = attempts.get(overlap.key);
          if (last !== undefined && !last.startsWith('SKIPPED')) continue;
          const agent = overlap.agents[0]!;
          // Session vivante : intouchable, décidé AVANT de prendre le verrou principal.
          const result: CatchUpResult = isProcessAlive(registry[agent]?.sessionPid)
            ? { agent, status: 'SKIPPED_SESSION' }
            : await sync({ root, agent, config: config as never })
                .then((r) => ({ agent, status: r.status }))
                .catch((error: { code?: string }) => ({
                  agent,
                  status: `ERROR_${error.code ?? 'UNKNOWN'}`,
                }));
          attempts.set(overlap.key, result.status);
          // Un refus d'attente qui se répète (session toujours vivante) ne se re-signale pas.
          if (last === result.status) continue;
          caughtUp.push(result);
          await emitStriartEvent(config as never, {
            type: 'overlap:catch-up',
            agent,
            status: result.status,
            message:
              result.status === 'REBASED'
                ? `🔄 [Striart] Agent ${agent} rebasé par anticipation sur ${config.targetBranch} (chevauchement observé).`
                : `⚠️ [Striart] Agent ${agent} : rebase anticipé sur ${config.targetBranch} non effectué (${result.status}) — le conflit sera traité à son merge.`,
          });
        }
      }
      return { report, fresh, caughtUp };
    },
  };
}

/**
 * Primitives des modes orchestrés (lot O) : démarrer un clone autonome sous
 * le Router, jouer un TOUR d'agent dans un clone, puis conclure (merge sous
 * Test Gate, nettoyage). Tous les modes (review, team, pipeline, race) se
 * composent de ces trois briques.
 *
 * Invariants (décision O5, et décision architecturale n°6) :
 *  - le verrou principal n'est JAMAIS tenu pendant une session : chaque
 *    primitive du noyau appelée ici (runTask, mergeAgentCommit, cleanClones,
 *    createAgent) le prend brièvement de son côté ;
 *  - `sessionPid` est publié pour toute la vie du groupe (`withGroupSession`) :
 *    PID de l'agent pendant un tour à écrivain unique, PID de ce process
 *    entre les tours et en cadence parallèle — SESSION_LIVE et
 *    SKIPPED_SESSION couvrent ainsi toutes les sessions du clone ; il est
 *    dépublié AVANT le merge final (sa garde verrait ce process vivant) ;
 *  - un arrêt demandé tue les arbres des agents (runAgentSession) AVANT
 *    toute dépublication ;
 *  - le clone n'est supprimé que sur le chemin entièrement vert, sans `force`
 *    (les garde-fous de cleanClones gardent le dernier mot).
 *
 * Le contrat de commit d'un tour et la conclusion d'un clone (merge puis
 * nettoyage sans force) sont les briques de la primitive unique du noyau
 * (`src/autonomous-cycle.ts`), partagée avec `runAutonomousTask` et le proxy
 * ACP : `applyCommitContract` (ligne de base = la pointe de branche AVANT le
 * tour) et `mergeAndCleanClone`. Un commit de l'agent déjà dans la cible
 * (`UP_TO_DATE`) est un succès BRUYANT : `merge.mergeSha` désigne le commit de la
 * cible qui porte le travail, `merge.alreadyMerged` le dit aux consommateurs.
 */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { syncAgentInstructionsToClone } from '../agents/instructions.ts';
import { applyCommitContract, branchTip, mergeAndCleanClone } from '../autonomous-cycle.ts';
import { cloneGit, createAgent, readRegistry, updateAgentMeta } from '../clone.ts';
import { resolveCommitPolicy } from '../commit-policy.ts';
import { loadConfig } from '../config.ts';
import { emitStriartEvent } from '../events.ts';
import { logger } from '../logger.ts';
import { runTask } from '../orchestrator.ts';
import { canonicalProtectedPath, compileProtectedGlob } from '../protected-paths.ts';
import { readQueue, removeTask } from '../queue.ts';
import { resolveAgentProfile, runAgentSession } from '../session.ts';
import { postHarvestedMessages } from '../collab/channel.ts';
import { deliverInbox, harvestOutbox, prepareCollabFiles } from '../collab/files.ts';
import type { OutboxHarvest } from '../collab/files.ts';
import { partialEvidenceFromMerge } from './evidence.ts';
import type { PartialEvidence } from './evidence.ts';
import type {
  AgentCollabInfo,
  AgentMeta,
  AgentProfile,
  CollabSettings,
  OrchestrationSettings,
  OrchestrationStatus,
  SessionResult,
  StriartCommitResult,
  StriartConfig,
} from '../types.js';
import { waitUntil } from './wait.ts';

export type AgentInfo = AgentMeta & { name: string };

export type ProgressEvent =
  | { type: 'node-started'; nodeId: string | null; kind: string; info?: AgentInfo | null }
  | {
      type: 'node-finished';
      nodeId: string | null;
      kind: string;
      status: OrchestrationStatus;
      agent: string | null;
    }
  | {
      type: 'turn';
      group: string;
      agent: string;
      role: string;
      round: number;
      phase: 'started' | 'finished';
      status: string | null;
    }
  | {
      type: 'waiting';
      nodeId: string | null;
      reason: 'dependency' | 'collision' | 'attended' | 'human-review';
      ref: string | null;
    }
  | { type: 'verdict'; group: string; reviewer: string; round: number; verdict: string }
  /** La sentinelle WHOLE_REPO du Router n'a pas attendu ces clones (session en échec, sans commit). */
  | { type: 'serialization-relaxed'; nodeId: string | null; blockers: string[] };

export interface OrchestrationContext {
  root: string;
  config: StriartConfig;
  settings: OrchestrationSettings;
  collab: CollabSettings;
  runId: string | null;
  nodeId: string | null;
  signal: AbortSignal | null;
  progress: (event: ProgressEvent) => void;
}

/** Progression best effort : un rendu qui lève ne casse jamais un nœud. */
export function report(ctx: OrchestrationContext, event: ProgressEvent): void {
  try {
    ctx.progress(event);
  } catch (error) {
    logger.warn({ err: error }, 'Rendu de progression en échec (ignoré)');
  }
}

/** Émission best effort sur le bus d'observabilité (events.js isole déjà ses abonnés). */
export async function emit(
  ctx: OrchestrationContext,
  event: Parameters<typeof emitStriartEvent>[1],
): Promise<void> {
  await emitStriartEvent(ctx.config, event).catch((error: unknown) => {
    logger.warn({ err: error }, 'Émission d’événement en échec (ignorée)');
  });
}

type StartOutcome =
  | { ok: true; meta: AgentInfo; predictedFiles: string[] }
  | { ok: false; status: OrchestrationStatus; detail: string };

/**
 * Démarre un clone AUTONOME pour un nœud orchestré. Collision du Router :
 * `collisionPolicy` 'wait' retire l'entrée de file (sinon la file la
 * relancerait en SUPERVISÉ, mode perdu) et attend, borné, le départ des
 * agents en collision avant de repasser le Router ; 'fail' rend SKIPPED.
 * `predictedFiles` (candidats d'une course) : clone créé directement avec
 * la prédiction du premier candidat — les candidats d'une même course
 * partagent la tâche et ne se bloquent pas entre eux.
 */
export async function startOrchestratedClone(
  ctx: OrchestrationContext,
  {
    agent,
    prompt,
    profileKey,
    predictedFiles = null,
  }: { agent: string | null; prompt: string; profileKey: string; predictedFiles?: string[] | null },
): Promise<StartOutcome> {
  const profile = resolveAgentProfile(ctx.config, profileKey);
  if (predictedFiles && agent) {
    const meta = (await createAgent({
      root: ctx.root,
      name: agent,
      prompt,
      predictedFiles,
      command: profile.command,
      cloneFilter: ctx.config.cloneFilter,
      secretPatterns: ctx.config.secretPatterns,
      mode: 'autonomous',
      profile: profileKey,
    })) as AgentInfo;
    return { ok: true, meta, predictedFiles };
  }
  const deadline = Date.now() + ctx.settings.waitTimeoutMs;
  let name = agent;
  for (;;) {
    if (ctx.signal?.aborted) return { ok: false, status: 'CANCELLED', detail: 'ABORTED' };
    const r = await runTask({
      root: ctx.root,
      agent: name,
      prompt,
      command: profile.command,
      mode: 'autonomous',
      profile: profileKey,
    });
    if (r.status === 'STARTED') {
      if (r.relaxedBlockers?.length) {
        report(ctx, {
          type: 'serialization-relaxed',
          nodeId: ctx.nodeId,
          blockers: r.relaxedBlockers.map((b) => b.agent),
        });
      }
      return { ok: true, meta: r.info as AgentInfo, predictedFiles: r.predictedFiles };
    }
    name = r.task.agent;
    if (!(await removeTask(ctx.root, r.task.id))) {
      // La file l'a déjà relancée (en supervisé) entre l'enfilage et le
      // retrait : ce n'est plus une tâche orchestrée, on ne la pilote pas.
      return { ok: false, status: 'SKIPPED', detail: 'QUEUE_TOOK_OVER' };
    }
    if (ctx.settings.collisionPolicy === 'fail')
      return { ok: false, status: 'SKIPPED', detail: 'ROUTER_COLLISION' };
    const blockers = r.collisions.map((c) => c.agent);
    report(ctx, {
      type: 'waiting',
      nodeId: ctx.nodeId,
      reason: 'collision',
      ref: blockers.join(','),
    });
    const outcome = await waitUntil(
      async () => {
        const registry = await readRegistry(ctx.root);
        return blockers.every((b) => !registry[b]);
      },
      {
        intervalMs: ctx.settings.pollIntervalMs,
        timeoutMs: Math.max(0, deadline - Date.now()),
        signal: ctx.signal,
      },
    );
    if (outcome === 'aborted') return { ok: false, status: 'CANCELLED', detail: 'ABORTED' };
    if (outcome === 'timeout')
      return { ok: false, status: 'WAIT_TIMEOUT', detail: 'ROUTER_COLLISION' };
  }
}

/** Nom de base libre pour `count` noms dérivés `<base>-<i>` (registre ET file). */
export async function freeBaseName(
  root: string,
  base: string,
  suffixes: string[],
): Promise<string> {
  const registry = await readRegistry(root);
  const queue = await readQueue(root);
  const taken = new Set([...Object.keys(registry), ...queue.map((t) => t.agent)]);
  const fits = (b: string) => suffixes.every((s) => !taken.has(`${b}-${s}`));
  if (fits(base)) return base;
  for (let i = 2; ; i += 1) if (fits(`${base}-${i}`)) return `${base}-${i}`;
}

/**
 * Publie la collaboration d'un clone au registre (`meta.collab`) — le SEUL
 * point où l'orchestration la change. Pour un agent SUPERVISÉ, le fichier de
 * consignes injecté dans le clone est régénéré dans la foulée : sans cela, le
 * rôle courant et le périmètre qu'il affiche seraient périmés dès le tour
 * suivant (il n'est régénéré sinon qu'à la création, au `--reuse` et après
 * rebase). Les agents autonomes reconstruisent leurs consignes à chaque
 * session depuis le registre : rien à faire pour eux. La régénération est
 * best effort — un échec est journalisé, jamais un échec de tour.
 */
export async function publishAgentCollab(
  root: string,
  agent: string,
  collab: AgentCollabInfo,
  patch: Partial<AgentMeta> = {},
): Promise<void> {
  const meta = await updateAgentMeta(root, agent, { ...patch, collab });
  if (meta.mode === 'autonomous') return;
  try {
    await syncAgentInstructionsToClone({
      root,
      agent,
      clonePath: meta.path,
      mode: 'attended',
      command: meta.command ?? null,
    });
  } catch (error) {
    logger.warn({ err: error, agent }, 'Consignes du clone supervisé non rafraîchies');
  }
}

/**
 * Exécute `fn` avec le clone publié comme « session vivante » (sessionPid =
 * ce process) et son information de collaboration au registre ; dépublie
 * TOUJOURS ensuite (un PID fantôme gèlerait les rebases du clone).
 */
export async function withGroupSession<T>(
  root: string,
  agent: string,
  collab: AgentCollabInfo,
  fn: () => Promise<T>,
): Promise<T> {
  await publishAgentCollab(root, agent, collab, {
    sessionPid: process.pid,
    sessionStartedAt: new Date().toISOString(),
  });
  try {
    return await fn();
  } finally {
    await updateAgentMeta(root, agent, { sessionPid: null }).catch((error: unknown) => {
      logger.warn({ err: error, agent }, 'Dépublication de la session de groupe impossible');
    });
  }
}

export interface TurnSpec {
  group: string;
  role: string;
  round: number;
  profileKey: string;
  profile: AgentProfile;
  timeoutMs: number;
  prompt: string;
  /** null = libre ; [] = lecture seule ; sinon globs autorisés. */
  scope: string[] | null;
  readOnly: boolean;
  /** false (cadence parallèle, relecteur) : aucun contrat de commit après le tour. */
  commit: boolean;
  /** Tour à écrivain unique : le PID de l'agent est publié pendant le tour. */
  publishChildPid: boolean;
  /** Arrêt propre à ce tour (course : candidats annulés), combiné au signal du contexte. */
  signal?: AbortSignal | null;
  /** Nouvelle tentative du même tour (verdict redemandé) : log de session distinct. */
  attempt?: number;
  /** Aucun canal de collaboration (candidats indépendants d'une course). */
  noCollab?: boolean;
}

export interface TurnResult {
  status:
    | 'COMPLETED'
    | 'SESSION_FAILED'
    | 'CANCELLED'
    | 'COMMIT_REFUSED'
    | 'COMMIT_FAILED'
    | 'READ_ONLY_VIOLATION'
    | 'SCOPE_VIOLATION';
  session: SessionResult | null;
  commit: StriartCommitResult | null;
  tipBefore: string | null;
  tipAfter: string | null;
  /** Fichiers changés pendant le tour (commits + worktree). */
  changedFiles: string[];
  outbox: OutboxHarvest;
  detail: string | null;
  scopeViolations: string[];
}

const NUL = String.fromCharCode(0);

// Pointe de la branche de tâche : définie une fois, dans la primitive du noyau.
export { branchTip };

/** Chemins du worktree non committés (suivis modifiés + non suivis non ignorés). */
export async function worktreePaths(meta: AgentInfo): Promise<string[]> {
  const raw = await cloneGit(meta.path).raw([
    'status',
    '--porcelain=v1',
    '-z',
    '--untracked-files=all',
    '--no-renames',
  ]);
  return raw
    .split(NUL)
    .filter((e) => e.length >= 4)
    .map((e) => e.slice(3));
}

/** Empreinte de lecture seule : HEAD, branche courante, état du worktree. */
async function fingerprint(meta: AgentInfo): Promise<{ digest: string; clean: boolean }> {
  const git = cloneGit(meta.path);
  const head = (await git.raw(['rev-parse', 'HEAD']).catch(() => '')).trim();
  const ref = (await git.raw(['symbolic-ref', '-q', 'HEAD']).catch(() => '')).trim();
  const status = await git.raw([
    'status',
    '--porcelain=v1',
    '-z',
    '--untracked-files=all',
    '--no-renames',
  ]);
  // Le contenu des fichiers modifiés compte aussi : un relecteur qui réécrit
  // un fichier DÉJÀ modifié par l'auteur ne change pas la ligne de statut.
  const hash = createHash('sha256').update(`${head}\n${ref}\n${status}`);
  for (const entry of status.split(NUL).filter((e) => e.length >= 4)) {
    const content = await readFile(path.join(meta.path, entry.slice(3))).catch(() => null);
    hash
      .update(NUL)
      .update(entry)
      .update(NUL)
      .update(content ?? Buffer.alloc(0));
  }
  return { digest: hash.digest('hex'), clean: status.length === 0 };
}

async function changedSince(
  meta: AgentInfo,
  tipBefore: string | null,
  tipAfter: string | null,
): Promise<string[]> {
  const files = new Set<string>();
  if (tipBefore && tipAfter && tipBefore !== tipAfter) {
    const raw = await cloneGit(meta.path).raw([
      'diff',
      '--name-only',
      '-z',
      '--no-renames',
      tipBefore,
      tipAfter,
    ]);
    for (const f of raw.split(NUL)) if (f) files.add(f);
  }
  for (const f of await worktreePaths(meta)) files.add(f);
  return [...files].sort();
}

/** Fichiers hors de tous les globs de `scope` (garde I2 réutilisée : même syntaxe, mêmes chemins canoniques). */
export function outsideScope(files: string[], scope: string[]): string[] {
  const res = scope.map((g) =>
    compileProtectedGlob(g, process.platform === 'win32' || process.platform === 'darwin'),
  );
  return files.filter((f) => !res.some((re) => re.test(canonicalProtectedPath(f))));
}

/** Rôles dont le périmètre couvre `file`. */
export function scopesCovering(
  file: string,
  roles: Array<{ name: string; files: string[] | null }>,
): string[] {
  const caseInsensitive = process.platform === 'win32' || process.platform === 'darwin';
  return roles
    .filter((r) =>
      (r.files ?? []).some((g) =>
        compileProtectedGlob(g, caseInsensitive).test(canonicalProtectedPath(file)),
      ),
    )
    .map((r) => r.name);
}

function linkedSignal(...signals: Array<AbortSignal | null | undefined>): AbortSignal | null {
  const live = signals.filter((s): s is AbortSignal => Boolean(s));
  if (live.length === 0) return null;
  if (live.length === 1) return live[0];
  return AbortSignal.any(live);
}

/**
 * Joue un tour d'agent dans un clone : inbox livrée, session supervisée,
 * outbox récoltée (messages postés au groupe), contrôles (lecture seule,
 * périmètre), contrat de commit. Ne lève pas pour un échec de l'agent : rend
 * un statut, l'appelant décide (comme runAgentSession et le Test Gate).
 */
export async function runTurn(
  ctx: OrchestrationContext,
  meta: AgentInfo,
  spec: TurnSpec,
): Promise<TurnResult> {
  const { root, config } = ctx;
  await prepareCollabFiles(meta.path);
  if (!spec.noCollab) {
    await deliverInbox(
      { root, clonePath: meta.path, group: spec.group, roles: [spec.role] },
      ctx.collab,
    );
  }
  const tipBefore = await branchTip(meta);
  const before = spec.readOnly ? await fingerprint(meta) : null;

  // Le profil effectif annonce le BON contrat de commit dans les consignes
  // Striart de la session : « ne committe pas » pour un relecteur ou une
  // cadence parallèle (Striart committe seul), la politique du profil sinon.
  const effectiveProfile: AgentProfile = spec.readOnly
    ? { ...spec.profile, commitPolicy: 'human' }
    : !spec.commit
      ? { ...spec.profile, commitPolicy: 'striart' }
      : spec.profile;

  report(ctx, {
    type: 'turn',
    group: spec.group,
    agent: meta.name,
    role: spec.role,
    round: spec.round,
    phase: 'started',
    status: null,
  });
  await emit(ctx, {
    type: 'collab:turn',
    group: spec.group,
    agent: meta.name,
    role: spec.role,
    round: spec.round,
    phase: 'started',
    status: null,
  });

  let session: SessionResult;
  try {
    session = (await runAgentSession({
      root,
      agent: meta.name,
      taskId: `${meta.taskId}-${spec.role}-r${spec.round}${spec.attempt ? `-a${spec.attempt}` : ''}`,
      cwd: meta.path,
      profile: effectiveProfile,
      prompt: spec.prompt,
      timeoutMs: spec.timeoutMs,
      signal: linkedSignal(ctx.signal, spec.signal),
      config,
      profileKey: spec.profileKey,
      onSpawn: spec.publishChildPid
        ? async (pid: number | undefined) => {
            await updateAgentMeta(root, meta.name, { sessionPid: pid ?? process.pid });
          }
        : null,
    })) as SessionResult;
  } finally {
    // Entre deux tours, le groupe reste vivant : PID de ce process (une seule
    // écriture, aucune fenêtre sans garde).
    if (spec.publishChildPid) {
      await updateAgentMeta(root, meta.name, { sessionPid: process.pid }).catch(
        (error: unknown) => {
          logger.warn(
            { err: error, agent: meta.name },
            'Republication du PID de groupe impossible',
          );
        },
      );
    }
  }

  const outbox = await harvestOutbox(meta.path, ctx.collab);
  if (outbox.error)
    logger.warn({ agent: meta.name, role: spec.role, cause: outbox.error }, 'Outbox refusée');
  if (outbox.messages.length > 0 && !spec.noCollab) {
    await postHarvestedMessages(
      root,
      spec.group,
      { agent: meta.name, role: spec.role },
      outbox.messages,
      'outbox',
      ctx.collab,
    ).catch((error: unknown) => logger.warn({ err: error }, 'Messages de l’outbox non postés'));
  }

  const result = (
    status: TurnResult['status'],
    detail: string | null,
    extra: Partial<TurnResult> = {},
  ): TurnResult => ({
    status,
    session,
    commit: null,
    tipBefore,
    tipAfter: null,
    changedFiles: [],
    outbox,
    detail,
    scopeViolations: [],
    ...extra,
  });
  const finish = async (r: TurnResult): Promise<TurnResult> => {
    report(ctx, {
      type: 'turn',
      group: spec.group,
      agent: meta.name,
      role: spec.role,
      round: spec.round,
      phase: 'finished',
      status: r.status,
    });
    await emit(ctx, {
      type: 'collab:turn',
      group: spec.group,
      agent: meta.name,
      role: spec.role,
      round: spec.round,
      phase: 'finished',
      status: r.status,
    });
    return r;
  };

  if (session.status !== 'COMPLETED') {
    return finish(
      result(session.status === 'CANCELLED' ? 'CANCELLED' : 'SESSION_FAILED', session.status),
    );
  }

  if (spec.readOnly && before) {
    const after = await fingerprint(meta);
    if (after.digest !== before.digest) {
      if (
        ctx.settings.review.reviewerWrites === 'discard' &&
        before.clean &&
        (await branchTip(meta)) === tipBefore
      ) {
        // Relâchement explicite (affiché par doctor) : l'arbre était propre
        // avant le tour, on le ramène exactement à la pointe — `clean` sans
        // -x : les fichiers ignorés (dépendances installées) restent.
        const git = cloneGit(meta.path);
        await git.raw(['reset', '--hard', tipBefore ?? 'HEAD']);
        await git.raw(['clean', '-fd']);
        logger.warn(
          { agent: meta.name, role: spec.role },
          'Écritures du relecteur jetées (review.reviewerWrites: discard)',
        );
      } else {
        return finish(result('READ_ONLY_VIOLATION', spec.role));
      }
    }
  }

  let commit: StriartCommitResult | null = null;
  if (spec.commit && !spec.readOnly) {
    // Ligne de base du TOUR : « l'agent a committé » = sa branche a bougé depuis
    // `tipBefore`. Le groupe tient déjà `sessionPid` (withGroupSession) : la
    // primitive n'y touche pas, et n'annonce pas d'événement `session:striart-commit`
    // (le tour publie ses propres `collab:turn`).
    const contract = await applyCommitContract({
      root,
      config,
      meta,
      profileKey: spec.profileKey,
      profile: spec.profile,
      prompt: meta.prompt,
      policy: resolveCommitPolicy(config, spec.profile),
      baselineTip: tipBefore,
      announce: false,
      wording: 'runner',
      logFields: { role: spec.role },
    });
    if (contract.kind === 'refused') return finish(result('COMMIT_REFUSED', contract.reason));
    if (contract.kind === 'failed') return finish(result('COMMIT_FAILED', contract.code));
    // L'agent a committé lui-même : aucun commit Striart à rapporter pour ce tour.
    commit = contract.commit.status === 'SKIPPED_AGENT_COMMITTED' ? null : contract.commit;
  }

  const tipAfter = await branchTip(meta);
  const changedFiles = await changedSince(meta, tipBefore, tipAfter);
  if (spec.scope && spec.scope.length > 0 && !spec.readOnly) {
    const outside = outsideScope(changedFiles, spec.scope);
    if (outside.length > 0) {
      if (ctx.settings.team.onScopeViolation === 'fail') {
        return finish(
          result('SCOPE_VIOLATION', spec.role, {
            commit,
            tipAfter,
            changedFiles,
            scopeViolations: outside,
          }),
        );
      }
      logger.warn(
        { agent: meta.name, role: spec.role, files: outside },
        'Écritures hors périmètre tolérées (team.onScopeViolation: warn)',
      );
    }
  }
  return finish(result('COMPLETED', null, { commit, tipAfter, changedFiles }));
}

export interface FinalOutcome {
  status: 'MERGED' | 'EMPTY' | 'MERGE_BLOCKED' | 'KEPT';
  detail: string | null;
  kept: boolean;
  merge: { sha: string; mergeSha: string; alreadyMerged?: boolean } | null;
  /** Preuve partielle (lot O, priorité 2) — src/orchestration/evidence.ts complète avec la consigne, les verdicts et l'usage. */
  evidence: PartialEvidence;
}

/**
 * Conclut un clone orchestré : rien de neuf → EMPTY (conservé) ; sinon merge
 * sous Test Gate (le Test Gate reste l'autorité finale, approuvé ou non par
 * un relecteur) ; puis nettoyage SANS force. À appeler APRÈS
 * `withGroupSession` (sessionPid dépublié).
 */
export async function finalizeClone(
  ctx: OrchestrationContext,
  meta: AgentInfo,
): Promise<FinalOutcome> {
  await updateAgentMeta(ctx.root, meta.name, { sessionPid: null }).catch((error: unknown) => {
    logger.warn({ err: error, agent: meta.name }, 'Dépublication du PID de groupe impossible');
  });
  if ((await branchTip(meta)) === meta.baseCommit) {
    return {
      status: 'EMPTY',
      detail: 'NO_COMMIT',
      kept: true,
      merge: null,
      evidence: partialEvidenceFromMerge(null),
    };
  }
  // `commitPolicy: 'human'` (profil du clone, sinon global) : jamais de merge
  // automatique, même pour un clone orchestré — le travail attend la revue humaine.
  const config = ctx.config ?? (await loadConfig(ctx.root));
  const profile = meta.profile ? config.agentProfiles?.[meta.profile] : undefined;
  if (resolveCommitPolicy(config, profile ?? {}) === 'human') {
    return {
      status: 'KEPT',
      detail: 'HUMAN_REVIEW_REQUIRED',
      kept: true,
      merge: null,
      evidence: partialEvidenceFromMerge(null),
    };
  }
  const done = await mergeAndCleanClone({ root: ctx.root, name: meta.name });
  if (done.kind === 'blocked') {
    return {
      status: 'MERGE_BLOCKED',
      detail: done.detail,
      kept: true,
      merge: null,
      evidence: partialEvidenceFromMerge(done.merge),
    };
  }
  const merged = done.merge;
  // `mergeAndCleanClone` ne rend « merged » que pour MERGED ou UP_TO_DATE alreadyMerged.
  if (merged.status !== 'MERGED' && merged.status !== 'UP_TO_DATE') {
    return {
      status: 'MERGE_BLOCKED',
      detail: merged.status,
      kept: true,
      merge: null,
      evidence: partialEvidenceFromMerge(merged),
    };
  }
  const mergeSha = merged.status === 'MERGED' ? merged.mergeSha : (merged.mergeSha ?? merged.sha);
  return {
    status: 'MERGED',
    detail: done.cleaned ? null : `CLEANUP_SKIPPED:${done.skippedReason ?? 'UNKNOWN'}`,
    kept: !done.cleaned,
    merge: {
      sha: merged.sha,
      mergeSha,
      ...(done.alreadyIntegrated ? { alreadyMerged: true } : {}),
    },
    evidence: partialEvidenceFromMerge(merged),
  };
}

/** Timeout effectif d'un agent : propre au nœud > profil > global. */
export function timeoutFor(
  ctx: OrchestrationContext,
  own: number | null,
  profile: AgentProfile,
): number {
  return own ?? profile.timeout ?? ctx.config.autonomousTimeoutMs;
}

/** Statut de nœud correspondant à l'échec d'un tour. */
export function turnFailureStatus(turn: TurnResult): OrchestrationStatus {
  switch (turn.status) {
    case 'CANCELLED':
      return 'CANCELLED';
    case 'COMMIT_REFUSED':
      return 'COMMIT_REFUSED';
    case 'COMMIT_FAILED':
      return 'COMMIT_FAILED';
    case 'READ_ONLY_VIOLATION':
      return 'READ_ONLY_VIOLATION';
    case 'SCOPE_VIOLATION':
      return 'SCOPE_VIOLATION';
    default:
      return 'SESSION_FAILED';
  }
}

/** Log de session (pour la lecture d'un bloc striart-verdict / striart-handoff). */
export async function readSessionLog(session: SessionResult | null): Promise<string> {
  if (!session?.logPath) return '';
  return readFile(session.logPath, 'utf8').catch(() => '');
}

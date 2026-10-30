/**
 * Exécuteur des plans `version: 2` (lot O, décision O2) : enchaînement
 * `sequential` / `parallel`, dépendances (fan-in), politique d'échec, et
 * aiguillage de chaque nœud vers son mode (task, review, pipeline, race, team).
 *
 * Le scheduler ne tient AUCUN verrou : il attend des promesses de nœuds, et
 * chaque nœud compose des primitives du noyau qui prennent le verrou
 * principal brièvement (réentrance par contexte asynchrone de lock.js : deux
 * nœuds parallèles d'un même process s'excluent correctement).
 *
 * Une tâche dépend d'une autre quand elle la cite dans `after` (id de plan),
 * et — en `sequential` — de la précédente. Elle démarre quand toutes ses
 * dépendances ont RÉUSSI (MERGED, ou FINISHED pour une tâche supervisée
 * attendue) ; une dépendance en échec la fait sauter (`skip-dependents`) ou
 * arrête tout ce qui n'a pas démarré (`stop`, défaut). Une référence
 * d'exécution (agent ou tâche vivant hors plan) est attendue, bornée par
 * `orchestration.waitTimeoutMs`.
 */
import { readRegistry } from '../clone.ts';
import { StriartError } from '../errors.ts';
import { logger } from '../logger.ts';
import { isProcessAlive } from '../process-tree.ts';
import { removeTask, readQueue } from '../queue.ts';
import { DEFAULT_PROFILE, resolveAgentProfile } from '../session.ts';
import { runAutonomousTask, runTask } from '../orchestrator.ts';
import type {
  MergeResult,
  OrchestrationMode,
  OrchestrationNodeResult,
  OrchestrationRunState,
  OrchestrationStatus,
  PlanFailurePolicy,
  PlanNode,
  StriartConfig,
  StriartPlanV2,
} from '../types.js';
import { buildEvidence, partialEvidenceFromMerge } from './evidence.ts';
import { runPipelineNode } from './pipeline.ts';
import { runRaceNode } from './race.ts';
import { nodeResult } from './result.ts';
import { runReviewNode } from './review.ts';
import { resolveCollabSettings, resolveOrchestrationSettings } from './settings.ts';
import {
  createRunState,
  finishRunState,
  loadRunState,
  reopenRunState,
  updateRunNode,
} from './store.ts';
import { runTeamNode } from './team.ts';
import { emit, report } from './unit.ts';
import type { AgentInfo, OrchestrationContext, ProgressEvent } from './unit.ts';
import { waitUntil } from './wait.ts';

export interface PlanOverrides {
  mode?: OrchestrationMode | null;
  concurrency?: number | null;
  onFailure?: PlanFailurePolicy | null;
}

/** Statuts qui satisfont une dépendance. */
const SUCCESS: ReadonlySet<OrchestrationStatus> = new Set(['MERGED', 'FINISHED']);

/** Profils de tous les agents d'un nœud (validés avant tout effet de bord). */
export function nodeProfiles(node: PlanNode): string[] {
  switch (node.kind) {
    case 'task':
      return node.autonomous ? [node.profile ?? DEFAULT_PROFILE] : [];
    case 'review':
      return [
        node.author.profile ?? DEFAULT_PROFILE,
        ...node.reviewers
          .filter((r) => r.kind === 'agent')
          .map((r) => r.profile ?? DEFAULT_PROFILE),
      ];
    case 'pipeline':
      return node.steps.map((s) => s.profile ?? DEFAULT_PROFILE);
    case 'race':
      return node.candidates.map((c) => c.profile ?? DEFAULT_PROFILE);
    case 'team':
      return node.roles.map((r) => r.profile ?? DEFAULT_PROFILE);
  }
}

/**
 * Contrôles qui dépendent de la config (profils existants, plafonds) :
 * avant tout lancement, `--dry-run` compris — l'erreur la plus probable
 * d'un plan multi-IA (profil mal orthographié) tombe à la revue.
 */
export function validatePlanAgainstConfig(plan: StriartPlanV2, config: StriartConfig): void {
  const settings = resolveOrchestrationSettings(config);
  plan.tasks.forEach((node, i) => {
    for (const key of nodeProfiles(node)) resolveAgentProfile(config, key);
    if (node.kind === 'race' && node.candidates.length > settings.race.maxCandidates) {
      throw new StriartError(
        `Plan invalide : tâche #${i + 1} : ${settings.race.maxCandidates} candidats au plus (orchestration.race.maxCandidates).`,
        {
          code: 'PLAN_INVALID',
          hint: 'striart plan <fichier> --dry-run',
          details: {
            reason: 'CANDIDATES_TOO_MANY',
            max: settings.race.maxCandidates,
            task: i + 1,
            taskId: node.id,
          },
        },
      );
    }
  });
}

/** Lignes de revue d'un plan v2 (`--dry-run`). */
export function describePlanV2(plan: StriartPlanV2) {
  return plan.tasks.map((t) => ({
    id: t.id,
    agent: t.agent,
    kind: t.kind,
    mode: (t.kind === 'task' && !t.autonomous ? 'attended' : 'autonomous') as
      'attended' | 'autonomous',
    after: t.after.length > 0 ? t.after.join(', ') : null,
  }));
}

async function isWorkActive(root: string, ref: string): Promise<boolean> {
  const registry = await readRegistry(root);
  if (registry[ref]) return true;
  return (await readQueue(root)).some((t) => t.id === ref || t.agent === ref);
}

/**
 * Un nœud est réutilisable depuis un run persisté quand son résultat est
 * VRAIMENT terminal. Un arrêt gracieux (`INTERRUPTED` au signal, `STOPPED`
 * par la politique d'échec) n'est pas une décision : il n'a jamais tourné,
 * la reprise doit le relancer, jamais le figer en échec.
 */
function resumableResult(result: OrchestrationNodeResult | null): OrchestrationNodeResult | null {
  if (!result) return null;
  if (
    result.status === 'SKIPPED' &&
    (result.detail === 'INTERRUPTED' || result.detail === 'STOPPED')
  ) {
    return null;
  }
  return result;
}

/** Le plan rejoué doit décrire exactement les mêmes nœuds que le run persisté (par index). */
function checkResumeCongruence(
  run: OrchestrationRunState,
  plan: StriartPlanV2,
  runId: string,
): void {
  const mismatch =
    run.nodes.length !== plan.tasks.length ||
    run.nodes.some((n, i) => {
      const t = plan.tasks[i];
      if (n.kind !== t.kind) return true;
      return n.id !== null && t.id !== null && n.id !== t.id;
    });
  if (mismatch) {
    throw new StriartError(
      `Le plan fourni ne correspond pas au run "${runId}" (tâches différentes).`,
      {
        code: 'ORCHESTRATION_RESUME_MISMATCH',
        details: { runId },
        hint: 'Reprends avec le même fichier de plan que celui qui a produit ce run.',
      },
    );
  }
}

export async function runPlanV2({
  root,
  plan,
  config,
  signal = null,
  onProgress = null,
  overrides = {},
  resume = null,
}: {
  root: string;
  plan: StriartPlanV2;
  config: StriartConfig;
  signal?: AbortSignal | null;
  onProgress?: ((event: ProgressEvent) => void) | null;
  overrides?: PlanOverrides;
  resume?: { runId: string } | null;
}) {
  const settings = resolveOrchestrationSettings(config);
  const collab = resolveCollabSettings(config);
  validatePlanAgainstConfig(plan, config);

  let run: OrchestrationRunState;
  let seeded: Array<OrchestrationNodeResult | null>;

  if (resume) {
    const existing = await loadRunState(root, resume.runId);
    if (!existing) {
      throw new StriartError(`Run introuvable : "${resume.runId}".`, {
        code: 'ORCHESTRATION_RUN_NOT_FOUND',
        details: { runId: resume.runId },
        hint: 'striart status --json (section orchestration) pour lister les runs connus.',
      });
    }
    if (existing.status === 'running' && isProcessAlive(existing.pid)) {
      throw new StriartError(`Run "${resume.runId}" est toujours en cours (pid ${existing.pid}).`, {
        code: 'ORCHESTRATION_RUN_LIVE',
        details: { runId: resume.runId, pid: existing.pid },
        hint: 'Attends la fin du run, ou interromps-le proprement avant de le reprendre.',
      });
    }
    checkResumeCongruence(existing, plan, resume.runId);
    run = await reopenRunState(root, resume.runId);
    seeded = run.nodes.map((n) => resumableResult(n.result));
  } else {
    const mode = overrides.mode ?? plan.mode;
    const concurrency =
      mode === 'sequential'
        ? 1
        : Math.min(
            overrides.concurrency ?? plan.concurrency ?? settings.concurrency,
            settings.maxConcurrency,
          );
    const onFailure = overrides.onFailure ?? plan.onFailure ?? settings.onFailure;
    run = await createRunState(
      root,
      {
        mode,
        concurrency,
        onFailure,
        nodes: plan.tasks.map((t) => ({
          id: t.id,
          kind: t.kind,
          state: 'pending',
          status: null,
          agent: null,
          result: null,
        })),
      },
      settings.keepRuns,
    );
    seeded = plan.tasks.map(() => null);
  }
  const { mode, concurrency, onFailure } = run;

  const indexOfId = new Map(
    plan.tasks.map((t, i) => [t.id, i] as const).filter(([id]) => id !== null) as Array<
      [string, number]
    >,
  );
  const deps = plan.tasks.map((t, i) => {
    const local = new Set<number>();
    const external: string[] = [];
    for (const ref of t.after) {
      const at = indexOfId.get(ref);
      if (at !== undefined) local.add(at);
      else external.push(ref);
    }
    if (mode === 'sequential' && i > 0) local.add(i - 1);
    return { local: [...local], external };
  });

  const results: Array<OrchestrationNodeResult | null> = seeded;
  const running = new Map<number, Promise<void>>();
  let stopped = false;

  const progress = (event: ProgressEvent) => {
    if (onProgress) onProgress(event);
  };

  const launch = (i: number) => {
    const node = plan.tasks[i];
    const ctx: OrchestrationContext = {
      root,
      config,
      settings,
      collab,
      runId: run.id,
      nodeId: node.id,
      signal,
      progress,
    };
    const work = (async () => {
      await updateRunNode(root, run.id, i, { state: 'running' });
      await emit(ctx, {
        type: 'orchestration:node',
        runId: run.id,
        nodeId: node.id,
        kind: node.kind,
        phase: 'started',
        status: null,
        agent: node.agent,
      });
      let result: OrchestrationNodeResult;
      try {
        result = await runNode(ctx, node, deps[i].external);
      } catch (error) {
        logger.error({ err: error, node: node.id }, 'Nœud de plan en erreur');
        result = nodeResult(node, {
          status: 'ERROR',
          detail: error instanceof StriartError ? error.code : 'UNEXPECTED',
          kept: true,
        });
      }
      results[i] = result;
      await updateRunNode(root, run.id, i, {
        state: 'done',
        status: result.status,
        agent: result.agent,
        result,
      });
      report(ctx, {
        type: 'node-finished',
        nodeId: node.id,
        kind: node.kind,
        status: result.status,
        agent: result.agent,
      });
      await emit(ctx, {
        type: 'orchestration:node',
        runId: run.id,
        nodeId: node.id,
        kind: node.kind,
        phase: 'finished',
        status: result.status,
        agent: result.agent,
        ...(SUCCESS.has(result.status)
          ? {}
          : {
              message: `⛔ [Striart] Plan ${run.id}: task ${node.id ?? `#${i + 1}`} (${node.kind}) ended ${result.status}.`,
            }),
      });
      if (!SUCCESS.has(result.status) && onFailure === 'stop') stopped = true;
    })();
    running.set(
      i,
      work.finally(() => running.delete(i)),
    );
  };

  const skip = (i: number, detail: string) => {
    const result = nodeResult(plan.tasks[i], {
      status: 'SKIPPED',
      detail,
      mode: modeOf(plan.tasks[i]),
    });
    results[i] = result;
    void updateRunNode(root, run.id, i, { state: 'skipped', status: 'SKIPPED', result });
  };

  for (;;) {
    // Ressources hors-Git (lot O, priorité 4) : occupées par tout nœud EN COURS
    // (recalculé à chaque passage — jamais mémorisé, un nœud qui finit libère
    // sa ressource immédiatement). Un conflit retarde le lancement, il ne
    // l'échoue ni ne le saute : le nœud repasse à l'itération suivante.
    const busyResources = new Set<string>();
    for (const idx of running.keys()) {
      for (const r of plan.tasks[idx].resources) busyResources.add(r);
    }
    for (let i = 0; i < plan.tasks.length; i += 1) {
      if (results[i] || running.has(i)) continue;
      if (signal?.aborted) {
        skip(i, 'INTERRUPTED');
        continue;
      }
      if (stopped) {
        skip(i, 'STOPPED');
        continue;
      }
      const local = deps[i].local;
      if (local.some((d) => results[d] && !SUCCESS.has(results[d]!.status))) {
        skip(i, 'DEPENDENCY_FAILED');
        continue;
      }
      if (!local.every((d) => results[d])) continue;
      if (plan.tasks[i].resources.some((r) => busyResources.has(r))) continue;
      if (running.size >= concurrency) break;
      launch(i);
      // Pris en compte tout de suite : un nœud plus loin dans ce même passage
      // qui partage la ressource ne doit pas être lancé à côté.
      for (const r of plan.tasks[i].resources) busyResources.add(r);
    }
    if (running.size === 0) break;
    await Promise.race(running.values());
  }

  const nodes = results as OrchestrationNodeResult[];
  const interrupted = Boolean(signal?.aborted);
  await finishRunState(root, run.id, interrupted ? 'interrupted' : 'done');
  return {
    run: { id: run.id, mode, concurrency, onFailure },
    nodes,
    interrupted,
    notApplied: nodes
      .map((n, i) => ({ n, t: plan.tasks[i] }))
      .filter(({ n }) => n.status === 'SKIPPED' && n.detail === 'INTERRUPTED')
      .map(({ t }) => ({ id: t.id, agent: t.agent })),
  };
}

function modeOf(node: PlanNode): 'attended' | 'autonomous' {
  return node.kind === 'task' && !node.autonomous ? 'attended' : 'autonomous';
}

async function runNode(
  ctx: OrchestrationContext,
  node: PlanNode,
  external: string[],
): Promise<OrchestrationNodeResult> {
  for (const ref of external) {
    report(ctx, { type: 'waiting', nodeId: node.id, reason: 'dependency', ref });
    const outcome = await waitUntil(async () => !(await isWorkActive(ctx.root, ref)), {
      intervalMs: ctx.settings.pollIntervalMs,
      timeoutMs: ctx.settings.waitTimeoutMs,
      signal: ctx.signal,
    });
    if (outcome === 'aborted')
      return nodeResult(node, { status: 'CANCELLED', detail: 'ABORTED', mode: modeOf(node) });
    if (outcome === 'timeout')
      return nodeResult(node, { status: 'WAIT_TIMEOUT', detail: ref, mode: modeOf(node) });
  }
  switch (node.kind) {
    case 'task':
      return node.autonomous ? runAutonomousNode(ctx, node) : runAttendedNode(ctx, node);
    case 'review':
      return runReviewNode(ctx, node);
    case 'pipeline':
      return runPipelineNode(ctx, node);
    case 'race':
      return runRaceNode(ctx, node);
    case 'team':
      return runTeamNode(ctx, node);
  }
}

type TaskNode = Extract<PlanNode, { kind: 'task' }>;

/**
 * Tâche SUPERVISÉE : démarrée (ou mise en file par le Router), puis ATTENDUE
 * jusqu'à la sortie de son agent du registre et de la file — l'attente
 * bloquante qui manquait au v1 pour un enchaînement séquentiel réel.
 */
async function runAttendedNode(
  ctx: OrchestrationContext,
  node: TaskNode,
): Promise<OrchestrationNodeResult> {
  const r = await runTask({
    root: ctx.root,
    agent: node.agent,
    prompt: node.prompt,
    command: node.command,
  });
  const name = r.status === 'STARTED' ? r.info.name : r.task.agent;
  const info = r.status === 'STARTED' ? (r.info as AgentInfo) : null;
  report(ctx, { type: 'node-started', nodeId: node.id, kind: 'task', info });
  report(ctx, { type: 'waiting', nodeId: node.id, reason: 'attended', ref: name });
  const outcome = await waitUntil(async () => !(await isWorkActive(ctx.root, name)), {
    intervalMs: ctx.settings.pollIntervalMs,
    timeoutMs: ctx.settings.waitTimeoutMs,
    signal: ctx.signal,
  });
  const status: OrchestrationStatus =
    outcome === 'ok' ? 'FINISHED' : outcome === 'aborted' ? 'CANCELLED' : 'WAIT_TIMEOUT';
  // Interrompu ou expiré : l'agent supervisé continue, il appartient à l'humain.
  return nodeResult(node, {
    status,
    mode: 'attended',
    agent: name,
    agents: [name],
    kept: status !== 'FINISHED',
    info,
    detail: r.status,
  });
}

/**
 * Merge porté par un nœud `task` autonome. Le cycle rend MERGED aussi quand le
 * commit de l'agent était déjà dans la cible (`UP_TO_DATE` + `alreadyMerged`) :
 * le nœud cite alors le commit de la cible qui porte le travail, jamais `null`.
 */
export function nodeMergeOf(
  merge: MergeResult | null,
): { sha: string; mergeSha: string; alreadyMerged?: boolean } | null {
  if (!merge) return null;
  if (merge.status === 'MERGED') return { sha: merge.sha, mergeSha: merge.mergeSha };
  if (merge.status === 'UP_TO_DATE' && merge.alreadyMerged === true) {
    return { sha: merge.sha, mergeSha: merge.mergeSha ?? merge.sha, alreadyMerged: true };
  }
  return null;
}

/**
 * Tâche AUTONOME simple : le cycle de `runAutonomousTask` (source unique).
 * Collision du Router : contrairement au v1, le mode n'est pas perdu — la
 * tâche est retirée de la file et relancée au dégagement (collisionPolicy).
 */
async function runAutonomousNode(
  ctx: OrchestrationContext,
  node: TaskNode,
): Promise<OrchestrationNodeResult> {
  const deadline = Date.now() + ctx.settings.waitTimeoutMs;
  let agent = node.agent;
  for (;;) {
    if (ctx.signal?.aborted) return nodeResult(node, { status: 'CANCELLED', detail: 'ABORTED' });
    const r = await runAutonomousTask({
      root: ctx.root,
      agent,
      prompt: node.prompt,
      profile: node.profile,
      timeoutMs: node.timeout,
      signal: ctx.signal,
    });
    if (r.status !== 'QUEUED') {
      if (r.agent) report(ctx, { type: 'node-started', nodeId: node.id, kind: 'task', info: null });
      // Sérialisation prudente (tâche vague) allégée : le nœud n'a pas attendu ces clones en
      // échec — dit à l'écran et dans le résultat du nœud, jamais en silence.
      if (r.relaxedBlockers?.length) {
        report(ctx, {
          type: 'serialization-relaxed',
          nodeId: node.id,
          blockers: r.relaxedBlockers.map((b) => b.agent),
        });
      }
      const status: OrchestrationStatus =
        r.status === 'SESSION_FAILED' && r.session?.status === 'CANCELLED' ? 'CANCELLED' : r.status;
      const kept = !r.cleaned;
      const evidence = await buildEvidence(ctx.root, {
        objective: node.prompt,
        partial: partialEvidenceFromMerge(r.merge),
        verdicts: [],
        agent: r.agent,
        kept,
      });
      return nodeResult(node, {
        status,
        agent: r.agent,
        agents: r.agent ? [r.agent] : [],
        detail: r.keptCode ? `${r.keptCode}${r.keptDetail ? `:${r.keptDetail}` : ''}` : null,
        kept,
        merge: nodeMergeOf(r.merge),
        evidence,
        ...(r.relaxedBlockers?.length ? { relaxedBlockers: r.relaxedBlockers } : {}),
      });
    }
    const task = r.task;
    if (!task) return nodeResult(node, { status: 'SKIPPED', detail: 'ROUTER_COLLISION' });
    agent = task.agent;
    if (!(await removeTask(ctx.root, task.id))) {
      return nodeResult(node, {
        status: 'SKIPPED',
        detail: 'QUEUE_TOOK_OVER',
        agent,
        agents: [agent],
      });
    }
    if (ctx.settings.collisionPolicy === 'fail')
      return nodeResult(node, { status: 'SKIPPED', detail: 'ROUTER_COLLISION' });
    const blockers = task.collisions.map((c) => c.agent);
    report(ctx, { type: 'waiting', nodeId: node.id, reason: 'collision', ref: blockers.join(',') });
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
    if (outcome === 'aborted') return nodeResult(node, { status: 'CANCELLED', detail: 'ABORTED' });
    if (outcome === 'timeout')
      return nodeResult(node, { status: 'WAIT_TIMEOUT', detail: 'ROUTER_COLLISION' });
  }
}

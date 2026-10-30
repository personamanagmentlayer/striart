/**
 * Observabilité de bout en bout (lot O, priorité 6 du Run Manager) : relie
 *
 *   run_id → task_id (id de plan) → attempt → agent/session → commit_sha
 *
 * à partir de données déjà PERSISTÉES par les priorités précédentes (état
 * de run, evidence bundle, registre d'usage) — rien n'est mesuré ici,
 * seulement assemblé (`traceRun`, le fil d'UN run) et agrégé
 * (`buildObservabilityReport`, sur tous les runs retenus).
 *
 * Mesures délibérément absentes (honnêteté plutôt que précision fabriquée) :
 *  - coût PAR tâche : `evidence.usage` est un cumul à vie de l'agent (voir
 *    evidence.ts), pas une mesure isolée à un nœud — l'additionner sur
 *    plusieurs nœuds d'un même agent compterait plusieurs fois le même
 *    jeton. `avgCostPerMergedTask` ne divise donc que le total GLOBAL du
 *    registre, un ratio de portefeuille, jamais une attribution par tâche ;
 *  - rollbacks et défauts qui ont franchi les gates : aucun registre ne les
 *    compte aujourd'hui — pas de métrique inventée pour les représenter.
 */
import { StriartError } from '../errors.ts';
import { currentTotals } from '../tokens/ledger.ts';
import type {
  OrchestrationMode,
  OrchestrationStatus,
  PlanFailurePolicy,
  PlanNodeKind,
} from '../types.js';
import { SUCCESS } from './scheduler.ts';
import { listOrchestrationState, loadRunState } from './store.ts';

export interface RunTraceNode {
  taskId: string | null;
  kind: PlanNodeKind;
  state: 'pending' | 'running' | 'done' | 'skipped';
  status: OrchestrationStatus | null;
  /** Combième lancement réel — `null` tant que le nœud n'a pas encore de résultat. */
  attempt: number | null;
  agent: string | null;
  /** Journal de LA session (tâche autonome simple seulement — voir OrchestrationNodeResult). */
  sessionLogPath: string | null;
  commit: { sha: string; mergeSha: string; alreadyMerged?: boolean } | null;
  kept: boolean | null;
}

export interface RunTrace {
  runId: string;
  mode: OrchestrationMode;
  onFailure: PlanFailurePolicy;
  status: 'running' | 'done' | 'interrupted';
  /** Combien de fois ce run a été repris après une interruption (priorité 1). */
  resumeCount: number;
  startedAt: string;
  updatedAt: string;
  nodes: RunTraceNode[];
}

/** Assemble le fil complet d'UN run — lève `ORCHESTRATION_RUN_NOT_FOUND` comme `--resume`. */
export async function traceRun(root: string, runId: string): Promise<RunTrace> {
  const run = await loadRunState(root, runId);
  if (!run) {
    throw new StriartError(`Run introuvable : "${runId}".`, {
      code: 'ORCHESTRATION_RUN_NOT_FOUND',
      details: { runId },
      hint: 'striart status --json (section orchestration) pour lister les runs connus.',
    });
  }
  return {
    runId: run.id,
    mode: run.mode,
    onFailure: run.onFailure,
    status: run.status,
    resumeCount: run.resumeCount ?? 0,
    startedAt: run.startedAt,
    updatedAt: run.updatedAt,
    nodes: run.nodes.map((n) => ({
      taskId: n.id,
      kind: n.kind,
      state: n.state,
      status: n.status,
      attempt: n.result?.attempt ?? null,
      agent: n.agent,
      sessionLogPath: n.result?.sessionLogPath ?? null,
      commit: n.result?.merge ?? null,
      kept: n.result?.kept ?? null,
    })),
  };
}

export interface ObservabilityReport {
  /** Runs persistés retenus (`orchestration.keepRuns`) — pas un historique complet illimité. */
  totalRuns: number;
  totalNodes: number;
  /** Nœuds `done`/`skipped` — un nœud encore `pending`/`running` n'entre dans aucun taux. */
  terminalNodes: number;
  mergedNodes: number;
  /** `mergedNodes / terminalNodes`, `null` si aucun nœud terminal encore. */
  mergedTaskRate: number | null;
  /** Nœuds conservés pour décision humaine (`kept`) sur le total terminal. */
  humanInterventionRate: number | null;
  /** Runs effectivement repris au moins une fois (`resumeCount > 0`). */
  crashRecoveries: number;
  /** Dépense GLOBALE du registre (lot T) / nœuds réussis — un ratio de portefeuille, jamais une attribution par tâche. */
  avgCostPerMergedTask: number | null;
}

export async function buildObservabilityReport(root: string): Promise<ObservabilityReport> {
  const { runs } = await listOrchestrationState(root);
  let totalNodes = 0;
  let terminalNodes = 0;
  let mergedNodes = 0;
  let keptNodes = 0;
  let crashRecoveries = 0;
  for (const run of runs) {
    if ((run.resumeCount ?? 0) > 0) crashRecoveries += 1;
    for (const node of run.nodes) {
      totalNodes += 1;
      if (node.state !== 'done' && node.state !== 'skipped') continue;
      terminalNodes += 1;
      if (node.status && SUCCESS.has(node.status)) mergedNodes += 1;
      if (node.result?.kept) keptNodes += 1;
    }
  }
  const totals = await currentTotals(root);
  return {
    totalRuns: runs.length,
    totalNodes,
    terminalNodes,
    mergedNodes,
    mergedTaskRate: terminalNodes > 0 ? mergedNodes / terminalNodes : null,
    humanInterventionRate: terminalNodes > 0 ? keptNodes / terminalNodes : null,
    crashRecoveries,
    avgCostPerMergedTask: mergedNodes > 0 ? totals.global.costUsd / mergedNodes : null,
  };
}

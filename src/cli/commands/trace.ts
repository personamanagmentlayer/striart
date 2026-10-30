import { buildObservabilityReport, traceRun } from '../../orchestration/observability.ts';
import type { ObservabilityReport, RunTrace } from '../../orchestration/observability.ts';
import type { CommandModule } from '../context.ts';

export interface TraceInput {
  runId: string | null;
}

export type TraceData =
  { kind: 'run'; trace: RunTrace } | { kind: 'report'; report: ObservabilityReport };

/**
 * Observabilité de bout en bout (lot O, priorité 6) : avec un id de run,
 * le fil run_id → task_id → attempt → agent/session → commit_sha ; sans
 * id, le bilan agrégé sur les runs persistés (`orchestration.keepRuns`).
 */
export const trace: CommandModule<TraceInput, TraceData> = {
  async execute(ctx, input) {
    const root = await ctx.repoRoot();
    if (input.runId) {
      return { data: { kind: 'run', trace: await traceRun(root, input.runId) }, outcome: 'ok' };
    }
    return {
      data: { kind: 'report', report: await buildObservabilityReport(root) },
      outcome: 'ok',
    };
  },

  render(ctx, { data }) {
    const { out, m } = ctx;
    if (data.kind === 'report') {
      const r = data.report;
      if (r.totalRuns === 0) {
        out.line('info', m.trace.empty);
        return;
      }
      out.heading(m.trace.reportHeading);
      out.detail(m.trace.totalRuns(r.totalRuns));
      out.detail(m.trace.totalNodes(r.totalNodes, r.terminalNodes));
      out.detail(
        r.mergedTaskRate === null
          ? m.trace.mergedRateNone
          : m.trace.mergedRate(r.mergedNodes, r.terminalNodes, r.mergedTaskRate),
      );
      out.detail(
        r.humanInterventionRate === null
          ? m.trace.humanRateNone
          : m.trace.humanRate(r.humanInterventionRate),
      );
      out.detail(m.trace.crashRecoveries(r.crashRecoveries));
      out.detail(
        r.avgCostPerMergedTask === null
          ? m.trace.avgCostNone
          : m.trace.avgCost(r.avgCostPerMergedTask),
      );
      out.hint('striart trace <run-id>');
      return;
    }
    const t = data.trace;
    out.heading(m.trace.runHeading(t.runId, t.status));
    out.detail(m.trace.runMeta(t.mode, t.resumeCount));
    out.table(
      [
        {
          key: 'task',
          header: m.trace.colTask,
          value: (n) => n.taskId ?? m.plan.derivedName,
          priority: 9,
        },
        { key: 'kind', header: m.trace.colKind, value: (n) => m.plan.kind(n.kind), priority: 6 },
        {
          key: 'status',
          header: m.trace.colStatus,
          value: (n) => n.status ?? n.state,
          priority: 8,
        },
        {
          key: 'attempt',
          header: m.trace.colAttempt,
          value: (n) => (n.attempt === null ? '' : String(n.attempt)),
          priority: 4,
        },
        {
          key: 'agent',
          header: m.trace.colAgent,
          value: (n) => (n.agent ? out.untrusted(n.agent) : ''),
          priority: 7,
        },
        {
          key: 'commit',
          header: m.trace.colCommit,
          value: (n) => (n.commit ? n.commit.sha.slice(0, 10) : ''),
          priority: 5,
          shrink: { min: 10 },
        },
      ],
      t.nodes,
    );
    for (const n of t.nodes) {
      if (n.sessionLogPath)
        out.detail(m.trace.sessionLog(n.taskId ?? m.plan.derivedName, n.sessionLogPath));
    }
  },
};

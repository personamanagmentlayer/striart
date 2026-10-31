import { StriartError } from '../../errors.ts';
import { loadConfig } from '../../config.ts';
import { parsePlan } from '../../plan.ts';
import { runWorker } from '../../orchestration/scheduler.ts';
import { traceRun } from '../../orchestration/observability.ts';
import type { RunTrace } from '../../orchestration/observability.ts';
import type { AttendedSession } from '../../pty-host.ts';
import type { CommandModule } from '../context.ts';
import { progressRenderer, readPlan } from './plan.ts';
import { renderRunTrace } from './trace.ts';

export interface WorkInput {
  file: string;
  runId: string | null;
}

export interface WorkData {
  file: string;
  runId: string;
  joined: boolean;
  claimed: number;
  interrupted: boolean;
  allDone: boolean;
  /** Tracé complet (priorité 6), seulement quand `allDone` : le run entier est connu. */
  trace: RunTrace | null;
}

const SUCCESS = new Set(['MERGED', 'FINISHED']);

/**
 * Worker coopératif (lot O, priorité 7) : s'attache à un run existant
 * (`--run`) ou en crée un, puis réclame et exécute des nœuds un par un
 * jusqu'à épuisement — plusieurs `striart work` lancés en parallèle sur le
 * MÊME `--run` coopèrent sans jamais exécuter un nœud deux fois (voir
 * docs/{en,fr}/plans.md). Ne lance RIEN d'autre que des agents déjà prévus
 * par le plan : aucun protocole réseau, aucun dépôt distinct.
 */
export const work: CommandModule<WorkInput, WorkData> = {
  async execute(ctx, input) {
    const root = await ctx.repoRoot();
    const { absolute, text } = await readPlan(ctx, input.file);
    const plan = parsePlan(text);
    if (plan.version !== 2) {
      throw new StriartError('Plan invalide : "striart work" exige un plan "version: 2".', {
        code: 'PLAN_INVALID',
        hint: 'striart plan <fichier> --dry-run',
        details: { reason: 'WORKER_NEEDS_V2' },
      });
    }
    const config = await loadConfig(root);
    const sessions: Record<string, AttendedSession> = {};
    const failures: Array<{ agent: string; code: string; message: string }> = [];
    const progress = progressRenderer(ctx, root, sessions, (failure) => failures.push(failure));
    const result = await ctx.out.task(ctx.m.work.running, () =>
      runWorker({
        root,
        plan,
        config,
        runId: input.runId,
        signal: ctx.signal,
        onProgress: progress.render,
      }),
    );
    await progress.settle();
    const trace = result.allDone ? await traceRun(root, result.runId) : null;
    const planFailed = Boolean(trace?.nodes.some((n) => n.status && !SUCCESS.has(n.status)));
    return {
      data: { file: absolute, ...result, trace },
      outcome:
        failures.length > 0 || result.interrupted || planFailed
          ? ('failed' as const)
          : ('ok' as const),
    };
  },

  render(ctx, { data }) {
    const { out, m } = ctx;
    out.detail(m.work.runId(data.runId, data.joined));
    out.line(
      data.interrupted ? 'warn' : 'ok',
      m.work.claimed(data.claimed, data.interrupted, data.allDone),
    );
    if (data.trace) {
      renderRunTrace(ctx, data.trace);
    } else {
      out.hint(`striart work ${data.file} --run ${data.runId}`);
    }
  },
};

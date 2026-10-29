import { reconcile as reconcileState } from '../../orchestrator.ts';
import type { AttendedSession } from '../../pty-host.ts';
import type { CommandModule } from '../context.ts';
import { renderStartedTasks, withSessions } from './queue.ts';

type ReconcileResult = Awaited<ReturnType<typeof reconcileState>>;

export interface ReconcileData {
  sessionPidsCleared: ReconcileResult['sessionPidsCleared'];
  started: Array<ReconcileResult['started'][number] & { session: AttendedSession }>;
  stillWaiting: ReconcileResult['stillWaiting'];
}

export const reconcile: CommandModule<Record<string, never>, ReconcileData> = {
  async execute(ctx) {
    const root = await ctx.repoRoot();
    const result = await ctx.out.task(ctx.m.reconcile.running, () => reconcileState({ root }));
    return {
      data: {
        sessionPidsCleared: result.sessionPidsCleared,
        started: await withSessions(root, result.started),
        stillWaiting: result.stillWaiting,
      },
      outcome: 'ok',
    };
  },

  render(ctx, { data }) {
    const { out, m } = ctx;
    if (data.sessionPidsCleared.length > 0) {
      out.line('ok', m.reconcile.cleared(data.sessionPidsCleared.join(', ')));
    }
    renderStartedTasks(out, data.started);
    if (data.stillWaiting.length > 0) {
      out.line('info', m.reconcile.stillWaiting(data.stillWaiting.length));
      out.hint('striart queue');
    }
    if (data.sessionPidsCleared.length === 0 && data.started.length === 0) {
      out.line('ok', m.reconcile.nothing);
    }
  },
};

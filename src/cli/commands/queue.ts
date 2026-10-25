import { assertInitialized } from '../../clone.js';
import { getQueueDashboard, retryQueue } from '../../orchestrator.js';
import { openAttendedSession } from '../../pty-host.ts';
import type { AttendedSession } from '../../pty-host.ts';
import type { CommandModule, Ctx } from '../context.ts';
import type { Output } from '../output.ts';
import { renderStartedAgent } from './start.ts';

export interface QueueInput {
  retry: boolean;
}

type QueueRow = Awaited<ReturnType<typeof getQueueDashboard>>[number];
type RetryResult = Awaited<ReturnType<typeof retryQueue>>;
type StartedTask = RetryResult['started'][number];

export type QueueData =
  | { action: 'list'; tasks: QueueRow[] }
  | {
      action: 'retry';
      started: Array<StartedTask & { session: AttendedSession }>;
      stillWaiting: RetryResult['stillWaiting'];
    };

/** Prépare la session supervisée de chaque tâche que la file vient de démarrer. */
export async function withSessions(root: string, started: StartedTask[]) {
  const out: Array<StartedTask & { session: AttendedSession }> = [];
  for (const entry of started)
    out.push({ ...entry, session: await openAttendedSession(root, entry.info) });
  return out;
}

export function renderStartedTasks(
  out: Output,
  started: Array<StartedTask & { session: AttendedSession }>,
) {
  for (const { task, info, session } of started) {
    out.line('ok', out.m.queue.unblocked(task.id, task.agent));
    renderStartedAgent(out, info, session);
  }
}

export const queue: CommandModule<QueueInput, QueueData> = {
  async execute(ctx: Ctx, input) {
    const root = await ctx.repoRoot();
    await assertInitialized(root);
    if (input.retry) {
      const { started, stillWaiting } = await ctx.out.task(ctx.m.queue.retrying, () =>
        retryQueue({ root }),
      );
      return {
        data: { action: 'retry', started: await withSessions(root, started), stillWaiting },
        outcome: 'ok',
      };
    }
    return { data: { action: 'list', tasks: await getQueueDashboard({ root }) }, outcome: 'ok' };
  },

  render(ctx, { data }) {
    const { out, m } = ctx;
    if (data.action === 'retry') {
      renderStartedTasks(out, data.started);
      if (data.started.length === 0) out.line('info', m.queue.nothingUnblocked);
      for (const task of data.stillWaiting) {
        const why = task.blockedReason
          ? m.queue.blockedReason(task.blockedReason)
          : m.queue.stillBlocked;
        out.line('info', `${out.untrusted(task.id)} (${out.untrusted(task.agent)}) : ${why}`);
      }
      return;
    }
    if (data.tasks.length === 0) {
      out.line('info', m.queue.empty);
      out.hint('striart run --agent <agent> "<tâche>"');
      return;
    }
    out.table<QueueRow>(
      [
        { key: 'id', header: m.queue.colTask, value: (r) => r.id, priority: 9 },
        { key: 'agent', header: m.queue.colAgent, value: (r) => r.agent, priority: 10 },
        {
          key: 'state',
          header: m.queue.colState,
          value: (r) => r.status,
          style: (text, r) =>
            out.style(r.status === 'RUNNING' ? 'ok' : r.ready ? 'info' : 'warn', text),
          priority: 8,
        },
        {
          key: 'why',
          header: m.queue.colWhy,
          value: (r) => queueReason(out, r),
          priority: 7,
          shrink: { min: 16 },
        },
        {
          key: 'files',
          header: m.queue.colFiles,
          value: (r) => r.files.join(', '),
          priority: 3,
          shrink: { min: 12 },
        },
      ],
      data.tasks,
    );
    if (data.tasks.some((r) => r.status === 'WAITING' && r.ready)) {
      out.print();
      out.line('info', m.queue.readyHint);
      out.hint('striart queue --retry');
    }
  },
};

function queueReason(out: Output, row: QueueRow): string {
  const { m } = out;
  if (row.status === 'RUNNING') return m.queue.running;
  const reasons: string[] = [];
  for (const b of row.blockedBy) reasons.push(m.queue.blockedBy(b.agent, b.files.join(', ')));
  if (row.after) reasons.push(m.queue.after(row.after));
  if (reasons.length === 0) return m.queue.ready;
  return reasons.join(' ; ');
}

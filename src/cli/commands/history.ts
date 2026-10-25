import { listMergeHistory } from '../../history.js';
import type { CommandModule } from '../context.ts';

export interface HistoryInput {
  limit: number;
}

type Entry = Awaited<ReturnType<typeof listMergeHistory>>[number];

export interface HistoryData {
  history: Entry[];
}

export const history: CommandModule<HistoryInput, HistoryData> = {
  async execute(ctx, input) {
    const root = await ctx.repoRoot();
    return {
      data: { history: await listMergeHistory({ root, limit: input.limit }) },
      outcome: 'ok',
    };
  },

  render(ctx, { data }) {
    const { out, m } = ctx;
    if (data.history.length === 0) {
      out.line('info', m.history.empty);
      return;
    }
    out.table<Entry>(
      [
        { key: 'date', header: m.history.colDate, value: (e) => out.date(e.date), priority: 8 },
        {
          key: 'type',
          header: m.history.colType,
          value: (e) => m.history.type(e.type),
          style: (text, e) => out.style(e.type === 'rollback' ? 'warn' : 'ok', text),
          priority: 9,
        },
        { key: 'agent', header: m.history.colAgent, value: (e) => e.agent, priority: 10 },
        { key: 'merge', header: m.history.colMerge, value: (e) => out.sha(e.sha), priority: 7 },
        {
          key: 'commit',
          header: m.history.colAgentCommit,
          value: (e) => e.agentSha ?? '',
          priority: 4,
        },
        {
          key: 'resolution',
          header: m.history.colResolution,
          value: (e) =>
            e.type === 'rollback'
              ? ''
              : m.history.resolution(e.resolution, e.ticketId, e.semanticFiles),
          priority: 5,
          shrink: { min: 10 },
        },
      ],
      data.history,
    );
  },
};

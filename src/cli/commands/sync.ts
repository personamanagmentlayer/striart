import { syncAgentWithMain, syncAllAgents } from '../../orchestrator.js';
import type { SyncResult } from '../../types.js';
import type { CommandModule } from '../context.ts';
import { syncOutcome, worstOutcome } from '../exit.ts';
import { renderSyncResult } from '../render/results.ts';

export interface SyncInput {
  agent: string | null;
}

export interface SyncData {
  results: SyncResult[];
}

export const sync: CommandModule<SyncInput, SyncData> = {
  async execute(ctx, input) {
    const root = await ctx.repoRoot();
    const results = input.agent
      ? [
          await ctx.out.task(ctx.m.sync.running(input.agent), () =>
            syncAgentWithMain({ root, agent: input.agent }),
          ),
        ]
      : await ctx.out.task(ctx.m.sync.runningAll, () => syncAllAgents({ root }));
    return { data: { results }, outcome: worstOutcome(results.map((r) => syncOutcome(r.status))) };
  },

  render(ctx, { data }) {
    if (data.results.length === 0) {
      ctx.out.line('info', ctx.m.sync.noAgents);
      return;
    }
    for (const result of data.results) renderSyncResult(ctx.out, result);
  },
};

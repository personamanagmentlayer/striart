import { rollbackLastMerge } from '../../orchestrator.ts';
import type { RollbackResult } from '../../types.js';
import type { CommandModule, CommandResult, Ctx } from '../context.ts';

export const rollback: CommandModule<Record<string, never>, RollbackResult> = {
  async execute(ctx: Ctx): Promise<CommandResult<RollbackResult>> {
    const root = await ctx.repoRoot();
    const result = await ctx.out.task(ctx.m.rollback.running, () => rollbackLastMerge({ root }));
    return { data: result, outcome: 'ok' };
  },

  render(ctx, { data }) {
    const { out, m } = ctx;
    if (data.mode === 'reset') {
      out.line('ok', m.rollback.reset(data.agent, out.sha(data.undoneSha), out.sha(data.newHead)));
      out.detail(
        data.agentResynced ? m.rollback.resynced(data.agent) : m.rollback.notResynced(data.agent),
      );
      out.detail(m.rollback.reflog);
      return;
    }
    out.line('ok', m.rollback.revert(data.agent, out.sha(data.newHead)));
    out.line('warn', m.rollback.doNotRemerge(data.agent));
  },
};

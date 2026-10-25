import { promoteStaging } from '../../orchestrator.js';
import type { PromoteResult } from '../../types.js';
import type { CommandModule } from '../context.ts';
import { promoteOutcome } from '../exit.ts';
import { renderTicketLocation } from '../render/results.ts';

export interface PromoteInput {
  rollback: boolean;
}

export const promote: CommandModule<PromoteInput, PromoteResult> = {
  async execute(ctx, input) {
    const root = await ctx.repoRoot();
    const result = await ctx.out.task(ctx.m.promote.running, () =>
      promoteStaging({ root, rollback: input.rollback }),
    );
    return { data: result, outcome: promoteOutcome(result.status) };
  },

  render(ctx, { data }) {
    const { out, m } = ctx;
    switch (data.status) {
      case 'UP_TO_DATE':
        out.line('ok', m.promote.upToDate);
        return;
      case 'PROMOTED':
        out.line('ok', m.promote.promoted(data.commits, out.sha(data.sha)));
        if (data.pushError) out.line('warn', m.merge.pushFailed(out.untrusted(data.pushError)));
        return;
      case 'GATE_FAILED':
        out.line('error', m.promote.gateFailed(data.gate.exitCode ?? null));
        renderTicketLocation(out, data.ticket);
        if (data.rolledBack) out.detail(m.promote.rolledBack);
        else {
          out.detail(m.promote.stagingKept);
          out.hint('striart promote --rollback');
        }
        return;
    }
  },
};

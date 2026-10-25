import { mergeAgentCommit } from '../../orchestrator.js';
import type { MergeResult } from '../../types.js';
import type { CommandModule } from '../context.ts';
import { mergeOutcome } from '../exit.ts';
import { renderMergeResult } from '../render/results.ts';

export interface MergeInput {
  agent: string;
}

/** Conflit ou Test Gate rouge → sortie 3 : `striart merge a && deploy` ne déploie jamais un gate rouge. */
export const merge: CommandModule<MergeInput, MergeResult> = {
  async execute(ctx, input) {
    const root = await ctx.repoRoot();
    const result = await ctx.out.task(ctx.m.merge.running(input.agent), () =>
      mergeAgentCommit({ root, agent: input.agent }),
    );
    return { data: result, outcome: mergeOutcome(result.status) };
  },

  render(ctx, { data }) {
    renderMergeResult(ctx.out, data);
  },
};

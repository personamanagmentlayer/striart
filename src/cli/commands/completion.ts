import type { Command } from 'commander';
import { completionScript } from '../completion.ts';
import type { Shell } from '../completion.ts';
import type { CommandModule } from '../context.ts';

export interface CompletionInput {
  shell: Shell;
  program: Command;
}

/** Script de complétion sur stdout (à rediriger dans le profil du shell). */
export const completion: CommandModule<CompletionInput, { shell: Shell; script: string }> = {
  async execute(ctx, input) {
    return {
      data: { shell: input.shell, script: completionScript(input.shell, input.program, ctx.m) },
      outcome: 'ok',
    };
  },

  render(ctx, { data }) {
    ctx.out.print(data.script.trimEnd());
  },
};

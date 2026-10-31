import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { loadConfig } from '../../config.ts';
import { StriartError } from '../../errors.ts';
import { draftPlan } from '../../orchestration/planner.ts';
import type { CommandModule } from '../context.ts';

export interface DraftInput {
  objective: string;
  out: string | null;
}

export interface DraftData {
  file: string;
  tasks: number;
  estimatedPromptTokens: number;
  notes: string[];
}

function defaultOutPath(): string {
  const stamp = new Date()
    .toISOString()
    .replace(/[^0-9]/g, '')
    .slice(0, 14);
  return `striart-draft-${stamp}.yaml`;
}

/**
 * Planner (lot O, priorité 3) : écrit un plan v2 proposé pour un objectif —
 * ne lance RIEN. L'humain relit le fichier, puis l'applique lui-même
 * (`striart plan <fichier> --dry-run`, puis `striart plan <fichier>`) :
 * deux étapes séparées, jamais une exécution automatique du résultat.
 */
export const draft: CommandModule<DraftInput, DraftData> = {
  async execute(ctx, input) {
    const root = await ctx.repoRoot();
    const config = await loadConfig(root);
    const result = await ctx.out.task(ctx.m.draft.running, () =>
      draftPlan({ root, config, objective: input.objective, signal: ctx.signal }),
    );
    const relative = input.out ?? defaultOutPath();
    const absolute = path.resolve(ctx.cwd, relative);
    try {
      await writeFile(absolute, result.yaml, { encoding: 'utf8', flag: 'wx' });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        throw new StriartError(ctx.m.draft.fileExists(relative), {
          code: 'DRAFT_FILE_EXISTS',
          hint: 'striart draft "<objective>" --out <another-file>',
          details: { file: relative },
        });
      }
      throw error;
    }
    return {
      data: {
        file: absolute,
        tasks: result.estimate.tasks,
        estimatedPromptTokens: result.estimate.estimatedPromptTokens,
        notes: result.notes,
      },
      outcome: 'ok',
    };
  },

  render(ctx, { data }) {
    const { out, m, cwd } = ctx;
    const shown = path.relative(cwd, data.file) || data.file;
    out.line('ok', m.draft.written(shown, data.tasks, data.estimatedPromptTokens));
    for (const note of data.notes) out.line('warn', m.draft.note(out.untrusted(note)));
    out.hint(`striart plan ${shown} --dry-run`);
  },
};

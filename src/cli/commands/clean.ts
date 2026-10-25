import { cleanClones } from '../../clone.js';
import type { CommandModule } from '../context.ts';

export interface CleanInput {
  agent: string | null;
  all: boolean;
  force: boolean;
}

type CleanResult = Awaited<ReturnType<typeof cleanClones>>;
type SkipReason = CleanResult['skipped'][number]['reason'];

export type CleanData = CleanResult;

/**
 * Sortie 3 quand un agent NOMMÉ explicitement n'a pas été supprimé : une
 * garde l'a protégé et l'intention de l'appelant n'est pas atteinte. Sans
 * cible explicite, un clone protégé est le fonctionnement normal (sortie 0).
 */
export const clean: CommandModule<CleanInput, CleanData> = {
  async execute(ctx, input) {
    const root = await ctx.repoRoot();
    const result = await ctx.out.task(ctx.m.clean.running, () =>
      cleanClones({ root, agent: input.agent, all: input.all, force: input.force }),
    );
    const refused =
      input.agent !== null && result.removed.length === 0 && result.skipped.length > 0;
    return {
      data: result,
      outcome: refused ? 'refused' : 'ok',
      warnings: result.artifactErrors.map((failure) => ({
        code: 'AGENT_ARTIFACT_FAILED',
        message: ctx.m.clean.artifactFailed(failure.name, failure.what, failure.message),
      })),
    };
  },

  render(ctx, { data }) {
    const { out, m } = ctx;
    for (const r of data.removed) {
      out.line('ok', m.clean.removed(r.name, out.bytes(r.freedBytes), r.wasActive));
    }
    for (const s of data.skipped) {
      out.line(
        s.reason === 'SESSION_LIVE' ? 'warn' : 'info',
        m.clean.skipped(s.name, s.reason),
        skipHint(s.name, s.reason),
      );
    }
    if (data.removed.length === 0 && data.skipped.length === 0) out.line('ok', m.clean.nothing);
    if (data.removed.length > 1) {
      out.line(
        'ok',
        m.clean.total(out.bytes(data.removed.reduce((sum, r) => sum + r.freedBytes, 0))),
      );
    }
  },
};

function skipHint(name: string, reason: SkipReason): string | null {
  switch (reason) {
    case 'ACTIVE':
      return `striart clean ${name} --all`;
    case 'PENDING':
      return `striart merge ${name}`;
    case 'IN_USE':
      return `striart clean ${name} --force`;
    case 'SESSION_LIVE':
      return `striart stop ${name}`;
    default:
      return null;
  }
}

import { pruneWorkspace } from '../../prune.ts';
import type { CommandModule } from '../context.ts';

export interface PruneInput {
  days: number | null;
  dryRun: boolean;
}

export type PruneData = Awaited<ReturnType<typeof pruneWorkspace>>;

export const prune: CommandModule<PruneInput, PruneData> = {
  async execute(ctx, input) {
    const root = await ctx.repoRoot();
    const result = await ctx.out.task(ctx.m.prune.running, () =>
      pruneWorkspace({ root, days: input.days, dryRun: input.dryRun }),
    );
    // Une suppression en échec (handle tenu sous Windows…) n'est jamais un
    // succès silencieux : le document la porte (`failed`), la sortie est 1.
    return { data: result, outcome: result.failed.length > 0 ? 'failed' : 'ok' };
  },

  render(ctx, { data }) {
    const { out, m } = ctx;
    for (const c of data.clones.removed) {
      out.line(
        'ok',
        m.prune.cloneRemoved(
          c.name,
          out.date(c.lastActivity),
          out.bytes(c.freedBytes),
          data.dryRun,
        ),
      );
    }
    for (const c of data.clones.kept) {
      out.line(
        'info',
        `${m.prune.cloneKept(c.name, out.date(c.lastActivity))}${
          c.reason ? ` ${m.prune.keptReason(c.reason)}` : ''
        }`,
      );
    }
    for (const f of data.failed) {
      out.line(
        'error',
        m.prune.failed(f.kind, out.untrusted(f.name), out.untrusted(f.cause)),
        f.kind === 'clone' ? 'striart reconcile' : null,
      );
    }
    for (const t of data.tickets.removed)
      out.line('ok', m.prune.ticketRemoved(t.id, out.date(t.resolvedAt), data.dryRun));
    if (data.clones.removed.length === 0 && data.tickets.removed.length === 0) {
      if (data.failed.length === 0) out.line('ok', m.prune.nothing(data.retentionDays));
      return;
    }
    out.line('ok', m.prune.total(out.bytes(data.freedBytes), data.retentionDays, data.dryRun));
    if (data.dryRun) out.hint(`striart prune --days ${data.retentionDays}`);
  },
};

import { assertInitialized } from '../../clone.ts';
import { sweepIdle } from '../../idle/sweep.ts';
import type { SweepReport } from '../../idle/sweep.ts';
import type { CommandModule } from '../context.ts';

export interface GcInput {
  agent: string | null;
  close: boolean;
  dryRun: boolean;
}

export type GcData = SweepReport;

export const gc: CommandModule<GcInput, GcData> = {
  async execute(ctx, input) {
    const root = await ctx.repoRoot();
    await assertInitialized(root);
    const report = await ctx.out.task(ctx.m.gc.running, () =>
      sweepIdle({ root, agent: input.agent, close: input.close, dryRun: input.dryRun }),
    );
    // Une fermeture ratée est un échec (1) ; une fermeture REFUSÉE par une garde est un refus (3) :
    // la session est intacte, relancer telle quelle ne changera rien. Jamais un succès silencieux.
    const failed = report.refused.some((r) => r.code === 'IDLE_CLOSE_FAILED');
    const outcome = failed ? 'failed' : report.refused.length > 0 ? 'refused' : 'ok';
    return { data: report, outcome };
  },

  render(ctx, { data }) {
    const { out, m } = ctx;
    if (!data.enabled) {
      out.line('warn', m.gc.disabled);
      return;
    }
    if (data.agents.length === 0) {
      out.line('ok', m.gc.nothing);
      return;
    }
    if (data.suspended) out.line('info', m.gc.holds('SUSPENDED'));
    if (data.holds.length > 0) out.line('warn', m.gc.holds(data.holds.join(', ')));
    if (data.authorizationError)
      out.line('warn', m.gc.authorizationError(out.untrusted(data.authorizationError)));

    let idle = 0;
    for (const a of data.agents) {
      if (a.state === 'idle') idle += 1;
      const level = a.state === 'active' ? 'info' : a.state === 'protected' ? 'info' : 'warn';
      out.line(
        level,
        m.gc.agentLine(
          a.agent,
          m.gc.stage[a.stage] ?? a.stage,
          a.idleMs === null ? null : out.duration(a.idleMs),
          m.gc.session[a.session] ?? a.session,
          a.host,
        ),
      );
      if (a.blockers.length > 0) out.detail(m.gc.blockedBy(a.blockers.join(', ')));
      else if (a.state === 'active' && a.reasons.length > 0)
        out.detail(m.gc.reasons(a.reasons.join(', ')));
      if (a.state === 'idle' && a.session === 'live') {
        if (a.plan === 'warn' && data.dryRun) out.detail(m.gc.wouldWarn(a.agent));
        if (a.plan === 'close' && data.dryRun) out.detail(m.gc.wouldClose(a.agent));
        if (a.closeNotBefore && a.plan !== 'close')
          out.detail(m.gc.closeNotBefore(out.date(a.closeNotBefore)));
        const blocked = a.closeBlockedBy.filter(
          (code) => !['NOT_WARNED', 'ACTION_REPORT', 'ACTION_WARN', 'GRACE_RUNNING'].includes(code),
        );
        if (a.plan !== 'close' && blocked.length > 0)
          out.detail(m.gc.closeBlocked(blocked.join(', ')));
      }
    }
    for (const agent of data.warned) out.line('warn', m.gc.warned(agent));
    for (const c of data.closed) out.line('ok', m.gc.closed(c.agent, c.host, c.code));
    for (const r of data.refused) {
      out.line(
        'error',
        m.gc.refused(r.agent, r.code, r.detail === null ? null : out.untrusted(r.detail)),
      );
    }
    if (!data.closeAuthorized && data.action === 'close') out.line('warn', m.gc.notAuthorized);

    const toWarn = data.agents.filter((a) => a.plan === 'warn').length;
    const toClose = data.agents.filter((a) => a.plan === 'close').length;
    out.line(
      'info',
      m.gc.summary(
        idle,
        data.dryRun ? toWarn : data.warned.length,
        data.dryRun ? toClose : data.closed.length,
        data.dryRun,
      ),
    );
    if (data.dryRun && toWarn + toClose > 0) out.hint('striart gc');
  },
};

import { loadConfig } from '../../config.ts';
import { StriartError } from '../../errors.ts';
import { USAGE_ROLES } from '../../tokens/ledger.ts';
import { type UsageReport, type UsageRow, buildUsageReport } from '../../tokens/report.ts';
import type { UsageRole } from '../../types.js';
import type { CommandModule } from '../context.ts';

export interface UsageInput {
  since: string | null;
  until: string | null;
  role: string | null;
  agent: string | null;
  task: string | null;
}

export type UsageData = UsageReport;

export const usage: CommandModule<UsageInput, UsageData> = {
  async execute(ctx, input) {
    const root = await ctx.repoRoot();
    if (input.role !== null && !USAGE_ROLES.includes(input.role as UsageRole)) {
      throw new StriartError(ctx.m.usage.unknownRole(input.role, USAGE_ROLES.join(', ')), {
        code: 'INVALID_ARGUMENT',
        hint: 'striart usage --role merger',
        details: { option: 'role', value: input.role, allowed: [...USAGE_ROLES] },
      });
    }
    const config = await loadConfig(root);
    const report = await buildUsageReport(root, config, {
      since: input.since,
      until: input.until,
      role: input.role as UsageRole | null,
      agent: input.agent,
      taskId: input.task,
    });
    return { data: report, outcome: 'ok' };
  },

  render(ctx, { data }) {
    const { out, m } = ctx;
    if (data.total.calls === 0 && data.total.resultCacheHits === 0 && data.total.refused === 0) {
      out.line('info', m.usage.empty);
      if (data.skippedLines > 0) out.line('warn', m.usage.skipped(data.skippedLines));
      return;
    }
    const fmt = (n: number) => new Intl.NumberFormat('en-US').format(n);
    const cost = (row: UsageRow) => (row.costUsd === null ? m.usage.none : row.costUsd.toFixed(4));
    const section = (title: string, rows: UsageRow[]) => {
      if (rows.length === 0) return;
      out.heading(title);
      out.table<UsageRow>(
        [
          {
            key: 'key',
            header: m.usage.colKey,
            value: (r) => r.key,
            priority: 10,
            shrink: { min: 12 },
          },
          { key: 'calls', header: m.usage.colCalls, value: (r) => fmt(r.calls), priority: 6 },
          { key: 'input', header: m.usage.colInput, value: (r) => fmt(r.input), priority: 5 },
          { key: 'output', header: m.usage.colOutput, value: (r) => fmt(r.output), priority: 5 },
          { key: 'cache', header: m.usage.colCache, value: (r) => fmt(r.cacheRead), priority: 3 },
          { key: 'tokens', header: m.usage.colTokens, value: (r) => fmt(r.tokens), priority: 9 },
          { key: 'cost', header: m.usage.colCost, value: cost, priority: 8 },
        ],
        rows,
      );
    };
    section(
      m.usage.byRole,
      [data.total, ...data.byRole].map((r, i) => (i === 0 ? { ...r, key: 'TOTAL' } : r)),
    );
    section(m.usage.byAgent, data.byAgent);
    section(m.usage.byTask, data.byTask.slice(0, 20));
    section(m.usage.byModel, data.byModel);
    if (data.byDay.length > 1) section(m.usage.byDay, data.byDay);

    if (data.total.unpricedCalls > 0) out.line('warn', m.usage.unpriced(data.total.unpricedCalls));
    if (data.total.estimatedCalls > 0)
      out.line('info', m.usage.estimated(data.total.estimatedCalls));
    if (data.total.unmeteredSessions > 0) {
      out.line('info', m.usage.unmetered(data.total.unmeteredSessions));
    }
    if (data.cache.promptHitRate !== null) {
      out.line('info', m.usage.promptCache(`${(data.cache.promptHitRate * 100).toFixed(1)} %`));
    }
    if (data.cache.resultCacheEligible > 0) {
      out.line(
        'info',
        m.usage.resultCache(data.cache.resultCacheHits, data.cache.resultCacheEligible),
      );
    }
    if (data.instructions.lastTokens !== null) {
      out.line('info', m.usage.instructions(data.instructions.lastTokens));
    }
    if (data.skippedLines > 0) out.line('warn', m.usage.skipped(data.skippedLines));
  },
};

import { collectStatus } from '../../status.ts';
import type { CommandModule } from '../context.ts';
import type { Level } from '../output.ts';

export type StatusData = Awaited<ReturnType<typeof collectStatus>>;
type Agent = StatusData['agents'][number];

export const status: CommandModule<Record<string, never>, StatusData> = {
  async execute(ctx) {
    const root = await ctx.repoRoot();
    return { data: await collectStatus(root), outcome: 'ok' };
  },

  render(ctx, { data }) {
    const { out, m } = ctx;
    if (data.agents.length === 0) {
      out.line('info', m.status.empty);
      out.hint('striart start <agent>');
    } else {
      const stateLevel = (a: Agent): Level =>
        a.status === 'ACTIVE' ? 'ok' : a.status === 'REMOVING' ? 'warn' : 'error';
      out.table<Agent>(
        [
          { key: 'agent', header: m.status.colAgent, value: (a) => a.name, priority: 10 },
          {
            key: 'state',
            header: m.status.colState,
            value: (a) => a.status,
            style: (text, a) => out.style(stateLevel(a), text),
            priority: 9,
          },
          {
            key: 'mode',
            header: m.status.colMode,
            value: (a) => m.common.mode(a.mode ?? 'attended', a.profile),
            priority: 6,
          },
          {
            key: 'session',
            header: m.status.colSession,
            value: (a) => m.status.session(a.session ?? null),
            priority: 8,
          },
          {
            key: 'pending',
            header: m.status.colPending,
            value: (a) => String(a.pendingCommits),
            priority: 7,
          },
          {
            key: 'branch',
            header: m.status.colBranch,
            value: (a) => a.currentBranch ?? a.branch,
            priority: 3,
            shrink: { min: 12 },
          },
          { key: 'tool', header: m.status.colTool, value: (a) => a.command ?? '', priority: 2 },
          {
            key: 'size',
            header: m.status.colSize,
            value: (a) => (a.sizeBytes != null ? out.bytes(a.sizeBytes) : ''),
            priority: 1,
          },
          {
            key: 'last',
            header: m.status.colLastCommit,
            value: (a) =>
              a.status === 'ACTIVE'
                ? (a.lastMessage ?? '').split('\n')[0]
                : m.status.brokenDetail(a.status),
            priority: 4,
            shrink: { min: 14 },
          },
        ],
        data.agents,
      );
    }

    // « À traiter » : tout ce qui attend un humain, au même endroit (avant la
    // 0.11, il fallait le chercher dans quatre commandes différentes).
    const items: Array<{ level: Level; text: string; hint: string | null }> = [];
    for (const a of data.agents.filter((x) => x.status === 'MISSING')) {
      items.push({
        level: 'error',
        text: m.status.missing(a.name),
        hint: `striart stop ${a.name}`,
      });
    }
    if (data.tickets.length > 0) {
      items.push({
        level: 'error',
        text: m.status.tickets(data.tickets.length),
        hint: 'striart resolve',
      });
    }
    if (data.state.manualMode) {
      items.push({ level: 'warn', text: m.status.manualMode, hint: 'striart resolve --unlock' });
    }
    if (data.mainSession?.alive) {
      items.push({
        level: 'warn',
        text: m.status.mainSession(
          out.untrusted(data.mainSession.reason),
          data.mainSession.pid,
          out.since(data.mainSession.startedAt),
        ),
        hint: 'striart lock --stop',
      });
    }
    // Lot O : une relecture humaine en attente bloque une orchestration.
    const pendingReviews = (data.orchestration?.reviews ?? []).filter(
      (r) => r.status === 'PENDING' && r.alive,
    );
    if (pendingReviews.length > 0) {
      items.push({
        level: 'warn',
        text: m.status.humanReviews(pendingReviews.length),
        hint: 'striart review',
      });
    }
    const runs = data.orchestration?.runs ?? [];
    const live = runs.filter((r) => r.status === 'running' && r.alive).length;
    if (live > 0) items.push({ level: 'info', text: m.status.orchestrations(live), hint: null });
    const orphans = runs.filter((r) => r.status === 'running' && !r.alive).length;
    if (orphans > 0) {
      items.push({
        level: 'warn',
        text: m.status.orphanRuns(orphans),
        hint: 'striart status --json',
      });
    }
    const waiting = data.queue.filter((t) => t.status === 'WAITING');
    const ready = waiting.filter((t) => t.ready);
    if (ready.length > 0)
      items.push({
        level: 'info',
        text: m.status.ready(ready.length),
        hint: 'striart queue --retry',
      });
    if (waiting.length > ready.length) {
      items.push({
        level: 'info',
        text: m.status.waiting(waiting.length - ready.length),
        hint: 'striart queue',
      });
    }
    const supervised = data.agents.filter((a) => a.status === 'ACTIVE' && a.mode !== 'autonomous');
    if (supervised.length > 0 && !data.daemon.running) {
      items.push({ level: 'info', text: m.status.noWatcher, hint: 'striart watch --daemon' });
    }
    if (items.length === 0) return;
    out.print();
    out.heading(m.status.attention);
    for (const item of items) out.line(item.level, item.text, item.hint);
  },
};

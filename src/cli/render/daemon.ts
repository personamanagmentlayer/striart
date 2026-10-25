/**
 * Rendu des actions de daemon, communes à `watch` et `dashboard`
 * (`--daemon`, `--stop`, `--status`).
 */
import type { Ctx } from '../context.ts';

export type DaemonActionData =
  | { action: 'daemon'; pid: number; logPath: string }
  | { action: 'stop'; stopped: boolean; stopping: boolean; wasStale: boolean; pid: number | null }
  | {
      action: 'status';
      running: boolean;
      stale: boolean;
      pid: number | null;
      startedAt?: string | null;
      logPath?: string;
    };

export function renderDaemonAction(
  ctx: Ctx,
  name: 'watch' | 'dashboard',
  data: DaemonActionData,
): void {
  const { out, m } = ctx;
  const label = m.daemon.label(name);
  switch (data.action) {
    case 'daemon':
      out.line('ok', m.daemon.started(label, data.pid));
      out.detail(m.common.log(out.path(data.logPath)));
      out.hint(`striart ${name} --status`);
      if (name === 'watch') out.detail(m.daemon.boot);
      return;
    case 'stop':
      if (data.stopped) out.line('ok', m.daemon.stopped(label, data.pid));
      else if (data.stopping) {
        out.line('info', m.daemon.stopping(label, data.pid));
        out.hint(`striart ${name} --status`);
      } else if (data.wasStale) out.line('ok', m.daemon.staleCleaned(data.pid));
      else out.line('info', m.daemon.notRunning(label));
      return;
    case 'status':
      if (data.running) {
        out.line('ok', m.daemon.running(label, data.pid, out.since(data.startedAt ?? null)));
        if (data.logPath) out.detail(m.common.log(out.path(data.logPath)));
        out.hint(`striart ${name} --stop`);
      } else {
        out.line('info', data.stale ? m.daemon.dead(label, data.pid) : m.daemon.notRunning(label));
        out.hint(`striart ${name} --daemon`);
      }
      return;
  }
}

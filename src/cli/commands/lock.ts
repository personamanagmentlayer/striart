import { assertInitialized } from '../../clone.ts';
import { StriartError } from '../../errors.ts';
import { reserveMainSession } from '../../lock.ts';
import { readMainSessionStatus, stopMainSession } from '../../main-session.ts';
import type { CommandModule } from '../context.ts';

export interface LockInput {
  start: string | null;
  stop: boolean;
  pid: number | null;
}

type MainSessionStatus = NonNullable<Awaited<ReturnType<typeof readMainSessionStatus>>>;

export type LockData =
  | { action: 'status'; session: MainSessionStatus | null }
  | { action: 'start'; session: { pid: number; reason: string; startedAt: string } }
  | { action: 'stop'; released: MainSessionStatus | null };

export const lock: CommandModule<LockInput, LockData> = {
  async execute(ctx, input) {
    if (input.pid !== null && input.start === null) {
      throw new StriartError(ctx.m.main.pidNeedsStart, {
        code: 'OPTION_CONFLICT',
        details: { reason: 'NEEDS_START', options: ['--pid'] },
        hint: 'striart lock --start "<raison>" --pid <n>',
      });
    }
    const root = await ctx.repoRoot();
    await assertInitialized(root);
    if (input.stop) {
      const previous = await readMainSessionStatus(root);
      await stopMainSession(root);
      return { data: { action: 'stop', released: previous }, outcome: 'ok' };
    }
    if (input.start !== null) {
      // Sans --pid : le parent de cette commande, c'est-à-dire le shell qui
      // l'a lancée — vérifié durable par reserveMainSession (fail closed).
      const explicitPid = input.pid !== null;
      const session = await reserveMainSession(root, {
        reason: input.start,
        pid: input.pid ?? process.ppid,
        explicitPid,
      });
      return { data: { action: 'start', session }, outcome: 'ok' };
    }
    return {
      data: { action: 'status', session: await readMainSessionStatus(root) },
      outcome: 'ok',
    };
  },

  render(ctx, { data }) {
    const { out, m } = ctx;
    if (data.action === 'stop') {
      out.line(
        'ok',
        data.released ? m.lock.released(out.untrusted(data.released.reason)) : m.lock.alreadyFree,
      );
      return;
    }
    if (data.action === 'start') {
      out.line('ok', m.lock.reserved(out.untrusted(data.session.reason), data.session.pid));
      out.detail(m.lock.reservedDetail);
      out.hint('striart lock --stop');
      return;
    }
    if (!data.session) {
      out.line('ok', m.lock.free);
      return;
    }
    const s = data.session;
    if (s.alive) {
      out.line(
        'warn',
        m.lock.busy(out.untrusted(s.reason), s.pid, out.date(s.startedAt), out.since(s.startedAt)),
      );
      out.hint('striart lock --stop');
    } else {
      out.line('info', m.lock.deadPid(out.untrusted(s.reason), s.pid));
    }
  },
};

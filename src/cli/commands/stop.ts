import { stopAgent } from '../../orchestrator.js';
import type { AttendedSession } from '../../pty-host.ts';
import type { CommandModule, CommandWarning } from '../context.ts';
import { renderStartedTasks, withSessions } from './queue.ts';

export interface StopInput {
  agent: string;
  force: boolean;
}

type StopResult = Awaited<ReturnType<typeof stopAgent>>;

export interface StopData extends Omit<StopResult, 'started'> {
  started: Array<StopResult['started'][number] & { session: AttendedSession }>;
}

export const stop: CommandModule<StopInput, StopData> = {
  async execute(ctx, input) {
    const root = await ctx.repoRoot();
    const result = await ctx.out.task(ctx.m.stop.running(input.agent), () =>
      stopAgent({ root, agent: input.agent, force: input.force }),
    );
    // Le terminal (hôte de pty) n'est jamais tué à l'aveugle : s'il reste en
    // vie, l'utilisateur doit le savoir — un « stop » silencieux ferait croire
    // le clone libre.
    const { ptyHost } = result;
    const warnings: CommandWarning[] = [];
    if (ptyHost.stopping)
      warnings.push({ code: 'PTY_HOST_STOPPING', message: ctx.m.stop.hostStopping(input.agent) });
    if (ptyHost.untouched)
      warnings.push({
        code: 'PTY_HOST_UNTOUCHED',
        message: ctx.m.stop.hostUntouched(input.agent, ctx.m.stop.hostWhy(ptyHost.untouched)),
      });
    // Le dégagement de la file après l'arrêt a échoué : l'arrêt est FAIT, la file
    // reste en l'état — rapporté (stderr + `warnings` du --json), jamais tu.
    if (result.queueError)
      warnings.push({
        code: result.queueError.code,
        message: ctx.m.stop.queueFailed(input.agent, result.queueError.code),
      });
    // Artefacts périphériques (hôte ACP, Tab Configs Warp) : échecs rapportés.
    for (const failure of result.artifacts.errors)
      warnings.push({
        code: 'AGENT_ARTIFACT_FAILED',
        message: ctx.m.stop.artifactFailed(input.agent, failure.what, failure.message),
      });
    return {
      data: { ...result, started: await withSessions(root, result.started) },
      outcome: 'ok',
      warnings,
    };
  },

  render(ctx, { data }) {
    const { out, m } = ctx;
    out.line(
      'ok',
      data.cloneMissing
        ? m.stop.stoppedMissing(data.agent)
        : m.stop.stopped(data.agent, out.path(data.clonePath)),
    );
    if (!data.cloneMissing) out.hint(`striart clean ${data.agent}`);
    renderStartedTasks(out, data.started);
    if (data.queueError)
      out.line(
        'warn',
        m.stop.queueFailed(data.agent, data.queueError.code),
        'striart queue --retry',
      );
    else if (data.stillWaiting.length > 0)
      out.line('info', m.reconcile.stillWaiting(data.stillWaiting.length));
  },
};

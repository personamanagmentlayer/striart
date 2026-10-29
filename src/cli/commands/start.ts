import { startAgent } from '../../orchestrator.ts';
import { openAttendedSession } from '../../pty-host.ts';
import type { AttendedSession } from '../../pty-host.ts';
import { quoteForShell } from '../../terminal.ts';
import type { AgentMeta } from '../../types.js';
import type { CommandModule, Ctx } from '../context.ts';
import type { Output } from '../output.ts';

export interface StartInput {
  agent: string;
  command: string | null;
  open: boolean;
  reuse: boolean;
  force: boolean;
  allowHistoricalSecrets: boolean;
}

export interface StartedAgentData {
  agent: AgentMeta & { name: string };
  session: AttendedSession;
}

export const start: CommandModule<StartInput, StartedAgentData> = {
  async execute(ctx, input) {
    const deprecated = input.force && !input.reuse;
    const allowHistoricalSecrets = input.allowHistoricalSecrets || deprecated;
    const force = input.force && input.reuse;
    const root = await ctx.repoRoot();
    const agent = await ctx.out.task(
      input.reuse ? ctx.m.start.reusing(input.agent) : ctx.m.start.creating(input.agent),
      () =>
        startAgent({
          root,
          name: input.agent,
          command: input.command,
          reuse: input.reuse,
          force,
          allowHistoricalSecrets,
        }),
    );
    const session = await openAttendedSession(root, agent, { open: input.open });
    const warnings = terminalWarnings(ctx, session);
    if (deprecated)
      warnings.unshift({ code: 'DEPRECATED_OPTION', message: ctx.m.main.deprecatedForce('start') });
    return { data: { agent, session }, outcome: 'ok', warnings };
  },

  render(ctx, { data }) {
    renderStartedAgent(ctx.out, data.agent, data.session);
  },
};

/** Avertissement d'ouverture d'onglet : non bloquant, l'agent est prêt quoi qu'il arrive. */
export function terminalWarnings(ctx: Ctx, session: AttendedSession) {
  const terminal = session.terminal;
  if (!terminal || !('error' in terminal)) return [];
  return [{ code: 'TERMINAL_OPEN_FAILED', message: ctx.m.start.terminalFailed(terminal.error) }];
}

/** Agent supervisé prêt : où il est, et la commande exacte pour s'y mettre. */
export function renderStartedAgent(
  out: Output,
  agent: AgentMeta & { name: string },
  session: AttendedSession,
): void {
  const { m } = out;
  out.line('ok', m.start.ready(agent.name, out.path(agent.path)));
  out.detail(m.start.branch(agent.branch));
  if (session.terminal?.launched) {
    out.line('ok', m.start.terminalOpened(agent.name, out.untrusted(session.agentCommand)));
    return;
  }
  if (session.terminal && !session.terminal.launched && session.terminal.hostPid !== null) {
    out.detail(m.start.attachManually);
    out.hint(`striart attach ${agent.name}`);
    return;
  }
  out.detail(m.start.launchManually);
  // `;` et non `&&` : valide dans Windows PowerShell 5.1, PowerShell 7, bash, zsh et fish.
  // Chemin cité pour le shell de la plateforme : le chemin du dépôt cible est
  // non fiable (SECURITY.md) — un `$(…)` ne doit pas s'exécuter au copier-coller.
  out.hint(`cd ${quoteForShell(agent.path, { shell: null })}; ${session.agentCommand}`);
}

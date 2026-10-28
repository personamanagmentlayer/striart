import { StriartError } from '../../errors.js';
import { runAutonomousTask, runMainSession, runTask } from '../../orchestrator.js';
import { openAttendedSession } from '../../pty-host.ts';
import type { AttendedSession } from '../../pty-host.ts';
import type { AutonomousResult, RunResult, SessionResult } from '../../types.js';
import type { CommandModule, CommandWarning, Ctx } from '../context.ts';
import { autonomousOutcome, mainSessionOutcome } from '../exit.ts';
import { localizeMergeResult } from '../localize.ts';
import { renderMergeResult } from '../render/results.ts';
import { renderStartedAgent, terminalWarnings } from './start.ts';

export interface RunInput {
  prompt: string | null;
  promptOption: string | null;
  agent: string | null;
  command: string | null;
  open: boolean;
  autonomous: boolean;
  onMain: boolean;
  profile: string | null;
  timeoutMs: number | null;
  after: string | null;
  reuse: boolean;
  force: boolean;
  allowHistoricalSecrets: boolean;
}

export type RunData =
  | { mode: 'attended'; run: RunResult; session: AttendedSession | null }
  | { mode: 'autonomous'; result: AutonomousResult }
  | { mode: 'on-main'; session: SessionResult };

/**
 * Combinaisons qu'aucune déclaration commander ne peut exprimer (une option
 * qui n'a de sens qu'avec une autre). Refusées AVANT toute action, au lieu
 * d'être ignorées en silence comme avant la 0.11.
 */
function assertCoherent(
  ctx: Parameters<CommandModule<RunInput>['execute']>[0],
  input: RunInput,
): string {
  const { m } = ctx;
  if (input.prompt !== null && input.promptOption !== null && input.prompt !== input.promptOption) {
    throw new StriartError(m.run.twoPrompts, {
      code: 'OPTION_CONFLICT',
      details: { options: ['<prompt>', '--prompt'] },
    });
  }
  const prompt = input.prompt ?? input.promptOption;
  if (prompt === null || prompt.trim() === '') {
    throw new StriartError(m.run.emptyPrompt, {
      code: 'EMPTY_PROMPT',
      hint: 'striart run "ajoute un test sur le parseur"',
    });
  }
  if (!input.autonomous && !input.onMain) {
    for (const [option, value] of [
      ['--profile', input.profile],
      ['--timeout', input.timeoutMs],
    ] as const) {
      if (value !== null) {
        throw new StriartError(m.run.needsUnattended(option), {
          code: 'OPTION_CONFLICT',
          details: { reason: 'NEEDS_UNATTENDED', options: [option] },
          hint: `striart run --autonomous ${option} …`,
        });
      }
    }
  }
  if (input.reuse && input.agent === null) {
    throw new StriartError(m.run.reuseNeedsAgent, {
      code: 'REUSE_NEEDS_AGENT',
      hint: 'striart run --reuse --agent agent-a "…"',
    });
  }
  return prompt;
}

/**
 * Avertissements non bloquants d'un cycle autonome réussi « bruyant » :
 * `ALREADY_INTEGRATED` (le commit de l'agent était déjà dans la cible — rien
 * n'a été mergé, le Test Gate n'a pas été rejoué). Rendus par main.ts sur
 * stderr et dans `warnings` du document `--json`.
 */
export function integrationWarnings(
  m: Ctx['m'],
  result: Pick<AutonomousResult, 'agent' | 'warnings' | 'relaxedBlockers'>,
): CommandWarning[] {
  return (result.warnings ?? []).map((code) => ({
    code,
    message:
      code === 'ALREADY_INTEGRATED'
        ? m.run.alreadyIntegratedWarning(result.agent)
        : code === 'SERIALIZATION_RELAXED'
          ? m.run.serializationRelaxedWarning(
              result.agent,
              (result.relaxedBlockers ?? []).map((b) => b.agent).join(', '),
            )
          : code,
  }));
}

export const run: CommandModule<RunInput, RunData> = {
  async execute(ctx, rawInput) {
    const deprecated = rawInput.force && !rawInput.reuse;
    const input = {
      ...rawInput,
      allowHistoricalSecrets: rawInput.allowHistoricalSecrets || deprecated,
      force: rawInput.force && rawInput.reuse,
    };
    const deprecationWarnings: CommandWarning[] = deprecated
      ? [{ code: 'DEPRECATED_OPTION', message: ctx.m.main.deprecatedForce('run') }]
      : [];
    const prompt = assertCoherent(ctx, input);
    const root = await ctx.repoRoot();
    const { m, out } = ctx;

    if (input.onMain) {
      out.notice('info', m.run.onMainIntro(input.profile));
      const session = await out.task(m.run.sessionRunning, () =>
        runMainSession({
          root,
          prompt,
          profile: input.profile,
          timeoutMs: input.timeoutMs,
          reason: prompt,
          signal: ctx.signal,
        }),
      );
      return {
        data: { mode: 'on-main', session },
        outcome: mainSessionOutcome(session.status, session.errorCode ?? null),
        warnings: deprecationWarnings,
      };
    }

    if (input.autonomous) {
      out.notice('info', m.run.autonomousIntro(input.profile));
      const result = await out.task(m.run.sessionRunning, () =>
        runAutonomousTask({
          root,
          agent: input.agent,
          prompt,
          profile: input.profile,
          timeoutMs: input.timeoutMs,
          after: input.after,
          reuse: input.reuse,
          force: input.force,
          allowHistoricalSecrets: input.allowHistoricalSecrets,
          signal: ctx.signal,
        }),
      );
      return {
        data: { mode: 'autonomous', result },
        outcome: autonomousOutcome(
          result.status,
          result.keptDetail,
          result.session?.errorCode ?? null,
        ),
        warnings: [...deprecationWarnings, ...integrationWarnings(ctx.m, result)],
      };
    }

    const result = await out.task(m.run.routing, () =>
      runTask({
        root,
        agent: input.agent,
        prompt,
        command: input.command,
        after: input.after,
        reuse: input.reuse,
        force: input.force,
        allowHistoricalSecrets: input.allowHistoricalSecrets,
      }),
    );
    let session: AttendedSession | null = null;
    let warnings: CommandWarning[] = [...deprecationWarnings];
    if (result.status === 'STARTED') {
      session = await openAttendedSession(root, result.info, { open: input.open });
      warnings = [...warnings, ...terminalWarnings(ctx, session)];
    }
    return { data: { mode: 'attended', run: result, session }, outcome: 'ok', warnings };
  },

  render(ctx, { data }) {
    const { out, m } = ctx;
    if (data.mode === 'on-main') {
      const s = data.session;
      out.line(
        s.status === 'COMPLETED' ? 'ok' : 'error',
        m.run.sessionEnded(s.status, out.duration(s.durationMs), s.exitCode),
      );
      out.detail(m.common.log(out.path(s.logPath)));
      return;
    }

    if (data.mode === 'autonomous') {
      const r = data.result;
      if (r.status === 'QUEUED') {
        out.line('info', m.run.autonomousQueued(r.task?.id ?? '?'));
        out.hint('striart queue --retry');
        return;
      }
      if (r.session) {
        out.detail(
          m.run.sessionEnded(
            r.session.status,
            out.duration(r.session.durationMs),
            r.session.exitCode,
          ),
        );
        out.detail(m.common.log(out.path(r.session.logPath)));
      }
      const c = r.commit;
      if (c?.status === 'COMMITTED' && c.sha) {
        out.line(
          'info',
          m.run.striartCommitted(
            out.sha(c.sha),
            c.files.length,
            out.untrusted(c.author ? `${c.author.name} <${c.author.email}>` : '?'),
          ),
        );
      } else if (c?.status === 'SKIPPED_AGENT_COMMITTED') {
        out.detail(m.run.commitSkippedAgent);
      }
      for (const kind of ['secrets', 'injected'] as const) {
        const files = c?.excluded[kind] ?? [];
        if (files.length > 0) {
          out.line(
            'warn',
            m.run.commitExcluded(kind, files.map((f) => out.untrusted(f)).join(', ')),
          );
        }
      }
      if (r.merge) renderMergeResult(out, localizeMergeResult(m, r.merge));
      // Raison localisée par code ; repli sur le texte du domaine (français).
      const reason = r.keptCode
        ? (m.run.kept(r.keptCode, r.keptDetail) ?? r.keptReason)
        : r.keptReason;
      if (r.status === 'MERGED') {
        out.line(
          'ok',
          r.cleaned ? m.run.autonomousCleaned : m.run.autonomousKept(out.untrusted(reason)),
        );
        return;
      }
      out.line(
        r.status === 'MERGE_BLOCKED' || r.status === 'COMMIT_REFUSED' ? 'error' : 'warn',
        m.run.autonomousStatus(r.status, out.untrusted(reason)),
      );
      if (r.clonePath) out.detail(m.run.cloneKept(out.path(r.clonePath)));
      return;
    }

    const r = data.run;
    if (r.status === 'QUEUED') {
      for (const c of r.collisions) {
        out.line(
          'info',
          m.run.collision(c.agent, r.task.agent, c.files.map((f) => out.untrusted(f)).join(', ')),
        );
      }
      if (r.task.after) out.line('info', m.run.waitsFor(out.untrusted(r.task.after)));
      out.line('ok', m.run.queued(r.task.agent, r.task.id));
      out.hint('striart queue');
      return;
    }
    out.detail(
      m.run.predicted(r.predictedFiles.map((f) => out.untrusted(f)).join(', ') || out.glyphs.empty),
    );
    if (r.routing?.serialized) {
      out.detail(
        m.run.serialized(
          out.untrusted(
            [r.routing.serialized.kind, ...(r.routing.serialized.reasons ?? [])].join(', '),
          ),
        ),
      );
    }
    if ((r.routing?.shared.length ?? 0) > 0) {
      out.detail(m.run.sharedIgnored(r.routing!.shared.map((f) => out.untrusted(f)).join(', ')));
    }
    for (const w of r.semanticWarnings ?? []) {
      const links = w.links
        .map((l) => m.run.importLink(out.untrusted(l.importedBy), out.untrusted(l.file)))
        .join(' ; ');
      out.line('warn', m.run.semanticLink(w.agent, links));
    }
    for (const w of r.workspaceWarnings ?? []) {
      const links = w.links
        .map((l) =>
          l.direction === 'depends-on'
            ? m.run.dependsOn(out.untrusted(l.mine), out.untrusted(l.theirs))
            : m.run.dependsOn(out.untrusted(l.theirs), out.untrusted(l.mine)),
        )
        .join(' ; ');
      out.line('warn', m.run.workspaceLink(w.agent, links));
    }
    if (data.session) renderStartedAgent(out, r.info, data.session);
  },
};

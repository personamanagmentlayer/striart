import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { StriartError } from '../../errors.ts';
import { applyPlan } from '../../orchestrator.ts';
import { openAttendedSession } from '../../pty-host.ts';
import type { AttendedSession } from '../../pty-host.ts';
import type { AgentMeta, AutonomousWarningCode } from '../../types.js';
import type { ProgressEvent } from '../../orchestration/unit.ts';
import type { PlanOverrides } from '../../orchestration/scheduler.ts';
import type { CommandModule, CommandWarning, Ctx } from '../context.ts';
import { autonomousOutcome, orchestrationOutcome, worstOutcome } from '../exit.ts';
import type { Outcome } from '../exit.ts';
import { integrationWarnings } from './run.ts';
import { renderStartedAgent } from './start.ts';

export interface PlanInput {
  file: string;
  dryRun: boolean;
  /** Plan v2 : surcharges de la ligne de commande (lot O). */
  mode?: 'sequential' | 'parallel' | null;
  concurrency?: number | null;
  onFailure?: 'stop' | 'skip-dependents' | null;
}

type PlanResult = Awaited<ReturnType<typeof applyPlan>>;

interface SessionFailure {
  agent: string;
  code: string;
  message: string;
}

export interface PlanData extends PlanResult {
  file: string;
  /** Sessions supervisées préparées pour les tâches démarrées (par nom d'agent). */
  sessions: Record<string, AttendedSession>;
  /** Sessions supervisées qui n'ont pas pu s'ouvrir (hôte de pty) : jamais passées sous silence. */
  sessionFailures: Array<{ agent: string; code: string }>;
}

async function readPlan(ctx: Ctx, file: string) {
  const absolute = path.resolve(ctx.cwd, file);
  try {
    return { absolute, text: await readFile(absolute, 'utf8') };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'EISDIR') {
      throw new StriartError(ctx.m.plan.notFound(absolute), {
        code: 'PLAN_NOT_FOUND',
        details: { file: absolute },
        hint: 'striart plan examples/plan.yaml --dry-run',
      });
    }
    throw error;
  }
}

/**
 * Progression d'un plan v2 sur stderr (muette en --json/--quiet). Une tâche
 * SUPERVISÉE démarrée reçoit sa session tout de suite : le plan l'attend
 * jusqu'à la sortie de son agent, l'humain doit pouvoir s'y mettre.
 */
function progressRenderer(
  ctx: Ctx,
  root: string,
  sessions: Record<string, AttendedSession>,
  onSessionFailure: (failure: SessionFailure) => void,
) {
  const { out, m } = ctx;
  const label = (id: string | null, fallback?: string | null) =>
    out.untrusted(id ?? fallback ?? '?');
  const pendingSessions: Array<Promise<void>> = [];
  /**
   * Ouvre la session d'un nœud supervisé. Un échec (hôte de pty, binaire natif
   * absent…) est signalé AU MOMENT OÙ IL SURVIENT, avec son code et la piste,
   * puis remonté à l'appelant : le plan attendrait sinon un agent que
   * personne n'a lancé jusqu'au délai de la tâche.
   */
  const openSession = async (info: AgentMeta & { name: string }): Promise<void> => {
    try {
      const session = await openAttendedSession(root, info);
      sessions[info.name] = session;
      renderStartedAgent(out, info, session);
    } catch (error) {
      const striart = error instanceof StriartError ? error : null;
      const code = striart?.code ?? 'UNEXPECTED';
      const raw = (
        (striart ? m.errors(striart.code, striart.details) : null) ??
        (error instanceof Error ? error.message : String(error))
      ).trim();
      const detail = /[.!?]$/.test(raw) ? raw : `${raw}.`;
      const message = m.plan.sessionFailed(out.untrusted(info.name), code, out.untrusted(detail));
      out.warn(message, striart?.hint ?? null);
      onSessionFailure({ agent: info.name, code, message });
    }
  };
  const render = (event: ProgressEvent) => {
    switch (event.type) {
      case 'node-started': {
        out.step(
          m.plan.progress.started(label(event.nodeId, event.info?.name), m.plan.kind(event.kind)),
        );
        const info = event.info;
        if (info && event.kind === 'task' && info.mode !== 'autonomous') {
          pendingSessions.push(openSession(info));
        }
        return;
      }
      case 'node-finished':
        out.step(
          m.plan.progress.finished(
            label(event.nodeId, event.agent),
            m.plan.kind(event.kind),
            event.status,
          ),
        );
        return;
      case 'turn':
        out.step(
          event.phase === 'started'
            ? m.plan.progress.turn(event.agent, event.role, event.round)
            : m.plan.progress.turnDone(event.agent, event.role, event.status ?? '?'),
        );
        return;
      case 'waiting':
        out.step(
          m.plan.progress.waiting(
            label(event.nodeId),
            event.reason,
            out.untrusted(event.ref ?? ''),
          ),
        );
        if (event.reason === 'human-review') out.step(m.review.pendingHint);
        return;
      case 'verdict':
        out.step(m.plan.progress.verdict(event.reviewer, event.round, event.verdict));
        return;
      case 'serialization-relaxed':
        out.step(
          m.plan.progress.serializationRelaxed(
            label(event.nodeId),
            out.untrusted(event.blockers.join(', ')),
          ),
        );
        return;
    }
  };
  // `openSession` attrape et signale ses erreurs : un rejet ici serait un bug,
  // qui doit remonter plutôt qu'être avalé (Promise.all, jamais allSettled).
  return {
    render,
    settle: async () => {
      await Promise.all(pendingSessions);
    },
  };
}

/** Exécution partagée par `plan` et `orchestrate` (même chemin de validation). */
export async function executePlanText(
  ctx: Ctx,
  {
    text,
    file,
    dryRun,
    overrides = {},
  }: { text: string; file: string; dryRun: boolean; overrides?: PlanOverrides },
) {
  const root = await ctx.repoRoot();
  const sessions: Record<string, AttendedSession> = {};
  const failures: SessionFailure[] = [];
  // Une session supervisée impossible à ouvrir interrompt le plan (comme
  // Ctrl+C : arrêt propre, clones conservés) au lieu de l'attendre jusqu'au
  // délai ; le signal de l'utilisateur reste prioritaire et propagé.
  const planAbort = new AbortController();
  const progress = progressRenderer(ctx, root, sessions, (failure) => {
    failures.push(failure);
    planAbort.abort();
  });
  const result = await ctx.out.task(dryRun ? ctx.m.plan.validating : ctx.m.plan.applying, () =>
    applyPlan({
      root,
      planText: text,
      dryRun,
      signal: AbortSignal.any([ctx.signal, planAbort.signal]),
      onProgress: progress.render,
      overrides,
    }),
  );
  await progress.settle();
  if (result.version !== 2) {
    for (const r of result.results ?? []) {
      if (r.mode === 'attended' && r.info)
        sessions[r.info.name] = await openAttendedSession(root, r.info);
    }
  }
  // Une tâche autonome qui échoue fait échouer le plan, comme `run --autonomous`.
  // Un plan interrompu (Ctrl+C) n'a pas atteint son intention : des tâches
  // n'ont pas été appliquées — jamais un « ok » dans le document --json.
  const interrupted = Boolean(result.interrupted) || (result.notApplied ?? []).length > 0;
  const outcomes: Outcome[] =
    result.version === 2
      ? (result.nodes ?? []).map((n) => orchestrationOutcome(n.status, n.detail ?? null))
      : (result.results ?? [])
          .filter((r) => r.mode === 'autonomous')
          .map((r) =>
            autonomousOutcome(r.status, r.keptDetail ?? null, v1Extra(r).errorCode ?? null),
          );
  const outcome = worstOutcome([
    ...outcomes,
    ...(interrupted || failures.length > 0 ? (['failed'] as const) : []),
  ]);
  const warnings: CommandWarning[] = [
    ...failures.map((f) => ({ code: f.code, message: f.message })),
    // Succès « bruyant » : le commit de l'agent était déjà dans la cible.
    ...(result.version === 2
      ? (result.nodes ?? [])
          .filter((n) => n.merge?.alreadyMerged === true)
          .flatMap((n) =>
            integrationWarnings(ctx.m, {
              agent: n.agent ?? n.id ?? '?',
              warnings: ['ALREADY_INTEGRATED'],
            }),
          )
      : (result.results ?? [])
          .filter((r) => r.mode === 'autonomous')
          .flatMap((r) =>
            integrationWarnings(ctx.m, { agent: r.agent, warnings: v1Extra(r).warnings }),
          )),
  ];
  return {
    data: {
      ...result,
      file,
      sessions,
      sessionFailures: failures.map(({ agent, code }) => ({ agent, code })),
    } as PlanData,
    outcome,
    warnings,
  };
}

/**
 * Champs OPTIONNELS que `applyPlan` (plan v1) peut joindre au résultat d'une
 * tâche autonome : les avertissements du cycle (`ALREADY_INTEGRATED`) et le
 * code d'erreur de la session (cause nommée d'un refus). Absents, rien n'est
 * déduit : le contrat de type de `applyPlan` ne les déclare pas encore.
 */
function v1Extra(result: object): {
  warnings?: AutonomousWarningCode[];
  errorCode?: string | null;
} {
  return result as { warnings?: AutonomousWarningCode[]; errorCode?: string | null };
}

/**
 * Niveau d'affichage d'une tâche : réussite = ok ; un nœud sauté (`SKIPPED`)
 * ou un travail gardé pour revue humaine (`KEPT`, rien n'est perdu) = warn ;
 * le reste = error.
 */
function outcomeLevel(outcome: Outcome, status: string): 'ok' | 'warn' | 'error' {
  if (outcome === 'ok') return 'ok';
  return status === 'SKIPPED' || status === 'KEPT' ? 'warn' : 'error';
}

export function renderPlanResult(ctx: Ctx, data: PlanData, rerun: string | null): void {
  const { out, m } = ctx;
  if (data.dryRun) {
    out.line('ok', m.plan.valid(data.tasks.length));
    out.table(
      [
        {
          key: 'task',
          header: m.plan.colTask,
          value: (t) => t.id ?? t.agent ?? m.plan.derivedName,
          priority: 9,
        },
        ...(data.version === 2
          ? [
              {
                key: 'kind',
                header: m.plan.colKind,
                value: (t: PlanData['tasks'][number]) => m.plan.kind(t.kind ?? 'task'),
                priority: 8,
              },
            ]
          : []),
        { key: 'mode', header: m.plan.colMode, value: (t) => m.common.mode(t.mode), priority: 8 },
        { key: 'after', header: m.plan.colAfter, value: (t) => t.after ?? '', priority: 7 },
      ],
      data.tasks,
    );
    if (rerun) out.hint(rerun);
    return;
  }
  const interrupted = (data.notApplied ?? []).length > 0;
  out.line(interrupted ? 'warn' : 'ok', m.plan.applied((data.results ?? []).length));
  if (data.version === 2) {
    if (data.run) out.detail(m.plan.run(data.run.id, data.run.mode, data.run.concurrency));
    for (const n of data.nodes ?? []) {
      const level = outcomeLevel(orchestrationOutcome(n.status, n.detail ?? null), n.status);
      out.line(
        level,
        m.plan.node(out.untrusted(n.id ?? n.agent ?? '?'), m.plan.kind(n.kind), n.status),
      );
      if (n.detail) out.detail(m.plan.nodeDetail(out.untrusted(n.detail)));
      if (n.agents.length > 1 || (n.agents.length === 1 && n.agents[0] !== n.id)) {
        out.detail(m.plan.nodeAgents(n.agents.map((a) => out.untrusted(a)).join(', ')));
      }
      if (n.verdicts.length > 0) {
        out.detail(
          m.plan.verdicts(
            n.verdicts
              .map((v) => `${out.untrusted(v.reviewer)}#${v.round}=${v.verdict}`)
              .join(', '),
          ),
        );
      }
      if (n.kept && n.status !== 'SKIPPED') out.detail(m.plan.nodeKept);
    }
  } else {
    for (const r of data.results ?? []) {
      const name = r.agent ?? r.id ?? '?';
      if (r.mode === 'autonomous') {
        const level = outcomeLevel(
          autonomousOutcome(r.status, r.keptDetail ?? null, v1Extra(r).errorCode ?? null),
          r.status,
        );
        out.line(level, m.plan.autonomousTask(name, r.status));
      } else if (r.info) {
        renderStartedAgent(out, r.info, data.sessions[r.info.name]);
      } else {
        out.line('info', m.plan.queuedTask(name));
      }
    }
  }
  for (const task of data.notApplied ?? []) {
    out.line('warn', m.plan.notApplied(task.id ?? task.agent ?? m.plan.derivedName));
  }
}

export const plan: CommandModule<PlanInput, PlanData> = {
  async execute(ctx, input) {
    const { absolute, text } = await readPlan(ctx, input.file);
    return executePlanText(ctx, {
      text,
      file: absolute,
      dryRun: input.dryRun,
      overrides: {
        mode: input.mode ?? null,
        concurrency: input.concurrency ?? null,
        onFailure: input.onFailure ?? null,
      },
    });
  },

  render(ctx, { data }) {
    renderPlanResult(ctx, data, `striart plan ${path.relative(ctx.cwd, data.file) || data.file}`);
  },
};

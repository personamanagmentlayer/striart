import { assertInitialized } from '../../clone.js';
import {
  closeConflictTicket,
  isReadableTicket,
  listConflictTickets,
  prepareResolutionScaffold,
} from '../../conflicts.js';
import { StriartError } from '../../errors.js';
import { applyTicketResolution } from '../../orchestrator.js';
import { quoteForShell } from '../../terminal.js';
import { readState, resetManualMode } from '../../state.js';
import type {
  CorruptTicket,
  ManualResolutionResult,
  StriartState,
  TicketEntry,
} from '../../types.js';
import type { CommandModule } from '../context.ts';
import { manualResolutionOutcome } from '../exit.ts';

export interface ResolveInput {
  unlock: boolean;
  close: string | null;
  prepare: string | null;
  apply: string | null;
  all: boolean;
  /** Chemins PROTÉGÉS à amorcer depuis la version de l'agent (avec `--prepare`). */
  acceptTheirs: string[];
}

export type ResolveData =
  | { action: 'list'; state: StriartState; tickets: TicketEntry[] }
  | { action: 'unlock' }
  | { action: 'close'; ticket: TicketEntry }
  | {
      action: 'prepare';
      ticketId: string;
      files: Awaited<ReturnType<typeof prepareResolutionScaffold>>;
    }
  | { action: 'apply'; result: ManualResolutionResult };

export const resolve: CommandModule<ResolveInput, ResolveData> = {
  async execute(ctx, input) {
    // Une option qui n'a de sens qu'avec une autre : refusée AVANT toute action
    // (jamais ignorée en silence — l'humain croirait avoir accepté la version
    // de l'agent).
    if (input.acceptTheirs.length > 0 && input.prepare === null) {
      throw new StriartError(ctx.m.resolve.acceptNeedsPrepare, {
        code: 'OPTION_CONFLICT',
        details: { reason: 'NEEDS_PREPARE', options: ['--accept-theirs'] },
        hint: 'striart resolve --prepare <ticket> --accept-theirs <chemin>',
      });
    }
    const root = await ctx.repoRoot();
    await assertInitialized(root);
    if (input.unlock) {
      await resetManualMode(root);
      return { data: { action: 'unlock' }, outcome: 'ok' };
    }
    if (input.close !== null) {
      return {
        data: { action: 'close', ticket: await closeConflictTicket(root, input.close) },
        outcome: 'ok',
      };
    }
    if (input.prepare !== null) {
      const files = await prepareResolutionScaffold(root, input.prepare, {
        acceptTheirs: input.acceptTheirs,
      });
      return { data: { action: 'prepare', ticketId: input.prepare, files }, outcome: 'ok' };
    }
    if (input.apply !== null) {
      const ticketId = input.apply;
      const result = await ctx.out.task(ctx.m.resolve.applying(ticketId), () =>
        applyTicketResolution({ root, ticketId }),
      );
      return { data: { action: 'apply', result }, outcome: manualResolutionOutcome(result.status) };
    }
    const [state, tickets] = await Promise.all([
      readState(root),
      listConflictTickets(root, { includeResolved: input.all }),
    ]);
    return { data: { action: 'list', state, tickets }, outcome: 'ok' };
  },

  render(ctx, { data }) {
    const { out, m } = ctx;
    switch (data.action) {
      case 'unlock':
        out.line('ok', m.resolve.unlocked);
        return;
      case 'close':
        out.line('ok', m.resolve.closed(data.ticket.id, out.path(data.ticket.dir)));
        return;
      case 'prepare':
        for (const f of data.files) {
          // Chemin protégé retenu : jamais amorcé depuis la version de l'agent
          // sans décision explicite — la commande exacte pour la prendre est donnée.
          if (f.held) {
            out.line(
              'warn',
              m.resolve.held(out.untrusted(f.path)),
              `striart resolve --prepare ${data.ticketId} --accept-theirs ${quoteForShell(f.path, { shell: null })}`,
            );
            continue;
          }
          out.line(
            f.created ? 'ok' : 'skip',
            f.created
              ? m.resolve.prepared(out.untrusted(f.path), f.source ?? '?')
              : m.resolve.alreadyPrepared(out.untrusted(f.path)),
          );
        }
        out.print();
        out.print(m.resolve.editThenApply);
        out.hint(`striart resolve --apply ${data.ticketId}`);
        return;
      case 'apply': {
        const r = data.result;
        if (r.status === 'MERGED') {
          out.line('ok', m.resolve.applied(r.ticketId, out.sha(r.mergeSha)));
          out.detail(m.resolve.files(r.resolvedFiles.map((f) => out.untrusted(f)).join(', ')));
          if (r.closedTickets.length > 1)
            out.detail(m.resolve.duplicatesClosed(r.closedTickets.slice(1).join(', ')));
          if (r.pushError) out.line('warn', m.merge.pushFailed(out.untrusted(r.pushError)));
          out.hint(`striart sync ${r.agent}`);
        } else if (r.status === 'ALREADY_CLEAN') {
          out.line('ok', m.resolve.alreadyClean(r.ticketId));
        } else {
          out.line('error', m.resolve.gateFailed(r.ticketId, r.gate.exitCode ?? null));
          out.hint(`striart resolve --apply ${r.ticketId}`);
        }
        return;
      }
      case 'list': {
        if (data.state.manualMode) out.line('warn', m.merge.manualMode, 'striart resolve --unlock');
        else if (data.state.semanticFailureStreak > 0)
          out.line('info', m.resolve.streak(data.state.semanticFailureStreak));
        if (data.tickets.length === 0) {
          out.line('ok', m.resolve.none);
          return;
        }
        out.table<TicketEntry>(
          [
            { key: 'id', header: m.resolve.colTicket, value: (t) => t.id, priority: 10 },
            {
              key: 'state',
              header: m.resolve.colState,
              value: (t) =>
                !isReadableTicket(t)
                  ? m.resolve.stateCorrupt(t.cause)
                  : t.resolved
                    ? m.resolve.stateResolved
                    : m.resolve.stateOpen,
              style: (text, t) => out.style(t.resolved ? 'ok' : 'error', text),
              priority: 9,
            },
            {
              key: 'reason',
              header: m.resolve.colReason,
              value: (t) => t.reason ?? m.resolve.unknownField,
              priority: 7,
            },
            {
              key: 'agent',
              header: m.resolve.colAgent,
              value: (t) => t.agent ?? m.resolve.unknownField,
              priority: 8,
            },
            {
              key: 'attempts',
              header: m.resolve.colAttempts,
              value: (t) =>
                isReadableTicket(t) ? String(t.attempts ?? 1) : m.resolve.unknownField,
              priority: 2,
            },
            {
              key: 'date',
              header: m.resolve.colDate,
              value: (t) =>
                out.date((isReadableTicket(t) ? t.updatedAt : undefined) ?? t.createdAt),
              priority: 3,
            },
            {
              key: 'files',
              header: m.resolve.colFiles,
              value: (t) => t.conflictedFiles.join(', '),
              priority: 5,
              shrink: { min: 12 },
            },
          ],
          data.tickets,
        );
        // Un ticket illisible ne peut qu'être fermé : sa cause et la commande
        // exacte sont affichées, jamais le contenu de ses fichiers.
        const open = data.tickets.filter((t) => !t.resolved && isReadableTicket(t));
        const corrupt = data.tickets.filter(
          (t): t is CorruptTicket => !t.resolved && !isReadableTicket(t),
        );
        if (open.length > 0) {
          out.print();
          out.print(m.resolve.howTo(open.length));
          out.hint(`striart resolve --prepare ${open[0].id}`);
        }
        for (const t of corrupt) {
          if (open.length === 0 && t === corrupt[0]) out.print();
          out.line(
            'warn',
            m.resolve.corrupt(t.id, t.cause),
            `striart resolve --close ${quoteForShell(t.id, { shell: null })}`,
          );
        }
        return;
      }
    }
  },
};

/**
 * Rendus humains partagés entre commandes : résultat de merge (merge,
 * watch, run --autonomous), résultat de sync (sync, watch). Fonctions de
 * présentation pures sur l'Output — aucune décision de code de sortie ici.
 */
import type { Output } from '../output.ts';
import type { MergeResult, SyncResult, Ticket } from '../../types.js';

export function renderTicketLocation(out: Output, ticket: Ticket): void {
  out.detail(out.m.common.ticket(ticket.id, out.path(ticket.dir)));
  out.hint(`striart resolve --prepare ${ticket.id}`);
}

export function renderMergeResult(out: Output, result: MergeResult): void {
  const { m } = out;
  switch (result.status) {
    case 'UP_TO_DATE':
      out.line(
        'ok',
        result.alreadyMerged
          ? m.merge.alreadyIntegrated(result.agent)
          : m.merge.upToDate(result.agent),
      );
      return;
    case 'MERGED': {
      out.line('ok', m.merge.merged(result.agent, out.sha(result.mergeSha), out.sha(result.sha)));
      if (result.semantic) {
        out.detail(
          m.merge.semanticFiles(result.resolvedFiles.map((f) => out.untrusted(f)).join(', ')),
        );
        if (result.gateRetries > 0) out.detail(m.merge.gateRetries(result.gateRetries));
      }
      for (const hazard of result.renameHazards ?? []) {
        out.line(
          'warn',
          m.merge.renameHazard(
            out.untrusted(hazard.source),
            out.untrusted(hazard.ours),
            out.untrusted(hazard.theirs),
          ),
        );
      }
      if (result.pushError) out.line('warn', m.merge.pushFailed(out.untrusted(result.pushError)));
      if (result.delivery?.pushed && result.delivery.mode === 'branch' && result.delivery.ref)
        out.detail(
          m.merge.deliveredBranch(out.untrusted(result.delivery.ref), out.sha(result.delivery.sha)),
        );
      if (result.memory && !result.memory.updated) {
        out.line('warn', m.merge.memoryFailed(out.untrusted(result.memory.error ?? '')));
      }
      return;
    }
    case 'CONFLICT': {
      if (result.reason === 'PROTECTED_PATHS_CHANGED') {
        const changes = result.protectedChanges ?? [];
        out.line(
          'error',
          m.merge.protectedRefused(
            result.agent,
            changes.map((c) => out.untrusted(c.path)).join(', '),
          ),
        );
        for (const c of changes) {
          out.detail(
            `  ${out.glyphs.info} ${m.merge.protectedChange(out.untrusted(c.path), c.status, out.untrusted(c.pattern), c.kind)}`,
          );
        }
        renderTicketLocation(out, result.ticket);
        out.detail(m.merge.protectedHelp(result.ticket.id));
        return;
      }
      out.line(
        'error',
        m.merge.conflict(
          result.agent,
          result.conflictedFiles.map((f) => out.untrusted(f)).join(', '),
        ),
      );
      if (result.reason === 'SEMANTIC_MERGE_FAILED') {
        out.detail(m.merge.semanticFailed(out.untrusted(result.error ?? '')));
      }
      if (result.reason === 'UNMERGEABLE_CONFLICT') {
        out.detail(m.merge.unmergeableTitle);
        for (const c of result.unmergeable ?? []) {
          const side =
            c.kind === 'delete' ? m.merge.deletedBy(c.deletedBy === 'ours' ? 'main' : 'agent') : '';
          out.detail(
            `  ${out.glyphs.info} ${out.untrusted(c.path)} : ${m.merge.conflictKind(c.kind)}${side}`,
          );
        }
      }
      renderTicketLocation(out, result.ticket);
      if (result.manualMode) out.line('warn', m.merge.manualMode, 'striart resolve --unlock');
      return;
    }
    case 'GATE_FAILED':
      out.line('error', m.merge.gateFailed(result.agent, result.gate.exitCode ?? null));
      if (result.semantic) out.detail(m.merge.gateFailedSemantic);
      renderTicketLocation(out, result.ticket);
      if (result.manualMode) out.line('warn', m.merge.manualMode, 'striart resolve --unlock');
      return;
  }
}

export function renderSyncResult(out: Output, result: SyncResult): void {
  const { m } = out;
  switch (result.status) {
    case 'REBASED':
      out.line('ok', m.sync.rebased(result.agent, out.sha(result.mainHead), result.rebasedCommits));
      if (result.stashed) out.detail(m.sync.stashed);
      return;
    case 'UP_TO_DATE':
      out.line('ok', m.sync.upToDate(result.agent));
      return;
    case 'SKIPPED_DIRTY':
      out.line(
        'info',
        result.overlap
          ? m.sync.skippedOverlap(
              result.agent,
              result.overlap.map((f) => out.untrusted(f)).join(', '),
            )
          : m.sync.skippedDirty(result.agent, result.files.length),
      );
      return;
    case 'SKIPPED_SESSION':
      out.line('info', m.sync.skippedSession(result.agent, result.pid));
      return;
    case 'REBASE_CONFLICT':
      out.line('warn', m.sync.rebaseConflict(result.agent));
      if (result.stashKept) out.detail(m.sync.stashKept);
      return;
    case 'STASH_CONFLICT':
      out.line('error', m.sync.stashConflict(result.agent));
      return;
  }
}

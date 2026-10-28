/**
 * Résolution d'un ticket de conflit depuis VS Code. Rien n'est inventé ici :
 *  - lecture 3-way : `ticket.get` (BASE/OURS/THEIRS/tentative LLM), affichée en
 *    diffs natifs de VS Code sur des documents virtuels en lecture seule ;
 *  - préparation : `ticket.prepare` (amorce les `.resolved`) ;
 *  - édition : les fichiers `.resolved` / `.delete` du dossier du ticket,
 *    ouverts tels quels dans l'éditeur (dossier vérifié sous `.striart/conflicts/`) ;
 *  - application : `ticket.apply` — rejoue le merge SOUS le Test Gate, comme la CLI ;
 *  - clôture manuelle : `ticket.close`, saisie de l'identifiant exigée (sans Test Gate).
 */
import { lstat, readdir } from 'node:fs/promises';
import path from 'node:path';
import * as vscode from 'vscode';
import { sanitizeBlock, sanitizeLine } from '../core/sanitize.ts';
import type { TicketInfo } from '../core/types.ts';
import type { Controller } from './controller.ts';
import type { VirtualDocuments } from './documents.ts';
import { confirmModal, confirmTyped, reportError, type ErrorSink } from './feedback.ts';

const l10n = vscode.l10n;

interface Resolution {
  path: string;
  base: string | null;
  ours: string | null;
  theirs: string | null;
  llmAttempt: string | null;
}
interface TicketDetail {
  resolutions: Resolution[];
  log: string | null;
  resolutionInputs: Array<{ path: string; kind: string }>;
}

function asDetail(data: unknown): TicketDetail {
  const o = (typeof data === 'object' && data !== null ? data : {}) as Record<string, unknown>;
  const text = (v: unknown): string | null => (typeof v === 'string' ? v : null);
  const resolutions = (Array.isArray(o.resolutions) ? o.resolutions : [])
    .filter(
      (r): r is Record<string, unknown> =>
        typeof r === 'object' && r !== null && typeof (r as Record<string, unknown>).path === 'string',
    )
    .slice(0, 5000)
    .map((r) => ({
      path: r.path as string,
      base: text(r.base),
      ours: text(r.ours),
      theirs: text(r.theirs),
      llmAttempt: text(r.llmAttempt),
    }));
  const inputs = (Array.isArray(o.resolutionInputs) ? o.resolutionInputs : [])
    .filter((r): r is Record<string, unknown> => typeof r === 'object' && r !== null)
    .map((r) => ({ path: String(r.path ?? ''), kind: String(r.kind ?? '') }));
  return { resolutions, log: text(o.log), resolutionInputs: inputs };
}

/** Le dossier du ticket doit être un sous-dossier direct de `<root>/.striart/conflicts/` (jamais un chemin du serveur pris tel quel). */
export async function safeTicketDir(root: string, ticket: TicketInfo): Promise<string | null> {
  const norm = (p: string) => (process.platform === 'win32' ? p.toLowerCase() : p);
  const base = path.resolve(root, '.striart', 'conflicts');
  const dir = path.resolve(ticket.dir);
  if (norm(path.dirname(dir)) !== norm(base) || path.basename(dir) !== ticket.id) return null;
  try {
    const info = await lstat(dir);
    return info.isDirectory() && !info.isSymbolicLink() ? dir : null;
  } catch {
    // Dossier absent : rien à ouvrir.
    return null;
  }
}

export class TicketResolver {
  private readonly busy = new Set<string>();

  constructor(
    private readonly controller: Controller,
    private readonly docs: VirtualDocuments,
    private readonly sink: ErrorSink,
  ) {}

  async resolve(ticketId?: string): Promise<void> {
    const state = this.controller.state;
    if (!state) return;
    const open = state.tickets.filter((t) => !t.resolved);
    if (open.length === 0) {
      void vscode.window.showInformationMessage(l10n.t('No open conflict ticket.'));
      return;
    }
    let ticket = ticketId ? open.find((t) => t.id === ticketId) : undefined;
    if (!ticket) {
      const pick = await vscode.window.showQuickPick(
        open.map((t) => ({
          label: sanitizeLine(t.id, 90),
          description: [t.agent, t.reason]
            .filter(Boolean)
            .map((v) => sanitizeLine(v, 40))
            .join(' · '),
          ticket: t,
        })),
        { title: l10n.t('Resolve a conflict ticket'), placeHolder: l10n.t('Choose a ticket'), ignoreFocusOut: true },
      );
      ticket = pick?.ticket;
    }
    if (!ticket) return;
    if (this.busy.has(ticket.id)) return;
    this.busy.add(ticket.id);
    try {
      await this.menu(ticket);
    } finally {
      this.busy.delete(ticket.id);
    }
  }

  private async menu(ticket: TicketInfo): Promise<void> {
    if (ticket.corrupt) {
      await this.closeByHand(ticket);
      return;
    }
    let detail: TicketDetail;
    try {
      detail = asDetail((await this.controller.call('ticket.get', { id: ticket.id })).data);
    } catch (error) {
      await reportError(this.sink, l10n.t('Reading the ticket'), error);
      return;
    }
    for (;;) {
      const choice = await vscode.window.showQuickPick(
        [
          { label: l10n.t('$(diff) Compare versions (BASE / OURS / THEIRS / LLM)…'), id: 'compare' },
          { label: l10n.t('$(output) Show the Test Gate log'), id: 'log' },
          { label: l10n.t('$(wand) Prepare resolution files…'), id: 'prepare' },
          { label: l10n.t('$(edit) Edit prepared resolution files…'), id: 'edit' },
          { label: l10n.t('$(check) Apply resolution under the Test Gate'), id: 'apply' },
          { label: l10n.t('$(warning) Close by hand (no Test Gate)…'), id: 'close' },
        ],
        {
          title: l10n.t('Ticket {0}', sanitizeLine(ticket.id, 90)),
          placeHolder: l10n.t(
            '{0} conflicting file(s) from agent {1}',
            ticket.conflictedFiles.length,
            sanitizeLine(ticket.agent ?? '?', 64),
          ),
          ignoreFocusOut: true,
        },
      );
      if (!choice) return;
      switch (choice.id) {
        case 'compare':
          await this.compare(ticket, detail);
          break;
        case 'log':
          await this.showLog(ticket, detail);
          break;
        case 'prepare':
          detail = (await this.prepare(ticket, detail)) ?? detail;
          break;
        case 'edit':
          await this.edit(ticket);
          break;
        case 'apply':
          if (await this.apply(ticket)) return;
          break;
        case 'close':
          if (await this.closeByHand(ticket)) return;
          break;
      }
    }
  }

  private async compare(ticket: TicketInfo, detail: TicketDetail): Promise<void> {
    if (detail.resolutions.length === 0) {
      void vscode.window.showInformationMessage(l10n.t('This ticket holds no file versions.'));
      return;
    }
    const file =
      detail.resolutions.length === 1
        ? detail.resolutions[0]
        : (
            await vscode.window.showQuickPick(
              detail.resolutions.map((r) => ({ label: sanitizeLine(r.path, 200), r })),
              { title: l10n.t('Choose a file'), ignoreFocusOut: true },
            )
          )?.r;
    if (!file) return;
    const pairs: Array<{
      label: string;
      left: string | null;
      right: string | null;
      leftName: string;
      rightName: string;
    }> = [
      {
        label: l10n.t('OURS (target branch) ↔ THEIRS (agent)'),
        left: file.ours,
        right: file.theirs,
        leftName: 'ours',
        rightName: 'theirs',
      },
      {
        label: l10n.t('BASE ↔ THEIRS (agent changes)'),
        left: file.base,
        right: file.theirs,
        leftName: 'base',
        rightName: 'theirs',
      },
      {
        label: l10n.t('BASE ↔ OURS (target changes)'),
        left: file.base,
        right: file.ours,
        leftName: 'base',
        rightName: 'ours',
      },
    ];
    if (file.llmAttempt !== null) {
      pairs.push({
        label: l10n.t('OURS ↔ semantic merge attempt (LLM)'),
        left: file.ours,
        right: file.llmAttempt,
        leftName: 'ours',
        rightName: 'llm-attempt',
      });
    }
    const pair = await vscode.window.showQuickPick(
      pairs.map((p) => ({ label: p.label, p })),
      { title: l10n.t('Compare {0}', sanitizeLine(file.path, 120)), ignoreFocusOut: true },
    );
    if (!pair) return;
    const base = path.posix.basename(file.path.replaceAll('\\', '/')) || 'file';
    const left = this.docs.put(`${ticket.id}/${pair.p.leftName}`, base, pair.p.left ?? '');
    const right = this.docs.put(`${ticket.id}/${pair.p.rightName}`, base, pair.p.right ?? '');
    await vscode.commands.executeCommand(
      'vscode.diff',
      left,
      right,
      `${sanitizeLine(file.path, 80)} (${pair.p.leftName} ↔ ${pair.p.rightName})`,
    );
  }

  private async showLog(ticket: TicketInfo, detail: TicketDetail): Promise<void> {
    if (!detail.log) {
      void vscode.window.showInformationMessage(l10n.t('This ticket has no Test Gate log.'));
      return;
    }
    const uri = this.docs.put(ticket.id, 'test-gate.log', sanitizeBlock(detail.log, 500_000));
    await vscode.window.showTextDocument(uri, { preview: true });
  }

  private async prepare(ticket: TicketInfo, detail: TicketDetail): Promise<TicketDetail | null> {
    const files = detail.resolutions.map((r) => r.path);
    let acceptTheirs: string[] = [];
    if (files.length > 0) {
      const picked = await vscode.window.showQuickPick(
        files.map((f) => ({ label: sanitizeLine(f, 200), file: f })),
        {
          title: l10n.t('Prepare resolution files'),
          placeHolder: l10n.t(
            'Tick the files where you accept the agent version as-is (optional; others start from the target branch)',
          ),
          canPickMany: true,
          ignoreFocusOut: true,
        },
      );
      if (picked === undefined) return null;
      acceptTheirs = picked.map((p) => p.file);
    }
    try {
      await this.controller.call('ticket.prepare', { id: ticket.id, acceptTheirs }, 'action');
      void vscode.window.showInformationMessage(
        l10n.t('Resolution files prepared for ticket {0}. Edit them, then apply.', sanitizeLine(ticket.id, 90)),
      );
      return asDetail((await this.controller.call('ticket.get', { id: ticket.id })).data);
    } catch (error) {
      await reportError(this.sink, l10n.t('Preparing the resolution'), error);
      return null;
    }
  }

  private async edit(ticket: TicketInfo): Promise<void> {
    const root = this.controller.root;
    const dir = root ? await safeTicketDir(root, ticket) : null;
    if (!dir) {
      void vscode.window.showWarningMessage(
        l10n.t('The ticket folder is not where expected under .striart/conflicts; refusing to open it.'),
      );
      return;
    }
    const names = (await readdir(dir)).filter((n) => n.endsWith('.resolved') || n.endsWith('.delete')).sort();
    if (names.length === 0) {
      void vscode.window.showInformationMessage(
        l10n.t('No prepared resolution file yet. Use "Prepare resolution files" first.'),
      );
      return;
    }
    const pick = await vscode.window.showQuickPick(
      names.map((n) => ({ label: sanitizeLine(n, 200), name: n })),
      { title: l10n.t('Open a resolution file'), ignoreFocusOut: true },
    );
    if (!pick) return;
    await vscode.window.showTextDocument(vscode.Uri.file(path.join(dir, pick.name)));
  }

  private async apply(ticket: TicketInfo): Promise<boolean> {
    const ok = await confirmModal(
      l10n.t('Apply the resolution of ticket {0}?', sanitizeLine(ticket.id, 90)),
      l10n.t(
        'Striart replays the merge with your prepared files under the main lock, then runs the Test Gate. It only commits if the gate is green; otherwise the ticket stays open.',
      ),
      l10n.t('Apply'),
    );
    if (!ok) return false;
    try {
      const result = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: l10n.t('Applying resolution (Test Gate)…') },
        () => this.controller.call('ticket.apply', { id: ticket.id }, 'action'),
      );
      const status =
        typeof (result.data as { result?: { status?: unknown } })?.result?.status === 'string'
          ? (result.data as { result: { status: string } }).result.status
          : 'UNKNOWN';
      if (status === 'MERGED') {
        void vscode.window.showInformationMessage(
          l10n.t('Ticket {0} resolved and merged.', sanitizeLine(ticket.id, 90)),
        );
        return true;
      }
      if (status === 'ALREADY_CLEAN') {
        void vscode.window.showInformationMessage(
          l10n.t('Ticket {0}: nothing left to merge.', sanitizeLine(ticket.id, 90)),
        );
        return true;
      }
      void vscode.window.showWarningMessage(
        l10n.t(
          'Ticket {0} stays open: the Test Gate is red or the resolution is incomplete ({1}).',
          sanitizeLine(ticket.id, 90),
          sanitizeLine(status, 40),
        ),
      );
      return false;
    } catch (error) {
      await reportError(this.sink, l10n.t('Applying the resolution'), error);
      return false;
    }
  }

  private async closeByHand(ticket: TicketInfo): Promise<boolean> {
    const ok = await confirmTyped({
      title: l10n.t('Close ticket {0} by hand', sanitizeLine(ticket.id, 90)),
      consequence: l10n.t('This marks the ticket resolved WITHOUT merging anything and WITHOUT the Test Gate.'),
      expected: ticket.id,
    });
    if (!ok) return false;
    try {
      await this.controller.call('ticket.close', { id: ticket.id }, 'action');
      void vscode.window.showInformationMessage(l10n.t('Ticket {0} closed.', sanitizeLine(ticket.id, 90)));
      return true;
    } catch (error) {
      await reportError(this.sink, l10n.t('Closing the ticket'), error);
      return false;
    }
  }
}

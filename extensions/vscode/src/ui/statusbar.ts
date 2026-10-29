/** Barre d'état : agents, conflits, demandes, watcher, hors ligne. Texte + icône (jamais la couleur seule). */
import * as vscode from 'vscode';
import { summarize } from '../core/model.ts';
import { sanitizeLine } from '../core/sanitize.ts';
import type { Controller } from './controller.ts';
import { plural } from './text.ts';

const l10n = vscode.l10n;

export class StriartStatusBar implements vscode.Disposable {
  private readonly item: vscode.StatusBarItem;
  private readonly subscription: vscode.Disposable;

  constructor(private readonly controller: Controller) {
    this.item = vscode.window.createStatusBarItem('striart.status', vscode.StatusBarAlignment.Left, 50);
    this.item.name = 'Striart';
    this.item.command = 'workbench.view.extension.striart';
    this.subscription = controller.onDidChange(() => this.render());
    this.render();
  }

  get text(): string {
    return this.item.text;
  }

  dispose(): void {
    this.subscription.dispose();
    this.item.dispose();
  }

  render(): void {
    const { connection, state, status } = this.controller.snapshot;
    this.item.backgroundColor = undefined;
    switch (connection) {
      case 'no-folder':
        this.item.hide();
        return;
      case 'restricted':
        this.show(
          '$(shield) Striart',
          l10n.t('Striart is inactive: this workspace is not trusted.'),
          l10n.t('Striart: restricted mode, workspace not trusted'),
        );
        return;
      case 'not-initialized':
        this.show(
          '$(circle-slash) Striart',
          l10n.t('This folder is not a Striart repository (run `striart init`).'),
          l10n.t('Striart: repository not initialized'),
        );
        return;
      case 'binary-missing':
        this.item.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
        this.show(
          '$(error) Striart',
          sanitizeLine(status?.detail ?? l10n.t('The striart binary could not be started.'), 300),
          l10n.t('Striart: binary unavailable'),
        );
        return;
      case 'blocked':
        this.item.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
        this.show(
          '$(lock) Striart',
          sanitizeLine(status?.detail ?? l10n.t('Striart refused the connection.'), 300),
          l10n.t('Striart: connection refused'),
        );
        return;
      case 'idle':
      case 'connecting':
      case 'stopped':
        this.show('$(sync~spin) Striart', l10n.t('Connecting to Striart…'), l10n.t('Striart: connecting'));
        return;
      case 'offline': {
        this.item.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
        const text = l10n.t('$(debug-disconnect) Striart offline');
        this.show(text, this.offlineTooltip(), l10n.t('Striart: offline, data may be stale'));
        return;
      }
      case 'connected':
        break;
    }
    if (!state) {
      this.show('$(sync~spin) Striart', l10n.t('Waiting for the first state…'), l10n.t('Striart: loading'));
      return;
    }
    const s = summarize(state);
    const parts: string[] = [plural(s.agents, l10n.t('{0} agent', s.agents), l10n.t('{0} agents', s.agents))];
    if (s.openTickets > 0) {
      parts.push(plural(s.openTickets, l10n.t('{0} conflict', s.openTickets), l10n.t('{0} conflicts', s.openTickets)));
    }
    if (s.requests > 0) {
      parts.push(plural(s.requests, l10n.t('{0} request', s.requests), l10n.t('{0} requests', s.requests)));
    }
    parts.push(s.watcher === 'running' ? l10n.t('watcher on') : l10n.t('watcher off'));
    const attention = s.openTickets > 0 || s.requests > 0;
    if (attention) this.item.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
    const icon = attention ? '$(warning)' : '$(git-merge)';
    const text = `${icon} ${parts.join(' · ')}`;
    const tooltip = [
      l10n.t('Running: {0}', s.running),
      l10n.t('Ready to merge: {0}', s.toMerge),
      l10n.t('Queued tasks: {0}', s.queued),
      s.watcher === 'running'
        ? l10n.t('Watcher: running')
        : s.watcher === 'stale'
          ? l10n.t('Watcher: stale PID file')
          : l10n.t('Watcher: stopped'),
      s.manualMode ? l10n.t('Manual mode: semantic merge disabled') : '',
    ]
      .filter(Boolean)
      .join('\n');
    this.show(text, tooltip, `Striart: ${parts.join(', ')}`);
  }

  private offlineTooltip(): string {
    const { status } = this.controller.snapshot;
    const lines = [l10n.t('The connection to Striart was lost. The tree shows the last known state.')];
    if (status?.detail) lines.push(sanitizeLine(status.detail, 300));
    if (status?.nextRetryAt) {
      lines.push(l10n.t('Reconnecting (attempt {0} of {1})…', status.attempt, status.maxAttempts));
    } else {
      lines.push(l10n.t('Automatic reconnection stopped. Run "Striart: Reconnect".'));
    }
    return lines.join('\n');
  }

  private show(text: string, tooltip: string, accessibilityLabel: string): void {
    this.item.text = text;
    this.item.tooltip = new vscode.MarkdownString().appendText(tooltip);
    this.item.accessibilityInformation = { label: accessibilityLabel, role: 'button' };
    this.item.show();
  }
}

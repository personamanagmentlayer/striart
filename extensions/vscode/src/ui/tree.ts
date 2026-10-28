/**
 * Vue arborescente « Striart » : agents regroupés (À traiter / En cours /
 * Inactifs), file d'attente. Tout vient de `state.get` / `state.changed`.
 * Le statut est toujours porté par un MOT (description + accessibilityInformation),
 * l'icône colorée n'est qu'un renfort. Le texte venu des agents est neutralisé
 * et affiché en texte brut (MarkdownString.appendText, jamais de HTML/commandes).
 */
import * as vscode from 'vscode';
import {
  classifyAgent,
  openTickets,
  pendingElicitations,
  pendingPermissions,
  pendingReviews,
  summarize,
  waitingTasks,
  type AgentClass,
  type AgentStatusKey,
  type Tone,
} from '../core/model.ts';
import { sanitizeBlock, sanitizeLine } from '../core/sanitize.ts';
import type {
  AgentInfo,
  ControlState,
  ElicitationRequest,
  PermissionRequest,
  QueueRow,
  TicketInfo,
} from '../core/types.ts';
import type { Controller } from './controller.ts';
import { plural } from './text.ts';

const l10n = vscode.l10n;

export type Node =
  | { kind: 'group'; id: 'attention' | 'running' | 'idle' | 'queue'; count: number }
  | { kind: 'agent'; agent: AgentInfo; cls: AgentClass }
  | { kind: 'ticket'; ticket: TicketInfo }
  | { kind: 'request'; request: PermissionRequest | ElicitationRequest }
  | { kind: 'queue'; task: QueueRow }
  | { kind: 'info'; id: string; label: string; description?: string; icon: string; tone: Tone; tooltip?: string }
  | { kind: 'placeholder'; id: string; label: string; icon: string };

const TONE_COLOR: Record<Tone, string | undefined> = {
  error: 'charts.red',
  warn: 'charts.yellow',
  info: 'charts.blue',
  ok: 'charts.green',
  neutral: undefined,
};

function icon(id: string, tone: Tone): vscode.ThemeIcon {
  const color = TONE_COLOR[tone];
  return new vscode.ThemeIcon(id, color ? new vscode.ThemeColor(color) : undefined);
}

export function statusLabel(key: AgentStatusKey): string {
  switch (key) {
    case 'broken':
      return l10n.t('Broken clone');
    case 'missing':
      return l10n.t('Clone missing');
    case 'removing':
      return l10n.t('Being removed');
    case 'running':
      return l10n.t('Running');
    case 'recent-activity':
      return l10n.t('Recent activity');
    case 'to-merge':
      return l10n.t('Ready to merge');
    case 'idle':
      return l10n.t('Idle');
  }
}

const STATUS_ICON: Record<AgentStatusKey, string> = {
  broken: 'error',
  missing: 'warning',
  removing: 'trash',
  running: 'loading~spin',
  'recent-activity': 'pulse',
  'to-merge': 'git-pull-request',
  idle: 'circle-outline',
};

export function groupLabel(id: 'attention' | 'running' | 'idle' | 'queue'): string {
  switch (id) {
    case 'attention':
      return l10n.t('Needs attention');
    case 'running':
      return l10n.t('Running');
    case 'idle':
      return l10n.t('Idle');
    case 'queue':
      return l10n.t('Queue');
  }
}

export function agentDescription(agent: AgentInfo, cls: AgentClass): string {
  const parts = [statusLabel(cls.key)];
  if (agent.mode === 'autonomous') parts.push(l10n.t('autonomous'));
  if (agent.pendingCommits > 0) {
    parts.push(
      plural(
        agent.pendingCommits,
        l10n.t('{0} pending commit', agent.pendingCommits),
        l10n.t('{0} pending commits', agent.pendingCommits),
      ),
    );
  }
  return parts.join(' · ');
}

export class StriartTreeProvider implements vscode.TreeDataProvider<Node>, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;
  private readonly subscription: vscode.Disposable;

  constructor(private readonly controller: Controller) {
    this.subscription = controller.onDidChange(() => this.emitter.fire(undefined));
  }

  dispose(): void {
    this.subscription.dispose();
    this.emitter.dispose();
  }

  getTreeItem(node: Node): vscode.TreeItem {
    switch (node.kind) {
      case 'group': {
        const item = new vscode.TreeItem(
          groupLabel(node.id),
          node.id === 'idle' || node.id === 'queue'
            ? vscode.TreeItemCollapsibleState.Collapsed
            : vscode.TreeItemCollapsibleState.Expanded,
        );
        item.id = `group:${node.id}`;
        item.description = String(node.count);
        item.contextValue = `striart.group.${node.id}`;
        item.accessibilityInformation = { label: `${groupLabel(node.id)}, ${node.count}` };
        return item;
      }
      case 'agent':
        return this.agentItem(node.agent, node.cls);
      case 'ticket':
        return this.ticketItem(node.ticket);
      case 'request':
        return this.requestItem(node.request);
      case 'queue':
        return this.queueItem(node.task);
      case 'info': {
        const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.None);
        item.id = `info:${node.id}`;
        item.description = node.description;
        item.iconPath = icon(node.icon, node.tone);
        item.contextValue = 'striart.info';
        if (node.tooltip) item.tooltip = new vscode.MarkdownString().appendText(node.tooltip);
        item.accessibilityInformation = { label: `${node.label}${node.description ? `, ${node.description}` : ''}` };
        return item;
      }
      case 'placeholder': {
        const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.None);
        item.id = `placeholder:${node.id}`;
        item.iconPath = new vscode.ThemeIcon(node.icon);
        return item;
      }
    }
  }

  getChildren(node?: Node): Node[] {
    const { state, connection } = this.controller.snapshot;
    if (!state || connection === 'restricted' || connection === 'no-folder') return [];
    if (!node) return this.roots(state);
    if (node.kind !== 'group') return [];
    return this.children(node.id, state);
  }

  /** Libellés aplatis (tests de bout en bout). */
  flattenLabels(): string[] {
    const out: string[] = [];
    const visit = (node: Node, depth: number) => {
      const item = this.getTreeItem(node);
      const label = typeof item.label === 'string' ? item.label : (item.label?.label ?? '');
      out.push(`${'  '.repeat(depth)}${label}${item.description ? ` | ${String(item.description)}` : ''}`);
      for (const child of this.getChildren(node)) visit(child, depth + 1);
    };
    for (const root of this.getChildren()) visit(root, 0);
    return out;
  }

  private roots(state: ControlState): Node[] {
    const roots: Node[] = [];
    const attention = this.children('attention', state);
    if (attention.length > 0) roots.push({ kind: 'group', id: 'attention', count: attention.length });
    const running = this.children('running', state);
    if (running.length > 0) roots.push({ kind: 'group', id: 'running', count: running.length });
    const idle = this.children('idle', state);
    if (idle.length > 0) roots.push({ kind: 'group', id: 'idle', count: idle.length });
    const queue = this.children('queue', state);
    if (queue.length > 0) roots.push({ kind: 'group', id: 'queue', count: queue.length });
    return roots;
  }

  private children(id: 'attention' | 'running' | 'idle' | 'queue', state: ControlState): Node[] {
    const summary = summarize(state);
    const agents = state.agents.map((agent) => ({ agent, cls: classifyAgent(agent) }));
    switch (id) {
      case 'attention': {
        const nodes: Node[] = [];
        for (const request of [...pendingPermissions(state), ...pendingElicitations(state)]) {
          nodes.push({ kind: 'request', request });
        }
        for (const ticket of openTickets(state)) nodes.push({ kind: 'ticket', ticket });
        for (const review of pendingReviews(state)) {
          nodes.push({
            kind: 'info',
            id: `review:${review.id}`,
            label: l10n.t('Review pending: {0}', sanitizeLine(review.agent, 64)),
            description: l10n.t('answer from the dashboard'),
            icon: 'eye',
            tone: 'warn',
          });
        }
        for (const { agent, cls } of agents) if (cls.group === 'attention') nodes.push({ kind: 'agent', agent, cls });
        if (summary.unwatchedPending) {
          nodes.push({
            kind: 'info',
            id: 'watcher',
            label: l10n.t('Watcher stopped'),
            description: l10n.t('commits are not merged automatically'),
            icon: 'eye-closed',
            tone: 'warn',
            tooltip: l10n.t(
              'Agents have unmerged commits and no watcher is running. Merge them from here or start the watcher (striart watch).',
            ),
          });
        }
        if (state.state.manualMode) {
          nodes.push({
            kind: 'info',
            id: 'manual',
            label: l10n.t('Manual mode'),
            description: l10n.t('semantic merge disabled'),
            icon: 'tools',
            tone: 'warn',
            tooltip: l10n.t('Consecutive semantic merge failures switched Striart to manual mode.'),
          });
        }
        if (state.mainSession?.alive) {
          nodes.push({
            kind: 'info',
            id: 'main-session',
            label: l10n.t('Main repository session'),
            description: sanitizeLine(state.mainSession.reason, 80),
            icon: 'lock',
            tone: 'info',
            tooltip: l10n.t(
              'A session is declared on the main repository: mutating operations are blocked until it ends.',
            ),
          });
        }
        return nodes;
      }
      case 'running':
        return agents.filter((a) => a.cls.group === 'running').map(({ agent, cls }) => ({ kind: 'agent', agent, cls }));
      case 'idle':
        return agents.filter((a) => a.cls.group === 'idle').map(({ agent, cls }) => ({ kind: 'agent', agent, cls }));
      case 'queue':
        return waitingTasks(state).map((task) => ({ kind: 'queue', task }));
    }
  }

  private agentItem(agent: AgentInfo, cls: AgentClass): vscode.TreeItem {
    const item = new vscode.TreeItem(agent.name, vscode.TreeItemCollapsibleState.None);
    item.id = `agent:${agent.name}`;
    const description = agentDescription(agent, cls);
    item.description = description;
    item.iconPath = icon(STATUS_ICON[cls.key], cls.tone);
    item.contextValue = cls.mergeable ? 'striart.agent.mergeable' : 'striart.agent';
    item.accessibilityInformation = { label: `${agent.name}, ${description}`, role: 'treeitem' };
    const tip = new vscode.MarkdownString();
    tip.appendText(`${agent.name}\n${description}\n`);
    if (agent.branch) tip.appendText(`${l10n.t('Branch')}: ${sanitizeLine(agent.branch, 120)}\n`);
    if (agent.profile) tip.appendText(`${l10n.t('Profile')}: ${sanitizeLine(agent.profile, 80)}\n`);
    if (agent.session?.pid) tip.appendText(`PID: ${agent.session.pid}\n`);
    if (agent.lastMessage) tip.appendText(`${l10n.t('Last commit')}: ${sanitizeBlock(agent.lastMessage, 300)}`);
    item.tooltip = tip;
    return item;
  }

  private ticketItem(ticket: TicketInfo): vscode.TreeItem {
    const label = ticket.corrupt
      ? l10n.t('Corrupt ticket {0}', sanitizeLine(ticket.id, 90))
      : sanitizeLine(ticket.id, 90);
    const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
    item.id = `ticket:${ticket.id}`;
    const parts = [l10n.t('Conflict ticket')];
    if (ticket.agent) parts.push(sanitizeLine(ticket.agent, 64));
    if (ticket.reason) parts.push(sanitizeLine(ticket.reason, 40));
    if (ticket.conflictedFiles.length > 0) {
      parts.push(
        plural(
          ticket.conflictedFiles.length,
          l10n.t('{0} file', ticket.conflictedFiles.length),
          l10n.t('{0} files', ticket.conflictedFiles.length),
        ),
      );
    }
    item.description = parts.join(' · ');
    item.iconPath = icon('git-merge', 'error');
    item.contextValue = 'striart.ticket';
    item.accessibilityInformation = { label: `${label}, ${item.description}` };
    const tip = new vscode.MarkdownString();
    tip.appendText(`${label}\n${item.description}\n`);
    for (const file of ticket.conflictedFiles.slice(0, 20)) tip.appendText(`• ${sanitizeLine(file, 200)}\n`);
    item.tooltip = tip;
    return item;
  }

  private requestItem(request: PermissionRequest | ElicitationRequest): vscode.TreeItem {
    const isPermission = request.kind === 'permission';
    const text = sanitizeLine(isPermission ? request.title : request.message, 120);
    const label = `${sanitizeLine(request.agent, 64)}: ${text}`;
    const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
    item.id = `request:${request.id}`;
    item.description = isPermission ? l10n.t('permission request') : l10n.t('question from the agent');
    item.iconPath = icon(isPermission ? 'shield' : 'question', 'warn');
    item.contextValue = 'striart.request';
    item.accessibilityInformation = { label: `${label}, ${item.description}` };
    item.command = {
      command: 'striart.answerRequest',
      title: l10n.t('Answer'),
      arguments: [{ kind: 'request', request }],
    };
    item.tooltip = new vscode.MarkdownString().appendText(
      `${item.description}\n${sanitizeBlock(isPermission ? request.title : request.message, 600)}\n${l10n.t('Expires')}: ${sanitizeLine(request.expiresAt, 40)}`,
    );
    return item;
  }

  private queueItem(task: QueueRow): vscode.TreeItem {
    const item = new vscode.TreeItem(sanitizeLine(task.agent, 64), vscode.TreeItemCollapsibleState.None);
    item.id = `queue:${task.id}`;
    const parts = [task.ready ? l10n.t('ready to start') : l10n.t('waiting')];
    if (task.blockedBy > 0)
      parts.push(
        plural(
          task.blockedBy,
          l10n.t('blocked by {0} collision', task.blockedBy),
          l10n.t('blocked by {0} collisions', task.blockedBy),
        ),
      );
    item.description = parts.join(' · ');
    item.iconPath = icon('clock', task.ready ? 'info' : 'neutral');
    item.contextValue = task.ready ? 'striart.queueTask' : 'striart.queueTask.blocked';
    item.accessibilityInformation = { label: `${task.agent}, ${item.description}` };
    const tip = new vscode.MarkdownString();
    for (const file of task.files.slice(0, 20)) tip.appendText(`• ${sanitizeLine(file, 200)}\n`);
    item.tooltip = tip;
    return item;
  }
}

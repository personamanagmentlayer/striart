/**
 * Commandes de la palette et de la vue. Chaque action est UN appel de méthode
 * du Control Protocol (plan humain) ; l'extension ne décide rien : elle
 * confirme proportionnellement au risque, appelle, présente l'issue.
 */
import * as vscode from 'vscode';
import { findOnPath } from '../core/binary.ts';
import { RpcError } from '../core/errors.ts';
import { agentClone, gitDiff } from '../core/git.ts';
import { classifyAgent, pendingRequests, type HumanRequest } from '../core/model.ts';
import { hasUnsafeChars, sanitizeBlock, sanitizeLine } from '../core/sanitize.ts';
import type { AgentInfo, ControlState } from '../core/types.ts';
import type { Controller } from './controller.ts';
import { childEnv } from './controller.ts';
import type { VirtualDocuments } from './documents.ts';
import { confirmModal, confirmTyped, reportError, type ErrorSink } from './feedback.ts';
import { runStriartJson, validateSignInUrl } from './oneshot.ts';
import type { RequestNotifier } from './requests.ts';
import type { TicketResolver } from './tickets.ts';
import type { Node } from './tree.ts';
import { agentDescription } from './tree.ts';

const l10n = vscode.l10n;

type Json = Record<string, unknown>;
const asObj = (v: unknown): Json => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Json) : {});
const asStr = (v: unknown): string => (typeof v === 'string' ? v : '');

export class Actions {
  private readonly busy = new Set<string>();

  constructor(
    private readonly controller: Controller,
    private readonly sink: ErrorSink,
    private readonly docs: VirtualDocuments,
    private readonly tickets: TicketResolver,
    private readonly requests: RequestNotifier,
  ) {}

  // ─── Utilitaires ──────────────────────────────────────────────────────────

  private requireState(): ControlState | null {
    const state = this.controller.state;
    if (!state || !this.controller.isConnected) {
      void vscode.window
        .showWarningMessage(l10n.t('Striart is not connected.'), l10n.t('Reconnect'))
        .then((c) => c && vscode.commands.executeCommand('striart.reconnect'));
      return null;
    }
    return state;
  }

  /** Verrou local : empêche de lancer deux fois la même action sur la même cible. */
  private async exclusive(key: string, work: () => Promise<void>): Promise<void> {
    if (this.busy.has(key)) {
      void vscode.window.showInformationMessage(l10n.t('This action is already in progress.'));
      return;
    }
    this.busy.add(key);
    try {
      await work();
    } finally {
      this.busy.delete(key);
    }
  }

  /**
   * Notification à boutons qui ne retient JAMAIS l'action appelante : le verrou
   * local d'une action ne doit pas dépendre du moment où l'utilisateur ferme
   * une notification. Le choix déclenche `run`, la fermeture ne fait rien.
   */
  private offer(level: 'info' | 'warn', message: string, buttons: Array<{ label: string; run: () => unknown }>): void {
    const labels = buttons.map((b) => b.label);
    const shown =
      level === 'warn'
        ? vscode.window.showWarningMessage(message, ...labels)
        : vscode.window.showInformationMessage(message, ...labels);
    void shown.then((choice) => {
      const button = buttons.find((b) => b.label === choice);
      if (button) void Promise.resolve(button.run()).catch((e) => this.sink.log.error(String(e)));
    });
  }

  private progress<T>(title: string, work: () => Promise<T>): Thenable<T> {
    return vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title }, work);
  }

  private agentFromArg(arg: unknown): string | null {
    const node = arg as Node | undefined;
    if (node && typeof node === 'object' && 'kind' in node) {
      if (node.kind === 'agent') return node.agent.name;
      if (node.kind === 'queue') return node.task.agent;
    }
    return null;
  }

  private async pickAgent(
    state: ControlState,
    title: string,
    filter: (a: AgentInfo) => boolean,
  ): Promise<AgentInfo | null> {
    const candidates = state.agents.filter((a) => a.status !== 'REMOVING' && filter(a));
    if (candidates.length === 0) {
      void vscode.window.showInformationMessage(l10n.t('No agent matches.'));
      return null;
    }
    const pick = await vscode.window.showQuickPick(
      candidates.map((agent) => ({
        label: agent.name,
        description: agentDescription(agent, classifyAgent(agent)),
        agent,
      })),
      { title, placeHolder: l10n.t('Choose an agent'), ignoreFocusOut: true },
    );
    return pick?.agent ?? null;
  }

  private async resolveAgent(
    arg: unknown,
    title: string,
    filter: (a: AgentInfo) => boolean = () => true,
  ): Promise<AgentInfo | null> {
    const state = this.requireState();
    if (!state) return null;
    const name = this.agentFromArg(arg);
    if (name) {
      const known = state.agents.find((a) => a.name === name);
      if (known) return known;
    }
    return this.pickAgent(state, title, filter);
  }

  // ─── Connexion ────────────────────────────────────────────────────────────

  reconnect(): void {
    this.controller.reconnect();
  }

  refresh(): void {
    // L'état est poussé par notification (aucun polling) ; « actualiser » force une reconnexion si l'on est hors ligne.
    if (!this.controller.isConnected) this.controller.reconnect();
    else
      void vscode.window.setStatusBarMessage(
        l10n.t('Striart is up to date: the view refreshes on every change.'),
        3000,
      );
  }

  // ─── Merge / sync / stop ──────────────────────────────────────────────────

  async merge(arg?: unknown): Promise<void> {
    const agent = await this.resolveAgent(arg, l10n.t('Merge an agent'), (a) => a.pendingCommits > 0);
    const state = this.controller.state;
    if (!agent || !state) return;
    const ok = await confirmModal(
      l10n.t('Merge {0} into {1}?', agent.name, sanitizeLine(state.config.targetBranch, 80)),
      l10n.t(
        'Striart rebases the agent commits, merges them and runs the blocking Test Gate ({0}). This can take several minutes. On a conflict or a red gate nothing is committed and a ticket is created.',
        sanitizeLine(state.config.testCommand, 120),
      ),
      l10n.t('Merge'),
    );
    if (!ok) return;
    await this.exclusive(`merge:${agent.name}`, async () => {
      try {
        const result = await this.progress(l10n.t('Merging {0} (Test Gate)…', agent.name), () =>
          this.controller.call('agent.merge', { agent: agent.name }, 'action'),
        );
        await this.presentMerge(agent.name, asObj(result.data));
      } catch (error) {
        await reportError(this.sink, l10n.t('Merging {0}', agent.name), error);
      }
    });
  }

  private async presentMerge(agent: string, data: Json): Promise<void> {
    const status = asStr(data.status);
    const ticket = asStr(asObj(data.ticket).id);
    const resolve = l10n.t('Resolve ticket');
    switch (status) {
      case 'MERGED': {
        const pushError = asStr(data.pushError);
        if (pushError) {
          void vscode.window.showWarningMessage(
            l10n.t('{0} merged, but the push failed: {1}', agent, sanitizeLine(pushError, 200)),
          );
        } else {
          void vscode.window.showInformationMessage(l10n.t('{0} merged into the target branch.', agent));
        }
        return;
      }
      case 'UP_TO_DATE':
        void vscode.window.showInformationMessage(l10n.t('{0} has nothing new to merge.', agent));
        return;
      case 'CONFLICT':
      case 'GATE_FAILED': {
        const message =
          status === 'GATE_FAILED'
            ? l10n.t(
                '{0}: the Test Gate is red. Nothing was committed; ticket {1} was created.',
                agent,
                sanitizeLine(ticket, 90),
              )
            : l10n.t(
                '{0}: merge conflict. Nothing was committed; ticket {1} was created.',
                agent,
                sanitizeLine(ticket, 90),
              );
        this.offer('warn', message, [{ label: resolve, run: () => ticket && this.tickets.resolve(ticket) }]);
        return;
      }
      default:
        void vscode.window.showWarningMessage(
          l10n.t('{0}: unexpected merge result ({1}).', agent, sanitizeLine(status || '?', 40)),
        );
        this.sink.log.warn(`agent.merge returned an unknown status "${sanitizeLine(status, 40)}"`);
    }
  }

  async sync(arg?: unknown): Promise<void> {
    const state = this.requireState();
    if (!state) return;
    let agent: string | null = this.agentFromArg(arg);
    if (!agent) {
      const all = l10n.t('All agents');
      const pick = await vscode.window.showQuickPick(
        [
          { label: all, name: null as string | null },
          ...state.agents
            .filter((a) => a.status === 'ACTIVE')
            .map((a) => ({ label: a.name, name: a.name as string | null })),
        ],
        { title: l10n.t('Synchronize with the target branch'), ignoreFocusOut: true },
      );
      if (!pick) return;
      agent = pick.name;
    }
    await this.exclusive(`sync:${agent ?? '*'}`, async () => {
      try {
        const result = await this.progress(l10n.t('Synchronizing…'), () =>
          this.controller.call('agent.sync', agent ? { agent } : {}, 'action'),
        );
        const results = Array.isArray(asObj(result.data).results) ? (asObj(result.data).results as unknown[]) : [];
        const problems = results
          .map(asObj)
          .filter((r) => !['SYNCED', 'UP_TO_DATE', 'REBASED'].includes(asStr(r.status)))
          .map((r) => `${sanitizeLine(asStr(r.agent), 64)}: ${sanitizeLine(asStr(r.status), 40)}`);
        if (problems.length === 0 && result.outcome === 'ok') {
          void vscode.window.showInformationMessage(l10n.t('Synchronized {0} agent(s).', results.length));
        } else {
          void vscode.window.showWarningMessage(
            l10n.t('Synchronization finished with remarks: {0}', problems.slice(0, 5).join('; ') || result.outcome),
          );
        }
      } catch (error) {
        await reportError(this.sink, l10n.t('Synchronizing'), error);
      }
    });
  }

  async stop(arg?: unknown): Promise<void> {
    const agent = await this.resolveAgent(arg, l10n.t('Stop an agent'));
    if (!agent) return;
    const ok = await confirmModal(
      l10n.t('Stop {0}?', agent.name),
      l10n.t('Striart stops tracking this agent. The stop is refused while it has unmerged commits.'),
      l10n.t('Stop'),
    );
    if (!ok) return;
    await this.exclusive(`stop:${agent.name}`, async () => {
      try {
        await this.stopCall(agent.name, false);
      } catch (error) {
        if (error instanceof RpcError && error.code === 'AGENT_HAS_PENDING') {
          await this.offerForceStop(agent.name);
          return;
        }
        await reportError(this.sink, l10n.t('Stopping {0}', agent.name), error);
      }
    });
  }

  private async stopCall(agent: string, force: boolean): Promise<void> {
    const result = await this.progress(l10n.t('Stopping {0}…', agent), () =>
      this.controller.call('agent.stop', { agent, force }, 'action'),
    );
    void vscode.window.showInformationMessage(l10n.t('{0} stopped.', agent));
    for (const w of result.warnings) void vscode.window.showWarningMessage(sanitizeLine(w.message, 300));
  }

  private async offerForceStop(agent: string): Promise<void> {
    const force = l10n.t('Force stop…');
    this.offer('warn', l10n.t('{0} has commits that are not merged yet. Merge them first, or force the stop.', agent), [
      { label: force, run: () => this.confirmAndForceStop(agent) },
    ]);
  }

  private async confirmAndForceStop(agent: string): Promise<void> {
    const ok = await confirmTyped({
      title: l10n.t('Force stop {0}', agent),
      consequence: l10n.t(
        'This removes the agent from the registry WITHOUT merging its pending commits and without the Test Gate. The clone stays on disk but Striart will no longer integrate it.',
      ),
      expected: agent,
    });
    if (!ok) return;
    await this.exclusive(`stop:${agent}`, async () => {
      try {
        await this.stopCall(agent, true);
      } catch (error) {
        await reportError(this.sink, l10n.t('Stopping {0}', agent), error);
      }
    });
  }

  async rollbackMerge(): Promise<void> {
    const state = this.requireState();
    if (!state) return;
    const branch = state.config.targetBranch;
    const ok = await confirmTyped({
      title: l10n.t('Roll back the last Striart merge of {0}', sanitizeLine(branch, 80)),
      consequence: l10n.t(
        'This undoes the last merge Striart made on the target branch (local reset if not pushed, revert if already published).',
      ),
      expected: branch,
    });
    if (!ok) return;
    await this.exclusive('rollback', async () => {
      try {
        const result = await this.progress(l10n.t('Rolling back…'), () =>
          this.controller.call('merge.rollback', {}, 'action'),
        );
        const data = asObj(result.data);
        void vscode.window.showInformationMessage(
          l10n.t(
            'Rolled back ({0}): {1} undone.',
            sanitizeLine(asStr(data.mode), 20),
            sanitizeLine(asStr(data.undoneSha).slice(0, 10), 12),
          ),
        );
      } catch (error) {
        await reportError(this.sink, l10n.t('Rolling back'), error);
      }
    });
  }

  async retryQueue(): Promise<void> {
    if (!this.requireState()) return;
    await this.exclusive('queue', async () => {
      try {
        const result = await this.controller.call('queue.retry', {}, 'action');
        const started = asObj(result.data).started;
        void vscode.window.showInformationMessage(
          l10n.t('Queue retried: {0} task(s) started.', Array.isArray(started) ? started.length : 0),
        );
      } catch (error) {
        await reportError(this.sink, l10n.t('Retrying the queue'), error);
      }
    });
  }

  // ─── Nouvelle tâche ───────────────────────────────────────────────────────

  async newTask(): Promise<void> {
    const state = this.requireState();
    if (!state) return;
    const prompt = await vscode.window.showInputBox({
      title: l10n.t('New Striart task'),
      prompt: l10n.t('What should the agent do? (the Router predicts the files and avoids collisions)'),
      ignoreFocusOut: true,
      validateInput: (v) =>
        v.trim() === '' ? l10n.t('Enter a prompt.') : v.length > 200_000 ? l10n.t('Prompt too long.') : undefined,
    });
    if (prompt === undefined) return;
    const mode = await vscode.window.showQuickPick(
      [
        {
          label: l10n.t('$(person) Attended'),
          description: l10n.t('Striart prepares a clone; you start your tool yourself'),
          id: 'attended' as const,
        },
        {
          label: l10n.t('$(rocket) Autonomous'),
          description: l10n.t('Striart runs a profile unattended, then merges under the Test Gate'),
          id: 'autonomous' as const,
        },
      ],
      { title: l10n.t('Execution mode'), ignoreFocusOut: true },
    );
    if (!mode) return;
    let profile: string | undefined;
    if (mode.id === 'autonomous') {
      const defaultLabel = l10n.t('Default profile');
      const pick = await vscode.window.showQuickPick(
        [
          { label: defaultLabel, name: undefined as string | undefined },
          ...state.profiles.map((p) => ({
            label: sanitizeLine(p.name, 80),
            description: p.acp ? 'ACP' : undefined,
            name: p.name as string | undefined,
          })),
        ],
        { title: l10n.t('Agent profile'), ignoreFocusOut: true },
      );
      if (!pick) return;
      profile = pick.name;
      const ok = await confirmModal(
        l10n.t('Run an autonomous session?'),
        l10n.t(
          'An agent will work WITHOUT supervision and may consume tokens. If the Test Gate passes, its work is merged into {0}.',
          sanitizeLine(state.config.targetBranch, 80),
        ),
        l10n.t('Run'),
      );
      if (!ok) return;
    }
    await this.exclusive('newTask', async () => {
      try {
        const result = await this.progress(l10n.t('Starting the task (Router)…'), () =>
          this.controller.call('task.run', { prompt, mode: mode.id, ...(profile ? { profile } : {}) }, 'action'),
        );
        await this.presentTask(asObj(result.data));
      } catch (error) {
        await reportError(this.sink, l10n.t('Starting the task'), error);
      }
    });
  }

  private async presentTask(data: Json): Promise<void> {
    if (data.mode === 'autonomous') {
      void vscode.window.showInformationMessage(
        l10n.t('Autonomous session launched. Its outcome is reported here and in the view.'),
      );
      return;
    }
    const run = asObj(data.run);
    if (run.status === 'STARTED') {
      const name = asStr(asObj(run.info).name);
      const open = l10n.t('Open terminal');
      this.offer('info', l10n.t('Task started on agent {0}.', sanitizeLine(name, 64)), [
        { label: open, run: () => name && this.openTerminal({ kind: 'agent-name', name }) },
      ]);
      return;
    }
    if (run.status === 'QUEUED') {
      void vscode.window.showInformationMessage(
        l10n.t('Task queued: files collide with a running agent. It starts when the way is clear.'),
      );
      return;
    }
    void vscode.window.showWarningMessage(
      l10n.t('Unexpected result starting the task ({0}).', sanitizeLine(asStr(run.status) || '?', 40)),
    );
  }

  // ─── Terminal, diff ───────────────────────────────────────────────────────

  async openTerminal(arg?: unknown): Promise<void> {
    const named =
      typeof arg === 'object' && arg !== null && (arg as { kind?: string }).kind === 'agent-name'
        ? (arg as { name: string }).name
        : null;
    const root = this.controller.root;
    if (!root) return;
    let agent: AgentInfo | null | undefined = null;
    if (named) agent = this.controller.state?.agents.find((a) => a.name === named);
    agent ??= await this.resolveAgent(arg, l10n.t('Open an agent terminal'), (a) => a.status === 'ACTIVE');
    if (!agent) return;
    const dir = await agentClone(root, agent.name);
    if (!dir) {
      void vscode.window.showWarningMessage(
        l10n.t('The clone of {0} was not found under .striart/agents.', agent.name),
      );
      return;
    }
    const terminal = vscode.window.createTerminal({ name: `Striart: ${agent.name}`, cwd: dir, isTransient: true });
    terminal.show();
    // Jamais d'exécution automatique : la commande est seulement PRÉ-SAISIE (sans Entrée), si elle est sûre.
    if (agent.command && !hasUnsafeChars(agent.command) && agent.command.length <= 500) {
      terminal.sendText(agent.command, false);
      void vscode.window.setStatusBarMessage(l10n.t('Command pre-filled: press Enter to run it.'), 5000);
    }
  }

  async showDiff(arg?: unknown): Promise<void> {
    const agent = await this.resolveAgent(arg, l10n.t('Show an agent diff'), (a) => a.pendingCommits > 0);
    const root = this.controller.root;
    if (!agent || !root) return;
    const dir = await agentClone(root, agent.name);
    if (!dir) {
      void vscode.window.showWarningMessage(
        l10n.t('The clone of {0} was not found under .striart/agents.', agent.name),
      );
      return;
    }
    if (agent.pendingCommits < 1) {
      void vscode.window.showInformationMessage(l10n.t('{0} has no pending commit.', agent.name));
      return;
    }
    try {
      const git = await findOnPath('git', {
        untrustedDirs: (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath),
      });
      if (!git) {
        void vscode.window.showWarningMessage(l10n.t('git was not found in PATH.'));
        return;
      }
      const patch = await gitDiff(git, dir, agent.pendingCommits, childEnv());
      const uri = this.docs.put(agent.name, `${agent.name}.diff`, patch || l10n.t('(empty diff)'));
      await vscode.window.showTextDocument(uri, { preview: true });
    } catch (error) {
      this.sink.log.error(`Diff of ${agent.name} failed: ${(error as Error).message}`);
      void vscode.window.showWarningMessage(
        l10n.t('Could not compute the diff of {0}: {1}', agent.name, sanitizeLine((error as Error).message, 200)),
      );
    }
  }

  // ─── Dashboard, doctor ────────────────────────────────────────────────────

  async openDashboard(): Promise<void> {
    const root = this.controller.root;
    if (!root || !this.requireState()) return;
    await this.exclusive('dashboard', async () => {
      try {
        const doc = await this.dashboardLink(root);
        if (doc === 'not-running') {
          this.offer('info', l10n.t('No dashboard is running for this repository.'), [
            { label: l10n.t('Start dashboard'), run: () => this.startDashboard(root) },
          ]);
          return;
        }
        await this.openLink(doc);
      } catch (error) {
        await reportError(this.sink, l10n.t('Opening the dashboard'), error);
      }
    });
  }

  private async startDashboard(root: string): Promise<void> {
    await this.exclusive('dashboard', async () => {
      try {
        await runStriartJson(root, ['dashboard', '--daemon']);
        let doc: string | 'not-running' | null = 'not-running';
        for (let attempt = 0; attempt < 6 && doc === 'not-running'; attempt += 1) {
          await new Promise((r) => setTimeout(r, 1000));
          doc = await this.dashboardLink(root);
        }
        await this.openLink(doc);
      } catch (error) {
        await reportError(this.sink, l10n.t('Opening the dashboard'), error);
      }
    });
  }

  private async openLink(doc: string | 'not-running' | null): Promise<void> {
    if (doc === 'not-running' || doc === null) {
      void vscode.window.showWarningMessage(l10n.t('The dashboard link is not ready yet. Try again in a moment.'));
      return;
    }
    const uri = validateSignInUrl(doc);
    if (!uri) {
      this.sink.log.error('Refused to open an unexpected dashboard link (not a loopback /auth URL).');
      void vscode.window.showErrorMessage(l10n.t('Striart returned an unexpected dashboard link; it was not opened.'));
      return;
    }
    await vscode.env.openExternal(uri);
  }

  /** URL du lien à usage unique, 'not-running' si aucun dashboard, null si le lien n'est pas encore prêt. */
  private async dashboardLink(root: string): Promise<string | 'not-running' | null> {
    try {
      const doc = await runStriartJson(root, ['dashboard', '--link']);
      const url = doc.data?.signInUrl;
      return typeof url === 'string' ? url : null;
    } catch (error) {
      if (error instanceof RpcError && error.code === 'CONTROL_INSTANCE_NOT_FOUND') return 'not-running';
      throw error;
    }
  }

  async doctor(): Promise<void> {
    if (!this.requireState()) return;
    await this.exclusive('doctor', async () => {
      try {
        const result = await this.progress(l10n.t('Running diagnostics…'), () =>
          this.controller.call('doctor.run', {}, 'action'),
        );
        const data = asObj(result.data);
        const checks = Array.isArray(data.checks) ? data.checks.map(asObj) : [];
        let warn = 0;
        let fail = 0;
        this.sink.log.info('— Striart doctor —');
        for (const c of checks.slice(0, 200)) {
          const level = asStr(c.level);
          if (level === 'warn') warn += 1;
          if (level === 'fail') fail += 1;
          const line = `[${level}] ${sanitizeLine(asStr(c.label), 120)}${c.detail ? ` — ${sanitizeLine(asStr(c.detail), 300)}` : ''}${c.hint ? ` (→ ${sanitizeLine(asStr(c.hint), 200)})` : ''}`;
          if (level === 'fail') this.sink.log.error(line);
          else if (level === 'warn') this.sink.log.warn(line);
          else this.sink.log.info(line);
        }
        const show = l10n.t('Show details');
        const buttons = [{ label: show, run: () => this.sink.log.show(true) }];
        if (data.healthy === true && warn === 0) {
          this.offer('info', l10n.t('Striart doctor: everything is healthy.'), buttons);
        } else {
          this.offer('warn', l10n.t('Striart doctor: {0} failure(s), {1} warning(s).', fail, warn), buttons);
        }
      } catch (error) {
        await reportError(this.sink, l10n.t('Running diagnostics'), error);
      }
    });
  }

  // ─── Demandes, tickets ────────────────────────────────────────────────────

  async answerRequest(arg?: unknown): Promise<void> {
    const state = this.requireState();
    if (!state) return;
    const node = arg as { kind?: string; request?: HumanRequest } | undefined;
    let request: HumanRequest | undefined = node?.kind === 'request' ? node.request : undefined;
    if (request) request = pendingRequests(state).find((r) => r.id === request?.id) ?? request;
    if (!request) {
      const pending = pendingRequests(state);
      if (pending.length === 0) {
        void vscode.window.showInformationMessage(l10n.t('No agent request is waiting.'));
        return;
      }
      const pick = await vscode.window.showQuickPick(
        pending.map((r) => ({
          label: `${sanitizeLine(r.agent, 64)}: ${sanitizeLine(r.kind === 'permission' ? r.title : r.message, 120)}`,
          description: r.kind === 'permission' ? l10n.t('permission request') : l10n.t('question from the agent'),
          request: r,
        })),
        { title: l10n.t('Answer an agent request'), ignoreFocusOut: true },
      );
      request = pick?.request;
    }
    if (request) await this.requests.answerRequest(request);
  }

  async resolveTicket(arg?: unknown): Promise<void> {
    if (!this.requireState()) return;
    const node = arg as Node | undefined;
    await this.tickets.resolve(node && typeof node === 'object' && node.kind === 'ticket' ? node.ticket.id : undefined);
  }

  showOutput(): void {
    this.sink.log.show(true);
  }

  /** Notification de fin de session autonome etc. relayée en message (control.notice). */
  showNotice(notice: { type: string; message: string }): void {
    const text = sanitizeBlock(notice.message, 300);
    if (/failed|blocked/.test(notice.type)) void vscode.window.showWarningMessage(text);
    else void vscode.window.showInformationMessage(text);
  }
}

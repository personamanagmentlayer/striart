/**
 * Point d'entrée. L'activation ne fait que construire les objets et
 * enregistrer les contributions : la connexion démarre en tâche de fond
 * (aucune I/O bloquante dans `activate`, budget < 200 ms).
 */
import * as vscode from 'vscode';
import { Actions } from './ui/actions.ts';
import { Controller } from './ui/controller.ts';
import { VirtualDocuments } from './ui/documents.ts';
import { RequestNotifier } from './ui/requests.ts';
import { StriartStatusBar } from './ui/statusbar.ts';
import { TicketResolver } from './ui/tickets.ts';
import { StriartTreeProvider } from './ui/tree.ts';

/** Surface exposée aux tests d'intégration (@vscode/test-electron) ; aucune action n'y est offerte. */
export interface StriartTestApi {
  snapshot(): { connection: string; agents: string[]; revision: number | null; launches: number };
  launches(): number;
  restart(): Promise<void>;
  /** Durée de `activate()` en millisecondes. */
  activationMs: number;
  /** Temps CPU consommé par `activate()` (insensible à la charge de la machine). */
  activationCpuMs: number;
  /** Jalons de l'activation (diagnostic de performance). */
  activationMarks: string[];
  /** Libellés aplatis de la vue (groupes puis enfants). */
  treeLabels(): string[];
  statusBarText(): string;
  /** Coupe brutalement le sous-process serveur (test de reprise). */
  dropConnection(): void;
}

let controller: Controller | undefined;

export function activate(context: vscode.ExtensionContext): StriartTestApi {
  const startedAt = performance.now();
  const cpuStart = process.cpuUsage();
  const marks: string[] = [];
  const mark = (name: string) => marks.push(`${name}=${(performance.now() - startedAt).toFixed(1)}`);
  const log = vscode.window.createOutputChannel('Striart', { log: true });
  const version = (context.extension.packageJSON as { version?: string }).version ?? '0.0.0';
  mark('log');
  const ctl = new Controller(log, version);
  mark('controller');
  controller = ctl;
  const sink = { log };
  const docs = new VirtualDocuments();
  const tickets = new TicketResolver(ctl, docs, sink);
  const notifier = new RequestNotifier(ctl, sink);
  const actions = new Actions(ctl, sink, docs, tickets, notifier);
  const tree = new StriartTreeProvider(ctl);
  const statusBar = new StriartStatusBar(ctl);
  mark('ui');

  const reg = (id: string, handler: (...args: unknown[]) => unknown) => vscode.commands.registerCommand(id, handler);

  const treeView = vscode.window.createTreeView('striart.agents', { treeDataProvider: tree, showCollapseAll: true });
  mark('treeView');
  const noticeSub = ctl.onNotice((notice) => actions.showNotice(notice));
  mark('notice');

  context.subscriptions.push(
    log,
    docs,
    notifier,
    tree,
    statusBar,
    treeView,
    noticeSub,
    (mark('pre-reg'), reg('striart.refresh', () => actions.refresh())),
    reg('striart.reconnect', () => actions.reconnect()),
    reg('striart.showOutput', () => actions.showOutput()),
    reg('striart.merge', (arg) => actions.merge(arg)),
    reg('striart.sync', (arg) => actions.sync(arg)),
    reg('striart.stop', (arg) => actions.stop(arg)),
    reg('striart.newTask', () => actions.newTask()),
    reg('striart.openTerminal', (arg) => actions.openTerminal(arg)),
    reg('striart.resolveTicket', (arg) => actions.resolveTicket(arg)),
    reg('striart.showDiff', (arg) => actions.showDiff(arg)),
    reg('striart.openDashboard', () => actions.openDashboard()),
    reg('striart.doctor', () => actions.doctor()),
    reg('striart.rollbackMerge', () => actions.rollbackMerge()),
    reg('striart.retryQueue', () => actions.retryQueue()),
    reg('striart.answerRequest', (arg) => actions.answerRequest(arg)),
    { dispose: () => void ctl.dispose() },
  );

  // Connexion en tâche de fond : `activate` rend la main immédiatement.
  mark('registered');
  void ctl.start();
  mark('started');
  const activationMs = performance.now() - startedAt;
  const cpu = process.cpuUsage(cpuStart);
  const activationCpuMs = (cpu.user + cpu.system) / 1000;

  return {
    snapshot: () => {
      const s = ctl.snapshot;
      return {
        connection: s.connection,
        agents: s.state?.agents.map((a) => a.name) ?? [],
        revision: s.state?.revision ?? null,
        launches: ctl.launches,
      };
    },
    launches: () => ctl.launches,
    restart: () => ctl.restart('test'),
    activationMs,
    activationCpuMs,
    activationMarks: marks,
    treeLabels: () => tree.flattenLabels(),
    statusBarText: () => statusBar.text,
    dropConnection: () => ctl.dropConnectionForTest(),
  };
}

export async function deactivate(): Promise<void> {
  await controller?.dispose();
  controller = undefined;
}

/**
 * Chef d'orchestre de la connexion : possède le client de protocole, applique
 * le Workspace Trust et les réglages, publie l'état à l'interface. Aucune
 * logique métier Striart.
 *
 * Workspace Trust : en espace NON fiable, aucun process n'est lancé. Ce n'est
 * pas seulement une prudence : `striart api` charge la configuration du dépôt
 * (`striart.config.mjs`, du code), donc même une « lecture seule » exécuterait
 * du code du dépôt. L'extension reste donc inerte (la vue l'explique) jusqu'à
 * l'octroi de la confiance, puis démarre d'elle-même.
 */
import path from 'node:path';
import * as vscode from 'vscode';
import { resolveStriartLaunch } from '../core/binary.ts';
import { ControlClient, type ConnectionStatus, type StatusInfo } from '../core/client.ts';
import { spawnTransport } from '../core/transport.ts';
import type { CallResult, ControlState } from '../core/types.ts';
import { isEmptyState } from '../core/model.ts';
import { sanitizeLine } from '../core/sanitize.ts';
import { readSettings } from './config.ts';

export type ViewConnection = ConnectionStatus | 'restricted' | 'no-folder';

export interface ControllerSnapshot {
  connection: ViewConnection;
  status: StatusInfo | null;
  state: ControlState | null;
  root: string | null;
}

const RESTART_SETTINGS = [
  'binaryPath',
  'nodePath',
  'root',
  'requestTimeoutSeconds',
  'actionTimeoutSeconds',
  'reconnect',
] as const;

const STRIPPED_ENV = /^(ELECTRON_RUN_AS_NODE|VSCODE_.*|ELECTRON_.*)$/;

export class Controller implements vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.emitter.event;
  private readonly noticeEmitter = new vscode.EventEmitter<{ type: string; message: string }>();
  readonly onNotice = this.noticeEmitter.event;
  private readonly stateEmitter = new vscode.EventEmitter<ControlState>();
  readonly onState = this.stateEmitter.event;

  private client: ControlClient | null = null;
  private clientSubscriptions: Array<{ dispose(): void }> = [];
  private disposables: vscode.Disposable[] = [];
  private initWatcher: vscode.Disposable | null = null;
  private currentRoot: string | null = null;
  private lastConnection: ViewConnection | null = null;
  /** Nombre de process lancés (observabilité : tests Workspace Trust). */
  launches = 0;

  constructor(
    private readonly log: vscode.LogOutputChannel,
    private readonly clientVersion: string,
  ) {
    this.disposables.push(
      vscode.workspace.onDidGrantWorkspaceTrust(() => void this.restart('workspace trust granted')),
      vscode.workspace.onDidChangeWorkspaceFolders(() => void this.restart('workspace folders changed')),
      vscode.workspace.onDidChangeConfiguration((e) => {
        // Les notifications se relisent à la volée : seuls ces réglages exigent une nouvelle connexion.
        const affects = RESTART_SETTINGS.some((key) => e.affectsConfiguration(`striart.${key}`));
        if (affects) void this.restart('settings changed');
      }),
    );
  }

  get snapshot(): ControllerSnapshot {
    return {
      connection: this.connection,
      status: this.client?.status ?? null,
      state: this.client?.state ?? null,
      root: this.currentRoot,
    };
  }

  get connection(): ViewConnection {
    if (!isTrusted()) return 'restricted';
    if (this.resolveRoot() === null) return 'no-folder';
    return this.client?.status.status ?? 'idle';
  }

  get state(): ControlState | null {
    return this.client?.state ?? null;
  }

  get root(): string | null {
    return this.currentRoot;
  }

  get isConnected(): boolean {
    return this.client?.status.status === 'connected';
  }

  /** Premier dossier de l'espace de travail, ou le réglage `striart.root` (absolu ou relatif au dossier). */
  private resolveRoot(): string | null {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder || folder.uri.scheme !== 'file') return null;
    const configured = readSettings().root.trim();
    if (configured === '') return folder.uri.fsPath;
    return path.isAbsolute(configured) ? configured : path.resolve(folder.uri.fsPath, configured);
  }

  async start(): Promise<void> {
    await this.restart('startup');
  }

  /** Les redémarrages sont sérialisés : jamais deux clients qui se construisent en même temps. */
  restart(reason: string): Promise<void> {
    const next = this.pendingRestart.then(() => this.doRestart(reason));
    this.pendingRestart = next.catch(() => undefined);
    return next;
  }

  private pendingRestart: Promise<void> = Promise.resolve();

  private async doRestart(reason: string): Promise<void> {
    await this.teardownClient();
    const settings = readSettings();
    for (const key of settings.ignoredWorkspaceOverrides) {
      this.log.warn(
        `Ignored ${key} set by the workspace: security-sensitive settings are read from user settings only.`,
      );
    }
    this.currentRoot = this.resolveRoot();
    if (!isTrusted()) {
      this.log.info('Workspace is not trusted: Striart is inactive (no process is started).');
      this.publish();
      return;
    }
    if (this.currentRoot === null) {
      this.log.info('No local workspace folder: Striart is inactive.');
      this.publish();
      return;
    }
    this.log.info(`Starting Striart connection (${reason}) in ${sanitizeLine(this.currentRoot, 300)}.`);
    this.createClient(settings, this.currentRoot);
    this.client?.start();
    this.publish();
  }

  private createClient(settings: ReturnType<typeof readSettings>, root: string): void {
    const client = new ControlClient({
      clientName: 'striart-vscode',
      clientVersion: this.clientVersion,
      requestTimeoutMs: settings.requestTimeoutMs,
      actionTimeoutMs: settings.actionTimeoutMs,
      reconnect: settings.reconnect,
      requiredMethods: ['state.subscribe', 'state.get'],
      connect: async () => {
        // Réglages relus à CHAQUE tentative : un binaire installé entre-temps est trouvé.
        const fresh = readSettings();
        const untrustedDirs = (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);
        const launch = await resolveStriartLaunch(fresh.binaryPath, fresh.nodePath, { untrustedDirs });
        this.log.info(`Launching: ${launch.display} api --stdio (cwd ${sanitizeLine(root, 300)})`);
        this.launches += 1;
        return spawnTransport({
          file: launch.file,
          args: [...launch.prefixArgs, 'api', '--stdio', '--framing', 'ndjson'],
          cwd: root,
          env: childEnv(),
          onStderrLine: (line) => this.log.warn(`striart: ${sanitizeLine(line, 500)}`),
        });
      },
    });
    this.client = client;
    const subscriptions: Array<{ dispose(): void }> = [];
    const onStatus = (s: StatusInfo) => {
      this.log.debug(`Connection status: ${s.status}${s.code ? ` (${s.code})` : ''}`);
      this.refreshInitWatcher(s.status);
      this.publish();
    };
    const onState = (state: ControlState) => {
      this.stateEmitter.fire(state);
      this.publish();
    };
    const onNotice = (n: { type: string; message: string }) => {
      this.log.info(`[notice] ${n.type}: ${sanitizeLine(n.message, 500)}`);
      this.noticeEmitter.fire({ type: n.type, message: sanitizeLine(n.message, 500) });
    };
    const onLog = (level: 'debug' | 'info' | 'warn' | 'error', message: string) => {
      this.log[level](message);
    };
    client.on('status', onStatus);
    client.on('state', onState);
    client.on('notice', onNotice);
    client.on('log', onLog);
    subscriptions.push(
      { dispose: () => void client.off('status', onStatus) },
      { dispose: () => void client.off('state', onState) },
      { dispose: () => void client.off('notice', onNotice) },
      { dispose: () => void client.off('log', onLog) },
    );
    this.clientSubscriptions = subscriptions;
  }

  /** Dépôt non initialisé : on attend sa création (événement du système de fichiers, pas de polling). */
  private refreshInitWatcher(status: ConnectionStatus): void {
    if (status === 'not-initialized' && !this.initWatcher && this.currentRoot) {
      const watcher = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(this.currentRoot, '.striart/agents.json'),
      );
      const trigger = () => this.client?.reconnect();
      this.initWatcher = vscode.Disposable.from(watcher, watcher.onDidCreate(trigger), watcher.onDidChange(trigger));
    } else if (status !== 'not-initialized' && this.initWatcher) {
      this.initWatcher.dispose();
      this.initWatcher = null;
    }
  }

  /** Test uniquement : tue le sous-process pour provoquer une reprise. */
  dropConnectionForTest(): void {
    this.client?.dropTransportForTest();
  }

  reconnect(): void {
    if (!isTrusted()) return;
    if (!this.client) {
      void this.restart('manual reconnect');
      return;
    }
    this.client.reconnect();
  }

  /** Appel de méthode ; lève RpcError / ConnectionLostError / RequestTimeoutError. */
  call<T = unknown>(
    method: string,
    params: Record<string, unknown> = {},
    kind: 'query' | 'action' = 'query',
  ): Promise<CallResult<T>> {
    if (!this.client) return Promise.reject(new Error('Striart is not connected.'));
    return this.client.call<T>(method, params, kind);
  }

  private publish(): void {
    const connection = this.connection;
    const state = this.state;
    void vscode.commands.executeCommand('setContext', 'striart.connection', connection);
    void vscode.commands.executeCommand('setContext', 'striart.empty', state !== null && isEmptyState(state));
    this.lastConnection = connection;
    this.emitter.fire();
  }

  get previousConnection(): ViewConnection | null {
    return this.lastConnection;
  }

  private async teardownClient(): Promise<void> {
    this.initWatcher?.dispose();
    this.initWatcher = null;
    for (const s of this.clientSubscriptions) s.dispose();
    this.clientSubscriptions = [];
    const client = this.client;
    this.client = null;
    await client?.stop();
  }

  async dispose(): Promise<void> {
    await this.teardownClient();
    for (const d of this.disposables) d.dispose();
    this.emitter.dispose();
    this.noticeEmitter.dispose();
    this.stateEmitter.dispose();
  }
}

/** Environnement de l'enfant : celui de l'hôte d'extension, moins les variables internes de VS Code. */
export function childEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!STRIPPED_ENV.test(key)) env[key] = value;
  }
  env.STRIART_LANG = vscode.env.language.toLowerCase().startsWith('fr') ? 'fr' : 'en';
  return env;
}

/**
 * Confiance de l'espace de travail. `STRIART_FORCE_UNTRUSTED=1` ne peut que
 * RESTREINDRE (fail closed) : les tests de bout en bout s'en servent, car
 * VS Code considère l'espace approuvé en mode test d'extension.
 */
function isTrusted(): boolean {
  return vscode.workspace.isTrusted && process.env.STRIART_FORCE_UNTRUSTED !== '1';
}

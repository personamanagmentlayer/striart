/**
 * Client du Striart Control Protocol v1 (JSON-RPC 2.0, ndjson, stdio).
 *
 * Aucune logique métier : le client connecte, négocie, s'abonne à l'état,
 * relaie les notifications validées et transporte les appels. Il est
 * indépendant de VS Code (testable avec un faux serveur).
 *
 * Fiabilité :
 *  - toute ligne reçue est validée (validate.ts) ; un message invalide est
 *    journalisé et compté, jamais interprété à moitié ;
 *  - perte de connexion → reprise avec backoff exponentiel à gigue, bornée
 *    en nombre de tentatives (pas de boucle infinie de lancements) ;
 *  - échecs TERMINAUX (dépôt non initialisé, session d'agent, binaire absent)
 *    → état explicite, aucune reprise automatique ;
 *  - requêtes : délai local, échec explicite à la coupure ; un délai local ne
 *    prétend jamais que l'opération n'a pas eu lieu.
 *
 * Aucun polling : l'état arrive par `state.changed`.
 */
import { EventEmitter } from 'node:events';
import { backoffDelayMs } from './backoff.ts';
import { BinaryError, ConnectionLostError, ProtocolError, RequestTimeoutError } from './errors.ts';
import { NdjsonDecoder, encodeMessage } from './ndjson.ts';
import type { Transport, TransportClose } from './transport.ts';
import {
  PROTOCOL_VERSION,
  type CallResult,
  type ControlState,
  type InitializeData,
  type NoticeParams,
} from './types.ts';
import {
  parseMessage,
  toRpcError,
  validateInitialize,
  validateNotice,
  validateResultDocument,
  validateStateChanged,
  validateSubscribe,
} from './validate.ts';

export type ConnectionStatus =
  | 'idle'
  | 'connecting'
  | 'connected'
  /** Coupé, reprise automatique en cours ou épuisée. */
  | 'offline'
  | 'not-initialized'
  | 'binary-missing'
  /** Refus du serveur qui ne se règle pas par une reprise (session d'agent, version). */
  | 'blocked'
  | 'stopped';

export interface StatusInfo {
  status: ConnectionStatus;
  /** Cause lisible (anglais technique ; l'UI localise le contexte). */
  detail: string | null;
  code: string | null;
  attempt: number;
  maxAttempts: number;
  nextRetryAt: number | null;
  serverVersion: string | null;
}

export interface ClientOptions {
  /** Crée un transport NEUF par tentative ; peut lever `BinaryError`. */
  connect(): Promise<Transport> | Transport;
  clientName: string;
  clientVersion: string;
  requestTimeoutMs: number;
  actionTimeoutMs: number;
  reconnect: { initialMs: number; maxMs: number; maxAttempts: number };
  /** Méthodes indispensables : absentes du serveur → incompatibilité explicite. */
  requiredMethods?: readonly string[];
  random?: () => number;
  timers?: {
    setTimeout(fn: () => void, ms: number): unknown;
    clearTimeout(handle: unknown): void;
    now(): number;
  };
}

interface Pending {
  method: string;
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: unknown;
}

export interface ClientEvents {
  status: [StatusInfo];
  state: [ControlState];
  notice: [NoticeParams];
  log: ['debug' | 'info' | 'warn' | 'error', string];
}

const TERMINAL_CODES: ReadonlyArray<[RegExp, ConnectionStatus, string]> = [
  [/\(NOT_INITIALIZED\)/, 'not-initialized', 'NOT_INITIALIZED'],
  [/\(CONTROL_NESTED_SESSION\)/, 'blocked', 'CONTROL_NESTED_SESSION'],
  [/\(CONTROL_VERSION_UNSUPPORTED\)/, 'blocked', 'CONTROL_VERSION_UNSUPPORTED'],
  [/\(MISSING_OPTION\)|\(UNKNOWN_OPTION\)|\(INVALID_ARGUMENT\)/, 'blocked', 'CLI_INCOMPATIBLE'],
];

const DEFAULT_TIMERS = {
  setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
  clearTimeout: (h: unknown) => clearTimeout(h as NodeJS.Timeout),
  now: () => Date.now(),
};

/** Nombre d'identifiants de requêtes expirées gardés pour reconnaître une réponse tardive. */
const LATE_IDS_KEEP = 128;

export class ControlClient extends EventEmitter<ClientEvents> {
  private readonly options: ClientOptions;
  private readonly timers: NonNullable<ClientOptions['timers']>;
  private transport: Transport | null = null;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private lateIds: number[] = [];
  private attempt = 0;
  private retryTimer: unknown = null;
  private stopped = true;
  private ready = false;
  private subscriptionId: string | null = null;
  private lastInstance: string | null = null;
  private lastRevision = 0;
  private _status: StatusInfo;
  private _state: ControlState | null = null;
  private generation = 0;
  /** Messages reçus mais rejetés (observabilité / tests). */
  invalidMessages = 0;

  constructor(options: ClientOptions) {
    super();
    this.options = options;
    this.timers = options.timers ?? DEFAULT_TIMERS;
    this._status = this.makeStatus('idle');
  }

  get status(): StatusInfo {
    return this._status;
  }

  get state(): ControlState | null {
    return this._state;
  }

  /** Démarre la connexion (idempotent). */
  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.attempt = 0;
    void this.connectOnce();
  }

  /** Reprise manuelle : remet les tentatives à zéro (utilisable depuis tout état non connecté). */
  reconnect(): void {
    if (this.stopped) {
      this.start();
      return;
    }
    if (this._status.status === 'connected' || this._status.status === 'connecting') return;
    this.clearRetry();
    this.attempt = 0;
    void this.connectOnce();
  }

  /** Arrêt définitif : ferme le sous-process, rejette les appels en vol. */
  async stop(): Promise<void> {
    this.stopped = true;
    this.clearRetry();
    this.generation += 1;
    const transport = this.transport;
    this.transport = null;
    this.ready = false;
    this.rejectAll(new ConnectionLostError('The Striart connection was closed.'));
    if (transport) {
      await new Promise<void>((resolve) => {
        let done = false;
        let guard: unknown = null;
        const finish = () => {
          if (done) return;
          done = true;
          if (guard !== null) this.timers.clearTimeout(guard);
          resolve();
        };
        transport.onClose(finish);
        guard = this.timers.setTimeout(finish, 5000);
        transport.close();
      });
    }
    this.setStatus('stopped', null, null);
  }

  /**
   * Appelle une méthode du protocole. `kind: 'action'` utilise le délai long
   * (merge + Test Gate : plusieurs minutes), `'query'` le délai court.
   */
  async call<T = unknown>(
    method: string,
    params: Record<string, unknown> = {},
    kind: 'query' | 'action' = 'query',
  ): Promise<CallResult<T>> {
    if (!this.ready || !this.transport) {
      throw new ConnectionLostError('Striart is not connected.');
    }
    return (await this.rawCall(
      method,
      params,
      kind === 'action' ? this.options.actionTimeoutMs : this.options.requestTimeoutMs,
    )) as CallResult<T>;
  }

  /** Test uniquement : coupe brutalement le sous-process (la reprise automatique s'enclenche). */
  dropTransportForTest(): void {
    this.transport?.kill();
  }

  // ─── Connexion ────────────────────────────────────────────────────────────

  private makeStatus(status: ConnectionStatus, detail: string | null = null, code: string | null = null): StatusInfo {
    return {
      status,
      detail,
      code,
      attempt: this.attempt,
      maxAttempts: this.options.reconnect.maxAttempts,
      nextRetryAt: null,
      serverVersion: this._status?.serverVersion ?? null,
    };
  }

  private setStatus(
    status: ConnectionStatus,
    detail: string | null,
    code: string | null,
    extra: Partial<StatusInfo> = {},
  ): void {
    this._status = { ...this.makeStatus(status, detail, code), ...extra };
    this.emit('status', this._status);
  }

  private log(level: ClientEvents['log'][0], message: string): void {
    this.emit('log', level, message);
  }

  private clearRetry(): void {
    if (this.retryTimer !== null) {
      this.timers.clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
  }

  private async connectOnce(): Promise<void> {
    if (this.stopped) return;
    const generation = ++this.generation;
    this.setStatus('connecting', null, null);
    let transport: Transport;
    try {
      transport = await this.options.connect();
    } catch (error) {
      if (generation !== this.generation) return;
      if (error instanceof BinaryError) {
        this.log('error', `${error.code}: ${error.message}`);
        this.setStatus('binary-missing', error.message, error.code);
        return;
      }
      this.log('error', `Could not start the Striart process: ${(error as Error).message}`);
      this.setStatus('binary-missing', (error as Error).message, 'LAUNCH_FAILED');
      return;
    }
    if (generation !== this.generation || this.stopped) {
      transport.kill();
      return;
    }
    this.transport = transport;
    this.ready = false;
    this.subscriptionId = null;
    // Nouvelle connexion = nouvelle séquence de révisions (l'état périmé reste
    // affiché, marqué hors ligne, jusqu'au premier état frais).
    this.lastInstance = null;
    this.lastRevision = 0;
    const decoder = new NdjsonDecoder({
      onLine: (line) => this.onLine(generation, line),
      onOverflow: (bytes) => {
        this.invalidMessages += 1;
        this.log('error', `Dropped an oversized message (${bytes} bytes, limit 1 MiB). State may be stale.`);
      },
    });
    transport.onData((chunk) => {
      if (generation === this.generation) decoder.push(chunk);
    });
    transport.onClose((info) => this.onClose(generation, info));

    try {
      const init = await this.handshake();
      if (generation !== this.generation) return;
      this.attempt = 0;
      this.ready = true;
      this.acceptState(init.state);
      this.subscriptionId = init.subscriptionId;
      this.setStatus('connected', null, null, { serverVersion: init.serverVersion });
      this.log('info', `Connected to Striart ${init.serverVersion}.`);
    } catch (error) {
      if (generation !== this.generation) return;
      // Le process a pu mourir pendant la négociation : onClose décide alors.
      if (error instanceof ConnectionLostError) return;
      this.log('error', `Handshake failed: ${(error as Error).message}`);
      const incompatible =
        error instanceof ProtocolError || (error as { code?: string }).code === 'CONTROL_VERSION_UNSUPPORTED';
      this.dropTransport();
      if (incompatible) {
        this.setStatus(
          'blocked',
          (error as Error).message,
          (error as { code?: string }).code ?? 'PROTOCOL_INCOMPATIBLE',
        );
        return;
      }
      this.scheduleRetry((error as Error).message);
    }
  }

  private async handshake(): Promise<{ state: ControlState; subscriptionId: string; serverVersion: string }> {
    const initDoc = await this.rawCall(
      'control.initialize',
      {
        protocolVersion: PROTOCOL_VERSION,
        client: { name: this.options.clientName, version: this.options.clientVersion },
      },
      this.options.requestTimeoutMs,
    );
    const init: InitializeData = validateInitialize(initDoc.data);
    const required = this.options.requiredMethods ?? ['state.subscribe'];
    const missing = required.filter((m) => !init.methods.includes(m));
    if (missing.length > 0) {
      throw new ProtocolError(
        'PROTOCOL_INCOMPATIBLE',
        `The Striart server does not offer: ${missing.join(', ')}. Update Striart.`,
      );
    }
    if (!init.notifications.includes('state.changed')) {
      throw new ProtocolError(
        'PROTOCOL_INCOMPATIBLE',
        'The Striart server does not send state.changed notifications. Update Striart.',
      );
    }
    const subDoc = await this.rawCall('state.subscribe', {}, this.options.requestTimeoutMs);
    const sub = validateSubscribe(subDoc.data);
    return { state: sub.state, subscriptionId: sub.subscriptionId, serverVersion: init.serverVersion };
  }

  private dropTransport(): void {
    const transport = this.transport;
    this.transport = null;
    this.ready = false;
    this.generation += 1;
    this.rejectAll(new ConnectionLostError('The Striart connection was lost.'));
    transport?.kill();
  }

  private onClose(generation: number, info: TransportClose): void {
    if (generation !== this.generation) return;
    this.transport = null;
    this.ready = false;
    this.generation += 1;
    this.rejectAll(new ConnectionLostError('The Striart process ended.'));
    if (this.stopped) return;

    if (info.error && (info.error as NodeJS.ErrnoException).code === 'ENOENT') {
      this.setStatus('binary-missing', info.error.message, 'ENOENT');
      return;
    }
    if (info.error && (info.error as NodeJS.ErrnoException).code === 'EACCES') {
      this.setStatus('binary-missing', info.error.message, 'EACCES');
      return;
    }
    for (const [pattern, status, code] of TERMINAL_CODES) {
      if (pattern.test(info.stderr)) {
        this.log('warn', `Striart refused to serve: ${code}.`);
        this.setStatus(status, firstLine(info.stderr), code);
        return;
      }
    }
    const reason = info.error
      ? info.error.message
      : `the process ended (code ${info.code ?? 'none'}${info.signal ? `, signal ${info.signal}` : ''})`;
    this.scheduleRetry(`${reason}${info.stderr ? ` — ${firstLine(info.stderr)}` : ''}`);
  }

  private scheduleRetry(reason: string): void {
    if (this.stopped) return;
    const { maxAttempts, initialMs, maxMs } = this.options.reconnect;
    this.attempt += 1;
    if (this.attempt > maxAttempts) {
      this.log('error', `Giving up automatic reconnection after ${maxAttempts} attempts: ${reason}`);
      this.setStatus('offline', reason, 'RECONNECT_EXHAUSTED', { nextRetryAt: null });
      return;
    }
    const delay = backoffDelayMs(this.attempt, { initialMs, maxMs }, this.options.random);
    const at = this.timers.now() + delay;
    this.log(
      'warn',
      `Disconnected (${reason}). Retry ${this.attempt}/${maxAttempts} in ${(delay / 1000).toFixed(1)} s.`,
    );
    this.setStatus('offline', reason, 'DISCONNECTED', { nextRetryAt: at });
    this.clearRetry();
    this.retryTimer = this.timers.setTimeout(() => {
      this.retryTimer = null;
      void this.connectOnce();
    }, delay);
  }

  // ─── Requêtes et messages entrants ────────────────────────────────────────

  private rawCall(method: string, params: Record<string, unknown>, timeoutMs: number): Promise<CallResult> {
    const transport = this.transport;
    if (!transport) return Promise.reject(new ConnectionLostError('Striart is not connected.'));
    const id = this.nextId++;
    return new Promise<CallResult>((resolve, reject) => {
      const timer = this.timers.setTimeout(() => {
        const entry = this.pending.get(id);
        if (!entry) return;
        this.pending.delete(id);
        this.lateIds.push(id);
        if (this.lateIds.length > LATE_IDS_KEEP) this.lateIds.shift();
        reject(new RequestTimeoutError(method, timeoutMs));
      }, timeoutMs);
      this.pending.set(id, {
        method,
        timer,
        resolve: (value) => resolve(value as CallResult),
        reject,
      });
      try {
        transport.write(encodeMessage({ jsonrpc: '2.0', id, method, params }));
      } catch (error) {
        this.pending.delete(id);
        this.timers.clearTimeout(timer);
        reject(new ConnectionLostError(`Could not write to Striart: ${(error as Error).message}`));
      }
    });
  }

  private rejectAll(error: Error): void {
    const entries = [...this.pending.values()];
    this.pending.clear();
    for (const entry of entries) {
      this.timers.clearTimeout(entry.timer);
      entry.reject(error);
    }
  }

  private onLine(generation: number, line: string): void {
    if (generation !== this.generation) return;
    try {
      const message = parseMessage(line);
      if (message.kind === 'notification') {
        this.onNotification(message.method, message.params);
        return;
      }
      this.onResponse(message);
    } catch (error) {
      this.invalidMessages += 1;
      this.log('error', `Rejected a message from the server: ${(error as Error).message}`);
    }
  }

  private onResponse(message: Extract<ReturnType<typeof parseMessage>, { kind: 'response' }>): void {
    const id = message.id;
    const entry = typeof id === 'number' ? this.pending.get(id) : undefined;
    if (!entry || typeof id !== 'number') {
      if (typeof id === 'number' && this.lateIds.includes(id)) {
        this.log('warn', 'Received the answer to a request that had already timed out; ignored.');
      } else {
        this.invalidMessages += 1;
        this.log('error', 'Received a response that matches no request; ignored.');
      }
      return;
    }
    this.pending.delete(id);
    this.timers.clearTimeout(entry.timer);
    if (message.error) {
      entry.reject(toRpcError(entry.method, message.error));
      return;
    }
    try {
      entry.resolve(validateResultDocument(entry.method, message.result));
    } catch (error) {
      this.invalidMessages += 1;
      entry.reject(error as Error);
    }
  }

  private onNotification(method: string, params: unknown): void {
    if (method === 'state.changed') {
      const changed = validateStateChanged(params);
      if (
        changed.subscriptionId !== null &&
        this.subscriptionId !== null &&
        changed.subscriptionId !== this.subscriptionId
      ) {
        this.log('warn', 'state.changed for an unknown subscription; ignored.');
        return;
      }
      if (changed.droppedNotices > 0)
        this.log('debug', `${changed.droppedNotices} notices were coalesced by the server.`);
      this.acceptState(changed.state);
      return;
    }
    if (method === 'control.notice') {
      this.emit('notice', validateNotice(params));
      return;
    }
    this.log('debug', `Ignored unknown notification ${method.slice(0, 64)}.`);
  }

  /** Garde la révision la plus récente d'une instance ; une nouvelle instance remplace tout. */
  private acceptState(state: ControlState): void {
    if (state.instanceId === this.lastInstance && state.revision <= this.lastRevision) return;
    this.lastInstance = state.instanceId;
    this.lastRevision = state.revision;
    this._state = state;
    this.emit('state', state);
  }
}

function firstLine(text: string): string {
  const line = text.split(/\r?\n/).find((l) => l.trim().length > 0) ?? '';
  return line.trim().slice(0, 300);
}

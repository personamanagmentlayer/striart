/**
 * Faux serveur Striart pour les tests du client : un Transport en mémoire qui
 * parle ndjson. Il répond à `control.initialize` / `state.subscribe`, laisse le
 * test émettre des notifications, couper la connexion, répondre de travers.
 */
import type { Transport, TransportClose } from '../../src/core/transport.ts';

export function makeState(revision: number, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    instanceId: 'inst-1',
    revision,
    generatedAt: '2026-10-26T10:00:00.000Z',
    agents: [],
    tasks: [],
    tickets: [],
    heatmap: [],
    history: [],
    state: { semanticFailureStreak: 0, manualMode: false },
    daemon: { running: false, stale: false, pid: null, logPath: 'x', startedAt: null, url: null },
    permissions: [],
    elicitations: [],
    mainSession: null,
    orchestration: { runs: [], groups: [] },
    reviews: [],
    profiles: [],
    config: { testCommand: 'npm test', targetBranch: 'main', semanticMerge: true, autoRebase: true, autoPush: false },
    ...extra,
  };
}

export function doc(command: string, data: unknown, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { schemaVersion: 1, command, ok: true, outcome: 'ok', data, ...extra };
}

export class ServerError extends Error {
  readonly serverCode: string;
  constructor(code: string, message = code) {
    super(message);
    this.serverCode = code;
  }
}

export class FakeServer implements Transport {
  readonly received: Array<Record<string, unknown>> = [];
  closed = false;
  killed = false;
  private dataListener: ((chunk: Buffer) => void) | null = null;
  private closeListeners: Array<(info: TransportClose) => void> = [];
  /** Réponse automatique à une méthode ; renvoie undefined pour ne pas répondre. */
  handlers = new Map<string, (params: Record<string, unknown>, id: unknown) => unknown>();
  state = makeState(1);

  constructor() {
    this.handlers.set('control.initialize', () =>
      doc('control.initialize', {
        protocolVersion: 1,
        schemaVersion: 1,
        server: { name: 'striart', version: '9.9.9' },
        transport: 'stdio',
        locale: 'en',
        methods: ['control.initialize', 'state.get', 'state.subscribe', 'agent.merge', 'agent.sync'],
        notifications: ['state.changed', 'control.notice'],
      }),
    );
    this.handlers.set('state.subscribe', () =>
      doc('state.subscribe', { subscriptionId: 'sub-1', seq: 1, state: this.state }),
    );
  }

  // ─── Transport ──
  write(data: string): void {
    for (const line of data.split('\n').filter(Boolean)) {
      const message = JSON.parse(line) as Record<string, unknown>;
      this.received.push(message);
      const handler = this.handlers.get(String(message.method));
      if (!handler) continue;
      const result = handler((message.params ?? {}) as Record<string, unknown>, message.id);
      if (result === undefined) continue;
      if (result instanceof Error) {
        this.send({
          jsonrpc: '2.0',
          id: message.id,
          error: {
            code: -32000,
            message: result.message,
            data: {
              schemaVersion: 1,
              command: message.method,
              ok: false,
              error: {
                code: result instanceof ServerError ? result.serverCode : 'UNEXPECTED',
                kind: 'failure',
                message: result.message,
                hint: 'striart status',
                details: {},
              },
            },
          },
        });
      } else {
        this.send({ jsonrpc: '2.0', id: message.id, result });
      }
    }
  }
  onData(callback: (chunk: Buffer) => void): void {
    this.dataListener = callback;
  }
  onClose(callback: (info: TransportClose) => void): void {
    this.closeListeners.push(callback);
  }
  close(): void {
    this.end({ code: 0, signal: null, stderr: '', error: null });
  }
  kill(): void {
    this.killed = true;
    this.end({ code: null, signal: 'SIGTERM', stderr: '', error: null });
  }

  // ─── Pilotage par le test ──
  send(message: unknown): void {
    this.sendRaw(`${JSON.stringify(message)}\n`);
  }
  sendRaw(text: string | Buffer): void {
    this.dataListener?.(Buffer.isBuffer(text) ? text : Buffer.from(text));
  }
  notify(method: string, params: unknown): void {
    this.send({ jsonrpc: '2.0', method, params });
  }
  end(info: TransportClose): void {
    if (this.closed) return;
    this.closed = true;
    for (const listener of this.closeListeners) listener(info);
  }
}

/** Minuteur manuel : les tests avancent le temps sans attendre. */
export class ManualTimers {
  now_ = 1_000_000;
  private next = 1;
  private tasks = new Map<number, { at: number; fn: () => void }>();

  setTimeout = (fn: () => void, ms: number): unknown => {
    const id = this.next++;
    this.tasks.set(id, { at: this.now_ + ms, fn });
    return id;
  };
  clearTimeout = (handle: unknown): void => {
    this.tasks.delete(handle as number);
  };
  now = (): number => this.now_;

  /** Délais en attente (ms restantes), triés. */
  pendingDelays(): number[] {
    return [...this.tasks.values()].map((t) => t.at - this.now_).sort((a, b) => a - b);
  }

  advance(ms: number): void {
    const target = this.now_ + ms;
    for (;;) {
      const due = [...this.tasks.entries()].filter(([, t]) => t.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      this.tasks.delete(due[0]);
      this.now_ = Math.max(this.now_, due[1].at);
      due[1].fn();
    }
    this.now_ = target;
  }
}

/** Laisse les promesses en attente se résoudre. */
export const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

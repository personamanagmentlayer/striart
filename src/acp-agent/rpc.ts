/**
 * Pair JSON-RPC 2.0 du proxy ACP `striart acp` côté AGENT (lot I10) : ndjson
 * sur stdin/stdout, comme tout agent ACP v1 en transport stdio. L'IDE est le
 * client ; il envoie `initialize`, `session/*` ; Striart lui renvoie des
 * notifications `session/update` et, pour l'arbitrage humain, des requêtes
 * `session/request_permission` / `elicitation/create`.
 *
 * Frontière de sécurité STRUCTURELLE : les seules requêtes que Striart peut
 * adresser à l'IDE sont celles de `OUTGOING_REQUESTS`. Les capacités `fs/*`
 * et `terminal/*` du client ne sont JAMAIS appelées — elles opéreraient sur
 * le worktree principal de l'IDE, alors que l'agent amont travaille dans son
 * clone (servi par le client ACP de Striart, borné au clone). Une tentative,
 * même par erreur de programmation, lève avant le moindre octet écrit.
 *
 * Lecture bornée PENDANT la lecture (boundedLines) : un message trop gros
 * est écarté et signalé à l'IDE (`-32600`), jamais accumulé.
 */
import { boundedLines } from '../line-reader.ts';
import { logger } from '../logger.ts';

export const RPC = Object.freeze({
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
  AUTH_REQUIRED: -32000,
  RESOURCE_NOT_FOUND: -32002,
});

/** Requêtes que Striart peut adresser au client IDE — et AUCUNE autre. */
export const OUTGOING_REQUESTS: ReadonlySet<string> = new Set([
  'session/request_permission',
  'elicitation/create',
]);
/** Notifications que Striart peut adresser au client IDE. */
export const OUTGOING_NOTIFICATIONS: ReadonlySet<string> = new Set(['session/update']);

/** Borne d'un message entrant (prompt avec contexte embarqué compris). */
export const MAX_INCOMING_BYTES = 8 * 1024 * 1024;

/** Erreur rendue à l'IDE : code JSON-RPC + code Striart stable dans `data`. */
export class AcpAgentRpcError extends Error {
  readonly rpcCode: number;
  readonly data: Record<string, unknown> | undefined;
  constructor(rpcCode: number, message: string, data?: Record<string, unknown>) {
    super(message);
    this.rpcCode = rpcCode;
    this.data = data;
  }
}

type Id = number | string;
type Handler = (method: string, params: Record<string, unknown>) => Promise<unknown>;
type NotificationHandler = (method: string, params: Record<string, unknown>) => void;

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

export interface RpcPeerOptions {
  input: NodeJS.ReadableStream;
  output: NodeJS.WritableStream;
  onRequest: Handler;
  onNotification: NotificationHandler;
  /** Traduit une erreur inattendue en erreur JSON-RPC (message sans détail sensible). */
  mapError: (error: unknown) => AcpAgentRpcError;
}

export class RpcPeer {
  private readonly options: RpcPeerOptions;
  private readonly pending = new Map<
    Id,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >();
  private nextId = 1;
  private closed = false;
  private readonly inFlight = new Set<Promise<void>>();

  constructor(options: RpcPeerOptions) {
    this.options = options;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  /** Lit jusqu'à la fin de stdin ; rend la main quand les requêtes en vol sont servies. */
  async serve(): Promise<void> {
    const overflows: number[] = [];
    try {
      for await (const line of boundedLines(this.options.input, {
        maxLineBytes: MAX_INCOMING_BYTES,
        encoding: 'utf8',
        onOverflow: (bytes) => overflows.push(bytes),
      })) {
        while (overflows.length > 0) this.reportOverflow(overflows.shift()!);
        if (line.trim().length === 0) continue;
        this.onLine(line);
      }
      while (overflows.length > 0) this.reportOverflow(overflows.shift()!);
    } finally {
      this.closed = true;
      for (const [, entry] of this.pending) entry.reject(new Error('The ACP client disconnected.'));
      this.pending.clear();
    }
    await Promise.allSettled([...this.inFlight]);
  }

  private reportOverflow(bytes: number): void {
    this.write({
      id: null,
      error: {
        code: RPC.INVALID_REQUEST,
        message: `Message of ${bytes} bytes exceeds the ${MAX_INCOMING_BYTES}-byte limit: dropped.`,
      },
    });
  }

  private write(message: Record<string, unknown>): void {
    if (this.closed && !('id' in message)) return;
    try {
      this.options.output.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
    } catch (error) {
      logger.warn({ err: error }, 'Écriture vers le client ACP impossible');
    }
  }

  private onLine(line: string): void {
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      this.write({ id: null, error: { code: RPC.PARSE_ERROR, message: 'Parse error' } });
      return;
    }
    if (!isPlainObject(message)) {
      this.write({
        id: null,
        error: { code: RPC.INVALID_REQUEST, message: 'A JSON-RPC message must be an object.' },
      });
      return;
    }
    const id = message.id as Id | null | undefined;
    const hasId = typeof id === 'number' || typeof id === 'string';
    if (hasId && message.method === undefined && ('result' in message || 'error' in message)) {
      const entry = this.pending.get(id);
      if (!entry) return;
      this.pending.delete(id);
      if (isPlainObject(message.error)) {
        const e = message.error;
        entry.reject(
          new AcpAgentRpcError(Number(e.code) || RPC.INTERNAL_ERROR, String(e.message ?? 'error')),
        );
      } else entry.resolve(message.result);
      return;
    }
    if (typeof message.method !== 'string') {
      if (hasId)
        this.write({ id, error: { code: RPC.INVALID_REQUEST, message: 'Missing method.' } });
      return;
    }
    const params = isPlainObject(message.params) ? message.params : {};
    if (!hasId) {
      try {
        this.options.onNotification(message.method, params);
      } catch (error) {
        logger.warn({ err: error, method: message.method }, 'Notification ACP en échec');
      }
      return;
    }
    const task = this.handle(id, message.method, params);
    this.inFlight.add(task);
    void task.finally(() => this.inFlight.delete(task));
  }

  private async handle(id: Id, method: string, params: Record<string, unknown>): Promise<void> {
    try {
      const result = await this.options.onRequest(method, params);
      this.write({ id, result: result ?? null });
    } catch (error) {
      const rpc = error instanceof AcpAgentRpcError ? error : this.options.mapError(error);
      this.write({
        id,
        error: { code: rpc.rpcCode, message: rpc.message, ...(rpc.data ? { data: rpc.data } : {}) },
      });
    }
  }

  /** Requête vers l'IDE — UNIQUEMENT parmi OUTGOING_REQUESTS (jamais fs/*, terminal/*). */
  request(method: string, params: Record<string, unknown>): Promise<unknown> {
    if (!OUTGOING_REQUESTS.has(method)) {
      return Promise.reject(
        new Error(
          `Refused to send "${method}" to the ACP client: only human arbitration requests are allowed.`,
        ),
      );
    }
    if (this.closed) return Promise.reject(new Error('The ACP client disconnected.'));
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      this.pending.set(id, { resolve, reject });
      this.write({ id, method, params });
    });
  }

  notify(method: string, params: Record<string, unknown>): void {
    if (!OUTGOING_NOTIFICATIONS.has(method)) {
      throw new Error(`Refused to send notification "${method}" to the ACP client.`);
    }
    this.write({ method, params });
  }
}

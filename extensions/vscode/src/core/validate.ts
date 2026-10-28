/**
 * Validation positive de CHAQUE message reçu du serveur, avant toute
 * utilisation. Ce que le serveur envoie n'est pas supposé correct : une forme
 * inattendue est une `ProtocolError` (échec explicite, jamais un repli
 * silencieux ni un `undefined` qui se propage jusqu'à l'interface).
 *
 * Pas de dépendance : le sous-ensemble consommé est petit et fermé ; les
 * champs inconnus sont tolérés (compatibilité ascendante), les champs lus sont
 * typés, bornés et énumérés.
 */
import { ProtocolError, RpcError } from './errors.ts';
import {
  PROTOCOL_VERSION,
  SCHEMA_VERSION,
  type AgentInfo,
  type CallResult,
  type ControlState,
  type DocumentWarning,
  type ElicitationRequest,
  type InitializeData,
  type MainSession,
  type NoticeParams,
  type Outcome,
  type PermissionOption,
  type PermissionRequest,
  type QueueRow,
  type ReviewInfo,
  type StateChangedParams,
  type SubscribeData,
  type TicketInfo,
} from './types.ts';

type Obj = Record<string, unknown>;

export const LIMITS = {
  agents: 2_000,
  tasks: 5_000,
  tickets: 5_000,
  requests: 1_000,
  options: 64,
  files: 10_000,
  methods: 200,
  profiles: 500,
  shortString: 2_048,
  longString: 200_000,
} as const;

const AGENT_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const TICKET_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,80}$/;
const PERMISSION_ID_RE = /^perm-[0-9a-f-]{8,36}$/;

const ELICITATION_ID_RE = /^elic-[0-9a-f-]{8,36}$/;
const REVIEW_ID_RE = /^rev-[0-9a-f]{12}$/;

function fail(path: string, expected: string): never {
  throw new ProtocolError('PROTOCOL_INVALID_MESSAGE', `Unexpected message shape: ${path} should be ${expected}.`);
}

function isObj(value: unknown): value is Obj {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function obj(value: unknown, path: string): Obj {
  if (!isObj(value)) fail(path, 'an object');
  return value;
}

function str(o: Obj, key: string, path: string, max: number = LIMITS.longString): string {
  const v = o[key];
  if (typeof v !== 'string') fail(`${path}.${key}`, 'a string');
  if (v.length > max) fail(`${path}.${key}`, `at most ${max} characters`);
  return v;
}

function optStr(o: Obj, key: string, path: string, max: number = LIMITS.longString): string | null {
  const v = o[key];
  if (v === undefined || v === null) return null;
  if (typeof v !== 'string') fail(`${path}.${key}`, 'a string or null');
  if (v.length > max) fail(`${path}.${key}`, `at most ${max} characters`);
  return v;
}

function patterned(o: Obj, key: string, path: string, re: RegExp): string {
  const v = str(o, key, path, 256);
  if (!re.test(v)) fail(`${path}.${key}`, `a valid identifier (${re.source})`);
  return v;
}

function int(o: Obj, key: string, path: string, min = 0): number {
  const v = o[key];
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < min) fail(`${path}.${key}`, `an integer >= ${min}`);
  return v;
}

function optInt(o: Obj, key: string, path: string): number | null {
  const v = o[key];
  if (v === undefined || v === null) return null;
  if (typeof v !== 'number' || !Number.isSafeInteger(v)) fail(`${path}.${key}`, 'an integer or null');
  return v;
}

function bool(o: Obj, key: string, path: string): boolean {
  const v = o[key];
  if (typeof v !== 'boolean') fail(`${path}.${key}`, 'a boolean');
  return v;
}

function oneOf<T extends string>(o: Obj, key: string, path: string, allowed: readonly T[]): T {
  const v = o[key];
  if (typeof v !== 'string' || !(allowed as readonly string[]).includes(v)) {
    fail(`${path}.${key}`, `one of ${allowed.join(', ')}`);
  }
  return v as T;
}

function arr(o: Obj, key: string, path: string, max: number): unknown[] {
  const v = o[key];
  if (!Array.isArray(v)) fail(`${path}.${key}`, 'an array');
  if (v.length > max) fail(`${path}.${key}`, `at most ${max} entries`);
  return v;
}

function strArr(o: Obj, key: string, path: string, max: number = LIMITS.files): string[] {
  return arr(o, key, path, max).map((item, i) => {
    if (typeof item !== 'string' || item.length > LIMITS.shortString) fail(`${path}.${key}[${i}]`, 'a string');
    return item;
  });
}

// ─── Entités de l'état ───────────────────────────────────────────────────────

function agent(value: unknown, path: string): AgentInfo {
  const o = obj(value, path);
  let session: AgentInfo['session'] = null;
  if (o.session !== undefined && o.session !== null) {
    const s = obj(o.session, `${path}.session`);
    session = {
      state: oneOf(s, 'state', `${path}.session`, ['running', 'recent-activity', 'idle']),
      via: optStr(s, 'via', `${path}.session`, 64),
      pid: optInt(s, 'pid', `${path}.session`),
    };
  }
  return {
    name: patterned(o, 'name', path, AGENT_NAME_RE),
    status: oneOf(o, 'status', path, ['ACTIVE', 'MISSING', 'BROKEN', 'REMOVING']),
    pendingCommits: int(o, 'pendingCommits', path),
    mode: o.mode === undefined ? 'attended' : oneOf(o, 'mode', path, ['attended', 'autonomous']),
    profile: optStr(o, 'profile', path, 128),
    branch: optStr(o, 'branch', path, LIMITS.shortString),
    command: optStr(o, 'command', path, LIMITS.shortString),
    lastMessage: optStr(o, 'lastMessage', path, LIMITS.shortString),
    session,
  };
}

function ticket(value: unknown, path: string): TicketInfo {
  const o = obj(value, path);
  const corrupt = o.status === 'CORRUPT';
  return {
    id: patterned(o, 'id', path, TICKET_ID_RE),
    agent: optStr(o, 'agent', path, 64),
    reason: optStr(o, 'reason', path, 64),
    resolved: bool(o, 'resolved', path),
    corrupt,
    dir: str(o, 'dir', path, 4096),
    conflictedFiles: strArr(o, 'conflictedFiles', path),
    createdAt: str(o, 'createdAt', path, 64),
  };
}

function queueRow(value: unknown, path: string): QueueRow {
  const o = obj(value, path);
  return {
    id: str(o, 'id', path, 256),
    agent: str(o, 'agent', path, 64),
    status: oneOf(o, 'status', path, ['RUNNING', 'WAITING']),
    files: strArr(o, 'files', path),
    blockedBy: arr(o, 'blockedBy', path, LIMITS.files).length,
    ready: o.ready === true,
  };
}

function permissionOption(value: unknown, path: string): PermissionOption {
  const o = obj(value, path);
  return {
    optionId: str(o, 'optionId', path, 256),
    name: optStr(o, 'name', path, LIMITS.shortString),
    kind: optStr(o, 'kind', path, 64),
  };
}

function permission(value: unknown, path: string): PermissionRequest {
  const o = obj(value, path);
  return {
    kind: 'permission',
    id: patterned(o, 'id', path, PERMISSION_ID_RE),
    agent: str(o, 'agent', path, 64),
    title: str(o, 'title', path, LIMITS.longString),
    options: arr(o, 'options', path, LIMITS.options).map((item, i) => permissionOption(item, `${path}.options[${i}]`)),
    status: oneOf(o, 'status', path, ['PENDING', 'ANSWERED']),
    expiresAt: str(o, 'expiresAt', path, 64),
  };
}

function elicitation(value: unknown, path: string): ElicitationRequest {
  const o = obj(value, path);
  const schema = o.requestedSchema;
  if (schema !== undefined && schema !== null && !isObj(schema)) fail(`${path}.requestedSchema`, 'an object or null');
  return {
    kind: 'elicitation',
    id: patterned(o, 'id', path, ELICITATION_ID_RE),
    agent: str(o, 'agent', path, 64),
    mode: oneOf(o, 'mode', path, ['form', 'url']),
    message: str(o, 'message', path, LIMITS.longString),
    requestedSchema: (schema as Obj | null | undefined) ?? null,
    url: optStr(o, 'url', path, 8192),
    status: oneOf(o, 'status', path, ['PENDING', 'ANSWERED']),
    expiresAt: str(o, 'expiresAt', path, 64),
  };
}

function review(value: unknown, path: string): ReviewInfo {
  const o = obj(value, path);
  return {
    id: patterned(o, 'id', path, REVIEW_ID_RE),
    agent: str(o, 'agent', path, 64),
    status: oneOf(o, 'status', path, ['PENDING', 'ANSWERED', 'EXPIRED']),
    alive: bool(o, 'alive', path),
  };
}

function mainSession(value: unknown, path: string): MainSession | null {
  if (value === null || value === undefined) return null;
  const o = obj(value, path);
  return {
    pid: optInt(o, 'pid', path),
    reason: str(o, 'reason', path, LIMITS.shortString),
    startedAt: str(o, 'startedAt', path, 64),
    alive: bool(o, 'alive', path),
  };
}

export function validateState(value: unknown, path = 'state'): ControlState {
  const o = obj(value, path);
  const daemon = obj(o.daemon, `${path}.daemon`);
  const flags = obj(o.state, `${path}.state`);
  const config = obj(o.config, `${path}.config`);
  return {
    instanceId: str(o, 'instanceId', path, 256),
    revision: int(o, 'revision', path, 1),
    generatedAt: str(o, 'generatedAt', path, 64),
    agents: arr(o, 'agents', path, LIMITS.agents).map((v, i) => agent(v, `${path}.agents[${i}]`)),
    tasks: arr(o, 'tasks', path, LIMITS.tasks).map((v, i) => queueRow(v, `${path}.tasks[${i}]`)),
    tickets: arr(o, 'tickets', path, LIMITS.tickets).map((v, i) => ticket(v, `${path}.tickets[${i}]`)),
    daemon: {
      running: bool(daemon, 'running', `${path}.daemon`),
      stale: daemon.stale === true,
      pid: optInt(daemon, 'pid', `${path}.daemon`),
    },
    permissions: arr(o, 'permissions', path, LIMITS.requests).map((v, i) => permission(v, `${path}.permissions[${i}]`)),
    elicitations: arr(o, 'elicitations', path, LIMITS.requests).map((v, i) =>
      elicitation(v, `${path}.elicitations[${i}]`),
    ),
    reviews: arr(o, 'reviews', path, LIMITS.requests).map((v, i) => review(v, `${path}.reviews[${i}]`)),
    mainSession: mainSession(o.mainSession, `${path}.mainSession`),
    state: {
      manualMode: bool(flags, 'manualMode', `${path}.state`),
      semanticFailureStreak: int(flags, 'semanticFailureStreak', `${path}.state`),
    },
    profiles: arr(o, 'profiles', path, LIMITS.profiles).map((v, i) => {
      const p = obj(v, `${path}.profiles[${i}]`);
      return { name: str(p, 'name', `${path}.profiles[${i}]`, 128), acp: p.acp === true };
    }),
    config: {
      targetBranch: str(config, 'targetBranch', `${path}.config`, 256),
      testCommand: str(config, 'testCommand', `${path}.config`, LIMITS.shortString),
    },
  };
}

// ─── Messages JSON-RPC ───────────────────────────────────────────────────────

export type Incoming =
  | { kind: 'response'; id: string | number | null; result: unknown; error: null }
  | { kind: 'response'; id: string | number | null; result: undefined; error: RawRpcError }
  | { kind: 'notification'; method: string; params: unknown };

export interface RawRpcError {
  code: number;
  message: string;
  data: unknown;
}

/** Décode une ligne reçue : JSON valide, enveloppe JSON-RPC 2.0 conforme, sinon `ProtocolError`. */
export function parseMessage(text: string): Incoming {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (cause) {
    throw new ProtocolError('PROTOCOL_INVALID_JSON', 'The server sent a line that is not valid JSON.', { cause });
  }
  const o = obj(json, 'message');
  if (o.jsonrpc !== '2.0') fail('message.jsonrpc', '"2.0"');
  const hasMethod = 'method' in o;
  const hasId = 'id' in o;
  if (hasMethod && !hasId) {
    const method = str(o, 'method', 'message', 128);
    return { kind: 'notification', method, params: o.params };
  }
  if (hasId && !hasMethod) {
    const id = o.id;
    if (!(id === null || typeof id === 'string' || (typeof id === 'number' && Number.isSafeInteger(id)))) {
      fail('message.id', 'a string, a safe integer or null');
    }
    const hasResult = 'result' in o;
    const hasError = 'error' in o;
    if (hasResult === hasError) fail('message', 'a response with exactly one of result or error');
    if (hasError) {
      const e = obj(o.error, 'message.error');
      const code = e.code;
      if (typeof code !== 'number' || !Number.isInteger(code)) fail('message.error.code', 'an integer');
      return {
        kind: 'response',
        id,
        result: undefined,
        error: { code, message: str(e, 'message', 'message.error', LIMITS.longString), data: e.data },
      };
    }
    return { kind: 'response', id, result: o.result, error: null };
  }
  throw new ProtocolError(
    'PROTOCOL_INVALID_MESSAGE',
    'The server sent a message that is neither a request answer nor a notification.',
  );
}

/** Document d'erreur (`error.data`) → `RpcError`, ou une erreur générique si le document est absent/invalide. */
export function toRpcError(method: string, raw: RawRpcError): RpcError {
  const doc = isObj(raw.data) ? raw.data : null;
  const e = doc && isObj(doc.error) ? doc.error : null;
  if (
    e &&
    typeof e.code === 'string' &&
    typeof e.message === 'string' &&
    (e.kind === 'usage' || e.kind === 'refusal' || e.kind === 'failure')
  ) {
    return new RpcError({
      method,
      rpcCode: raw.code,
      code: e.code.slice(0, 128),
      kind: e.kind,
      message: e.message.slice(0, LIMITS.shortString),
      hint: typeof e.hint === 'string' ? e.hint.slice(0, LIMITS.shortString) : null,
      details: isObj(e.details) ? e.details : {},
    });
  }
  return new RpcError({
    method,
    rpcCode: raw.code,
    code: 'CONTROL_ERROR',
    kind: 'failure',
    message: raw.message.slice(0, LIMITS.shortString),
    hint: null,
    details: {},
  });
}

/** Résultat d'un appel : enveloppe du document `--json` vérifiée, `data` rendu tel quel. */
export function validateResultDocument(method: string, result: unknown): CallResult {
  const o = obj(result, 'result');
  if (o.schemaVersion !== SCHEMA_VERSION) fail('result.schemaVersion', String(SCHEMA_VERSION));
  if (o.command !== method) fail('result.command', `"${method}"`);
  const ok = bool(o, 'ok', 'result');
  if (!('data' in o)) fail('result.data', 'present');
  const outcome: Outcome = o.outcome === undefined ? 'ok' : oneOf(o, 'outcome', 'result', ['ok', 'refused', 'failed']);
  const warnings: DocumentWarning[] = [];
  if (o.warnings !== undefined) {
    for (const [i, w] of arr(o, 'warnings', 'result', 100).entries()) {
      const wo = obj(w, `result.warnings[${i}]`);
      warnings.push({
        code: str(wo, 'code', `result.warnings[${i}]`, 128),
        message: str(wo, 'message', `result.warnings[${i}]`, LIMITS.shortString),
      });
    }
  }
  return { command: method, ok, outcome, data: o.data, warnings };
}

export function validateInitialize(data: unknown): InitializeData {
  const o = obj(data, 'initialize');
  if (o.protocolVersion !== PROTOCOL_VERSION) fail('initialize.protocolVersion', String(PROTOCOL_VERSION));
  const server = obj(o.server, 'initialize.server');
  if (server.name !== 'striart') fail('initialize.server.name', '"striart"');
  return {
    protocolVersion: PROTOCOL_VERSION,
    schemaVersion: int(o, 'schemaVersion', 'initialize', 1),
    serverVersion: str(server, 'version', 'initialize.server', 64),
    locale: str(o, 'locale', 'initialize', 16),
    methods: strArr(o, 'methods', 'initialize', LIMITS.methods),
    notifications: strArr(o, 'notifications', 'initialize', LIMITS.methods),
  };
}

export function validateSubscribe(data: unknown): SubscribeData {
  const o = obj(data, 'subscribe');
  return {
    subscriptionId: str(o, 'subscriptionId', 'subscribe', 128),
    seq: int(o, 'seq', 'subscribe', 1),
    state: validateState(o.state, 'subscribe.state'),
  };
}

export function validateStateChanged(params: unknown): StateChangedParams {
  const o = obj(params, 'state.changed');
  const sub = o.subscriptionId;
  if (sub !== null && typeof sub !== 'string') fail('state.changed.subscriptionId', 'a string or null');
  return {
    subscriptionId: sub as string | null,
    seq: int(o, 'seq', 'state.changed', 1),
    state: validateState(o.state, 'state.changed.state'),
    droppedNotices: int(o, 'droppedNotices', 'state.changed'),
  };
}

export function validateNotice(params: unknown): NoticeParams {
  const o = obj(params, 'control.notice');
  return {
    seq: int(o, 'seq', 'control.notice', 1),
    type: str(o, 'type', 'control.notice', 256),
    message: str(o, 'message', 'control.notice', LIMITS.shortString),
  };
}

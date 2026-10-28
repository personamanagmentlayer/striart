/**
 * Sous-ensemble du Striart Control Protocol v1 que l'extension consomme.
 * Source de vérité : `schemas/striart-control-v1.openrpc.json` du dépôt Striart.
 * Les champs inconnus sont tolérés (compatibilité ascendante) ; les champs
 * déclarés ici sont validés strictement par validate.ts.
 */

export const PROTOCOL_VERSION = 1;
export const SCHEMA_VERSION = 1;

export type Outcome = 'ok' | 'refused' | 'failed';

export interface AgentSession {
  state: 'running' | 'recent-activity' | 'idle';
  via: string | null;
  pid: number | null;
}

export interface AgentInfo {
  name: string;
  status: 'ACTIVE' | 'MISSING' | 'BROKEN' | 'REMOVING';
  pendingCommits: number;
  mode: 'attended' | 'autonomous';
  profile: string | null;
  branch: string | null;
  command: string | null;
  lastMessage: string | null;
  session: AgentSession | null;
}

export interface TicketInfo {
  id: string;
  agent: string | null;
  reason: string | null;
  resolved: boolean;
  corrupt: boolean;
  dir: string;
  conflictedFiles: string[];
  createdAt: string;
}

export interface QueueRow {
  id: string;
  agent: string;
  status: 'RUNNING' | 'WAITING';
  files: string[];
  blockedBy: number;
  ready: boolean;
}

export interface PermissionOption {
  optionId: string;
  name: string | null;
  kind: string | null;
}

export interface PermissionRequest {
  kind: 'permission';
  id: string;
  agent: string;
  title: string;
  options: PermissionOption[];
  status: 'PENDING' | 'ANSWERED';
  expiresAt: string;
}

export interface ElicitationRequest {
  kind: 'elicitation';
  id: string;
  agent: string;
  mode: 'form' | 'url';
  message: string;
  requestedSchema: Record<string, unknown> | null;
  url: string | null;
  status: 'PENDING' | 'ANSWERED';
  expiresAt: string;
}

export interface ReviewInfo {
  id: string;
  agent: string;
  status: 'PENDING' | 'ANSWERED' | 'EXPIRED';
  alive: boolean;
}

export interface MainSession {
  pid: number | null;
  reason: string;
  startedAt: string;
  alive: boolean;
}

export interface ProfileInfo {
  name: string;
  acp: boolean;
}

export interface ControlState {
  instanceId: string;
  revision: number;
  generatedAt: string;
  agents: AgentInfo[];
  tasks: QueueRow[];
  tickets: TicketInfo[];
  daemon: { running: boolean; stale: boolean; pid: number | null };
  permissions: PermissionRequest[];
  elicitations: ElicitationRequest[];
  reviews: ReviewInfo[];
  mainSession: MainSession | null;
  state: { manualMode: boolean; semanticFailureStreak: number };
  profiles: ProfileInfo[];
  config: { targetBranch: string; testCommand: string };
}

export interface InitializeData {
  protocolVersion: number;
  schemaVersion: number;
  serverVersion: string;
  locale: string;
  methods: string[];
  notifications: string[];
}

export interface SubscribeData {
  subscriptionId: string;
  seq: number;
  state: ControlState;
}

export interface StateChangedParams {
  subscriptionId: string | null;
  seq: number;
  state: ControlState;
  droppedNotices: number;
}

export interface NoticeParams {
  seq: number;
  type: string;
  message: string;
}

export interface DocumentWarning {
  code: string;
  message: string;
}

/** Résultat d'un appel réussi : le document `--json` désenveloppé. */
export interface CallResult<T = unknown> {
  command: string;
  ok: boolean;
  outcome: Outcome;
  data: T;
  warnings: DocumentWarning[];
}

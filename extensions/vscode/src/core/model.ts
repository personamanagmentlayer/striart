/**
 * Modèle de présentation de l'état : regroupement des agents, synthèse pour
 * la barre d'état, détection des nouvelles demandes d'arbitrage. Pur (aucun
 * accès à VS Code) donc testable. Aucune chaîne localisée ici : l'interface
 * associe un libellé à chaque clé.
 *
 * Ce n'est PAS de la logique métier Striart : le regroupement est une
 * présentation de champs que le serveur calcule (`session.state`,
 * `pendingCommits`, `status`).
 */
import type {
  AgentInfo,
  ControlState,
  ElicitationRequest,
  PermissionRequest,
  QueueRow,
  ReviewInfo,
  TicketInfo,
} from './types.ts';

export type AgentGroup = 'attention' | 'running' | 'idle';

/** Raison sémantique du statut d'un agent (la couleur n'est jamais seule : un mot l'accompagne). */
export type AgentStatusKey = 'broken' | 'missing' | 'removing' | 'running' | 'recent-activity' | 'to-merge' | 'idle';

export type Tone = 'error' | 'warn' | 'info' | 'ok' | 'neutral';

export interface AgentClass {
  group: AgentGroup;
  key: AgentStatusKey;
  tone: Tone;
  /** Peut être mergé depuis l'interface (commits en attente, clone sain). */
  mergeable: boolean;
}

export function classifyAgent(agent: AgentInfo): AgentClass {
  switch (agent.status) {
    case 'BROKEN':
      return { group: 'attention', key: 'broken', tone: 'error', mergeable: false };
    case 'MISSING':
      return { group: 'attention', key: 'missing', tone: 'error', mergeable: false };
    case 'REMOVING':
      return { group: 'idle', key: 'removing', tone: 'neutral', mergeable: false };
    case 'ACTIVE':
      break;
  }
  const session = agent.session?.state ?? 'idle';
  if (session === 'running') {
    return { group: 'running', key: 'running', tone: 'info', mergeable: false };
  }
  if (session === 'recent-activity') {
    return { group: 'running', key: 'recent-activity', tone: 'info', mergeable: agent.pendingCommits > 0 };
  }
  if (agent.pendingCommits > 0) {
    return { group: 'attention', key: 'to-merge', tone: 'warn', mergeable: true };
  }
  return { group: 'idle', key: 'idle', tone: 'neutral', mergeable: false };
}

export function openTickets(state: ControlState): TicketInfo[] {
  return state.tickets.filter((t) => !t.resolved);
}

export function pendingPermissions(state: ControlState): PermissionRequest[] {
  return state.permissions.filter((p) => p.status === 'PENDING');
}

export function pendingElicitations(state: ControlState): ElicitationRequest[] {
  return state.elicitations.filter((e) => e.status === 'PENDING');
}

export function pendingReviews(state: ControlState): ReviewInfo[] {
  return state.reviews.filter((r) => r.status === 'PENDING' && r.alive);
}

export type HumanRequest = PermissionRequest | ElicitationRequest;

export function pendingRequests(state: ControlState): HumanRequest[] {
  return [...pendingPermissions(state), ...pendingElicitations(state)];
}

export type WatcherState = 'running' | 'stopped' | 'stale';

export interface Summary {
  agents: number;
  running: number;
  toMerge: number;
  attention: number;
  openTickets: number;
  requests: number;
  reviews: number;
  queued: number;
  watcher: WatcherState;
  manualMode: boolean;
  mainSessionAlive: boolean;
  /** Des commits attendent un merge alors que le watcher ne tourne pas. */
  unwatchedPending: boolean;
}

export function summarize(state: ControlState): Summary {
  let running = 0;
  let toMerge = 0;
  let attention = 0;
  for (const agent of state.agents) {
    const c = classifyAgent(agent);
    if (c.group === 'running') running += 1;
    if (c.group === 'attention') attention += 1;
    if (c.key === 'to-merge') toMerge += 1;
  }
  const watcher: WatcherState = state.daemon.running ? 'running' : state.daemon.stale ? 'stale' : 'stopped';
  const tickets = openTickets(state).length;
  const attendedPending = state.agents.some(
    (a) => a.status === 'ACTIVE' && a.mode === 'attended' && a.pendingCommits > 0,
  );
  return {
    agents: state.agents.filter((a) => a.status !== 'REMOVING').length,
    running,
    toMerge,
    attention,
    openTickets: tickets,
    requests: pendingRequests(state).length,
    reviews: pendingReviews(state).length,
    queued: state.tasks.filter((t) => t.status === 'WAITING').length,
    watcher,
    manualMode: state.state.manualMode,
    mainSessionAlive: state.mainSession?.alive === true,
    unwatchedPending: attendedPending && watcher !== 'running',
  };
}

export function isEmptyState(state: ControlState): boolean {
  return (
    state.agents.length === 0 &&
    state.tasks.length === 0 &&
    openTickets(state).length === 0 &&
    pendingRequests(state).length === 0
  );
}

export function waitingTasks(state: ControlState): QueueRow[] {
  return state.tasks.filter((t) => t.status === 'WAITING');
}

/**
 * Suit les demandes d'arbitrage déjà notifiées : `fresh` rend celles qui
 * n'ont pas encore donné lieu à une notification. Les identifiants disparus
 * de l'état (répondus, expirés) sont oubliés, la mémoire reste bornée.
 */
export class RequestTracker {
  private readonly seen = new Set<string>();

  fresh(state: ControlState): HumanRequest[] {
    const pending = pendingRequests(state);
    const live = new Set(pending.map((r) => r.id));
    for (const id of this.seen) if (!live.has(id)) this.seen.delete(id);
    const fresh = pending.filter((r) => !this.seen.has(r.id));
    for (const r of fresh) this.seen.add(r.id);
    return fresh;
  }

  reset(): void {
    this.seen.clear();
  }
}

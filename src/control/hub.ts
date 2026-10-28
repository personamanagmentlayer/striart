/**
 * Hub d'état du Striart Control Protocol : UNE source d'état pour tous les
 * transports (stdio des extensions IDE, SSE du dashboard).
 *
 * Garanties (constats d'audit 3.3 et 6.2) :
 *  - **une seule collecte en vol** : `getState()` rejoint ou enchaîne, il
 *    ne lance jamais deux `collectControlState` en parallèle — et ne rend
 *    jamais un état dont la collecte a commencé AVANT l'appel (pas d'état
 *    périmé après une action) ;
 *  - **délai maximal** : une rafale de changements est coalescée (fenêtre
 *    `debounceMs`), mais aucun changement n'attend plus de `maxDelayMs`
 *    avant d'être poussé, même sous un flux continu d'écritures ;
 *  - **numéro de séquence** sur chaque envoi (par abonnement, contigu à
 *    partir de 1) et **révision** monotone sur chaque état : un client
 *    ignore un état plus ancien que celui qu'il a rendu ;
 *  - **contre-pression** : un abonné dont plus de `maxBufferedBytes` octets
 *    attendent d'être lus est soit déconnecté explicitement (SSE — le
 *    navigateur se reconnecte et reçoit l'état complet, idempotent), soit
 *    servi en coalescence (stdio — l'état le plus récent part au `drain`,
 *    les notices intermédiaires sont comptées dans `droppedNotices`).
 *
 * Source de vérité inter-process : le DISQUE (`.striart/` via chokidar, refs
 * des agents via watchAgents — jamais les worktrees). Le bus in-process
 * n'apporte que les notices des actions lancées par CE process.
 */
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import chokidar from 'chokidar';
import { isIgnoredStatePath } from '../state-watch-ignore.ts';
import { describeOrchestrationEvent } from './event-notices.ts';
import { onStriartEvent } from '../events.js';
import { logger } from '../logger.js';
import { striartDir } from '../paths.js';
import { watchAgents } from '../watcher.js';
import { collectControlState } from './state.ts';
import type { ControlState, ControlStateBase } from './state.ts';

export const DEFAULT_DEBOUNCE_MS = 300;
export const DEFAULT_MAX_DELAY_MS = 2_000;
export const DEFAULT_MAX_BUFFERED_BYTES = 4 * 1024 * 1024;

export type SlowPolicy = 'disconnect' | 'coalesce';

/** Ce qu'un transport fournit au hub pour un abonné. */
export interface SubscriberTransport {
  policy: SlowPolicy;
  /** Écrit une notification (`state.changed`, `control.notice`). */
  write(method: string, params: Record<string, unknown>): void;
  /** Octets écrits mais pas encore lus par le pair. */
  bufferedBytes(): number;
  /** Politique `disconnect` : coupe la connexion maintenant. */
  disconnect(reason: 'slow' | 'closing'): void;
  /** Politique `coalesce` : rappelle `callback` une fois le tampon vidé. */
  onceDrained(callback: () => void): void;
}

interface Subscription {
  id: string;
  transport: SubscriberTransport;
  seq: number;
  lastRevision: number;
  ready: boolean;
  pendingState: boolean;
  waitingDrain: boolean;
  droppedNotices: number;
}

export interface ControlHubOptions {
  root: string;
  debounceMs?: number;
  maxDelayMs?: number;
  maxBufferedBytes?: number;
  /** Injection pour les tests unitaires (aucun disque). */
  collect?: (root: string) => Promise<ControlStateBase>;
  /** false : pas de watchers disque (tests unitaires). */
  watchDisk?: boolean;
}

export class ControlHub {
  readonly instanceId = randomUUID();
  readonly root: string;
  private readonly debounceMs: number;
  private readonly maxDelayMs: number;
  private readonly maxBufferedBytes: number;
  private readonly collect: (root: string) => Promise<ControlStateBase>;
  private readonly watchDisk: boolean;

  private revision = 0;
  private inflight: Promise<ControlState> | null = null;
  private queued: Promise<ControlState> | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private firstPendingAt: number | null = null;
  private nextSubscription = 1;
  private readonly subscriptions = new Map<string, Subscription>();
  private watchers: Array<{ close(): Promise<void> }> = [];
  private readonly offBus: () => void;
  private closed = false;
  /** Compteurs d'observabilité (exposés par `stats()`). */
  private collections = 0;
  private slowDisconnects = 0;

  constructor(options: ControlHubOptions) {
    this.root = options.root;
    this.debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
    this.maxDelayMs = options.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
    this.maxBufferedBytes = options.maxBufferedBytes ?? DEFAULT_MAX_BUFFERED_BYTES;
    this.collect = options.collect ?? collectControlState;
    this.watchDisk = options.watchDisk ?? true;
    // Bus in-process : notices typées des actions lancées par ce process.
    this.offBus = onStriartEvent((_config, event) => {
      // Mesure du verrou (L8) : aucun état n'a changé — ni notice, ni recollecte.
      if (event.type === 'lock:contention') return;
      // Événements d'orchestration sans `message` : texte construit depuis
      // leurs seuls identifiants (event-notices.ts), jamais depuis un contenu.
      const text = event.message ?? describeOrchestrationEvent(event);
      if (text) this.notice(event.type, text);
      this.changed();
    });
  }

  /**
   * État frais : sa collecte a commencé au plus tôt à l'appel. Jamais deux
   * collectes simultanées : pendant qu'une tourne, les appelants suivants
   * partagent LA collecte suivante, lancée dès la fin de la courante.
   */
  getState(): Promise<ControlState> {
    // `queued` d'abord : entre la fin de la collecte courante (inflight vidé)
    // et le départ de la suivante, un appelant rejoint la collecte déjà
    // enchaînée — sinon il en lancerait une seconde, concurrente.
    if (this.queued) return this.queued;
    if (!this.inflight) return this.startCollect();
    const after = this.inflight.then(
      () => undefined,
      () => undefined,
    );
    this.queued = after.then(() => {
      this.queued = null;
      return this.startCollect();
    });
    return this.queued;
  }

  private startCollect(): Promise<ControlState> {
    this.revision += 1;
    this.collections += 1;
    const revision = this.revision;
    const run = this.collect(this.root).then((base): ControlState => ({
      ...base,
      instanceId: this.instanceId,
      revision,
    }));
    this.inflight = run;
    const clear = () => {
      if (this.inflight === run) this.inflight = null;
    };
    run.then(clear, clear);
    return run;
  }

  /** Un changement a eu lieu : pousse un état frais aux abonnés, coalescé et borné. */
  changed(): void {
    if (this.closed || this.subscriptions.size === 0) return;
    const now = Date.now();
    this.firstPendingAt ??= now;
    if (this.timer) clearTimeout(this.timer);
    const wait = Math.max(
      0,
      Math.min(this.debounceMs, this.firstPendingAt + this.maxDelayMs - now),
    );
    this.timer = setTimeout(() => void this.flush(), wait);
  }

  private async flush(): Promise<void> {
    this.timer = null;
    this.firstPendingAt = null;
    try {
      const state = await this.getState();
      for (const sub of this.subscriptions.values()) this.deliverState(sub, state);
    } catch (error) {
      // Un état illisible pendant une écriture concurrente sera repoussé au
      // prochain changement ; les clients gardent le précédent.
      logger.warn({ err: (error as Error).message }, 'Control state push failed');
    }
  }

  /** Notice lisible (toast du dashboard, notification des extensions). */
  notice(type: string, message: string): void {
    for (const sub of this.subscriptions.values()) {
      if (!sub.ready) {
        // Avant l'activation (réponse de state.subscribe pas encore écrite) :
        // la notice n'est pas livrée, mais jamais perdue sans trace.
        sub.droppedNotices += 1;
        continue;
      }
      if (this.congested(sub)) {
        if (sub.transport.policy === 'disconnect') {
          this.dropSlow(sub);
          continue;
        }
        sub.droppedNotices += 1;
        continue;
      }
      sub.seq += 1;
      sub.transport.write('control.notice', { seq: sub.seq, type, message });
    }
  }

  /**
   * Abonne un transport. `initial: 'frame'` (SSE) : l'état courant part en
   * première notification ; `initial: 'return'` (stdio) : il est rendu à
   * l'appelant (réponse de `state.subscribe`), et les notifications ne
   * commencent qu'après `activate()` — jamais avant la réponse.
   */
  async subscribe(
    transport: SubscriberTransport,
    { initial }: { initial: 'frame' | 'return' },
  ): Promise<{ subscriptionId: string; seq: number; state: ControlState; activate: () => void }> {
    const id = `sub-${this.nextSubscription++}`;
    const sub: Subscription = {
      id,
      transport,
      seq: 0,
      lastRevision: 0,
      ready: false,
      pendingState: false,
      waitingDrain: false,
      droppedNotices: 0,
    };
    this.subscriptions.set(id, sub);
    this.ensureWatching();
    let state: ControlState;
    try {
      state = await this.getState();
    } catch (error) {
      this.subscriptions.delete(id);
      throw error;
    }
    const activate = () => {
      if (!this.subscriptions.has(id)) return;
      sub.ready = true;
      if (sub.pendingState) {
        sub.pendingState = false;
        void this.getState().then(
          (fresh) => this.deliverState(sub, fresh),
          (error) => logger.warn({ err: (error as Error).message }, 'Control state push failed'),
        );
      }
    };
    if (initial === 'frame') {
      // Un état plus récent a pu être poussé pendant la collecte initiale :
      // activate() le rattrape après l'envoi de celle-ci.
      const missed = sub.pendingState;
      sub.pendingState = false;
      sub.ready = true;
      this.deliverState(sub, state);
      if (missed) {
        sub.ready = false;
        sub.pendingState = true;
        activate();
      }
      return { subscriptionId: id, seq: sub.seq, state, activate: () => {} };
    }
    sub.seq = 1;
    sub.lastRevision = state.revision;
    return { subscriptionId: id, seq: 1, state, activate };
  }

  unsubscribe(id: string): boolean {
    return this.subscriptions.delete(id);
  }

  hasSubscription(id: string): boolean {
    return this.subscriptions.has(id);
  }

  private congested(sub: Subscription): boolean {
    return sub.transport.bufferedBytes() > this.maxBufferedBytes;
  }

  private dropSlow(sub: Subscription): void {
    this.subscriptions.delete(sub.id);
    this.slowDisconnects += 1;
    logger.warn(
      { subscription: sub.id, bufferedBytes: sub.transport.bufferedBytes(), seq: sub.seq },
      'Control subscriber too slow: disconnected (it reconnects and gets the full state)',
    );
    sub.transport.disconnect('slow');
  }

  private deliverState(sub: Subscription, state: ControlState): void {
    if (!this.subscriptions.has(sub.id)) return;
    if (state.revision <= sub.lastRevision) return;
    if (!sub.ready) {
      sub.pendingState = true;
      return;
    }
    if (this.congested(sub)) {
      if (sub.transport.policy === 'disconnect') {
        this.dropSlow(sub);
        return;
      }
      sub.pendingState = true;
      if (!sub.waitingDrain) {
        sub.waitingDrain = true;
        sub.transport.onceDrained(() => {
          sub.waitingDrain = false;
          if (!sub.pendingState || !this.subscriptions.has(sub.id)) return;
          sub.pendingState = false;
          void this.getState().then(
            (fresh) => this.deliverState(sub, fresh),
            (error) => logger.warn({ err: (error as Error).message }, 'Control state push failed'),
          );
        });
      }
      return;
    }
    sub.seq += 1;
    sub.lastRevision = state.revision;
    const droppedNotices = sub.droppedNotices;
    sub.droppedNotices = 0;
    sub.transport.write('state.changed', {
      subscriptionId: sub.transport.policy === 'disconnect' ? null : sub.id,
      seq: sub.seq,
      state,
      droppedNotices,
    });
  }

  /**
   * Vérifie la contre-pression d'un abonné hors envoi d'état (battement de
   * cœur SSE) : rend false si l'abonné vient d'être déconnecté.
   */
  checkPressure(id: string): boolean {
    const sub = this.subscriptions.get(id);
    if (!sub) return false;
    if (sub.transport.policy === 'disconnect' && this.congested(sub)) {
      this.dropSlow(sub);
      return false;
    }
    return true;
  }

  stats() {
    return {
      subscribers: this.subscriptions.size,
      collections: this.collections,
      slowDisconnects: this.slowDisconnects,
      revision: this.revision,
    };
  }

  private ensureWatching(): void {
    if (!this.watchDisk || this.watchers.length > 0 || this.closed) return;
    // Fichiers d'état de .striart/ — en EXCLUANT agents/ (des clones entiers,
    // les refs sont couvertes par watchAgents ci-dessous), logs/ (le daemon y
    // écrit en continu), control/ (jetons des instances), le verrou
    // transitoire (battu toutes les 5 s), les verrous d'état, la file
    // d'attente du verrou (lock-queue/), les suppressions en cours
    // (removing/) et les .tmp d'écriture atomique (state-watch-ignore.ts).
    const dir = striartDir(this.root);
    const stateWatcher = chokidar.watch(dir, {
      ignoreInitial: true,
      depth: 2,
      ignored: (p: string) => isIgnoredStatePath(path.relative(dir, p), ['logs', 'control']),
    });
    stateWatcher.on('all', () => this.changed());
    stateWatcher.on('error', (error) => logger.warn({ err: error }, 'Control state watcher'));
    // Refs des agents : « en attente » et « dernier commit » bougent ici.
    const refsWatcher = watchAgents({ root: this.root, onCommit: () => this.changed() });
    this.watchers = [stateWatcher, refsWatcher];
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.offBus();
    const subs = [...this.subscriptions.values()];
    this.subscriptions.clear();
    for (const sub of subs) sub.transport.disconnect('closing');
    const watchers = this.watchers;
    this.watchers = [];
    await Promise.all(
      watchers.map((w) =>
        w.close().catch((error: Error) => {
          // Fermeture best-effort : un watcher déjà mort n'empêche pas l'arrêt.
          logger.debug({ err: error.message }, 'Control watcher close failed');
        }),
      ),
    );
  }
}

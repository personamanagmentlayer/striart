import path from 'node:path';
import chokidar from 'chokidar';
import { onStriartEvent } from '../events.ts';
import { logger } from '../logger.ts';
import { striartDir } from '../paths.ts';
import { isIgnoredStatePath } from '../state-watch-ignore.ts';
import { watchAgents } from '../watcher.ts';
import { STATUS_URI, TICKETS_URI } from './resources.ts';

/**
 * Flux de changements des ressources MCP, pour les abonnements
 * (`subscriptions/listen` moderne, `resources/subscribe` legacy).
 *
 * Même source de vérité que le dashboard (process distincts : le bus
 * in-process ne voit que ce process) : le DISQUE — fichiers d'état de
 * `.striart/` (hors clones, verrou transitoire, file du verrou, écritures
 * atomiques en cours) et refs des clones (watchAgents, jamais les
 * worktrees) — plus le bus in-process pour les actions lancées par CE
 * serveur. Aucun état parallèle.
 *
 * Paresseux : les watchers n'existent que tant qu'au moins un abonné est
 * inscrit, et sont fermés avec le dernier. Les rafales sont coalescées
 * (`debounceMs`) en un seul lot d'URI changées.
 */

export interface ChangeBatch {
  /** URI dont le contenu a changé. */
  updated: Set<string>;
  /** La liste des ressources a changé (ticket ou journal apparu/disparu). */
  listChanged: boolean;
}

export interface ChangeFeed {
  subscribe(listener: (batch: ChangeBatch) => void): () => void;
  close(): Promise<void>;
}

/** Fabrique injectable (tests unitaires : pas de disque). */
export type ChangeFeedFactory = (root: string) => ChangeFeed;

export function createChangeFeed(root: string, { debounceMs = 300 } = {}): ChangeFeed {
  const listeners = new Set<(batch: ChangeBatch) => void>();
  let closers: Array<() => Promise<void> | void> = [];
  let pending: ChangeBatch = { updated: new Set(), listChanged: false };
  let timer: ReturnType<typeof setTimeout> | null = null;

  const flush = () => {
    timer = null;
    const batch = pending;
    pending = { updated: new Set(), listChanged: false };
    for (const listener of listeners) {
      try {
        listener(batch);
      } catch (error) {
        logger.warn({ err: error }, 'MCP: change subscriber failed');
      }
    }
  };
  const schedule = () => {
    if (!timer) timer = setTimeout(flush, debounceMs);
  };
  const mark = (uri: string) => {
    pending.updated.add(uri);
    schedule();
  };

  const dir = striartDir(root);
  const onPath = (event: string, p: string) => {
    const rel = path.relative(dir, p);
    if (rel === '' || rel.startsWith('..')) return;
    const parts = rel.split(path.sep);
    pending.updated.add(STATUS_URI);
    if (parts[0] === 'conflicts') {
      pending.updated.add(TICKETS_URI);
      if (parts[1]) pending.updated.add(`striart://tickets/${parts[1]}`);
      // Ticket créé/supprimé, ou clos (RESOLVED) : il quitte la liste des ouverts.
      if (event === 'addDir' || event === 'unlinkDir' || parts[2] === 'RESOLVED') {
        pending.listChanged = true;
      }
    }
    if (parts[0] === 'logs' && parts[1]) {
      pending.updated.add(`striart://logs/${parts[1]}`);
      if (event === 'add' || event === 'unlink') pending.listChanged = true;
    }
    schedule();
  };

  const start = () => {
    const stateWatcher = chokidar.watch(dir, {
      ignoreInitial: true,
      depth: 3,
      ignored: (p: string) => isIgnoredStatePath(path.relative(dir, p), ['permissions']),
    });
    stateWatcher.on('all', onPath);
    stateWatcher.on('error', (error) => logger.warn({ err: error }, 'MCP: state watcher'));
    const refsWatcher = watchAgents({ root, onCommit: () => mark(STATUS_URI) });
    const offBus = onStriartEvent((_config, event) => {
      // Mesure du verrou (L8) : ne change aucun état lisible — pas de notification de ressource.
      if (event.type === 'lock:contention') return;
      pending.updated.add(STATUS_URI);
      pending.updated.add(TICKETS_URI);
      schedule();
    });
    closers = [() => stateWatcher.close(), () => refsWatcher.close(), offBus];
  };

  const stop = async () => {
    const current = closers;
    closers = [];
    if (timer) clearTimeout(timer);
    timer = null;
    await Promise.all(current.map(async (close) => close()));
  };

  return {
    subscribe(listener) {
      listeners.add(listener);
      if (listeners.size === 1) start();
      return () => {
        if (!listeners.delete(listener)) return;
        if (listeners.size === 0) {
          stop().catch((error) => logger.warn({ err: error }, 'MCP: closing watchers failed'));
        }
      };
    },
    async close() {
      listeners.clear();
      await stop();
    },
  };
}

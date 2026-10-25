/**
 * Boucle de `striart watch` : surveille les commits des agents, les merge
 * derrière le Test Gate, rebase les autres, mesure leur retard et
 * réconcilie périodiquement l'état. Logique métier pure : elle n'écrit
 * rien sur le terminal, elle ÉMET des événements typés (`WatchEvent`) que
 * la CLI rend en texte, en ndjson (`watch --json`) ou dans l'UI Ink
 * (`watch --ui`).
 *
 * Invariants (repris tels quels de l'implémentation historique de cli.js) :
 *  - un seul merge à la fois : tout passe par une chaîne de promesses FIFO
 *    (`chain`) — le verrou principal est réentrant par compteur et ne
 *    sérialise PAS deux tâches async de premier niveau d'un même process ;
 *  - la réconciliation périodique est ENFILÉE sur cette même chaîne, jamais
 *    lancée en parallèle d'un merge, avec un garde anti-empilement ;
 *  - seule une branche de tâche (`striart/…`) déclenche un merge ;
 *  - un agent autonome gère son propre merge en fin de session ;
 *  - le fetch silencieux ne touche jamais un worktree et ne signale que les
 *    CHANGEMENTS de retard.
 */
import { StriartError } from './errors.js';
import { logger } from './logger.js';
import { loadConfig } from './config.js';
import { agentsDir } from './paths.js';
import { watchAgents } from './watcher.js';
import {
  checkAgentsBehind,
  mergeAgentCommit,
  reconcile,
  shouldWatcherMerge,
  syncAllAgents,
} from './orchestrator.js';
import type { MergeResult, SyncResult } from './types.js';

export type WatchEvent =
  | { type: 'started'; agentsDir: string; merge: boolean; fetchIntervalMs: number }
  | { type: 'commit'; agent: string; branch: string; sha: string }
  | { type: 'merge'; result: MergeResult }
  | { type: 'merge-skipped'; agent: string; reason: 'autonomous' }
  /** Arrêt demandé avant que ce merge en file ne parte : à relancer à la main (`striart merge`). */
  | { type: 'merge-deferred'; agent: string }
  | { type: 'merge-error'; agent: string; error: { code: string | null; message: string } }
  | { type: 'sync'; result: SyncResult }
  | {
      type: 'reconcile';
      started: Array<{ taskId: string; agent: string }>;
      sessionPidsCleared: string[];
    }
  | { type: 'reconcile-error'; error: { code: string | null; message: string } }
  | { type: 'behind'; agent: string; behind: number; targetBranch: string }
  | { type: 'fetch-error'; agent: string | null; error: { code: string | null; message: string } };

export interface WatchLoop {
  /**
   * Arrête watchers et timers. Aucune opération encore en file ne démarre :
   * chaque merge abandonné ainsi est signalé (`merge-deferred`) — le watcher
   * ne revoit pas un commit antérieur à son démarrage, il faut le relancer à
   * la main. `drain` (défaut) attend la fin de l'opération EN VOL (merge,
   * Test Gate) et en rapporte le résultat ; sans, la laisse à la
   * récupération après coupure (verrou orphelin, merge orphelin) et
   * n'émet plus rien.
   */
  stop(options?: { drain?: boolean }): Promise<void>;
  /** Une opération (merge, sync, réconciliation) est-elle en cours ? */
  isBusy(): boolean;
  /** Résolue quand la surveillance des refs est en place (un commit antérieur passerait inaperçu). */
  ready: Promise<void>;
}

function describeError(error: unknown): { code: string | null; message: string } {
  if (error instanceof StriartError) return { code: error.code, message: error.message };
  return { code: null, message: error instanceof Error ? error.message : String(error) };
}

export async function startWatchLoop({
  root,
  merge,
  onEvent,
  usePolling = false,
}: {
  root: string;
  merge: boolean;
  onEvent: (event: WatchEvent) => void;
  /** Sondage des refs au lieu des notifications du système (systèmes de fichiers réseau, tests). */
  usePolling?: boolean;
}): Promise<WatchLoop> {
  const config = await loadConfig(root);
  const timers: NodeJS.Timeout[] = [];
  let chain: Promise<unknown> = Promise.resolve();
  let pending = 0;
  /** Arrêt demandé : plus aucune opération ne démarre. */
  let stopped = false;
  /** Arrêt terminé : plus aucun événement (l'opération en vol a été rapportée). */
  let closed = false;
  /**
   * Enfile une opération sur la chaîne FIFO, en comptant celles en vol.
   * `onDropped` : appelée à la place de l'opération si l'arrêt est tombé
   * avant son tour.
   */
  const enqueue = (operation: () => Promise<unknown>, onDropped?: () => Promise<void>) => {
    pending += 1;
    chain = chain.then(async () => {
      try {
        if (stopped) {
          await onDropped?.();
          return;
        }
        await operation();
      } catch (error) {
        // Chaque opération rapporte déjà ses échecs (merge-error,
        // reconcile-error) : arriver ici est un bug (abonné qui lève…). Le
        // journaliser, mais ne JAMAIS laisser une promesse rejetée en tête de
        // chaîne — toutes les opérations suivantes seraient sautées.
        logger.error({ err: error }, 'Opération de la boucle watch en échec inattendu');
      } finally {
        pending -= 1;
      }
    });
  };

  const emit = (event: WatchEvent) => {
    if (!closed) onEvent(event);
  };
  /** Un seul signalement par agent, quel que soit le nombre de commits en file. */
  const deferred = new Set<string>();
  const deferMerge = async (agent: string) => {
    if (deferred.has(agent)) return;
    // Un agent autonome n'est jamais mergé par le watcher (sa fin de cycle
    // s'en charge) : rien n'est ajourné pour lui.
    if (!(await shouldWatcherMerge({ root, agent }).catch(() => true))) return;
    deferred.add(agent);
    // Journalisé même quand l'événement ne peut plus partir (`stop({ drain:
    // false })` de `--ui`) : un merge abandonné n'est jamais tu.
    logger.warn({ agent }, 'Merge non lancé : arrêt demandé (à relancer par striart merge)');
    emit({ type: 'merge-deferred', agent });
  };

  // Fetch silencieux périodique : visibilité sur le retard des agents, sans
  // jamais toucher leurs working trees. Le rebase reste fait au merge.
  if (config.fetchIntervalMs > 0) {
    let checking = false;
    const lastBehind = new Map<string, number>();
    timers.push(
      setInterval(async () => {
        if (checking) return; // pas de chevauchement si un check traîne
        checking = true;
        try {
          for (const { agent, behind, error } of await checkAgentsBehind({ root, config })) {
            if (error) {
              emit({ type: 'fetch-error', agent, error: { code: null, message: error } });
              continue;
            }
            if (behind === (lastBehind.get(agent) ?? 0)) continue;
            lastBehind.set(agent, behind);
            emit({ type: 'behind', agent, behind, targetBranch: config.targetBranch });
          }
        } catch (error) {
          emit({ type: 'fetch-error', agent: null, error: describeError(error) });
        } finally {
          checking = false;
        }
      }, config.fetchIntervalMs),
    );
  }

  // Réconciliation périodique (level-triggered) : rattrape les changements
  // d'état qui n'émettent aucun commit — `clean` du bloqueur d'une tâche
  // `--after`, session autonome morte. Enfilée sur la chaîne de merge.
  if (merge && config.fetchIntervalMs > 0) {
    let reconcilePending = false;
    timers.push(
      setInterval(() => {
        if (reconcilePending || stopped) return;
        reconcilePending = true;
        enqueue(async () => {
          try {
            const { sessionPidsCleared, started } = await reconcile({ root });
            if (started.length > 0 || sessionPidsCleared.length > 0) {
              emit({
                type: 'reconcile',
                started: started.map(({ task }) => ({ taskId: task.id, agent: task.agent })),
                sessionPidsCleared,
              });
            }
          } catch (error) {
            emit({ type: 'reconcile-error', error: describeError(error) });
          } finally {
            reconcilePending = false;
          }
        });
      }, config.fetchIntervalMs),
    );
  }

  const watcher = watchAgents({
    root,
    usePolling,
    onCommit: ({ agent, branch, sha }: { agent: string; branch: string; sha: string }) => {
      emit({ type: 'commit', agent, branch, sha });
      if (!merge) return;
      // Seule la branche de tâche déclenche un merge : les refs annexes du
      // clone (ex. son main local touché par l'agent) ne sont que du bruit.
      if (!branch.startsWith('striart/')) return;
      // Commit vu entre l'arrêt demandé et la fermeture du watcher : pas de
      // merge, mais signalé comme ceux qui attendaient en file.
      if (stopped) {
        void deferMerge(agent);
        return;
      }
      enqueue(
        async () => {
          try {
            if (!(await shouldWatcherMerge({ root, agent }))) {
              emit({ type: 'merge-skipped', agent, reason: 'autonomous' });
              return;
            }
            const result = await mergeAgentCommit({ root, agent });
            emit({ type: 'merge', result });
            if (result.status === 'MERGED') {
              // Tous les agents repartent du code le plus récent — Y COMPRIS
              // celui qu'on vient de merger : le commit de merge --no-ff
              // n'existe que dans main, sans ça il resterait « behind 1 ».
              for (const sync of await syncAllAgents({ root })) {
                if (sync.status !== 'UP_TO_DATE') emit({ type: 'sync', result: sync });
              }
            }
          } catch (error) {
            // Agent stoppé entre le commit et son tour dans la chaîne : rien à faire.
            if (error instanceof StriartError && error.code === 'AGENT_UNKNOWN') return;
            emit({ type: 'merge-error', agent, error: describeError(error) });
          }
        },
        () => deferMerge(agent),
      );
    },
  });

  emit({
    type: 'started',
    agentsDir: agentsDir(root),
    merge,
    fetchIntervalMs: config.fetchIntervalMs,
  });

  const ready = new Promise<void>((resolve) => watcher.once('ready', () => resolve()));

  return {
    ready,
    async stop({ drain = true } = {}) {
      stopped = true;
      if (!drain) closed = true;
      for (const timer of timers) clearInterval(timer);
      // Arrêt best effort : un watcher déjà fermé ne doit pas empêcher la
      // vidange. La chaîne, elle, ne rejette jamais (voir enqueue).
      await watcher.close().catch((error: unknown) => {
        logger.debug({ err: error }, 'Fermeture du watcher de refs');
      });
      if (drain) await chain;
      closed = true;
    },
    isBusy() {
      return pending > 0;
    },
  };
}

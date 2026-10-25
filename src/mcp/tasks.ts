import { randomUUID } from 'node:crypto';
import type { JsonObject, JsonRpcError } from './protocol.ts';

/**
 * Magasin des tâches de l'extension `io.modelcontextprotocol/tasks`
 * (ext-tasks, révision 2026-07-28) pour les opérations longues
 * (striart_merge, striart_resolve_apply : Test Gate).
 *
 * - Identifiant : UUID v4 (crypto) — non devinable, il sert de jeton
 *   porteur pour `tasks/get` (exigence « Task ID unguessability »).
 * - Durée de vie : la tâche existe dès sa création (avant la réponse
 *   CreateTaskResult) ; une tâche TERMINÉE est oubliée `ttlMs` après sa
 *   création ; une tâche EN COURS ne l'est jamais (son résultat est la seule
 *   trace de l'issue du merge pour le client).
 * - Plafond : `maxTasks` ; au-delà, les tâches terminées les plus anciennes
 *   sont purgées, et si toutes sont en cours la création est refusée (null)
 *   — l'appelant exécute alors de façon synchrone, ce que la spec permet
 *   (« the server decides per-request whether to create a task »).
 * - Annulation (`tasks/cancel`) : l'AbortSignal de la tâche est déclenché
 *   et transmis aux primitives. Tant que l'opération attend un créneau ou le
 *   verrou principal, elle est réellement annulée (statut `cancelled`, rien
 *   exécuté). Une fois le verrou acquis, la section critique (Test Gate
 *   compris) n'est JAMAIS interrompue — l'interrompre laisserait le dépôt en
 *   état « merging » : l'opération va à son terme et la tâche finit
 *   `completed` avec l'issue réelle, explicitement permis par la spec
 *   (« MAY ultimately reach a terminal status other than cancelled »).
 */

export type TaskStatus = 'working' | 'input_required' | 'completed' | 'failed' | 'cancelled';

export interface TaskRecord {
  taskId: string;
  status: TaskStatus;
  statusMessage?: string;
  createdAt: string;
  lastUpdatedAt: string;
  ttlMs: number;
  pollIntervalMs: number;
  result?: JsonObject;
  error?: JsonRpcError;
  cancelRequested: boolean;
  controller: AbortController;
  done: Promise<void>;
}

type Listener = (task: TaskRecord) => void;

export class TaskStore {
  readonly #tasks = new Map<string, TaskRecord>();
  readonly #listeners = new Set<Listener>();
  readonly #ttlMs: number;
  readonly #pollIntervalMs: number;
  readonly #maxTasks: number;
  readonly #now: () => number;

  constructor({
    ttlMs,
    pollIntervalMs,
    maxTasks = 256,
    now = Date.now,
  }: {
    ttlMs: number;
    pollIntervalMs: number;
    maxTasks?: number;
    now?: () => number;
  }) {
    this.#ttlMs = ttlMs;
    this.#pollIntervalMs = pollIntervalMs;
    this.#maxTasks = maxTasks;
    this.#now = now;
  }

  /** Abonné aux changements d'état (notifications/tasks). Retourne le désabonnement. */
  onChange(listener: Listener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #emit(task: TaskRecord): void {
    for (const listener of this.#listeners) {
      try {
        listener(task);
      } catch {
        // Un abonné (écriture de notification) ne casse jamais la tâche.
      }
    }
  }

  #isExpired(task: TaskRecord): boolean {
    return task.status !== 'working' && this.#now() > Date.parse(task.createdAt) + task.ttlMs;
  }

  #sweep(): void {
    for (const [id, task] of this.#tasks) if (this.#isExpired(task)) this.#tasks.delete(id);
    if (this.#tasks.size < this.#maxTasks) return;
    const terminal = [...this.#tasks.values()]
      .filter((t) => t.status !== 'working')
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    for (const task of terminal) {
      if (this.#tasks.size < this.#maxTasks) break;
      this.#tasks.delete(task.taskId);
    }
  }

  /**
   * Crée la tâche et lance `run` (qui ne doit pas throw : un échec d'outil
   * est un résultat `isError`, donc `completed`). Retourne null si le
   * plafond est atteint par des tâches toutes en cours.
   */
  create(run: (signal: AbortSignal) => Promise<JsonObject>): TaskRecord | null {
    this.#sweep();
    if (this.#tasks.size >= this.#maxTasks) return null;
    const at = new Date(this.#now()).toISOString();
    const controller = new AbortController();
    const task: TaskRecord = {
      taskId: randomUUID(),
      status: 'working',
      statusMessage: 'The operation is in progress.',
      createdAt: at,
      lastUpdatedAt: at,
      ttlMs: this.#ttlMs,
      pollIntervalMs: this.#pollIntervalMs,
      cancelRequested: false,
      controller,
      done: Promise.resolve(),
    };
    this.#tasks.set(task.taskId, task);
    task.done = (async () => {
      try {
        const result = await run(controller.signal);
        task.status = 'completed';
        task.result = result;
        task.statusMessage = task.cancelRequested
          ? 'Cancellation was requested after the operation had acquired the main lock: a started merge (Test Gate included) is never interrupted, so the repository is never left mid-merge — this is its real outcome.'
          : result.isError === true
            ? 'The operation finished with an error (see result).'
            : 'The operation finished.';
      } catch (error) {
        if (error instanceof Error && error.name === 'CancelledBeforeStart') {
          // Annulée pendant l'attente d'un créneau : l'opération n'a JAMAIS
          // commencé — la seule annulation réellement honorée.
          task.status = 'cancelled';
          task.statusMessage = 'Cancelled before the operation started: nothing was executed.';
          task.lastUpdatedAt = new Date(this.#now()).toISOString();
          this.#emit(task);
          return;
        }
        // Défaut de programmation (run ne throw pas en principe) : erreur
        // JSON-RPC interne, sans détail interne exposé.
        task.status = 'failed';
        task.error = { code: -32603, message: 'Internal error while running the task.' };
        task.statusMessage = error instanceof Error ? error.name : 'Error';
      }
      task.lastUpdatedAt = new Date(this.#now()).toISOString();
      this.#emit(task);
    })();
    return task;
  }

  get(taskId: string): TaskRecord | null {
    const task = this.#tasks.get(taskId);
    if (!task) return null;
    if (this.#isExpired(task)) {
      this.#tasks.delete(taskId);
      return null;
    }
    return task;
  }

  /** Enregistre l'intention d'annuler (coopératif, voir l'en-tête). */
  requestCancel(taskId: string): boolean {
    const task = this.get(taskId);
    if (!task) return false;
    if (task.status === 'working' && !task.cancelRequested) {
      task.cancelRequested = true;
      task.controller.abort();
      task.statusMessage =
        'Cancellation requested: honored if the operation is still waiting for the main lock; once started it finishes (never left mid-merge).';
      task.lastUpdatedAt = new Date(this.#now()).toISOString();
      this.#emit(task);
    }
    return true;
  }

  /** Toutes les tâches encore en cours (attendues avant l'arrêt du serveur). */
  pending(): Promise<void>[] {
    return [...this.#tasks.values()].filter((t) => t.status === 'working').map((t) => t.done);
  }
}

/** Forme publique `Task` / `DetailedTask` (sans les champs internes). */
export function publicTask(task: TaskRecord, { detailed }: { detailed: boolean }): JsonObject {
  const base: JsonObject = {
    taskId: task.taskId,
    status: task.status,
    createdAt: task.createdAt,
    lastUpdatedAt: task.lastUpdatedAt,
    ttlMs: task.ttlMs,
    pollIntervalMs: task.pollIntervalMs,
  };
  if (task.statusMessage) base.statusMessage = task.statusMessage;
  if (detailed && task.status === 'completed' && task.result) base.result = task.result;
  if (detailed && task.status === 'failed' && task.error) base.error = task.error;
  return base;
}

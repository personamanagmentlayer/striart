import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { striartDir } from './paths.ts';
import { UNCHANGED, readJson, updateJsonLocked } from './json-file.ts';
import type { QueueTask } from './types.js';
import type { PublicRouterDetails } from './router-details.ts';

function queuePath(root: string) {
  return path.join(striartDir(root), 'queue.json');
}

/**
 * Lecture-modification-écriture de la file sous le verrou d'état : deux
 * process qui enfilent ou retirent en même temps ne perdent aucune tâche.
 */
function updateQueue(
  root: string,
  mutator: (queue: QueueTask[]) => QueueTask[] | typeof UNCHANGED,
) {
  return updateJsonLocked(queuePath(root), { fallback: [], code: 'QUEUE_CORRUPT' }, mutator);
}

export async function readQueue(root: string): Promise<QueueTask[]> {
  return readJson(queuePath(root), { fallback: [], code: 'QUEUE_CORRUPT' });
}

export async function enqueueTask(
  root: string,
  {
    agent,
    prompt,
    predictedFiles,
    routing = null,
    collisions,
    command = null,
    after = null,
    reuse = false,
    allowHistoricalSecrets = false,
  }: {
    agent: string;
    prompt: string;
    predictedFiles: string[];
    routing?: PublicRouterDetails | null;
    collisions: QueueTask['collisions'];
    command?: string | null;
    after?: string | null;
    reuse?: boolean;
    allowHistoricalSecrets?: boolean;
  },
): Promise<QueueTask> {
  const task: QueueTask = {
    id: `task-${randomUUID().slice(0, 8)}`,
    status: 'WAITING',
    agent,
    prompt,
    predictedFiles,
    // Détail du Router (additif, informatif) : pourquoi cette tâche attend.
    ...(routing ? { routing } : {}),
    collisions,
    command,
    // Dépendance déclarée : la tâche ne part pas tant que ce travail
    // (id de tâche en file ou nom d'agent actif) n'est pas terminé.
    after,
    reuse,
    // Décision consciente prise à l'enfilage (bypass HISTORICAL_SECRETS_FOUND) :
    // doit survivre au dégagement, comme `reuse`. Jamais de consentement à
    // perdre du travail ici : il ne vaut que pour l'état constaté à l'instant.
    allowHistoricalSecrets,
    createdAt: new Date().toISOString(),
  };
  await updateQueue(root, (queue) => [...queue, task]);
  return task;
}

export async function removeTask(root: string, taskId: string): Promise<boolean> {
  let removed = false;
  await updateQueue(root, (queue) => {
    const remaining = queue.filter((t) => t.id !== taskId);
    removed = remaining.length !== queue.length;
    return removed ? remaining : UNCHANGED;
  });
  return removed;
}

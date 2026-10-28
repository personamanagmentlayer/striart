import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { striartDir } from './paths.js';
import { UNCHANGED, readJson, updateJsonLocked } from './json-file.js';

function queuePath(root) {
  return path.join(striartDir(root), 'queue.json');
}

/**
 * Lecture-modification-écriture de la file sous le verrou d'état : deux
 * process qui enfilent ou retirent en même temps ne perdent aucune tâche.
 * @param {string} root
 * @param {(queue: import('./types.js').QueueTask[]) => import('./types.js').QueueTask[] | typeof UNCHANGED} mutator
 */
function updateQueue(root, mutator) {
  return updateJsonLocked(queuePath(root), { fallback: [], code: 'QUEUE_CORRUPT' }, mutator);
}

/** @param {string} root @returns {Promise<import('./types.js').QueueTask[]>} */
export async function readQueue(root) {
  return readJson(queuePath(root), { fallback: [], code: 'QUEUE_CORRUPT' });
}

/** @param {string} root @param {{agent: string, prompt: string, predictedFiles: string[], routing?: import('./router-details.ts').PublicRouterDetails|null, collisions: import('./types.js').Collision[], command?: string|null, after?: string|null, reuse?: boolean, allowHistoricalSecrets?: boolean}} task @returns {Promise<import('./types.js').QueueTask>} */
export async function enqueueTask(
  root,
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
  },
) {
  const task = /** @type {import('./types.js').QueueTask} */ ({
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
  });
  await updateQueue(root, (queue) => [...queue, task]);
  return task;
}

export async function removeTask(root, taskId) {
  let removed = false;
  await updateQueue(root, (queue) => {
    const remaining = queue.filter((t) => t.id !== taskId);
    removed = remaining.length !== queue.length;
    return removed ? remaining : UNCHANGED;
  });
  return removed;
}

import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { striartDir } from './clone.js';
import { readJson, writeJsonAtomic } from './json-file.js';

function queuePath(root) {
  return path.join(striartDir(root), 'queue.json');
}

/** @param {string} root @returns {Promise<import('./types.js').QueueTask[]>} */
export async function readQueue(root) {
  return readJson(queuePath(root), { fallback: [], code: 'QUEUE_CORRUPT' });
}

/** @param {string} root @param {{agent: string, prompt: string, predictedFiles: string[], collisions: import('./types.js').Collision[], command?: string|null, after?: string|null, reuse?: boolean}} task @returns {Promise<import('./types.js').QueueTask>} */
export async function enqueueTask(
  root,
  { agent, prompt, predictedFiles, collisions, command = null, after = null, reuse = false },
) {
  const queue = await readQueue(root);
  const task = /** @type {import('./types.js').QueueTask} */ ({
    id: `task-${randomUUID().slice(0, 8)}`,
    status: 'WAITING',
    agent,
    prompt,
    predictedFiles,
    collisions,
    command,
    // Dépendance déclarée : la tâche ne part pas tant que ce travail
    // (id de tâche en file ou nom d'agent actif) n'est pas terminé.
    after,
    reuse,
    createdAt: new Date().toISOString(),
  });
  queue.push(task);
  await writeJsonAtomic(queuePath(root), queue);
  return task;
}

export async function removeTask(root, taskId) {
  const queue = await readQueue(root);
  const remaining = queue.filter((t) => t.id !== taskId);
  await writeJsonAtomic(queuePath(root), remaining);
  return queue.length !== remaining.length;
}

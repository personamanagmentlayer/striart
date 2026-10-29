import path from 'node:path';
import { striartDir } from './paths.ts';
import { readJson, writeJsonAtomic } from './json-file.ts';
import { withStateLock } from './state-lock.ts';
import type { AgentRegistry } from './types.js';

function locksPath(root: string) {
  return path.join(striartDir(root), 'locks.json');
}

export async function readLocks(root: string): Promise<Record<string, string>> {
  return readJson(locksPath(root), { fallback: {}, code: 'LOCKS_CORRUPT' });
}

/**
 * Verrous optimistes : locks.json est une vue matérialisée du registre —
 * { 'src/auth/db.ts': 'agent-a' }. La source de vérité reste agents.json
 * (prédictions du Router) ; ce fichier est reconstruit à chaque changement
 * d'agent pour l'observabilité (dashboard, humain, outils externes).
 *
 * Écrit sous le verrou d'état (réentrant) : appelé depuis la mise à jour du
 * registre, dans la même section, il dérive toujours du registre qui vient
 * d'être écrit — deux reconstructions concurrentes ne s'entrelacent pas.
 */
export async function syncLocks(
  root: string,
  registry: AgentRegistry,
): Promise<Record<string, string>> {
  const locks: Record<string, string> = {};
  for (const [name, meta] of Object.entries(registry)) {
    for (const file of meta.predictedFiles ?? []) {
      locks[file] ??= name; // premier arrivé, premier verrouillé
    }
  }
  await withStateLock(striartDir(root), () => writeJsonAtomic(locksPath(root), locks));
  return locks;
}

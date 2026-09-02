import { readFile } from 'node:fs/promises';
import path from 'node:path';
import chokidar from 'chokidar';
import { agentsDir } from './clone.js';
import { logger } from './logger.js';

/**
 * Surveille .striart/agents/<name>/.git/refs/heads/** de tous les agents.
 * À chaque nouveau commit (création ou mise à jour d'une ref de branche),
 * appelle onCommit({ agent, branch, sha, refPath }).
 *
 * On ne watch que le sous-arbre .git/refs de chaque clone : le worktree
 * (node_modules inclus) est ignoré pour ne pas saturer le watcher.
 */
export function watchAgents({ root, onCommit, usePolling = false }) {
  const dir = agentsDir(root);

  const isWatchable = (p) => {
    const rel = path.relative(dir, p);
    if (rel === '' || rel.startsWith('..')) return true;
    const parts = rel.split(path.sep);
    if (parts.length === 1) return true; // dossier de l'agent lui-même
    if (parts[1] !== '.git') return false; // worktree de l'agent : ignoré
    if (parts.length === 2) return true;
    return parts[2] === 'refs';
  };

  const watcher = chokidar.watch(dir, {
    ignoreInitial: true,
    usePolling,
    // Git écrit les refs via lock + rename : on attend que le fichier soit
    // stable avant de le lire, pour ne jamais capter une écriture partielle.
    awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 100 },
    ignored: (p) => !isWatchable(p) || p.endsWith('.lock'),
  });

  // Déduplication : un touch de ref sans nouveau commit (fetch, gc, faux
  // positif du watcher) ne doit pas déclencher un cycle de merge inutile.
  const lastShaByRef = new Map();

  const handleRef = async (filePath) => {
    const parts = path.relative(dir, filePath).split(path.sep);
    // Attendu : [agent, '.git', 'refs', 'heads', ...branche]
    if (parts[2] !== 'refs' || parts[3] !== 'heads' || parts.length < 5) return;
    const agent = parts[0];
    const branch = parts.slice(4).join('/');
    try {
      const sha = (await readFile(filePath, 'utf8')).trim();
      if (!/^[0-9a-f]{40,64}$/.test(sha)) return; // ref symbolique ou écriture en cours
      if (lastShaByRef.get(filePath) === sha) return; // pas de nouveau commit
      lastShaByRef.set(filePath, sha);
      onCommit({ agent, branch, sha, refPath: filePath });
    } catch {
      // La ref a pu être déplacée entre l'événement et la lecture (lock git) : on ignore.
    }
  };

  watcher.on('add', handleRef);
  watcher.on('change', handleRef);
  watcher.on('error', (error) => logger.error({ err: error }, 'Erreur du watcher'));

  return watcher;
}

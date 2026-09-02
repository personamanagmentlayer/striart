import { readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { loadConfig } from './config.js';
import { assertInitialized, dirStats, readRegistry } from './clone.js';
import { agentsDir } from './paths.js';
import { listConflictTickets } from './conflicts.js';
import { withMainLock } from './lock.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * striart prune — rétention automatique de l'espace de travail :
 *  - clones d'agents ARRÊTÉS (absents du registre) sans activité depuis
 *    N jours (dernier mtime du clone, worktree inclus) ;
 *  - tickets de conflit RÉSOLUS depuis N jours (date du marqueur RESOLVED).
 * Ne touche jamais : agents actifs (règle d'or n°3), tickets non résolus
 * (fallback humain, règle d'or n°4).
 *
 * @param {{root: string, days?: number|null, dryRun?: boolean}} params
 * @returns {Promise<{
 *   retentionDays: number, dryRun: boolean, freedBytes: number,
 *   clones: {removed: Array<{name: string, freedBytes: number, lastActivity: string}>, kept: Array<{name: string, lastActivity: string}>},
 *   tickets: {removed: Array<{id: string, resolvedAt: string}>},
 * }>}
 */
export async function pruneWorkspace(params) {
  return withMainLock(params.root, 'prune', () => pruneWorkspaceImpl(params));
}

async function pruneWorkspaceImpl({ root, days = null, dryRun = false }) {
  await assertInitialized(root);
  const config = await loadConfig(root);
  const retentionDays = days ?? config.pruneDays;
  const cutoff = Date.now() - retentionDays * DAY_MS;

  let freedBytes = 0;

  // 1. Clones d'agents arrêtés, inactifs depuis la période de rétention.
  const registry = await readRegistry(root);
  const clonesRemoved = [];
  const clonesKept = [];
  const entries = await readdir(agentsDir(root), { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isDirectory() || registry[entry.name]) continue; // actif → intouchable
    const clonePath = path.join(agentsDir(root), entry.name);
    const stats = await dirStats(clonePath);
    const lastActivity = new Date(stats.latestMtimeMs).toISOString();
    if (stats.latestMtimeMs > cutoff) {
      clonesKept.push({ name: entry.name, lastActivity });
      continue;
    }
    if (!dryRun) await rm(clonePath, { recursive: true, force: true, maxRetries: 5 });
    freedBytes += stats.sizeBytes;
    clonesRemoved.push({ name: entry.name, freedBytes: stats.sizeBytes, lastActivity });
  }

  // 2. Tickets résolus depuis plus de N jours (les dossiers gardent l'audit
  //    tant que la rétention court ; les tickets ouverts ne sont jamais touchés).
  const ticketsRemoved = [];
  for (const ticket of await listConflictTickets(root, { includeResolved: true })) {
    if (!ticket.resolved) continue;
    const resolvedStat = await stat(path.join(ticket.dir, 'RESOLVED')).catch(() => null);
    if (!resolvedStat || resolvedStat.mtimeMs > cutoff) continue;
    const stats = await dirStats(ticket.dir);
    if (!dryRun) await rm(ticket.dir, { recursive: true, force: true, maxRetries: 5 });
    freedBytes += stats.sizeBytes;
    ticketsRemoved.push({
      id: ticket.id,
      resolvedAt: new Date(resolvedStat.mtimeMs).toISOString(),
    });
  }

  return {
    retentionDays,
    dryRun,
    freedBytes,
    clones: { removed: clonesRemoved, kept: clonesKept },
    tickets: { removed: ticketsRemoved },
  };
}

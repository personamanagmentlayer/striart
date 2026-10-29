import { readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { loadConfig } from './config.ts';
import { assertInitialized, dirStats, readRegistry, removeClone } from './clone.ts';
import { agentsDir, striartDir } from './paths.ts';
import { StriartError } from './errors.ts';
import { listConflictTickets, removeResolvedTicketDir } from './conflicts.ts';
import { withMainLock } from './lock.ts';
import { logger } from './logger.ts';
import { withTransientRetry } from './json-file.ts';
import { ptyHostStatus } from './pty-host-state.ts';
import { AGENT_NAME_RE } from './agent-name.ts';
import { sweepCache } from './tokens/cache.ts';
import { pruneLedger } from './tokens/ledger.ts';
import { resolveTokensSettings } from './tokens/settings.ts';
import type { AgentRegistry } from './types.js';

/** Journaux par agent : sessions autonomes (session.js, acp.ts) et terminaux (pty-host.ts). */
const AGENT_LOG_RE = /^(session-.+|pty-.+)\.log$/;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * striart prune — rétention automatique de l'espace de travail :
 *  - clones d'agents ARRÊTÉS (absents du registre) sans activité depuis
 *    N jours (dernier mtime du clone, worktree inclus) ;
 *  - tickets de conflit RÉSOLUS depuis N jours (date du marqueur RESOLVED) ;
 *  - journaux de session (`session-*.log`) et de terminal (`pty-*.log`)
 *    inactifs depuis N jours, sauf ceux d'un agent actif (tâche en cours,
 *    terminal ouvert).
 * Ne touche jamais : agents actifs (règle d'or n°3), tickets non résolus
 * (fallback humain, règle d'or n°4). Une suppression qui échoue (handle tenu
 * sous Windows) est rapportée dans `failed`, jamais tue — celle d'un clone
 * reste marquée et la réconciliation la termine (removeClone).
 *
 * `signal` n'annule que l'ATTENTE du verrou, jamais une rétention commencée.
 *
 * @param {{root: string, days?: number|null, dryRun?: boolean, signal?: AbortSignal|null}} params
 * @returns {Promise<{
 *   retentionDays: number, dryRun: boolean, freedBytes: number,
 *   clones: {removed: Array<{name: string, freedBytes: number, lastActivity: string}>, kept: Array<{name: string, lastActivity: string, reason?: 'PTY_HOST_LIVE'}>},
 *   tickets: {removed: Array<{id: string, resolvedAt: string}>},
 *   logs: {removed: Array<{file: string, freedBytes: number, lastActivity: string}>},
 *   usage: {retentionDays: number, ledgerRemoved: Array<{file: string, freedBytes: number}>, cacheEntriesRemoved: number, freedBytes: number},
 *   failed: Array<{kind: 'clone'|'ticket'|'log', name: string, cause: string}>,
 * }>}
 */
export async function pruneWorkspace(params) {
  return withMainLock(params.root, 'prune', () => pruneWorkspaceImpl(params), {
    signal: params.signal ?? null,
  });
}

/**
 * Une rétention invalide n'a pas de « valeur par défaut raisonnable » : NaN
 * ou négatif rendrait `cutoff` non comparable (NaN) ou dans le futur, et
 * TOUS les clones arrêtés seraient supprimés sans un mot. Fail closed, avec
 * le même prédicat que `pruneDays` dans la config (entier >= 0).
 * @param {unknown} days
 */
function assertValidRetentionDays(days) {
  if (Number.isSafeInteger(days) && /** @type {number} */ days >= 0) return;
  throw new StriartError(
    `Rétention invalide : ${JSON.stringify(days)}. Attendu : un nombre entier de jours >= 0.`,
    {
      code: 'INVALID_RETENTION_DAYS',
      details: { days },
      hint: 'striart prune --days 14 --dry-run',
    },
  );
}

async function pruneWorkspaceImpl({ root, days = null, dryRun = false }) {
  if (days !== null) assertValidRetentionDays(days);
  await assertInitialized(root);
  const config = await loadConfig(root);
  const retentionDays = days ?? config.pruneDays;
  const cutoff = Date.now() - retentionDays * DAY_MS;

  let freedBytes = 0;
  /** @type {Array<{kind: 'clone'|'ticket'|'log', name: string, cause: string}>} */
  const failed = [];

  // 1. Clones d'agents arrêtés, inactifs depuis la période de rétention.
  const registry = await readRegistry(root);
  const clonesRemoved = [];
  const clonesKept = [];
  const entries = await readdir(agentsDir(root), { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isDirectory() || registry[entry.name]) continue; // actif → intouchable
    // Dossier hors alphabet d'agent : pas un clone de Striart, jamais touché.
    if (!AGENT_NAME_RE.test(entry.name)) continue;
    const clonePath = path.join(agentsDir(root), entry.name);
    const stats = await dirStats(clonePath);
    const lastActivity = new Date(stats.latestMtimeMs).toISOString();
    if (stats.latestMtimeMs > cutoff) {
      clonesKept.push({ name: entry.name, lastActivity });
      continue;
    }
    // Hôte de terminal vivant : son shell a ce clone pour répertoire courant
    // (cleanClones et la reprise des suppressions inachevées le respectent
    // aussi). État d'hôte impossible à établir : présumé vivant (fail closed).
    const hostLive = await ptyHostStatus(root, entry.name).then(
      (status) => status.running,
      () => true,
    );
    if (hostLive) {
      clonesKept.push({ name: entry.name, lastActivity, reason: 'PTY_HOST_LIVE' });
      continue;
    }
    if (!dryRun) {
      const removal = await removeClone(root, entry.name, { wasActive: false });
      if ('cause' in removal) {
        failed.push({ kind: 'clone', name: entry.name, cause: removal.cause });
        continue;
      }
    }
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
    if (!dryRun) {
      try {
        await removeResolvedTicketDir(ticket.dir);
      } catch (error) {
        failed.push({ kind: 'ticket', name: ticket.id, cause: error.code ?? error.message });
        continue;
      }
    }
    freedBytes += stats.sizeBytes;
    ticketsRemoved.push({
      id: ticket.id,
      resolvedAt: new Date(resolvedStat.mtimeMs).toISOString(),
    });
  }

  // 3. Journaux de session et de terminal des agents qui ne sont plus actifs.
  const logs = await pruneAgentLogs(root, { registry, cutoff, dryRun, failed });
  freedBytes += logs.reduce((sum, log) => sum + log.freedBytes, 0);

  // 4. Registre d'usage des tokens (lot T) : fichiers journaliers plus vieux que
  //    tokens.retentionDays (indépendant de pruneDays : la comptabilité se
  //    garde plus longtemps que les clones) et entrées de cache expirées.
  const tokenSettings = resolveTokensSettings(config);
  const ledger = await pruneLedger(root, { retentionDays: tokenSettings.retentionDays, dryRun });
  for (const f of ledger.failed) failed.push({ kind: 'log', name: f.file, cause: f.cause });
  const cache = await sweepCache(root, { dryRun });
  const usageFreed = ledger.removed.reduce((sum, r) => sum + r.freedBytes, 0) + cache.freedBytes;
  freedBytes += usageFreed;

  if (failed.length > 0) {
    logger.warn({ failed }, 'Rétention : suppression(s) inachevée(s)');
  }
  return {
    retentionDays,
    dryRun,
    freedBytes,
    clones: { removed: clonesRemoved, kept: clonesKept },
    tickets: { removed: ticketsRemoved },
    logs: { removed: logs },
    usage: {
      retentionDays: tokenSettings.retentionDays,
      ledgerRemoved: ledger.removed,
      cacheEntriesRemoved: cache.removed,
      freedBytes: usageFreed,
    },
    failed,
  };
}

/**
 * Journaux par agent (`session-<agent>-<tâche>.log`, `pty-<agent>.log`)
 * inactifs depuis la rétention. Conservés quoi qu'il arrive : celui de la
 * tâche COURANTE d'un agent inscrit, et le journal de terminal d'un agent
 * inscrit ou dont l'hôte de pty vit. Le nom de fichier n'est jamais
 * interprété comme un chemin : seuls les noms de `logs/` sont considérés.
 */
async function pruneAgentLogs(
  root: string,
  {
    registry,
    cutoff,
    dryRun,
    failed,
  }: {
    registry: AgentRegistry;
    cutoff: number;
    dryRun: boolean;
    failed: Array<{ kind: 'clone' | 'ticket' | 'log'; name: string; cause: string }>;
  },
): Promise<Array<{ file: string; freedBytes: number; lastActivity: string }>> {
  const logsDir = path.join(striartDir(root), 'logs');
  const protectedNames = new Set();
  for (const [name, meta] of Object.entries(registry)) {
    protectedNames.add(`session-${name}-${meta.taskId}.log`);
    protectedNames.add(`pty-${name}.log`);
  }
  const removed = [];
  for (const entry of await readdir(logsDir, { withFileTypes: true }).catch(() => [])) {
    if (!entry.isFile() || !AGENT_LOG_RE.test(entry.name) || protectedNames.has(entry.name)) {
      continue;
    }
    const file = path.join(logsDir, entry.name);
    const stats = await stat(file).catch(() => null);
    if (!stats || stats.mtimeMs > cutoff) continue;
    if (entry.name.startsWith('pty-')) {
      const agent = entry.name.slice('pty-'.length, -'.log'.length);
      // Nom hors alphabet d'agent : pas un journal de Striart, jamais touché.
      if (!AGENT_NAME_RE.test(agent)) continue;
      // Hôte illisible : présumé vivant (fail closed, le journal reste).
      if ((await ptyHostStatus(root, agent).catch(() => ({ running: true }))).running) continue;
    }
    if (!dryRun) {
      try {
        await withTransientRetry(() => rm(file, { force: true }));
      } catch (error) {
        failed.push({ kind: 'log', name: entry.name, cause: error.code ?? error.message });
        continue;
      }
    }
    removed.push({
      file: entry.name,
      freedBytes: stats.size,
      lastActivity: new Date(stats.mtimeMs).toISOString(),
    });
  }
  return removed;
}

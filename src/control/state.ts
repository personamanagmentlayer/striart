/**
 * Collecte de l'état complet exposé au plan humain (Striart Control Protocol
 * `state.get` / `state.changed`, dashboard). Lecture seule, aucun verrou :
 * un instantané, pas une transaction — comme `striart status` (status.js),
 * dont il reprend les objets et ajoute ce que le pilotage demande (heatmap,
 * historique, permissions en attente, profils).
 *
 * Le hub (hub.ts) garantit qu'UNE SEULE collecte est en vol à la fois :
 * cette fonction ne doit jamais être appelée en boucle par un transport.
 */
import { formatBytes, listAgents } from '../clone.js';
import { presentAgent } from '../agent-view.ts';
import { listConflictTickets } from '../conflicts.js';
import { loadConfig } from '../config.js';
import { watchDaemonStatus } from '../daemon.js';
import { listMergeHistory } from '../history.js';
import { readLocks } from '../locks.js';
import { readMainSessionStatus } from '../main-session.js';
import { getQueueDashboard } from '../orchestrator.js';
import { overlapStatus } from '../overlap.ts';
import { idleStatus } from '../idle/status.ts';
import { acpHostStatus } from '../acp/host.ts';
import { listPendingHumanRequests } from '../permissions.ts';
import type { ElicitationRequest, PermissionRequest } from '../permissions.ts';
import { readQueue } from '../queue.js';
import { listProfiles } from '../session.js';
import { readState } from '../state.js';
import { sanitizeAgentText } from '../collab/message.ts';
import { listHumanReviews } from '../orchestration/human-review.ts';
import { listOrchestrationState } from '../orchestration/store.ts';

export const HEATMAP_TOP = 30;
export const HISTORY_LIMIT = 30;
/** Borne du diffstat d'une revue humaine (sortie git : texte non fiable). */
const DIFFSTAT_MAX_BYTES = 8_192;

/**
 * Revue humaine servie au plan humain : le diffstat vient de git sur le code
 * d'un agent (noms de fichiers arbitraires) — contrôles et surcharges
 * bidirectionnelles retirés, taille bornée. Le verdict a déjà été neutralisé
 * à l'écriture (parseVerdict).
 */
export function presentReview<T extends { diffstat?: string | null }>(review: T): T {
  return {
    ...review,
    diffstat: sanitizeAgentText(review.diffstat ?? '', DIFFSTAT_MAX_BYTES).text,
  };
}

export interface HeatmapEntry {
  file: string;
  agents: string[];
  queued: string[];
  conflicts: number;
  score: number;
}

/**
 * Fichiers les plus disputés : croise les verrous actifs, les prédictions
 * des tâches en attente et l'historique des tickets (résolus inclus).
 * Le lead voit en un coup d'œil où le couloir est étroit — AVANT que les
 * collisions ne deviennent des conflits.
 */
async function collectHeatmap(
  root: string,
  allTickets: Array<{ conflictedFiles?: string[] }>,
): Promise<HeatmapEntry[]> {
  const [locks, queue] = await Promise.all([readLocks(root), readQueue(root)]);

  const byFile = new Map<string, { agents: Set<string>; queued: Set<string>; conflicts: number }>();
  const entry = (file: string) => {
    const key = file.replaceAll('\\', '/');
    let value = byFile.get(key);
    if (!value) {
      value = { agents: new Set(), queued: new Set(), conflicts: 0 };
      byFile.set(key, value);
    }
    return value;
  };

  for (const [file, agent] of Object.entries(locks as Record<string, string>))
    entry(file).agents.add(agent);
  for (const task of queue)
    for (const file of task.predictedFiles ?? []) entry(file).queued.add(task.agent);
  for (const ticket of allTickets)
    for (const file of ticket.conflictedFiles ?? []) entry(file).conflicts += 1;

  return [...byFile.entries()]
    .map(([file, data]) => ({
      file,
      agents: [...data.agents],
      queued: [...data.queued],
      conflicts: data.conflicts,
      // Un conflit avéré pèse plus lourd qu'une simple prédiction.
      score: data.agents.size + data.queued.size + data.conflicts * 2,
    }))
    .filter((e) => e.score > 0)
    .sort((a, b) => b.score - a.score || a.file.localeCompare(b.file))
    .slice(0, HEATMAP_TOP);
}

/** État complet, sans les champs propres à l'instance (`instanceId`, `revision`). */
export async function collectControlState(root: string) {
  const [
    agents,
    tasks,
    tickets,
    allTickets,
    state,
    config,
    history,
    daemon,
    humanRequests,
    mainSession,
    orchestration,
    reviews,
  ] = await Promise.all([
    listAgents(root),
    getQueueDashboard({ root }),
    listConflictTickets(root),
    listConflictTickets(root, { includeResolved: true }),
    readState(root),
    loadConfig(root),
    listMergeHistory({ root, limit: HISTORY_LIMIT }),
    // Le watcher n'est jamais lancé automatiquement : sans lui, les commits
    // des agents supervisés ne sont pas mergés. L'état doit donc dire s'il
    // tourne, sinon l'utilisateur attend un merge qui ne viendra pas.
    watchDaemonStatus({ root }),
    // Demandes adressées à l'humain par les sessions ACP : permissions
    // (politique 'ask') et questions structurées (elicitations) — une seule
    // lecture de la boîte aux lettres, répartie ensuite.
    listPendingHumanRequests(root),
    // Session déclarée sur le repo principal (édition directe / agent hors clone).
    readMainSessionStatus(root),
    // Lot O : runs et groupes orchestrés (alive calculé), relectures humaines.
    listOrchestrationState(root),
    listHumanReviews(root),
  ]);
  const heatmap = await collectHeatmap(root, allTickets);
  // Chevauchements OBSERVÉS (filet à l'exécution) : git entre commits, borné, mis en cache
  // entre deux collectes (le hub recollecte à chaque changement). Ne throw jamais.
  const overlaps = await overlapStatus(root, config);
  // GC d'inactivité : balayage en lecture seule (aucune écriture, aucun événement). Ne throw jamais.
  const idle = await idleStatus(root, agents);
  const permissions = humanRequests.filter(
    (r): r is PermissionRequest => (r.kind ?? 'permission') === 'permission',
  );
  const elicitations = humanRequests.filter(
    (r): r is ElicitationRequest => r.kind === 'elicitation',
  );
  // Hôte de session ACP persistant : seulement pour les agents autonomes
  // (lecture de PID file + identité du process, en cache).
  const acpHosts = await Promise.all(
    agents.map((a) => (a.mode === 'autonomous' ? acpHostStatus(root, a.name) : null)),
  );

  // Le log du Test Gate n'est PAS embarqué dans l'état de liste : il est
  // servi à la demande par `ticket.get`. L'embarquer relirait chaque log sur
  // disque et le sérialiserait dans CHAQUE notification, pour des octets que
  // le client jette.
  return {
    agents: agents.map((a, i) => ({
      ...presentAgent(a),
      ...(acpHosts[i] ? { acpHost: acpHosts[i] } : {}),
      sizeHuman: a.sizeBytes != null ? formatBytes(a.sizeBytes) : null,
      // Registres antérieurs au mode autonome : pas de champ `mode` → supervisé.
      mode: a.mode ?? 'attended',
      profile: a.profile ?? null,
    })),
    tasks,
    tickets,
    heatmap,
    history,
    state,
    daemon,
    permissions,
    elicitations,
    mainSession,
    orchestration,
    reviews: reviews.map(presentReview),
    overlaps,
    idle,
    // Profils du mode autonome : clés d'env uniquement, jamais les valeurs
    // (même contrat que `striart profiles`).
    profiles: listProfiles(config),
    config: {
      testCommand: config.testCommand,
      targetBranch: config.targetBranch,
      semanticMerge: config.semanticMerge,
      autoRebase: config.autoRebase,
      autoPush: config.autoPush,
    },
    generatedAt: new Date().toISOString(),
  };
}

export type ControlStateBase = Awaited<ReturnType<typeof collectControlState>>;
export type ControlState = ControlStateBase & { instanceId: string; revision: number };

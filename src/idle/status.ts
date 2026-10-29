/**
 * Vue d'état du GC d'inactivité — champ ADDITIF de `striart status`, de
 * `striart_status` (MCP, lecture seule) et du Control Protocol (`state.get`).
 *
 * C'est un balayage `dryRun` (aucune écriture, aucun événement, aucune
 * fermeture) auquel on ajoute la date du dernier balayage réel. L'activité du
 * worktree, déjà mesurée par `listAgents`, est réutilisée (aucun second
 * parcours). Ne throw jamais : une panne se déclare (`available: false`), elle
 * ne casse pas la vue d'état.
 */
import { loadConfig } from '../config.ts';
import { readIdleState } from './state.ts';
import { sweepIdle } from './sweep.ts';
import type { SweepReport } from './sweep.ts';

export type IdleStatus =
  | ({ available: true; lastSweepAt: string | null } & Omit<
      SweepReport,
      'warned' | 'closed' | 'refused' | 'dryRun' | 'forced' | 'suspended'
    >)
  | { available: false; reason: string };

export async function idleStatus(
  root: string,
  agents: ReadonlyArray<{ name: string; lastActivity?: string | null }> = [],
): Promise<IdleStatus> {
  try {
    const config = await loadConfig(root);
    const worktreeMs = new Map<string, number>();
    for (const agent of agents) {
      const at = agent.lastActivity ? Date.parse(agent.lastActivity) : NaN;
      if (Number.isFinite(at)) worktreeMs.set(agent.name, at);
    }
    const report = await sweepIdle({ root, config, dryRun: true, worktreeMs });
    const lastSweepAt = await readIdleState(root).then(
      (state) => state.lastSweepAt,
      () => null,
    );
    return {
      available: true,
      lastSweepAt,
      generatedAt: report.generatedAt,
      enabled: report.enabled,
      action: report.action,
      closeAuthorized: report.closeAuthorized,
      authorizationError: report.authorizationError,
      holds: report.holds,
      thresholds: report.thresholds,
      agents: report.agents,
    };
  } catch (error) {
    return { available: false, reason: (error as { code?: string }).code ?? 'IDLE_STATUS_FAILED' };
  }
}

/**
 * Cellule d'inactivité d'un agent pour les vues terminal (`watch --ui`, `watch --plain`) : réduite
 * à ce qui s'affiche, QUANTIFIÉE à la minute (une durée exacte changerait à chaque rafraîchissement
 * et repeindrait l'écran pour rien).
 */
export interface IdleCell {
  stage: 'idle' | 'warned' | 'closable';
  minutes: number;
}

/** Agents à signaler (idle, avertis, fermables) ; GC désactivé ou indisponible = aucune cellule. */
export function idleCells(status: IdleStatus): Map<string, IdleCell> {
  const cells = new Map<string, IdleCell>();
  if (!status.available || !status.enabled) return cells;
  for (const agent of status.agents) {
    if (agent.stage !== 'idle' && agent.stage !== 'warned' && agent.stage !== 'closable') continue;
    if (typeof agent.idleMs !== 'number' || !Number.isFinite(agent.idleMs)) continue;
    cells.set(agent.agent, {
      stage: agent.stage,
      minutes: Math.max(0, Math.floor(agent.idleMs / 60_000)),
    });
  }
  return cells;
}

/** Période minimale entre deux évaluations du GC pour un affichage rafraîchi en boucle. */
export const IDLE_VIEW_TTL_MS = 15_000;

/**
 * Fournisseur mémoïsé de cellules pour une vue qui se rafraîchit souvent : le balayage `dryRun`
 * n'est refait qu'au bout de `ttlMs`. Ne throw jamais (un GC indisponible n'a pas de cellule).
 */
export function createIdleCellsProvider(
  root: string,
  ttlMs: number = IDLE_VIEW_TTL_MS,
  now: () => number = Date.now,
): (
  agents: ReadonlyArray<{ name: string; lastActivity?: string | null }>,
) => Promise<Map<string, IdleCell>> {
  let cached: { at: number; cells: Map<string, IdleCell> } | null = null;
  return async (agents) => {
    const at = now();
    if (cached && at - cached.at < ttlMs) return cached.cells;
    const cells = idleCells(await idleStatus(root, agents));
    cached = { at, cells };
    return cells;
  };
}

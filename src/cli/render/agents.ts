/**
 * Vocabulaire d'état d'un agent, partagé par `striart status` (tableau) et le
 * cockpit `watch --ui` : un état = un MOT (les noms de `types.d.ts` : ACTIVE,
 * MISSING, BROKEN, REMOVING, plus TICKET quand un ticket de conflit attend
 * l'humain) + un GLYPHE + un ton. La couleur ne porte jamais l'état seule.
 *
 * Fonction pure : aucune E/S, aucune décision métier (elle ne fait que
 * classer ce que le domaine a déjà établi).
 */
import type { Glyphs, Level } from '../output.ts';

/** Où ranger l'agent dans le cockpit : « À traiter · En cours · Inactifs ». */
export type AgentGroup = 'attention' | 'running' | 'idle';

export type StateGlyph = 'active' | 'idle' | 'error' | 'warn';

export interface AgentStateInput {
  status: string;
  session?: { state: string } | null;
  pendingCommits?: number;
}

export interface AgentStateView {
  /** Mot affiché (un nom de statut de `types.d.ts`, ou `ticketLabel`). */
  label: string;
  level: Level;
  glyph: StateGlyph;
  group: AgentGroup;
}

/**
 * ACTIVE avec session vivante ou travail à merger → « en cours » ; ACTIVE
 * sans rien → « inactif » (atténué) ; ticket ouvert, clone MISSING/BROKEN
 * → « à traiter » (erreur) ; REMOVING → avertissement.
 */
export function agentStateView(
  agent: AgentStateInput,
  hasOpenTicket: boolean,
  ticketLabel: string,
): AgentStateView {
  if (agent.status === 'MISSING' || agent.status === 'BROKEN') {
    return { label: agent.status, level: 'error', glyph: 'error', group: 'attention' };
  }
  if (agent.status === 'REMOVING') {
    return { label: agent.status, level: 'warn', glyph: 'warn', group: 'attention' };
  }
  if (hasOpenTicket) {
    return { label: ticketLabel, level: 'error', glyph: 'error', group: 'attention' };
  }
  const sessionState = agent.session?.state ?? 'idle';
  const working = sessionState !== 'idle' || (agent.pendingCommits ?? 0) > 0;
  return working
    ? { label: agent.status, level: 'ok', glyph: 'active', group: 'running' }
    : { label: agent.status, level: 'skip', glyph: 'idle', group: 'idle' };
}

export const GROUP_ORDER: readonly AgentGroup[] = ['attention', 'running', 'idle'];

/** Le caractère du glyphe d'état, dans le jeu Unicode ou ASCII courant. */
export function stateGlyphChar(glyphs: Glyphs, glyph: StateGlyph): string {
  switch (glyph) {
    case 'active':
      return glyphs.active;
    case 'idle':
      return glyphs.idle;
    case 'error':
      return glyphs.error;
    case 'warn':
      return glyphs.warn;
  }
}

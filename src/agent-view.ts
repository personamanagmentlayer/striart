/**
 * Présentation d'un agent dont le clone est en cours de suppression
 * (`removing: true` au registre, posé par `removeAgentClone`).
 *
 * `listAgents` calcule ACTIVE / MISSING / BROKEN d'après le disque — pour
 * un clone à moitié supprimé, c'est du bruit (BROKEN ou MISSING à tort, voire
 * ACTIVE tant que le dossier tient). Toutes les surfaces d'AFFICHAGE (CLI
 * status, dashboard, Control Protocol, MCP) passent par ce point unique pour
 * montrer l'état dédié `REMOVING`. Le domaine, lui, continue de lire
 * `removing` sur le registre : ceci ne change aucune décision.
 */
export interface AgentLike {
  status: string;
  removing?: boolean;
}

export function presentAgent<T extends AgentLike>(agent: T): T {
  return agent.removing === true ? { ...agent, status: 'REMOVING' } : agent;
}

export function presentAgents<T extends AgentLike>(agents: readonly T[]): T[] {
  return agents.map(presentAgent);
}

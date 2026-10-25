/**
 * Identifiant de ticket de conflit — source UNIQUE (CLI, complétion, MCP).
 *
 * Un id est le nom du dossier du ticket sous `.striart/conflicts/`
 * (`<agent>-<sha>`) : même alphabet que les noms d'agent, borné. Il n'est
 * jamais concaténé dans un chemin — les consommateurs le cherchent dans le
 * listing des tickets — mais il est validé positivement à chaque entrée.
 *
 * Deux formes du MÊME langage : le motif en chaîne pour un `pattern` de JSON
 * Schema (qui ne porte pas de drapeaux, d'où la casse explicite) et la
 * RegExp qui en est dérivée. Aucune dépendance : importable depuis la CLI
 * comme depuis le domaine.
 */
export const TICKET_ID_PATTERN = '^[A-Za-z0-9][A-Za-z0-9_-]{0,80}$';
export const TICKET_ID_RE = new RegExp(TICKET_ID_PATTERN);

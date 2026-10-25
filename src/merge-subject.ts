/**
 * Format du sujet des commits de merge Striart — source unique.
 *
 * Le graphe Git est la source de vérité de l'historique (`history.js`) et de
 * `striart rollback` : ces deux lecteurs doivent reconnaître exactement ce que
 * les deux producteurs (`mergeAgentCommit`, `applyTicketResolution`) écrivent.
 * Format produit, inchangé depuis la v0.1 pour rester lisible sur les
 * historiques existants :
 *
 *   merge(striart): <agent> <branche> (<sha8 de l'agent>)[ <note>]
 *
 * où `<note>` vaut `[fusion sémantique: f1, f2]` ou
 * `[résolution manuelle: <ticketId>]`.
 */

export type MergeResolution = 'auto' | 'semantic' | 'manual';

export interface MergeSubject {
  agent: string;
  branch: string;
  /** Les 8 premiers caractères du commit de l'agent qui a été mergé. */
  agentSha: string;
  resolution: MergeResolution;
  /** Fichiers résolus par la fusion sémantique (vide sinon). */
  semanticFiles: string[];
  /** Ticket dont la résolution humaine a produit ce merge (null sinon). */
  ticketId: string | null;
}

const PREFIX = 'merge(striart): ';
const SEMANTIC_NOTE = 'fusion sémantique';
const MANUAL_NOTE = 'résolution manuelle';

// La note est capturée jusqu'au DERNIER `]` : un chemin de fichier peut
// contenir des crochets, et une capture `[^\]]+` ferait alors disparaître le
// merge de l'historique sans aucun signal.
const SUBJECT_RE = /^merge\(striart\): (\S+) (\S+) \(([0-9a-f]{8})\)(?: \[([^:\]]+): (.+)\])?$/;
const REVERT_RE = /^Revert "(.*)"$/;

export function formatMergeSubject({
  agent,
  branch,
  agentSha,
  semanticFiles = [],
  ticketId = null,
}: {
  agent: string;
  branch: string;
  agentSha: string;
  semanticFiles?: string[];
  ticketId?: string | null;
}): string {
  const head = `${PREFIX}${agent} ${branch} (${agentSha.slice(0, 8)})`;
  if (ticketId) return `${head} [${MANUAL_NOTE}: ${ticketId}]`;
  if (semanticFiles.length > 0) return `${head} [${SEMANTIC_NOTE}: ${semanticFiles.join(', ')}]`;
  return head;
}

/** Analyse un sujet de commit ; null s'il ne s'agit pas d'un merge Striart. */
export function parseMergeSubject(subject: string): MergeSubject | null {
  const match = SUBJECT_RE.exec(subject);
  if (!match) return null;
  const [, agent, branch, agentSha, noteKind, noteValue] = match;
  const base = { agent, branch, agentSha };
  if (noteKind === undefined) {
    return { ...base, resolution: 'auto', semanticFiles: [], ticketId: null };
  }
  if (noteKind === SEMANTIC_NOTE) {
    return {
      ...base,
      resolution: 'semantic',
      semanticFiles: noteValue.split(',').map((file) => file.trim()),
      ticketId: null,
    };
  }
  if (noteKind === MANUAL_NOTE) {
    return { ...base, resolution: 'manual', semanticFiles: [], ticketId: noteValue.trim() };
  }
  // Note inconnue (version future de Striart) : le merge reste reconnu, sa
  // nature exacte n'est pas devinée.
  return { ...base, resolution: 'auto', semanticFiles: [], ticketId: null };
}

/**
 * Analyse le sujet d'un `git revert` d'un merge Striart (produit par
 * `striart rollback` sur un merge déjà poussé) ; null sinon.
 */
export function parseRevertSubject(subject: string): MergeSubject | null {
  const match = REVERT_RE.exec(subject);
  return match ? parseMergeSubject(match[1]) : null;
}

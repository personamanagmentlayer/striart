/**
 * Historique des opérations Striart, reconstruit depuis le graphe Git —
 * la source de vérité, pas un journal parallèle qui pourrait diverger.
 * Les commits `merge(striart): …` (format : `merge-subject.ts`, source
 * unique partagée avec les producteurs et `striart rollback`) et leurs
 * éventuels reverts sont parsés et enrichis.
 */
import { simpleGit } from 'simple-git';
import { parseMergeSubject, parseRevertSubject } from './merge-subject.ts';

const FIELD_SEP = String.fromCharCode(9);

/**
 * `resolution` dit comment un conflit éventuel a été tranché : 'auto' (git
 * seul), 'semantic' (fusion LLM, fichiers dans `semanticFiles`) ou 'manual'
 * (`striart resolve --apply`, ticket dans `ticketId`).
 * @typedef {{
 *   sha: string, date: string, type: 'merge'|'rollback',
 *   agent: string, branch?: string, agentSha?: string,
 *   resolution: import('./merge-subject.ts').MergeResolution,
 *   semantic: boolean, semanticFiles: string[], ticketId: string|null
 * }} HistoryEntry
 */

/**
 * Liste les merges (et rollbacks par revert) Striart, du plus récent au
 * plus ancien.
 * @param {{root: string, limit?: number}} params
 * @returns {Promise<HistoryEntry[]>}
 */
export async function listMergeHistory({ root, limit = 30 }) {
  const git = simpleGit(root);
  let raw;
  try {
    raw = await git.raw([
      'log',
      '--max-count',
      String(Math.max(limit * 5, 100)),
      `--format=%H${FIELD_SEP}%P${FIELD_SEP}%aI${FIELD_SEP}%s`,
    ]);
  } catch {
    return []; // repo sans commit
  }

  const entries = [];
  for (const line of raw.split('\n')) {
    if (entries.length >= limit) break;
    const [sha, parents, date, ...subjectParts] = line.split(FIELD_SEP);
    if (!sha || subjectParts.length === 0) continue;
    const subject = subjectParts.join(FIELD_SEP);

    // Le sujet est forgeable (n'importe quel commit d'agent peut le porter) :
    // seul un vrai commit de merge — au moins deux parents — est un merge Striart.
    const merge =
      (parents ?? '').trim().split(/\s+/).filter(Boolean).length >= 2
        ? parseMergeSubject(subject)
        : null;
    if (merge) {
      entries.push({
        sha,
        date,
        type: 'merge',
        agent: merge.agent,
        branch: merge.branch,
        agentSha: merge.agentSha,
        resolution: merge.resolution,
        semantic: merge.resolution === 'semantic',
        semanticFiles: merge.semanticFiles,
        ticketId: merge.ticketId,
      });
      continue;
    }
    const revert = parseRevertSubject(subject);
    if (revert) {
      entries.push({
        sha,
        date,
        type: 'rollback',
        agent: revert.agent,
        resolution: revert.resolution,
        semantic: false,
        semanticFiles: [],
        ticketId: null,
      });
    }
  }
  return entries;
}

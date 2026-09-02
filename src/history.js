/**
 * Historique des opérations Striart, reconstruit depuis le graphe Git —
 * la source de vérité, pas un journal parallèle qui pourrait diverger.
 * Les commits `merge(striart): <agent> <branche> (<sha8>)[ note]` et leurs
 * éventuels reverts (striart rollback) sont parsés et enrichis.
 */
import { simpleGit } from 'simple-git';

const FIELD_SEP = String.fromCharCode(9);
const MERGE_RE =
  /^merge\(striart\): (\S+) (\S+) \(([0-9a-f]{8})\)(?: \[fusion sémantique: ([^\]]+)\])?$/;
const REVERT_RE = /^Revert "merge\(striart\): (\S+) /;

/**
 * @typedef {{
 *   sha: string, date: string, type: 'merge'|'rollback',
 *   agent: string, branch?: string, agentSha?: string,
 *   semantic: boolean, semanticFiles: string[]
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
      `--format=%H${FIELD_SEP}%aI${FIELD_SEP}%s`,
    ]);
  } catch {
    return []; // repo sans commit
  }

  const entries = [];
  for (const line of raw.split('\n')) {
    if (entries.length >= limit) break;
    const [sha, date, ...subjectParts] = line.split(FIELD_SEP);
    if (!sha || subjectParts.length === 0) continue;
    const subject = subjectParts.join(FIELD_SEP);

    const merge = subject.match(MERGE_RE);
    if (merge) {
      const [, agent, branch, agentSha, semanticFiles] = merge;
      entries.push({
        sha,
        date,
        type: 'merge',
        agent,
        branch,
        agentSha,
        semantic: Boolean(semanticFiles),
        semanticFiles: semanticFiles ? semanticFiles.split(',').map((f) => f.trim()) : [],
      });
      continue;
    }
    const revert = subject.match(REVERT_RE);
    if (revert) {
      entries.push({
        sha,
        date,
        type: 'rollback',
        agent: revert[1],
        semantic: false,
        semanticFiles: [],
      });
    }
  }
  return entries;
}

/**
 * Verdict structuré d'un relecteur (mode review, lot O) — fonctions PURES.
 *
 * Un verdict est une SORTIE D'AGENT, donc non fiable : validation positive
 * (clés connues, valeurs dans la liste, chemins relatifs sûrs, bornes de
 * taille), neutralisation du texte libre. Un verdict douteux n'approuve
 * jamais rien : l'appelant le traite comme absent (nouvelle demande, puis
 * fail closed). Et un verdict valide ne fait que PROPOSER — le merge reste
 * soumis au Test Gate.
 */
import { randomBytes } from 'node:crypto';
import { isSafeProjectPath, normalizeFilePath } from '../router.ts';
import { sanitizeAgentText } from '../collab/message.ts';
import type { ReviewComment, ReviewQuorum, ReviewVerdict, ReviewVerdictValue } from '../types.js';

export const VERDICT_VALUES: readonly ReviewVerdictValue[] = Object.freeze([
  'approve',
  'request-changes',
  'reject',
]);
const SEVERITIES = ['blocker', 'major', 'minor', 'info'] as const;
export const MAX_REVIEW_COMMENTS = 50;

export type VerdictParse = { ok: true; verdict: ReviewVerdict } | { ok: false; reason: string };

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Valide un verdict désérialisé. `maxBytes` borne chaque texte libre
 * (résumé, remarque) — collab.maxBodyBytes.
 */
export function parseVerdict(raw: unknown, maxBytes: number): VerdictParse {
  if (!isObject(raw)) return { ok: false, reason: 'NOT_AN_OBJECT' };
  if (Object.keys(raw).some((k) => !['verdict', 'summary', 'comments'].includes(k))) {
    return { ok: false, reason: 'UNKNOWN_KEY' };
  }
  if (
    typeof raw.verdict !== 'string' ||
    !(VERDICT_VALUES as readonly string[]).includes(raw.verdict)
  ) {
    return { ok: false, reason: 'VERDICT_VALUE_INVALID' };
  }
  if (raw.summary !== undefined && typeof raw.summary !== 'string') {
    return { ok: false, reason: 'SUMMARY_INVALID' };
  }
  const comments: ReviewComment[] = [];
  if (raw.comments !== undefined) {
    if (!Array.isArray(raw.comments)) return { ok: false, reason: 'COMMENTS_INVALID' };
    if (raw.comments.length > MAX_REVIEW_COMMENTS)
      return { ok: false, reason: 'TOO_MANY_COMMENTS' };
    for (const c of raw.comments) {
      const parsed = parseComment(c, maxBytes);
      if (typeof parsed === 'string') return { ok: false, reason: parsed };
      comments.push(parsed);
    }
  }
  return {
    ok: true,
    verdict: {
      verdict: raw.verdict as ReviewVerdictValue,
      summary: sanitizeAgentText(typeof raw.summary === 'string' ? raw.summary : '', maxBytes).text,
      comments,
    },
  };
}

function parseComment(c: unknown, maxBytes: number): ReviewComment | string {
  if (!isObject(c)) return 'COMMENTS_INVALID';
  if (Object.keys(c).some((k) => !['file', 'line', 'severity', 'body'].includes(k))) {
    return 'COMMENTS_INVALID';
  }
  if (typeof c.body !== 'string' || c.body.trim().length === 0) return 'COMMENTS_INVALID';
  let file: string | null = null;
  if (c.file !== undefined && c.file !== null) {
    if (typeof c.file !== 'string') return 'COMMENTS_INVALID';
    file = normalizeFilePath(c.file);
    if (!isSafeProjectPath(file)) return 'COMMENT_PATH_UNSAFE';
  }
  let line: number | null = null;
  if (c.line !== undefined && c.line !== null) {
    if (!Number.isInteger(c.line) || (c.line as number) < 1) return 'COMMENTS_INVALID';
    line = c.line as number;
  }
  const severity = c.severity ?? 'info';
  if (typeof severity !== 'string' || !(SEVERITIES as readonly string[]).includes(severity)) {
    return 'COMMENTS_INVALID';
  }
  return {
    file,
    line,
    severity: severity as ReviewComment['severity'],
    body: sanitizeAgentText(c.body, maxBytes).text,
  };
}

/**
 * Contenu du DERNIER bloc ```<tag> … ``` d'un texte (log de session). Le
 * dernier, parce qu'un agent qui recopie son prompt reproduit l'exemple
 * fourni AVANT de donner sa réponse.
 */
export function lastFencedBlock(text: string, tag: string): string | null {
  // Balayage LINÉAIRE (S-M3) : l'ancienne RegExp à quantificateur paresseux
  // rescannait jusqu'à la fin du journal pour CHAQUE ouverture non fermée
  // (O(n * ouvertures), journal fourni par l'agent). Ici, dès qu'aucune
  // fermeture ne suit, aucune ouverture ultérieure ne peut en trouver.
  const open = '```' + tag;
  let position = 0;
  let last: string | null = null;
  for (;;) {
    const start = text.indexOf(open, position);
    if (start === -1) break;
    let i = start + open.length;
    while (text[i] === ' ' || text[i] === '\t') i += 1;
    if (text[i] === '\r') i += 1;
    if (text[i] !== '\n') {
      // Pas une ligne d'ouverture (balise plus longue, texte à la suite).
      position = start + 1;
      continue;
    }
    i += 1;
    const close = text.indexOf('```', i);
    if (close === -1) break;
    last = text.slice(i, close).replace(/\r?\n$/, '');
    position = close + 3;
  }
  return last;
}

/**
 * Jeton propre à UN tour de relecture : 128 bits aléatoires que seul le prompt
 * du relecteur contient. La balise attendue dans le journal est
 * `striart-verdict-<jeton>`.
 */
export function newVerdictToken(): string {
  return randomBytes(16).toString('hex');
}

/**
 * Verdict lu dans le journal de session. Le journal contient AUSSI les sorties
 * d'outils (contenu de fichiers écrits par l'auteur) : un bloc `striart-verdict`
 * nu y est forgeable. Seul un bloc portant le jeton du tour — que l'auteur ne
 * peut pas connaître — est accepté ; sans jeton valide, rien (fail closed).
 */
export function parseVerdictFromLog(text: string, maxBytes: number, token: string): VerdictParse {
  if (!/^[0-9a-f]{32}$/.test(token)) return { ok: false, reason: 'MISSING' };
  const block = lastFencedBlock(text, `striart-verdict-${token}`);
  if (block === null) return { ok: false, reason: 'MISSING' };
  let raw: unknown;
  try {
    raw = JSON.parse(block);
  } catch {
    return { ok: false, reason: 'NOT_JSON' };
  }
  return parseVerdict(raw, maxBytes);
}

/**
 * Agrège les verdicts d'un tour selon le quorum :
 *  - all      : approuvé si tous approuvent ; rejeté si un seul rejette ;
 *  - majority : approuvé si plus de la moitié approuve ; rejeté si plus de la
 *               moitié rejette ;
 *  - any      : approuvé si un seul approuve ; rejeté si tous rejettent.
 * Sinon : corrections demandées.
 */
export function aggregateVerdicts(
  values: ReviewVerdictValue[],
  quorum: ReviewQuorum,
): ReviewVerdictValue {
  const n = values.length;
  const approvals = values.filter((v) => v === 'approve').length;
  const rejects = values.filter((v) => v === 'reject').length;
  if (n === 0) return 'request-changes';
  if (quorum === 'all') {
    if (approvals === n) return 'approve';
    if (rejects > 0) return 'reject';
    return 'request-changes';
  }
  if (quorum === 'majority') {
    if (approvals > n / 2) return 'approve';
    if (rejects > n / 2) return 'reject';
    return 'request-changes';
  }
  if (approvals > 0) return 'approve';
  if (rejects === n) return 'reject';
  return 'request-changes';
}

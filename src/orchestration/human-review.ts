/**
 * Relecture HUMAINE d'un nœud `review` (lot O) — boîte aux lettres disque
 * `.striart/reviews/<id>.json`.
 *
 * Le process qui orchestre écrit la demande (PENDING) et attend ; l'humain
 * tranche depuis un autre process (`striart review <id> --approve|…`, et
 * demain le dashboard / Control Protocol — lot I8). Même discipline que
 * `permissions.ts`, avec un cycle de vie propre (décision O3) : verdict
 * structuré avec remarques, auditables après coup (le fichier est conservé,
 * rétention bornée), délai FAIL CLOSED (`review.humanTimeoutMs` → EXPIRED,
 * jamais une approbation implicite).
 *
 * La réponse est une compare-and-swap sous le verrou d'état : seule une
 * demande PENDING, non expirée, dont l'attente est vivante, peut être
 * tranchée — et une seule fois.
 */
import { randomBytes } from 'node:crypto';
import { mkdir, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { StriartError } from '../errors.js';
import { UNCHANGED, readJson, updateJsonLocked } from '../json-file.js';
import { striartDir } from '../paths.js';
import { isProcessAlive } from '../process-tree.js';
import type { HumanReviewRequest, ReviewVerdict } from '../types.js';
import { parseVerdict } from './verdict.ts';
import { sleepAbortable } from './wait.ts';

export const REVIEW_ID_RE = /^rev-[0-9a-f]{12}$/;
/** Texte humain : borné comme un message de collaboration par défaut. */
const HUMAN_TEXT_MAX_BYTES = 16_384;

export function reviewsDir(root: string): string {
  return path.join(striartDir(root), 'reviews');
}

function reviewPath(root: string, id: string): string {
  if (!REVIEW_ID_RE.test(id)) throw unknownReview(id);
  return path.join(reviewsDir(root), `${id}.json`);
}

export async function createHumanReview(
  root: string,
  init: Omit<
    HumanReviewRequest,
    'id' | 'status' | 'verdict' | 'createdAt' | 'answeredAt' | 'expiresAt' | 'pid'
  >,
  { timeoutMs, keep }: { timeoutMs: number; keep: number },
): Promise<HumanReviewRequest> {
  await mkdir(reviewsDir(root), { recursive: true });
  await pruneAnswered(root, keep);
  const created = Date.now();
  const request: HumanReviewRequest = {
    ...init,
    id: `rev-${randomBytes(6).toString('hex')}`,
    status: 'PENDING',
    verdict: null,
    createdAt: new Date(created).toISOString(),
    answeredAt: null,
    expiresAt: new Date(created + timeoutMs).toISOString(),
    pid: process.pid,
  };
  await updateJsonLocked(
    reviewPath(root, request.id),
    { fallback: null, code: 'REVIEW_CORRUPT' },
    () => request,
  );
  return request;
}

async function readReview(root: string, id: string): Promise<HumanReviewRequest | null> {
  return (await readJson(reviewPath(root, id), {
    fallback: null,
    code: 'REVIEW_CORRUPT',
  })) as HumanReviewRequest | null;
}

/** Marque EXPIRED une demande encore PENDING (délai, arrêt) — jamais une réponse déjà donnée. */
async function expire(root: string, id: string): Promise<HumanReviewRequest | null> {
  return (await updateJsonLocked(
    reviewPath(root, id),
    { fallback: null as HumanReviewRequest | null, code: 'REVIEW_CORRUPT' },
    (r: HumanReviewRequest | null) =>
      r && r.status === 'PENDING' ? { ...r, status: 'EXPIRED' } : UNCHANGED,
  )) as HumanReviewRequest | null;
}

/**
 * Attend la réponse. Délai dépassé ou arrêt demandé → EXPIRED (fail closed) :
 * la demande ne peut plus être approuvée après coup.
 */
export async function awaitHumanReview(
  root: string,
  id: string,
  { intervalMs, signal }: { intervalMs: number; signal: AbortSignal | null },
): Promise<
  { status: 'ANSWERED'; verdict: ReviewVerdict } | { status: 'EXPIRED' } | { status: 'ABORTED' }
> {
  for (;;) {
    const r = await readReview(root, id);
    if (!r) return { status: 'EXPIRED' };
    if (r.status === 'ANSWERED' && r.verdict) return { status: 'ANSWERED', verdict: r.verdict };
    if (r.status === 'EXPIRED') return { status: 'EXPIRED' };
    if (Date.now() >= Date.parse(r.expiresAt)) {
      const after = await expire(root, id);
      if (after?.status === 'ANSWERED' && after.verdict)
        return { status: 'ANSWERED', verdict: after.verdict };
      return { status: 'EXPIRED' };
    }
    const left = Date.parse(r.expiresAt) - Date.now();
    if (!(await sleepAbortable(Math.max(50, Math.min(intervalMs, left)), signal))) {
      const after = await expire(root, id);
      if (after?.status === 'ANSWERED' && after.verdict)
        return { status: 'ANSWERED', verdict: after.verdict };
      return { status: 'ABORTED' };
    }
  }
}

/** Toutes les demandes, les plus récentes d'abord ; `alive` = l'attente vit encore. */
export async function listHumanReviews(
  root: string,
): Promise<Array<HumanReviewRequest & { alive: boolean }>> {
  const names = await readdir(reviewsDir(root)).catch(() => [] as string[]);
  const out: Array<HumanReviewRequest & { alive: boolean }> = [];
  for (const name of names) {
    const id = name.endsWith('.json') ? name.slice(0, -5) : '';
    if (!REVIEW_ID_RE.test(id)) continue;
    const r = await readReview(root, id).catch(() => null);
    if (r) out.push({ ...r, alive: r.status === 'PENDING' && isProcessAlive(r.pid) });
  }
  return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/**
 * Réponse humaine. Le verdict est validé positivement comme celui d'un agent
 * (même schéma, mêmes bornes) : un humain peut se tromper de champ, et le
 * texte est réaffiché ensuite à un agent.
 */
export async function answerHumanReview(
  root: string,
  id: string,
  input: unknown,
): Promise<HumanReviewRequest> {
  const parsed = parseVerdict(input, HUMAN_TEXT_MAX_BYTES);
  if (parsed.ok === false) {
    throw new StriartError(`Invalid review verdict (${parsed.reason}).`, {
      code: 'REVIEW_VERDICT_INVALID',
      hint: 'striart review <id> --approve',
      details: { reason: parsed.reason },
    });
  }
  let refusal = null as string | null;
  const after = (await updateJsonLocked(
    reviewPath(root, id),
    { fallback: null as HumanReviewRequest | null, code: 'REVIEW_CORRUPT' },
    (r: HumanReviewRequest | null) => {
      if (!r) throw unknownReview(id);
      if (r.status !== 'PENDING') {
        refusal = r.status;
        return UNCHANGED;
      }
      if (Date.now() >= Date.parse(r.expiresAt)) {
        refusal = 'EXPIRED';
        return { ...r, status: 'EXPIRED' };
      }
      // Personne n'attend plus ce verdict (process orchestrateur mort) : le
      // donner laisserait croire qu'il sera appliqué.
      if (!isProcessAlive(r.pid)) {
        refusal = 'WAITER_GONE';
        return { ...r, status: 'EXPIRED' };
      }
      return {
        ...r,
        status: 'ANSWERED',
        verdict: parsed.verdict,
        answeredAt: new Date().toISOString(),
      };
    },
  )) as HumanReviewRequest | null;
  if (refusal || !after) {
    throw new StriartError(
      `Review ${id} is not pending (${refusal ?? 'UNKNOWN'}): its verdict can no longer be given.`,
      {
        code: 'REVIEW_NOT_PENDING',
        hint: 'striart review',
        details: { reviewId: id, reason: refusal ?? 'UNKNOWN' },
      },
    );
  }
  return after;
}

async function pruneAnswered(root: string, keep: number): Promise<void> {
  const done = (await listHumanReviews(root)).filter((r) => r.status !== 'PENDING');
  for (const old of done.slice(Math.max(0, keep - 1))) {
    await rm(path.join(reviewsDir(root), `${old.id}.json`), { force: true }).catch(() => {});
  }
}

function unknownReview(id: string): StriartError {
  return new StriartError(`Unknown review request "${String(id).slice(0, 40)}".`, {
    code: 'REVIEW_UNKNOWN',
    hint: 'striart review',
    details: { reviewId: String(id).slice(0, 40) },
  });
}

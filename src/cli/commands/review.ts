/**
 * `striart review [id] [--approve | --request-changes | --reject] [--comment]`
 * (lot O) : verdicts des relecteurs HUMAINS des tâches `review`. Sans id :
 * liste des demandes (en attente d'abord). Le verdict est validé comme celui
 * d'un agent ; il ne fait que permettre la tentative de merge — le Test Gate
 * décide toujours.
 */
import { assertInitialized } from '../../clone.ts';
import { StriartError } from '../../errors.ts';
import { answerHumanReview, listHumanReviews } from '../../orchestration/human-review.ts';
import type { HumanReviewRequest, ReviewVerdictValue } from '../../types.js';
import type { CommandModule } from '../context.ts';

export interface ReviewInput {
  id: string | null;
  verdict: ReviewVerdictValue | null;
  comment: string | null;
}

type Listed = HumanReviewRequest & { alive: boolean };

export type ReviewData =
  { action: 'list'; reviews: Listed[] } | { action: 'answer'; review: HumanReviewRequest };

export const review: CommandModule<ReviewInput, ReviewData> = {
  async execute(ctx, input) {
    const root = await ctx.repoRoot();
    await assertInitialized(root);
    if (!input.verdict) {
      const all = await listHumanReviews(root);
      const reviews = (input.id ? all.filter((r) => r.id === input.id) : all).sort(
        (a, b) => Number(b.status === 'PENDING') - Number(a.status === 'PENDING'),
      );
      return { data: { action: 'list', reviews }, outcome: 'ok' };
    }
    if (!input.id) {
      throw new StriartError(ctx.m.review.idRequired, {
        code: 'REVIEW_VERDICT_INVALID',
        hint: 'striart review',
        details: { reason: 'ID_REQUIRED' },
      });
    }
    if (input.verdict === 'request-changes' && !input.comment?.trim()) {
      throw new StriartError(ctx.m.review.commentRequired, {
        code: 'REVIEW_VERDICT_INVALID',
        hint: `striart review ${input.id} --request-changes --comment "…"`,
        details: { reason: 'COMMENT_REQUIRED' },
      });
    }
    const answered = await answerHumanReview(root, input.id, {
      verdict: input.verdict,
      summary: input.comment ?? '',
      comments: [],
    });
    return { data: { action: 'answer', review: answered }, outcome: 'ok' };
  },

  render(ctx, { data }) {
    const { out, m } = ctx;
    if (data.action === 'answer') {
      out.line('ok', m.review.answered(data.review.id, data.review.verdict?.verdict ?? '?'));
      out.detail(m.review.gateStillDecides);
      return;
    }
    if (data.reviews.length === 0) {
      out.line('info', m.review.empty);
      return;
    }
    out.table<Listed>(
      [
        { key: 'id', header: m.review.colId, value: (r) => r.id, priority: 10 },
        { key: 'agent', header: m.review.colAgent, value: (r) => r.agent, priority: 9 },
        { key: 'reviewer', header: m.review.colReviewer, value: (r) => r.reviewer, priority: 7 },
        { key: 'round', header: m.review.colRound, value: (r) => String(r.round), priority: 6 },
        {
          key: 'state',
          header: m.review.colState,
          value: (r) => m.review.state(r.status, r.alive),
          style: (text, r) => out.style(r.status === 'PENDING' && r.alive ? 'warn' : 'muted', text),
          priority: 8,
        },
        {
          key: 'since',
          header: m.review.colSince,
          value: (r) => out.since(r.createdAt),
          priority: 5,
        },
      ],
      data.reviews,
    );
    for (const r of data.reviews.filter((x) => x.status === 'PENDING' && x.alive)) {
      if (r.diffstat) out.detail(`${r.id}: ${out.untrusted(r.diffstat.split('\n').at(-1) ?? '')}`);
    }
    if (data.reviews.some((r) => r.status === 'PENDING' && r.alive)) out.hint(m.review.pendingHint);
  },
};

/**
 * Mode `review` (lot O, décision O3) : un auteur produit, un ou plusieurs
 * relecteurs relisent son diff AVANT tout merge, verdict structuré, boucle
 * de corrections bornée. Le Test Gate reste l'autorité finale : une
 * approbation ne fait que permettre la tentative de merge.
 *
 * Le relecteur travaille DANS le clone de l'auteur, à son tour (un seul
 * écrivain à la fois), en lecture seule vérifiée par empreinte : il voit le
 * vrai arbre, peut lancer les tests, et n'impose aucun second clone à
 * supprimer de force. Un relecteur humain passe par la boîte aux lettres
 * `.striart/reviews/` (`striart review`), délai fail closed.
 */
import { collabRulesInSessionInstructions } from '../agents/instructions.ts';
import { cloneGit } from '../clone.js';
import { DEFAULT_PROFILE, resolveAgentProfile } from '../session.js';
import {
  closeCollabGroup,
  createCollabGroup,
  messagesForRoles,
  readCollabGroup,
  setActiveRoles,
} from '../collab/channel.ts';
import type {
  AgentCollabFiles,
  AgentCollabInfo,
  OrchestrationNodeResult,
  OrchestrationStatus,
  PlanNode,
  ReviewVerdict,
  ReviewVerdictRecord,
} from '../types.js';
import { composeTurnPrompt, feedbackItems, messageItems } from './briefing.ts';
import { awaitHumanReview, createHumanReview } from './human-review.ts';
import { nodeResult } from './result.ts';
import { createGroupState, finishGroupState, updateGroupState } from './store.ts';
import {
  branchTip,
  emit,
  finalizeClone,
  readSessionLog,
  report,
  runTurn,
  startOrchestratedClone,
  timeoutFor,
  turnFailureStatus,
  publishAgentCollab,
  withGroupSession,
} from './unit.ts';
import type { AgentInfo, OrchestrationContext } from './unit.ts';
import {
  aggregateVerdicts,
  newVerdictToken,
  parseVerdict,
  parseVerdictFromLog,
} from './verdict.ts';

type ReviewNode = Extract<PlanNode, { kind: 'review' }>;

export async function runReviewNode(
  ctx: OrchestrationContext,
  node: ReviewNode,
): Promise<OrchestrationNodeResult> {
  const authorKey = node.author.profile ?? DEFAULT_PROFILE;
  const authorProfile = resolveAgentProfile(ctx.config, authorKey);
  const reviewers = node.reviewers.map((r) => ({
    ...r,
    profileKey: r.kind === 'agent' ? (r.profile ?? DEFAULT_PROFILE) : null,
  }));
  const maxRounds = node.maxRounds ?? ctx.settings.review.maxRounds;
  const quorum = node.quorum ?? ctx.settings.review.quorum;

  const start = await startOrchestratedClone(ctx, {
    agent: node.agent,
    prompt: node.prompt,
    profileKey: authorKey,
  });
  if (start.ok === false) return nodeResult(node, { status: start.status, detail: start.detail });
  const meta = start.meta;
  const group = await createCollabGroup(ctx.root, {
    kind: 'review',
    members: [
      { agent: meta.name, role: 'author' },
      ...reviewers.map((r) => ({ agent: meta.name, role: r.name, verdict: true })),
    ],
  });
  await createGroupState(
    ctx.root,
    { id: group.id, kind: 'review', runId: ctx.runId, nodeId: ctx.nodeId, agents: [meta.name] },
    ctx.settings.keepRuns,
  );
  report(ctx, { type: 'node-started', nodeId: ctx.nodeId, kind: 'review', info: meta });

  const verdicts: ReviewVerdictRecord[] = [];
  let rounds = 0;
  let outcome: { status: OrchestrationStatus | 'APPROVED'; detail: string | null } = {
    status: 'REVIEW_EXHAUSTED',
    detail: null,
  };
  const roles = ['author', ...reviewers.map((r) => r.name)];
  // Périmètre par rôle publié avec la collaboration : l'auteur écrit librement,
  // les relecteurs sont en lecture seule.
  const files: AgentCollabFiles = {
    author: null,
    ...Object.fromEntries(reviewers.map((r) => [r.name, [] as string[]])),
  };
  const collabOf = (activeRole: string, round: number): AgentCollabInfo => ({
    group: group.id,
    kind: 'review',
    cadence: 'turns',
    roles,
    activeRole,
    round,
    files,
  });
  const setTurn = async (role: string, round: number) => {
    await setActiveRoles(ctx.root, group.id, [role]);
    await updateGroupState(ctx.root, group.id, { round, activeRoles: [role] });
    // Le rôle courant des consignes (registre) suit le tour : sans cela, un
    // relecteur verrait « author » comme rôle courant.
    await publishAgentCollab(ctx.root, meta.name, collabOf(role, round));
  };

  await withGroupSession(ctx.root, meta.name, collabOf('author', 1), async () => {
    let feedback: ReviewVerdictRecord[] = [];
    for (let round = 1; round <= maxRounds; round += 1) {
      rounds = round;
      await setTurn('author', round);
      const authorFacts =
        round === 1
          ? []
          : [
              `Review round ${round - 1} requested changes. Address every comment below, then commit your fixes on the current branch.`,
            ];
      const g = await readCollabGroup(ctx.root, group.id);
      const authorTurn = await runTurn(ctx, meta, {
        group: group.id,
        role: 'author',
        round,
        profileKey: authorKey,
        profile: authorProfile,
        timeoutMs: timeoutFor(ctx, node.author.timeout, authorProfile),
        prompt: composeTurnPrompt({
          task: node.prompt,
          group: group.id,
          role: 'author',
          roleKind: 'author',
          peers: reviewers.map((r) => `${r.name} (reviewer)`),
          scope: null,
          readOnly: false,
          noCommit: false,
          facts: authorFacts,
          untrusted: [...messageItems(messagesForRoles(g, ['author'])), ...feedbackItems(feedback)],
          outboxFile: ctx.collab.outboxFile,
          inboxFile: ctx.collab.inboxFile,
          rulesInInstructions: collabRulesInSessionInstructions(ctx.config, authorProfile),
          maxChars: ctx.collab.briefingMaxChars,
        }),
        scope: null,
        readOnly: false,
        commit: true,
        publishChildPid: true,
      });
      if (authorTurn.status !== 'COMPLETED') {
        outcome = { status: turnFailureStatus(authorTurn), detail: authorTurn.detail };
        return;
      }
      const tip = await branchTip(meta);
      if (!tip || tip === meta.baseCommit) {
        outcome = { status: 'EMPTY', detail: 'NO_COMMIT' };
        return;
      }
      const diffstat = (
        await cloneGit(meta.path)
          .raw(['diff', '--stat', meta.baseCommit, tip])
          .catch(() => '')
      ).trim();

      const roundVerdicts: ReviewVerdictRecord[] = [];
      for (const reviewer of reviewers) {
        await setTurn(reviewer.name, round);
        const record =
          reviewer.kind === 'human'
            ? await humanVerdict(ctx, meta, {
                group: group.id,
                reviewer: reviewer.name,
                round,
                tip,
                diffstat,
              })
            : await agentVerdict(ctx, meta, {
                group: group.id,
                node,
                reviewer: {
                  name: reviewer.name,
                  profileKey: reviewer.profileKey ?? DEFAULT_PROFILE,
                  timeout: reviewer.timeout,
                  prompt: reviewer.prompt,
                },
                round,
                tip,
                diffstat,
                peers: roles.filter((r) => r !== reviewer.name),
              });
        if ('failure' in record) {
          outcome = { status: record.failure, detail: record.detail };
          return;
        }
        roundVerdicts.push(record);
        verdicts.push(record);
        await updateGroupState(ctx.root, group.id, { verdicts: [...verdicts] });
        report(ctx, {
          type: 'verdict',
          group: group.id,
          reviewer: record.reviewer,
          round,
          verdict: record.verdict,
        });
        await emit(ctx, {
          type: 'review:verdict',
          group: group.id,
          agent: meta.name,
          reviewer: record.reviewer,
          round,
          verdict: record.verdict,
          message: `🔎 [Striart] Review of ${meta.name}, round ${round}: ${record.reviewer} → ${record.verdict}.`,
        });
      }
      const decision = aggregateVerdicts(
        roundVerdicts.map((v) => v.verdict),
        quorum,
      );
      if (decision === 'approve') {
        outcome = { status: 'APPROVED', detail: null };
        return;
      }
      if (decision === 'reject') {
        outcome = { status: 'REVIEW_REJECTED', detail: null };
        return;
      }
      feedback = roundVerdicts;
    }
    outcome = { status: 'REVIEW_EXHAUSTED', detail: String(maxRounds) };
  });

  let result: OrchestrationNodeResult;
  if (outcome.status === 'APPROVED') {
    const final = await finalizeClone(ctx, meta);
    result = nodeResult(node, {
      status: final.status,
      detail: final.detail,
      kept: final.kept,
      merge: final.merge,
    });
  } else {
    result = nodeResult(node, { status: outcome.status, detail: outcome.detail, kept: true });
  }
  await closeCollabGroup(ctx.root, group.id).catch(() => {});
  await finishGroupState(ctx.root, group.id, result.status);
  return { ...result, agent: meta.name, agents: [meta.name], group: group.id, rounds, verdicts };
}

type VerdictOrFailure =
  ReviewVerdictRecord | { failure: OrchestrationStatus; detail: string | null };

async function agentVerdict(
  ctx: OrchestrationContext,
  meta: AgentInfo,
  {
    group,
    node,
    reviewer,
    round,
    tip,
    diffstat,
    peers,
  }: {
    group: string;
    node: ReviewNode;
    reviewer: { name: string; profileKey: string; timeout: number | null; prompt: string | null };
    round: number;
    tip: string;
    diffstat: string;
    peers: string[];
  },
): Promise<VerdictOrFailure> {
  const profile = resolveAgentProfile(ctx.config, reviewer.profileKey);
  for (let attempt = 0; attempt <= ctx.settings.review.verdictRetries; attempt += 1) {
    const g = await readCollabGroup(ctx.root, group);
    const seqBefore = g.seq;
    const verdictToken = newVerdictToken();
    const turn = await runTurn(ctx, meta, {
      group,
      role: reviewer.name,
      round,
      attempt,
      profileKey: reviewer.profileKey,
      profile,
      timeoutMs: timeoutFor(ctx, reviewer.timeout, profile),
      prompt: composeTurnPrompt({
        task: node.prompt,
        group,
        role: reviewer.name,
        roleKind: 'reviewer',
        rolePrompt: reviewer.prompt,
        peers,
        scope: [],
        readOnly: true,
        noCommit: true,
        facts: [
          `Changes to review (git diff --stat ${meta.baseCommit.slice(0, 12)}..${tip.slice(0, 12)}):\n${diffstat || '(empty)'}`,
        ],
        untrusted: messageItems(messagesForRoles(g, [reviewer.name])),
        outboxFile: ctx.collab.outboxFile,
        inboxFile: ctx.collab.inboxFile,
        rulesInInstructions: collabRulesInSessionInstructions(ctx.config, profile),
        review: { baseCommit: meta.baseCommit, tip, round, retry: attempt > 0, verdictToken },
        maxChars: ctx.collab.briefingMaxChars,
      }),
      scope: [],
      readOnly: true,
      commit: false,
      publishChildPid: true,
    });
    if (turn.status !== 'COMPLETED')
      return { failure: turnFailureStatus(turn), detail: turn.detail };

    // Ordre de lecture : outil MCP (posé pendant CE tour, seul le rôle
    // relecteur actif peut poster un verdict) → outbox → log de session.
    const after = await readCollabGroup(ctx.root, group);
    const viaMcp = after.messages.filter(
      (m) =>
        m.seq > seqBefore &&
        m.kind === 'verdict' &&
        m.from.role === reviewer.name &&
        m.source === 'mcp',
    );
    const candidates: Array<{ source: ReviewVerdictRecord['source']; raw: () => unknown }> = [];
    if (viaMcp.length > 0) {
      const body = viaMcp[viaMcp.length - 1].body;
      candidates.push({ source: 'mcp', raw: () => safeJson(body) });
    }
    if (turn.outbox.verdict !== undefined)
      candidates.push({ source: 'outbox', raw: () => turn.outbox.verdict });
    for (const c of candidates) {
      const parsed = parseVerdict(c.raw(), ctx.collab.maxBodyBytes);
      if (parsed.ok) return record(parsed.verdict, reviewer.name, 'agent', round, c.source);
    }
    if (ctx.collab.logMarkers) {
      const parsed = parseVerdictFromLog(
        await readSessionLog(turn.session),
        ctx.collab.maxBodyBytes,
        verdictToken,
      );
      if (parsed.ok) return record(parsed.verdict, reviewer.name, 'agent', round, 'log');
    }
  }
  await emit(ctx, {
    type: 'review:verdict',
    group,
    agent: meta.name,
    reviewer: reviewer.name,
    round,
    verdict: 'invalid',
    message: `⛔ [Striart] Review of ${meta.name}: ${reviewer.name} gave no valid verdict — nothing merged, clone kept.`,
  });
  return { failure: 'VERDICT_INVALID', detail: reviewer.name };
}

async function humanVerdict(
  ctx: OrchestrationContext,
  meta: AgentInfo,
  {
    group,
    reviewer,
    round,
    tip,
    diffstat,
  }: { group: string; reviewer: string; round: number; tip: string; diffstat: string },
): Promise<VerdictOrFailure> {
  const request = await createHumanReview(
    ctx.root,
    {
      group,
      agent: meta.name,
      reviewer,
      round,
      branch: meta.branch,
      sha: tip,
      baseCommit: meta.baseCommit,
      diffstat,
    },
    { timeoutMs: ctx.settings.review.humanTimeoutMs, keep: ctx.settings.keepRuns },
  );
  await updateGroupState(ctx.root, group, { humanReview: request.id });
  report(ctx, { type: 'waiting', nodeId: ctx.nodeId, reason: 'human-review', ref: request.id });
  await emit(ctx, {
    type: 'review:human-pending',
    group,
    agent: meta.name,
    reviewId: request.id,
    message: `👀 [Striart] Human review requested for ${meta.name} (round ${round}): striart review ${request.id} --approve | --request-changes | --reject`,
  });
  const answer = await awaitHumanReview(ctx.root, request.id, {
    intervalMs: ctx.settings.pollIntervalMs,
    signal: ctx.signal,
  });
  await updateGroupState(ctx.root, group, { humanReview: null });
  if (answer.status === 'ABORTED') return { failure: 'CANCELLED', detail: 'ABORTED' };
  if (answer.status === 'EXPIRED')
    return { failure: 'VERDICT_INVALID', detail: `${reviewer}:EXPIRED` };
  return record(answer.verdict, reviewer, 'human', round, 'human');
}

function record(
  verdict: ReviewVerdict,
  reviewer: string,
  kind: 'agent' | 'human',
  round: number,
  source: ReviewVerdictRecord['source'],
): ReviewVerdictRecord {
  return { ...verdict, reviewer, kind, round, source };
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

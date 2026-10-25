/**
 * Mode `team` — COLLABORATION INTRA-CLONE (lot O, décision O3) — et pipeline
 * à relais dans le clone (`handoff: clone`), qui en est le cas particulier
 * « un tour par étape ».
 *
 * Plusieurs rôles travaillent sur la MÊME tâche dans le MÊME clone ;
 * l'isolation vis-à-vis des autres tâches reste entière (un clone, un
 * merge, un Test Gate). Le problème central — plusieurs process qui
 * écrivent le même worktree et le même index — est traité par la cadence :
 *
 *  - `turns` (défaut) : un seul écrivain à la fois, tours bornés ; chaque
 *    rôle committe pendant SON tour (sérialisation des commits par
 *    construction) ; le tour suivant reçoit un briefing (faits git + messages
 *    médiés). Périmètre par rôle vérifié après chaque tour.
 *  - `parallel` : partition STATIQUE (`files` par rôle) ; aucun commit
 *    d'agent toléré (deux `git commit` concurrents se disputeraient l'index) ;
 *    après la phase, chaque fichier changé doit tomber dans exactement UN
 *    périmètre — l'attribution d'une écriture à un rôle est impossible sans
 *    médiation des écritures, c'est donc la partition qui fait foi ; puis
 *    Striart committe une fois.
 */
import { collabRulesInSessionInstructions } from '../agents/instructions.ts';
import { commitSessionLeftovers } from '../commit-policy.ts';
import { StriartError } from '../errors.js';
import { logger } from '../logger.js';
import { DEFAULT_PROFILE, resolveAgentProfile } from '../session.js';
import {
  closeCollabGroup,
  createCollabGroup,
  messagesForRoles,
  postHarvestedMessages,
  readCollabGroup,
  setActiveRoles,
} from '../collab/channel.ts';
import type {
  AgentCollabFiles,
  AgentCollabInfo,
  AgentProfile,
  OrchestrationNodeResult,
  OrchestrationStatus,
  PlanNode,
} from '../types.js';
import { composeTurnPrompt, messageItems } from './briefing.ts';
import { nodeResult } from './result.ts';
import { createGroupState, finishGroupState, updateGroupState } from './store.ts';
import {
  branchTip,
  finalizeClone,
  readSessionLog,
  report,
  runTurn,
  scopesCovering,
  startOrchestratedClone,
  timeoutFor,
  turnFailureStatus,
  withGroupSession,
  publishAgentCollab,
  worktreePaths,
} from './unit.ts';
import type { AgentInfo, OrchestrationContext, TurnResult } from './unit.ts';
import { lastFencedBlock, newVerdictToken } from './verdict.ts';
import { sanitizeAgentText } from '../collab/message.ts';

export interface TeamRole {
  name: string;
  profileKey: string;
  profile: AgentProfile;
  timeout: number | null;
  /** Consignes propres au rôle. */
  prompt: string | null;
  files: string[] | null;
  /** Pipeline : la tâche de l'étape remplace la tâche commune. */
  task: string | null;
}

export interface TeamFlow {
  kind: 'team' | 'pipeline';
  agent: string | null;
  goal: string;
  roles: TeamRole[];
  cadence: 'turns' | 'parallel';
  rounds: number;
}

export function teamRolesFrom(
  ctx: OrchestrationContext,
  node: Extract<PlanNode, { kind: 'team' }>,
): TeamRole[] {
  return node.roles.map((r) => {
    const profileKey = r.profile ?? DEFAULT_PROFILE;
    return {
      name: r.name,
      profileKey,
      profile: resolveAgentProfile(ctx.config, profileKey),
      timeout: r.timeout,
      prompt: r.prompt,
      files: r.files,
      task: null,
    };
  });
}

export async function runTeamNode(
  ctx: OrchestrationContext,
  node: Extract<PlanNode, { kind: 'team' }>,
): Promise<OrchestrationNodeResult> {
  return runTeamFlow(ctx, node, {
    kind: 'team',
    agent: node.agent,
    goal: node.prompt,
    roles: teamRolesFrom(ctx, node),
    cadence: node.cadence ?? ctx.settings.team.cadence,
    rounds: Math.min(node.rounds ?? ctx.settings.team.rounds, ctx.settings.team.maxRounds),
  });
}

/** Jeton d'un tour pour la balise de relais : même générateur que le verdict (128 bits, un par tour). */
export const newHandoffToken = newVerdictToken;

const HANDOFF_TOKEN_RE = /^[0-9a-f]{32}$/;

/** Consigne donnée à l'agent (faits du briefing) : la balise EXACTE de son tour. */
export function handoffDirective(token: string): string {
  return `To hand over through your answer, end it with a fenced block tagged \`striart-handoff-${token}\` (this exact tag, valid for this turn only; free text). A \`striart-handoff\` block without this token is ignored.`;
}

/**
 * Artefact de relais laissé par un tour : outbox `handoff`, sinon dernier bloc
 * fencé `striart-handoff-<jeton>` du log. Le journal contient AUSSI les sorties
 * d'outils (contenu de fichiers écrits par un autre rôle) : une balise nue y est
 * forgeable. Seule la balise portant le jeton du tour — que seul le briefing
 * de ce tour contient — est acceptée ; sans jeton valide, rien (fail closed).
 */
export async function handoffOf(
  ctx: OrchestrationContext,
  turn: TurnResult,
  token: string,
): Promise<string | null> {
  if (turn.outbox.handoff) return turn.outbox.handoff;
  if (!ctx.collab.logMarkers || !HANDOFF_TOKEN_RE.test(token)) return null;
  const block = lastFencedBlock(await readSessionLog(turn.session), `striart-handoff-${token}`);
  return block && block.trim() ? sanitizeAgentText(block, ctx.collab.maxBodyBytes).text : null;
}

export async function runTeamFlow(
  ctx: OrchestrationContext,
  node: Pick<PlanNode, 'id' | 'kind'>,
  flow: TeamFlow,
): Promise<OrchestrationNodeResult> {
  const first = flow.roles[0];
  const start = await startOrchestratedClone(ctx, {
    agent: flow.agent,
    prompt: flow.goal,
    profileKey: first.profileKey,
  });
  if (start.ok === false) return nodeResult(node, { status: start.status, detail: start.detail });
  const meta = start.meta;
  const group = await createCollabGroup(ctx.root, {
    kind: flow.kind,
    members: flow.roles.map((r) => ({ agent: meta.name, role: r.name })),
  });
  await createGroupState(
    ctx.root,
    { id: group.id, kind: flow.kind, runId: ctx.runId, nodeId: ctx.nodeId, agents: [meta.name] },
    ctx.settings.keepRuns,
  );
  report(ctx, { type: 'node-started', nodeId: ctx.nodeId, kind: flow.kind, info: meta });

  const roleNames = flow.roles.map((r) => r.name);
  const files: AgentCollabFiles = Object.fromEntries(
    flow.roles.map((r) => [r.name, r.files ?? null]),
  );
  const info: AgentCollabInfo =
    flow.cadence === 'parallel'
      ? {
          group: group.id,
          kind: 'team',
          cadence: 'parallel',
          roles: roleNames,
          activeRoles: [],
          round: 1,
          files,
        }
      : {
          group: group.id,
          kind: flow.kind,
          cadence: 'turns',
          roles: roleNames,
          activeRole: null,
          round: 1,
          files,
        };

  // Faits enregistrés par Striart (jamais par un agent) : qui a changé quoi,
  // cités dans le briefing des tours suivants.
  const changes: TurnChange[] = [];
  let rounds = 0;
  let failure = null as { status: OrchestrationStatus; detail: string | null } | null;
  await withGroupSession(ctx.root, meta.name, info, async () => {
    for (let round = 1; round <= flow.rounds; round += 1) {
      rounds = round;
      const outcome =
        flow.cadence === 'parallel'
          ? await parallelRound(ctx, meta, group.id, flow, round, info)
          : await turnsRound(ctx, meta, group.id, flow, round, info, changes);
      if (outcome.kind === 'failed') {
        failure = { status: outcome.status, detail: outcome.detail };
        return;
      }
      // Tous les rôles ont déclaré la tâche commune terminée : pas de tour de plus.
      if (outcome.kind === 'done') return;
    }
  });

  let result: OrchestrationNodeResult;
  if (failure) {
    const f: { status: OrchestrationStatus; detail: string | null } = failure;
    result = nodeResult(node, { status: f.status, detail: f.detail, kept: true });
  } else {
    const final = await finalizeClone(ctx, meta);
    result = nodeResult(node, {
      status: final.status,
      detail: final.detail,
      kept: final.kept,
      merge: final.merge,
    });
  }
  await closeCollabGroup(ctx.root, group.id).catch(() => {});
  await finishGroupState(ctx.root, group.id, result.status);
  return { ...result, agent: meta.name, agents: [meta.name], group: group.id, rounds };
}

type RoundOutcome =
  | { kind: 'continue' }
  | { kind: 'done' }
  | { kind: 'failed'; status: OrchestrationStatus; detail: string | null };

const failed = (status: OrchestrationStatus, detail: string | null): RoundOutcome => ({
  kind: 'failed',
  status,
  detail,
});

/** Un tour par rôle, un écrivain à la fois : échec, terminé (tous ont déclaré done), ou suite. */
async function turnsRound(
  ctx: OrchestrationContext,
  meta: AgentInfo,
  group: string,
  flow: TeamFlow,
  round: number,
  info: AgentCollabInfo,
  changes: TurnChange[],
): Promise<RoundOutcome> {
  const done = new Set<string>();
  for (const [index, role] of flow.roles.entries()) {
    await setActiveRoles(ctx.root, group, [role.name]);
    await updateGroupState(ctx.root, group, { round, activeRoles: [role.name] });
    await publishAgentCollab(ctx.root, meta.name, {
      ...info,
      activeRole: role.name,
      round,
    } as AgentCollabInfo);
    const g = await readCollabGroup(ctx.root, group);
    const handoffToken = newHandoffToken();
    const facts = [
      ...turnFacts(flow, index, round),
      ...(ctx.collab.logMarkers ? [handoffDirective(handoffToken)] : []),
    ];
    const readOnly = Array.isArray(role.files) && role.files.length === 0;
    const turn = await runTurn(ctx, meta, {
      group,
      role: role.name,
      round,
      profileKey: role.profileKey,
      profile: role.profile,
      timeoutMs: timeoutFor(ctx, role.timeout, role.profile),
      prompt: composeTurnPrompt({
        task: role.task ?? flow.goal,
        group,
        role: role.name,
        roleKind: flow.kind === 'pipeline' ? 'step' : 'member',
        rolePrompt: role.prompt,
        peers: flow.roles.filter((r) => r.name !== role.name).map((r) => r.name),
        scope: role.files,
        readOnly,
        noCommit: false,
        facts: [...facts, ...previousChanges(changes, role.name)],
        untrusted: messageItems(messagesForRoles(g, [role.name])),
        outboxFile: ctx.collab.outboxFile,
        inboxFile: ctx.collab.inboxFile,
        rulesInInstructions: collabRulesInSessionInstructions(ctx.config, role.profile),
        maxChars: ctx.collab.briefingMaxChars,
      }),
      scope: role.files,
      readOnly,
      commit: !readOnly,
      publishChildPid: true,
    });
    await publishAgentCollab(ctx.root, meta.name, {
      ...info,
      activeRole: null,
      round,
    } as AgentCollabInfo).catch(() => {});
    if (turn.status !== 'COMPLETED') return failed(turnFailureStatus(turn), turn.detail);
    if (turn.changedFiles.length > 0) {
      changes.push({ role: role.name, round, files: turn.changedFiles, tip: turn.tipAfter });
    }
    const handoff = await handoffOf(ctx, turn, handoffToken);
    const next = flow.roles[index + 1];
    if (handoff && next) {
      await postHarvestedMessages(
        ctx.root,
        group,
        { agent: meta.name, role: role.name },
        [{ to: next.name, kind: 'handoff', body: handoff }],
        'outbox',
        ctx.collab,
      ).catch((error: unknown) => logger.warn({ err: error }, 'Artefact de relais non posté'));
    }
    if (turn.outbox.done) done.add(role.name);
  }
  return done.size === flow.roles.length ? { kind: 'done' } : { kind: 'continue' };
}

interface TurnChange {
  role: string;
  round: number;
  files: string[];
  tip: string | null;
}

function turnFacts(flow: TeamFlow, index: number, round: number): string[] {
  const facts = [
    `Round ${round} of ${flow.rounds}; you are role ${index + 1} of ${flow.roles.length} (${flow.roles.map((r) => r.name).join(' → ')}).`,
  ];
  if (flow.kind === 'pipeline' && index > 0) {
    facts.push(
      `You continue the work of the previous step "${flow.roles[index - 1].name}" in the same clone: its commits are already on your branch.`,
    );
  }
  return facts;
}

/** Changements des AUTRES rôles, du plus ancien au plus récent (10 au plus). */
function previousChanges(changes: TurnChange[], role: string): string[] {
  const list = changes.filter((c) => c.role !== role);
  return list.slice(-10).map((c) => {
    const shown = c.files.slice(0, 20).join(', ');
    const more = c.files.length > 20 ? ` (+${c.files.length - 20} more)` : '';
    return `Role ${c.role} (round ${c.round}) changed: ${shown}${more}${c.tip ? ` — now at ${c.tip.slice(0, 12)}` : ''}.`;
  });
}

/** Tous les rôles en même temps, partition statique, commit unique par Striart. */
async function parallelRound(
  ctx: OrchestrationContext,
  meta: AgentInfo,
  group: string,
  flow: TeamFlow,
  round: number,
  info: AgentCollabInfo,
): Promise<RoundOutcome> {
  const roleNames = flow.roles.map((r) => r.name);
  await setActiveRoles(ctx.root, group, roleNames);
  await updateGroupState(ctx.root, group, { round, activeRoles: roleNames });
  await publishAgentCollab(ctx.root, meta.name, {
    ...info,
    activeRoles: roleNames,
    round,
  } as AgentCollabInfo);
  const tipBefore = await branchTip(meta);
  const g = await readCollabGroup(ctx.root, group);
  const controller = new AbortController();
  const turns = await Promise.all(
    flow.roles.map(async (role) => {
      const readOnly = Array.isArray(role.files) && role.files.length === 0;
      const turn = await runTurn(ctx, meta, {
        group,
        role: role.name,
        round,
        profileKey: role.profileKey,
        profile: role.profile,
        timeoutMs: timeoutFor(ctx, role.timeout, role.profile),
        prompt: composeTurnPrompt({
          task: flow.goal,
          group,
          role: role.name,
          roleKind: 'member',
          rolePrompt: role.prompt,
          peers: flow.roles.filter((r) => r.name !== role.name).map((r) => r.name),
          scope: role.files,
          readOnly,
          noCommit: true,
          facts: [
            `Round ${round} of ${flow.rounds}: all roles work AT THE SAME TIME in this clone, each inside its own write scope.`,
          ],
          untrusted: messageItems(messagesForRoles(g, [role.name])),
          outboxFile: ctx.collab.outboxFile,
          inboxFile: ctx.collab.inboxFile,
          rulesInInstructions: collabRulesInSessionInstructions(ctx.config, role.profile),
          maxChars: ctx.collab.briefingMaxChars,
        }),
        // Contrôles faits collectivement après la phase (attribution impossible).
        scope: null,
        readOnly: false,
        commit: false,
        publishChildPid: false,
        signal: controller.signal,
      });
      // Un rôle en échec arrête les autres : leur travail ne serait jamais mergé.
      if (turn.status !== 'COMPLETED') controller.abort();
      return turn;
    }),
  );
  await publishAgentCollab(ctx.root, meta.name, {
    ...info,
    activeRoles: [],
    round,
  } as AgentCollabInfo).catch(() => {});
  // Le rôle en échec d'abord (les autres ont pu être annulés à cause de lui).
  const broken =
    turns.find((t) => t.status !== 'COMPLETED' && t.status !== 'CANCELLED') ??
    turns.find((t) => t.status !== 'COMPLETED');
  if (broken) return failed(turnFailureStatus(broken), broken.detail);

  if ((await branchTip(meta)) !== tipBefore) return failed('TEAM_COMMIT_FORBIDDEN', null);
  const changed = await worktreePaths(meta);
  const violations = changed.filter((f) => scopesCovering(f, flow.roles).length !== 1);
  if (violations.length > 0) {
    if (ctx.settings.team.onScopeViolation === 'fail')
      return failed('SCOPE_VIOLATION', violations.slice(0, 20).join(','));
    logger.warn(
      { agent: meta.name, files: violations },
      'Partition non respectée, tolérée (team.onScopeViolation: warn)',
    );
  }
  if (changed.length > 0) {
    try {
      const outcome = await commitSessionLeftovers({
        root: ctx.root,
        clonePath: meta.path,
        branch: meta.branch,
        agent: meta.name,
        profileKey: 'striart-team',
        profile: { command: flow.roles[0].profile.command, args: [] },
        config: ctx.config,
        taskId: meta.taskId,
        prompt: flow.goal,
        policy: 'striart',
      });
      if (outcome.status === 'REFUSED') return failed('COMMIT_REFUSED', outcome.reason);
    } catch (error) {
      logger.error({ agent: meta.name, err: error }, 'Commit Striart de l’équipe en échec');
      return failed('COMMIT_FAILED', error instanceof StriartError ? error.code : 'GIT_FAILED');
    }
  }
  return turns.every((t) => t.outbox.done) ? { kind: 'done' } : { kind: 'continue' };
}

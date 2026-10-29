/**
 * Mode `pipeline` (lot O, décision O3) : des étapes ordonnées dont la sortie
 * VALIDÉE alimente la suivante.
 *
 *  - `handoff: merge` (défaut) : chaque étape est un cycle complet dans son
 *    propre clone — session, contrat de commit, merge sous Test Gate,
 *    nettoyage. L'étape suivante part du principal à jour (son clone est créé
 *    APRÈS le merge précédent) et reçoit un briefing de relais : les faits
 *    calculés par Striart (commit mergé, fichiers changés) puis l'artefact de
 *    l'étape précédente, encadré comme non fiable. Une étape qui n'est pas
 *    mergée arrête le pipeline : rien ne part sur un travail non validé.
 *  - `handoff: clone` : étapes en tours de parole dans UN clone, un seul
 *    merge à la fin (src/orchestration/team.ts).
 */
import { simpleGit } from 'simple-git';
import { DEFAULT_PROFILE, resolveAgentProfile } from '../session.ts';
import { slugifyPrompt } from '../orchestrator.ts';
import {
  closeCollabGroup,
  createCollabGroup,
  messagesForRoles,
  postHarvestedMessages,
  readCollabGroup,
  setActiveRoles,
} from '../collab/channel.ts';
import { collabRulesInSessionInstructions } from '../agents/instructions.ts';
import { logger } from '../logger.ts';
import type { OrchestrationNodeResult, PlanNode } from '../types.js';
import { composeTurnPrompt, messageItems } from './briefing.ts';
import { nodeResult } from './result.ts';
import { createGroupState, finishGroupState, updateGroupState } from './store.ts';
import { handoffDirective, handoffOf, newHandoffToken, runTeamFlow } from './team.ts';
import {
  finalizeClone,
  freeBaseName,
  report,
  runTurn,
  startOrchestratedClone,
  timeoutFor,
  turnFailureStatus,
  withGroupSession,
} from './unit.ts';
import type { OrchestrationContext } from './unit.ts';

type PipelineNode = Extract<PlanNode, { kind: 'pipeline' }>;

export async function runPipelineNode(
  ctx: OrchestrationContext,
  node: PipelineNode,
): Promise<OrchestrationNodeResult> {
  const steps = node.steps.map((s) => {
    const profileKey = s.profile ?? DEFAULT_PROFILE;
    return { ...s, profileKey, profileSpec: resolveAgentProfile(ctx.config, profileKey) };
  });
  const handoff = node.handoff ?? ctx.settings.pipeline.handoff;
  if (handoff === 'clone') {
    return runTeamFlow(ctx, node, {
      kind: 'pipeline',
      agent: node.agent,
      // Le Router prédit les fichiers de TOUTES les étapes (un seul clone).
      goal: steps.map((s) => s.prompt).join('\n\n'),
      roles: steps.map((s) => ({
        name: s.id,
        profileKey: s.profileKey,
        profile: s.profileSpec,
        timeout: s.timeout,
        prompt: null,
        files: null,
        task: s.prompt,
      })),
      cadence: 'turns',
      rounds: 1,
    });
  }

  const base =
    node.agent ??
    (await freeBaseName(
      ctx.root,
      slugifyPrompt(steps[0].prompt).slice(0, 30),
      steps.map((s) => s.id),
    ));
  const names = steps.map((s) => `${base}-${s.id}`);
  const group = await createCollabGroup(ctx.root, {
    kind: 'pipeline',
    members: steps.map((s, i) => ({ agent: names[i], role: s.id })),
  });
  await createGroupState(
    ctx.root,
    { id: group.id, kind: 'pipeline', runId: ctx.runId, nodeId: ctx.nodeId, agents: names },
    ctx.settings.keepRuns,
  );

  const agents: string[] = [];
  let previous: { step: string; mergeSha: string; files: string[] } | null = null;
  let result: OrchestrationNodeResult | null = null;
  for (const [i, step] of steps.entries()) {
    await updateGroupState(ctx.root, group.id, { round: i + 1, activeRoles: [step.id] });
    const start = await startOrchestratedClone(ctx, {
      agent: names[i],
      prompt: step.prompt,
      profileKey: step.profileKey,
    });
    if (start.ok === false) {
      result = nodeResult(node, {
        status: start.status,
        detail: `${step.id}:${start.detail}`,
        kept: agents.length > 0,
      });
      break;
    }
    const meta = start.meta;
    agents.push(meta.name);
    if (i === 0)
      report(ctx, { type: 'node-started', nodeId: ctx.nodeId, kind: 'pipeline', info: meta });
    await setActiveRoles(ctx.root, group.id, [step.id]);
    const g = await readCollabGroup(ctx.root, group.id);
    const handoffToken = newHandoffToken();
    const facts = previous
      ? [
          `Pipeline step ${i + 1} of ${steps.length}. The previous step "${previous.step}" was merged into the target branch (merge commit ${previous.mergeSha.slice(0, 12)}) and is already in your clone.`,
          `Files changed by the previous step: ${previous.files.slice(0, 40).join(', ') || '(none)'}${previous.files.length > 40 ? ` (+${previous.files.length - 40} more)` : ''}.`,
        ]
      : [
          `Pipeline step 1 of ${steps.length}. Leave a "handoff" in .striart-outbox.json (or the log handoff tag below) for the next step.`,
        ];
    if (ctx.collab.logMarkers) facts.push(handoffDirective(handoffToken));
    const turn = await withGroupSession(
      ctx.root,
      meta.name,
      {
        group: group.id,
        kind: 'pipeline',
        cadence: 'turns',
        roles: [step.id],
        activeRole: step.id,
        round: i + 1,
        files: { [step.id]: null },
      },
      () =>
        runTurn(ctx, meta, {
          group: group.id,
          role: step.id,
          round: i + 1,
          profileKey: step.profileKey,
          profile: step.profileSpec,
          timeoutMs: timeoutFor(ctx, step.timeout, step.profileSpec),
          prompt: composeTurnPrompt({
            task: step.prompt,
            group: group.id,
            role: step.id,
            roleKind: 'step',
            peers: steps.filter((s) => s.id !== step.id).map((s) => s.id),
            scope: null,
            readOnly: false,
            noCommit: false,
            facts,
            untrusted: messageItems(messagesForRoles(g, [step.id])),
            outboxFile: ctx.collab.outboxFile,
            inboxFile: ctx.collab.inboxFile,
            rulesInInstructions: collabRulesInSessionInstructions(ctx.config, step.profileSpec),
            maxChars: ctx.collab.briefingMaxChars,
          }),
          scope: null,
          readOnly: false,
          commit: true,
          publishChildPid: true,
        }),
    );
    if (turn.status !== 'COMPLETED') {
      result = nodeResult(node, {
        status: turnFailureStatus(turn),
        detail: `${step.id}:${turn.detail ?? ''}`,
        kept: true,
      });
      break;
    }
    const artefact = await handoffOf(ctx, turn, handoffToken);
    const final = await finalizeClone(ctx, meta);
    if (final.status !== 'MERGED' || !final.merge) {
      result = nodeResult(node, {
        status: final.status,
        detail: `${step.id}:${final.detail ?? ''}`,
        kept: true,
      });
      break;
    }
    const next = steps[i + 1];
    if (next && artefact) {
      await postHarvestedMessages(
        ctx.root,
        group.id,
        { agent: meta.name, role: step.id },
        [{ to: next.id, kind: 'handoff', body: artefact }],
        'outbox',
        ctx.collab,
      ).catch((error: unknown) => logger.warn({ err: error }, 'Artefact de relais non posté'));
    }
    // Merge réel : ce que le commit de merge a apporté. Commit déjà dans la cible
    // (`alreadyMerged`) : ce que le travail de l'agent a changé depuis sa base.
    const diffArgs = final.merge.alreadyMerged
      ? ['diff', '--name-only', meta.baseCommit, final.merge.sha]
      : ['diff', '--name-only', `${final.merge.mergeSha}^1`, final.merge.mergeSha];
    const files = (
      await simpleGit(ctx.root)
        .raw(diffArgs)
        .catch(() => '')
    )
      .split('\n')
      .map((f) => f.trim())
      .filter(Boolean);
    previous = { step: step.id, mergeSha: final.merge.mergeSha, files };
    result = nodeResult(node, {
      status: 'MERGED',
      detail: final.detail,
      kept: final.kept,
      merge: final.merge,
    });
  }
  const final = result ?? nodeResult(node, { status: 'SKIPPED', detail: 'NO_STEP' });
  await closeCollabGroup(ctx.root, group.id).catch(() => {});
  await finishGroupState(ctx.root, group.id, final.status);
  return { ...final, agent: agents.at(-1) ?? null, agents, group: group.id, rounds: agents.length };
}

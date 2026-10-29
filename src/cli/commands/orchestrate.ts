/**
 * `striart orchestrate <review|race|team|pipeline> …` (lot O) : une tâche
 * orchestrée depuis la ligne de commande, sans fichier. La commande ne fait
 * que TRADUIRE ses options en un plan `version: 2` d'un nœud, appliqué par
 * le même chemin que `striart plan` : une seule validation (plan-schema.ts),
 * une seule exécution (scheduler.ts), un seul rendu.
 *
 * Une option qui ne s'applique pas au mode choisi est refusée (sortie 2) :
 * l'ignorer laisserait croire à un réglage actif.
 */
import { StriartError } from '../../errors.ts';
import type { CommandModule } from '../context.ts';
import { executePlanText, renderPlanResult } from './plan.ts';
import type { PlanData } from './plan.ts';

export type OrchestrateMode = 'review' | 'race' | 'team' | 'pipeline';

export interface OrchestrateInput {
  mode: OrchestrateMode;
  prompts: string[];
  agent: string | null;
  author: string | null;
  reviewers: string[];
  humanReviewer: boolean;
  quorum: string | null;
  maxRounds: number | null;
  candidates: string[];
  pick: string | null;
  losers: string | null;
  roles: string[];
  cadence: string | null;
  rounds: number | null;
  stepProfiles: string[];
  handoff: string | null;
  timeout: number | null;
  dryRun: boolean;
}

/** Options propres à chaque mode (nom de champ → drapeau affiché). */
const OPTIONS: Record<string, { flag: string; modes: OrchestrateMode[] }> = {
  author: { flag: '--author', modes: ['review'] },
  reviewers: { flag: '--reviewer', modes: ['review'] },
  humanReviewer: { flag: '--human-reviewer', modes: ['review'] },
  quorum: { flag: '--quorum', modes: ['review'] },
  maxRounds: { flag: '--max-rounds', modes: ['review'] },
  candidates: { flag: '--candidate', modes: ['race'] },
  pick: { flag: '--pick', modes: ['race'] },
  losers: { flag: '--losers', modes: ['race'] },
  roles: { flag: '--role', modes: ['team'] },
  cadence: { flag: '--cadence', modes: ['team'] },
  rounds: { flag: '--rounds', modes: ['team'] },
  stepProfiles: { flag: '--step-profile', modes: ['pipeline'] },
  handoff: { flag: '--handoff', modes: ['pipeline'] },
};

function usage(reason: string, details: Record<string, unknown>): StriartError {
  return new StriartError(`Invalid "orchestrate" usage (${reason}).`, {
    code: 'ORCHESTRATE_USAGE',
    hint: 'striart orchestrate --help',
    details: { reason, ...details },
  });
}

const given = (v: unknown) =>
  Array.isArray(v) ? v.length > 0 : v !== null && v !== undefined && v !== false;

/** `nom=profil[:glob,glob]` ; `nom=profil:` = rôle en lecture seule. */
export function parseRoleSpec(spec: string): { name: string; profile: string; files?: string[] } {
  const match = /^([^=:]+)=([^:]+)(?::(.*))?$/.exec(spec);
  if (!match) throw usage('ROLE_SPEC_INVALID', { option: '--role' });
  const [, name, profile, files] = match;
  if (files === undefined) return { name: name.trim(), profile: profile.trim() };
  return {
    name: name.trim(),
    profile: profile.trim(),
    files: files
      .split(',')
      .map((g) => g.trim())
      .filter(Boolean),
  };
}

/** Traduit les options en plan v2 (objet ; validé ensuite par le schéma). */
export function buildOrchestratePlan(input: OrchestrateInput): Record<string, unknown> {
  for (const [field, { flag, modes }] of Object.entries(OPTIONS)) {
    if (given(input[field as keyof OrchestrateInput]) && !modes.includes(input.mode)) {
      throw usage('OPTION_NOT_FOR_MODE', { option: flag, mode: input.mode });
    }
  }
  if (input.mode !== 'pipeline' && input.prompts.length !== 1) {
    throw usage('ONE_PROMPT', { mode: input.mode });
  }
  const timeout = input.timeout ?? undefined;
  const base: Record<string, unknown> = { id: input.mode, mode: input.mode };
  if (input.agent) base.agent = input.agent;
  const prompt = input.prompts[0];
  let task: Record<string, unknown>;
  switch (input.mode) {
    case 'review': {
      if (input.reviewers.length === 0 && !input.humanReviewer) {
        throw usage('MISSING_OPTION', { option: '--reviewer | --human-reviewer', mode: 'review' });
      }
      task = {
        ...base,
        prompt,
        author: {
          ...(input.author ? { profile: input.author } : {}),
          ...(timeout ? { timeout } : {}),
        },
        reviewers: [
          ...input.reviewers.map((profile) => ({ profile, ...(timeout ? { timeout } : {}) })),
          ...(input.humanReviewer ? [{ name: 'human', human: true }] : []),
        ],
        ...(input.quorum ? { quorum: input.quorum } : {}),
        ...(input.maxRounds ? { maxRounds: input.maxRounds } : {}),
      };
      break;
    }
    case 'race':
      task = {
        ...base,
        prompt,
        candidates: input.candidates.map((profile) => ({
          profile,
          ...(timeout ? { timeout } : {}),
        })),
        ...(input.pick ? { pick: input.pick } : {}),
        ...(input.losers ? { losers: input.losers } : {}),
      };
      break;
    case 'team':
      task = {
        ...base,
        prompt,
        roles: input.roles.map((spec) => ({
          ...parseRoleSpec(spec),
          ...(timeout ? { timeout } : {}),
        })),
        ...(input.cadence ? { cadence: input.cadence } : {}),
        ...(input.rounds ? { rounds: input.rounds } : {}),
      };
      break;
    case 'pipeline': {
      if (input.stepProfiles.length > 0 && input.stepProfiles.length !== input.prompts.length) {
        throw usage('STEP_PROFILES_MISMATCH', { option: '--step-profile', mode: 'pipeline' });
      }
      task = {
        ...base,
        ...(input.handoff ? { handoff: input.handoff } : {}),
        steps: input.prompts.map((p, i) => ({
          id: `step-${i + 1}`,
          prompt: p,
          ...(input.stepProfiles[i] ? { profile: input.stepProfiles[i] } : {}),
          ...(timeout ? { timeout } : {}),
        })),
      };
      break;
    }
  }
  return { version: 2, tasks: [task] };
}

export const orchestrate: CommandModule<OrchestrateInput, PlanData> = {
  async execute(ctx, input) {
    const doc = buildOrchestratePlan(input);
    // JSON est un sous-ensemble de YAML : même analyse, même validation.
    return executePlanText(ctx, {
      text: JSON.stringify(doc),
      file: '(orchestrate)',
      dryRun: input.dryRun,
    });
  },

  render(ctx, { data }) {
    renderPlanResult(ctx, data, null);
  },
};

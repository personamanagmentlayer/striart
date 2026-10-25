import { describe, expect, it } from 'vitest';
import { buildOrchestratePlan, parseRoleSpec } from '../../src/cli/commands/orchestrate.ts';
import { validatePlan } from '../../src/plan.ts';
import { en } from '../../src/cli/i18n/en.ts';

/**
 * `striart orchestrate` (lot O) ne fait que traduire ses options en un plan
 * v2 d'un nœud : le plan produit passe la MÊME validation que `striart plan`,
 * et une option hors de son mode est refusée (jamais ignorée).
 */
const input = (extra) => ({
  mode: 'review',
  prompts: ['do it'],
  agent: null,
  author: null,
  reviewers: [],
  humanReviewer: false,
  quorum: null,
  maxRounds: null,
  candidates: [],
  pick: null,
  losers: null,
  roles: [],
  cadence: null,
  rounds: null,
  stepProfiles: [],
  handoff: null,
  timeout: null,
  dryRun: false,
  ...extra,
});

const usageReason = (fn) => {
  try {
    fn();
  } catch (error) {
    expect(error.code).toBe('ORCHESTRATE_USAGE');
    expect(en.errors(error.code, error.details)).toBeTruthy();
    return error.details.reason;
  }
  throw new Error('accepté à tort');
};

describe('striart orchestrate → plan v2', () => {
  it('review : auteur, relecteurs agent + humain, quorum', () => {
    const doc = buildOrchestratePlan(
      input({
        author: 'claude',
        reviewers: ['codex'],
        humanReviewer: true,
        quorum: 'any',
        timeout: 60000,
      }),
    );
    const plan = validatePlan(doc);
    expect(plan.tasks[0]).toMatchObject({
      kind: 'review',
      author: { profile: 'claude', timeout: 60000 },
      quorum: 'any',
    });
    expect(plan.tasks[0].reviewers.map((r) => [r.name, r.kind])).toEqual([
      ['reviewer-1', 'agent'],
      ['human', 'human'],
    ]);
  });

  it('race, team (rôles nom=profil:globs) et pipeline (une étape par prompt)', () => {
    expect(
      validatePlan(
        buildOrchestratePlan(input({ mode: 'race', candidates: ['a', 'b'], pick: 'judge' })),
      ).tasks[0],
    ).toMatchObject({ kind: 'race', pick: 'judge' });
    const team = validatePlan(
      buildOrchestratePlan(
        input({
          mode: 'team',
          roles: ['back=claude:src/**,lib/**', 'reader=codex:', 'free=codex'],
          cadence: 'turns',
        }),
      ),
    );
    expect(team.tasks[0].roles.map((r) => r.files)).toEqual([['src/**', 'lib/**'], [], null]);
    const pipe = validatePlan(
      buildOrchestratePlan(
        input({
          mode: 'pipeline',
          prompts: ['a', 'b'],
          stepProfiles: ['p', 'q'],
          handoff: 'clone',
        }),
      ),
    );
    expect(pipe.tasks[0].steps.map((s) => [s.id, s.profile])).toEqual([
      ['step-1', 'p'],
      ['step-2', 'q'],
    ]);
  });

  it('refuse une option hors de son mode, un relecteur manquant, des profils d’étapes mal alignés', () => {
    expect(
      usageReason(() =>
        buildOrchestratePlan(input({ mode: 'race', candidates: ['a', 'b'], reviewers: ['x'] })),
      ),
    ).toBe('OPTION_NOT_FOR_MODE');
    expect(usageReason(() => buildOrchestratePlan(input({})))).toBe('MISSING_OPTION');
    expect(
      usageReason(() => buildOrchestratePlan(input({ prompts: ['a', 'b'], reviewers: ['x'] }))),
    ).toBe('ONE_PROMPT');
    expect(
      usageReason(() =>
        buildOrchestratePlan(input({ mode: 'pipeline', prompts: ['a', 'b'], stepProfiles: ['p'] })),
      ),
    ).toBe('STEP_PROFILES_MISMATCH');
    expect(usageReason(() => parseRoleSpec('nobody'))).toBe('ROLE_SPEC_INVALID');
  });
});

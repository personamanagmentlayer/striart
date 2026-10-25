import { describe, expect, it } from 'vitest';
import { en } from '../../src/cli/i18n/en.ts';
import { parsePlan, validatePlan } from '../../src/plan.ts';

/**
 * Plan `version: 2` (lot O) : modes d'orchestration explicites. Validation
 * POSITIVE — toute clé inconnue, toute valeur hors liste est refusée avant
 * le moindre effet de bord, avec une raison stable traduite en anglais.
 */
function reasonOf(doc) {
  try {
    validatePlan(doc);
  } catch (error) {
    expect(error.code).toBe('PLAN_INVALID');
    return error;
  }
  throw new Error('plan accepté à tort');
}

const v2 = (tasks, extra = {}) => ({ version: 2, tasks, ...extra });

describe('plan v2 — formes valides', () => {
  it('normalise un plan à quatre modes (défauts null, after en liste)', () => {
    const plan = validatePlan(
      v2(
        [
          { id: 'schema', prompt: 'migrate', autonomous: true, profile: 'claude' },
          {
            id: 'auth',
            mode: 'review',
            prompt: 'jwt',
            after: 'schema',
            author: { profile: 'claude' },
            reviewers: [{ profile: 'codex' }, { name: 'lead', human: true }],
            quorum: 'majority',
            maxRounds: 2,
          },
          {
            id: 'docs',
            mode: 'pipeline',
            after: ['schema', 'auth'],
            steps: [
              { id: 'draft', prompt: 'draft docs', profile: 'claude' },
              { id: 'polish', prompt: 'polish docs' },
            ],
          },
          {
            id: 'perf',
            mode: 'race',
            prompt: 'speed up',
            candidates: [{ profile: 'claude' }, { profile: 'codex', timeout: 60000 }],
            pick: 'smallest-diff',
            losers: 'archive',
          },
          {
            id: 'api',
            mode: 'team',
            prompt: 'build the api',
            cadence: 'parallel',
            roles: [
              { name: 'backend', profile: 'claude', files: ['src/**'] },
              { name: 'tests', profile: 'codex', files: ['tests/**'] },
            ],
          },
        ],
        { mode: 'parallel', concurrency: 3, onFailure: 'skip-dependents' },
      ),
    );
    expect(plan.version).toBe(2);
    expect(plan.mode).toBe('parallel');
    expect(plan.concurrency).toBe(3);
    expect(plan.onFailure).toBe('skip-dependents');
    expect(plan.tasks.map((t) => t.kind)).toEqual(['task', 'review', 'pipeline', 'race', 'team']);
    expect(plan.tasks[1].after).toEqual(['schema']);
    expect(plan.tasks[2].after).toEqual(['schema', 'auth']);
    expect(plan.tasks[1].reviewers).toEqual([
      { name: 'reviewer-1', kind: 'agent', profile: 'codex', timeout: null, prompt: null },
      { name: 'lead', kind: 'human', profile: null, timeout: null, prompt: null },
    ]);
    expect(plan.tasks[4].roles[0]).toEqual({
      name: 'backend',
      profile: 'claude',
      timeout: null,
      prompt: null,
      files: ['src/**'],
    });
  });

  it('défauts : mode sequential, concurrency/onFailure null', () => {
    const plan = validatePlan(v2([{ prompt: 'x' }]));
    expect(plan.mode).toBe('sequential');
    expect(plan.concurrency).toBeNull();
    expect(plan.onFailure).toBeNull();
    expect(plan.tasks[0]).toMatchObject({ kind: 'task', autonomous: false, after: [] });
  });

  it('se lit depuis YAML (et depuis JSON, sous-ensemble de YAML)', () => {
    const yaml = parsePlan('version: 2\ntasks:\n  - prompt: |\n      multi\n      ligne\n');
    expect(yaml.tasks[0].prompt).toBe('multi\nligne\n');
    const json = parsePlan(JSON.stringify(v2([{ prompt: 'x' }])));
    expect(json.version).toBe(2);
  });

  it('le v1 reste inchangé (aucune clé v2 n’y est lue)', () => {
    const plan = validatePlan({ version: 1, tasks: [{ prompt: 'x', after: 'y' }] });
    expect(plan.version).toBe(1);
    expect(plan.tasks[0].after).toBe('y');
  });
});

describe('plan v2 — refus (raison stable + traduction anglaise)', () => {
  const cases = [
    ['UNKNOWN_KEY', v2([{ prompt: 'x' }], { mdoe: 'parallel' }), /unknown key "mdoe"/],
    ['UNKNOWN_KEY', v2([{ prompt: 'x', autonmous: true }]), /unknown key "autonmous"/],
    ['MODE_INVALID', v2([{ prompt: 'x' }], { mode: 'swarm' }), /"mode"/],
    ['CONCURRENCY_INVALID', v2([{ prompt: 'x' }], { concurrency: 0 }), /"concurrency"/],
    ['ON_FAILURE_INVALID', v2([{ prompt: 'x' }], { onFailure: 'ignore' }), /"onFailure"/],
    ['KIND_UNKNOWN', v2([{ mode: 'swarm', prompt: 'x' }]), /task #1.*"swarm"/],
    ['AFTER_INVALID', v2([{ prompt: 'x', after: [] }]), /"after"/],
    ['AFTER_INVALID', v2([{ prompt: 'x', after: ['a', 'a'] }]), /"after"/],
    [
      'AFTER_FORWARD',
      v2([
        { id: 'a', prompt: 'x', after: ['b'] },
        { id: 'b', prompt: 'y' },
      ]),
      /"after: b".*later/,
    ],
    [
      'COMMAND_AUTONOMOUS_CONFLICT',
      v2([{ prompt: 'x', command: 'aider', autonomous: true }]),
      /"command"/,
    ],
    ['PROFILE_NEEDS_AUTONOMOUS', v2([{ prompt: 'x', profile: 'claude' }]), /"profile"/],
    [
      'COMMAND_NOT_AN_EXECUTABLE_NAME',
      v2([{ prompt: 'x', command: 'claude; curl x | sh' }]),
      /"command"/,
    ],
    ['REVIEWERS_MISSING', v2([{ mode: 'review', prompt: 'x', reviewers: [] }]), /reviewer/],
    [
      'REVIEWERS_TOO_MANY',
      v2([
        {
          mode: 'review',
          prompt: 'x',
          reviewers: [1, 2, 3, 4, 5, 6].map(() => ({ profile: 'p' })),
        },
      ]),
      /at most 5/,
    ],
    [
      'HUMAN_REVIEWER_PROFILE',
      v2([{ mode: 'review', prompt: 'x', reviewers: [{ human: true, profile: 'p' }] }]),
      /human reviewer/,
    ],
    [
      'QUORUM_INVALID',
      v2([{ mode: 'review', prompt: 'x', reviewers: [{ profile: 'p' }], quorum: 'most' }]),
      /"quorum"/,
    ],
    [
      'ROUNDS_INVALID',
      v2([{ mode: 'review', prompt: 'x', reviewers: [{ profile: 'p' }], maxRounds: 11 }]),
      /"maxRounds"/,
    ],
    [
      'NAME_INVALID',
      v2([{ mode: 'review', prompt: 'x', reviewers: [{ name: 'Lead Dev', profile: 'p' }] }]),
      /name/,
    ],
    [
      'NAME_DUPLICATE',
      v2([
        {
          mode: 'review',
          prompt: 'x',
          reviewers: [
            { name: 'a', profile: 'p' },
            { name: 'a', profile: 'q' },
          ],
        },
      ]),
      /duplicate name "a"/,
    ],
    ['STEPS_MISSING', v2([{ mode: 'pipeline', steps: [{ id: 'a', prompt: 'x' }] }]), /2 steps/],
    [
      'STEP_ID_DUPLICATE',
      v2([
        {
          mode: 'pipeline',
          steps: [
            { id: 'a', prompt: 'x' },
            { id: 'a', prompt: 'y' },
          ],
        },
      ]),
      /duplicate step id "a"/,
    ],
    [
      'HANDOFF_INVALID',
      v2([
        {
          mode: 'pipeline',
          handoff: 'copy',
          steps: [
            { id: 'a', prompt: 'x' },
            { id: 'b', prompt: 'y' },
          ],
        },
      ]),
      /"handoff"/,
    ],
    [
      'PROMPT_FORBIDDEN',
      v2([
        {
          mode: 'pipeline',
          prompt: 'x',
          steps: [
            { id: 'a', prompt: 'x' },
            { id: 'b', prompt: 'y' },
          ],
        },
      ]),
      /"prompt"/,
    ],
    [
      'CANDIDATES_TOO_FEW',
      v2([{ mode: 'race', prompt: 'x', candidates: [{ profile: 'p' }] }]),
      /2 candidates/,
    ],
    [
      'PICK_INVALID',
      v2([{ mode: 'race', prompt: 'x', candidates: [{}, {}], pick: 'best' }]),
      /"pick"/,
    ],
    [
      'LOSERS_INVALID',
      v2([{ mode: 'race', prompt: 'x', candidates: [{}, {}], losers: 'delete' }]),
      /"losers"/,
    ],
    ['ROLES_TOO_FEW', v2([{ mode: 'team', prompt: 'x', roles: [{ name: 'a' }] }]), /2 roles/],
    [
      'CADENCE_UNAVAILABLE',
      v2([
        { mode: 'team', prompt: 'x', cadence: 'dynamic', roles: [{ name: 'a' }, { name: 'b' }] },
      ]),
      /dynamic/,
    ],
    [
      'CADENCE_INVALID',
      v2([{ mode: 'team', prompt: 'x', cadence: 'chaos', roles: [{ name: 'a' }, { name: 'b' }] }]),
      /"cadence"/,
    ],
    [
      'PARALLEL_SCOPE_MISSING',
      v2([
        {
          mode: 'team',
          prompt: 'x',
          cadence: 'parallel',
          roles: [{ name: 'a', files: ['src/**'] }, { name: 'b' }],
        },
      ]),
      /role "b".*"files"/,
    ],
    [
      'SCOPE_INVALID',
      v2([
        {
          mode: 'team',
          prompt: 'x',
          roles: [{ name: 'a', files: ['../outside'] }, { name: 'b' }],
        },
      ]),
      /"files"/,
    ],
  ];

  for (const [reason, doc, english] of cases) {
    it(`${reason}`, () => {
      const error = reasonOf(doc);
      expect(error.details.reason).toBe(reason);
      expect(en.errors(error.code, error.details)).toMatch(english);
    });
  }

  it('une version future reste refusée (fail closed)', () => {
    const error = reasonOf({ version: 3, tasks: [{ prompt: 'x' }] });
    expect(error.details.reason).toBe('UNSUPPORTED_VERSION');
    expect(en.errors(error.code, error.details)).toMatch(/expected: 1 or 2/);
  });
});

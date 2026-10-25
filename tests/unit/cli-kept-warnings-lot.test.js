import { beforeEach, describe, expect, it, vi } from 'vitest';
import { en } from '../../src/cli/i18n/en.ts';
import { fr } from '../../src/cli/i18n/fr.ts';
import { autonomousOutcome, orchestrationOutcome } from '../../src/cli/exit.ts';

/**
 * Lot « suites revue CLI » : statut KEPT (commitPolicy 'human'), avertissement
 * ALREADY_INTEGRATED, queueError de `stop`, clones conservés de `prune`.
 */
const state = vi.hoisted(() => ({
  autonomous: null,
  applyPlan: null,
  stopAgent: null,
  prune: null,
}));

vi.mock('../../src/clone.js', () => ({ assertInitialized: async () => {} }));
vi.mock('../../src/orchestrator.js', async (importOriginal) => ({
  ...(await importOriginal()),
  runAutonomousTask: (...a) => state.autonomous(...a),
  applyPlan: (...a) => state.applyPlan(...a),
  stopAgent: (...a) => state.stopAgent(...a),
}));
vi.mock('../../src/prune.js', () => ({ pruneWorkspace: (...a) => state.prune(...a) }));
vi.mock('../../src/cli/commands/queue.ts', () => ({
  withSessions: async (_root, started) => started,
  renderStartedTasks: () => {},
}));
vi.mock('../../src/pty-host.ts', () => ({ openAttendedSession: async () => null }));

const { run } = await import('../../src/cli/commands/run.ts');
const { executePlanText, renderPlanResult } = await import('../../src/cli/commands/plan.ts');
const { stop } = await import('../../src/cli/commands/stop.ts');
const { prune } = await import('../../src/cli/commands/prune.ts');

function makeCtx(m = en) {
  const lines = [];
  const out = {
    step: () => {},
    warn: () => {},
    line: (level, text, hint) => lines.push({ level, text, hint }),
    detail: (text) => lines.push({ level: 'detail', text }),
    print: () => {},
    hint: () => {},
    untrusted: (t) => String(t ?? ''),
    path: (p) => String(p),
    sha: (s) => String(s),
    date: (d) => String(d),
    bytes: (b) => `${b}B`,
    duration: (d) => `${d}ms`,
    task: async (_l, fn) => fn(),
    table: () => {},
  };
  const ctx = {
    out,
    m,
    json: false,
    cwd: '/repo',
    signal: new AbortController().signal,
    repoRoot: async () => '/repo',
  };
  return { ctx, lines };
}

const KEPT = {
  status: 'KEPT',
  agent: 'agent-a',
  session: null,
  merge: null,
  commit: null,
  cleaned: false,
  keptReason: 'revue humaine',
  keptCode: 'HUMAN_REVIEW_REQUIRED',
  keptDetail: 'human',
  clonePath: '/clones/agent-a',
};

const INTEGRATED = {
  status: 'MERGED',
  agent: 'agent-b',
  session: null,
  merge: { status: 'UP_TO_DATE', agent: 'agent-b', alreadyMerged: true, sha: 'abc' },
  commit: null,
  cleaned: true,
  keptReason: null,
  keptCode: null,
  keptDetail: null,
  clonePath: null,
  warnings: ['ALREADY_INTEGRATED'],
};

const RUN_INPUT = {
  prompt: 'p',
  promptOption: null,
  agent: 'agent-a',
  command: null,
  open: false,
  autonomous: true,
  onMain: false,
  profile: null,
  timeoutMs: null,
  after: null,
  reuse: false,
  force: false,
  allowHistoricalSecrets: false,
};

beforeEach(() => {
  state.autonomous = null;
  state.applyPlan = null;
  state.stopAgent = null;
  state.prune = null;
});

describe('exit : KEPT = renvoi voulu vers l’humain (refus, 3), jamais un échec (1)', () => {
  it('autonomousOutcome KEPT → refused', () => {
    expect(autonomousOutcome('KEPT', 'human')).toBe('refused');
    expect(autonomousOutcome('KEPT')).toBe('refused');
  });
  it('orchestrationOutcome KEPT → refused', () => {
    expect(orchestrationOutcome('KEPT', 'HUMAN_REVIEW_REQUIRED')).toBe('refused');
  });
  it('les autres statuts ne changent pas', () => {
    expect(autonomousOutcome('MERGED')).toBe('ok');
    expect(autonomousOutcome('EMPTY')).toBe('failed');
    expect(autonomousOutcome('EMPTY', 'human')).toBe('refused');
  });
});

describe('run --autonomous : KEPT et ALREADY_INTEGRATED', () => {
  it('KEPT : sortie 3 et affichage avec la raison localisée + clone conservé', async () => {
    state.autonomous = async () => KEPT;
    const { ctx, lines } = makeCtx();
    const result = await run.execute(ctx, RUN_INPUT);
    expect(result.outcome).toBe('refused');
    run.render(ctx, result);
    const status = lines.find((l) => l.text.includes('KEPT'));
    expect(status.level).toBe('warn');
    expect(status.text).toContain(en.run.kept('HUMAN_REVIEW_REQUIRED', 'human'));
    expect(lines.some((l) => l.text.includes('/clones/agent-a'))).toBe(true);
  });

  it('ALREADY_INTEGRATED : remonté en avertissement (stderr + warnings du --json)', async () => {
    state.autonomous = async () => INTEGRATED;
    const { ctx } = makeCtx();
    const result = await run.execute(ctx, RUN_INPUT);
    expect(result.outcome).toBe('ok');
    expect(result.warnings).toEqual([
      expect.objectContaining({
        code: 'ALREADY_INTEGRATED',
        message: en.run.alreadyIntegratedWarning('agent-b'),
      }),
    ]);
  });

  it('i18n fr : alreadyIntegratedWarning défini', () => {
    expect(fr.run.alreadyIntegratedWarning('agent-b')).toContain('agent-b');
  });
});

describe('plan : KEPT / ALREADY_INTEGRATED', () => {
  const v1 = (results) => async () => ({
    version: 1,
    dryRun: false,
    tasks: [],
    results,
    notApplied: [],
  });

  it('v1 : tâche autonome KEPT → refus ; ALREADY_INTEGRATED → avertissement', async () => {
    state.applyPlan = v1([
      { mode: 'autonomous', id: 'a', ...KEPT },
      { mode: 'autonomous', id: 'b', ...INTEGRATED },
    ]);
    const { ctx } = makeCtx();
    const res = await executePlanText(ctx, {
      text: 'x',
      file: '/p.yml',
      dryRun: false,
      overrides: { mode: null, concurrency: null, onFailure: null },
    });
    expect(res.outcome).toBe('refused');
    expect(res.warnings.map((w) => w.code)).toEqual(['ALREADY_INTEGRATED']);
    expect(res.warnings[0].message).toBe(en.run.alreadyIntegratedWarning('agent-b'));
  });

  it('v2 : nœud KEPT → refus ; nœud mergé alreadyMerged → avertissement', async () => {
    state.applyPlan = async () => ({
      version: 2,
      dryRun: false,
      tasks: [],
      results: [],
      notApplied: [],
      nodes: [
        {
          id: 'n1',
          kind: 'task',
          mode: 'autonomous',
          status: 'KEPT',
          agent: 'agent-a',
          agents: ['agent-a'],
          verdicts: [],
          detail: 'HUMAN_REVIEW_REQUIRED',
          kept: true,
          merge: null,
        },
        {
          id: 'n2',
          kind: 'task',
          mode: 'autonomous',
          status: 'MERGED',
          agent: 'agent-b',
          agents: ['agent-b'],
          verdicts: [],
          detail: null,
          kept: false,
          merge: { sha: 'a', mergeSha: 'a', alreadyMerged: true },
        },
      ],
    });
    const { ctx } = makeCtx();
    const res = await executePlanText(ctx, {
      text: 'x',
      file: '/p.yml',
      dryRun: false,
      overrides: { mode: null, concurrency: null, onFailure: null },
    });
    expect(res.outcome).toBe('refused');
    expect(res.warnings.map((w) => w.code)).toEqual(['ALREADY_INTEGRATED']);
    expect(res.warnings[0].message).toBe(en.run.alreadyIntegratedWarning('agent-b'));
  });

  it('rendu : un nœud/une tâche KEPT est un avertissement visible, pas une erreur', () => {
    const { ctx, lines } = makeCtx();
    renderPlanResult(
      ctx,
      {
        version: 2,
        dryRun: false,
        file: '/p.yml',
        tasks: [],
        results: [],
        sessions: {},
        nodes: [
          {
            id: 'n1',
            kind: 'task',
            status: 'KEPT',
            agents: ['agent-a'],
            verdicts: [],
            detail: 'HUMAN_REVIEW_REQUIRED',
            kept: true,
          },
        ],
      },
      null,
    );
    expect(lines.find((l) => l.text.includes('KEPT')).level).toBe('warn');
    const { ctx: ctx1, lines: l1 } = makeCtx();
    renderPlanResult(
      ctx1,
      {
        version: 1,
        dryRun: false,
        file: '/p.yml',
        tasks: [],
        results: [{ mode: 'autonomous', id: 'a', ...KEPT }],
        sessions: {},
      },
      null,
    );
    expect(l1.find((l) => l.text.includes('KEPT')).level).toBe('warn');
  });
});

describe('stop : queueError', () => {
  const STOPPED = {
    agent: 'agent-a',
    clonePath: '/clones/agent-a',
    cloneMissing: false,
    started: [],
    stillWaiting: [],
    ptyHost: { stopping: false, untouched: null },
    artifacts: { errors: [] },
  };

  it('queueError : avertissement avec le code, et ligne visible au rendu', async () => {
    state.stopAgent = async () => ({
      ...STOPPED,
      queueError: { code: 'QUEUE_CORRUPT', message: 'illisible' },
    });
    const { ctx, lines } = makeCtx();
    const result = await stop.execute(ctx, { agent: 'agent-a', force: false });
    expect(result.warnings).toEqual([
      expect.objectContaining({ code: 'QUEUE_CORRUPT', message: expect.stringContaining('queue') }),
    ]);
    stop.render(ctx, result);
    const warn = lines.find((l) => l.level === 'warn');
    expect(warn.hint).toBe('striart queue --retry');
  });

  it('sans queueError : aucun avertissement', async () => {
    state.stopAgent = async () => ({ ...STOPPED, queueError: null });
    const { ctx } = makeCtx();
    const result = await stop.execute(ctx, { agent: 'agent-a', force: false });
    expect(result.warnings).toEqual([]);
  });
});

describe('prune : clones conservés et échecs', () => {
  const RESULT = (extra = {}) => ({
    retentionDays: 14,
    dryRun: false,
    freedBytes: 0,
    clones: {
      removed: [],
      kept: [
        { name: 'agent-a', lastActivity: '2026-01-01' },
        { name: 'agent-b', lastActivity: '2026-01-02', reason: 'PTY_HOST_LIVE' },
      ],
    },
    tickets: { removed: [] },
    logs: { removed: [] },
    usage: {},
    failed: [],
    ...extra,
  });

  it('affiche la raison de conservation (hôte de terminal vivant)', async () => {
    state.prune = async () => RESULT();
    const { ctx, lines } = makeCtx();
    const result = await prune.execute(ctx, { days: null, dryRun: false });
    prune.render(ctx, result);
    const b = lines.find((l) => l.text.includes('agent-b'));
    expect(b.text).toContain(en.prune.keptReason('PTY_HOST_LIVE'));
    const a = lines.find((l) => l.text.includes('agent-a'));
    expect(a.text).not.toContain(en.prune.keptReason('PTY_HOST_LIVE'));
  });

  it('une suppression en échec n’est jamais silencieuse : ligne d’erreur et sortie 1', async () => {
    state.prune = async () =>
      RESULT({ failed: [{ kind: 'clone', name: 'agent-c', cause: 'EBUSY' }] });
    const { ctx, lines } = makeCtx();
    const result = await prune.execute(ctx, { days: null, dryRun: false });
    expect(result.outcome).toBe('failed');
    prune.render(ctx, result);
    const f = lines.find((l) => l.text.includes('agent-c'));
    expect(f.level).toBe('error');
    expect(f.text).toContain('EBUSY');
  });

  it('i18n fr : keptReason et failed définis', () => {
    expect(fr.prune.keptReason('PTY_HOST_LIVE')).toBeTruthy();
    expect(fr.prune.failed('clone', 'x', 'EBUSY')).toContain('EBUSY');
  });
});

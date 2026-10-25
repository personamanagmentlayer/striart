import { beforeEach, describe, expect, it, vi } from 'vitest';
import { StriartError } from '../../src/errors.js';
import { en } from '../../src/cli/i18n/en.ts';

/**
 * C-I5 : l'échec d'ouverture d'une session SUPERVISÉE (hôte de pty) ne doit
 * jamais être avalé. Avant : `openAttendedSession(...).then(...)` dans
 * `pendingSessions`, vidé par `Promise.allSettled` jamais lu — le plan
 * attendait un agent que personne n'avait lancé, sans un mot.
 */
const state = vi.hoisted(() => ({ open: null, applyPlan: null }));

vi.mock('../../src/pty-host.ts', () => ({
  openAttendedSession: (...args) => state.open(...args),
}));
vi.mock('../../src/orchestrator.js', () => ({
  applyPlan: (...args) => state.applyPlan(...args),
}));
vi.mock('../../src/cli/commands/start.ts', () => ({ renderStartedAgent: vi.fn() }));

const { executePlanText } = await import('../../src/cli/commands/plan.ts');

const INFO = {
  name: 'agent-a',
  path: '/clones/agent-a',
  branch: 'striart/agent-a/task-1',
  mode: 'attended',
};

function makeCtx() {
  const calls = { warn: [], step: [] };
  const out = {
    step: (message) => calls.step.push(message),
    warn: (message, hint) => calls.warn.push({ message, hint }),
    untrusted: (text) => String(text ?? ''),
    task: async (_label, fn) => fn(),
    line: () => {},
    detail: () => {},
  };
  const ctx = {
    out,
    m: en,
    cwd: '/repo',
    signal: new AbortController().signal,
    repoRoot: async () => '/repo',
  };
  return { ctx, calls };
}

/** applyPlan simulé : démarre un nœud supervisé puis attend son agent jusqu'à l'abandon. */
function waitingPlan() {
  return async ({ onProgress, signal }) => {
    onProgress({ type: 'node-started', nodeId: 'a', kind: 'task', info: INFO });
    await new Promise((resolve) => {
      if (signal.aborted) resolve();
      else signal.addEventListener('abort', () => resolve(), { once: true });
    });
    return {
      version: 2,
      dryRun: false,
      tasks: [],
      results: [],
      nodes: [],
      interrupted: signal.aborted,
      notApplied: signal.aborted ? [{ id: 'a', agent: 'agent-a' }] : [],
    };
  };
}

describe('plan / orchestrate : échec d’ouverture d’une session supervisée (C-I5)', () => {
  beforeEach(() => {
    state.open = null;
    state.applyPlan = null;
  });

  it('un hôte de pty qui ne démarre pas est signalé avec son code, interrompt le plan et le fait échouer', async () => {
    state.open = async () => {
      throw new StriartError('The pty host of "agent-a" did not become ready in time.', {
        code: 'PTY_HOST_SPAWN_FAILED',
        details: { agent: 'agent-a', reason: 'TIMEOUT', logFile: null },
        hint: 'striart doctor',
      });
    };
    let seenSignal = null;
    const plan = waitingPlan();
    state.applyPlan = async (args) => {
      seenSignal = args.signal;
      return plan(args);
    };
    const { ctx, calls } = makeCtx();

    const result = await executePlanText(ctx, { text: 'x', file: 'p.yaml', dryRun: false });

    // Visible tout de suite, avec le code et la piste.
    expect(calls.warn).toHaveLength(1);
    expect(calls.warn[0].message).toContain('agent-a');
    expect(calls.warn[0].message).toContain('PTY_HOST_SPAWN_FAILED');
    expect(calls.warn[0].hint).toBe('striart doctor');
    // Le plan n'attend pas un agent que personne n'a lancé.
    expect(seenSignal.aborted).toBe(true);
    expect(result.outcome).toBe('failed');
    expect(result.data.sessionFailures).toEqual([
      { agent: 'agent-a', code: 'PTY_HOST_SPAWN_FAILED' },
    ]);
    expect(result.warnings).toEqual([expect.objectContaining({ code: 'PTY_HOST_SPAWN_FAILED' })]);
  });

  it('une erreur non Striart est aussi signalée (UNEXPECTED), jamais avalée', async () => {
    state.open = async () => {
      throw new Error('spawn EACCES');
    };
    state.applyPlan = waitingPlan();
    const { ctx, calls } = makeCtx();

    const result = await executePlanText(ctx, { text: 'x', file: 'p.yaml', dryRun: false });

    expect(calls.warn).toHaveLength(1);
    expect(calls.warn[0].message).toContain('spawn EACCES');
    expect(result.outcome).toBe('failed');
    expect(result.data.sessionFailures[0]).toEqual({ agent: 'agent-a', code: 'UNEXPECTED' });
  });

  it('session ouverte : ni avertissement ni interruption', async () => {
    const session = { agentCommand: 'claude', terminal: null };
    state.open = async () => session;
    let seenSignal = null;
    state.applyPlan = async ({ onProgress, signal }) => {
      seenSignal = signal;
      onProgress({ type: 'node-started', nodeId: 'a', kind: 'task', info: INFO });
      await new Promise((resolve) => setTimeout(resolve, 5));
      return { version: 2, dryRun: false, tasks: [], results: [], nodes: [], notApplied: [] };
    };
    const { ctx, calls } = makeCtx();

    const result = await executePlanText(ctx, { text: 'x', file: 'p.yaml', dryRun: false });

    expect(calls.warn).toEqual([]);
    expect(seenSignal.aborted).toBe(false);
    expect(result.outcome).toBe('ok');
    expect(result.data.sessions['agent-a']).toBe(session);
    expect(result.data.sessionFailures).toEqual([]);
    expect(result.warnings ?? []).toEqual([]);
  });

  it('Ctrl+C de l’utilisateur reste propagé au plan (signal composé)', async () => {
    const controller = new AbortController();
    state.open = async () => ({ agentCommand: 'claude', terminal: null });
    state.applyPlan = async ({ signal }) => {
      controller.abort();
      return {
        version: 2,
        dryRun: false,
        tasks: [],
        results: [],
        nodes: [],
        interrupted: signal.aborted,
        notApplied: [],
      };
    };
    const { ctx } = makeCtx();
    ctx.signal = controller.signal;

    const result = await executePlanText(ctx, { text: 'x', file: 'p.yaml', dryRun: false });

    expect(result.data.interrupted).toBe(true);
  });
});

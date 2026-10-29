import { beforeEach, describe, expect, it, vi } from 'vitest';
import { en } from '../../src/cli/i18n/en.ts';
import { fr } from '../../src/cli/i18n/fr.ts';

/**
 * Commande `striart gc` : issue (0 / 1 / 3) et rendu. Le balayage est simulé — sa logique
 * est couverte par idle-classify.test.js et tests/integration/idle-*.test.js.
 */
const state = vi.hoisted(() => ({ sweep: null, calls: [] }));

vi.mock('../../src/clone.js', () => ({ assertInitialized: async () => {} }));
vi.mock('../../src/idle/sweep.ts', () => ({
  sweepIdle: async (options) => {
    state.calls.push(options);
    return state.sweep(options);
  },
}));

const { gc } = await import('../../src/cli/commands/gc.ts');

function makeCtx(m = en) {
  const lines = [];
  const out = {
    line: (level, text) => lines.push({ level, text }),
    detail: (text) => lines.push({ level: 'detail', text }),
    hint: (text) => lines.push({ level: 'hint', text }),
    untrusted: (t) => String(t ?? ''),
    date: (d) => String(d),
    duration: (ms) => `${Math.round(ms / 60_000)}min`,
    task: async (_label, fn) => fn(),
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

const agent = (overrides = {}) => ({
  agent: 'agent-a',
  state: 'idle',
  stage: 'idle',
  session: 'live',
  host: 'process',
  idleMs: 3 * 3_600_000,
  lastActivityAt: null,
  lastActivitySignal: null,
  reasons: [],
  blockers: [],
  plan: 'none',
  closable: false,
  closeBlockedBy: [],
  warnedAt: null,
  closeNotBefore: null,
  signals: [],
  worktreeSkipped: false,
  ...overrides,
});

const report = (overrides = {}) => ({
  generatedAt: '2026-10-27T12:00:00.000Z',
  dryRun: false,
  enabled: true,
  action: 'report',
  closeAuthorized: false,
  authorizationError: null,
  forced: false,
  suspended: false,
  holds: [],
  thresholds: { warnAfterMs: 1, closeAfterMs: 2, graceMs: 1 },
  agents: [agent()],
  warned: [],
  closed: [],
  refused: [],
  ...overrides,
});

beforeEach(() => {
  state.sweep = null;
  state.calls = [];
});

describe('gc : issue de la commande', () => {
  const input = { agent: null, close: false, dryRun: false };

  it('rien refusé : sortie 0', async () => {
    state.sweep = () => report();
    expect((await gc.execute(makeCtx().ctx, input)).outcome).toBe('ok');
  });

  it('fermeture REFUSÉE par une garde (session intacte) : refus, sortie 3', async () => {
    state.sweep = () =>
      report({
        refused: [
          { agent: 'agent-a', host: 'process', code: 'IDLE_CLOSE_UNVERIFIED', detail: 'IDENTITY' },
        ],
      });
    expect((await gc.execute(makeCtx().ctx, input)).outcome).toBe('refused');
  });

  it('fermeture ÉCHOUÉE : échec, sortie 1 (prime sur le refus)', async () => {
    state.sweep = () =>
      report({
        refused: [
          { agent: 'agent-a', host: 'process', code: 'IDLE_CLOSE_UNVERIFIED', detail: null },
          { agent: 'agent-b', host: 'acp', code: 'IDLE_CLOSE_FAILED', detail: 'STILL_ALIVE' },
        ],
      });
    expect((await gc.execute(makeCtx().ctx, input)).outcome).toBe('failed');
  });

  it('transmet agent, close et dry-run au balayage, sur la racine du dépôt', async () => {
    state.sweep = () => report();
    await gc.execute(makeCtx().ctx, { agent: 'agent-a', close: true, dryRun: true });
    expect(state.calls).toEqual([{ root: '/repo', agent: 'agent-a', close: true, dryRun: true }]);
  });
});

describe('gc : rendu', () => {
  it.each([
    ['en', en, /idle for 180min/, /1 idle agent, 0 warned, 0 sessions closed/],
    ['fr', fr, /inactif depuis 180min/, /1 agent inactif, 0 averti, 0 session fermée/],
  ])('rendu %s : état, durée, résumé', (_lang, catalogue, lineRe, summaryRe) => {
    const { ctx, lines } = makeCtx(catalogue);
    gc.render(ctx, { data: report(), outcome: 'ok' });
    const text = lines.map((l) => l.text).join('\n');
    expect(text).toMatch(lineRe);
    expect(text).toMatch(summaryRe);
  });

  it('désactivé : le dit, ne liste rien', () => {
    const { ctx, lines } = makeCtx();
    gc.render(ctx, { data: report({ enabled: false, agents: [] }), outcome: 'ok' });
    expect(lines).toHaveLength(1);
    expect(lines[0].text).toBe(en.gc.disabled);
  });

  it('dry-run : annonce ce qui serait fait et propose la commande réelle', () => {
    const { ctx, lines } = makeCtx();
    gc.render(ctx, {
      data: report({ dryRun: true, agents: [agent({ plan: 'warn' })] }),
      outcome: 'ok',
    });
    const text = lines.map((l) => l.text).join('\n');
    expect(text).toContain(en.gc.wouldWarn('agent-a'));
    expect(lines.some((l) => l.level === 'hint' && l.text === 'striart gc')).toBe(true);
  });

  it('action close sans autorisation utilisateur : le dit explicitement', () => {
    const { ctx, lines } = makeCtx();
    gc.render(ctx, {
      data: report({ action: 'close', closeAuthorized: false }),
      outcome: 'ok',
    });
    expect(lines.map((l) => l.text)).toContain(en.gc.notAuthorized);
  });

  it('refus rendu en erreur, avec le code et le motif ; fermeture rendue en succès', () => {
    const { ctx, lines } = makeCtx();
    gc.render(ctx, {
      data: report({
        closed: [{ agent: 'agent-b', host: 'acp', code: 'CLOSED' }],
        refused: [
          { agent: 'agent-a', host: 'process', code: 'IDLE_CLOSE_UNVERIFIED', detail: 'IDENTITY' },
        ],
      }),
      outcome: 'refused',
    });
    expect(lines.find((l) => l.level === 'error').text).toContain('IDLE_CLOSE_UNVERIFIED');
    expect(lines.find((l) => l.level === 'ok').text).toContain('closed cleanly');
  });

  it('un agent protégé est expliqué par ses gardes, un agent actif par ses signaux', () => {
    const { ctx, lines } = makeCtx();
    gc.render(ctx, {
      data: report({
        agents: [
          agent({
            agent: 'p',
            state: 'protected',
            stage: 'protected',
            blockers: ['HUMAN_REQUEST'],
          }),
          agent({
            agent: 'a',
            state: 'active',
            stage: 'active',
            reasons: ['SIGNAL_UNKNOWN:refs'],
          }),
        ],
      }),
      outcome: 'ok',
    });
    const text = lines.map((l) => l.text).join('\n');
    expect(text).toContain('HUMAN_REQUEST');
    expect(text).toContain('SIGNAL_UNKNOWN:refs');
  });
});

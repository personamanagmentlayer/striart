import { beforeEach, describe, expect, it, vi } from 'vitest';
import { en } from '../../src/cli/i18n/en.ts';
import { fr } from '../../src/cli/i18n/fr.ts';

/**
 * Lot « suites sécurité / revue CLI » :
 *  - dashboard : l'URL affichée et publiée est celle du serveur
 *    (`server.striart.baseUrl`), pas un `localhost` codé en dur — en mode
 *    `dashboardHostname: 'instance'` le localhost renvoie 403 ;
 *  - resolve : `--accept-theirs <chemin>` (répétable, validé) →
 *    prepareResolutionScaffold, chemins retenus (`held`) affichés.
 */
const state = vi.hoisted(() => ({
  published: [],
  scaffoldCalls: [],
  baseUrl: 'http://striart-ab12cd.localhost:4567',
}));

vi.mock('../../src/clone.js', () => ({ assertInitialized: async () => {} }));
vi.mock('../../src/daemon.js', () => ({
  dashboardDaemonStatus: async () => ({ running: false, url: null }),
  publishDaemonInfo: async (args) => {
    state.published.push(args);
  },
  daemonStopSignal: ({ signal }) => ({ signal, dispose: () => {} }),
  releaseDaemonPidFile: async () => {},
  startDashboardDaemon: async () => ({}),
  stopDashboardDaemon: async () => ({}),
}));
vi.mock('../../src/dashboard.js', () => ({
  startDashboard: async () => ({
    address: () => ({ port: 4567 }),
    close: (cb) => cb(),
    striart: {
      baseUrl: state.baseUrl,
      signInUrl: () => ({
        url: `${state.baseUrl}/auth?code=x`,
        expiresAt: '2030-01-01T00:00:00Z',
      }),
    },
  }),
}));
vi.mock('../../src/conflicts.js', async (importOriginal) => ({
  ...(await importOriginal()),
  prepareResolutionScaffold: async (...args) => {
    state.scaffoldCalls.push(args);
    return [];
  },
}));

const { dashboard } = await import('../../src/cli/commands/dashboard.ts');
const { resolve } = await import('../../src/cli/commands/resolve.ts');
const { buildProgram } = await import('../../src/cli/program.ts');

function makeCtx() {
  const lines = [];
  const events = [];
  const controller = new AbortController();
  const out = {
    line: (level, text, hint) => lines.push({ level, text, hint }),
    detail: () => {},
    print: () => {},
    hint: () => {},
    event: (e) => events.push(e),
    date: (d) => String(d),
    untrusted: (t) => String(t ?? ''),
    task: async (_l, fn) => fn(),
  };
  const ctx = {
    out,
    m: en,
    json: false,
    command: 'dashboard',
    cwd: '/repo',
    signal: controller.signal,
    repoRoot: async () => '/repo',
  };
  return { ctx, lines, events, controller };
}

const SERVE = { port: null, daemon: false, stop: false, status: false, link: false };

async function serveUntilAbort(ctx, controller) {
  const pending = dashboard.execute(ctx, SERVE);
  setTimeout(() => controller.abort(), 30);
  return pending;
}

beforeEach(() => {
  state.published.length = 0;
  state.scaffoldCalls.length = 0;
  delete process.env.STRIART_DAEMON;
});

describe('dashboard : l’URL vient du serveur (baseUrl), jamais de localhost codé en dur', () => {
  it('affiche et renvoie server.striart.baseUrl', async () => {
    const { ctx, lines, controller } = makeCtx();
    const result = await serveUntilAbort(ctx, controller);
    expect(result.data.url).toBe(state.baseUrl);
    expect(lines.some((l) => l.text.includes(state.baseUrl))).toBe(true);
    expect(lines.some((l) => l.text.includes('http://localhost:4567'))).toBe(false);
  });

  it('daemon : publie baseUrl dans les infos du daemon (lues par --status et le parent)', async () => {
    process.env.STRIART_DAEMON = '1';
    const { ctx, controller } = makeCtx();
    await serveUntilAbort(ctx, controller);
    expect(state.published).toHaveLength(1);
    expect(state.published[0].patch.url).toBe(state.baseUrl);
  });

  it('--json : l’événement listening porte baseUrl et le port réel', async () => {
    const { ctx, events, controller } = makeCtx();
    ctx.json = true;
    await serveUntilAbort(ctx, controller);
    expect(events[0].data.url).toBe(state.baseUrl);
    expect(events[0].data.port).toBe(4567);
  });
});

describe('resolve --accept-theirs', () => {
  const base = { unlock: false, close: null, prepare: 't-1', apply: null, all: false };

  it('passe les chemins à prepareResolutionScaffold', async () => {
    const { ctx } = makeCtx();
    await resolve.execute(ctx, { ...base, acceptTheirs: ['a.js', 'b/c.js'] });
    expect(state.scaffoldCalls).toEqual([['/repo', 't-1', { acceptTheirs: ['a.js', 'b/c.js'] }]]);
  });

  it('sans --prepare : usage refusé (OPTION_CONFLICT), rien n’est appelé', async () => {
    const { ctx } = makeCtx();
    await expect(
      resolve.execute(ctx, { ...base, prepare: null, apply: 't-1', acceptTheirs: ['a.js'] }),
    ).rejects.toMatchObject({ code: 'OPTION_CONFLICT' });
    expect(state.scaffoldCalls).toHaveLength(0);
  });

  it('affiche les chemins retenus (held) avec la commande exacte pour les accepter', () => {
    const { ctx, lines } = makeCtx();
    const files = [
      { path: 'a.js', created: true, source: 'theirs' },
      { path: '.github/workflows/ci.yml', created: false, source: null, held: true },
    ];
    resolve.render(ctx, { data: { action: 'prepare', ticketId: 't-1', files } });
    const held = lines.find((l) => l.text.includes('.github/workflows/ci.yml'));
    expect(held.level).toBe('warn');
    expect(held.hint).toContain('--accept-theirs');
    expect(held.hint).toContain('t-1');
    expect(held.text).not.toBe(en.resolve.alreadyPrepared('.github/workflows/ci.yml'));
  });

  it('i18n fr et en : held défini des deux côtés', () => {
    expect(typeof en.resolve.held('x')).toBe('string');
    expect(typeof fr.resolve.held('x')).toBe('string');
  });
});

describe('program : --accept-theirs répétable et validé positivement', () => {
  const caps = { colorStdout: false, colorStderr: false, columns: 100 };
  async function parse(args) {
    const calls = [];
    const program = buildProgram({
      m: en,
      caps,
      version: '0.0.0',
      dispatch: async (name, _loader, input) => {
        calls.push({ name, input });
      },
    });
    await program.parseAsync(['node', 'striart', ...args]);
    return calls;
  }

  it('répétable, transmis tel quel', async () => {
    const calls = await parse([
      'resolve',
      '--prepare',
      'agent-a-f72c4ba9',
      '--accept-theirs',
      'src/a.js',
      '--accept-theirs',
      'docs/b.md',
    ]);
    expect(calls[0].input.acceptTheirs).toEqual(['src/a.js', 'docs/b.md']);
  });

  it('défaut : liste vide', async () => {
    const calls = await parse(['resolve']);
    expect(calls[0].input.acceptTheirs).toEqual([]);
  });

  it.each(['../etc/passwd', '/abs/path', 'C:/x', ' ', 'a/../../b', 'a\\..\\b'])(
    'chemin invalide %j : erreur d’usage commander (sortie 2)',
    async (bad) => {
      await expect(
        parse(['resolve', '--prepare', 'agent-a-f72c4ba9', '--accept-theirs', bad]),
      ).rejects.toMatchObject({ code: 'commander.invalidArgument' });
    },
  );

  it('incompatible avec --apply / --close / --unlock / --all', async () => {
    for (const other of [
      ['--apply', 'agent-a-f72c4ba9'],
      ['--close', 'agent-a-f72c4ba9'],
      ['--unlock'],
      ['--all'],
    ]) {
      await expect(parse(['resolve', '--accept-theirs', 'a.js', ...other])).rejects.toMatchObject({
        code: 'commander.conflictingOption',
      });
    }
  });
});

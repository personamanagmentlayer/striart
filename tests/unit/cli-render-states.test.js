import { describe, expect, it } from 'vitest';
import { detectCapabilities } from '../../src/cli/caps.ts';
import { fr } from '../../src/cli/i18n/fr.ts';
import { Output } from '../../src/cli/output.ts';
import { status } from '../../src/cli/commands/status.ts';
import { queue } from '../../src/cli/commands/queue.ts';

/**
 * Les sorties non interactives parlent le même langage que le cockpit
 * `watch --ui` : un état = glyphe + mot (+ ton), tableaux qui se replient.
 */
function ctxFor({ env = {}, columns = null, plain = false } = {}) {
  const chunks = [];
  const sink = { write: (c) => chunks.push(c), isTTY: false };
  const caps = detectCapabilities({
    env: { LANG: 'fr_FR.UTF-8', ...env, ...(columns ? { COLUMNS: String(columns) } : {}) },
    platform: 'linux',
    stdout: { isTTY: false },
    stderr: { isTTY: false },
    stdin: { isTTY: false },
    plain,
    color: null,
  });
  const out = new Output({
    caps,
    messages: fr,
    stdout: sink,
    stderr: sink,
    quiet: false,
    json: false,
  });
  return { ctx: { out, m: fr, caps }, text: () => chunks.join('') };
}

const agent = (name, over = {}) => ({
  name,
  status: 'ACTIVE',
  mode: 'attended',
  session: { state: 'running', via: 'pty', pid: 4242 },
  pendingCommits: 0,
  branch: `striart/${name}/task-1`,
  currentBranch: `striart/${name}/task-1`,
  lastMessage: 'chore: x',
  command: null,
  sizeBytes: 1000,
  ...over,
});

const DATA = {
  agents: [
    agent('a'),
    agent('b', { session: { state: 'idle', via: null, pid: null } }),
    agent('c'),
    agent('d', { status: 'MISSING' }),
  ],
  tickets: [{ id: 't1', agent: 'c', reason: 'GATE_FAILED' }],
  state: { manualMode: false },
  queue: [],
  daemon: { running: true },
  mainSession: null,
  orchestration: { runs: [], reviews: [] },
};

describe('striart status : vocabulaire d’état partagé avec le cockpit', () => {
  it('chaque agent porte glyphe + mot : ● ACTIVE, ○ ACTIVE (inactif), ✗ TICKET, ✗ MISSING', () => {
    const { ctx, text } = ctxFor();
    status.render(ctx, { data: DATA });
    const out = text();
    expect(out).toMatch(/a\s+● ACTIVE/);
    expect(out).toMatch(/b\s+○ ACTIVE/);
    expect(out).toMatch(/c\s+✗ TICKET/);
    expect(out).toMatch(/d\s+✗ MISSING/);
  });

  it('STRIART_ASCII / --plain : mêmes états en ASCII pur, sans couleur', () => {
    for (const opts of [{ env: { STRIART_ASCII: '1' } }, { plain: true }]) {
      const { ctx, text } = ctxFor(opts);
      status.render(ctx, { data: DATA });
      const out = text();
      expect(out).toMatch(/a\s+\* ACTIVE/);
      expect(out).toMatch(/b\s+o ACTIVE/);
      expect(out).toMatch(/c\s+x TICKET/);
      expect(out).not.toMatch(/[●○✗]/u);
      // eslint-disable-next-line no-control-regex -- vérifie l'absence de séquences de style
      expect(out).not.toMatch(/\u001b\[/);
    }
  });

  it('NO_COLOR : aucune séquence de style, l’état reste lisible', () => {
    const { ctx, text } = ctxFor({ env: { NO_COLOR: '1', FORCE_COLOR: '1' } });
    status.render(ctx, { data: DATA });
    // eslint-disable-next-line no-control-regex -- vérifie l'absence de séquences de style
    expect(text()).not.toMatch(/\u001b\[/);
    expect(text()).toContain('✗ TICKET');
  });

  it('terminal étroit : aucune ligne ne déborde, l’identifiant et l’état restent', () => {
    const { ctx, text } = ctxFor({ columns: 50 });
    status.render(ctx, { data: DATA });
    const lines = text()
      .split('\n')
      .filter((l) => /^(AGENT|a |b |c |d )/.test(l));
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(50);
    expect(text()).toContain('✗ TICKET');
  });
});

describe('striart queue : même langage', () => {
  it('RUNNING / WAITING portent un glyphe et un mot', () => {
    const { ctx, text } = ctxFor();
    queue.render(ctx, {
      data: {
        action: 'list',
        tasks: [
          { id: 't1', agent: 'a', status: 'RUNNING', files: [], blockedBy: [], ready: false },
          {
            id: 't2',
            agent: 'b',
            status: 'WAITING',
            files: ['x.js'],
            blockedBy: [{ agent: 'a', files: ['x.js'] }],
            ready: false,
          },
          { id: 't3', agent: 'c', status: 'WAITING', files: [], blockedBy: [], ready: true },
        ],
      },
    });
    const out = text();
    expect(out).toContain('● RUNNING');
    expect(out).toMatch(/! WAITING/);
    expect(out).toMatch(/○ WAITING/);
  });
});

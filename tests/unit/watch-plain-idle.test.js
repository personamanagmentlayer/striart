import { describe, expect, it, vi } from 'vitest';
import { PassThrough, Writable } from 'node:stream';
import { fr } from '../../src/cli/i18n/fr.ts';
import { en } from '../../src/cli/i18n/en.ts';

const agents = [
  {
    name: 'forgotten',
    status: 'ACTIVE',
    pendingCommits: 0,
    session: { state: 'idle' },
    lastMessage: 'a',
  },
  {
    name: 'fresh',
    status: 'ACTIVE',
    pendingCommits: 0,
    session: { state: 'idle' },
    lastMessage: 'b',
  },
];
const cells = vi.hoisted(() => ({ value: new Map() }));

vi.mock('../../src/clone.js', () => ({ listAgents: async () => agents, cloneGit: () => ({}) }));
vi.mock('../../src/conflicts.js', () => ({ listConflictTickets: async () => [] }));
vi.mock('../../src/config.js', () => ({ loadConfig: async () => ({ targetBranch: 'main' }) }));
vi.mock('../../src/idle/status.ts', () => ({
  createIdleCellsProvider: () => async () => cells.value,
}));

const { runWatchPlain } = await import('../../src/watch-plain.ts');

async function plainOutput(messages) {
  const chunks = [];
  const stdout = new Writable({
    write(chunk, _enc, done) {
      chunks.push(String(chunk));
      done();
    },
  });
  stdout.columns = 120;
  const stdin = new PassThrough();
  const controller = new AbortController();
  const caps = {
    unicode: false,
    colorStdout: false,
    plain: true,
    theme: 'default',
    animate: false,
  };
  const done = runWatchPlain('/repo', {
    messages,
    signal: controller.signal,
    caps,
    autoMerge: true,
    io: { stdin, stdout },
  });
  await new Promise((r) => setTimeout(r, 300));
  controller.abort();
  await done;
  return chunks.join('');
}

describe('watch --plain : inactivité (GC) dans le tableau des agents', () => {
  it('affiche « (inactif …) » après l’état de l’agent concerné seulement (fr, ASCII)', async () => {
    cells.value = new Map([['forgotten', { stage: 'warned', minutes: 75 }]]);
    const text = await plainOutput(fr);
    expect(text).toMatch(/forgotten\s+\S+ ACTIVE \(inactif 1\s?h, averti\)/);
    expect(text).not.toMatch(/fresh[^\n]*inactif/);
  });

  it('en anglais', async () => {
    cells.value = new Map([['forgotten', { stage: 'idle', minutes: 192 }]]);
    const text = await plainOutput(en);
    expect(text).toMatch(/forgotten\s+\S+ ACTIVE \(idle 3\s?h\)/);
  });

  it('sans cellule : aucune mention d’inactivité', async () => {
    cells.value = new Map();
    const text = await plainOutput(fr);
    expect(text).toContain('forgotten');
    expect(text).not.toMatch(/inactif \d/);
  });
});

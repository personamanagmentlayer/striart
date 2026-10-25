import { beforeEach, describe, expect, it, vi } from 'vitest';

const SHA = 'a'.repeat(40);
const mainRevparse = vi.fn(async () => `${SHA}\n`);
const AGENTS = ['agent-a', 'agent-b', 'agent-c'];

// Aucun git réel : seul compte le nombre de `rev-parse --verify` lancés sur
// le repo principal pendant une passe de synchronisation.
vi.mock('simple-git', () => ({ simpleGit: () => ({ revparse: mainRevparse }) }));
vi.mock('../../src/clone.js', () => ({
  assertInitialized: async () => {},
  readRegistry: async () =>
    Object.fromEntries(AGENTS.map((name) => [name, { path: `/clones/${name}` }])),
  updateAgentMeta: async () => {},
  cloneGit: () => ({
    fetch: async () => {},
    revparse: async () => `${SHA}\n`,
    raw: async () => '0\n', // à jour : UP_TO_DATE
  }),
}));
vi.mock('../../src/lock.js', () => ({ withMainLock: (_root, _op, fn) => fn() }));
vi.mock('../../src/config.js', () => ({
  loadConfig: async () => ({ targetBranch: 'main', autoStash: true }),
}));
vi.mock('../../src/events.js', () => ({ emitStriartEvent: async () => {} }));
vi.mock('../../src/memory.js', () => ({ syncMemoryToClone: async () => {} }));

const { syncAgentWithMain, syncAllAgents } = await import('../../src/sync.js');

const verifyCalls = () =>
  mainRevparse.mock.calls.filter(([args]) => Array.isArray(args) && args.includes('--verify'));

describe('syncAllAgents : branche cible vérifiée une fois par passe', () => {
  beforeEach(() => mainRevparse.mockClear());

  // Appelée après chaque merge réussi de `watch` : la vérification par agent
  // lançait N process git identiques (lents sous Windows + antivirus).
  it('un seul rev-parse --verify pour N agents', async () => {
    const results = await syncAllAgents({ root: '/repo' });
    expect(results.map((r) => r.status)).toEqual(['UP_TO_DATE', 'UP_TO_DATE', 'UP_TO_DATE']);
    expect(verifyCalls()).toHaveLength(1);
  });

  it('le sync unitaire vérifie toujours la branche (chemin direct)', async () => {
    await syncAgentWithMain({ root: '/repo', agent: 'agent-a' });
    expect(verifyCalls()).toHaveLength(1);
  });

  it('branche cible absente : la passe échoue en UNKNOWN_BRANCH, comme avant', async () => {
    mainRevparse.mockResolvedValueOnce('');
    await expect(syncAllAgents({ root: '/repo' })).rejects.toMatchObject({
      code: 'UNKNOWN_BRANCH',
    });
  });
});

import { describe, expect, it, vi } from 'vitest';

const sweepIdle = vi.fn();
vi.mock('../../src/idle/sweep.ts', () => ({ sweepIdle }));
vi.mock('../../src/idle/state.ts', () => ({ readIdleState: async () => ({ lastSweepAt: null }) }));
vi.mock('../../src/config.js', () => ({ loadConfig: async () => ({}) }));

const { createIdleCellsProvider, idleCells } = await import('../../src/idle/status.ts');

const verdict = (agent, stage, idleMs) => ({ agent, stage, idleMs });
const available = (agents, over = {}) => ({ available: true, enabled: true, agents, ...over });

describe('idleCells — ce que les vues terminal affichent', () => {
  it('ne garde que idle / warned / closable, quantifié à la minute', () => {
    const cells = idleCells(
      available([
        verdict('a', 'idle', 3 * 3_600_000 + 59_000),
        verdict('b', 'warned', 90_000),
        verdict('c', 'closable', 7_200_000),
        verdict('d', 'active', 1000),
        verdict('e', 'protected', null),
        verdict('f', 'idle', null),
      ]),
    );
    expect([...cells.entries()]).toEqual([
      ['a', { stage: 'idle', minutes: 180 }],
      ['b', { stage: 'warned', minutes: 1 }],
      ['c', { stage: 'closable', minutes: 120 }],
    ]);
  });

  it('GC indisponible ou désactivé : aucune cellule (fail closed côté affichage)', () => {
    expect(idleCells({ available: false, reason: 'X' }).size).toBe(0);
    expect(idleCells(available([verdict('a', 'idle', 9e6)], { enabled: false })).size).toBe(0);
  });
});

describe('createIdleCellsProvider — mémoïsé, ne throw pas', () => {
  it('ne refait le balayage qu’après le TTL', async () => {
    sweepIdle.mockReset();
    sweepIdle.mockResolvedValue({
      generatedAt: 'x',
      enabled: true,
      action: 'report',
      closeAuthorized: false,
      authorizationError: null,
      holds: [],
      thresholds: {},
      agents: [verdict('a', 'idle', 3_600_000)],
    });
    let t = 1000;
    const provider = createIdleCellsProvider('/repo', 15_000, () => t);
    expect((await provider([])).get('a')).toEqual({ stage: 'idle', minutes: 60 });
    t += 5_000;
    await provider([]);
    expect(sweepIdle).toHaveBeenCalledTimes(1);
    t += 15_000;
    await provider([]);
    expect(sweepIdle).toHaveBeenCalledTimes(2);
  });

  it('un balayage en échec donne une vue vide, pas une exception', async () => {
    sweepIdle.mockReset();
    sweepIdle.mockRejectedValue(Object.assign(new Error('x'), { code: 'BOOM' }));
    const provider = createIdleCellsProvider('/repo', 0, () => 1);
    expect((await provider([])).size).toBe(0);
  });
});

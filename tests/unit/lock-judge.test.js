/**
 * Jugement d'un main.lock présent (src/lock.js, `judgeLock`) — fonction pure
 * sur l'état lu, horloge et identité injectées : aucun disque, aucun process.
 *
 * Règle (revue L1, B1) : on ne casse QUE sur preuve — détenteur mort, PID
 * recyclé (identité étrangère), format hérité au-delà du TTL, contenu
 * invalide ET ancien. Un détenteur vivant dont le battement est figé n'est
 * jamais cassé par défaut (HOLDER_FROZEN) : seule l'option explicite
 * `lock.breakFrozenHolderAfterMs` le permet, après une observation active.
 */
import { describe, expect, it, vi } from 'vitest';
import { createStaleObservation, judgeLock, listTickets } from '../../src/lock.ts';
import { validateConfig } from '../../src/config.ts';

const T0 = Date.parse('2026-10-24T10:00:00.000Z');
const MIN = 60_000;

function lockAt({ beatAgoMs = 0, startedAgoMs = 0, token = 'jeton', script = 'cli.js' } = {}) {
  const info = {
    pid: 4242,
    startedAt: new Date(T0 - startedAgoMs).toISOString(),
    label: 'merge:a',
    ...(token === null
      ? {}
      : { token, heartbeatAt: new Date(T0 - beatAgoMs).toISOString(), script }),
  };
  return { state: 'ok', raw: JSON.stringify(info), info };
}

/** Sondages successifs tous les `stepMs`, horloge simulée. */
async function poll(current, mtime, { polls, stepMs = 300, deps = {} }) {
  const observation = createStaleObservation();
  let now = T0;
  let verdict;
  for (let i = 0; i < polls; i += 1) {
    verdict = await judgeLock(current, mtime, observation, {
      now: () => now,
      isAlive: () => true,
      checkInstance: async () => 'alive',
      frozenBreakAfterMs: async () => null,
      ...deps,
    });
    if (verdict.stale) return { verdict, polls: i + 1 };
    now += stepMs;
  }
  return { verdict, polls };
}

describe('judgeLock — casser seulement sur preuve', () => {
  it('détenteur mort → HOLDER_DEAD, quel que soit le battement', async () => {
    const { verdict } = await poll(lockAt(), T0, { polls: 1, deps: { isAlive: () => false } });
    expect(verdict).toEqual({ stale: true, reason: 'HOLDER_DEAD' });
  });

  it('battement frais → tenu (HELD), aucune lecture d’identité', async () => {
    const checkInstance = vi.fn();
    const { verdict } = await poll(lockAt({ beatAgoMs: 2000 }), T0 - 2000, {
      polls: 3,
      deps: { checkInstance },
    });
    expect(verdict).toMatchObject({ stale: false, reason: 'HELD' });
    expect(checkInstance).not.toHaveBeenCalled();
  });

  it('battement expiré + PID étranger → IDENTITY_FOREIGN (identité relue sans cache, heure de création comprise)', async () => {
    const checkInstance = vi.fn(async () => 'foreign');
    const current = lockAt({ beatAgoMs: 5 * MIN, startedAgoMs: 6 * MIN });
    const { verdict } = await poll(current, T0 - 5 * MIN, { polls: 1, deps: { checkInstance } });
    expect(verdict).toMatchObject({ stale: true, reason: 'IDENTITY_FOREIGN' });
    expect(checkInstance).toHaveBeenCalledWith(
      4242,
      expect.objectContaining({ scriptName: 'cli.js', startedAt: current.info.startedAt }),
      { cache: false },
    );
  });

  it.each(['alive', 'unverified'])(
    'battement expiré + identité %s → JAMAIS cassé par défaut (HOLDER_FROZEN, âge du battement rapporté)',
    async (identity) => {
      const { verdict } = await poll(lockAt({ beatAgoMs: 5 * MIN }), T0 - 5 * MIN, {
        polls: 2000, // 10 min de sondage simulé
        deps: { checkInstance: async () => identity },
      });
      expect(verdict.stale).toBe(false);
      expect(verdict.reason).toBe('HOLDER_FROZEN');
      expect(verdict.heartbeatAgeMs).toBeGreaterThanOrEqual(5 * MIN);
    },
  );

  it('identité illisible (outil système en échec) → jamais une preuve : HOLDER_FROZEN', async () => {
    const { verdict } = await poll(lockAt({ beatAgoMs: 5 * MIN }), T0 - 5 * MIN, {
      polls: 200,
      deps: {
        checkInstance: async () => {
          throw new Error('binaire natif absent');
        },
      },
    });
    expect(verdict).toMatchObject({ stale: false, reason: 'HOLDER_FROZEN' });
  });

  it('option breakFrozenHolderAfterMs : cassé seulement après 15 s d’observation ACTIVE', async () => {
    const deps = { frozenBreakAfterMs: async () => 2 * MIN };
    const { verdict, polls } = await poll(lockAt({ beatAgoMs: 5 * MIN }), T0 - 5 * MIN, {
      polls: 200,
      deps,
    });
    expect(verdict).toMatchObject({
      stale: true,
      reason: 'FROZEN_HOLDER_BROKEN',
      breakFrozenHolderAfterMs: 2 * MIN,
    });
    expect(polls * 300).toBeGreaterThanOrEqual(15_000);
  });

  it('option : un battement figé depuis MOINS que le délai configuré n’est pas cassé', async () => {
    const { verdict } = await poll(lockAt({ beatAgoMs: 2 * MIN }), T0 - 2 * MIN, {
      polls: 200,
      deps: { frozenBreakAfterMs: async () => 10 * MIN },
    });
    expect(verdict).toMatchObject({ stale: false, reason: 'HOLDER_FROZEN' });
  });

  it('veille de la machine : un saut d’horloge ne compte presque pas dans l’observation', async () => {
    const observation = createStaleObservation();
    const current = lockAt({ beatAgoMs: 5 * MIN });
    const deps = (now) => ({
      now: () => now,
      isAlive: () => true,
      checkInstance: async () => 'alive',
      frozenBreakAfterMs: async () => MIN,
    });
    // Deux sondages séparés par 10 minutes de veille.
    expect((await judgeLock(current, T0 - 5 * MIN, observation, deps(T0))).stale).toBe(false);
    const after = await judgeLock(current, T0 - 5 * MIN, observation, deps(T0 + 10 * MIN));
    expect(after.stale).toBe(false);
    expect(observation.observedMs).toBeLessThanOrEqual(1200);
  });

  it('format hérité (sans jeton) : TTL de 30 min sur le mtime, sinon tenu', async () => {
    const legacy = lockAt({ token: null });
    expect((await poll(legacy, T0 - 10 * MIN, { polls: 1 })).verdict.stale).toBe(false);
    expect((await poll(legacy, T0 - 31 * MIN, { polls: 1 })).verdict).toEqual({
      stale: true,
      reason: 'LEGACY_TTL',
    });
  });

  it('contenu invalide : débris seulement s’il est ANCIEN ; illisible (erreur de lecture) : jamais cassé', async () => {
    const invalid = { state: 'invalid', raw: '{"pid": 12' };
    expect((await poll(invalid, T0 - 2000, { polls: 1 })).verdict).toMatchObject({ stale: false });
    expect((await poll(invalid, T0 - 60_000, { polls: 1 })).verdict).toEqual({
      stale: true,
      reason: 'INVALID_CONTENT',
    });
    const unreadable = { state: 'unreadable', cause: 'EPERM' };
    expect((await poll(unreadable, T0 - 3600_000, { polls: 50 })).verdict).toMatchObject({
      stale: false,
      reason: 'LOCK_UNREADABLE',
    });
  });
});

describe('listTickets — jamais « personne devant » sur une erreur', () => {
  it('dossier absent → file vide', async () => {
    const readdir = async () => {
      throw Object.assign(new Error('absent'), { code: 'ENOENT' });
    };
    await expect(listTickets('/q', { readdir })).resolves.toEqual([]);
  });

  it('EPERM transitoire (Windows) → réessai borné, puis la vraie liste', async () => {
    let calls = 0;
    const readdir = async () => {
      calls += 1;
      if (calls < 3) throw Object.assign(new Error('occupé'), { code: 'EPERM' });
      return ['000000000002.json', 'bruit.txt', '000000000001.json'];
    };
    const list = await listTickets('/q', { readdir });
    expect(list.map((t) => t.number)).toEqual([1, 2]);
    expect(calls).toBe(3);
  });

  it('erreur durable → LOCK_IO_FAILED nommée, jamais une liste vide', async () => {
    const readdir = async () => {
      throw Object.assign(new Error('refusé'), { code: 'EACCES' });
    };
    await expect(listTickets('/q', { readdir })).rejects.toMatchObject({
      code: 'LOCK_IO_FAILED',
      details: { operation: 'readdir', cause: 'EACCES' },
    });
  });
});

describe('config lock.breakFrozenHolderAfterMs — relâchement explicite, validé', () => {
  it('null (défaut : jamais) ou entier ≥ 60 000 ms ; tout le reste est refusé', () => {
    expect(() => validateConfig({ lock: { breakFrozenHolderAfterMs: null } })).not.toThrow();
    expect(() => validateConfig({ lock: { breakFrozenHolderAfterMs: 120_000 } })).not.toThrow();
    for (const bad of [0, 1000, 59_999, '120000', 1.5, -1]) {
      expect(() => validateConfig({ lock: { breakFrozenHolderAfterMs: bad } })).toThrow(
        expect.objectContaining({
          code: 'CONFIG_INVALID',
          details: expect.objectContaining({ key: 'lock' }),
        }),
      );
    }
    expect(() => validateConfig({ lock: { inconnu: 1 } })).toThrow(
      expect.objectContaining({ code: 'CONFIG_INVALID' }),
    );
  });
});

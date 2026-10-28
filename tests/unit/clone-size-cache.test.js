import { describe, expect, it, vi } from 'vitest';
import { createSizeCache } from '../../src/clone-size-cache.ts';

// Cache des tailles de clones (décision D4) : la taille est de l'AFFICHAGE, elle
// n'a pas à être temps réel, mais son âge est toujours exposé (`computedAt`).
// Pur : horloge et mesure injectées, aucun disque.

function setup(options = {}) {
  let t = 1_000_000;
  const cache = createSizeCache({
    ttlMs: 60_000,
    minRefreshMs: 5_000,
    maxEntries: 3,
    now: () => t,
    ...options,
  });
  const measure = vi.fn(async () => ({ sizeBytes: 100, complete: true }));
  return {
    cache,
    measure,
    advance: (ms) => {
      t += ms;
    },
    clock: () => t,
  };
}

describe('createSizeCache', () => {
  it('première lecture : mesure et expose computedAt', async () => {
    const { cache, measure, clock } = setup();
    const r = await cache.get('/c/a', 'sig1', measure);
    expect(r).toEqual({ sizeBytes: 100, computedAt: clock(), cached: false });
    expect(measure).toHaveBeenCalledTimes(1);
  });

  it('signature inchangée dans le TTL : servi du cache, computedAt ancien conservé', async () => {
    const { cache, measure, advance } = setup();
    const first = await cache.get('/c/a', 'sig1', measure);
    advance(30_000);
    const second = await cache.get('/c/a', 'sig1', measure);
    expect(measure).toHaveBeenCalledTimes(1);
    expect(second).toEqual({ ...first, cached: true });
  });

  it('signature changée après le rafraîchissement minimal : remesuré', async () => {
    const { cache, measure, advance } = setup();
    await cache.get('/c/a', 'sig1', measure);
    advance(6_000);
    measure.mockResolvedValueOnce({ sizeBytes: 250, complete: true });
    const r = await cache.get('/c/a', 'sig2', measure);
    expect(measure).toHaveBeenCalledTimes(2);
    expect(r.sizeBytes).toBe(250);
    expect(r.cached).toBe(false);
  });

  it('signature changée mais entrée plus jeune que minRefreshMs : servie (borne le coût d’un clone actif)', async () => {
    const { cache, measure, advance } = setup();
    await cache.get('/c/a', 'sig1', measure);
    advance(1_000);
    const r = await cache.get('/c/a', 'sig2', measure);
    expect(measure).toHaveBeenCalledTimes(1);
    expect(r.cached).toBe(true);
  });

  it('TTL dépassé : remesuré même si la signature est identique', async () => {
    const { cache, measure, advance } = setup();
    await cache.get('/c/a', 'sig1', measure);
    advance(60_001);
    await cache.get('/c/a', 'sig1', measure);
    expect(measure).toHaveBeenCalledTimes(2);
  });

  it('horloge qui recule : l’entrée n’est pas crue', async () => {
    const { cache, measure, advance } = setup();
    await cache.get('/c/a', 'sig1', measure);
    advance(-10_000);
    await cache.get('/c/a', 'sig1', measure);
    expect(measure).toHaveBeenCalledTimes(2);
  });

  it('mesures concurrentes de la même clé : une seule mesure en vol', async () => {
    const { cache, measure } = setup();
    let release;
    measure.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ sizeBytes: 7, complete: true });
        }),
    );
    const a = cache.get('/c/a', 'sig1', measure);
    const b = cache.get('/c/a', 'sig1', measure);
    await Promise.resolve();
    release();
    const [ra, rb] = await Promise.all([a, b]);
    expect(measure).toHaveBeenCalledTimes(1);
    expect(ra.sizeBytes).toBe(7);
    expect(rb.sizeBytes).toBe(7);
  });

  it('mesure incomplète (dossier illisible) : rendue mais jamais mise en cache', async () => {
    const { cache, measure } = setup();
    measure.mockResolvedValue({ sizeBytes: 40, complete: false });
    const r1 = await cache.get('/c/a', 'sig1', measure);
    const r2 = await cache.get('/c/a', 'sig1', measure);
    expect(r1.sizeBytes).toBe(40);
    expect(r2.cached).toBe(false);
    expect(measure).toHaveBeenCalledTimes(2);
  });

  it('mesure qui lève : l’erreur remonte et rien n’est mémorisé', async () => {
    const { cache, measure } = setup();
    measure.mockRejectedValueOnce(new Error('boom'));
    await expect(cache.get('/c/a', 'sig1', measure)).rejects.toThrow('boom');
    const r = await cache.get('/c/a', 'sig1', measure);
    expect(r.cached).toBe(false);
    expect(measure).toHaveBeenCalledTimes(2);
  });

  it('invalidate retire une clé, clear toutes', async () => {
    const { cache, measure } = setup();
    await cache.get('/c/a', 'sig1', measure);
    await cache.get('/c/b', 'sig1', measure);
    cache.invalidate('/c/a');
    await cache.get('/c/a', 'sig1', measure);
    await cache.get('/c/b', 'sig1', measure);
    expect(measure).toHaveBeenCalledTimes(3);
    cache.clear();
    await cache.get('/c/b', 'sig1', measure);
    expect(measure).toHaveBeenCalledTimes(4);
  });

  it('taille bornée : au-delà de maxEntries, la plus ancienne est évincée', async () => {
    const { cache, measure, advance } = setup();
    for (const k of ['a', 'b', 'c', 'd']) {
      await cache.get(`/c/${k}`, 's', measure);
      advance(10);
    }
    expect(cache.size()).toBe(3);
    await cache.get('/c/a', 's', measure); // évincée : remesurée
    expect(measure).toHaveBeenCalledTimes(5);
  });
});

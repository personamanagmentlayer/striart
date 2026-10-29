import { describe, expect, it } from 'vitest';
import { PHASES, PhaseTimer } from '../../src/timings.ts';

/** Horloge factice : avance seulement quand le test le dit (jamais Date.now). */
function fakeClock() {
  let t = 1000;
  return { now: () => t, advance: (ms) => (t += ms) };
}

describe('PhaseTimer — durées par phase sur horloge monotone', () => {
  it('snapshot : toutes les phases présentes (0 par défaut), unité déclarée', () => {
    const timer = new PhaseTimer(fakeClock().now);
    const snap = timer.snapshot();
    expect(snap.unit).toBe('ms');
    for (const phase of PHASES) expect(snap[phase], phase).toBe(0);
    expect(snap.total).toBe(0);
  });

  it('measure cumule la durée d’une phase appelée plusieurs fois et rend la valeur de fn', async () => {
    const clock = fakeClock();
    const timer = new PhaseTimer(clock.now);
    const a = await timer.measure('gate', async () => {
      clock.advance(40);
      return 'rouge';
    });
    await timer.measure('gate', async () => clock.advance(60));
    expect(a).toBe('rouge');
    expect(timer.snapshot().gate).toBe(100);
  });

  it('measure comptabilise aussi la durée d’une fn qui throw, puis propage l’erreur', async () => {
    const clock = fakeClock();
    const timer = new PhaseTimer(clock.now);
    await expect(
      timer.measure('merge', async () => {
        clock.advance(25);
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(timer.snapshot().merge).toBe(25);
  });

  it('une phase imbriquée dans la même phase n’est pas comptée deux fois', async () => {
    const clock = fakeClock();
    const timer = new PhaseTimer(clock.now);
    await timer.measure('lockHeld', async () => {
      clock.advance(10);
      await timer.measure('lockHeld', async () => clock.advance(30));
    });
    expect(timer.snapshot().lockHeld).toBe(40);
  });

  it('total court depuis la construction ; arrondi à 0,01 ms', () => {
    const clock = fakeClock();
    const timer = new PhaseTimer(clock.now);
    clock.advance(12.3456);
    expect(timer.snapshot().total).toBe(12.35);
  });

  it('add ignore les valeurs non finies ou négatives (jamais NaN dans un --json)', () => {
    const timer = new PhaseTimer(fakeClock().now);
    timer.add('commit', Number.NaN);
    timer.add('commit', -5);
    timer.add('commit', 7);
    expect(timer.snapshot().commit).toBe(7);
  });

  it('l’horloge par défaut est monotone (performance.now), pas Date.now', () => {
    const timer = new PhaseTimer();
    const first = timer.snapshot().total;
    const second = timer.snapshot().total;
    expect(second).toBeGreaterThanOrEqual(first);
  });
});

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  STATE_LOCK_ALERT_MS,
  STATE_LOCK_BUDGET_MS,
  latencyLevel,
  median,
  measureStateLockLatency,
  boundedDirSize,
} from '../../src/doctor-perf.ts';

describe('doctor-perf — budgets documentés', () => {
  it('budget du verrou d’état : 100 ms au repos, alerte à 1 s', () => {
    expect(STATE_LOCK_BUDGET_MS).toBe(100);
    expect(STATE_LOCK_ALERT_MS).toBe(1000);
  });

  it('latencyLevel : ok / slow (> budget) / alert (> 1 s), sur la médiane ET le pire échantillon', () => {
    expect(latencyLevel({ medianMs: 5, maxMs: 40 })).toBe('ok');
    expect(latencyLevel({ medianMs: 100, maxMs: 100 })).toBe('ok');
    expect(latencyLevel({ medianMs: 101, maxMs: 120 })).toBe('slow');
    // Un seul échantillon très lent déclenche l'alerte (le tail est ce qui gèle le verrou).
    expect(latencyLevel({ medianMs: 20, maxMs: 1500 })).toBe('alert');
    expect(latencyLevel({ medianMs: 1001, maxMs: 1001 })).toBe('alert');
  });

  it('median : impair, pair, vide', () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(median([])).toBe(0);
  });
});

describe('doctor-perf — mesures bornées', () => {
  let dir;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'striart-perf-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('measureStateLockLatency : N échantillons réels, aucun fichier de sonde laissé', async () => {
    const result = await measureStateLockLatency(dir, { samples: 4 });
    expect(result.samples).toHaveLength(4);
    expect(result.timedOut).toBe(false);
    for (const ms of result.samples) expect(ms).toBeGreaterThanOrEqual(0);
    expect(result.maxMs).toBe(Math.max(...result.samples));
    // Lecture seule du point de vue de l'utilisateur : ni sonde, ni verrou résiduel.
    expect((await readdir(dir)).filter((f) => /probe|\.tmp$|state\.lock/.test(f))).toEqual([]);
  });

  it('measureStateLockLatency : borné dans le temps (verrou tenu par un autre → timedOut, pas d’attente infinie)', async () => {
    // Verrou vivant (notre PID) tenu en continu : la sonde ne l'obtient pas dans le délai.
    const { withStateLock } = await import('../../src/state-lock.ts');
    let release;
    const hold = new Promise((resolve) => (release = resolve));
    let entered;
    const inside = new Promise((resolve) => (entered = resolve));
    const holder = withStateLock(dir, async () => {
      entered();
      await hold;
    });
    await inside;
    const started = performance.now();
    // Même process : le verrou est réentrant par contexte asynchrone, la sonde (autre contexte) attend.
    const result = await measureStateLockLatency(dir, { samples: 3, deadlineMs: 300 });
    const elapsed = performance.now() - started;
    release();
    await holder;
    expect(result.timedOut).toBe(true);
    expect(elapsed).toBeLessThan(3000);
  });

  it('boundedDirSize : taille additionnelle, complet sur un petit arbre', async () => {
    await mkdir(path.join(dir, 'a', 'b'), { recursive: true });
    await writeFile(path.join(dir, 'a', 'f1'), 'x'.repeat(100));
    await writeFile(path.join(dir, 'a', 'b', 'f2'), 'y'.repeat(50));
    const result = await boundedDirSize(dir, { deadlineMs: 5000 });
    expect(result).toEqual({ sizeBytes: 150, complete: true });
  });

  it('boundedDirSize : délai dépassé → incomplet, jamais d’attente non bornée', async () => {
    for (let i = 0; i < 30; i += 1) {
      await mkdir(path.join(dir, `d${i}`));
      await writeFile(path.join(dir, `d${i}`, 'f'), 'z');
    }
    const result = await boundedDirSize(dir, { deadlineMs: 0 });
    expect(result.complete).toBe(false);
  });
});

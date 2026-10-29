import { describe, expect, it } from 'vitest';
import {
  medianOfRuns,
  parseBenchArgs,
  percentile,
  renderTable,
  summarizeRun,
} from '../../scripts/bench-merge.ts';
import { PHASES } from '../../src/timings.ts';

const timings = (over = {}) => ({
  unit: 'ms',
  ...Object.fromEntries(PHASES.map((p) => [p, 0])),
  ...over,
});

describe('bench-merge — statistiques', () => {
  it('percentile (rang le plus proche) sur échantillons triés', () => {
    const s = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    expect(percentile(s, 50)).toBe(5);
    expect(percentile(s, 95)).toBe(10);
    expect(percentile(s, 99)).toBe(10);
    expect(percentile([7], 50)).toBe(7);
    expect(percentile([], 50)).toBe(0);
  });

  it('summarizeRun : p50/p95/p99 par phase, débit, part de temps de verrou tenu', () => {
    const merges = [100, 200, 300, 400].map((gate, i) =>
      timings({ gate, lockHeld: gate + 50, lockWait: i * 10, total: gate + 80 }),
    );
    const run = summarizeRun(merges, { wallMs: 2000 });
    expect(run.merges).toBe(4);
    expect(run.throughputPerSec).toBe(2);
    expect(run.phases.gate).toEqual({ p50: 200, p95: 400, p99: 400, max: 400 });
    expect(run.phases.lockHeld.p50).toBe(250);
    // Temps de verrou tenu cumulé / durée murale : le goulot que L9 doit faire chuter.
    expect(run.lockHeldTotalMs).toBe(1000 + 200);
    expect(run.lockHeldRatio).toBeCloseTo(0.6, 5);
    for (const p of PHASES) expect(run.phases[p], p).toBeDefined();
  });

  it('medianOfRuns : médiane de chaque statistique sur plusieurs exécutions', () => {
    const mk = (gateP50, thr) => ({
      merges: 4,
      wallMs: 1000,
      throughputPerSec: thr,
      lockHeldTotalMs: 500,
      lockHeldRatio: 0.5,
      phases: Object.fromEntries(
        PHASES.map((p) => [p, { p50: p === 'gate' ? gateP50 : 0, p95: 0, p99: 0, max: 0 }]),
      ),
    });
    const med = medianOfRuns([mk(100, 1), mk(300, 3), mk(200, 2)]);
    expect(med.runs).toBe(3);
    expect(med.throughputPerSec).toBe(2);
    expect(med.phases.gate.p50).toBe(200);
  });

  it('renderTable : une ligne par phase, sans NaN', () => {
    const run = summarizeRun([timings({ gate: 10, total: 20 })], { wallMs: 100 });
    const text = renderTable(run, { gateMs: 10, agents: 1 });
    expect(text).toContain('gate');
    expect(text).toContain('lockHeld');
    expect(text).not.toMatch(/NaN|undefined/);
  });
});

describe('bench-merge — arguments', () => {
  it('défauts', () => {
    expect(parseBenchArgs([])).toMatchObject({
      agents: 4,
      rounds: 1,
      concurrency: 4,
      gateMs: 0,
      repeat: 1,
      json: false,
      gateContainer: 'process',
    });
  });

  it('valeurs explicites ; concurrency suit agents par défaut', () => {
    const a = parseBenchArgs(['--agents', '6', '--gate-ms', '1500', '--json', '--repeat', '3']);
    expect(a).toMatchObject({ agents: 6, concurrency: 6, gateMs: 1500, json: true, repeat: 3 });
    expect(parseBenchArgs(['--agents', '6', '--concurrency', '2']).concurrency).toBe(2);
  });

  it('valeurs invalides refusées (jamais ignorées)', () => {
    for (const bad of [
      ['--agents', '0'],
      ['--agents', 'x'],
      ['--gate-ms', '-1'],
      ['--rounds', '1.5'],
      ['--repeat', '0'],
      ['--gate-container', 'docker'],
      ['--inconnue'],
    ]) {
      expect(() => parseBenchArgs(bad), bad.join(' ')).toThrow();
    }
  });
});

import { describe, expect, it } from 'vitest';
import { isProcessAlive, normalizeExitCode } from '../../src/process-tree.js';

describe('normalizeExitCode', () => {
  it('replie le wrap non signé de Windows en entier signé', () => {
    // Cas réel observé : ENOENT (-4058) rendu 4294963238 par Windows.
    expect(normalizeExitCode(4294963238)).toBe(-4058);
    // STATUS_CONTROL_C_EXIT (0xC000013A), le Ctrl+C de Windows.
    expect(normalizeExitCode(0xc000013a)).toBe(-1073741510);
  });

  it('laisse les codes ordinaires intacts — 0 reste 0', () => {
    expect(normalizeExitCode(0)).toBe(0);
    expect(normalizeExitCode(1)).toBe(1);
    expect(normalizeExitCode(255)).toBe(255);
    expect(normalizeExitCode(-4058)).toBe(-4058);
    // Borne : le plus grand int32 positif ne doit pas être replié.
    expect(normalizeExitCode(0x7fffffff)).toBe(0x7fffffff);
  });

  it('normalise l’absence de code (process tué par signal) en null', () => {
    expect(normalizeExitCode(null)).toBe(null);
    expect(normalizeExitCode(undefined)).toBe(null);
  });
});

describe('isProcessAlive', () => {
  it('vrai pour le process courant, faux pour un PID invalide', () => {
    expect(isProcessAlive(process.pid)).toBe(true);
    expect(isProcessAlive(null)).toBe(false);
    expect(isProcessAlive(0)).toBe(false);
    expect(isProcessAlive(-1)).toBe(false);
  });
});

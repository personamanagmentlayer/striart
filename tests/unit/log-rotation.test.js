import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, validateConfig } from '../../src/config.ts';
import {
  DEFAULT_LOG_GENERATIONS,
  DEFAULT_LOG_MAX_BYTES,
  isValidRotation,
} from '../../src/log-rotation.ts';

describe('rotation des journaux — configuration validée', () => {
  it('défauts sûrs exposés par la config', () => {
    expect(DEFAULT_CONFIG.logMaxBytes).toBe(DEFAULT_LOG_MAX_BYTES);
    expect(DEFAULT_CONFIG.logGenerations).toBe(DEFAULT_LOG_GENERATIONS);
    expect(isValidRotation(DEFAULT_LOG_MAX_BYTES, DEFAULT_LOG_GENERATIONS)).toBe(true);
  });

  it('bornes : 64 Kio..1 Gio, 1..100 générations, entiers seulement', () => {
    expect(() => validateConfig({ logMaxBytes: 64 * 1024, logGenerations: 1 })).not.toThrow();
    for (const bad of [0, 1000, 64 * 1024 - 1, 2 ** 31, 1.5, '1000000', null]) {
      expect(() => validateConfig({ logMaxBytes: bad })).toThrow();
    }
    for (const bad of [0, 101, 2.5, '5', null]) {
      expect(() => validateConfig({ logGenerations: bad })).toThrow();
    }
  });
});

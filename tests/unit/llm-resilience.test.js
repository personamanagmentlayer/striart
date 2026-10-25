import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_LLM_RESILIENCE,
  backoffDelay,
  breakerAdmit,
  breakerFailure,
  breakerKey,
  breakerSuccess,
  isRetryableStatus,
  parseRetryAfter,
  resetCircuitBreakers,
} from '../../src/llm-resilience.ts';

afterEach(() => resetCircuitBreakers());

describe('classement des statuts HTTP', () => {
  it.each([400, 401, 403, 404, 422, 501])('%i : jamais retenté', (status) => {
    expect(isRetryableStatus(status)).toBe(false);
  });
  it.each([408, 409, 425, 429, 500, 502, 503, 504])('%i : retentable', (status) => {
    expect(isRetryableStatus(status)).toBe(true);
  });
});

describe('Retry-After', () => {
  it('secondes entières', () => expect(parseRetryAfter('7')).toBe(7000));
  it('date HTTP', () => {
    const now = Date.parse('2026-10-24T10:00:00Z');
    expect(parseRetryAfter('Sat, 24 Oct 2026 10:00:30 GMT', now)).toBe(30_000);
    expect(parseRetryAfter('Sat, 24 Oct 2026 09:00:00 GMT', now)).toBe(0);
  });
  it('absent ou illisible → null', () => {
    expect(parseRetryAfter(null)).toBeNull();
    expect(parseRetryAfter('bientôt')).toBeNull();
  });
});

describe('backoff exponentiel à gigue complète', () => {
  const cfg = { baseMs: 500, maxMs: 20_000 };
  it('tiré dans [0, plafond exponentiel]', () => {
    expect(backoffDelay(1, cfg, () => 1)).toBe(500);
    expect(backoffDelay(3, cfg, () => 1)).toBe(2000);
    expect(backoffDelay(3, cfg, () => 0)).toBe(0);
  });
  it('plafonné par maxMs', () => {
    expect(backoffDelay(20, cfg, () => 1)).toBe(20_000);
  });
  it('vraiment aléatoire par défaut (gigue)', () => {
    const spy = vi.spyOn(Math, 'random').mockReturnValue(0.5);
    expect(backoffDelay(2, cfg)).toBe(500);
    spy.mockRestore();
  });
});

describe('disjoncteur', () => {
  const cfg = { ...DEFAULT_LLM_RESILIENCE.breaker, failureThreshold: 3, cooldownMs: 1000 };
  const key = breakerKey('openai', 'https://api.example.com/v1');

  it('clé = fournisseur + hôte (jamais le chemin ni l’URL complète)', () => {
    expect(key).toBe('openai|api.example.com');
  });

  it('s’ouvre au seuil, refuse pendant le délai, admet UNE sonde ensuite', () => {
    const t0 = 1_000_000;
    expect(breakerAdmit(key, cfg, t0)).toBeNull();
    breakerFailure(key, cfg, t0);
    breakerFailure(key, cfg, t0);
    expect(breakerAdmit(key, cfg, t0)).toBeNull(); // pas encore ouvert
    breakerFailure(key, cfg, t0);
    expect(breakerAdmit(key, cfg, t0 + 100)).toBe(900); // ouvert
    expect(breakerAdmit(key, cfg, t0 + 1001)).toBeNull(); // sonde admise
    expect(breakerAdmit(key, cfg, t0 + 1002)).not.toBeNull(); // pas une deuxième
  });

  it('succès de la sonde → fermé ; échec de la sonde → rouvert', () => {
    const t0 = 5_000_000;
    for (let i = 0; i < 3; i += 1) breakerFailure(key, cfg, t0);
    expect(breakerAdmit(key, cfg, t0 + 1500)).toBeNull();
    breakerFailure(key, cfg, t0 + 1500);
    expect(breakerAdmit(key, cfg, t0 + 1600)).not.toBeNull();
    expect(breakerAdmit(key, cfg, t0 + 2600)).toBeNull();
    breakerSuccess(key);
    expect(breakerAdmit(key, cfg, t0 + 2601)).toBeNull();
  });

  it('indépendant par fournisseur', () => {
    for (let i = 0; i < 3; i += 1) breakerFailure(key, cfg, 1);
    expect(breakerAdmit(breakerKey('anthropic', 'https://api.anthropic.com'), cfg, 2)).toBeNull();
  });

  it('désactivé : toujours admis', () => {
    const off = { ...cfg, enabled: false };
    for (let i = 0; i < 10; i += 1) breakerFailure(key, off, 1);
    expect(breakerAdmit(key, off, 2)).toBeNull();
  });
});

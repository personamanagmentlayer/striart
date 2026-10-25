import { describe, expect, it } from 'vitest';
import {
  calibrateFromRecords,
  calibrationKey,
  effectiveChars,
  estimateTokens,
} from '../../src/tokens/estimate.ts';
import { costOf, lookupPrice, stalePrices } from '../../src/tokens/pricing.ts';

const OPTS = { charsPerToken: 3, safetyFactor: 1.15 };

describe('estimateur local', () => {
  it('est conservateur : jamais sous le ratio de départ, marge de prudence incluse', () => {
    const text = 'a'.repeat(3000);
    // 3000 / 3 * 1.15 = 1150
    expect(estimateTokens(text, OPTS)).toBe(1150);
  });

  it('un caractère non ASCII pèse trois caractères ASCII', () => {
    expect(effectiveChars('é')).toBe(3);
    expect(effectiveChars('ab')).toBe(2);
    expect(estimateTokens('日本語'.repeat(100), OPTS)).toBeGreaterThan(
      estimateTokens('a'.repeat(300), OPTS),
    );
  });

  it('texte vide → 0, texte non vide → au moins 1', () => {
    expect(estimateTokens('', OPTS)).toBe(0);
    expect(estimateTokens('a', OPTS)).toBeGreaterThanOrEqual(1);
  });
});

describe('calibration sur l’usage réel observé', () => {
  const rec = (promptChars, input, extra = {}) => ({
    v: 1,
    ts: '2026-10-24T10:00:00.000Z',
    role: 'router',
    provider: 'anthropic',
    model: 'm',
    agent: null,
    taskId: null,
    durationMs: 1,
    source: 'api',
    outcome: 'ok',
    estimated: false,
    input,
    output: 1,
    cacheRead: 0,
    cacheWrite: 0,
    reasoning: 0,
    costUsd: null,
    promptChars,
    ...extra,
  });

  it('un ratio par fournisseur:modèle, jamais plus optimiste que 1,5× le défaut', () => {
    const ratios = calibrateFromRecords([rec(12000, 1000), rec(12000, 1000)], 3);
    // 12 car./jeton observés : plafonné à 3 × 1,5 = 4,5
    expect(ratios.get(calibrationKey('anthropic', 'm'))).toBe(4.5);
  });

  it('un ratio plus pessimiste que le défaut est retenu (plancher 1,2)', () => {
    const ratios = calibrateFromRecords([rec(1000, 1000)], 3);
    expect(ratios.get(calibrationKey('anthropic', 'm'))).toBeCloseTo(1.2, 5);
  });

  it('ignore les relevés estimés, sans promptChars ou sans entrée', () => {
    const ratios = calibrateFromRecords(
      [
        rec(3000, 1000, { estimated: true }),
        rec(0, 1000),
        rec(3000, 0),
        rec(3000, 1000, { source: 'estimate' }),
      ],
      3,
    );
    expect(ratios.size).toBe(0);
  });
});

describe('table de prix configurable', () => {
  const pricing = {
    'anthropic:m': {
      inputPerMTok: 2,
      outputPerMTok: 10,
      cacheReadPerMTok: 0.2,
      asOf: '2026-10-01',
    },
    other: { inputPerMTok: 1, outputPerMTok: 4, asOf: '2026-01-01' },
  };
  const usage = {
    input: 1_000_000,
    output: 100_000,
    cacheRead: 1_000_000,
    cacheWrite: 0,
    reasoning: 0,
  };

  it('aucun prix en dur : modèle inconnu → coût null (jamais 0)', () => {
    expect(costOf(usage, {}, 'anthropic', 'm')).toBeNull();
    expect(lookupPrice({}, 'openai', 'gpt').priced).toBe(false);
  });

  it('provider:model l’emporte sur model seul ; cache read au tarif dédié', () => {
    // 1M×2 + 1M×0.2 + 0.1M×10 = 3.2
    expect(costOf(usage, pricing, 'anthropic', 'm')).toBeCloseTo(3.2, 6);
    expect(costOf({ ...usage, cacheRead: 0 }, pricing, 'x', 'other')).toBeCloseTo(1 + 0.4, 6);
  });

  it('cache sans tarif propre : facturé comme de l’entrée normale (surestimation prudente)', () => {
    const u = { input: 0, output: 0, cacheRead: 1_000_000, cacheWrite: 1_000_000, reasoning: 0 };
    expect(costOf(u, pricing, 'x', 'other')).toBeCloseTo(2, 6);
  });

  it('un fournisseur ollama (local) coûte 0 sans déclaration', () => {
    expect(costOf(usage, {}, 'ollama', 'llama3')).toBe(0);
  });

  it('prix périmés signalés', () => {
    const stale = stalePrices(pricing, 90, Date.parse('2026-10-24T00:00:00Z'));
    expect(stale.map((s) => s.key)).toEqual(['other']);
  });
});

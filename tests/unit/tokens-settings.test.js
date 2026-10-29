import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, validateConfig } from '../../src/config.ts';
import {
  DEFAULT_TOKENS_SETTINGS,
  isValidTokensSettings,
  resolveTokensSettings,
  tokensRelaxations,
} from '../../src/tokens/settings.ts';
import {
  DEFAULT_LLM_RESILIENCE,
  isValidLlmResilience,
  llmResilienceRelaxations,
  resolveLlmResilience,
} from '../../src/llm-resilience.ts';

describe('tokens : défauts sûrs', () => {
  it('comptabilité active, plafonds opt-in, alertes à seuils absolus', () => {
    const s = resolveTokensSettings({});
    expect(s.accounting).toBe(true);
    expect(s.budgets.enforcement).toBe('hard');
    expect(s.budgets.perDay).toEqual({ maxTokens: null, maxCostUsd: null });
    expect(s.alerts.callInputTokens).toBe(150_000);
    expect(s.pricing).toEqual({});
    expect(s.cache.roles).toEqual(['router', 'memory']);
  });

  it('fusion en profondeur : un plafond posé ne perd pas les autres défauts', () => {
    const s = resolveTokensSettings({ tokens: { budgets: { perDay: { maxTokens: 1000 } } } });
    expect(s.budgets.perDay.maxTokens).toBe(1000);
    expect(s.budgets.perDay.maxCostUsd).toBeNull();
    expect(s.budgets.warnAtRatio).toBe(0.8);
    expect(s.merger.mode).toBe('auto');
  });

  it('DEFAULT_CONFIG porte les deux clés (objets partiels vides)', () => {
    expect(DEFAULT_CONFIG.tokens).toEqual({});
    expect(DEFAULT_CONFIG.llmResilience).toEqual({});
    expect(DEFAULT_TOKENS_SETTINGS.accounting).toBe(true);
  });
});

describe('tokens : validation', () => {
  const ok = (v) => expect(isValidTokensSettings(v)).toBe(true);
  const ko = (v) => expect(isValidTokensSettings(v)).toBe(false);

  it('accepte les formes valides', () => {
    ok({});
    ok({
      budgets: {
        perCall: { maxInputTokens: 50_000, maxCostUsd: 0.5 },
        perDay: { maxTokens: 10_000_000 },
      },
    });
    ok({
      pricing: { 'anthropic:claude-x': { inputPerMTok: 2, outputPerMTok: 10, asOf: '2026-10-01' } },
    });
    ok({ router: { tree: { mode: 'compact', exclude: ['**/dist/**'] } } });
    ok({ merger: { mode: 'hunk', contextLines: 3 }, instructions: { mode: 'compact' } });
  });

  it('refuse une clé inconnue (faute de frappe sur un plafond)', () => {
    ko({ budget: {} });
    ko({ budgets: { perDay: { maxToken: 1 } } });
    ko({ budgets: { perHour: {} } });
  });

  it('refuse un prix sans date de relevé ou mal daté', () => {
    ko({ pricing: { m: { inputPerMTok: 1, outputPerMTok: 1 } } });
    ko({ pricing: { m: { inputPerMTok: 1, outputPerMTok: 1, asOf: '2026-13-45' } } });
    ko({ pricing: { m: { inputPerMTok: -1, outputPerMTok: 1, asOf: '2026-10-01' } } });
  });

  it('refuse des bornes absurdes et des motifs de glob dangereux', () => {
    ko({ budgets: { warnAtRatio: 0 } });
    ko({ budgets: { perDay: { maxTokens: 0 } } });
    ko({ estimator: { safetyFactor: 0.5 } });
    ko({ router: { tree: { exclude: ['/etc/passwd'] } } });
    ko({ router: { tree: { exclude: ['../x'] } } });
    ko({ merger: { mode: 'sometimes' } });
  });

  it('jamais de cache pour un rôle qui arbitre (judge, review)', () => {
    ko({ cache: { roles: ['judge'] } });
    ko({ cache: { roles: ['review'] } });
    ok({ cache: { roles: ['router', 'merger'] } });
  });

  it('validateConfig refuse tokens invalide avec CONFIG_INVALID et la clé seule', () => {
    expect(() => validateConfig({ tokens: { budgets: { oops: 1 } } })).toThrowError(
      expect.objectContaining({
        code: 'CONFIG_INVALID',
        details: { reason: 'INVALID_VALUE', key: 'tokens' },
      }),
    );
    expect(() => validateConfig({ llmResilience: { breaker: { nope: 1 } } })).toThrowError(
      expect.objectContaining({ code: 'CONFIG_INVALID' }),
    );
    expect(() => validateConfig({ tokens: { accounting: true } })).not.toThrow();
  });
});

describe('tokens : relâchements explicites (affichés par doctor)', () => {
  it('rien par défaut', () => {
    expect(tokensRelaxations({})).toEqual([]);
  });
  it('accounting coupé', () => {
    expect(tokensRelaxations({ tokens: { accounting: false } }).map((r) => r.key)).toEqual([
      'tokens.accounting',
    ]);
  });
  it('alert-only n’est un relâchement que si un plafond existe', () => {
    expect(tokensRelaxations({ tokens: { budgets: { enforcement: 'alert-only' } } })).toEqual([]);
    const r = tokensRelaxations({
      tokens: { budgets: { enforcement: 'alert-only', perDay: { maxTokens: 5 } } },
    });
    expect(r.map((x) => x.key)).toEqual(['tokens.budgets.enforcement']);
  });
  it('cache du Merger', () => {
    expect(
      tokensRelaxations({ tokens: { cache: { roles: ['router', 'merger'] } } }).map((r) => r.key),
    ).toEqual(['tokens.cache.roles']);
  });
});

describe('llmResilience', () => {
  it('défauts et fusion', () => {
    expect(resolveLlmResilience({})).toEqual(DEFAULT_LLM_RESILIENCE);
    expect(
      resolveLlmResilience({ llmResilience: { breaker: { cooldownMs: 1000 } } }).breaker,
    ).toEqual({
      enabled: true,
      failureThreshold: 5,
      cooldownMs: 1000,
    });
  });
  it('validation stricte', () => {
    expect(isValidLlmResilience({ backoff: { baseMs: 100 } })).toBe(true);
    expect(isValidLlmResilience({ backoff: { baseMs: 0 } })).toBe(false);
    expect(isValidLlmResilience({ breaker: { enabled: 'yes' } })).toBe(false);
    expect(isValidLlmResilience({ other: 1 })).toBe(false);
  });
  it('disjoncteur désactivé = relâchement', () => {
    expect(
      llmResilienceRelaxations({ llmResilience: { breaker: { enabled: false } } }),
    ).toHaveLength(1);
    expect(llmResilienceRelaxations({})).toEqual([]);
  });
});

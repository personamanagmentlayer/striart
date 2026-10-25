import { afterEach, describe, expect, it } from 'vitest';
import { evaluateBudgets, firstBreach, resetAlertDedup } from '../../src/tokens/budget.ts';
import { resolveTokensSettings } from '../../src/tokens/settings.ts';

const zero = { tokens: 0, costUsd: 0, unpriced: 0 };
const totals = (over = {}) => ({
  perDay: zero,
  perTask: zero,
  perAgent: zero,
  global: zero,
  ...over,
});
const ids = { agent: 'agent-a', taskId: 't1', day: '2026-10-24' };
const planned = (inputTokens, outputTokens = null, costUsd = null) => ({
  inputTokens,
  outputTokens,
  costUsd,
});
const settings = (budgets, extra = {}) => resolveTokensSettings({ tokens: { budgets, ...extra } });

afterEach(() => resetAlertDedup());

describe('evaluateBudgets', () => {
  it('aucun plafond ni dépassement de seuil absolu : aucun constat', () => {
    expect(evaluateBudgets(settings({}), totals(), planned(1000), ids)).toEqual([]);
  });

  it('par appel : entrée estimée au-delà du plafond → exceeded', () => {
    const f = evaluateBudgets(
      settings({ perCall: { maxInputTokens: 500 } }),
      totals(),
      planned(501),
      ids,
    );
    expect(f).toEqual([
      expect.objectContaining({
        scope: 'perCall',
        metric: 'inputTokens',
        level: 'exceeded',
        limit: 500,
        used: 501,
      }),
    ]);
  });

  it('par jour : cumul + appel prévu au-delà du plafond → exceeded ; en deçà du seuil → rien', () => {
    const s = settings({ perDay: { maxTokens: 1000 } });
    expect(
      evaluateBudgets(s, totals({ perDay: { ...zero, tokens: 400 } }), planned(300), ids),
    ).toEqual([]);
    const over = evaluateBudgets(
      s,
      totals({ perDay: { ...zero, tokens: 600 } }),
      planned(500),
      ids,
    );
    expect(over[0]).toMatchObject({
      scope: 'perDay',
      metric: 'tokens',
      level: 'exceeded',
      used: 1100,
    });
  });

  it('seuil d’alerte à warnAtRatio du plafond', () => {
    const s = settings({ perDay: { maxTokens: 1000 }, warnAtRatio: 0.5 });
    const f = evaluateBudgets(s, totals({ perDay: { ...zero, tokens: 450 } }), planned(100), ids);
    expect(f[0]).toMatchObject({ level: 'warn', scope: 'perDay' });
  });

  it('par tâche et par agent : seulement avec une clé connue', () => {
    const s = settings({ perTask: { maxTokens: 10 }, perAgent: { maxTokens: 10 } });
    const used = { ...zero, tokens: 50 };
    expect(
      evaluateBudgets(s, totals({ perTask: used, perAgent: used }), planned(1), {
        agent: null,
        taskId: null,
        day: ids.day,
      }),
    ).toEqual([]);
    const f = evaluateBudgets(s, totals({ perTask: used, perAgent: used }), planned(1), ids);
    expect(f.map((x) => x.scope).sort()).toEqual(['perAgent', 'perTask']);
  });

  it('coût : plafond en USD sur le jour', () => {
    const s = settings({ perDay: { maxCostUsd: 1 } });
    const f = evaluateBudgets(
      s,
      totals({ perDay: { ...zero, costUsd: 0.9 } }),
      planned(10, 10, 0.2),
      ids,
    );
    expect(f[0]).toMatchObject({ metric: 'costUsd', level: 'exceeded' });
  });

  it('seuils absolus par défaut : alerte seulement (warn), jamais bloquante', () => {
    const f = evaluateBudgets(resolveTokensSettings({}), totals(), planned(200_000), ids);
    expect(f).toEqual([
      expect.objectContaining({ scope: 'perCall', level: 'warn', metric: 'inputTokens' }),
    ]);
    expect(firstBreach(f, resolveTokensSettings({}))).toBeNull();
  });

  it('un plafond posé remplace le seuil absolu de sa portée', () => {
    const s = settings({ perCall: { maxInputTokens: 1_000_000 } });
    expect(evaluateBudgets(s, totals(), planned(200_000), ids)).toEqual([]);
  });

  it('firstBreach : plafond dur seulement en enforcement hard', () => {
    const hard = settings({ perDay: { maxTokens: 10 } });
    const f = evaluateBudgets(hard, totals({ perDay: { ...zero, tokens: 20 } }), planned(0), ids);
    expect(firstBreach(f, hard)).toMatchObject({ scope: 'perDay', limit: 10 });
    const soft = settings({ enforcement: 'alert-only', perDay: { maxTokens: 10 } });
    expect(firstBreach(f, soft)).toBeNull();
  });
});

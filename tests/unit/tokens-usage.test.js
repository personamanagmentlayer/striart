import { describe, expect, it } from 'vitest';
import {
  addUsage,
  fromAcpUsage,
  fromAnthropic,
  fromCodexTurn,
  fromGeminiStats,
  fromOllama,
  fromOpenAi,
  maxUsage,
  totalInput,
  totalTokens,
} from '../../src/tokens/usage.ts';
import { extractStreamUsage } from '../../src/agents/transcript.ts';

describe('normalisation de l’usage des fournisseurs', () => {
  it('Anthropic : input non caché + cache read + cache creation distincts', () => {
    const usage = fromAnthropic({
      input_tokens: 2048,
      cache_read_input_tokens: 1800,
      cache_creation_input_tokens: 248,
      output_tokens: 503,
    });
    expect(usage).toEqual({
      input: 2048,
      output: 503,
      cacheRead: 1800,
      cacheWrite: 248,
      reasoning: 0,
    });
    expect(totalInput(usage)).toBe(4096);
    expect(totalTokens(usage)).toBe(4599);
  });

  it('Anthropic : cache_creation détaillé par TTL quand le total est absent', () => {
    const usage = fromAnthropic({
      input_tokens: 10,
      output_tokens: 5,
      cache_creation: { ephemeral_5m_input_tokens: 148, ephemeral_1h_input_tokens: 100 },
    });
    expect(usage.cacheWrite).toBe(248);
  });

  it('OpenAI : prompt_tokens INCLUT le cache, le raisonnement est un sous-ensemble de la sortie', () => {
    const usage = fromOpenAi({
      prompt_tokens: 1000,
      completion_tokens: 300,
      prompt_tokens_details: { cached_tokens: 600 },
      completion_tokens_details: { reasoning_tokens: 200 },
    });
    expect(usage).toEqual({
      input: 400,
      output: 300,
      cacheRead: 600,
      cacheWrite: 0,
      reasoning: 200,
    });
    // Le raisonnement n'est JAMAIS ajouté une seconde fois au total.
    expect(totalTokens(usage)).toBe(1300);
  });

  it('OpenAI : un cache annoncé supérieur au prompt est borné (jamais d’entrée négative)', () => {
    const usage = fromOpenAi({
      prompt_tokens: 10,
      completion_tokens: 1,
      prompt_tokens_details: { cached_tokens: 99 },
    });
    expect(usage.input).toBe(0);
    expect(usage.cacheRead).toBe(10);
  });

  it('Ollama : prompt_eval_count / eval_count / prompt_eval_cached_count', () => {
    expect(
      fromOllama({ prompt_eval_count: 12, eval_count: 7, prompt_eval_cached_count: 4 }),
    ).toEqual({
      input: 12,
      output: 7,
      cacheRead: 4,
      cacheWrite: 0,
      reasoning: 0,
    });
  });

  it('Codex turn.completed : input_tokens inclut cached_input_tokens', () => {
    expect(
      fromCodexTurn({ input_tokens: 24763, cached_input_tokens: 24448, output_tokens: 122 }),
    ).toEqual({ input: 315, output: 122, cacheRead: 24448, cacheWrite: 0, reasoning: 0 });
  });

  it('Gemini result.stats : cached est un sous-ensemble de input_tokens', () => {
    expect(fromGeminiStats({ input_tokens: 100, output_tokens: 20, cached: 60 })).toMatchObject({
      input: 40,
      cacheRead: 60,
      output: 20,
    });
  });

  it('ACP Usage (brouillon) : inputTokens est le total d’entrée', () => {
    expect(
      fromAcpUsage({ inputTokens: 100, outputTokens: 10, cachedReadTokens: 30, thoughtTokens: 4 }),
    ).toEqual({ input: 70, output: 10, cacheRead: 30, cacheWrite: 0, reasoning: 4 });
  });

  it('tolérant : valeurs absentes, négatives ou mal typées → null, jamais d’exception', () => {
    expect(fromAnthropic(null)).toBeNull();
    expect(fromAnthropic({})).toBeNull();
    expect(fromOpenAi('x')).toBeNull();
    expect(fromOllama({ eval_count: -4 })).toBeNull();
    expect(fromCodexTurn({ input_tokens: 'beaucoup' })).toBeNull();
  });

  it('addUsage / maxUsage', () => {
    const a = { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, reasoning: 5 };
    const b = { input: 5, output: 1, cacheRead: 0, cacheWrite: 9, reasoning: 0 };
    expect(addUsage(a, b)).toEqual({
      input: 6,
      output: 3,
      cacheRead: 3,
      cacheWrite: 13,
      reasoning: 5,
    });
    expect(maxUsage(a, b)).toEqual({
      input: 5,
      output: 2,
      cacheRead: 3,
      cacheWrite: 9,
      reasoning: 5,
    });
  });
});

describe('extractStreamUsage (flux structurés d’agents)', () => {
  it('Claude assistant : usage par message, avec id (dédoublonnable)', () => {
    const ev = extractStreamUsage('claude-stream-json', {
      type: 'assistant',
      message: { id: 'msg_1', model: 'm', usage: { input_tokens: 5, output_tokens: 7 } },
    });
    expect(ev).toMatchObject({ kind: 'message', id: 'msg_1', model: 'm' });
  });

  it('Claude result : total autoritaire + coût rapporté par l’outil', () => {
    const ev = extractStreamUsage('claude-stream-json', {
      type: 'result',
      total_cost_usd: 0.0123,
      usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 10 },
    });
    expect(ev).toMatchObject({ kind: 'total', costUsd: 0.0123 });
    expect(ev.usage.cacheRead).toBe(10);
  });

  it('Codex turn.completed : usage additif', () => {
    const ev = extractStreamUsage('codex-jsonl', {
      type: 'turn.completed',
      usage: { input_tokens: 10, cached_input_tokens: 4, output_tokens: 2 },
    });
    expect(ev).toMatchObject({ kind: 'turn' });
    expect(ev.usage.input).toBe(6);
  });

  it('Gemini result.stats', () => {
    const ev = extractStreamUsage('gemini-stream-json', {
      type: 'result',
      stats: { input_tokens: 10, output_tokens: 3, cached: 2 },
    });
    expect(ev).toMatchObject({ kind: 'total', costUsd: null });
  });

  it('événements sans usage, formats génériques : null', () => {
    expect(extractStreamUsage('claude-stream-json', { type: 'system' })).toBeNull();
    expect(extractStreamUsage('ndjson', { type: 'result', usage: {} })).toBeNull();
    expect(extractStreamUsage('codex-jsonl', { type: 'turn.completed' })).toBeNull();
  });
});

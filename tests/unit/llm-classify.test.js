import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { llmGenerate, sanitizeErrorText } from '../../src/llm.js';
import { resetCircuitBreakers } from '../../src/llm-resilience.ts';

// Les attentes de backoff sont enregistrées, jamais subies.
const sleeps = vi.hoisted(() => []);
vi.mock('node:timers/promises', () => ({
  setTimeout: async (ms) => {
    sleeps.push(ms);
  },
}));

// Comptabilité coupée : ces tests portent sur le classement des erreurs, le
// backoff et le disjoncteur — pas sur le registre (voir tests/integration/tokens-*.test.js).
const BASE = { tokens: { accounting: false } };
const OLLAMA = { ...BASE, ollamaHost: 'http://localhost:11434', ollamaModel: 'm' };
const OPENAI = {
  ...BASE,
  llm: { provider: 'openai', model: 'gpt-x', baseUrl: 'https://secret-host.example/v1' },
};

const http = (status, headers = {}) => ({
  ok: false,
  status,
  headers: { get: (name) => headers[name.toLowerCase()] ?? null },
});
const okOllama = (response = 'ok', extra = {}) => ({
  ok: true,
  json: async () => ({ response, ...extra }),
});

beforeEach(() => {
  vi.stubEnv('OPENAI_API_KEY', 'sk-test');
  resetCircuitBreakers();
  sleeps.length = 0;
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('erreurs classées', () => {
  it.each([400, 401, 403, 404, 422])('HTTP %i : jamais retenté', async (status) => {
    const fetchMock = vi.fn().mockResolvedValue(http(status));
    vi.stubGlobal('fetch', fetchMock);
    await expect(
      llmGenerate({ config: OLLAMA, prompt: 'p', retries: 3, retryDelayMs: 1 }),
    ).rejects.toMatchObject({
      code: 'LLM_FAILED',
      details: expect.objectContaining({ status, attempts: 1 }),
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('HTTP 500 puis succès : retenté', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(http(500))
      .mockResolvedValueOnce(okOllama('bon'));
    vi.stubGlobal('fetch', fetchMock);
    await expect(
      llmGenerate({ config: OLLAMA, prompt: 'p', retries: 2, retryDelayMs: 1 }),
    ).resolves.toBe('bon');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('réseau en panne (TypeError) : retenté', async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(okOllama('bon'));
    vi.stubGlobal('fetch', fetchMock);
    await expect(
      llmGenerate({ config: OLLAMA, prompt: 'p', retries: 1, retryDelayMs: 1 }),
    ).resolves.toBe('bon');
  });

  it('réponse tronquée par la limite de sortie : erreur franche, jamais acceptée ni retentée', async () => {
    const fetchMock = vi.fn().mockResolvedValue(okOllama('code coupé', { done_reason: 'length' }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(
      llmGenerate({ config: OLLAMA, prompt: 'p', retries: 2, retryDelayMs: 1 }),
    ).rejects.toMatchObject({
      code: 'LLM_FAILED',
      message: expect.stringContaining('limite de longueur'),
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('OpenAI finish_reason=length : erreur franche', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ choices: [{ message: { content: 'x' }, finish_reason: 'length' }] }),
      }),
    );
    await expect(
      llmGenerate({ config: OPENAI, prompt: 'p', retries: 1, retryDelayMs: 1 }),
    ).rejects.toMatchObject({
      message: expect.stringContaining('limite de longueur'),
    });
  });

  it('Anthropic stop_reason=max_tokens : erreur franche', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'k');
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ content: [{ type: 'text', text: 'x' }], stop_reason: 'max_tokens' }),
      }),
    );
    await expect(
      llmGenerate({
        config: { ...BASE, llm: { provider: 'anthropic', model: 'm' } },
        prompt: 'p',
        retries: 0,
      }),
    ).rejects.toMatchObject({ message: expect.stringContaining('limite de longueur') });
  });
});

describe('Retry-After', () => {
  it('429 avec Retry-After : l’attente est AU MOINS celle demandée', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0); // gigue nulle : seul le plancher compte
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(http(429, { 'retry-after': '2' }))
      .mockResolvedValueOnce(okOllama('ok'));
    vi.stubGlobal('fetch', fetchMock);
    await expect(
      llmGenerate({ config: OLLAMA, prompt: 'p', retries: 1, retryDelayMs: 1 }),
    ).resolves.toBe('ok');
    expect(sleeps).toContain(2000);
  });

  it('Retry-After au-delà du maximum accepté : échec franc, pas d’attente', async () => {
    const fetchMock = vi.fn().mockResolvedValue(http(429, { 'retry-after': '3600' }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(
      llmGenerate({ config: OLLAMA, prompt: 'p', retries: 3, retryDelayMs: 1 }),
    ).rejects.toMatchObject({
      details: expect.objectContaining({ status: 429, attempts: 1 }),
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('disjoncteur par fournisseur', () => {
  it('s’ouvre après des échecs consécutifs, puis échoue immédiatement sans appel réseau', async () => {
    const config = {
      ...OLLAMA,
      llmResilience: { breaker: { failureThreshold: 2, cooldownMs: 60_000 } },
    };
    const fetchMock = vi.fn().mockResolvedValue(http(503));
    vi.stubGlobal('fetch', fetchMock);
    await expect(
      llmGenerate({ config, prompt: 'p', retries: 1, retryDelayMs: 1 }),
    ).rejects.toBeTruthy();
    const callsAfterFirst = fetchMock.mock.calls.length;
    await expect(
      llmGenerate({ config, prompt: 'p', retries: 1, retryDelayMs: 1 }),
    ).rejects.toMatchObject({
      details: expect.objectContaining({ reason: 'CIRCUIT_OPEN' }),
    });
    expect(fetchMock.mock.calls.length).toBe(callsAfterFirst);
  });

  it('une 400 (erreur de requête) n’ouvre jamais le disjoncteur', async () => {
    const config = { ...OLLAMA, llmResilience: { breaker: { failureThreshold: 2 } } };
    const fetchMock = vi.fn().mockResolvedValue(http(400));
    vi.stubGlobal('fetch', fetchMock);
    for (let i = 0; i < 4; i += 1) {
      await expect(llmGenerate({ config, prompt: 'p', retries: 0 })).rejects.toMatchObject({
        details: expect.not.objectContaining({ reason: 'CIRCUIT_OPEN' }),
      });
    }
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });
});

describe('message d’erreur sans donnée sensible', () => {
  it('ni baseUrl ni URL dans le message ni dans details ; l’hôte seul en details', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockRejectedValue(
          new TypeError('fetch failed: https://user:pw@secret-host.example/v1?key=abc'),
        ),
    );
    let error;
    try {
      await llmGenerate({ config: OPENAI, prompt: 'p', retries: 0 });
    } catch (e) {
      error = e;
    }
    const dump = JSON.stringify({ m: error.message, d: error.details });
    expect(dump).not.toContain('user:pw');
    expect(dump).not.toContain('key=abc');
    expect(dump).not.toContain('/v1');
    expect(error.details.baseUrl).toBeUndefined();
    expect(error.details.host).toBe('secret-host.example');
  });

  it('sanitizeErrorText masque les URL et les jetons ressemblant à des clés', () => {
    expect(sanitizeErrorText('POST https://a.b/c?x=1 failed with sk-abcdefghijklmnop')).toBe(
      'POST <url> failed with <redacted>',
    );
  });
});

describe('corps de requête', () => {
  it('OpenAI : max_completion_tokens sur api.openai.com, max_tokens sur un serveur compatible', async () => {
    const body = async (config) => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ choices: [{ message: { content: 'x' }, finish_reason: 'stop' }] }),
      });
      vi.stubGlobal('fetch', fetchMock);
      await llmGenerate({ config, prompt: 'p', maxOutputTokens: 100, retries: 0 });
      return JSON.parse(fetchMock.mock.calls[0][1].body);
    };
    const official = await body({ ...BASE, llm: { provider: 'openai', model: 'm' } });
    expect(official.max_completion_tokens).toBe(100);
    expect(official.max_tokens).toBeUndefined();
    const compatible = await body(OPENAI);
    expect(compatible.max_tokens).toBe(100);
  });

  it('Anthropic : préfixe stable marqué cache_control quand il dépasse le seuil, partie variable à part', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'k');
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        content: [{ type: 'text', text: 'ok' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
    });
    vi.stubGlobal('fetch', fetchMock);
    const stable = 'régles '.repeat(1200);
    await llmGenerate({
      config: { ...BASE, llm: { provider: 'anthropic', model: 'm' } },
      prompt: `${stable}Tâche : X`,
      stablePrefix: stable,
      retries: 0,
    });
    const content = JSON.parse(fetchMock.mock.calls[0][1].body).messages[0].content;
    expect(content).toEqual([
      { type: 'text', text: stable, cache_control: { type: 'ephemeral' } },
      { type: 'text', text: 'Tâche : X' },
    ]);
  });

  it('Anthropic : préfixe trop court ou cache désactivé → contenu simple', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'k');
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn' }),
    });
    vi.stubGlobal('fetch', fetchMock);
    await llmGenerate({
      config: { ...BASE, llm: { provider: 'anthropic', model: 'm' } },
      prompt: 'court Tâche',
      stablePrefix: 'court ',
      retries: 0,
    });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).messages[0].content).toBe('court Tâche');
  });
});

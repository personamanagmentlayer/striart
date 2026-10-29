/**
 * `details.causeCode` stable des échecs LLM (TRANSPORT, TIMEOUT, HTTP_4XX, HTTP_5XX, TRUNCATED,
 * FILTERED, REFUSED, INVALID_JSON, INVALID_RESPONSE) ; le catalogue anglais rend les codes et
 * garde le repli sur le texte pour une cause sans code.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { llmGenerate } from '../../src/llm.ts';
import { resetCircuitBreakers } from '../../src/llm-resilience.ts';
import { en } from '../../src/cli/i18n/en.ts';

const CONFIG = {
  tokens: { accounting: false },
  ollamaHost: 'http://localhost:11434',
  ollamaModel: 'm',
};

beforeEach(() => resetCircuitBreakers());
afterEach(() => vi.unstubAllGlobals());

async function failure(fetchImpl, extra = {}) {
  vi.stubGlobal('fetch', fetchImpl);
  try {
    await llmGenerate({ config: CONFIG, prompt: 'x', retries: 0, retryDelayMs: 1, ...extra });
  } catch (error) {
    return error;
  }
  throw new Error('llmGenerate devait échouer');
}

const reply = (status, body = {}) => ({
  ok: status < 400,
  status,
  headers: { get: () => null },
  json: async () => body,
});

describe('causeCode des échecs LLM', () => {
  it('TRANSPORT (+ causeDetail)', async () => {
    const e = await failure(
      vi
        .fn()
        .mockRejectedValue(
          Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }),
        ),
    );
    expect(e.code).toBe('LLM_FAILED');
    expect(e.details).toMatchObject({ causeCode: 'TRANSPORT', causeDetail: 'ECONNREFUSED' });
  });

  it('TIMEOUT', async () => {
    const e = await failure(
      vi.fn().mockRejectedValue(Object.assign(new Error('x'), { name: 'TimeoutError' })),
    );
    expect(e.details.causeCode).toBe('TIMEOUT');
  });

  it('HTTP_4XX et HTTP_5XX portent le statut', async () => {
    const e4 = await failure(vi.fn().mockResolvedValue(reply(401)));
    expect(e4.details).toMatchObject({ causeCode: 'HTTP_4XX', status: 401 });
    const e5 = await failure(vi.fn().mockResolvedValue(reply(503)));
    expect(e5.details).toMatchObject({ causeCode: 'HTTP_5XX', status: 503 });
  });

  it('TRUNCATED', async () => {
    const e = await failure(
      vi.fn().mockResolvedValue(reply(200, { response: 'a', done_reason: 'length' })),
    );
    expect(e.details.causeCode).toBe('TRUNCATED');
  });

  it('INVALID_JSON quand la réponse validée par transform n’est pas du JSON', async () => {
    const e = await failure(vi.fn().mockResolvedValue(reply(200, { response: 'pas du json' })), {
      transform: (text) => JSON.parse(text),
    });
    expect(e.details.causeCode).toBe('INVALID_JSON');
  });

  it('INVALID_RESPONSE quand la réponse est mal formée sans être du JSON invalide', async () => {
    const e = await failure(vi.fn().mockResolvedValue(reply(200, { autre: 1 })));
    expect(e.details.causeCode).toBe('INVALID_RESPONSE');
  });
});

describe('catalogue anglais — LLM_FAILED par code', () => {
  const say = (details) => en.errors('LLM_FAILED', { provider: 'ollama', model: 'm', ...details });

  it('rend chaque code sans le texte français', () => {
    expect(say({ causeCode: 'TRANSPORT', causeDetail: 'ECONNREFUSED', cause: 'panne' })).toContain(
      'transport failure (ECONNREFUSED)',
    );
    expect(say({ causeCode: 'TIMEOUT', cause: 'délai dépassé' })).toContain('timed out');
    expect(say({ causeCode: 'HTTP_5XX', status: 503, cause: 'x' })).toContain('HTTP 503');
    expect(say({ causeCode: 'HTTP_4XX', status: 401, cause: 'x' })).toContain('HTTP 401');
    expect(say({ causeCode: 'TRUNCATED', cause: 'x' })).toContain('output length limit');
    expect(say({ causeCode: 'FILTERED', cause: 'x' })).toContain('content_filter');
    expect(say({ causeCode: 'REFUSED', cause: 'x' })).toContain('refused');
    expect(say({ causeCode: 'INVALID_JSON', cause: 'x' })).toContain('JSON');
    expect(say({ causeCode: 'INVALID_RESPONSE', cause: 'x' })).toContain('malformed');
    expect(
      say({ causeCode: 'TRANSPORT', causeDetail: 'E', cause: 'panne de transport' }),
    ).not.toMatch(/panne/);
  });

  it('code inconnu ou absent : repli sur le texte, aucune information perdue', () => {
    expect(say({ causeCode: 'NOUVEAU_CODE', cause: 'quelque chose' })).toContain('quelque chose');
    expect(say({ cause: 'délai dépassé' })).toContain('timed out');
    expect(say({ cause: 'Ollama a répondu HTTP 503' })).toContain('Ollama answered HTTP 503');
  });
});

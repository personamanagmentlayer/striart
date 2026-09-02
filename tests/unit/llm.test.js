import { afterEach, describe, expect, it, vi } from 'vitest';
import { llmGenerate, resolveLlmConfig } from '../../src/llm.js';
import { DEFAULT_CONFIG } from '../../src/config.js';
import { StriartError } from '../../src/errors.js';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('resolveLlmConfig', () => {
  it('défaut : Ollama via ollamaModel/ollamaHost (rétro-compatibilité)', () => {
    const resolved = resolveLlmConfig(DEFAULT_CONFIG);
    expect(resolved).toMatchObject({
      provider: 'ollama',
      model: 'llama3.1:8b',
      baseUrl: 'http://localhost:11434',
      apiKey: null,
    });
  });

  it('provider openai : baseUrl et apiKeyEnv par défaut', () => {
    vi.stubEnv('OPENAI_API_KEY', 'sk-test');
    const resolved = resolveLlmConfig({ llm: { provider: 'openai', model: 'gpt-4o-mini' } });
    expect(resolved).toMatchObject({
      provider: 'openai',
      model: 'gpt-4o-mini',
      baseUrl: 'https://api.openai.com/v1',
      apiKeyEnv: 'OPENAI_API_KEY',
      apiKey: 'sk-test',
    });
  });

  it('endpoint OpenAI-compatible custom (LM Studio, vLLM...)', () => {
    const resolved = resolveLlmConfig({
      llm: {
        provider: 'openai',
        model: 'local-model',
        baseUrl: 'http://localhost:1234/v1/',
        apiKeyEnv: 'LM_KEY',
      },
    });
    expect(resolved.baseUrl).toBe('http://localhost:1234/v1'); // slash final retiré
    expect(resolved.apiKeyEnv).toBe('LM_KEY');
  });

  it('rejette un provider inconnu', () => {
    expect(() => resolveLlmConfig({ llm: { provider: 'gemini', model: 'x' } })).toThrow(
      StriartError,
    );
  });

  it('rejette un provider cloud sans modèle', () => {
    expect(() => resolveLlmConfig({ llm: { provider: 'anthropic' } })).toThrowError(
      expect.objectContaining({ code: 'LLM_CONFIG_INVALID' }),
    );
  });
});

describe('llmGenerate — provider openai', () => {
  const config = { llm: { provider: 'openai', model: 'gpt-4o-mini' } };

  it('appelle /chat/completions avec Bearer et parse la réponse', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'sk-test');
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ choices: [{ message: { content: '{"files":["a.js"]}' } }] }),
      }),
    );
    const result = await llmGenerate({ config, prompt: 'p', format: 'json' });
    expect(result).toBe('{"files":["a.js"]}');

    const [url, options] = fetch.mock.calls[0];
    expect(url).toBe('https://api.openai.com/v1/chat/completions');
    expect(options.headers.Authorization).toBe('Bearer sk-test');
    const body = JSON.parse(options.body);
    expect(body).toMatchObject({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: 'p' }],
      response_format: { type: 'json_object' },
    });
  });

  it('clé API absente → LLM_CONFIG_INVALID sans appel réseau', async () => {
    vi.stubEnv('OPENAI_API_KEY', '');
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(llmGenerate({ config, prompt: 'p', retries: 0 })).rejects.toMatchObject({
      code: 'LLM_CONFIG_INVALID',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('llmGenerate — provider azure', () => {
  const config = {
    llm: {
      provider: 'azure',
      model: 'mon-deploiement',
      baseUrl: 'https://ma-ressource.openai.azure.com',
    },
  };

  it('exige baseUrl (endpoint de la ressource)', () => {
    expect(() => resolveLlmConfig({ llm: { provider: 'azure', model: 'x' } })).toThrowError(
      expect.objectContaining({ code: 'LLM_CONFIG_INVALID' }),
    );
  });

  it('URL par deployment + api-version + header api-key', async () => {
    vi.stubEnv('AZURE_OPENAI_API_KEY', 'azkey');
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ choices: [{ message: { content: 'ok' } }] }),
      }),
    );
    const result = await llmGenerate({ config, prompt: 'p', format: 'json' });
    expect(result).toBe('ok');

    const [url, options] = fetch.mock.calls[0];
    expect(url).toBe(
      'https://ma-ressource.openai.azure.com/openai/deployments/mon-deploiement/chat/completions?api-version=2024-10-21',
    );
    expect(options.headers['api-key']).toBe('azkey');
    expect(options.headers.Authorization).toBeUndefined(); // pas de Bearer chez Azure
    expect(JSON.parse(options.body).response_format).toEqual({ type: 'json_object' });
  });

  it('apiVersion surchargable', () => {
    vi.stubEnv('AZURE_OPENAI_API_KEY', 'azkey');
    const resolved = resolveLlmConfig({
      llm: { ...config.llm, apiVersion: '2025-01-01-preview' },
    });
    expect(resolved.apiVersion).toBe('2025-01-01-preview');
  });
});

describe('llmGenerate — provider anthropic', () => {
  const config = { llm: { provider: 'anthropic', model: 'claude-haiku-4-5-20251001' } };

  it('appelle /v1/messages avec x-api-key et parse content[0].text', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-test');
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ content: [{ type: 'text', text: 'const merged = 1;' }] }),
      }),
    );
    const result = await llmGenerate({ config, prompt: 'fusionne' });
    expect(result).toBe('const merged = 1;');

    const [url, options] = fetch.mock.calls[0];
    expect(url).toBe('https://api.anthropic.com/v1/messages');
    expect(options.headers['x-api-key']).toBe('sk-ant-test');
    expect(options.headers['anthropic-version']).toBeDefined();
    const body = JSON.parse(options.body);
    expect(body.messages).toEqual([{ role: 'user', content: 'fusionne' }]);
    expect(body.max_tokens).toBeGreaterThan(0);
  });

  it('erreur HTTP → retry puis échec avec le code fourni', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-test');
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 429 });
    vi.stubGlobal('fetch', fetchMock);
    await expect(
      llmGenerate({ config, prompt: 'p', retries: 1, retryDelayMs: 1, errorCode: 'ROUTER_FAILED' }),
    ).rejects.toMatchObject({ code: 'ROUTER_FAILED' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('fillPromptTemplate', () => {
  it('substitue toutes les occurrences de chaque placeholder', async () => {
    const { fillPromptTemplate } = await import('../../src/llm.js');
    expect(fillPromptTemplate('{{a}} et {{b}} puis {{a}}', { a: 'X', b: 'Y' })).toBe(
      'X et Y puis X',
    );
  });

  it('la valeur est de la donnée : $&, $1 et {{...}} n’y sont pas interprétés', async () => {
    const { fillPromptTemplate } = await import('../../src/llm.js');
    // Un contenu de fichier peut contenir n'importe quoi — y compris des
    // séquences spéciales de String.replace et d'autres moustaches.
    expect(fillPromptTemplate('code: {{code}}', { code: 'a $& b $1 c {{code}}' })).toBe(
      'code: a $& b $1 c {{code}}',
    );
  });
});

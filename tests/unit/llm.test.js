import { afterEach, describe, expect, it, vi } from 'vitest';
import { llmGenerate, resolveLlmConfig, unwrapJsonResponse } from '../../src/llm.js';
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

  it('M8 : le nom de deployment et l’apiVersion sont encodés dans l’URL (aucune réécriture du chemin ni de la requête)', async () => {
    vi.stubEnv('AZURE_OPENAI_API_KEY', 'azkey');
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ choices: [{ message: { content: 'ok' } }] }),
      }),
    );
    await llmGenerate({
      config: {
        llm: {
          ...config.llm,
          model: '../../x?y=1#z',
          apiVersion: '2024-10-21&api-key=evil',
        },
      },
      prompt: 'p',
    });
    const [url] = fetch.mock.calls[0];
    const parsed = new URL(url);
    expect(parsed.pathname).toBe('/openai/deployments/..%2F..%2Fx%3Fy%3D1%23z/chat/completions');
    expect([...parsed.searchParams.keys()]).toEqual(['api-version']);
    expect(parsed.hash).toBe('');
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

  it('format json : un JSON rendu dans un bloc ```json (pas de mode JSON natif) est déballé avant transform', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-test');
    const fenced = '```json\n{"files":["src/a.js"]}\n```';
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ content: [{ type: 'text', text: fenced }] }),
      }),
    );
    const result = await llmGenerate({
      config,
      prompt: 'p',
      format: 'json',
      transform: (text) => JSON.parse(text),
    });
    expect(result).toEqual({ files: ['src/a.js'] });
  });

  it('sans format json, la réponse est rendue telle quelle (le code fusionné garde ses blocs)', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-test');
    const fenced = '```js\nconst a = 1;\n```';
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ content: [{ type: 'text', text: fenced }] }),
      }),
    );
    expect(await llmGenerate({ config, prompt: 'p' })).toBe(fenced);
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

describe('llm — exfiltration de secrets par une config de dépôt (S-M5)', () => {
  const base = { provider: 'openai', model: 'm' };

  it.each([
    'GITHUB_TOKEN',
    'AWS_SECRET_ACCESS_KEY',
    'NPM_TOKEN',
    'SSH_AUTH_SOCK',
    'path',
    'AZURE_CLIENT_SECRET',
    'HOME',
  ])('refuse apiKeyEnv %s', (name) => {
    expect(() => resolveLlmConfig({ llm: { ...base, apiKeyEnv: name } })).toThrow(
      expect.objectContaining({ code: 'LLM_CONFIG_INVALID' }),
    );
  });

  it('accepte une clé de fournisseur usuelle, et l option explicite lève la restriction', () => {
    expect(() =>
      resolveLlmConfig({ llm: { ...base, apiKeyEnv: 'MISTRAL_API_KEY' } }),
    ).not.toThrow();
    expect(() =>
      resolveLlmConfig({ llm: { ...base, apiKeyEnv: 'GITHUB_TOKEN', allowAnyApiKeyEnv: true } }),
    ).not.toThrow();
  });

  it('une clé ne part jamais en clair hors boucle locale (sauf option explicite)', () => {
    vi.stubEnv('OPENAI_API_KEY', 'sk-test');
    const insecure = { ...base, baseUrl: 'http://gateway.example/v1' };
    expect(() => resolveLlmConfig({ llm: insecure })).toThrow(
      expect.objectContaining({
        details: expect.objectContaining({ reason: 'INSECURE_BASE_URL' }),
      }),
    );
    expect(() =>
      resolveLlmConfig({ llm: { ...insecure, allowInsecureTransport: true } }),
    ).not.toThrow();
    expect(() =>
      resolveLlmConfig({ llm: { ...base, baseUrl: 'http://127.0.0.1:1234/v1' } }),
    ).not.toThrow();
  });

  it('tous les appels authentifiés refusent les redirections (redirect: error)', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'sk-test');
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant');
    vi.stubEnv('AZURE_OPENAI_API_KEY', 'az');
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        response: 'ok',
        choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
        content: [{ type: 'text', text: 'ok' }],
        stop_reason: 'end_turn',
      }),
    }));
    vi.stubGlobal('fetch', fetchMock);
    const configs = [
      { llm: { provider: 'ollama', model: 'm', baseUrl: 'http://localhost:11434' } },
      { llm: { provider: 'openai', model: 'm' } },
      { llm: { provider: 'anthropic', model: 'm' } },
      { llm: { provider: 'azure', model: 'm', baseUrl: 'https://r.openai.azure.com' } },
    ];
    for (const [i, config] of configs.entries()) {
      await llmGenerate({ config, prompt: `x${i}` });
    }
    expect(fetchMock).toHaveBeenCalledTimes(4);
    for (const [, init] of fetchMock.mock.calls) expect(init.redirect).toBe('error');
  });
});

describe('unwrapJsonResponse', () => {
  it('déballe un bloc unique, avec ou sans langage, sauts de ligne Windows compris', () => {
    expect(unwrapJsonResponse('```json\n{"a":1}\n```')).toBe('{"a":1}');
    expect(unwrapJsonResponse('```\n[1,2]\n```\n')).toBe('[1,2]');
    expect(unwrapJsonResponse('  ```json\r\n{"a":1}\r\n```  ')).toBe('{"a":1}');
  });

  it('ne devine rien d’autre : texte autour, plusieurs blocs ou JSON nu → inchangé', () => {
    for (const text of [
      '{"a":1}',
      'Voici :\n```json\n{"a":1}\n```',
      '```json\n{"a":1}\n```\net voilà',
      '```json\n{"a":1}\n```\n```json\n{"b":2}\n```',
      '',
    ]) {
      expect(unwrapJsonResponse(text)).toBe(text);
    }
  });
});

describe('llmGenerate — couche réseau (src/net.ts)', () => {
  const okFetch = () =>
    vi.fn(async () => ({
      ok: true,
      json: async () => ({ response: 'ok', done: true }),
    }));

  it('Ollama distant en http:// SANS clé API : refusé (NET_INSECURE_TRANSPORT), jamais retenté ni enveloppé', async () => {
    const fetchMock = okFetch();
    vi.stubGlobal('fetch', fetchMock);
    const error = await llmGenerate({
      config: { llm: { provider: 'ollama', model: 'm', baseUrl: 'http://gpu.corp.example:11434' } },
      prompt: 'x',
      retries: 3,
      retryDelayMs: 1,
    }).catch((e) => e);
    expect(error).toBeInstanceOf(StriartError);
    expect(error.code).toBe('NET_INSECURE_TRANSPORT');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('ollamaHost historique distant en http:// : même refus', async () => {
    vi.stubGlobal('fetch', okFetch());
    await expect(
      llmGenerate({
        config: { ollamaModel: 'm', ollamaHost: 'http://gpu.corp.example:11434' },
        prompt: 'x',
      }),
    ).rejects.toMatchObject({ code: 'NET_INSECURE_TRANSPORT' });
  });

  it('mode offline : un LLM cloud est refusé (NET_OFFLINE), Ollama local reste servi', async () => {
    vi.stubEnv('STRIART_OFFLINE', '1');
    vi.stubEnv('OPENAI_API_KEY', 'sk-test');
    const fetchMock = okFetch();
    vi.stubGlobal('fetch', fetchMock);
    await expect(
      llmGenerate({ config: { llm: { provider: 'openai', model: 'm' } }, prompt: 'x' }),
    ).rejects.toMatchObject({ code: 'NET_OFFLINE' });
    expect(fetchMock).not.toHaveBeenCalled();
    await expect(
      llmGenerate({
        config: { llm: { provider: 'ollama', model: 'm', baseUrl: 'http://localhost:11434' } },
        prompt: 'x',
      }),
    ).resolves.toBe('ok');
  });

  it('liste blanche d’hôtes : un fournisseur hors liste est refusé avant tout envoi de la clé', async () => {
    vi.stubEnv('STRIART_ALLOWED_HOSTS', 'api.anthropic.com');
    vi.stubEnv('OPENAI_API_KEY', 'sk-test');
    const fetchMock = okFetch();
    vi.stubGlobal('fetch', fetchMock);
    await expect(
      llmGenerate({ config: { llm: { provider: 'openai', model: 'm' } }, prompt: 'x' }),
    ).rejects.toMatchObject({ code: 'NET_HOST_NOT_ALLOWED' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('certificat non fiable : NET_TLS_UNTRUSTED remonte tel quel (non retentable)', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'sk-test');
    const fetchMock = vi.fn(async () => {
      throw Object.assign(new TypeError('fetch failed'), {
        cause: Object.assign(new Error('self signed'), { code: 'SELF_SIGNED_CERT_IN_CHAIN' }),
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    await expect(
      llmGenerate({
        config: { llm: { provider: 'openai', model: 'm' } },
        prompt: 'x',
        retries: 3,
        retryDelayMs: 1,
      }),
    ).rejects.toMatchObject({ code: 'NET_TLS_UNTRUSTED' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

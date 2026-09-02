import { afterEach, describe, expect, it, vi } from 'vitest';
import { detectCollisions, normalizeFilePath, predictFiles } from '../../src/router.js';
import { StriartError } from '../../src/errors.js';

const CONFIG = { ollamaHost: 'http://localhost:11434', ollamaModel: 'llama3.1:8b' };

function mockOllamaResponse(files) {
  return {
    ok: true,
    json: async () => ({ response: JSON.stringify({ files }) }),
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('predictFiles', () => {
  it('retourne les fichiers prédits par Ollama', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(mockOllamaResponse(['src/auth.js', 'src/db.js'])),
    );
    const files = await predictFiles({
      prompt: 'refactor auth',
      projectFiles: ['src/auth.js'],
      config: CONFIG,
    });
    expect(files).toEqual(['src/auth.js', 'src/db.js']);
    const body = JSON.parse(fetch.mock.calls[0][1].body);
    expect(body).toMatchObject({ model: CONFIG.ollamaModel, stream: false, format: 'json' });
    expect(body.prompt).toContain('refactor auth');
    expect(body.prompt).toContain('src/auth.js');
  });

  it('normalise et déduplique les chemins', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(mockOllamaResponse(['./src/a.js', 'src\\a.js', '', 42, 'src/b.js'])),
    );
    const files = await predictFiles({ prompt: 'x', projectFiles: [], config: CONFIG });
    expect(files).toEqual(['src/a.js', 'src/b.js']);
  });

  it('retente puis réussit si Ollama échoue au premier appel', async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error('ECONNREFUSED'))
      .mockResolvedValue(mockOllamaResponse(['src/a.js']));
    vi.stubGlobal('fetch', fetchMock);
    const files = await predictFiles({
      prompt: 'x',
      projectFiles: [],
      config: CONFIG,
      retryDelayMs: 1,
    });
    expect(files).toEqual(['src/a.js']);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('throw ROUTER_FAILED après épuisement des retries', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    vi.stubGlobal('fetch', fetchMock);
    await expect(
      predictFiles({ prompt: 'x', projectFiles: [], config: CONFIG, retries: 2, retryDelayMs: 1 }),
    ).rejects.toMatchObject({ code: 'ROUTER_FAILED' });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('throw ROUTER_FAILED sur une réponse JSON sans tableau "files"', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, json: async () => ({ response: '{"nope": true}' }) }),
    );
    await expect(
      predictFiles({ prompt: 'x', projectFiles: [], config: CONFIG, retries: 0 }),
    ).rejects.toThrow(StriartError);
  });

  it('throw ROUTER_FAILED sur une réponse HTTP non-ok', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 500 }));
    await expect(
      predictFiles({ prompt: 'x', projectFiles: [], config: CONFIG, retries: 0 }),
    ).rejects.toMatchObject({ code: 'ROUTER_FAILED' });
  });
});

describe('detectCollisions', () => {
  it('détecte une intersection non vide', () => {
    const collisions = detectCollisions(
      ['src/auth/schema.ts', 'src/api.ts'],
      [
        { name: 'agent-a', predictedFiles: ['src/auth/schema.ts'] },
        { name: 'agent-b', predictedFiles: ['src/ui.tsx'] },
      ],
    );
    expect(collisions).toEqual([{ agent: 'agent-a', files: ['src/auth/schema.ts'] }]);
  });

  it('retourne un tableau vide sans chevauchement', () => {
    expect(detectCollisions(['a.js'], [{ name: 'x', predictedFiles: ['b.js'] }])).toEqual([]);
  });

  it('compare des chemins non normalisés', () => {
    const collisions = detectCollisions(
      ['./src/a.js'],
      [{ name: 'x', predictedFiles: ['src\\a.js'] }],
    );
    expect(collisions).toEqual([{ agent: 'x', files: ['src/a.js'] }]);
  });

  it('tolère un agent sans prédictions (créé via striart start)', () => {
    expect(detectCollisions(['a.js'], [{ name: 'x' }])).toEqual([]);
  });
});

describe('normalizeFilePath', () => {
  it('convertit backslashes et préfixe ./', () => {
    expect(normalizeFilePath('.\\src\\a.js'.replaceAll('\\', '/'))).toBe('src/a.js');
    expect(normalizeFilePath('src\\a.js')).toBe('src/a.js');
  });
});

describe('predictFiles — prompt surchargé (config.prompts.router)', () => {
  it('utilise le template, tâche et fichiers substitués, contrat JSON inchangé', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockOllamaResponse(['src/x.js'])));
    const files = await predictFiles({
      prompt: 'add billing',
      projectFiles: ['src/x.js', 'src/y.js'],
      config: {
        ...CONFIG,
        prompts: {
          router: 'Which files does "{{task}}" touch?\n{{files}}\nReply {"files": []}.',
          merger: null,
        },
      },
    });
    expect(files).toEqual(['src/x.js']);
    const body = JSON.parse(fetch.mock.calls[0][1].body);
    expect(body.prompt).toContain('Which files does "add billing" touch?');
    expect(body.prompt).toContain('src/x.js\nsrc/y.js');
    // Le prompt par défaut ne doit laisser aucune trace.
    expect(body.prompt).not.toContain('analyste de code');
    // format: 'json' reste imposé par le Router, template ou pas.
    expect(body.format).toBe('json');
  });
});

describe('isSafeProjectPath', () => {
  it('accepte les chemins de projet relatifs', async () => {
    const { isSafeProjectPath } = await import('../../src/router.js');
    expect(isSafeProjectPath('src/auth.js')).toBe(true);
    expect(isSafeProjectPath('a/b/c.ts')).toBe(true);
  });

  it('rejette absolus, lettres de lecteur et traversées', async () => {
    const { isSafeProjectPath } = await import('../../src/router.js');
    expect(isSafeProjectPath('/etc/passwd')).toBe(false);
    expect(isSafeProjectPath('C:/Windows/system32')).toBe(false);
    expect(isSafeProjectPath('../../../secret')).toBe(false);
    expect(isSafeProjectPath('src/../../etc')).toBe(false);
    expect(isSafeProjectPath('')).toBe(false);
  });

  it('predictFiles écarte les chemins hors de l’arbre hallucinés par le LLM', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          mockOllamaResponse(['src/ok.js', '../../etc/passwd', '/abs/x', 'C:/Windows/y']),
        ),
    );
    const files = await predictFiles({ prompt: 'x', projectFiles: [], config: CONFIG });
    expect(files).toEqual(['src/ok.js']);
  });
});

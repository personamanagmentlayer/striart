import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { WHOLE_REPO, detectCollisions, predictFiles } from '../../src/router.ts';
import { isValidTokensSettings, resolveTokensSettings } from '../../src/tokens/settings.ts';

const CONFIG = { ollamaHost: 'http://localhost:11434', ollamaModel: 'llama3.1:8b' };
const withTokens = (tokens) => ({ ...CONFIG, tokens });

const reply = (files) => ({
  ok: true,
  json: async () => ({ response: JSON.stringify({ files }) }),
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/**
 * La liste de fichiers soumise au Router est bornée (`tokens.router.tree.maxFiles`).
 * Quand elle l'est, le Router ne voit qu'une partie du dépôt : jamais en silence.
 * Par défaut il sérialise prudemment (sentinelle `**`, aucun appel LLM) ; en
 * mode `predict` il prédit, mais le prompt DÉCLARE la troncature.
 */
describe('Router : arbre tronqué', () => {
  const truncated = { kept: 100, total: 450 };

  it('défaut (serialize) : sentinelle « tout le dépôt », aucun appel LLM', async () => {
    const fetchMock = vi.fn().mockResolvedValue(reply(['src/a.js']));
    vi.stubGlobal('fetch', fetchMock);
    const files = await predictFiles({
      prompt: 'refactor auth',
      projectFiles: ['src/a.js'],
      config: CONFIG,
      treeTruncated: truncated,
    });
    expect(files).toEqual([WHOLE_REPO]);
    expect(fetchMock).not.toHaveBeenCalled();
    // Et la sentinelle entre bien en collision avec tout agent actif.
    expect(detectCollisions(files, [{ name: 'a', predictedFiles: ['src/x.js'] }])).toEqual([
      { agent: 'a', files: [WHOLE_REPO] },
    ]);
  });

  it('predict : le LLM est appelé et le prompt DÉCLARE la troncature (nombres inclus)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(reply(['src/a.js']));
    vi.stubGlobal('fetch', fetchMock);
    const files = await predictFiles({
      prompt: 'refactor auth',
      projectFiles: ['src/a.js'],
      config: withTokens({ router: { onTreeTruncated: 'predict' } }),
      treeTruncated: truncated,
    });
    expect(files).toEqual(['src/a.js']);
    const prompt = JSON.parse(fetchMock.mock.calls[0][1].body).prompt;
    expect(prompt).toMatch(/TRUNCATED|tronquée/i);
    expect(prompt).toContain('100');
    expect(prompt).toContain('450');
  });

  it('predict : une prédiction faite sur un arbre complet n’est pas resservie pour un arbre tronqué', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'striart-router-trunc-'));
    try {
      await mkdir(path.join(root, '.striart'), { recursive: true });
      const fetchMock = vi.fn().mockResolvedValue(reply(['src/a.js']));
      vi.stubGlobal('fetch', fetchMock);
      const config = withTokens({ router: { onTreeTruncated: 'predict' } });
      const common = { prompt: 'même tâche', projectFiles: ['src/a.js'], config, root };
      await predictFiles(common);
      await predictFiles(common); // témoin : l’arbre complet identique est bien servi du cache
      expect(fetchMock).toHaveBeenCalledTimes(1);
      await predictFiles({ ...common, treeTruncated: truncated });
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 5 });
    }
  });

  it('arbre complet : comportement inchangé, aucune mention de troncature', async () => {
    const fetchMock = vi.fn().mockResolvedValue(reply(['src/a.js']));
    vi.stubGlobal('fetch', fetchMock);
    await predictFiles({ prompt: 'x', projectFiles: ['src/a.js'], config: CONFIG });
    const prompt = JSON.parse(fetchMock.mock.calls[0][1].body).prompt;
    expect(prompt).not.toMatch(/TRUNCATED|tronquée/i);
  });
});

describe('tokens.router : maxFiles et onTreeTruncated', () => {
  it('défauts : borne haute large, sérialisation prudente', () => {
    const s = resolveTokensSettings({});
    expect(s.router.tree.maxFiles).toBe(50_000);
    expect(s.router.onTreeTruncated).toBe('serialize');
  });

  it('validation positive', () => {
    expect(
      isValidTokensSettings({
        router: { onTreeTruncated: 'predict', tree: { maxFiles: 1000 } },
      }),
    ).toBe(true);
    expect(isValidTokensSettings({ router: { onTreeTruncated: 'ignore' } })).toBe(false);
    expect(isValidTokensSettings({ router: { tree: { maxFiles: 10 } } })).toBe(false);
    expect(isValidTokensSettings({ router: { tree: { maxFiles: 1.5 } } })).toBe(false);
    expect(isValidTokensSettings({ router: { tree: { maxFiles: '400' } } })).toBe(false);
  });
});

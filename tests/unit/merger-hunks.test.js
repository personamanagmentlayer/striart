import { afterEach, describe, expect, it, vi } from 'vitest';
import { maxMergeInputChars, parseRegionResponse, semanticMerge } from '../../src/merger.ts';

const CONFIG = {
  ollamaHost: 'http://localhost:11434',
  ollamaModel: 'm',
  tokens: { accounting: false },
};

afterEach(() => vi.unstubAllGlobals());

const reply = (text) => ({ ok: true, json: async () => ({ response: text, done_reason: 'stop' }) });

/** Fichier de `n` lignes ; `edit` remplace des lignes. */
function file(n, edits = {}) {
  return (
    Array.from(
      { length: n },
      (_, i) => edits[i + 1] ?? `ligne ${i + 1} du fichier avec du contenu pour grossir`,
    ).join('\n') + '\n'
  );
}

describe('Merger par régions', () => {
  const base = file(800);
  const ours = file(800, { 400: 'OURS 400', 10: 'ours seulement 10' });
  const theirs = file(800, { 400: 'THEIRS 400', 700: 'theirs seulement 700' });

  it('grand fichier : seules les régions en conflit partent au LLM, le reste est fusionné localement', async () => {
    const fetchMock = vi.fn().mockResolvedValue(reply('<<<REGION 1>>>\nFUSION 400\n<<<END 1>>>'));
    vi.stubGlobal('fetch', fetchMock);
    const merged = await semanticMerge({
      filePath: 'src/a.js',
      base,
      ours,
      theirs,
      config: CONFIG,
      retries: 0,
    });

    const prompt = JSON.parse(fetchMock.mock.calls[0][1].body).prompt;
    expect(prompt).toContain('OURS 400');
    expect(prompt).toContain('THEIRS 400');
    expect(prompt.length).toBeLessThan(base.length / 4); // bien moins que 3 fichiers entiers
    expect(prompt).not.toContain('ligne 50 du fichier');
    // Résultat : modifications non conflictuelles des deux côtés + résolution du LLM.
    const lines = merged.split('\n');
    expect(lines[9]).toBe('ours seulement 10');
    expect(lines[399]).toBe('FUSION 400');
    expect(lines[699]).toBe('theirs seulement 700');
    expect(lines).toHaveLength(801);
    expect(merged.endsWith('\n')).toBe(true);
  });

  it('petit fichier (sous le seuil) : trois versions entières, comportement historique', async () => {
    const fetchMock = vi.fn().mockResolvedValue(reply('tout le fichier'));
    vi.stubGlobal('fetch', fetchMock);
    const out = await semanticMerge({
      filePath: 'a.js',
      base: 'a\n',
      ours: 'b\n',
      theirs: 'c\n',
      config: CONFIG,
      retries: 0,
    });
    expect(out).toBe('tout le fichier\n');
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).prompt).toContain('Version BASE (commune)');
  });

  it('gabarit surchargé (prompts.merger) : toujours le fichier entier, le gabarit est respecté', async () => {
    const fetchMock = vi.fn().mockResolvedValue(reply('ok'));
    vi.stubGlobal('fetch', fetchMock);
    const template = '{{file}}|{{base}}|{{ours}}|{{theirs}}|{{feedback}}';
    await semanticMerge({
      filePath: 'x.js',
      base,
      ours,
      theirs,
      config: {
        ...CONFIG,
        prompts: { merger: template },
        tokens: { accounting: false, merger: { maxWindowTokens: 1_000_000 } },
      },
      retries: 0,
    });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).prompt.startsWith('x.js|')).toBe(true);
    expect(maxMergeInputChars({ prompts: { merger: template } })).toBe(120_000);
  });

  it('fenêtre dépassée : MERGE_WINDOW_EXCEEDED, aucun appel, jamais de troncature', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(
      semanticMerge({
        filePath: 'a.js',
        base,
        ours,
        theirs,
        config: {
          ...CONFIG,
          tokens: { accounting: false, merger: { mode: 'full', maxWindowTokens: 1000 } },
        },
        retries: 0,
      }),
    ).rejects.toMatchObject({
      code: 'MERGE_WINDOW_EXCEEDED',
      details: expect.objectContaining({ mode: 'full' }),
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('réponse à la mauvaise forme (région manquante) : tentative échouée puis SEMANTIC_MERGE_FAILED', async () => {
    const fetchMock = vi.fn().mockResolvedValue(reply('Voici la fusion : tout va bien'));
    vi.stubGlobal('fetch', fetchMock);
    await expect(
      semanticMerge({
        filePath: 'a.js',
        base,
        ours,
        theirs,
        config: CONFIG,
        retries: 1,
        retryDelayMs: 1,
      }),
    ).rejects.toMatchObject({ code: 'SEMANTIC_MERGE_FAILED' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('CRLF préservé dans les régions résolues', async () => {
    const crlf = (s) => s.replaceAll('\n', '\r\n');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(reply('<<<REGION 1>>>\nFUSION\n<<<END 1>>>')));
    const merged = await semanticMerge({
      filePath: 'a.js',
      base: crlf(base),
      ours: crlf(ours),
      theirs: crlf(theirs),
      config: CONFIG,
      retries: 0,
    });
    expect(merged.split('\r\n')[399]).toBe('FUSION');
    expect(merged).not.toMatch(/[^\r]\n/);
  });
});

describe('Merger par régions : indentation, fin de fichier, fusion locale', () => {
  const HUNK = { ...CONFIG, tokens: { accounting: false, merger: { mode: 'hunk' } } };
  const pad = (n) => Array.from({ length: n }, (_, i) => `l${i}`).join('\n');

  it("l'indentation de la 1re ligne d'une région résolue est conservée", async () => {
    const base = `${pad(30)}\ndef f():\n    return 1\n${pad(30)}\n`;
    const ours = base.replace('return 1', 'return 2');
    const theirs = base.replace('return 1', 'return 3');
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(reply('<<<REGION 1>>>\n    return 23\n<<<END 1>>>')),
    );
    const merged = await semanticMerge({
      filePath: 'a.py',
      base,
      ours,
      theirs,
      config: HUNK,
      retries: 0,
    });
    expect(merged).toContain('def f():\n    return 23\n');
  });

  it('CRLF sans newline final : pas de \\r parasite en fin de fichier', async () => {
    const crlf = (s) => s.replaceAll('\n', '\r\n');
    const base = crlf(`${pad(30)}\nX`);
    const ours = crlf(`${pad(30)}\nO`);
    const theirs = crlf(`${pad(30)}\nT`);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(reply('<<<REGION 1>>>\nFUSION\n<<<END 1>>>')));
    const merged = await semanticMerge({
      filePath: 'a.js',
      base,
      ours,
      theirs,
      config: HUNK,
      retries: 0,
    });
    expect(merged.endsWith('\nFUSION')).toBe(true);
  });

  it('fusion locale propre (aucune région en conflit) : aucun appel LLM', async () => {
    const base = `${pad(30)}\nmid\n${pad(30)}\n`;
    const ours = base.replace('l1\n', 'l1 ours\n');
    const theirs = base.replace('l28\n', 'l28 theirs\n');
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const merged = await semanticMerge({
      filePath: 'a.js',
      base,
      ours,
      theirs,
      config: HUNK,
      retries: 0,
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(merged).toContain('l1 ours');
    expect(merged).toContain('l28 theirs');
  });

  it('très grand fichier (150 000 lignes) : pas de RangeError', async () => {
    const big = Array.from({ length: 150_000 }, (_, i) => `x${i}`).join('\n') + '\n';
    const ours = big.replace('x10\n', 'x10 ours\n');
    const theirs = big.replace('x149990\n', 'x149990 theirs\n');
    vi.stubGlobal('fetch', vi.fn());
    const merged = await semanticMerge({
      filePath: 'big.txt',
      base: big,
      ours,
      theirs,
      config: HUNK,
      retries: 0,
    });
    expect(merged).toContain('x10 ours');
    expect(merged).toContain('x149990 theirs');
  });
});

describe('parseRegionResponse', () => {
  const regions = [
    { index: 1, ours: ['a'], theirs: ['b'] },
    { index: 2, ours: ['c'], theirs: ['d'] },
  ];
  it('extrait chaque région, ignore le préambule, retire les clôtures de code', () => {
    const out = parseRegionResponse(
      'Voici :\n<<<REGION 1>>>\n```js\nx\n```\n<<<END 1>>>\n<<<REGION 2>>>\ny\nz\n<<<END 2>>>',
      regions,
    );
    expect(out.get(1)).toEqual(['x']);
    expect(out.get(2)).toEqual(['y', 'z']);
  });
  it.each([
    ['région manquante', '<<<REGION 1>>>\nx\n<<<END 1>>>'],
    ['région coupée', '<<<REGION 1>>>\nx\n<<<END 1>>>\n<<<REGION 2>>>\ny'],
    ['région inconnue', '<<<REGION 1>>>\nx\n<<<END 1>>>\n<<<REGION 9>>>\nx\n<<<END 9>>>'],
    ['région dupliquée', '<<<REGION 1>>>\nx\n<<<END 1>>>\n<<<REGION 1>>>\nx\n<<<END 1>>>'],
    [
      'marqueurs de conflit',
      '<<<REGION 1>>>\n<<<<<<< HEAD\n<<<END 1>>>\n<<<REGION 2>>>\ny\n<<<END 2>>>',
    ],
    [
      'région vide alors que les deux côtés existent',
      '<<<REGION 1>>>\n<<<END 1>>>\n<<<REGION 2>>>\ny\n<<<END 2>>>',
    ],
  ])('%s → rejeté', (_name, response) => {
    expect(() => parseRegionResponse(response, regions)).toThrow();
  });
  it('une région vide est admise quand un côté a supprimé', () => {
    const out = parseRegionResponse('<<<REGION 1>>>\n<<<END 1>>>', [
      { index: 1, ours: [], theirs: ['b'] },
    ]);
    expect(out.get(1)).toEqual([]);
  });
});

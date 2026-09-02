import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  MAX_MERGE_INPUT_CHARS,
  classifyConflict,
  detectLanguage,
  lineOverlap,
  semanticMerge,
  stripCodeFences,
} from '../../src/merger.js';

const CONFIG = { ollamaHost: 'http://localhost:11434', ollamaModel: 'llama3.1:8b' };

function mockOllamaResponse(response) {
  return { ok: true, json: async () => ({ response }) };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('stripCodeFences', () => {
  it('laisse le code nu intact', () => {
    expect(stripCodeFences('const x = 1;\n')).toBe('const x = 1;');
  });

  it('retire une fence avec langage', () => {
    expect(stripCodeFences('```typescript\nconst x = 1;\n```')).toBe('const x = 1;');
  });

  it('retire une fence sans langage', () => {
    expect(stripCodeFences('```\nconst x = 1;\n```')).toBe('const x = 1;');
  });

  it('ne touche pas aux fences internes au code', () => {
    const code = 'const doc = `\\`\\`\\`js`;\nconst y = 2;';
    expect(stripCodeFences(code)).toBe(code);
  });
});

describe('detectLanguage', () => {
  it.each([
    ['src/auth/schema.ts', 'TypeScript'],
    ['src/Button.tsx', 'TypeScript (React)'],
    ['scripts/deploy.py', 'Python'],
    ['main.rs', 'Rust'],
    ['Makefile', null],
  ])('%s → %s', (file, expected) => {
    expect(detectLanguage(file)).toBe(expected);
  });
});

describe('semanticMerge', () => {
  const versions = { filePath: 'src/a.js', base: 'a', ours: 'b', theirs: 'c', config: CONFIG };

  it('retourne le code fusionné, fences retirées, newline final garanti', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(mockOllamaResponse('```js\nconst merged = 1;\n```')),
    );
    await expect(semanticMerge(versions)).resolves.toBe('const merged = 1;\n');
    const body = JSON.parse(fetch.mock.calls[0][1].body);
    expect(body.prompt).toContain('Version BASE');
    expect(body.prompt).toContain('src/a.js');
    expect(body.prompt).toContain('JavaScript'); // prompt adapté au langage du fichier
    expect(body.format).toBeUndefined(); // sortie code brut, pas JSON
  });

  it('rejette une réponse vide → SEMANTIC_MERGE_FAILED', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockOllamaResponse('   ')));
    await expect(semanticMerge({ ...versions, retries: 0 })).rejects.toMatchObject({
      code: 'SEMANTIC_MERGE_FAILED',
    });
  });

  it('rejette une réponse contenant encore des marqueurs de conflit', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(mockOllamaResponse('<<<<<<< HEAD\nx\n=======\ny\n>>>>>>> agent')),
    );
    await expect(semanticMerge({ ...versions, retries: 0 })).rejects.toMatchObject({
      code: 'SEMANTIC_MERGE_FAILED',
    });
  });

  it('injecte le feedback du Test Gate dans le prompt quand il est fourni', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockOllamaResponse('const fixed = 1;')));
    await expect(
      semanticMerge({ ...versions, feedback: 'Error: expected 2 to be 3\n  at test.js:12' }),
    ).resolves.toBe('const fixed = 1;\n');
    const body = JSON.parse(fetch.mock.calls[0][1].body);
    expect(body.prompt).toContain('les tests');
    expect(body.prompt).toContain('expected 2 to be 3');
    expect(body.prompt).toContain('fusion corrigée');
  });

  it('sans feedback, le prompt ne mentionne pas de tentative précédente', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockOllamaResponse('const merged = 1;')));
    await semanticMerge(versions);
    const body = JSON.parse(fetch.mock.calls[0][1].body);
    expect(body.prompt).not.toContain('précédente fusion');
  });

  it('retente puis réussit après une réponse invalide', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(mockOllamaResponse(''))
      .mockResolvedValue(mockOllamaResponse('const ok = true;'));
    vi.stubGlobal('fetch', fetchMock);
    await expect(semanticMerge({ ...versions, retries: 1, retryDelayMs: 1 })).resolves.toBe(
      'const ok = true;\n',
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('classifyConflict', () => {
  const NUL = String.fromCharCode(0);
  const text = (s) => s;

  it('conflit textuel classique → text', () => {
    expect(
      classifyConflict({ filePath: 'src/app.js', base: 'a\n', ours: 'b\n', theirs: 'c\n' }),
    ).toEqual({ kind: 'text' });
  });

  it('ajouté des deux côtés (pas de BASE) → text', () => {
    expect(
      classifyConflict({ filePath: 'src/new.js', base: '', ours: 'a\n', theirs: 'b\n' }),
    ).toEqual({ kind: 'text' });
  });

  it('supprimé côté main, modifié côté agent → delete/ours', () => {
    expect(
      classifyConflict({ filePath: 'src/app.js', base: 'a\n', ours: '', theirs: 'b\n' }),
    ).toEqual({ kind: 'delete', deletedBy: 'ours' });
  });

  it('supprimé côté agent, modifié côté main → delete/theirs', () => {
    expect(
      classifyConflict({ filePath: 'src/app.js', base: 'a\n', ours: 'b\n', theirs: '' }),
    ).toEqual({ kind: 'delete', deletedBy: 'theirs' });
  });

  it('octet NUL dans une version → binary', () => {
    expect(
      classifyConflict({ filePath: 'logo.png', base: text(`x${NUL}y`), ours: 'a', theirs: 'b' }),
    ).toEqual({ kind: 'binary' });
  });

  it.each(['package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'Cargo.lock', 'go.sum'])(
    '%s → lockfile',
    (name) => {
      expect(
        classifyConflict({ filePath: `sub/${name}`, base: 'a', ours: 'b', theirs: 'c' }),
      ).toEqual({ kind: 'lockfile' });
    },
  );

  it('dépassement de MAX_MERGE_INPUT_CHARS → oversized', () => {
    const big = 'x'.repeat(MAX_MERGE_INPUT_CHARS);
    const result = classifyConflict({ filePath: 'src/gen.js', base: big, ours: 'a', theirs: 'b' });
    expect(result.kind).toBe('oversized');
    expect(result.chars).toBeGreaterThan(MAX_MERGE_INPUT_CHARS);
  });

  it('aucune version lisible → opaque', () => {
    expect(classifyConflict({ filePath: 'vendor/lib', base: '', ours: '', theirs: '' })).toEqual({
      kind: 'opaque',
    });
  });

  it('renommage/renommage — ancien nom (BASE seule) → path', () => {
    expect(classifyConflict({ filePath: 'src/old.js', base: 'a\n', ours: '', theirs: '' })).toEqual(
      { kind: 'path' },
    );
  });

  it("renommage/ajout — contenu d'un seul côté sans BASE → path", () => {
    expect(
      classifyConflict({ filePath: 'src/new-a.js', base: '', ours: 'a\n', theirs: '' }),
    ).toEqual({ kind: 'path' });
    expect(
      classifyConflict({ filePath: 'src/new-b.js', base: '', ours: '', theirs: 'b\n' }),
    ).toEqual({ kind: 'path' });
  });

  it('gitlink (mode 160000) → submodule, même sans contenu lisible', () => {
    expect(
      classifyConflict({
        filePath: 'vendor/lib',
        base: '',
        ours: '',
        theirs: '',
        modes: { base: '160000', ours: '160000', theirs: '160000' },
      }),
    ).toEqual({ kind: 'submodule' });
  });

  it('lien symbolique (mode 120000) → symlink', () => {
    expect(
      classifyConflict({
        filePath: 'bin/link',
        base: 'target-a',
        ours: 'target-b',
        theirs: 'target-c',
        modes: { base: '120000', ours: '120000', theirs: '120000' },
      }),
    ).toEqual({ kind: 'symlink' });
  });

  it('bit exécutable divergent entre main et agent → mode', () => {
    expect(
      classifyConflict({
        filePath: 'scripts/run.sh',
        base: 'a\n',
        ours: 'b\n',
        theirs: 'c\n',
        modes: { base: '100644', ours: '100755', theirs: '100644' },
      }),
    ).toEqual({ kind: 'mode', ours: '100755', theirs: '100644' });
  });

  it('bit exécutable identique des deux côtés → text (préservé au merge)', () => {
    expect(
      classifyConflict({
        filePath: 'scripts/run.sh',
        base: 'a\n',
        ours: 'b\n',
        theirs: 'c\n',
        modes: { base: '100644', ours: '100755', theirs: '100755' },
      }),
    ).toEqual({ kind: 'text' });
  });
});

describe('lineOverlap', () => {
  it('contenu identique → 1', () => {
    expect(lineOverlap('a\nb\nc\n', 'a\nb\nc\n')).toBe(1);
  });

  it('une ligne modifiée sur trois → 2/3', () => {
    expect(lineOverlap('a\nb\nc\n', 'a\nb\nZZZ\n')).toBeCloseTo(2 / 3);
  });

  it('contenus disjoints → 0', () => {
    expect(lineOverlap('a\nb\n', 'x\ny\n')).toBe(0);
  });

  it("ignore les lignes vides et l'indentation", () => {
    expect(lineOverlap('a\n\n  b\n', '  a\nb\n\n')).toBe(1);
  });

  it('base vide → 0 (pas de division par zéro)', () => {
    expect(lineOverlap('', 'a\n')).toBe(0);
  });
});

describe('semanticMerge — prompt surchargé (config.prompts.merger)', () => {
  const TEMPLATE = `Merge {{file}}.
BASE:{{base}}
OURS:{{ours}}
THEIRS:{{theirs}}{{feedback}}
Reply with code only.`;

  it('utilise le template au lieu du prompt par défaut, toutes versions substituées', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockOllamaResponse('merged')));
    await semanticMerge({
      filePath: 'src/a.js',
      base: 'AAA',
      ours: 'BBB',
      theirs: 'CCC',
      config: { ...CONFIG, prompts: { router: null, merger: TEMPLATE } },
    });
    const body = JSON.parse(fetch.mock.calls[0][1].body);
    expect(body.prompt).toContain('Merge src/a.js.');
    expect(body.prompt).toContain('BASE:AAA');
    expect(body.prompt).toContain('OURS:BBB');
    expect(body.prompt).toContain('THEIRS:CCC');
    // Le prompt par défaut ne doit laisser aucune trace.
    expect(body.prompt).not.toContain('Version BASE');
  });

  it('{{feedback}} est vide au premier essai, porte le log du gate au retry', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockOllamaResponse('merged')));
    const config = { ...CONFIG, prompts: { router: null, merger: TEMPLATE } };

    await semanticMerge({ filePath: 'a.js', base: 'a', ours: 'b', theirs: 'c', config });
    expect(JSON.parse(fetch.mock.calls[0][1].body).prompt).toContain('THEIRS:c\nReply');

    await semanticMerge({
      filePath: 'a.js',
      base: 'a',
      ours: 'b',
      theirs: 'c',
      config,
      feedback: '2 tests failed: expect(x).toBe(1)',
    });
    const retryPrompt = JSON.parse(fetch.mock.calls[1][1].body).prompt;
    expect(retryPrompt).toContain('2 tests failed');
    // La section formatée complète, pas le log nu : le contexte du retry
    // (« une précédente fusion a été rejetée ») doit survivre à la surcharge.
    expect(retryPrompt).toContain('précédente fusion');
  });
});

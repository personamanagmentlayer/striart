import { afterEach, describe, expect, it, vi } from 'vitest';
import { WHOLE_REPO, predictFiles, predictFilesDetailed } from '../../src/router.ts';
import { resetRepoMapCache } from '../../src/router-map.ts';
import { resetImportGraphCache } from '../../src/imports.ts';
import { isValidTokensSettings, resolveTokensSettings } from '../../src/tokens/settings.ts';

const BASE = { ollamaHost: 'http://localhost:11434', ollamaModel: 'llama3.1:8b' };
const cfg = (router = {}) => ({ ...BASE, tokens: { router } });

function llmSays(payload) {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ response: JSON.stringify(payload) }),
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}
const sentPrompt = (fetchMock) => JSON.parse(fetchMock.mock.calls[0][1].body).prompt;

const PROJECT = [
  'src/lock.ts',
  'src/user.ts',
  'src/cli/i18n/fr.ts',
  'src/cli/i18n/en.ts',
  'tests/unit/lock.test.js',
  'tests/unit/user.test.js',
  'CHANGELOG.md',
  'docs/fr/guide.md',
  'package.json',
];

function memorySources(files) {
  return {
    version: async (f) => (f in files ? `v:${files[f].length}` : null),
    read: async (f) => (f in files ? files[f] : null),
  };
}
const SOURCES = memorySources({
  'src/lock.ts': '/** Verrou principal inter-process. */\nexport function acquireLock() {}\n',
  'src/user.ts': "import { acquireLock } from './lock.ts';\nexport function login() {}\n",
});

afterEach(() => {
  vi.unstubAllGlobals();
  resetRepoMapCache();
  resetImportGraphCache();
});

describe('Router — contrat et détails', () => {
  it('predictFiles garde son contrat (tableau de chemins) ; les détails sont additifs', async () => {
    llmSays({
      files: [{ path: 'src/lock.ts', confidence: 0.9 }],
      scope: 'narrow',
      confidence: 0.8,
    });
    const files = await predictFiles({
      prompt: 'rendre le verrou plus robuste',
      projectFiles: PROJECT,
      config: BASE,
      sources: SOURCES,
    });
    expect(Array.isArray(files)).toBe(true);
    expect(files).toContain('src/lock.ts');
    const { details } = await predictFilesDetailed({
      prompt: 'rendre le verrou plus robuste',
      projectFiles: PROJECT,
      config: BASE,
      sources: SOURCES,
    });
    expect(details.files.find((f) => f.path === 'src/lock.ts')).toMatchObject({
      confidence: 0.9,
      source: 'llm',
    });
    expect(details.serialized).toBeNull();
    expect(details.retrieval[0].path).toBe('src/lock.ts');
  });

  it('le prompt v3 reçoit la carte des candidats lexicaux (symboles et doc), après la liste complète', async () => {
    const fetchMock = llmSays({
      files: [{ path: 'src/lock.ts', confidence: 0.9 }],
      scope: 'narrow',
      confidence: 0.8,
    });
    await predictFiles({
      prompt: 'rendre le verrou plus robuste',
      projectFiles: PROJECT,
      config: BASE,
      sources: SOURCES,
    });
    const prompt = sentPrompt(fetchMock);
    expect(prompt).toContain('Candidats les plus proches');
    expect(prompt).toContain('src/lock.ts — Verrou principal inter-process. [acquireLock]');
    expect(prompt.indexOf('Fichiers du projet')).toBeLessThan(prompt.indexOf('Candidats'));
    expect(prompt.indexOf('Candidats')).toBeLessThan(prompt.indexOf('Demande :'));
    expect(prompt).toContain('gérée à part'); // tenue de livre exclue annoncée au LLM
  });

  it('sans sources lisibles, retombe sur l’arbre seul sans échouer (signal advisory)', async () => {
    const fetchMock = llmSays({
      files: [{ path: 'src/lock.ts', confidence: 0.9 }],
      scope: 'narrow',
      confidence: 0.8,
    });
    const broken = {
      version: async () => {
        throw new Error('disque indisponible');
      },
      read: async () => null,
    };
    const files = await predictFiles({
      prompt: 'verrou',
      projectFiles: PROJECT,
      config: BASE,
      sources: broken,
    });
    expect(files).toContain('src/lock.ts');
    expect(sentPrompt(fetchMock)).not.toContain('Candidats les plus proches');
  });
});

describe('Router — confiance, plafond, tâche vague', () => {
  it('écarte les fichiers sous minFileConfidence (0,5 par défaut) mais garde ceux sans confiance', async () => {
    llmSays({
      files: [
        { path: 'src/lock.ts', confidence: 0.9 },
        { path: 'src/user.ts', confidence: 0.2 },
        'tests/unit/user.test.js',
      ],
      scope: 'narrow',
      confidence: 0.8,
    });
    const files = await predictFiles({
      prompt: 'x',
      projectFiles: PROJECT,
      config: cfg({ expansion: { tests: false } }),
    });
    expect(files).toEqual(['src/lock.ts', 'tests/unit/user.test.js']);
  });

  it('plafonne à maxFiles en gardant les plus sûrs', async () => {
    llmSays({
      files: ['a', 'b', 'c', 'd'].map((n, i) => ({
        path: `src/${n}.ts`,
        confidence: 0.6 + i * 0.1,
      })),
      scope: 'narrow',
      confidence: 0.9,
    });
    const files = await predictFiles({
      prompt: 'x',
      projectFiles: [],
      config: cfg({ maxFiles: 2, expansion: { tests: false } }),
    });
    expect(files).toEqual(['src/d.ts', 'src/c.ts']);
  });

  it('portée « broad » → sérialisation prudente (sentinelle), raison dans les détails', async () => {
    llmSays({ files: [{ path: 'src/lock.ts', confidence: 0.9 }], scope: 'broad', confidence: 0.2 });
    const r = await predictFilesDetailed({
      prompt: 'renommer partout',
      projectFiles: PROJECT,
      config: BASE,
    });
    expect(r.files).toEqual([WHOLE_REPO]);
    expect(r.details.serialized).toMatchObject({
      kind: 'vague',
      reasons: ['scope-broad', expect.stringMatching(/^low-confidence/)],
    });
  });

  it('prédiction vide → sentinelle (jamais un tableau vide trompeur) ; préréglage legacy : comportement historique', async () => {
    llmSays({ files: [], scope: 'narrow', confidence: 0.9 });
    expect(await predictFiles({ prompt: 'x', projectFiles: PROJECT, config: BASE })).toEqual([
      WHOLE_REPO,
    ]);
    llmSays({ files: [] });
    expect(
      await predictFiles({ prompt: 'x', projectFiles: PROJECT, config: cfg({ preset: 'legacy' }) }),
    ).toEqual([]);
  });

  it('une panne du LLM reste ROUTER_FAILED (fail closed), aucun repli silencieux', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));
    await expect(
      predictFiles({
        prompt: 'x',
        projectFiles: PROJECT,
        config: BASE,
        retries: 1,
        retryDelayMs: 1,
      }),
    ).rejects.toMatchObject({ code: 'ROUTER_FAILED' });
  });
});

describe('Router — tenue de livre partagée', () => {
  it('exclut CHANGELOG/docs/manifestes du tableau de collision, les garde dans details.shared', async () => {
    llmSays({
      files: [
        { path: 'src/lock.ts', confidence: 0.9 },
        { path: 'CHANGELOG.md', confidence: 0.9 },
        { path: 'docs/fr/guide.md', confidence: 0.8 },
      ],
      scope: 'narrow',
      confidence: 0.8,
    });
    const r = await predictFilesDetailed({
      prompt: 'x',
      projectFiles: PROJECT,
      config: cfg({ expansion: { tests: false } }),
    });
    expect(r.files).toEqual(['src/lock.ts']);
    expect(r.details.shared).toEqual(['CHANGELOG.md', 'docs/fr/guide.md']);
  });

  it('mode keep : traités comme n’importe quel fichier (historique)', async () => {
    llmSays({
      files: [{ path: 'CHANGELOG.md', confidence: 0.9 }],
      scope: 'narrow',
      confidence: 0.8,
    });
    const r = await predictFilesDetailed({
      prompt: 'x',
      projectFiles: PROJECT,
      config: cfg({ sharedFiles: { mode: 'keep' } }),
    });
    expect(r.files).toEqual(['CHANGELOG.md']);
  });

  it('une prédiction réduite à de la tenue de livre n’est pas une prédiction → sentinelle', async () => {
    llmSays({
      files: [{ path: 'CHANGELOG.md', confidence: 0.9 }],
      scope: 'narrow',
      confidence: 0.8,
    });
    const r = await predictFilesDetailed({ prompt: 'x', projectFiles: PROJECT, config: BASE });
    expect(r.files).toEqual([WHOLE_REPO]);
    expect(r.details.serialized.reasons).toEqual(['only-shared-files']);
  });
});

describe('Router — expansion déterministe', () => {
  it('ajoute le test apparié (défaut) avec sa raison ; les ajouts sont dans le tableau', async () => {
    llmSays({
      files: [{ path: 'src/lock.ts', confidence: 0.9 }],
      scope: 'narrow',
      confidence: 0.8,
    });
    const r = await predictFilesDetailed({
      prompt: 'verrou',
      projectFiles: PROJECT,
      config: BASE,
      sources: SOURCES,
    });
    expect(r.files).toEqual(['src/lock.ts', 'tests/unit/lock.test.js']);
    expect(r.details.expansion).toEqual([
      expect.objectContaining({
        path: 'tests/unit/lock.test.js',
        reason: 'test',
        from: 'src/lock.ts',
      }),
    ]);
  });

  it('importeurs via le graphe d’imports (opt-in) et co-modification via l’historique fourni', async () => {
    llmSays({
      files: [{ path: 'src/lock.ts', confidence: 0.9 }],
      scope: 'narrow',
      confidence: 0.8,
    });
    const history = Array.from({ length: 4 }, () => ['src/lock.ts', 'src/cli/i18n/fr.ts']);
    const r = await predictFilesDetailed({
      prompt: 'verrou',
      projectFiles: PROJECT,
      config: cfg({ expansion: { tests: false, imports: 'importers', coChange: true } }),
      sources: SOURCES,
      history,
    });
    expect(r.details.expansion.map((a) => [a.path, a.reason]).sort()).toEqual([
      ['src/cli/i18n/fr.ts', 'co-change'],
      ['src/user.ts', 'importer'],
    ]);
  });

  it('le préréglage legacy reproduit le prompt et la sortie historiques', async () => {
    const fetchMock = llmSays({ files: ['src/lock.ts', 'CHANGELOG.md'] });
    const files = await predictFiles({
      prompt: 'verrou',
      projectFiles: PROJECT,
      config: cfg({ preset: 'legacy' }),
      sources: SOURCES,
    });
    expect(files).toEqual(['src/lock.ts', 'CHANGELOG.md']);
    const prompt = sentPrompt(fetchMock);
    expect(prompt).toContain('(1 à 5 maximum)');
    expect(prompt).toContain('Tâche : verrou');
    expect(prompt).not.toContain('Candidats');
  });
});

describe('Réglages tokens.router (validation et préréglages)', () => {
  const ok = (router) => expect(isValidTokensSettings({ router })).toBe(true);
  const ko = (router) => expect(isValidTokensSettings({ router })).toBe(false);

  it('accepte les clés documentées, refuse les inconnues et les valeurs hors bornes', () => {
    ok({ preset: 'recall', prompt: 'v3', minFileConfidence: 0.4, maxFiles: 8 });
    ok({
      map: { mode: 'candidates', candidates: 20 },
      retrieval: { enabled: true, bilingual: false },
    });
    ok({ expansion: { imports: 'both', depth: 2, tests: true, maxAdded: 10 } });
    ok({ vague: { enabled: true, minConfidence: 0.5, maxFiles: 10, verbs: true } });
    ok({ sharedFiles: { mode: 'exclude', patterns: ['CHANGELOG*', 'docs/**'] } });
    ko({ preset: 'turbo' });
    ko({ prompt: 'v9' });
    ko({ minFileConfidence: 1.5 });
    ko({ maxFiles: 0 });
    ko({ unknownKey: true });
    ko({ map: { mode: 'full' } });
    ko({ expansion: { imports: 'all' } });
    ko({ expansion: { surprise: true } });
    ko({ vague: { enabled: 'yes' } });
    ko({ sharedFiles: { mode: 'ignore' } });
    ko({ sharedFiles: { patterns: ['/etc/passwd'] } });
    ko({ sharedFiles: { patterns: ['../x'] } });
  });

  it('défaut = équilibré ; legacy et recall se résolvent sans dépendre du défaut ; les clés explicites priment', () => {
    const balanced = resolveTokensSettings({}).router;
    expect(balanced).toMatchObject({
      preset: 'balanced',
      prompt: 'v3',
      minFileConfidence: 0.5,
      sharedFiles: { mode: 'exclude' },
      expansion: { tests: true, coChange: false, imports: 'off' },
      vague: { enabled: true },
    });
    const legacy = resolveTokensSettings({ tokens: { router: { preset: 'legacy' } } }).router;
    expect(legacy).toMatchObject({
      prompt: 'legacy',
      map: { mode: 'off' },
      retrieval: { enabled: false },
      expansion: { tests: false, coChange: false, imports: 'off' },
      minFileConfidence: 0,
      vague: { enabled: false },
      sharedFiles: { mode: 'keep' },
    });
    const recall = resolveTokensSettings({ tokens: { router: { preset: 'recall' } } }).router;
    expect(recall.expansion).toMatchObject({
      imports: 'importers',
      coChange: true,
      siblings: true,
    });
    expect(
      resolveTokensSettings({ tokens: { router: { preset: 'legacy', minFileConfidence: 0.7 } } })
        .router.minFileConfidence,
    ).toBe(0.7);
  });
});

describe('Router — bornes de lecture et confidentialité', () => {
  it('ne lit jamais le contenu d’un fichier désigné par secretPatterns', async () => {
    llmSays({
      files: [{ path: 'src/lock.ts', confidence: 0.9 }],
      scope: 'narrow',
      confidence: 0.8,
    });
    const read = vi.fn(async () => '/** secret */\nexport const token = 1;\n');
    const sources = { version: async () => 'v1', read };
    await predictFiles({
      prompt: 'verrou',
      projectFiles: ['src/lock.ts', 'config/credentials.json', '.env.local'],
      config: { ...BASE, secretPatterns: ['.env.*', 'credentials.json'] },
      sources,
    });
    const readPaths = read.mock.calls.map((c) => c[0]);
    expect(readPaths).toContain('src/lock.ts');
    expect(readPaths).not.toContain('config/credentials.json');
    expect(readPaths).not.toContain('.env.local');
  });

  it('au-delà de maxScanFiles aucun contenu n’est lu ; le classement lexical reste disponible sur les chemins', async () => {
    const fetchMock = llmSays({
      files: [{ path: 'src/lock.ts', confidence: 0.9 }],
      scope: 'narrow',
      confidence: 0.8,
    });
    const read = vi.fn(async () => 'export const x = 1;\n');
    const files = await predictFiles({
      prompt: 'verrou lock',
      projectFiles: ['src/lock.ts', ...Array.from({ length: 120 }, (_, i) => `src/m${i}.ts`)],
      config: cfg({ maxScanFiles: 100, expansion: { tests: false } }),
      sources: { version: async () => 'v1', read },
    });
    expect(read).not.toHaveBeenCalled();
    expect(files).toEqual(['src/lock.ts']);
    expect(sentPrompt(fetchMock)).toContain('Candidats les plus proches');
  });

  it('caviarde les secrets du commentaire d’en-tête avant de l’envoyer au fournisseur', async () => {
    const fetchMock = llmSays({
      files: [{ path: 'src/lock.ts', confidence: 0.9 }],
      scope: 'narrow',
      confidence: 0.8,
    });
    const key = `sk-ant-${'a1b2c3d4e5f6'.repeat(4)}`;
    await predictFiles({
      prompt: 'verrou lock',
      projectFiles: ['src/lock.ts'],
      config: BASE,
      sources: memorySources({
        'src/lock.ts': `/** Verrou — clé de test ${key} */\nexport function acquireLock() {}\n`,
      }),
    });
    const prompt = sentPrompt(fetchMock);
    expect(prompt).toContain('acquireLock');
    expect(prompt).not.toContain(key);
  });
});

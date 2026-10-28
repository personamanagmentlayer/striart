import { beforeEach, describe, expect, it } from 'vitest';
import {
  buildRepoMap,
  renderMapLine,
  resetRepoMapCache,
  summarizeSource,
} from '../../src/router-map.ts';
import { buildRetrievalIndex, retrieve, terms } from '../../src/router-retrieval.ts';
import { buildCoChange, associatedWith } from '../../src/router-cochange.ts';
import { expandPrediction, isTestPath, stemOf } from '../../src/router-expand.ts';
import { sweepingVerb, vagueReasons } from '../../src/router-vague.ts';
import {
  DEFAULT_SHARED_PATTERNS,
  compileSharedMatcher,
  partitionShared,
} from '../../src/router-shared.ts';
import { buildImportGraph, invertImportGraph, resetImportGraphCache } from '../../src/imports.js';

/** Sources en mémoire (le Router lit aussi un arbre qui n'est pas sur le disque). */
function memorySources(files) {
  const reads = { count: 0 };
  return {
    reads,
    version: async (f) => (f in files ? `v:${files[f].length}` : null),
    read: async (f) => {
      reads.count += 1;
      return f in files ? files[f] : null;
    },
  };
}

describe('carte du dépôt (symboles + documentation)', () => {
  beforeEach(() => resetRepoMapCache());

  it('extrait symboles exportés d’abord et la première ligne de documentation (TS)', () => {
    const src = `/**
 * Verrou principal : exclusion mutuelle inter-process.
 */
const helper = () => 1;
export function acquireLock() {}
export class LockQueue {
  release() {}
}
export { helper as internalHelper };
`;
    const s = summarizeSource('src/lock.ts', src);
    expect(s.doc).toBe('Verrou principal : exclusion mutuelle inter-process.');
    expect(s.symbols.slice(0, 3)).toEqual(
      expect.arrayContaining(['acquireLock', 'LockQueue', 'internalHelper']),
    );
    expect(s.symbols).toContain('release');
    // Les exportés précèdent les non exportés.
    expect(s.symbols.indexOf('acquireLock')).toBeLessThan(s.symbols.indexOf('release'));
  });

  it('couvre Python, Rust, Go, Ruby et Markdown', () => {
    expect(
      summarizeSource('a.py', '"""Outils de cache."""\ndef load():\n  pass\nclass Store:\n  pass\n')
        .symbols,
    ).toEqual(expect.arrayContaining(['load', 'Store']));
    expect(
      summarizeSource('a.rs', '//! Hôte de pty\npub fn spawn() {}\nstruct Inner;\n').symbols,
    ).toEqual(expect.arrayContaining(['spawn', 'Inner']));
    expect(summarizeSource('a.go', 'func (s *S) Run() {}\ntype Config struct{}\n').symbols).toEqual(
      expect.arrayContaining(['Run', 'Config']),
    );
    expect(summarizeSource('a.rb', 'class Foo\n def bar; end\nend\n').symbols).toEqual(
      expect.arrayContaining(['Foo', 'bar']),
    );
    const md = summarizeSource('README.md', '# Titre du projet\n## Installation\n## Usage\n');
    expect(md.doc).toBe('Titre du projet');
    expect(md.symbols).toEqual(['Installation', 'Usage']);
  });

  it('mémorise l’analyse par (chemin, version) et ignore verrous et binaires', async () => {
    const sources = memorySources({
      'src/a.ts': 'export const alpha = 1;\n',
      'package-lock.json': '{}',
    });
    const files = ['src/a.ts', 'package-lock.json', 'logo.png'];
    const first = await buildRepoMap(files, sources);
    expect(first.get('src/a.ts').symbols).toEqual(['alpha']);
    expect(first.get('package-lock.json').symbols).toEqual([]);
    const reads = sources.reads.count;
    await buildRepoMap(files, sources);
    expect(sources.reads.count).toBe(reads); // 2e passe : tout vient du cache
  });

  it('rend une ligne lisible', () => {
    expect(renderMapLine('src/x.ts', { symbols: ['a', 'b'], doc: 'Doc.', index: '' })).toBe(
      'src/x.ts — Doc. [a, b]',
    );
    expect(renderMapLine('src/x.ts', { symbols: [], doc: null, index: '' })).toBe('src/x.ts');
  });
});

describe('récupération lexicale (BM25)', () => {
  it('éclate camelCase/kebab, replie les accents, retire les mots vides', () => {
    expect(terms('Verrouillage du dépôt AcquireLock state-lock')).toEqual([
      'verrouillage',
      'depot',
      'acquire',
      'lock',
      'state',
      'lock',
    ]);
    expect(terms('pour les des')).toEqual([]);
  });

  it('classe d’abord le fichier dont le nom et les symboles portent la demande', async () => {
    const files = ['src/lock.ts', 'src/router.ts', 'src/dashboard.ts', 'docs/guide.md'];
    const sources = memorySources({
      'src/lock.ts': '/** Verrou principal inter-process. */\nexport function acquireLock() {}\n',
      'src/router.ts': '/** Prédiction de fichiers. */\nexport function predictFiles() {}\n',
      'src/dashboard.ts': '/** Interface web locale. */\nexport function startDashboard() {}\n',
      'docs/guide.md': '# Guide\n',
    });
    const summaries = await buildRepoMap(files, sources);
    const index = buildRetrievalIndex(files, summaries);
    expect(retrieve(index, 'corriger le verrou perdu après un crash')[0].path).toBe('src/lock.ts');
    expect(retrieve(index, 'prédire les fichiers touchés par une tâche')[0].path).toBe(
      'src/router.ts',
    );
  });

  it('le pont français → anglais retrouve « lock » depuis « verrou »', async () => {
    const files = ['src/lock.ts', 'src/other.ts'];
    const summaries = await buildRepoMap(files, memorySources({}));
    const index = buildRetrievalIndex(files, summaries);
    expect(retrieve(index, 'rendre le verrou plus robuste', { bilingual: true })[0]?.path).toBe(
      'src/lock.ts',
    );
    expect(retrieve(index, 'rendre le verrou plus robuste', { bilingual: false })).toEqual([]);
  });

  it('est déterministe et sans résultat pour une requête vide', async () => {
    const files = ['a.ts', 'b.ts'];
    const index = buildRetrievalIndex(files, new Map());
    expect(retrieve(index, 'pour les des')).toEqual([]);
    expect(retrieve(index, 'a b')).toEqual(retrieve(index, 'a b'));
  });
});

describe('graphe d’imports avec sources injectées', () => {
  beforeEach(() => resetImportGraphCache());

  it('construit le graphe depuis des sources mémoire, l’inverse, et mémorise par version', async () => {
    const sources = memorySources({
      'src/a.ts': "import { b } from './b.ts';\n",
      'src/b.ts': 'export const b = 1;\n',
      'tests/a.test.ts': "import { x } from '../src/a.ts';\n",
    });
    const files = Object.keys({ 'src/a.ts': 1, 'src/b.ts': 1, 'tests/a.test.ts': 1 });
    const graph = await buildImportGraph('', files, sources);
    expect([...graph.get('src/a.ts')]).toEqual(['src/b.ts']);
    expect([...invertImportGraph(graph).get('src/a.ts')]).toEqual(['tests/a.test.ts']);
    const reads = sources.reads.count;
    await buildImportGraph('', files, sources);
    expect(sources.reads.count).toBe(reads);
  });
});

describe('expansion déterministe', () => {
  const settings = (over = {}) => ({
    imports: 'off',
    depth: 1,
    tests: false,
    siblings: false,
    contracts: false,
    coChange: false,
    maxAdded: 6,
    ...over,
  });
  const files = new Set([
    'src/lock.ts',
    'src/lock.d.ts',
    'tests/unit/lock.test.js',
    'tests/unit/unrelated.test.js',
    'src/cli/i18n/fr.ts',
    'src/cli/i18n/en.ts',
    'src/user.ts',
    'src/errors.ts',
  ]);
  const base = (over = {}) => ({
    core: [{ path: 'src/lock.ts', confidence: 0.8 }],
    files,
    graph: null,
    inverse: null,
    coChange: null,
    settings: settings(),
    ...over,
  });

  it('ne fait rien quand tout est désactivé', () => {
    expect(expandPrediction(base())).toEqual([]);
  });

  it('apparie source ↔ test par le nom, dans les deux sens', () => {
    const forward = expandPrediction(base({ settings: settings({ tests: true }) }));
    expect(forward).toEqual([
      expect.objectContaining({
        path: 'tests/unit/lock.test.js',
        reason: 'test',
        from: 'src/lock.ts',
      }),
    ]);
    const backward = expandPrediction(
      base({
        core: [{ path: 'tests/unit/lock.test.js', confidence: 0.8 }],
        settings: settings({ tests: true }),
      }),
    );
    expect(backward.map((a) => [a.path, a.reason])).toEqual(
      expect.arrayContaining([['src/lock.ts', 'tested-code']]),
    );
  });

  it('ajoute les fichiers frères (même nom, autre extension) et les jumeaux de traduction', () => {
    const sib = expandPrediction(base({ settings: settings({ siblings: true }) }));
    expect(sib.map((a) => a.path)).toContain('src/lock.d.ts');
    const twin = expandPrediction(
      base({
        core: [{ path: 'src/cli/i18n/fr.ts', confidence: 0.9 }],
        settings: settings({ contracts: true }),
      }),
    );
    expect(twin).toEqual([
      expect.objectContaining({ path: 'src/cli/i18n/en.ts', reason: 'contract' }),
    ]);
  });

  it('suit les importeurs et importés, hors hubs et hors tests', () => {
    const graph = new Map([
      ['src/user.ts', new Set(['src/lock.ts'])],
      ['src/lock.ts', new Set(['src/errors.ts'])],
    ]);
    const inverse = invertImportGraph(graph);
    const importers = expandPrediction(
      base({ graph, inverse, settings: settings({ imports: 'importers' }) }),
    );
    expect(importers.map((a) => [a.path, a.reason])).toEqual([['src/user.ts', 'importer']]);
    const importees = expandPrediction(
      base({ graph, inverse, settings: settings({ imports: 'importees' }) }),
    );
    expect(importees.map((a) => [a.path, a.reason])).toEqual([['src/errors.ts', 'importee']]);
    // Un fichier importé par beaucoup (hub) n'est pas un candidat.
    const crowd = new Map(
      Array.from({ length: 30 }, (_, i) => [`src/m${i}.ts`, new Set(['src/errors.ts'])]),
    );
    crowd.set('src/lock.ts', new Set(['src/errors.ts']));
    const hub = expandPrediction(
      base({
        graph: crowd,
        inverse: invertImportGraph(crowd),
        settings: settings({ imports: 'importees' }),
      }),
    );
    expect(hub).toEqual([]);
  });

  it('ajoute les compagnons d’historique fiables et respecte maxAdded', () => {
    const commits = Array.from({ length: 5 }, () => ['src/lock.ts', 'src/errors.ts']);
    const model = buildCoChange(commits);
    const added = expandPrediction(
      base({ coChange: model, settings: settings({ coChange: true }) }),
    );
    expect(added).toEqual([
      expect.objectContaining({ path: 'src/errors.ts', reason: 'co-change' }),
    ]);
    const none = expandPrediction(
      base({ coChange: model, settings: settings({ coChange: true, maxAdded: 0 }) }),
    );
    expect(none).toEqual([]);
  });

  it('n’ajoute jamais un chemin hors du projet ni un doublon du LLM', () => {
    const added = expandPrediction(
      base({
        core: [
          { path: 'src/lock.ts', confidence: 0.8 },
          { path: 'tests/unit/lock.test.js', confidence: 0.8 },
        ],
        settings: settings({ tests: true }),
      }),
    );
    expect(added.map((a) => a.path)).not.toContain('tests/unit/lock.test.js');
    expect(added.every((a) => files.has(a.path))).toBe(true);
  });

  it('isTestPath et stemOf', () => {
    expect(isTestPath('tests/integration/run.test.js')).toBe(true);
    expect(isTestPath('src/run_test.go')).toBe(true);
    expect(isTestPath('src/run.ts')).toBe(false);
    expect(stemOf('tests/unit/Lock.test.js')).toBe('lock');
    expect(stemOf('src/types.d.ts')).toBe('types');
  });
});

describe('co-modification historique', () => {
  it('ignore les commits de masse et exige support et confiance', () => {
    const bulk = Array.from({ length: 40 }, (_, i) => `f${i}`);
    const model = buildCoChange([bulk, ['a', 'b'], ['a', 'b'], ['a', 'b'], ['a', 'c']]);
    expect(model.commits).toBe(4);
    expect(associatedWith(model, 'a').map((x) => x.path)).toEqual(['b']);
    expect(associatedWith(model, 'a', { minSupport: 3, minConfidence: 0.9 })).toEqual([]);
    expect(associatedWith(model, 'inconnu')).toEqual([]);
  });
});

describe('tâches vagues', () => {
  const off = { enabled: false, minConfidence: 0.3, maxFiles: null, verbs: false };
  const on = { ...off, enabled: true };

  it('désactivé : jamais de raison', () => {
    expect(
      vagueReasons({
        task: 'refactor partout',
        fileCount: 0,
        confidence: 0,
        scope: 'broad',
        settings: off,
      }),
    ).toEqual([]);
  });

  it('retient portée large, faible confiance, trop de fichiers et prédiction vide', () => {
    expect(
      vagueReasons({ task: 'x', fileCount: 3, confidence: 0.9, scope: 'broad', settings: on }),
    ).toEqual(['scope-broad']);
    expect(
      vagueReasons({ task: 'x', fileCount: 3, confidence: 0.1, scope: 'narrow', settings: on })[0],
    ).toMatch(/^low-confidence/);
    expect(
      vagueReasons({
        task: 'x',
        fileCount: 20,
        confidence: 0.9,
        scope: null,
        settings: { ...on, maxFiles: 10 },
      }),
    ).toEqual(['many-files:20']);
    expect(
      vagueReasons({ task: 'x', fileCount: 0, confidence: null, scope: null, settings: on }),
    ).toEqual(['empty-prediction']);
    expect(
      vagueReasons({ task: 'x', fileCount: 3, confidence: null, scope: null, settings: on }),
    ).toEqual([]);
  });

  it('les verbes transverses sont un signal opt-in', () => {
    const task = 'Renommer partout la notion de projet';
    expect(sweepingVerb(task)).toMatch(/renomm|partout/);
    expect(
      vagueReasons({ task, fileCount: 3, confidence: 0.9, scope: 'narrow', settings: on }),
    ).toEqual([]);
    expect(
      vagueReasons({
        task,
        fileCount: 3,
        confidence: 0.9,
        scope: 'narrow',
        settings: { ...on, verbs: true },
      })[0],
    ).toMatch(/^sweeping-verb/);
    expect(sweepingVerb('Corriger le message affiché au démarrage')).toBeNull();
  });
});

describe('fichiers de tenue de livre', () => {
  it('reconnaît journal, README, docs, roadmap, manifestes et verrous — pas le code', () => {
    const shared = compileSharedMatcher(DEFAULT_SHARED_PATTERNS);
    for (const f of [
      'CHANGELOG.md',
      'README.fr.md',
      'docs/fr/x.md',
      'roadmap/roadmap.md',
      'package.json',
      'package-lock.json',
      'native/Cargo.lock',
      'pkg/yarn.lock',
      'packages/a/README.md',
    ]) {
      expect(shared(f), f).toBe(true);
    }
    for (const f of [
      'src/router.js',
      'tests/unit/router.test.js',
      'scripts/docs.ts',
      'src/docs-sync.ts',
    ]) {
      expect(shared(f), f).toBe(false);
    }
    expect(partitionShared(['src/a.ts', 'CHANGELOG.md'], shared)).toEqual({
      own: ['src/a.ts'],
      shared: ['CHANGELOG.md'],
    });
  });
});

describe('arbre classé par scores déterministes (BM25) fournis par l’appelant', () => {
  it('place en tête les fichiers les mieux notés quand l’arbre déborde du budget', async () => {
    const { buildRouterTree } = await import('../../src/router-tree.ts');
    const files = Array.from({ length: 800 }, (_, i) => `packages/core/src/module-${i}/index.ts`);
    files.push('src/lock/state-lock.ts');
    const tree = await buildRouterTree({
      files,
      task: 'zzz sans mot reconnu',
      settings: {
        mode: 'auto',
        maxTreeTokens: 600,
        exclude: [],
        importExpansion: false,
      },
      estimator: { charsPerToken: 3, safetyFactor: 1.15 },
      scores: new Map([['src/lock/state-lock.ts', 9]]),
    });
    expect(tree.mode).toBe('ranked');
    expect(tree.text).toContain('state-lock.ts');
    expect(tree.shown).toBeLessThan(files.length);
  });
});

describe('historique git de co-modification', () => {
  it('refuse une référence qui ressemble à une option git', async () => {
    const { loadCoChange } = await import('../../src/router-cochange.ts');
    await expect(loadCoChange('.', '--output=/tmp/x')).rejects.toThrow(/référence git invalide/);
    await expect(loadCoChange('.', '-n1')).rejects.toThrow(/référence git invalide/);
  });
});

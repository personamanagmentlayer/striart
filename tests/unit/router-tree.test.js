import { describe, expect, it } from 'vitest';
import { buildRouterTree, keywords } from '../../src/router-tree.ts';
import { detectCollisions, WHOLE_REPO } from '../../src/router.js';

const ESTIMATOR = { charsPerToken: 3, safetyFactor: 1.15 };
const SETTINGS = (over = {}) => ({
  mode: 'auto',
  maxTreeTokens: 6000,
  exclude: ['**/dist/**', '**/*.png', '**/node_modules/**'],
  importExpansion: false,
  ...over,
});

const bigTree = () => [
  ...Array.from({ length: 800 }, (_, i) => `packages/core/src/module-${i}/index.ts`),
  ...Array.from({ length: 200 }, (_, i) => `docs/page-${i}.md`),
  'src/auth/login.ts',
  'src/auth/session.ts',
  'dist/bundle.js',
  'assets/logo.png',
];

describe('arbre du Router', () => {
  it('auto : petit arbre → liste brute inchangée (comportement historique)', async () => {
    const files = ['src/a.js', 'src/b.js', 'dist/x.js'];
    const tree = await buildRouterTree({
      files,
      task: 't',
      settings: SETTINGS(),
      estimator: ESTIMATOR,
    });
    expect(tree.mode).toBe('full');
    expect(tree.text).toBe('dist/x.js\nsrc/a.js\nsrc/b.js');
    expect(tree.omitted).toBe(0);
  });

  it('mode full : jamais de filtre ni de compaction', async () => {
    const tree = await buildRouterTree({
      files: bigTree(),
      task: 't',
      settings: SETTINGS({ mode: 'full' }),
      estimator: ESTIMATOR,
    });
    expect(tree.mode).toBe('full');
    expect(tree.total).toBe(tree.shown);
  });

  it('compact : ressources filtrées, chemins regroupés par dossier, légende présente', async () => {
    const tree = await buildRouterTree({
      files: ['src/a.ts', 'src/b.ts', 'dist/x.js', 'logo.png', 'README.md'],
      task: 'modifier src',
      settings: SETTINGS({ mode: 'compact' }),
      estimator: ESTIMATOR,
    });
    expect(tree.mode).toBe('compact');
    expect(tree.text).toContain('src/: a.ts, b.ts');
    expect(tree.text).toContain('./: README.md');
    expect(tree.text).not.toContain('dist/');
    expect(tree.text).not.toContain('logo.png');
    expect(tree.text).toContain('FULL paths');
    expect(tree.omitted).toBe(2);
  });

  it('un fichier NOMMÉ dans la tâche n’est jamais filtré', async () => {
    const tree = await buildRouterTree({
      files: ['dist/x.js', 'src/a.ts'],
      task: 'corriger dist/x.js',
      settings: SETTINGS({ mode: 'compact' }),
      estimator: ESTIMATOR,
    });
    expect(tree.text).toContain('dist/: x.js');
  });

  it('débordement : classé par pertinence, résumé par dossier, déclaré comme tel (aucune troncature silencieuse)', async () => {
    const files = bigTree();
    const tree = await buildRouterTree({
      files,
      task: 'corriger le login et la session dans auth',
      settings: SETTINGS({ maxTreeTokens: 1500 }),
      estimator: ESTIMATOR,
    });
    expect(tree.mode).toBe('ranked');
    expect(tree.text).toContain('src/auth/: login.ts, session.ts');
    expect(tree.text).toMatch(/NOTE: \d+ of \d+ project files are listed, ranked/);
    expect(tree.text).toContain('Not shown:');
    expect(tree.estimatedTokens).toBeLessThanOrEqual(1500);
    expect(tree.omitted).toBe(tree.total - tree.shown);
    expect(tree.total).toBe(files.length - 2 + 2); // total d'origine, filtre compris
  });

  it('déterministe : même entrée, même sortie (préfixe de cache stable)', async () => {
    const a = await buildRouterTree({
      files: bigTree(),
      task: 'x y z',
      settings: SETTINGS({ mode: 'compact' }),
      estimator: ESTIMATOR,
    });
    const b = await buildRouterTree({
      files: [...bigTree()].reverse(),
      task: 'autre tâche',
      settings: SETTINGS({ mode: 'compact' }),
      estimator: ESTIMATOR,
    });
    expect(a.text).toBe(b.text);
  });

  it('keywords : éclate camelCase, retire mots vides et accents', () => {
    expect(keywords('Corriger LoginHandler dans les tests')).toEqual(['login', 'handler', 'tests']);
  });
});

describe('sérialisation prudente (WHOLE_REPO)', () => {
  const agents = [
    { name: 'a', predictedFiles: ['src/x.js'] },
    { name: 'b', predictedFiles: [] },
  ];
  it('une prédiction WHOLE_REPO entre en collision avec tout agent actif', () => {
    expect(detectCollisions([WHOLE_REPO], agents)).toEqual([
      { agent: 'a', files: [WHOLE_REPO] },
      { agent: 'b', files: [WHOLE_REPO] },
    ]);
  });
  it('un agent qui détient WHOLE_REPO bloque les nouvelles tâches', () => {
    expect(detectCollisions(['src/y.js'], [{ name: 'a', predictedFiles: [WHOLE_REPO] }])).toEqual([
      { agent: 'a', files: [WHOLE_REPO] },
    ]);
  });
  it('sans WHOLE_REPO : intersection exacte comme avant', () => {
    expect(detectCollisions(['src/x.js'], agents)).toEqual([{ agent: 'a', files: ['src/x.js'] }]);
  });
});

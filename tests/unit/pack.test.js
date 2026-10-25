import { describe, expect, it } from 'vitest';
import path from 'node:path';
import {
  analyzeEmittedModule,
  assertPublishableIndex,
  binTargets,
  buildStagedManifest,
  emittedPath,
  DEFAULT_OUT_DIR,
  isCoveredByFilesEntry,
  parseCli,
  parseLsFilesIndex,
  parsePorcelainZ,
  planPackFiles,
  resolveNpmCli,
  unresolvedImports,
  verifyPackedFiles,
  addNativeDistribution,
  buildNativeManifest,
  expectedPlatformPackageFiles,
  mergeNativeSbom,
  nativeSbomComponents,
  selectNativePlatforms,
  verifyNativeFilesPacked,
} from '../../scripts/pack.ts';

const FILES = [
  'src/',
  'examples/',
  'README.md',
  'README.fr.md',
  'CHANGELOG.md',
  'LICENSE',
  '.env.example',
];

describe('scripts/pack.ts — sélection des fichiers publiés', () => {
  it('ne retient que les fichiers suivis couverts par "files" (+ .npmignore)', () => {
    const plan = planPackFiles(
      [
        'src/cli.js',
        'src/acp.ts',
        'src/types.d.ts',
        'examples/plan.example.yaml',
        'README.md',
        '.npmignore',
        '.npmrc',
        'tests/unit/x.test.js',
        'scripts/pack.ts',
        'srcx/evil.js',
        'README.md.bak',
      ],
      FILES,
    );
    expect(plan.compile).toEqual(['src/acp.ts', 'src/cli.js']);
    expect(plan.copy).toEqual(['.npmignore', 'README.md', 'examples/plan.example.yaml']);
    expect(plan.dropped.map((d) => d.file)).toEqual(['src/types.d.ts']);
  });

  it('refuse un .ts hors de src/ (inexécutable une fois installé)', () => {
    expect(() => planPackFiles(['examples/tool.ts'], FILES)).toThrow(
      expect.objectContaining({ code: 'PACK_UNSUPPORTED_FILE' }),
    );
  });

  it('refuse les extensions TypeScript non émises (.tsx/.mts/.cts)', () => {
    for (const file of ['src/view.tsx', 'src/x.mts', 'src/y.cts']) {
      expect(() => planPackFiles([file], FILES)).toThrow(
        expect.objectContaining({ code: 'PACK_UNSUPPORTED_FILE' }),
      );
    }
  });

  it('refuse deux sources qui produiraient le même .js', () => {
    expect(() => planPackFiles(['src/a.js', 'src/a.ts'], FILES)).toThrow(
      expect.objectContaining({ code: 'PACK_OUTPUT_COLLISION' }),
    );
  });

  it('refuse une entrée "files" à motif glob plutôt que de perdre des fichiers en silence', () => {
    expect(() => isCoveredByFilesEntry('src/a.js', ['src/**/*.js'])).toThrow(
      expect.objectContaining({ code: 'PACK_UNSUPPORTED_FILES_ENTRY' }),
    );
  });

  it('couvre un dossier avec ou sans « / » final, et un fichier exact seulement', () => {
    expect(isCoveredByFilesEntry('examples/a.yaml', ['examples'])).toBe(true);
    expect(isCoveredByFilesEntry('examples/a.yaml', ['./examples/'])).toBe(true);
    expect(isCoveredByFilesEntry('examplesX/a.yaml', ['examples'])).toBe(false);
    expect(isCoveredByFilesEntry('LICENSE.old', ['LICENSE'])).toBe(false);
  });

  it('nomme la sortie émise : .ts → .js, .js inchangé', () => {
    expect(emittedPath('src/acp.ts')).toBe('src/acp.js');
    expect(emittedPath('src/cli.js')).toBe('src/cli.js');
  });
});

describe('scripts/pack.ts — package.json de staging', () => {
  const manifest = {
    name: '@jumsay/striart',
    version: '1.2.3',
    type: 'module',
    bin: { striart: './src/cli.js' },
    files: FILES,
    scripts: { test: 'vitest run' },
    dependencies: { commander: '^12.0.0' },
    devDependencies: { vitest: '^4.0.0' },
    publishConfig: { registry: 'https://registry.example/' },
    engines: { node: '>=22.18' },
    private: true,
  };

  it('retire scripts, devDependencies et private (garde anti-publication du dépôt), conserve le reste', () => {
    const staged = buildStagedManifest(manifest, { gitHead: null });
    expect(staged).not.toHaveProperty('private');
    expect(staged).not.toHaveProperty('scripts');
    expect(staged).not.toHaveProperty('devDependencies');
    expect(staged).toEqual({
      name: '@jumsay/striart',
      version: '1.2.3',
      type: 'module',
      bin: { striart: './src/cli.js' },
      files: FILES,
      dependencies: { commander: '^12.0.0' },
      publishConfig: { registry: 'https://registry.example/' },
      engines: { node: '>=22.18' },
    });
    // Le manifeste source n'est jamais muté.
    expect(manifest.scripts).toEqual({ test: 'vitest run' });
  });

  it('renseigne gitHead seulement pour un arbre propre', () => {
    expect(buildStagedManifest(manifest, { gitHead: 'abc123' }).gitHead).toBe('abc123');
    expect(
      buildStagedManifest({ ...manifest, gitHead: 'stale' }, { gitHead: null }),
    ).not.toHaveProperty('gitHead');
  });

  it('normalise les cibles bin (objet ou chaîne)', () => {
    expect(binTargets(manifest)).toEqual(['src/cli.js']);
    expect(binTargets({ bin: 'src\\cli.js' })).toEqual(['src/cli.js']);
    expect(binTargets({})).toEqual([]);
  });
});

describe('scripts/pack.ts — contrôle du JS émis', () => {
  it('signale les chemins .ts construits à l’exécution, jamais réécrits par tsc', () => {
    const code = [
      "import { a } from './ok.js';",
      "const u = new URL('./host.ts', import.meta.url);",
      "const p = path.join(dir, 'acp.ts');",
      'const t = `./${name}.ts`;',
      "const extensions = ['.js', '.ts'];",
    ].join('\n');
    const { tsPaths } = analyzeEmittedModule(code, new Set(['acp.ts']));
    expect(tsPaths.map((h) => h.line)).toEqual([2, 3, 4]);
  });

  it("ignore les commentaires (JSDoc import('./x.ts') inerte à l’exécution)", () => {
    const code = [
      '/**',
      " * @param {import('./merge-subject.ts').MergeResolution} r",
      ' */',
      "// voir './acp.ts'",
      'export const x = 1;',
    ].join('\n');
    expect(analyzeEmittedModule(code, new Set(['acp.ts'])).tsPaths).toEqual([]);
  });

  it('collecte les imports relatifs statiques, re-exports et import() à littéral', () => {
    const code = [
      "import { a } from './a.js';",
      "export { b } from '../b.js';",
      "import 'node:path';",
      "import pkg from 'commander';",
      "const m = await import('./lazy.js');",
      'const n = await import(dynamicName);',
    ].join('\n');
    expect(analyzeEmittedModule(code).relativeImports.map((i) => i.specifier)).toEqual([
      './a.js',
      '../b.js',
      './lazy.js',
    ]);
  });

  it('trouve les imports qui ne désignent aucun fichier publié', () => {
    const packed = new Set(['src/cli.js', 'src/a.js', 'package.json']);
    expect(
      unresolvedImports('src/cli.js', ['./a.js', './missing.js', '../package.json'], packed),
    ).toEqual(['./missing.js']);
  });

  it('refuse une archive contenant un .ts ou privée de sa cible bin', () => {
    const manifest = { bin: { striart: './src/cli.js' } };
    expect(() => verifyPackedFiles(['package.json', 'src/cli.js'], manifest)).not.toThrow();
    expect(() => verifyPackedFiles(['package.json', 'src/cli.js', 'src/acp.ts'], manifest)).toThrow(
      expect.objectContaining({ code: 'PACK_CONTENT_INVALID' }),
    );
    expect(() => verifyPackedFiles(['package.json'], manifest)).toThrow(
      expect.objectContaining({ code: 'PACK_CONTENT_INVALID' }),
    );
  });

  // Documentation de conception, consignes d'agents et feuille de route ne
  // quittent jamais le dépôt : l'archive est refusée si l'une d'elles y figure.
  it.each([
    'AGENTS.md',
    'CLAUDE.md',
    'src/agents/AGENTS.md',
    '.claude/CLAUDE.md',
    '.claude/agents/code-reviewer.md',
    'docs/fr/architecture.md',
    'roadmap/roadmap.md',
    'CONTRIBUTING.md',
    'SECURITY.md',
    'scripts/public/AGENTS.md',
    'docs/adr/0001-clone-integration.md',
  ])('refuse une archive contenant %s (documentation interne ou consigne d’agent)', (leaked) => {
    const manifest = { bin: { striart: './src/cli.js' } };
    expect(() =>
      verifyPackedFiles(['package.json', 'src/cli.js', 'README.md', leaked], manifest),
    ).toThrow(expect.objectContaining({ code: 'PACK_CONTENT_INVALID' }));
  });

  it('laisse passer README, CHANGELOG, LICENSE, schémas et exemples', () => {
    const manifest = { bin: { striart: './src/cli.js' } };
    expect(() =>
      verifyPackedFiles(
        [
          'package.json',
          'src/cli.js',
          'src/agents/catalog.js',
          'README.md',
          'README.fr.md',
          'CHANGELOG.md',
          'LICENSE',
          '.env.example',
          'schemas/striart-document-v1.schema.json',
          'examples/plan.example.yaml',
          'native/keys/minisign.pub',
        ],
        manifest,
      ),
    ).not.toThrow();
  });
});

describe('scripts/pack.ts — index git (provenance du contenu publié)', () => {
  const stage = [
    '100644 1111111111111111111111111111111111111111 0\tsrc/a.js',
    '100755 2222222222222222222222222222222222222222 0\tsrc/cli.js',
    '120000 3333333333333333333333333333333333333333 0\tREADME.md',
    '100644 4444444444444444444444444444444444444444 0\tsrc/b.ts',
    '',
  ].join('\0');
  const tags = ['H src/a.js', 'H src/cli.js', 'H README.md', 'S src/b.ts', ''].join('\0');

  it('lit mode, objet et marqueurs (skip-worktree / assume-unchanged) de chaque entrée', () => {
    const index = parseLsFilesIndex(stage, tags);
    expect(index.get('src/a.js')).toEqual({
      mode: '100644',
      object: '1111111111111111111111111111111111111111',
      hidden: false,
    });
    expect(index.get('src/cli.js')?.mode).toBe('100755');
    expect(index.get('src/b.ts')?.hidden).toBe(true);
    expect(parseLsFilesIndex(stage, 'h src/a.js\0').get('src/a.js')?.hidden).toBe(true);
  });

  it('refuse un lien symbolique publié (son contenu serait celui de la cible)', () => {
    const index = parseLsFilesIndex(stage, tags.replace('S src/b.ts', 'H src/b.ts'));
    expect(() => assertPublishableIndex(index, ['src/a.js', 'README.md'])).toThrowError(
      expect.objectContaining({ code: 'PACK_UNSUPPORTED_MODE' }),
    );
    expect(() => assertPublishableIndex(index, ['src/a.js', 'src/cli.js'])).not.toThrow();
  });

  it('refuse un fichier masqué au contrôle de propreté (skip-worktree, assume-unchanged)', () => {
    const index = parseLsFilesIndex(stage, tags);
    expect(() => assertPublishableIndex(index, ['src/b.ts'])).toThrowError(
      expect.objectContaining({ code: 'PACK_HIDDEN_CHANGES' }),
    );
  });

  it('refuse un fichier planifié absent de l’index', () => {
    const index = parseLsFilesIndex(stage, tags);
    expect(() => assertPublishableIndex(index, ['src/ghost.js'])).toThrowError(
      expect.objectContaining({ code: 'PACK_NOT_IN_INDEX' }),
    );
  });
});

describe('scripts/pack.ts — utilitaires', () => {
  it('analyse git status --porcelain -z, renommages compris', () => {
    const out = ' M src/a.js\0?? src/new.ts\0R  src/b.js\0src/old-b.js\0 D src/gone.js\0';
    expect(parsePorcelainZ(out)).toEqual([
      { status: ' M', file: 'src/a.js' },
      { status: '??', file: 'src/new.ts' },
      { status: 'R ', file: 'src/b.js' },
      { status: ' D', file: 'src/gone.js' },
    ]);
    expect(parsePorcelainZ('')).toEqual([]);
  });

  it('résout npm-cli.js : npm_execpath d’abord, puis à côté du binaire Node', () => {
    const fromEnv = path.join('opt', 'npm', 'bin', 'npm-cli.js');
    expect(
      resolveNpmCli({ env: { npm_execpath: fromEnv }, execPath: '/x/node', exists: () => true }),
    ).toBe(fromEnv);
    const execPath = path.join('C:', 'node', 'node.exe');
    const windows = path.join(path.dirname(execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
    expect(
      resolveNpmCli({
        env: { npm_execpath: 'C:/yarn/yarn.js' }, // pas npm : ignoré
        execPath,
        exists: (p) => p === windows,
      }),
    ).toBe(windows);
  });

  it('échoue explicitement quand npm est introuvable', () => {
    expect(() => resolveNpmCli({ env: {}, execPath: '/x/node', exists: () => false })).toThrow(
      expect.objectContaining({ code: 'PACK_NPM_NOT_FOUND' }),
    );
  });
});

describe('scripts/pack.ts — ligne de commande', () => {
  it('options par défaut : dist/ du dépôt, ni dry-run ni --allow-dirty', () => {
    expect(parseCli([])).toEqual({
      outDir: DEFAULT_OUT_DIR,
      dryRun: false,
      json: false,
      allowDirty: false,
      keepStaging: false,
      nativeDir: null,
      nativePlatforms: null,
      signingScheme: 'minisign',
      ephemeralSigningKey: false,
      signingPublicKey: null,
    });
    expect(parseCli(['--help'])).toBe('help');
  });

  it('option inconnue = erreur d’usage (sortie 2), jamais ignorée', () => {
    expect(() => parseCli(['--bogus'])).toThrow(
      expect.objectContaining({ code: 'PACK_USAGE', usage: true }),
    );
  });

  it('npm publish depuis le dépôt (hook prepublishOnly) est refusé avec la marche à suivre', () => {
    expect(() => parseCli(['--refuse-raw-publish'])).toThrow(
      expect.objectContaining({ code: 'PACK_RAW_PUBLISH', usage: false }),
    );
  });
});

describe('scripts/pack.ts — distribution native', () => {
  const platforms = selectNativePlatforms(null);
  const artifacts = platforms.map((platform, i) => ({
    platform,
    source: `/native/${platform.key}`,
    sha256: String(i).repeat(64),
    size: 100 + i,
  }));

  it('les six plateformes par défaut ; sélection explicite validée', () => {
    expect(platforms.map((p) => p.key)).toHaveLength(6);
    expect(selectNativePlatforms(['linux-x64', 'win32-x64']).map((p) => p.key)).toEqual([
      'win32-x64',
      'linux-x64',
    ]);
    expect(() => selectNativePlatforms(['linux-ia32'])).toThrow(
      expect.objectContaining({ code: 'PACK_USAGE', usage: true }),
    );
    expect(() => selectNativePlatforms([])).toThrow(
      expect.objectContaining({ code: 'PACK_USAGE' }),
    );
  });

  it('options natives de la ligne de commande', () => {
    expect(
      parseCli([
        '--native-dir',
        'dist/native',
        '--native-platforms',
        'win32-x64, linux-x64',
        '--signing-scheme',
        'minisign',
        '--ephemeral-signing-key',
        '--dry-run',
      ]),
    ).toMatchObject({
      nativeDir: path.resolve('dist/native'),
      nativePlatforms: ['win32-x64', 'linux-x64'],
      signingScheme: 'minisign',
      ephemeralSigningKey: true,
    });
  });

  it('manifeste : clés triées, relu par la validation du chargement', () => {
    const manifest = buildNativeManifest('0.11.0', [...artifacts].reverse(), {
      nativeVersion: '0.1.0',
    });
    expect(Object.keys(manifest.binaries)).toEqual([...platforms.map((p) => p.key)].sort());
    expect(manifest).toMatchObject({ schemaVersion: 1, protocol: 1, version: '0.11.0' });
    expect(manifest.binaries['linux-arm64']).toEqual({
      package: '@jumsay/striart-native-linux-arm64',
      path: 'bin/striart-native',
      sha256: '5'.repeat(64),
      size: 105,
    });
    expect(() => buildNativeManifest('latest', artifacts, { nativeVersion: '0.1.0' })).toThrow();
    expect(manifest.nativeVersion).toBe('0.1.0');
    expect(manifest.ephemeral).toBeUndefined();
  });

  it('package.json de staging : dépendances optionnelles EXACTES et fichiers du manifeste', () => {
    const staged = addNativeDistribution(
      { name: '@jumsay/striart', version: '0.11.0', files: ['src/', 'native/keys/'] },
      platforms,
    );
    expect(Object.values(staged.optionalDependencies)).toEqual(Array(6).fill('0.11.0'));
    expect(Object.keys(staged.optionalDependencies)).toContain('@jumsay/striart-native-darwin-x64');
    expect(staged.files).toEqual([
      'src/',
      'native/keys/',
      'native-manifest.json',
      'native-manifest.sig.json',
    ]);
  });

  it('archive principale : manifeste, signature et clé publique exigés', () => {
    expect(() =>
      verifyNativeFilesPacked(
        ['native-manifest.json', 'native-manifest.sig.json', 'native/keys/minisign.pub'],
        'minisign',
      ),
    ).not.toThrow();
    expect(() => verifyNativeFilesPacked(['native-manifest.json'], 'minisign')).toThrow(
      expect.objectContaining({ code: 'PACK_CONTENT_INVALID' }),
    );
  });

  it('paquet de plateforme : contenu exact attendu', () => {
    expect(expectedPlatformPackageFiles(platforms[0])).toEqual([
      'LICENSE',
      'bin/striart-native.exe',
      'package.json',
    ]);
  });

  it('SBOM : un composant par binaire (SHA-256, cible) et par crate du registre', () => {
    const components = nativeSbomComponents('0.11.0', artifacts.slice(0, 1), [
      { name: 'libc', version: '0.2.190', source: 'registry+x', checksum: 'c'.repeat(64) },
      { name: 'striart-native', version: '0.1.0', source: null, checksum: null },
    ]);
    expect(components).toHaveLength(2);
    expect(components[0]).toMatchObject({
      type: 'application',
      purl: 'pkg:npm/%40jumsay/striart-native-win32-x64@0.11.0',
      hashes: [{ alg: 'SHA-256', content: '0'.repeat(64) }],
    });
    expect(components[1]).toMatchObject({ purl: 'pkg:cargo/libc@0.2.190' });
    const merged = JSON.parse(
      mergeNativeSbom('{"bomFormat":"CycloneDX","components":[{"name":"a"}]}', components),
    );
    expect(merged.components).toHaveLength(3);
    expect(() => mergeNativeSbom('not json', components)).toThrow(
      expect.objectContaining({ code: 'PACK_SBOM_FAILED' }),
    );
  });
});

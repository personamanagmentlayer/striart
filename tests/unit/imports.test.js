import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildImportGraph, detectSemanticNeighbors } from '../../src/imports.js';

describe('buildImportGraph', () => {
  let root;

  beforeAll(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'striart-imports-'));
    await mkdir(path.join(root, 'src', 'utils'), { recursive: true });
    await writeFile(path.join(root, 'src', 'auth.js'), 'export function hash() {}\n');
    await writeFile(
      path.join(root, 'src', 'login.js'),
      "import { hash } from './auth.js';\nimport express from 'express';\n",
    );
    await writeFile(
      path.join(root, 'src', 'signup.ts'),
      "import { hash } from './auth';\nconst lazy = await import('./utils');\n",
    );
    await writeFile(
      path.join(root, 'src', 'utils', 'index.js'),
      "const { hash } = require('../auth.js');\n",
    );
    await writeFile(path.join(root, 'src', 'styles.css'), "@import './auth.js';\n");
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true, maxRetries: 5 });
  });

  const FILES = [
    'src/auth.js',
    'src/login.js',
    'src/signup.ts',
    'src/utils/index.js',
    'src/styles.css',
  ];

  it('résout imports ESM, extension implicite, dynamic import, require et index', async () => {
    const graph = await buildImportGraph(root, FILES);
    expect([...graph.get('src/login.js')]).toEqual(['src/auth.js']); // express (bare) ignoré
    expect([...graph.get('src/signup.ts')].sort()).toEqual(['src/auth.js', 'src/utils/index.js']);
    expect([...graph.get('src/utils/index.js')]).toEqual(['src/auth.js']); // require + remontée ../
  });

  it('ignore les fichiers non couverts et les fichiers absents', async () => {
    const graph = await buildImportGraph(root, FILES.concat('src/fantome.js'));
    expect(graph.has('src/styles.css')).toBe(false);
    expect(graph.has('src/fantome.js')).toBe(false);
  });
});

describe('buildImportGraph — multi-langages (imports relatifs uniquement)', () => {
  let root;

  beforeAll(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'striart-imports-ml-'));
    await mkdir(path.join(root, 'pkg', 'sub'), { recursive: true });
    await mkdir(path.join(root, 'lib'), { recursive: true });
    // Python : relatif à 1 et 2 points, `from . import x`, absolu ignoré.
    await writeFile(path.join(root, 'pkg', '__init__.py'), '');
    await writeFile(path.join(root, 'pkg', 'db.py'), 'def connect(): ...\n');
    await writeFile(
      path.join(root, 'pkg', 'api.py'),
      'import os\nfrom .db import connect\nfrom . import models\n',
    );
    await writeFile(path.join(root, 'pkg', 'models.py'), 'from os import path\n');
    await writeFile(path.join(root, 'pkg', 'sub', 'deep.py'), 'from ..db import connect\n');
    // Ruby : require_relative résolu, require (LOAD_PATH) ignoré.
    await writeFile(path.join(root, 'lib', 'helper.rb'), 'def aide; end\n');
    await writeFile(
      path.join(root, 'lib', 'app.rb'),
      "require 'json'\nrequire_relative 'helper'\n",
    );
    // PHP : require/include relatifs (avec et sans __DIR__), use ignoré.
    await writeFile(path.join(root, 'lib', 'config.php'), '<?php $x = 1;\n');
    await writeFile(
      path.join(root, 'lib', 'index.php'),
      "<?php\nrequire __DIR__ . '/config.php';\ninclude_once('config.php');\nuse App\\Service;\n",
    );
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true, maxRetries: 5 });
  });

  const FILES = [
    'pkg/__init__.py',
    'pkg/db.py',
    'pkg/api.py',
    'pkg/models.py',
    'pkg/sub/deep.py',
    'lib/helper.rb',
    'lib/app.rb',
    'lib/config.php',
    'lib/index.php',
  ];

  it('Python : from .x, from . import y, remontée ..', async () => {
    const graph = await buildImportGraph(root, FILES);
    expect([...graph.get('pkg/api.py')].sort()).toEqual(['pkg/db.py', 'pkg/models.py']);
    expect([...graph.get('pkg/sub/deep.py')]).toEqual(['pkg/db.py']);
    // `import os` / `from os import path` (absolus) : jamais dans le graphe.
    expect(graph.has('pkg/models.py')).toBe(false);
  });

  it('Ruby : require_relative résolu, require ignoré', async () => {
    const graph = await buildImportGraph(root, FILES);
    expect([...graph.get('lib/app.rb')]).toEqual(['lib/helper.rb']);
  });

  it('PHP : require __DIR__ et include relatifs résolus, use ignoré', async () => {
    const graph = await buildImportGraph(root, FILES);
    expect([...graph.get('lib/index.php')]).toEqual(['lib/config.php']);
  });
});

describe('detectSemanticNeighbors', () => {
  const graph = new Map([
    ['src/login.js', new Set(['src/auth.js'])],
    ['src/signup.js', new Set(['src/auth.js'])],
  ]);

  it("avertit quand les fichiers d'un agent importent les miens", () => {
    const warnings = detectSemanticNeighbors({
      graph,
      predictedFiles: ['src/auth.js'],
      agents: [{ name: 'agent-login', predictedFiles: ['src/login.js'] }],
    });
    expect(warnings).toEqual([
      { agent: 'agent-login', links: [{ file: 'src/auth.js', importedBy: 'src/login.js' }] },
    ]);
  });

  it("avertit dans l'autre sens (mes fichiers importent les leurs)", () => {
    const warnings = detectSemanticNeighbors({
      graph,
      predictedFiles: ['src/signup.js'],
      agents: [{ name: 'agent-auth', predictedFiles: ['src/auth.js'] }],
    });
    expect(warnings).toEqual([
      { agent: 'agent-auth', links: [{ file: 'src/auth.js', importedBy: 'src/signup.js' }] },
    ]);
  });

  it('silencieux quand les périmètres sont indépendants', () => {
    const warnings = detectSemanticNeighbors({
      graph,
      predictedFiles: ['src/ui.js'],
      agents: [{ name: 'agent-auth', predictedFiles: ['src/auth.js'] }],
    });
    expect(warnings).toEqual([]);
  });
});

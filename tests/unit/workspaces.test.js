import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { detectWorkspaceLinks, fileToPackage, loadWorkspaces } from '../../src/workspaces.js';

async function writeJson(file, data) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(data, null, 2));
}

describe('workspaces monorepo', () => {
  let root;
  let workspaces;

  beforeAll(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'striart-ws-'));
    await writeJson(path.join(root, 'package.json'), {
      name: 'monorepo',
      workspaces: ['packages/*', 'apps/web'],
    });
    await writeJson(path.join(root, 'packages', 'auth', 'package.json'), { name: '@acme/auth' });
    await writeJson(path.join(root, 'packages', 'ui', 'package.json'), {
      name: '@acme/ui',
      dependencies: { '@acme/auth': 'workspace:*', react: '^18' },
    });
    await writeJson(path.join(root, 'packages', 'docs', 'package.json'), { name: '@acme/docs' });
    await writeJson(path.join(root, 'apps', 'web', 'package.json'), {
      name: '@acme/web',
      devDependencies: { '@acme/ui': 'workspace:*' },
    });
    workspaces = await loadWorkspaces(root);
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true, maxRetries: 5 });
  });

  it('charge les packages depuis les motifs workspaces (glob * et chemin explicite)', () => {
    expect(workspaces.map((w) => w.name).sort()).toEqual([
      '@acme/auth',
      '@acme/docs',
      '@acme/ui',
      '@acme/web',
    ]);
    const ui = workspaces.find((w) => w.name === '@acme/ui');
    expect(ui.dir).toBe('packages/ui');
    expect(ui.dependencies.has('@acme/auth')).toBe(true);
  });

  it('Cargo : [workspace] members, noms et dépendances des crates', async () => {
    const cargo = await mkdtemp(path.join(os.tmpdir(), 'striart-cargo-'));
    try {
      await mkdir(path.join(cargo, 'crates', 'core'), { recursive: true });
      await mkdir(path.join(cargo, 'crates', 'cli'), { recursive: true });
      await writeFile(path.join(cargo, 'Cargo.toml'), '[workspace]\nmembers = ["crates/*"]\n');
      await writeFile(
        path.join(cargo, 'crates', 'core', 'Cargo.toml'),
        '[package]\nname = "acme-core"\nversion = "0.1.0"\n\n[dependencies]\nserde = "1"\n',
      );
      await writeFile(
        path.join(cargo, 'crates', 'cli', 'Cargo.toml'),
        '[package]\nname = "acme-cli"\nversion = "0.1.0"\n\n[dependencies]\nacme-core = { path = "../core" }\nclap = "4"\n',
      );
      const pkgs = await loadWorkspaces(cargo);
      expect(pkgs.map((p) => p.name).sort()).toEqual(['acme-cli', 'acme-core']);
      const cli = pkgs.find((p) => p.name === 'acme-cli');
      expect(cli.dir).toBe('crates/cli');
      expect(cli.dependencies.has('acme-core')).toBe(true);
    } finally {
      await rm(cargo, { recursive: true, force: true, maxRetries: 5 });
    }
  });

  it('Go : go.work use + go.mod (module, require, replace)', async () => {
    const go = await mkdtemp(path.join(os.tmpdir(), 'striart-go-'));
    try {
      await mkdir(path.join(go, 'svc'), { recursive: true });
      await mkdir(path.join(go, 'shared'), { recursive: true });
      await writeFile(path.join(go, 'go.work'), 'go 1.26\n\nuse (\n\t./svc\n\t./shared\n)\n');
      await writeFile(
        path.join(go, 'shared', 'go.mod'),
        'module example.com/acme/shared\n\ngo 1.26\n',
      );
      await writeFile(
        path.join(go, 'svc', 'go.mod'),
        'module example.com/acme/svc\n\ngo 1.26\n\nrequire example.com/acme/shared v0.0.0\n\nreplace example.com/acme/shared => ../shared\n',
      );
      const pkgs = await loadWorkspaces(go);
      expect(pkgs.map((p) => p.name).sort()).toEqual([
        'example.com/acme/shared',
        'example.com/acme/svc',
      ]);
      const svc = pkgs.find((p) => p.name === 'example.com/acme/svc');
      expect(svc.dir).toBe('svc');
      expect(svc.dependencies.has('example.com/acme/shared')).toBe(true);
    } finally {
      await rm(go, { recursive: true, force: true, maxRetries: 5 });
    }
  });

  it('Maven : <modules> du pom racine, artifactId hors <parent>, dépendances', async () => {
    const mvn = await mkdtemp(path.join(os.tmpdir(), 'striart-mvn-'));
    try {
      await mkdir(path.join(mvn, 'core'), { recursive: true });
      await mkdir(path.join(mvn, 'web'), { recursive: true });
      await writeFile(
        path.join(mvn, 'pom.xml'),
        '<project><artifactId>parent</artifactId><modules><module>core</module><module>web</module></modules></project>',
      );
      await writeFile(
        path.join(mvn, 'core', 'pom.xml'),
        '<project><parent><artifactId>parent</artifactId></parent><artifactId>acme-core</artifactId></project>',
      );
      await writeFile(
        path.join(mvn, 'web', 'pom.xml'),
        '<project><parent><artifactId>parent</artifactId></parent><artifactId>acme-web</artifactId><dependencies><dependency><groupId>com.acme</groupId><artifactId>acme-core</artifactId></dependency></dependencies></project>',
      );
      const pkgs = await loadWorkspaces(mvn);
      expect(pkgs.map((p) => p.name).sort()).toEqual(['acme-core', 'acme-web']);
      const web = pkgs.find((p) => p.name === 'acme-web');
      expect(web.dir).toBe('web');
      expect(web.dependencies.has('acme-core')).toBe(true);
    } finally {
      await rm(mvn, { recursive: true, force: true, maxRetries: 5 });
    }
  });

  it('repo sans workspaces → [] (no-op complet)', async () => {
    const solo = await mkdtemp(path.join(os.tmpdir(), 'striart-solo-'));
    try {
      await writeJson(path.join(solo, 'package.json'), { name: 'app' });
      expect(await loadWorkspaces(solo)).toEqual([]);
    } finally {
      await rm(solo, { recursive: true, force: true, maxRetries: 5 });
    }
  });

  it('fileToPackage : préfixe le plus long, null hors workspace', () => {
    expect(fileToPackage(workspaces, 'packages/ui/src/Button.tsx').name).toBe('@acme/ui');
    expect(fileToPackage(workspaces, 'apps/web/pages/index.tsx').name).toBe('@acme/web');
    expect(fileToPackage(workspaces, 'README.md')).toBeNull();
  });

  it("avertit quand mon package dépend de celui de l'autre agent", () => {
    const warnings = detectWorkspaceLinks({
      workspaces,
      predictedFiles: ['packages/ui/src/Button.tsx'],
      agents: [{ name: 'agent-auth', predictedFiles: ['packages/auth/src/hash.ts'] }],
    });
    expect(warnings).toEqual([
      {
        agent: 'agent-auth',
        links: [{ mine: '@acme/ui', theirs: '@acme/auth', direction: 'depends-on' }],
      },
    ]);
  });

  it("avertit dans l'autre sens (mon package est une dépendance du sien)", () => {
    const warnings = detectWorkspaceLinks({
      workspaces,
      predictedFiles: ['packages/ui/src/Button.tsx'],
      agents: [{ name: 'agent-web', predictedFiles: ['apps/web/pages/index.tsx'] }],
    });
    expect(warnings).toEqual([
      {
        agent: 'agent-web',
        links: [{ mine: '@acme/ui', theirs: '@acme/web', direction: 'dependency-of' }],
      },
    ]);
  });

  it('packages indépendants ou même package → silence total', () => {
    // docs et auth ne sont pas liés.
    expect(
      detectWorkspaceLinks({
        workspaces,
        predictedFiles: ['packages/docs/index.md'],
        agents: [{ name: 'agent-auth', predictedFiles: ['packages/auth/src/hash.ts'] }],
      }),
    ).toEqual([]);
    // Même package : les verrous fichier couvrent déjà.
    expect(
      detectWorkspaceLinks({
        workspaces,
        predictedFiles: ['packages/auth/src/a.ts'],
        agents: [{ name: 'agent-auth', predictedFiles: ['packages/auth/src/b.ts'] }],
      }),
    ).toEqual([]);
  });
});

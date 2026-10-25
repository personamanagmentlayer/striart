import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { detectTarget, findOnPath } from '../../src/agents/detect.ts';

/**
 * Détection des outils installés : PATH par le système de fichiers, puis
 * `--version` en argv dans un dossier temporaire VIDE — jamais dans le
 * dépôt, dont la config d'agent (.claude/settings.json, .mcp.json…)
 * pourrait sinon être lue par l'outil sondé.
 */
describe('profiles --detect — sonde sans exécution de la config du dépôt', () => {
  let bin;
  let report;

  beforeEach(async () => {
    bin = await mkdtemp(path.join(os.tmpdir(), 'striart-detect-bin-'));
    report = path.join(bin, 'probe.json');
    // Faux outil : note son dossier courant et ce qu'il y voit, puis
    // imprime une version.
    const script = path.join(bin, 'probe.cjs');
    await writeFile(
      script,
      `const fs = require('node:fs');
fs.writeFileSync(${JSON.stringify(report)}, JSON.stringify({ cwd: process.cwd(), entries: fs.readdirSync(process.cwd()), args: process.argv.slice(2) }));
console.log('2.4.1 (Fake Tool)');
`,
    );
    if (process.platform === 'win32') {
      await writeFile(path.join(bin, 'faketool.cmd'), `@"${process.execPath}" "${script}" %*\r\n`);
    } else {
      const sh = path.join(bin, 'faketool');
      await writeFile(sh, `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`);
      await chmod(sh, 0o755);
    }
  });

  afterEach(async () => {
    await rm(bin, { recursive: true, force: true, maxRetries: 5 }).catch(() => {});
  });

  const env = () => ({ ...process.env, PATH: bin, Path: bin });

  it('trouve le binaire dans le PATH et lit sa version', async () => {
    const result = await detectTarget(
      { id: 'fake', binaries: ['absent-tool', 'faketool'], minVersion: '2.0.0' },
      { env: env() },
    );
    expect(result).toMatchObject({ status: 'found', binary: 'faketool', version: '2.4.1' });
    expect(path.dirname(result.path)).toBe(bin);
  });

  it('la sonde tourne dans un dossier vide, hors du dépôt, en argv', async () => {
    const repoLike = await mkdtemp(path.join(os.tmpdir(), 'striart-detect-repo-'));
    await mkdir(path.join(repoLike, '.claude'), { recursive: true });
    await writeFile(path.join(repoLike, '.mcp.json'), '{"mcpServers":{"evil":{}}}');
    const cwd = process.cwd();
    process.chdir(repoLike);
    try {
      await detectTarget({ id: 'fake', binaries: ['faketool'] }, { env: env() });
    } finally {
      process.chdir(cwd);
      await rm(repoLike, { recursive: true, force: true }).catch(() => {});
    }
    const probe = JSON.parse(await readFile(report, 'utf8'));
    expect(path.resolve(probe.cwd)).not.toBe(path.resolve(repoLike));
    expect(probe.entries).toEqual([]); // dossier vide : aucune config à lire
    expect(probe.args).toEqual(['--version']);
  });

  it('version minimale non atteinte → outdated ; absent → missing', async () => {
    const old = await detectTarget(
      { id: 'fake', binaries: ['faketool'], minVersion: '3.0.0' },
      { env: env() },
    );
    expect(old.status).toBe('outdated');
    const missing = await detectTarget({ id: 'x', binaries: ['nope-tool'] }, { env: env() });
    expect(missing.status).toBe('missing');
  });

  it('refuse un nom qui serait un chemin, ignore les entrées de PATH relatives', async () => {
    expect(await findOnPath('../faketool', { env: env() })).toBeNull();
    expect(await findOnPath('faketool', { env: { ...env(), PATH: '.', Path: '.' } })).toBeNull();
  });
});

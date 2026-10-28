import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { findOnPath, resolveStriartLaunch } from '../../src/core/binary.ts';
import { BinaryError } from '../../src/core/errors.ts';

const isWin = process.platform === 'win32';
let tmp: string;
let binDir: string;
let workspace: string;
let nodeExe: string;

async function makeExe(dir: string, name: string, content = '#!/bin/sh\nexit 0\n'): Promise<string> {
  const file = path.join(dir, name);
  await writeFile(file, content);
  await chmod(file, 0o755);
  return file;
}

before(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), 'striart-bin-'));
  binDir = path.join(tmp, 'bin');
  workspace = path.join(tmp, 'workspace');
  await mkdir(binDir);
  await mkdir(workspace);
  nodeExe = await makeExe(binDir, isWin ? 'node.exe' : 'node');
});
after(async () => {
  await rm(tmp, { recursive: true, force: true });
});

const envFor = (...dirs: string[]): NodeJS.ProcessEnv => ({ PATH: dirs.join(path.delimiter), PATHEXT: '.EXE;.CMD' });

describe('résolution du binaire', () => {
  it('trouve une commande dans le PATH', async () => {
    const exe = await makeExe(binDir, isWin ? 'striart.exe' : 'striart');
    const found = await findOnPath('striart', { env: envFor(binDir) });
    assert.equal(found?.toLowerCase(), exe.toLowerCase());
  });

  it('ignore le dossier du workspace et les entrées relatives (binary planting)', async () => {
    await makeExe(workspace, isWin ? 'plant.exe' : 'plant');
    assert.equal(await findOnPath('plant', { env: envFor(workspace), untrustedDirs: [workspace] }), null);
    assert.equal(await findOnPath('plant', { env: envFor('.', ''), untrustedDirs: [] }), null);
    // Sous-dossier du workspace : également exclu.
    const sub = path.join(workspace, 'node_modules', '.bin');
    await mkdir(sub, { recursive: true });
    await makeExe(sub, isWin ? 'plant2.exe' : 'plant2');
    assert.equal(await findOnPath('plant2', { env: envFor(sub), untrustedDirs: [workspace] }), null);
  });

  it('refuse un chemin relatif et une valeur vide ou piégée', async () => {
    for (const bad of ['./striart', '..\\striart', 'sub/striart', '', '  ', 'str\u0000iart']) {
      await assert.rejects(
        resolveStriartLaunch(bad, 'node', { env: envFor(binDir) }),
        (e: unknown) => e instanceof BinaryError,
        JSON.stringify(bad),
      );
    }
  });

  it('signale un binaire introuvable', async () => {
    await assert.rejects(resolveStriartLaunch('introuvable-xyz', 'node', { env: envFor(binDir) }), /not found in PATH/);
  });

  it('un script d’entrée est lancé par node (chemin absolu)', async () => {
    const script = path.join(tmp, 'cli.js');
    await writeFile(script, '// x');
    const spec = await resolveStriartLaunch(script, 'node', { env: envFor(binDir) });
    assert.equal(spec.file.toLowerCase(), nodeExe.toLowerCase());
    assert.deepEqual(spec.prefixArgs, [script]);
  });

  it('un exécutable est lancé directement, sans argument préfixe', { skip: isWin }, async () => {
    const exe = await makeExe(binDir, 'direct');
    const spec = await resolveStriartLaunch(exe, 'node', { env: envFor(binDir) });
    assert.equal(spec.file, exe);
    assert.deepEqual(spec.prefixArgs, []);
  });

  it('shim npm Windows : remonté au script du paquet, sinon échec explicite', async () => {
    const prefix = path.join(tmp, 'npm-prefix');
    const entry = path.join(prefix, 'node_modules', '@jumsay', 'striart', 'src');
    await mkdir(entry, { recursive: true });
    await writeFile(path.join(entry, 'cli.js'), '// x');
    await writeFile(path.join(prefix, 'striart.cmd'), '@echo off');
    const spec = await resolveStriartLaunch(path.join(prefix, 'striart.cmd'), 'node', {
      env: envFor(binDir),
      platform: 'win32',
    });
    assert.equal(spec.prefixArgs[0], path.join(entry, 'cli.js'));

    const lone = path.join(tmp, 'lone');
    await mkdir(lone);
    await writeFile(path.join(lone, 'striart.cmd'), '@echo off');
    await assert.rejects(
      resolveStriartLaunch(path.join(lone, 'striart.cmd'), 'node', { env: envFor(binDir), platform: 'win32' }),
      (e: unknown) => e instanceof BinaryError && e.code === 'BINARY_UNSUPPORTED_SHIM',
    );
  });
});

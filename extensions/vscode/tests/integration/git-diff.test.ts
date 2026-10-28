import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { promisify } from 'node:util';
import { findOnPath } from '../../src/core/binary.ts';
import { agentClone, gitDiff } from '../../src/core/git.ts';

const run = promisify(execFile);
const dirs: string[] = [];
after(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

async function git(cwd: string, ...args: string[]) {
  return run('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=Test', ...args], { cwd });
}

describe('diff d’un clone d’agent', () => {
  it('rend le patch des commits en attente et ignore une configuration hostile du clone', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'striart-diff-'));
    dirs.push(root);
    const clone = path.join(root, '.striart', 'agents', 'agent-a');
    await mkdir(clone, { recursive: true });
    await git(clone, 'init', '-q', '-b', 'main');
    await writeFile(path.join(clone, 'a.txt'), 'one\n');
    await git(clone, 'add', '.');
    await git(clone, 'commit', '-qm', 'base');
    await writeFile(path.join(clone, 'a.txt'), 'one\ntwo\n');
    await git(clone, 'commit', '-qam', 'second');

    // Configuration hostile écrite par « l'agent » : un moniteur de fichiers qui écrit un marqueur.
    const marker = path.join(root, 'FSMONITOR-RAN');
    const hook = path.join(root, 'hook.cjs');
    await writeFile(hook, `require('fs').writeFileSync(${JSON.stringify(marker)}, 'x'); process.stdout.write('\\0');`);
    await git(clone, 'config', 'core.fsmonitor', `node ${hook.replaceAll('\\', '/')}`);
    await git(clone, 'config', 'diff.external', `node ${hook.replaceAll('\\', '/')}`);

    const gitPath = await findOnPath('git');
    assert.ok(gitPath, 'git must be in PATH for this test');
    // Témoin : un `git diff` ordinaire exécute bien la commande de l'agent (le test peut donc échouer).
    await run(gitPath, ['diff', 'HEAD~1', 'HEAD'], { cwd: clone }).catch(() => undefined);
    assert.equal(existsSync(marker), true, 'control: plain git diff runs diff.external');
    await rm(marker);
    const patch = await gitDiff(gitPath, clone, 1, process.env);
    assert.match(patch, /\+two/);
    assert.equal(existsSync(marker), false, 'the agent-controlled command must never run');
  });

  it('agentClone : dossier reconstruit, noms invalides et liens symboliques refusés', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'striart-clone-'));
    dirs.push(root);
    await mkdir(path.join(root, '.striart', 'agents', 'ok'), { recursive: true });
    assert.equal(await agentClone(root, 'ok'), path.join(root, '.striart', 'agents', 'ok'));
    assert.equal(await agentClone(root, '../ok'), null);
    assert.equal(await agentClone(root, 'absent'), null);
    const outside = await mkdtemp(path.join(os.tmpdir(), 'striart-outside-'));
    dirs.push(outside);
    try {
      await symlink(outside, path.join(root, '.striart', 'agents', 'lnk'), 'junction');
    } catch {
      return; // Création de lien impossible (droits) : le reste du test a été exécuté.
    }
    assert.equal(await agentClone(root, 'lnk'), null);
  });
});

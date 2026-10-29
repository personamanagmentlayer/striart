/**
 * Détection du merge ouvert quand `.git` est un FICHIER (worktree lié,
 * submodule, `--separate-git-dir`) — revue du noyau K-M12. `readOpenMergeHead`
 * lisait `<racine>/.git/MERGE_HEAD` : avec un `.git` fichier, la lecture
 * échouait en ENOTDIR, prise pour « un merge est ouvert, SHA inconnu » — le
 * marqueur MERGE_STATE_CHANGED bloquait alors à vie (MERGE_RECOVERY_BLOCKED)
 * et un marqueur périmé ne se levait jamais.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execa } from 'execa';
import { initStriart } from '../../src/init.ts';
import { recordMergeStateChanged, withMainLock } from '../../src/lock.ts';

const git = (cwd, ...args) => execa('git', ['-C', cwd, ...args]).then((r) => r.stdout.trim());

describe('verrou principal — dépôt dont .git est un fichier (intégration)', () => {
  let base;
  let root;
  let gitDir;

  beforeEach(async () => {
    base = await mkdtemp(path.join(os.tmpdir(), 'striart-gitdir-'));
    root = path.join(base, 'work');
    gitDir = path.join(base, 'gitdir');
    await execa('git', ['init', '-q', '-b', 'main', '--separate-git-dir', gitDir, root]);
    await git(root, 'config', 'user.name', 'T');
    await git(root, 'config', 'user.email', 't@example.com');
    await writeFile(path.join(root, 'README.md'), '# test\n');
    await git(root, 'add', 'README.md');
    await git(root, 'commit', '-q', '-m', 'chore: initial');
    await initStriart(root);
  });

  afterEach(async () => {
    await rm(base, { recursive: true, force: true, maxRetries: 5 }).catch(() => {});
  });

  async function openForeignMerge() {
    await git(root, 'checkout', '-q', '-b', 'feat');
    await writeFile(path.join(root, 'feat.js'), 'export const f = 1;\n');
    await git(root, 'add', 'feat.js');
    await git(root, 'commit', '-q', '-m', 'feat: f');
    await git(root, 'checkout', '-q', 'main');
    await writeFile(path.join(root, 'main.js'), 'export const m = 1;\n');
    await git(root, 'add', 'main.js');
    await git(root, 'commit', '-q', '-m', 'feat: m');
    await git(root, 'merge', '--no-commit', '--no-ff', 'feat');
    return git(root, 'rev-parse', 'MERGE_HEAD');
  }

  it('témoin : .git est bien un fichier', async () => {
    expect((await stat(path.join(root, '.git'))).isFile()).toBe(true);
  });

  it('marqueur périmé et AUCUN merge ouvert : le verrou s’acquiert et le marqueur est levé', async () => {
    await recordMergeStateChanged(root, {
      operation: 'merge:a',
      agent: 'a',
      mergeHead: 'a'.repeat(40),
    });

    const out = await withMainLock(root, 'test', async () => 'ok');

    expect(out).toBe('ok');
    await expect(
      stat(path.join(root, '.striart', 'merge-state-changed.json')),
    ).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('marqueur désignant AUTRE chose que le merge ouvert : périmé, le débris est annulé', async () => {
    await openForeignMerge();
    await recordMergeStateChanged(root, {
      operation: 'merge:a',
      agent: 'a',
      mergeHead: 'b'.repeat(40),
    });

    const out = await withMainLock(root, 'test', async () => 'ok');

    expect(out).toBe('ok');
    await expect(stat(path.join(root, '.git'))).resolves.toBeTruthy();
    // Le merge orphelin a été annulé (MERGE_HEAD absent du vrai gitdir).
    await expect(stat(path.join(gitDir, 'MERGE_HEAD'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('marqueur désignant LE merge ouvert : MERGE_RECOVERY_BLOCKED, merge du tiers intact', async () => {
    const mergeHead = await openForeignMerge();
    await recordMergeStateChanged(root, { operation: 'merge:a', agent: 'a', mergeHead });

    await expect(withMainLock(root, 'test', async () => 'ok')).rejects.toMatchObject({
      code: 'MERGE_RECOVERY_BLOCKED',
    });

    expect((await readFile(path.join(gitDir, 'MERGE_HEAD'), 'utf8')).trim()).toBe(mergeHead);
  });

  it('merge orphelin sans marqueur : annulé par la récupération', async () => {
    await openForeignMerge();

    await withMainLock(root, 'test', async () => 'ok');

    await expect(stat(path.join(gitDir, 'MERGE_HEAD'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

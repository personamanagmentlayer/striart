import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { execa } from 'execa';
import path from 'node:path';
import { simpleGit } from 'simple-git';
import { createTempRepo } from '../helpers/temp-repo.js';
import { initStriart } from '../../src/init.js';
import { withMainLock } from '../../src/lock.js';

describe('withMainLock — verrou inter-processus (intégration)', () => {
  let repo;
  let lockFile;

  beforeEach(async () => {
    repo = await createTempRepo();
    await initStriart(repo.root);
    lockFile = path.join(repo.root, '.striart', 'main.lock');
  });

  afterEach(async () => {
    await repo.cleanup();
  });

  it('exécute fn, écrit puis nettoie le lockfile', async () => {
    const result = await withMainLock(repo.root, 'test', async () => {
      const info = JSON.parse(await readFile(lockFile, 'utf8'));
      expect(info).toMatchObject({ pid: process.pid, label: 'test' });
      return 42;
    });
    expect(result).toBe(42);
    await expect(stat(lockFile)).rejects.toThrow(); // libéré
  });

  it('le lockfile est nettoyé même si fn throw', async () => {
    await expect(
      withMainLock(repo.root, 'test', async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    await expect(stat(lockFile)).rejects.toThrow();
  });

  it('réentrant : les opérations imbriquées ne se bloquent pas elles-mêmes', async () => {
    const result = await withMainLock(repo.root, 'externe', () =>
      withMainLock(repo.root, 'interne', async () => 'ok'),
    );
    expect(result).toBe('ok');
    await expect(stat(lockFile)).rejects.toThrow();
  });

  it('verrou détenu par un processus vivant → LOCK_TIMEOUT avec le label du détenteur', async () => {
    // Simule un autre processus vivant : notre propre pid, timestamp frais.
    await writeFile(
      lockFile,
      JSON.stringify({
        pid: process.pid,
        startedAt: new Date().toISOString(),
        label: 'merge:agent-x',
      }),
    );
    await expect(
      withMainLock(repo.root, 'test', async () => 'jamais', { timeoutMs: 1200 }),
    ).rejects.toMatchObject({ code: 'LOCK_TIMEOUT' });
    // Le lock du "détenteur" n'a pas été cassé.
    await expect(stat(lockFile)).resolves.toBeTruthy();
  });

  it('verrou orphelin (détenteur mort) → cassé automatiquement', async () => {
    // Un vrai pid garanti mort : un process enfant déjà terminé.
    const dead = await execa('node', ['-e', 'process.exit(0)']);
    await writeFile(
      lockFile,
      JSON.stringify({ pid: dead.pid, startedAt: new Date().toISOString(), label: 'crash' }),
    );
    const result = await withMainLock(repo.root, 'test', async () => 'récupéré');
    expect(result).toBe('récupéré');
    await expect(stat(lockFile)).rejects.toThrow();
  });

  it('verrou plus vieux que le TTL → cassé même si le pid semble vivant', async () => {
    await writeFile(
      lockFile,
      JSON.stringify({
        pid: process.pid, // vivant
        startedAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
        label: 'zombie',
      }),
    );
    // L'âge du fichier (mtime) doit aussi dépasser le TTL : on le vieillit.
    const { utimes } = await import('node:fs/promises');
    const old = new Date(Date.now() - 60 * 60 * 1000);
    await utimes(lockFile, old, old);

    const result = await withMainLock(repo.root, 'test', async () => 'récupéré');
    expect(result).toBe('récupéré');
  });

  it("récupération d'un merge orphelin à l'acquisition (crash pendant un merge --no-commit)", async () => {
    // Fabrique un état de merge abandonné : merge en conflit non résolu.
    await writeFile(path.join(repo.root, 'shared.js'), 'main\n');
    await repo.git.add(['shared.js']);
    await repo.git.commit('feat: main');
    await repo.git.checkoutBranch('autre', 'HEAD~1');
    await writeFile(path.join(repo.root, 'shared.js'), 'autre\n');
    await repo.git.add(['shared.js']);
    await repo.git.commit('feat: autre');
    await repo.git.checkout('main');
    await repo.git.raw(['merge', 'autre', '--no-commit', '--no-ff']).catch(() => {});
    await expect(stat(path.join(repo.root, '.git', 'MERGE_HEAD'))).resolves.toBeTruthy();

    await withMainLock(repo.root, 'test', async () => {
      // À l'entrée, le merge orphelin a été annulé.
      await expect(stat(path.join(repo.root, '.git', 'MERGE_HEAD'))).rejects.toThrow();
      expect((await simpleGit(repo.root).status()).conflicted).toEqual([]);
    });
  });
});

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { associatedWith, loadCoChange, resetCoChangeCache } from '../../src/router-cochange.ts';
import { createTempRepo } from '../helpers/temp-repo.js';

describe('co-modification lue dans un vrai historique git', () => {
  let repo;

  beforeEach(async () => {
    resetCoChangeCache();
    repo = await createTempRepo();
    await mkdir(path.join(repo.root, 'src'), { recursive: true });
    for (let i = 0; i < 4; i += 1) {
      await writeFile(path.join(repo.root, 'src', 'lock.js'), `export const v = ${i};\n`);
      await writeFile(path.join(repo.root, 'src', 'types.d.ts'), `export type V = ${i};\n`);
      await repo.git.add(['src/lock.js', 'src/types.d.ts']);
      await repo.git.commit(`feat: lock v${i}`);
    }
    await writeFile(path.join(repo.root, 'src', 'other.js'), 'export {};\n');
    await repo.git.add(['src/other.js']);
    await repo.git.commit('feat: other');
  });

  afterEach(async () => {
    await repo.cleanup();
  });

  it('retrouve les compagnons fiables d’un fichier, par nom de branche comme par SHA', async () => {
    const byBranch = await loadCoChange(repo.root, 'main');
    expect(associatedWith(byBranch, 'src/lock.js').map((a) => a.path)).toEqual(['src/types.d.ts']);
    expect(associatedWith(byBranch, 'src/other.js')).toEqual([]);
    const sha = (await repo.git.revparse(['HEAD'])).trim();
    resetCoChangeCache();
    const bySha = await loadCoChange(repo.root, sha);
    expect(associatedWith(bySha, 'src/types.d.ts').map((a) => a.path)).toEqual(['src/lock.js']);
  });

  it('une référence inconnue échoue franchement (l’appelant traite l’absence de signal)', async () => {
    await expect(loadCoChange(repo.root, 'branche-inconnue')).rejects.toThrow();
  });
});

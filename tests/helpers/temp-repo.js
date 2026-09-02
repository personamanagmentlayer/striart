import { chmod, mkdtemp, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { simpleGit } from 'simple-git';

/**
 * Crée un repo Git temporaire avec un commit initial.
 * Retourne { root, git, cleanup }.
 */
/**
 * Antidate récursivement les mtimes d'un dossier — simule un clone inactif
 * pour les tests de présence de session (clean/prune).
 */
export async function backdateDir(dir, ageMs = 60 * 60_000) {
  const when = new Date(Date.now() - ageMs);
  const backdate = async (p) => {
    try {
      await utimes(p, when, when);
    } catch {
      // Objets git en lecture seule (Windows) : rendre modifiable puis retenter.
      await chmod(p, 0o666).catch(() => {});
      await utimes(p, when, when).catch(() => {});
    }
  };
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) await backdateDir(p, ageMs);
    else await backdate(p);
  }
  await backdate(dir);
}

export async function createTempRepo() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'striart-test-'));
  const git = simpleGit(root);
  await git.init(['-b', 'main']);
  await git.addConfig('user.name', 'Striart Test');
  await git.addConfig('user.email', 'striart-test@example.com');
  await writeFile(path.join(root, 'README.md'), '# test\n');
  await git.add(['README.md']);
  await git.commit('chore: initial commit');

  const cleanup = async () => {
    try {
      await rm(root, { recursive: true, force: true, maxRetries: 5 });
    } catch {
      // Windows sous charge : un handle traînant (antivirus, git) peut tenir
      // le dossier temp quelques secondes. Un reliquat dans %TEMP% ne doit
      // jamais faire échouer un test qui a réussi.
    }
  };

  return { root, git, cleanup };
}

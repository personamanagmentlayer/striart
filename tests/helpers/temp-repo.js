import { chmod, mkdtemp, readdir, realpath, rm, utimes, writeFile } from 'node:fs/promises';
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
  // realpath NATIF : sous Windows, os.tmpdir() renvoie le nom court 8.3 (RUNNER~1)
  // que le produit résout en nom long — les chemins attendus doivent être canoniques.
  const root = await mkdtemp(path.join(await realpath(os.tmpdir()), 'striart-test-'));
  const git = simpleGit(root);
  await git.init(['-b', 'main']);
  await git.addConfig('user.name', 'Striart Test');
  await git.addConfig('user.email', 'striart-test@example.com');
  // Pas de maintenance en arrière-plan : un `gc --auto` / repack concurrent d'un
  // clone local (objets hardlinkés) peut retirer un objet pendant la copie
  // (« failed to copy file … No such file or directory », vu en CI Linux).
  await git.addConfig('gc.auto', '0');
  await git.addConfig('maintenance.auto', 'false');
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

/**
 * Racine temporaire dont le chemin tient dans `sockaddr_un.sun_path` (104
 * octets sous macOS, NUL compris) une fois `.striart/pty/<agent>/attach.sock`
 * ajouté. Le TMPDIR d'un runner macOS (`/private/var/folders/xx/…/T`) en
 * consomme à lui seul plus de 60 : le garde `PTY_ENDPOINT_TOO_LONG` du produit
 * est voulu, ce sont les tests d'hôte de pty qui doivent partir d'un préfixe
 * court. Sous Windows (named pipes) le TMPDIR habituel convient.
 */
export async function createSocketSafeTempDir(prefix) {
  const base = process.platform === 'win32' ? os.tmpdir() : '/tmp';
  return mkdtemp(path.join(await realpath(base), prefix));
}

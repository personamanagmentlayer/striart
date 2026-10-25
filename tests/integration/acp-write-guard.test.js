/**
 * `fs/write_text_file` du client ACP (revue du noyau K-M3) : un agent ne doit
 * pas pouvoir, par ce canal servi par Striart, écrire dans le `.git/` de son
 * clone (config, hooks) — c'est la porte qui fait exécuter un programme choisi
 * par l'agent à la prochaine commande git de Striart. Les LECTURES de `.git/`
 * restent permises (outils d'analyse).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { resolvePathInsideClone, resolveWritablePathInsideClone } from '../../src/acp/protocol.ts';

describe('ACP — écriture dans le clone, .git exclu (intégration)', () => {
  let clone;

  beforeEach(async () => {
    clone = await mkdtemp(path.join(os.tmpdir(), 'striart-acp-write-'));
    await mkdir(path.join(clone, '.git', 'hooks'), { recursive: true });
    await mkdir(path.join(clone, 'src'), { recursive: true });
    await mkdir(path.join(clone, 'vendor', 'lib', '.git'), { recursive: true });
  });

  afterEach(async () => {
    await rm(clone, { recursive: true, force: true, maxRetries: 5 }).catch(() => {});
  });

  it.each([
    '.git',
    '.git/config',
    '.git/hooks/pre-commit',
    './.git/config',
    'src/../.git/config',
    '.GIT/config',
    'vendor/lib/.git/config',
  ])('écriture refusée : %s', async (candidate) => {
    expect(await resolveWritablePathInsideClone(clone, candidate)).toBeNull();
  });

  it('écriture permise : fichiers ordinaires, y compris ceux dont le nom ressemble', async () => {
    for (const candidate of [
      'src/a.js',
      'nouveau/dossier/b.js',
      '.gitignore',
      '.github/ci.yml',
      'git/x',
    ]) {
      const resolved = await resolveWritablePathInsideClone(clone, candidate);
      expect(resolved, candidate).toBe(path.resolve(clone, candidate));
    }
  });

  it('chemin hors du clone toujours refusé (comportement de resolvePathInsideClone conservé)', async () => {
    expect(await resolveWritablePathInsideClone(clone, '../dehors.txt')).toBeNull();
  });

  it('lecture de .git/ toujours permise', async () => {
    expect(await resolvePathInsideClone(clone, '.git/config')).toBe(
      path.resolve(clone, '.git/config'),
    );
  });

  it('un lien symbolique vers .git ne contourne pas la garde', async () => {
    try {
      await symlink(path.join(clone, '.git'), path.join(clone, 'raccourci'), 'junction');
    } catch {
      return; // droits insuffisants pour créer le lien : cas non testable ici
    }
    expect(await resolveWritablePathInsideClone(clone, 'raccourci/config')).toBeNull();
  });
});

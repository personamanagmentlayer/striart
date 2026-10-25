import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createTempRepo } from '../helpers/temp-repo.js';

/**
 * Réconciliation × fichiers d'état (lot L2) — fichier à part : le module
 * process-tree y est remplacé pour rejouer, de façon déterministe, la course
 * « une session publie son PID entre la lecture du registre et l'effacement ».
 */
const race = vi.hoisted(() => ({ registryFile: '', republishPid: 0, armed: false }));

vi.mock('../../src/process-tree.js', async (original) => {
  const actual = /** @type {typeof import('../../src/process-tree.js')} */ (await original());
  return {
    ...actual,
    isProcessAlive: (pid) => {
      if (race.armed && pid === 0x7fffffff) {
        race.armed = false;
        // Une nouvelle session publie son PID PENDANT la décision de la
        // réconciliation (écriture synchrone : elle tombe exactement entre
        // la lecture du registre et l'effacement).
        const registry = JSON.parse(readFileSync(race.registryFile, 'utf8'));
        registry.a.sessionPid = race.republishPid;
        writeFileSync(race.registryFile, JSON.stringify(registry));
        return false;
      }
      return actual.isProcessAlive(pid);
    },
  };
});

const DEAD_PID = 0x7fffffff;
const { initStriart } = await import('../../src/init.js');
const { readRegistry } = await import('../../src/clone.js');
const { reconcile } = await import('../../src/orchestrator.js');
const { createAgent } = await import('../../src/clone.js');

describe('reconcile — fichiers d’état', () => {
  let repo;

  beforeEach(async () => {
    repo = await createTempRepo();
    await initStriart(repo.root);
  });

  afterEach(async () => {
    race.armed = false;
    await repo.cleanup();
  });

  it('n’efface jamais un sessionPid republié entre sa lecture et l’écriture', async () => {
    await createAgent({ root: repo.root, name: 'a' });
    race.registryFile = path.join(repo.root, '.striart', 'agents.json');
    const registry = JSON.parse(await readFile(race.registryFile, 'utf8'));
    registry.a.sessionPid = DEAD_PID;
    await writeFile(race.registryFile, JSON.stringify(registry));
    race.republishPid = process.pid;
    race.armed = true;

    const result = await reconcile({ root: repo.root });

    expect(result.sessionPidsCleared).toEqual([]);
    expect((await readRegistry(repo.root)).a.sessionPid).toBe(process.pid);
  });

  it('reprend une suppression de clone interrompue (marqueur + removing au registre)', async () => {
    const meta = await createAgent({ root: repo.root, name: 'gone' });
    // Simule un `rm` interrompu : marqueur posé, registre marqué, clone à moitié supprimé.
    await mkdir(path.join(repo.root, '.striart', 'removing'), { recursive: true });
    await writeFile(
      path.join(repo.root, '.striart', 'removing', 'gone.json'),
      JSON.stringify({ name: 'gone', wasActive: true, since: new Date().toISOString() }),
    );
    const file = path.join(repo.root, '.striart', 'agents.json');
    const registry = JSON.parse(await readFile(file, 'utf8'));
    registry.gone.removing = true;
    await writeFile(file, JSON.stringify(registry));
    await rm(path.join(meta.path, 'README.md'), { force: true });

    // Tant que la suppression n'est pas finie, le nom n'est pas réutilisable.
    await expect(createAgent({ root: repo.root, name: 'gone' })).rejects.toMatchObject({
      code: 'CLONE_REMOVAL_PENDING',
    });

    const result = await reconcile({ root: repo.root });

    expect(result.removalsCompleted).toEqual(['gone']);
    expect(result.removalsPending).toEqual([]);
    expect((await readRegistry(repo.root)).gone).toBeUndefined();
    await expect(stat(meta.path)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(
      stat(path.join(repo.root, '.striart', 'removing', 'gone.json')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
    // Le nom est de nouveau libre.
    await expect(createAgent({ root: repo.root, name: 'gone' })).resolves.toMatchObject({
      name: 'gone',
    });
  });

  it('balaye les temporaires orphelins de .striart/', async () => {
    const tmp = path.join(repo.root, '.striart', `agents.json.${DEAD_PID}.0123456789ab.tmp`);
    await writeFile(tmp, '{');
    const { utimes } = await import('node:fs/promises');
    const old = new Date(Date.now() - 2 * 60_000);
    await utimes(tmp, old, old);
    const result = await reconcile({ root: repo.root });
    expect(result.tempFilesSwept).toBe(1);
    await expect(stat(tmp)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

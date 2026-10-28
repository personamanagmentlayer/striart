// withMainLock protège `.striart/` AVANT la prise du verrou, une fois par
// process et par racine, jamais sous le verrou (icacls : 1 à 3 s sous Windows).
import { access, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTempRepo } from '../helpers/temp-repo.js';
import { StriartError } from '../../src/errors.js';

vi.mock('../../src/state-protection.ts', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, ensureStateProtection: vi.fn(actual.ensureStateProtection) };
});

const { withMainLock } = await import('../../src/lock.js');
const protection = await import('../../src/state-protection.ts');
const { resetHardenMemo } = await import('../../src/private-fs.ts');
const ensure = protection.ensureStateProtection;

const exists = (file) =>
  access(file).then(
    () => true,
    () => false,
  );

describe('withMainLock — protection de .striart/ avant le verrou', () => {
  let repo;
  beforeEach(async () => {
    repo = await createTempRepo();
    await mkdir(path.join(repo.root, '.striart'), { recursive: true });
    protection.resetStateProtectionMemo();
    resetHardenMemo();
    ensure.mockClear();
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await repo.cleanup();
  });

  it('appelée AVANT la prise du verrou (main.lock absent à ce moment), jamais sous lui', async () => {
    const lockFile = path.join(repo.root, '.striart', 'main.lock');
    const seen = [];
    ensure.mockImplementationOnce(async () => {
      seen.push(await exists(lockFile));
      return null;
    });
    await withMainLock(repo.root, 'test', async () => {
      expect(await exists(lockFile)).toBe(true);
    });
    expect(seen).toEqual([false]);
  });

  it('une seule fois par racine sur des appels répétés, concurrents et réentrants', async () => {
    await Promise.all([
      withMainLock(repo.root, 'a', async () => {
        await withMainLock(repo.root, 'a-inner', async () => {});
      }),
      withMainLock(repo.root, 'b', async () => {}),
    ]);
    await withMainLock(repo.root, 'c', async () => {});
    // a, b, c : l'appel réentrant ne repasse pas par la protection ; la
    // mémoïsation (une résolution par racine) est celle d'ensureStateProtection.
    expect(ensure).toHaveBeenCalledTimes(3);
    const roots = new Set(ensure.mock.calls.map((call) => path.resolve(call[0])));
    expect(roots.size).toBe(1);
  });

  it('la protection est mémoïsée par racine : le même résultat partagé, un seul resserrement', async () => {
    const actual = await vi.importActual('../../src/state-protection.ts');
    const first = actual.ensureStateProtection(repo.root);
    const second = actual.ensureStateProtection(repo.root);
    expect(second).toBe(first);
    await first;
  });

  it('échec STATE_UNPROTECTED : fail closed, la section critique ne tourne pas, aucun verrou laissé', async () => {
    ensure.mockRejectedValueOnce(
      new StriartError('x', {
        code: 'STATE_UNPROTECTED',
        details: { path: 'p', reason: 'icacls' },
      }),
    );
    const fn = vi.fn();
    await expect(withMainLock(repo.root, 'test', fn)).rejects.toMatchObject({
      code: 'STATE_UNPROTECTED',
    });
    expect(fn).not.toHaveBeenCalled();
    expect(await exists(path.join(repo.root, '.striart', 'main.lock'))).toBe(false);
  });

  it('dépôt non initialisé (.striart/ absent) : aucune création, comportement inchangé', async () => {
    const bare = await createTempRepo();
    try {
      ensure.mockClear();
      await withMainLock(bare.root, 'test', async () => {});
      expect(ensure).not.toHaveBeenCalled();
      expect(await exists(path.join(bare.root, '.striart'))).toBe(false);
    } finally {
      await bare.cleanup();
    }
  });

  it('privateStateDir: false : relâchement explicite, le verrou se prend quand même', async () => {
    await writeFile(
      path.join(repo.root, 'striart.config.mjs'),
      'export default { privateStateDir: false };\n',
    );
    ensure.mockImplementationOnce((root, config) =>
      // vrai module, config relue par lui (chemin sans config passée)
      vi
        .importActual('../../src/state-protection.ts')
        .then((m) => m.ensureStateProtection(root, config)),
    );
    const fn = vi.fn(async () => 'ok');
    await expect(withMainLock(repo.root, 'test', fn)).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledOnce();
  });
});

/**
 * Écrivain de journal à rotation — réouverture en échec après la rotation
 * (revue du noyau K-M13). `rotate()` fermait le descripteur, décalait les
 * générations puis rouvrait : si `openSync` échouait (EMFILE, antivirus), le
 * descripteur FERMÉ restait en service — écritures en EBADF, voire dans le
 * fichier d'un autre si le numéro avait été recyclé. Désormais : jamais de
 * descripteur périmé, la ligne part sur stderr (rien n'est perdu en silence),
 * la réouverture est retentée à l'écriture suivante.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const fsHooks = vi.hoisted(() => ({
  /** Nombre d'`openSync` à faire échouer à partir du N-ième appel (1-indexé). */
  failFrom: 0,
  failCount: 0,
  calls: 0,
  closed: /** @type {Set<number>} */ (new Set()),
  badWrites: 0,
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    openSync: (...args) => {
      fsHooks.calls += 1;
      if (
        fsHooks.failFrom > 0 &&
        fsHooks.calls >= fsHooks.failFrom &&
        fsHooks.calls < fsHooks.failFrom + fsHooks.failCount
      ) {
        throw Object.assign(new Error('EMFILE'), { code: 'EMFILE' });
      }
      const fd = actual.openSync(...args);
      fsHooks.closed.delete(fd);
      return fd;
    },
    closeSync: (fd) => {
      fsHooks.closed.add(fd);
      return actual.closeSync(fd);
    },
    writeSync: (fd, ...rest) => {
      if (fsHooks.closed.has(fd)) fsHooks.badWrites += 1;
      return actual.writeSync(fd, ...rest);
    },
  };
});

const { createRotatingFileSink } = await import('../../src/log-rotation.ts');

describe('rotation des journaux — réouverture en échec (intégration)', () => {
  let dir;
  let file;

  beforeEach(async () => {
    fsHooks.failFrom = 0;
    fsHooks.failCount = 0;
    fsHooks.calls = 0;
    fsHooks.closed.clear();
    fsHooks.badWrites = 0;
    dir = await mkdtemp(path.join(os.tmpdir(), 'striart-logrot-'));
    file = path.join(dir, 'x.log');
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(dir, { recursive: true, force: true, maxRetries: 5 }).catch(() => {});
  });

  it('openSync échoue après la rotation : write() ne lève pas, aucun descripteur fermé n’est réutilisé, la ligne part sur stderr', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const sink = createRotatingFileSink(file, { maxBytes: 50, generations: 2 });
    sink.write('a'.repeat(30) + '\n'); // 31 octets
    // Réouverture n°2 (appel 2 à openSync) : échec.
    fsHooks.failFrom = fsHooks.calls + 1;
    fsHooks.failCount = 1;

    expect(() => sink.write('b'.repeat(30) + '\n')).not.toThrow(); // déclenche la rotation

    expect(fsHooks.badWrites).toBe(0);
    expect(stderr.mock.calls.map((c) => String(c[0])).join('')).toContain('b'.repeat(30));

    // La réouverture est retentée à l'écriture suivante : le journal reprend.
    sink.write('c'.repeat(10) + '\n');
    sink.close();
    expect(fsHooks.badWrites).toBe(0);
    expect(await readFile(file, 'utf8')).toContain('c'.repeat(10));
    // La génération précédente existe (le décalage a bien eu lieu).
    expect(await readFile(`${file}.1`, 'utf8')).toContain('a'.repeat(30));
  });
});

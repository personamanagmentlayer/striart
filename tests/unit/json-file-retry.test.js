import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/**
 * writeJsonAtomic v2 face aux refus passagers de Windows : le renommage est
 * remplacé par un double qui échoue N fois (EPERM) avant de déléguer au vrai.
 */
const failures = vi.hoisted(() => ({ rename: 0, code: 'EPERM' }));

vi.mock('node:fs/promises', async (original) => {
  const actual = /** @type {typeof import('node:fs/promises')} */ (await original());
  return {
    ...actual,
    rename: async (from, to) => {
      if (failures.rename > 0) {
        failures.rename -= 1;
        throw Object.assign(new Error(`${failures.code}: simulated`), { code: failures.code });
      }
      return actual.rename(from, to);
    },
  };
});

const { writeJsonAtomic, withTransientRetry, isTransientFsError } =
  await import('../../src/json-file.js');

const realPlatform = process.platform;
function setPlatform(value) {
  Object.defineProperty(process, 'platform', { value, configurable: true });
}

describe('writeJsonAtomic v2 — nouvelles tentatives et fail closed', () => {
  let dir;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'striart-retry-'));
  });

  afterEach(async () => {
    setPlatform(realPlatform);
    failures.rename = 0;
    failures.code = 'EPERM';
    await rm(dir, { recursive: true, force: true });
  });

  it('Windows : un renommage refusé 2 fois (EPERM) finit par réussir', async () => {
    setPlatform('win32');
    failures.rename = 2;
    const file = path.join(dir, 'agents.json');
    await writeJsonAtomic(file, { a: 1 });
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ a: 1 });
    expect(failures.rename).toBe(0);
    expect(await readdir(dir)).toEqual(['agents.json']); // aucun .tmp laissé
  });

  it('refus persistant : STATE_WRITE_FAILED, temporaire retiré, ancien contenu intact', async () => {
    setPlatform('win32');
    const file = path.join(dir, 'queue.json');
    await writeJsonAtomic(file, ['old']);
    failures.rename = Number.POSITIVE_INFINITY;
    await expect(writeJsonAtomic(file, ['new'])).rejects.toMatchObject({
      code: 'STATE_WRITE_FAILED',
      details: { path: file, cause: 'EPERM' },
    });
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual(['old']);
    expect(await readdir(dir)).toEqual(['queue.json']);
  }, 10_000);

  it('hors Windows, EPERM n’est pas passager : échec immédiat, sans attente', async () => {
    setPlatform('linux');
    failures.rename = 1;
    const started = Date.now();
    await expect(writeJsonAtomic(path.join(dir, 's.json'), {})).rejects.toMatchObject({
      code: 'STATE_WRITE_FAILED',
    });
    expect(Date.now() - started).toBeLessThan(500);
  });

  it('deux écritures concurrentes n’utilisent jamais le même temporaire', async () => {
    const file = path.join(dir, 'state.json');
    await Promise.all(Array.from({ length: 20 }, (_, i) => writeJsonAtomic(file, { i })));
    expect(typeof JSON.parse(await readFile(file, 'utf8')).i).toBe('number');
    expect(await readdir(dir)).toEqual(['state.json']);
  });

  it('withTransientRetry : la dernière erreur remonte une fois le budget épuisé', async () => {
    setPlatform('win32');
    let calls = 0;
    const attempt = withTransientRetry(
      async () => {
        calls += 1;
        throw Object.assign(new Error('busy'), { code: 'EBUSY' });
      },
      { budgetMs: 100 },
    );
    await expect(attempt).rejects.toMatchObject({ code: 'EBUSY' });
    expect(calls).toBeGreaterThan(1);
    expect(isTransientFsError({ code: 'ENOENT' })).toBe(false);
  });
});

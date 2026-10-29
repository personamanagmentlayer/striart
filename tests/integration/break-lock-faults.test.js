/**
 * Verrou de cassure DÉBRIS impossible à supprimer (revue du noyau K-M5).
 * L'en-tête de state-lock.js promet une issue `failed` BORNÉE ; la reprise du
 * verrou de cassure (`state.lock.break`) levait au contraire aussitôt
 * STATE_LOCK_FAILED sur le premier EPERM/EBUSY (antivirus, indexeur Windows).
 *  - panne passagère → nouvelles tentatives bornées, la cassure aboutit ;
 *  - panne durable → STATE_LOCK_TIMEOUT nommé (reason BREAK_FAILED, cause)
 *    DANS le délai, sans spam de journal, jamais STATE_LOCK_FAILED.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execa } from 'execa';

const hooks = vi.hoisted(() => ({
  /** @type {null | ((file: string, op: string) => Promise<void> | void)} */
  before: null,
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal();
  const guarded =
    (op) =>
    async (file, ...args) => {
      if (hooks.before) await hooks.before(String(file), op);
      return actual[op](file, ...args);
    };
  return { ...actual, rm: guarded('rm'), rename: guarded('rename'), unlink: guarded('unlink') };
});

const { withStateLock } = await import('../../src/state-lock.ts');
const { logger } = await import('../../src/logger.ts');

async function deadPid() {
  return (await execa('node', ['-e', 'process.exit(0)'])).pid;
}

describe('verrou de cassure débris — suppression en panne (intégration)', () => {
  let root;
  let dir;
  let lockFile;
  let breakFile;

  beforeEach(async () => {
    hooks.before = null;
    root = await mkdtemp(path.join(os.tmpdir(), 'striart-break-faults-'));
    dir = path.join(root, '.striart');
    await mkdir(dir, { recursive: true });
    lockFile = path.join(dir, 'state.lock');
    breakFile = path.join(dir, 'state.lock.break');
    const pid = await deadPid();
    // Verrou d'état ET verrou de cassure laissés par des process morts.
    await writeFile(
      lockFile,
      `${JSON.stringify({ pid, token: 'mort', createdAt: new Date().toISOString() })}\n`,
    );
    await writeFile(
      breakFile,
      `${JSON.stringify({ pid, token: 'mort-casseur', startedAt: new Date().toISOString() })}\n`,
    );
  });

  afterEach(async () => {
    hooks.before = null;
    vi.restoreAllMocks();
    await rm(root, { recursive: true, force: true, maxRetries: 5 }).catch(() => {});
  });

  it('EPERM passager sur la suppression du verrou de cassure débris → réessayé, l’acquisition aboutit', async () => {
    let failures = 0;
    hooks.before = (file, op) => {
      if (op === 'rm' && file.endsWith('state.lock.break') && failures < 2) {
        failures += 1;
        throw Object.assign(new Error('EPERM'), { code: 'EPERM' });
      }
    };

    const result = await withStateLock(dir, async () => 'ok', { timeoutMs: 5_000 });

    expect(result).toBe('ok');
    expect(failures).toBe(2);
    await expect(stat(breakFile)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('EPERM durable → STATE_LOCK_TIMEOUT nommé dans le délai (jamais STATE_LOCK_FAILED), journal borné, débris intacts', async () => {
    hooks.before = (file, op) => {
      if (op === 'rm' && file.endsWith('state.lock.break'))
        throw Object.assign(new Error('EPERM'), { code: 'EPERM' });
    };
    const warn = vi.spyOn(logger, 'warn');
    const t0 = Date.now();

    const error = await withStateLock(dir, async () => 'jamais', { timeoutMs: 1_500 }).catch(
      (e) => e,
    );

    expect(error).toMatchObject({
      code: 'STATE_LOCK_TIMEOUT',
      details: { reason: 'BREAK_FAILED', cause: 'EPERM' },
    });
    expect(Date.now() - t0).toBeLessThan(4_000);
    expect(JSON.parse(await readFile(lockFile, 'utf8')).token).toBe('mort');
    expect(warn.mock.calls.length).toBeLessThanOrEqual(3);
  });
});

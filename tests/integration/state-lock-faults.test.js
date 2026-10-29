/**
 * Verrou d'état sous pannes d'E/S et courses de cassure — pendant de
 * lock-faults.test.js pour `state.lock` (revue du 2026-10-24). Le seul moyen
 * déterministe de placer une panne ou un retard AU MILIEU d'une séquence
 * d'appels fs est d'enrober `node:fs/promises` (le vrai disque tourne dessous) :
 *  - M1 : deux casseurs simultanés d'un verrou de cassure orphelin
 *         (`state.lock.break`) ne le tiennent jamais en même temps (prise de
 *         contrôle atomique, marqueur `.reclaim`) ;
 *  - M2 : un verrou de cassure tenu par un PID RECYCLÉ (vivant, étranger ou
 *         sans identité enregistrée) n'empêche plus la cassure à perpétuité ;
 *  - I2 : une suppression durablement impossible (EPERM) ne rend plus
 *         l'acquisition infinie ni brute — STATE_LOCK_TIMEOUT dans le délai,
 *         sans spam de journal, le verrou périmé intact ;
 *  - un détenteur VIVANT et identifié n'est jamais cassé (témoin).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
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
  return {
    ...actual,
    rm: guarded('rm'),
    rename: guarded('rename'),
    unlink: guarded('unlink'),
  };
});

const { underBreakLock, withStateLock } = await import('../../src/state-lock.ts');
const { logger } = await import('../../src/logger.ts');

async function deadPid() {
  return (await execa('node', ['-e', 'process.exit(0)'])).pid;
}

describe('verrou d’état — pannes d’E/S et courses de cassure (intégration)', () => {
  let root;
  let dir;
  let lockFile;
  let breakFile;

  beforeEach(async () => {
    hooks.before = null;
    root = await mkdtemp(path.join(os.tmpdir(), 'striart-state-faults-'));
    dir = path.join(root, '.striart');
    await mkdir(dir, { recursive: true });
    lockFile = path.join(dir, 'state.lock');
    breakFile = path.join(dir, 'state.lock.break');
  });

  afterEach(async () => {
    hooks.before = null;
    vi.restoreAllMocks();
    await rm(root, { recursive: true, force: true, maxRetries: 5 }).catch(() => {});
  });

  /** state.lock laissé par un process mort : un débris à casser. */
  async function writeDeadStateLock() {
    await writeFile(
      lockFile,
      `${JSON.stringify({ pid: await deadPid(), token: 'mort', createdAt: new Date().toISOString() })}\n`,
    );
  }

  it('M1 : deux casseurs simultanés d’un verrou de cassure orphelin → jamais deux dans la section de cassure', async () => {
    await writeFile(
      breakFile,
      JSON.stringify({ pid: await deadPid(), token: 'mort', startedAt: new Date().toISOString() }),
    );
    let active = 0;
    let max = 0;
    let signalInside;
    const inside = new Promise((resolve) => {
      signalInside = resolve;
    });
    // Le SECOND appel qui supprime le verrou de cassure attend que le premier
    // casseur soit DANS sa section : c'est l'entrelacement fatal d'une prise
    // de contrôle non atomique (comparaison faite avant, suppression après la
    // création du verrou neuf par l'autre).
    let touches = 0;
    hooks.before = async (file) => {
      if (!file.endsWith('state.lock.break')) return;
      touches += 1;
      if (touches > 1) await Promise.race([inside, sleep(3_000)]);
    };
    const run = () =>
      underBreakLock(dir, async () => {
        active += 1;
        max = Math.max(max, active);
        signalInside();
        await sleep(200);
        active -= 1;
      });
    const results = await Promise.all([run(), run()]);
    expect(max).toBe(1);
    expect(results).toContain(true);
    await expect(stat(breakFile)).rejects.toThrow();
  });

  it('M2 : verrou de cassure d’un PID recyclé VIVANT sans identité enregistrée, ancien → débris, la cassure reprend', async () => {
    const holder = execa('node', ['-e', 'setTimeout(() => {}, 60000)'], { reject: false });
    try {
      await writeDeadStateLock();
      await writeFile(
        breakFile,
        JSON.stringify({ pid: holder.pid, token: 'ancien', startedAt: new Date().toISOString() }),
      );
      const old = new Date(Date.now() - 2 * 60_000);
      await utimes(breakFile, old, old);
      await expect(withStateLock(dir, async () => 'acquis', { timeoutMs: 8_000 })).resolves.toBe(
        'acquis',
      );
      await expect(stat(breakFile)).rejects.toThrow();
    } finally {
      holder.kill();
      await holder;
    }
  });

  it('M2 : verrou de cassure d’un PID recyclé vivant ÉTRANGER (identité enregistrée) → débris, la cassure reprend', async () => {
    const foreign = execa('node', ['-e', 'setTimeout(() => {}, 60000)'], { reject: false });
    try {
      await writeDeadStateLock();
      await writeFile(
        breakFile,
        JSON.stringify({
          pid: foreign.pid,
          token: 'recycle',
          startedAt: new Date().toISOString(),
          script: 'cli.js',
        }),
      );
      const old = new Date(Date.now() - 2 * 60_000);
      await utimes(breakFile, old, old);
      await expect(withStateLock(dir, async () => 'acquis', { timeoutMs: 8_000 })).resolves.toBe(
        'acquis',
      );
    } finally {
      foreign.kill();
      await foreign;
    }
  });

  it('témoin : verrou de cassure d’un vivant RÉCENT → respecté (BREAK_IN_PROGRESS), verrou périmé intact', async () => {
    await writeDeadStateLock();
    await writeFile(
      breakFile,
      JSON.stringify({ pid: process.pid, token: 'casseur', startedAt: new Date().toISOString() }),
    );
    const error = await withStateLock(dir, async () => 'jamais', { timeoutMs: 600 }).catch(
      (e) => e,
    );
    expect(error).toMatchObject({
      code: 'STATE_LOCK_TIMEOUT',
      details: { reason: 'BREAK_IN_PROGRESS' },
    });
    expect(JSON.parse(await readFile(lockFile, 'utf8')).token).toBe('mort');
  });

  it('verrou de cassure d’un casseur mort + marqueur de reprise orphelin → la cassure reprend', async () => {
    await writeDeadStateLock();
    const pid = await deadPid();
    await writeFile(
      breakFile,
      JSON.stringify({ pid, token: 'mort', startedAt: new Date().toISOString() }),
    );
    await writeFile(
      `${breakFile}.reclaim`,
      JSON.stringify({ pid, startedAt: new Date().toISOString() }),
    );
    await expect(withStateLock(dir, async () => 'acquis', { timeoutMs: 8_000 })).resolves.toBe(
      'acquis',
    );
    await expect(stat(breakFile)).rejects.toThrow();
    await expect(stat(`${breakFile}.reclaim`)).rejects.toThrow();
  });

  it('I2 : suppression du verrou orphelin durablement impossible (EPERM) → STATE_LOCK_TIMEOUT nommé dans le délai, sans spam de logs', async () => {
    await writeDeadStateLock();
    hooks.before = (file) => {
      if (file.endsWith('state.lock')) throw Object.assign(new Error('EPERM'), { code: 'EPERM' });
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
    // Le verrou orphelin est toujours là, intact.
    expect(JSON.parse(await readFile(lockFile, 'utf8')).token).toBe('mort');
    // Journal borné : l'échec est dit, pas répété à chaque tour.
    expect(warn.mock.calls.length).toBeLessThanOrEqual(3);
  });

  it('témoin : détenteur VIVANT et identifié → jamais cassé, même ancien (STATE_LOCK_TIMEOUT)', async () => {
    const holder = execa('node', ['-e', 'setTimeout(() => {}, 60000)'], { reject: false });
    try {
      await writeFile(
        lockFile,
        `${JSON.stringify({ pid: holder.pid, token: 'vivant', createdAt: new Date().toISOString() })}\n`,
      );
      const old = new Date(Date.now() - 2 * 60_000);
      await utimes(lockFile, old, old);
      await expect(
        withStateLock(dir, async () => 'jamais', { timeoutMs: 400 }),
      ).rejects.toMatchObject({ code: 'STATE_LOCK_TIMEOUT', details: { pid: holder.pid } });
      expect(JSON.parse(await readFile(lockFile, 'utf8')).token).toBe('vivant');
    } finally {
      holder.kill();
      await holder;
    }
  });
});

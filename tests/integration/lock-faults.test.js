/**
 * Verrou principal sous pannes d'E/S et courses de cassure (revue L1, second
 * tour) — le seul moyen déterministe de placer une panne ou un retard AU
 * MILIEU d'une séquence d'appels fs est d'enrober `node:fs/promises` (le vrai
 * disque tourne dessous) :
 *  - I2  : une suppression durablement impossible (EPERM/EBUSY) ne rend plus
 *          l'acquisition infinie — LOCK_TIMEOUT dans le délai, sans spam ;
 *  - M1  : deux casseurs simultanés d'un verrou de cassure orphelin ne le
 *          tiennent jamais en même temps (prise de contrôle atomique) ;
 *  - M6  : un waiter derrière N tickets vivants ne relit pas toute la file à
 *          chaque sondage.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { execa } from 'execa';

const hooks = vi.hoisted(() => ({
  /** @type {null | ((file: string, op: string) => Promise<void> | void)} */
  before: null,
  /** @type {null | ((file: string) => void)} */
  onRead: null,
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
    readFile: async (file, ...args) => {
      hooks.onRead?.(String(file));
      return actual.readFile(file, ...args);
    },
  };
});

const { createTempRepo } = await import('../helpers/temp-repo.js');
const { initStriart } = await import('../../src/init.js');
const { underBreakLock, withMainLock } = await import('../../src/lock.js');
const { logger } = await import('../../src/logger.js');

async function deadPid() {
  return (await execa('node', ['-e', 'process.exit(0)'])).pid;
}

describe('verrou principal — pannes d’E/S et courses de cassure (intégration)', () => {
  let repo;
  let lockFile;
  let queueDir;
  let breakFile;

  beforeEach(async () => {
    hooks.before = null;
    hooks.onRead = null;
    repo = await createTempRepo();
    await initStriart(repo.root);
    lockFile = path.join(repo.root, '.striart', 'main.lock');
    queueDir = path.join(repo.root, '.striart', 'lock-queue');
    breakFile = path.join(queueDir, 'break.lock');
  });

  afterEach(async () => {
    hooks.before = null;
    hooks.onRead = null;
    vi.restoreAllMocks();
    await repo.cleanup();
  });

  it('I2 : suppression du verrou orphelin durablement impossible (EPERM) → LOCK_TIMEOUT dans le délai, sans boucle ni spam de logs', async () => {
    await writeFile(
      lockFile,
      JSON.stringify({ pid: await deadPid(), startedAt: new Date().toISOString(), label: 'crash' }),
    );
    hooks.before = (file) => {
      if (file.endsWith('main.lock')) throw Object.assign(new Error('EPERM'), { code: 'EPERM' });
    };
    const warn = vi.spyOn(logger, 'warn');
    // Garde-fou du test : sans borne, l'ancienne boucle ne finit jamais.
    const controller = new AbortController();
    const guard = setTimeout(() => controller.abort(), 8_000);
    const t0 = Date.now();
    const error = await withMainLock(repo.root, 'x', async () => 'jamais', {
      timeoutMs: 1_500,
      signal: controller.signal,
    }).catch((e) => e);
    clearTimeout(guard);
    expect(error).toMatchObject({
      code: 'LOCK_TIMEOUT',
      details: { reason: 'BREAK_FAILED', cause: 'EPERM' },
    });
    expect(Date.now() - t0).toBeLessThan(4_000);
    // Le verrou orphelin est toujours là, intact.
    expect(JSON.parse(await readFile(lockFile, 'utf8')).label).toBe('crash');
    // Journal borné : l'échec est dit, pas répété à chaque tour.
    expect(warn.mock.calls.length).toBeLessThanOrEqual(3);
  });

  it('M1 : deux casseurs simultanés d’un verrou de cassure orphelin → jamais deux dans la section de cassure', async () => {
    await mkdir(queueDir, { recursive: true });
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
    // Le SECOND appel qui touche au verrou de cassure (suppression ou
    // renommage) attend que le premier casseur soit DANS sa section : c'est
    // l'entrelacement fatal d'une prise de contrôle non atomique (comparaison
    // faite avant, suppression après la création du verrou neuf par l'autre).
    let touches = 0;
    hooks.before = async (file) => {
      if (!file.endsWith('break.lock')) return;
      touches += 1;
      if (touches > 1) await Promise.race([inside, sleep(3_000)]);
    };
    const run = () =>
      underBreakLock(repo.root, async () => {
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

  it('M6 : un waiter derrière 20 tickets vivants ne relit pas toute la file à chaque sondage', async () => {
    await mkdir(queueDir, { recursive: true });
    for (let i = 1; i <= 20; i += 1) {
      await writeFile(
        path.join(queueDir, `${String(i).padStart(12, '0')}.json`),
        JSON.stringify({ pid: process.pid, token: `t${i}`, label: 'forge' }),
      );
    }
    const reads = [];
    hooks.onRead = (file) => {
      if (/lock-queue[\\/]0{10}(0[1-9]|1\d|20)\.json$/.test(file)) reads.push(file);
    };
    const error = await withMainLock(repo.root, 'x', async () => 'jamais', {
      timeoutMs: 1_000,
    }).catch((e) => e);
    expect(error).toMatchObject({ code: 'LOCK_TIMEOUT', details: { waitingAhead: 20 } });
    // ~4 sondages : l'ancien code lisait les 20 tickets à chacun (80 lectures).
    expect(reads.length).toBeLessThanOrEqual(8);
    expect(
      (await readdir(queueDir)).filter((n) => /^0{10}(0[1-9]|1\d|20)\.json$/.test(n)),
    ).toHaveLength(20);
    await rm(queueDir, { recursive: true, force: true });
  });
});

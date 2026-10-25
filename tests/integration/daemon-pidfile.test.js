/**
 * PID file et démarrage d'un daemon (revue du noyau K-I7, K-M4) :
 *  - un PID file ILLISIBLE n'est plus « aucun daemon » (fail-open : un second
 *    daemon partait, `--stop` ne tuait rien) : seul ENOENT prouve l'absence ;
 *    une lecture passagère est retentée, une autre erreur est NOMMÉE ;
 *  - un PID file corrompu est refusé (DAEMON_PIDFILE_CORRUPT), jamais écrasé ;
 *  - le journal du daemon est ouvert en asynchrone et sa poignée est fermée
 *    dans le parent, y compris quand le lancement échoue ;
 *  - un lancement raté (pas de PID, événement `error`) échoue en
 *    DAEMON_SPAWN_FAILED, sans PID file sans pid ;
 *  - le verrou du PID file est un vrai verrou à jeton (casseur sérialisé,
 *    débris d'un démarreur mort repris tout de suite).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execa } from 'execa';
import { isProcessAlive } from '../../src/process-tree.js';

const mocks = vi.hoisted(() => ({
  /** @type {null | ((file: string) => Error | null)} */
  readFault: null,
  /** Handles ouverts sur un journal (`*.log`). */
  logHandles: /** @type {any[]} */ ([]),
  spawnCalls: 0,
  /** @type {() => any} */
  makeChild: () => ({}),
  identity: 'alive',
  /** Verdicts consommés dans l'ordre avant de retomber sur `identity`. */
  identitySeq: /** @type {string[]} */ ([]),
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    readFile: async (file, ...args) => {
      const fault = mocks.readFault?.(String(file));
      if (fault) throw fault;
      return actual.readFile(file, ...args);
    },
    open: async (file, ...args) => {
      const handle = await actual.open(file, ...args);
      if (String(file).endsWith('.log')) mocks.logHandles.push(handle);
      return handle;
    },
  };
});

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    spawn: (...args) => {
      mocks.spawnCalls += 1;
      return mocks.makeChild(...args);
    },
  };
});

vi.mock('../../src/process-info.ts', async (importOriginal) => ({
  ...(await importOriginal()),
  checkProcessInstance: async () => mocks.identitySeq.shift() ?? mocks.identity,
}));

const { daemonStatus, startDaemon, stopDaemon } = await import('../../src/daemon.js');

function okChild(pid = 424242) {
  const child = new EventEmitter();
  child.pid = pid;
  child.unref = () => {};
  return child;
}

function failingChild() {
  const child = new EventEmitter();
  child.pid = undefined;
  child.unref = () => {};
  queueMicrotask(() =>
    child.emit('error', Object.assign(new Error('spawn x ENOENT'), { code: 'ENOENT' })),
  );
  return child;
}

async function deadPid() {
  return (await execa('node', ['-e', 'process.exit(0)'])).pid;
}

describe('daemon — PID file et démarrage (intégration)', () => {
  let root;
  let stateDir;
  let pidFile;

  beforeEach(async () => {
    mocks.readFault = null;
    mocks.logHandles.length = 0;
    mocks.spawnCalls = 0;
    mocks.makeChild = () => okChild();
    mocks.identity = 'alive';
    mocks.identitySeq.length = 0;
    root = await mkdtemp(path.join(os.tmpdir(), 'striart-daemon-pid-'));
    stateDir = path.join(root, '.striart');
    await mkdir(stateDir, { recursive: true });
    pidFile = path.join(stateDir, 'watch.pid');
  });

  afterEach(async () => {
    mocks.readFault = null;
    await rm(root, { recursive: true, force: true, maxRetries: 5 }).catch(() => {});
  });

  const publish = () =>
    writeFile(pidFile, JSON.stringify({ pid: 777777, startedAt: new Date().toISOString() }));

  it('PID file absent : aucun daemon (seul ENOENT prouve l’absence)', async () => {
    expect(await daemonStatus({ root, name: 'watch' })).toMatchObject({
      running: false,
      stale: false,
      pid: null,
    });
  });

  it('lecture impossible (EACCES) : STATE_READ_FAILED nommé, JAMAIS « aucun daemon » ; aucun second daemon lancé', async () => {
    await publish();
    mocks.readFault = (file) =>
      file.endsWith('watch.pid') ? Object.assign(new Error('EACCES'), { code: 'EACCES' }) : null;

    await expect(daemonStatus({ root, name: 'watch' })).rejects.toMatchObject({
      code: 'STATE_READ_FAILED',
    });
    await expect(
      startDaemon({ root, name: 'watch', label: 'watcher', args: ['watch'] }),
    ).rejects.toMatchObject({ code: 'STATE_READ_FAILED' });
    expect(mocks.spawnCalls).toBe(0);
  });

  it.runIf(process.platform === 'win32')(
    'lecture passagère (EBUSY, Windows) : retentée, le daemon publié est vu',
    async () => {
      await publish();
      let failures = 0;
      mocks.readFault = (file) => {
        if (!file.endsWith('watch.pid') || failures >= 2) return null;
        failures += 1;
        return Object.assign(new Error('EBUSY'), { code: 'EBUSY' });
      };

      expect(await daemonStatus({ root, name: 'watch' })).toMatchObject({
        running: true,
        pid: 777777,
      });
      expect(failures).toBe(2);
    },
  );

  it('PID file corrompu : DAEMON_PIDFILE_CORRUPT, fichier intact, aucun lancement', async () => {
    await writeFile(pidFile, '{"pid": 12');

    await expect(daemonStatus({ root, name: 'watch' })).rejects.toMatchObject({
      code: 'DAEMON_PIDFILE_CORRUPT',
      kind: 'refusal',
    });
    await expect(
      startDaemon({ root, name: 'watch', label: 'watcher', args: ['watch'] }),
    ).rejects.toMatchObject({ code: 'DAEMON_PIDFILE_CORRUPT' });
    expect(mocks.spawnCalls).toBe(0);
    expect(await readFile(pidFile, 'utf8')).toBe('{"pid": 12');
  });

  it('lancement réussi : PID file écrit avec le pid, poignée du journal FERMÉE dans le parent', async () => {
    const started = await startDaemon({ root, name: 'watch', label: 'watcher', args: ['watch'] });

    expect(started.pid).toBe(424242);
    expect(JSON.parse(await readFile(pidFile, 'utf8')).pid).toBe(424242);
    expect(mocks.logHandles).toHaveLength(1);
    expect(mocks.logHandles.every((handle) => handle.fd === -1)).toBe(true);
  });

  it('lancement raté (événement error, pas de pid) : DAEMON_SPAWN_FAILED, pas de PID file, poignée fermée', async () => {
    mocks.makeChild = () => failingChild();

    await expect(
      startDaemon({ root, name: 'watch', label: 'watcher', args: ['watch'] }),
    ).rejects.toMatchObject({ code: 'DAEMON_SPAWN_FAILED', kind: 'failure' });

    await expect(stat(pidFile)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(mocks.logHandles.length).toBeGreaterThan(0);
    expect(mocks.logHandles.every((handle) => handle.fd === -1)).toBe(true);
  });

  it('verrou du PID file laissé par un démarreur MORT (récent) : repris aussitôt, sans attendre 30 s', async () => {
    await writeFile(
      path.join(stateDir, 'watch.pid.lock'),
      `${JSON.stringify({ pid: await deadPid(), token: 'mort', createdAt: new Date().toISOString() })}\n`,
    );
    const t0 = Date.now();

    const started = await startDaemon({ root, name: 'watch', label: 'watcher', args: ['watch'] });

    expect(started.pid).toBe(424242);
    expect(Date.now() - t0).toBeLessThan(5_000);
    await expect(stat(path.join(stateDir, 'watch.pid.lock'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('deux démarrages simultanés sur un verrou débris : UN seul lancement, l’autre voit DAEMON_RUNNING', async () => {
    await writeFile(
      path.join(stateDir, 'watch.pid.lock'),
      `${JSON.stringify({ pid: await deadPid(), token: 'mort', createdAt: new Date().toISOString() })}\n`,
    );

    const results = await Promise.allSettled([
      startDaemon({ root, name: 'watch', label: 'watcher', args: ['watch'] }),
      startDaemon({ root, name: 'watch', label: 'watcher', args: ['watch'] }),
    ]);

    expect(mocks.spawnCalls).toBe(1);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((r) => r.status === 'rejected');
    expect(rejected.reason).toMatchObject({ code: 'DAEMON_RUNNING' });
  });

  it('verrou tenu par un démarreur VIVANT : DAEMON_BUSY (délai borné), jamais cassé', async () => {
    const holder = execa('node', ['-e', 'setTimeout(() => {}, 60000)'], { reject: false });
    try {
      await writeFile(
        path.join(stateDir, 'watch.pid.lock'),
        `${JSON.stringify({ pid: holder.pid, token: 'vivant', createdAt: new Date().toISOString() })}\n`,
      );
      await expect(
        startDaemon({ root, name: 'watch', label: 'watcher', args: ['watch'], lockTimeoutMs: 400 }),
      ).rejects.toMatchObject({ code: 'DAEMON_BUSY' });
      expect(mocks.spawnCalls).toBe(0);
    } finally {
      holder.kill();
      await holder;
    }
  });

  it('--stop sans accusé : identité RELUE sans cache avant le signal de repli — PID devenu étranger, aucun signal', async () => {
    const stranger = execa('node', ['-e', 'setTimeout(() => {}, 60000)'], { reject: false });
    try {
      await writeFile(
        pidFile,
        JSON.stringify({ pid: stranger.pid, startedAt: new Date().toISOString() }),
      );
      // 1er verdict (état, décision destructive) : daemon reconnu ; 2e (juste avant
      // le repli) : le numéro appartient désormais à un autre programme.
      mocks.identitySeq.push('alive', 'foreign');

      const outcome = await stopDaemon({ root, name: 'watch', waitMs: 300, ackWaitMs: 300 });

      expect(outcome).toMatchObject({ stopped: false, stopping: true });
      expect(isProcessAlive(stranger.pid)).toBe(true);
    } finally {
      stranger.kill();
      await stranger;
    }
  });

  it('--stop sans accusé et identité confirmée : repli par signal (témoin)', async () => {
    const victim = execa('node', ['-e', 'setTimeout(() => {}, 60000)'], { reject: false });
    try {
      await writeFile(
        pidFile,
        JSON.stringify({ pid: victim.pid, startedAt: new Date().toISOString() }),
      );
      mocks.identity = 'alive';

      const outcome = await stopDaemon({ root, name: 'watch', waitMs: 3_000, ackWaitMs: 200 });

      expect(outcome).toMatchObject({ stopped: true });
    } finally {
      victim.kill();
      await victim;
    }
  });
});

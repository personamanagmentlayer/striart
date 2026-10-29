import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { createTempRepo } from '../helpers/temp-repo.js';
import { initStriart } from '../../src/init.ts';
import { isProcessAlive } from '../../src/process-tree.ts';
import {
  dashboardDaemonStatus,
  startDashboardDaemon,
  startWatchDaemon,
  stopDaemon,
  stopDashboardDaemon,
  stopWatchDaemon,
  watchDaemonStatus,
} from '../../src/daemon.ts';

async function waitFor(predicate, { timeoutMs = 15_000, stepMs = 250 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, stepMs));
  }
  return false;
}

describe('striart watch --daemon (intégration)', () => {
  let repo;

  beforeEach(async () => {
    repo = await createTempRepo();
    await initStriart(repo.root);
  });

  afterEach(async () => {
    await stopWatchDaemon({ root: repo.root }).catch(() => {});
    await repo.cleanup();
  });

  it('cycle de vie complet : start → status running → double start refusé → stop', async () => {
    const started = await startWatchDaemon({ root: repo.root });
    expect(started.pid).toBeGreaterThan(0);

    const status = await watchDaemonStatus({ root: repo.root });
    expect(status).toMatchObject({ running: true, pid: started.pid });

    // Le watcher écrit réellement dans son log (démarrage confirmé).
    const logged = await waitFor(async () => {
      const log = await readFile(started.logPath, 'utf8').catch(() => '');
      return log.length > 0;
    });
    expect(logged).toBe(true);

    // Un second daemon est refusé tant que le premier vit.
    await expect(startWatchDaemon({ root: repo.root })).rejects.toMatchObject({
      code: 'DAEMON_RUNNING',
    });

    const stopped = await stopWatchDaemon({ root: repo.root });
    expect(stopped).toMatchObject({ stopped: true, pid: started.pid });
    // PID file nettoyé, plus de daemon.
    await expect(stat(path.join(repo.root, '.striart', 'watch.pid'))).rejects.toThrow();
    expect((await watchDaemonStatus({ root: repo.root })).running).toBe(false);
  });

  // Sous Windows, un signal est un TerminateProcess : le watcher mourait en
  // plein merge, sans vidange. La demande d'arrêt est lue par le daemon
  // lui-même — l'événement de fin du flux ndjson prouve une sortie propre.
  it('stop : arrêt propre (demande lue par le daemon), sur tous les OS', async () => {
    const started = await startWatchDaemon({ root: repo.root });
    const logged = await waitFor(async () =>
      (await readFile(started.logPath, 'utf8').catch(() => '')).includes('"type":"started"'),
    );
    expect(logged).toBe(true);
    expect(await stopWatchDaemon({ root: repo.root })).toMatchObject({
      stopped: true,
      pid: started.pid,
    });
    const log = await readFile(started.logPath, 'utf8');
    expect(log).toContain('"type":"end"');
    await expect(stat(path.join(repo.root, '.striart', 'watch.stop'))).rejects.toThrow();
  });

  it('deux --daemon simultanés : un seul démarre, l’autre est refusé', async () => {
    const results = await Promise.allSettled([
      startWatchDaemon({ root: repo.root }),
      startWatchDaemon({ root: repo.root }),
    ]);
    const ok = results.filter((r) => r.status === 'fulfilled');
    const refused = results.filter((r) => r.status === 'rejected');
    expect(ok).toHaveLength(1);
    expect(refused).toHaveLength(1);
    expect(refused[0].reason).toMatchObject({ code: 'DAEMON_RUNNING' });
  });

  it('PID file orphelin (process mort) : détecté stale, nettoyé par stop, start repart', async () => {
    // PID improbable mais bien formé.
    await writeFile(
      path.join(repo.root, '.striart', 'watch.pid'),
      JSON.stringify({ pid: 999999, startedAt: new Date().toISOString() }),
    );
    const status = await watchDaemonStatus({ root: repo.root });
    expect(status).toMatchObject({ running: false, stale: true, pid: 999999 });

    const stopped = await stopWatchDaemon({ root: repo.root });
    expect(stopped).toMatchObject({ stopped: false, wasStale: true });

    // Après nettoyage, un vrai daemon démarre.
    const started = await startWatchDaemon({ root: repo.root });
    expect((await watchDaemonStatus({ root: repo.root })).running).toBe(true);
    await stopWatchDaemon({ root: repo.root });
    expect(started.pid).not.toBe(999999);
  });
});

/**
 * Un PID file dont le numéro désigne désormais un AUTRE process (PID
 * recyclé par l'OS après un reboot ou un crash). Le croire vivant gelait le
 * daemon (DAEMON_RUNNING à vie) ; pire, `--stop` tuait ce process innocent.
 */
describe('daemon : PID recyclé par un process étranger', () => {
  let repo;
  let stranger;

  beforeEach(async () => {
    repo = await createTempRepo();
    await initStriart(repo.root);
    stranger = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1e9)'], { stdio: 'ignore' });
    await waitFor(() => isProcessAlive(stranger.pid));
    await writeFile(
      path.join(repo.root, '.striart', 'watch.pid'),
      JSON.stringify({ pid: stranger.pid, startedAt: new Date().toISOString() }),
    );
  });

  afterEach(async () => {
    stranger?.kill();
    await stopWatchDaemon({ root: repo.root }).catch(() => {});
    await repo.cleanup();
  });

  it('status : stale (pas running) ; stop : nettoie sans tuer ; start repart', async () => {
    const status = await watchDaemonStatus({ root: repo.root });
    expect(status).toMatchObject({ running: false, stale: true, pid: stranger.pid });

    const stopped = await stopWatchDaemon({ root: repo.root });
    expect(stopped).toMatchObject({ stopped: false, wasStale: true });
    expect(isProcessAlive(stranger.pid)).toBe(true); // jamais tué
    await expect(stat(path.join(repo.root, '.striart', 'watch.pid'))).rejects.toThrow();

    const started = await startWatchDaemon({ root: repo.root });
    expect(started.pid).not.toBe(stranger.pid);
    expect((await watchDaemonStatus({ root: repo.root })).running).toBe(true);
  });
});

/**
 * Faux daemon : un script nommé `cli.js` lancé avec l'argument `watch` —
 * même identité qu'un vrai (ligne de commande), comportement piloté :
 *  - `ack`  : accuse la demande d'arrêt puis met `holdMs` à sortir (vidange) ;
 *  - `deaf` : ignore la demande (version antérieure) — seul un signal l'arrête.
 */
const FAKE_DAEMON = `
const { readFileSync, writeFileSync } = require('node:fs');
const [, , , mode, stopFile, holdMs] = process.argv;
setInterval(() => {
  if (mode !== 'ack') return;
  let request = null;
  try { request = JSON.parse(readFileSync(stopFile, 'utf8')); } catch {}
  if (request && request.pid === process.pid && !request.ackAt) {
    writeFileSync(stopFile, JSON.stringify({ ...request, ackAt: new Date().toISOString() }));
    setTimeout(() => process.exit(0), Number(holdMs));
  }
}, 50);
`;

describe('daemon : protocole d’arrêt (faux daemons)', () => {
  let repo;
  let fakeDir;
  let daemon;

  async function startFake(mode, holdMs = 0) {
    const stopFile = path.join(repo.root, '.striart', 'watch.stop');
    daemon = spawn(
      process.execPath,
      [path.join(fakeDir, 'cli.js'), 'watch', mode, stopFile, String(holdMs)],
      { stdio: 'ignore' },
    );
    await waitFor(() => isProcessAlive(daemon.pid));
    await writeFile(
      path.join(repo.root, '.striart', 'watch.pid'),
      JSON.stringify({ pid: daemon.pid, startedAt: new Date().toISOString() }),
    );
    return daemon.pid;
  }

  beforeEach(async () => {
    repo = await createTempRepo();
    await initStriart(repo.root);
    fakeDir = await mkdtemp(path.join(os.tmpdir(), 'striart-fake-daemon-'));
    await writeFile(path.join(fakeDir, 'cli.js'), FAKE_DAEMON);
  });

  afterEach(async () => {
    daemon?.kill();
    await repo.cleanup();
    await rm(fakeDir, { recursive: true, force: true });
  });

  // Un watcher qui draine un merge sort après l'attente de stop : son PID
  // file reste en place tant qu'il vit, et un second --stop ne re-signale
  // pas (un second signal forcerait la sortie en plein Test Gate).
  it('daemon lent à sortir : stopping, PID file conservé ; second --stop sans re-signal', async () => {
    const pid = await startFake('ack', 15_000);
    const kill = vi.spyOn(process, 'kill');
    try {
      const first = await stopDaemon({ root: repo.root, name: 'watch', waitMs: 300 });
      expect(first).toMatchObject({ stopped: false, stopping: true, pid });
      await expect(stat(path.join(repo.root, '.striart', 'watch.pid'))).resolves.toBeTruthy();
      await expect(startWatchDaemon({ root: repo.root })).rejects.toMatchObject({
        code: 'DAEMON_RUNNING',
      });
      const second = await stopDaemon({ root: repo.root, name: 'watch', waitMs: 300 });
      expect(second).toMatchObject({ stopping: true });
      const signalled = kill.mock.calls.filter(([p, sig]) => p === pid && sig !== 0);
      expect(signalled).toEqual([]);
    } finally {
      kill.mockRestore();
    }
    expect(await stopDaemon({ root: repo.root, name: 'watch', waitMs: 25_000 })).toMatchObject({
      stopped: true,
    });
  });

  it('daemon sans accusé (version antérieure) : repli sur le signal', async () => {
    const pid = await startFake('deaf');
    const result = await stopDaemon({ root: repo.root, name: 'watch', ackWaitMs: 500 });
    expect(result).toMatchObject({ stopped: true, pid });
    expect(isProcessAlive(pid)).toBe(false);
  });

  // Daemon d'un autre utilisateur (EPERM au signal) : ni tué, ni oublié.
  it('signal refusé (EPERM) : DAEMON_STOP_DENIED, PID file conservé', async () => {
    const pid = await startFake('deaf');
    const realKill = process.kill.bind(process);
    const kill = vi.spyOn(process, 'kill').mockImplementation((target, signal) => {
      if (target === pid && signal !== 0) {
        throw Object.assign(new Error('kill EPERM'), { code: 'EPERM' });
      }
      return realKill(target, signal);
    });
    try {
      await expect(
        stopDaemon({ root: repo.root, name: 'watch', ackWaitMs: 300 }),
      ).rejects.toMatchObject({
        code: 'DAEMON_STOP_DENIED',
        kind: 'refusal',
        details: { name: 'watch', pid },
      });
      await expect(stat(path.join(repo.root, '.striart', 'watch.pid'))).resolves.toBeTruthy();
    } finally {
      kill.mockRestore();
    }
  });
});

/**
 * `daemon.js` a été généralisé le 2026-09-09 (extraction pour `dashboard
 * --daemon`, qui réutilise exactement le même mécanisme que `watch --daemon`
 * plutôt que d'en recopier un). Ces tests couvrent la même chose que ceux du
 * watcher ci-dessus, plus l'absence de collision entre les deux daemons.
 */
describe('striart dashboard --daemon (intégration)', () => {
  let repo;

  beforeEach(async () => {
    repo = await createTempRepo();
    await initStriart(repo.root);
  });

  afterEach(async () => {
    await stopDashboardDaemon({ root: repo.root }).catch(() => {});
    await stopWatchDaemon({ root: repo.root }).catch(() => {});
    await repo.cleanup();
  });

  it('cycle de vie complet : start → status running → double start refusé → stop', async () => {
    // port: 0 — le serveur choisit un port libre, jamais de collision entre exécutions.
    const started = await startDashboardDaemon({ root: repo.root, port: 0 });
    expect(started.pid).toBeGreaterThan(0);

    const status = await dashboardDaemonStatus({ root: repo.root });
    expect(status).toMatchObject({ running: true, pid: started.pid });

    const logged = await waitFor(async () => {
      const log = await readFile(started.logPath, 'utf8').catch(() => '');
      return log.length > 0;
    });
    expect(logged).toBe(true);

    await expect(startDashboardDaemon({ root: repo.root })).rejects.toMatchObject({
      code: 'DAEMON_RUNNING',
    });

    const stopped = await stopDashboardDaemon({ root: repo.root });
    expect(stopped).toMatchObject({ stopped: true, pid: started.pid });
    await expect(stat(path.join(repo.root, '.striart', 'dashboard.pid'))).rejects.toThrow();
    expect((await dashboardDaemonStatus({ root: repo.root })).running).toBe(false);
  });

  it('ne collisionne pas avec un watch daemon en cours (PID/log distincts, tous deux vivants)', async () => {
    const watch = await startWatchDaemon({ root: repo.root });
    const dashboard = await startDashboardDaemon({ root: repo.root, port: 0 });
    expect(dashboard.pid).not.toBe(watch.pid);
    expect(dashboard.logPath).not.toBe(watch.logPath);
    expect((await watchDaemonStatus({ root: repo.root })).running).toBe(true);
    expect((await dashboardDaemonStatus({ root: repo.root })).running).toBe(true);
  });
});

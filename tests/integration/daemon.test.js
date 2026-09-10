import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createTempRepo } from '../helpers/temp-repo.js';
import { initStriart } from '../../src/init.js';
import {
  dashboardDaemonStatus,
  startDashboardDaemon,
  startWatchDaemon,
  stopDashboardDaemon,
  stopWatchDaemon,
  watchDaemonStatus,
} from '../../src/daemon.js';

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

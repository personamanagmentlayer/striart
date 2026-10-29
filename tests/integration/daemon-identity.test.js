import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createTempRepo } from '../helpers/temp-repo.js';
import { initStriart } from '../../src/init.ts';
import { isProcessAlive } from '../../src/process-tree.ts';
import { ptyHostPidFilePath } from '../../src/pty-host-state.ts';

// Lecture d'identité en panne (PowerShell bloqué, WMI cassé…) : le verdict
// est `unverified`. Il suffit pour s'abstenir, jamais pour tuer.
vi.mock('../../src/process-info.ts', async (importOriginal) => ({
  ...(await importOriginal()),
  checkProcessInstance: async () => 'unverified',
}));

const { stopDaemon, daemonStatus } = await import('../../src/daemon.ts');
const { stopPtyHost } = await import('../../src/pty-host.ts');

describe('PID vivant mais non identifiable : jamais tué', () => {
  let repo;
  let stranger;

  beforeEach(async () => {
    repo = await createTempRepo();
    await initStriart(repo.root);
    stranger = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1e9)'], { stdio: 'ignore' });
    const deadline = Date.now() + 5000;
    while (!isProcessAlive(stranger.pid) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  });

  afterEach(async () => {
    stranger?.kill();
    await repo.cleanup();
  });

  // Avant : `unverified` comptait comme vivant… puis --stop le tuait.
  it('daemon : DAEMON_IDENTITY_UNVERIFIED, process intact, PID file conservé', async () => {
    const pidFile = path.join(repo.root, '.striart', 'watch.pid');
    await writeFile(
      pidFile,
      JSON.stringify({ pid: stranger.pid, startedAt: new Date().toISOString() }),
    );
    expect(await daemonStatus({ root: repo.root, name: 'watch' })).toMatchObject({
      running: true,
      verified: false,
    });
    await expect(stopDaemon({ root: repo.root, name: 'watch' })).rejects.toMatchObject({
      code: 'DAEMON_IDENTITY_UNVERIFIED',
      kind: 'refusal',
    });
    expect(isProcessAlive(stranger.pid)).toBe(true);
    await expect(stat(pidFile)).resolves.toBeTruthy();
  });

  it('hôte de pty : laissé en place et signalé (untouched), jamais tué', async () => {
    // Pas forcément `.striart/pty/<agent>/` : `ptyHostStateDir` bascule sur un
    // dossier de repli (hors du dépôt) quand ce chemin naturel dépasse la
    // limite des sockets Unix — déterministe sur les runners macOS de CI.
    // Publier au chemin que `stopPtyHost` lit RÉELLEMENT, jamais un chemin
    // naturel codé en dur.
    const pidFile = ptyHostPidFilePath(repo.root, 'agent-a');
    const { mkdir } = await import('node:fs/promises');
    await mkdir(path.dirname(pidFile), { recursive: true });
    await writeFile(
      pidFile,
      JSON.stringify({ pid: stranger.pid, startedAt: new Date().toISOString() }),
    );
    expect(await stopPtyHost(repo.root, 'agent-a')).toMatchObject({
      stopped: false,
      untouched: 'unverified',
    });
    expect(isProcessAlive(stranger.pid)).toBe(true);
    await expect(stat(pidFile)).resolves.toBeTruthy();
  });
});

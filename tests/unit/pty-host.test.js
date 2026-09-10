import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { defaultShell, ensurePtyHost, ptyHostStatus, stopPtyHost } from '../../src/pty-host.ts';
import {
  connectWithRetry,
  seedAgentRegistry,
  waitFor,
  withRealPtySlot,
} from '../helpers/pty-test-utils.js';

const SHELL = defaultShell();
const ECHO_EOL = process.platform === 'win32' ? '\r\n' : '\n';

describe('pty-host', () => {
  let root;
  const agent = 'agent-host';

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'striart-pty-host-'));
    await seedAgentRegistry(root, agent);
  });

  afterEach(async () => {
    await stopPtyHost(root, agent).catch(() => {});
    await rm(root, { recursive: true, force: true }).catch(() => {});
    // même raison que pty-attach.test.js : laisse le temps à l'agent interne
    // de node-pty (bug amont connu, cf. roadmap Phase A) de se dissiper.
    await new Promise((resolve) => setTimeout(resolve, 400));
  });

  it(
    'démarre un hôte détaché, idempotent sur un second appel pour le même agent',
    () =>
      withRealPtySlot(async () => {
        const first = await ensurePtyHost(root, agent, { shell: SHELL, cwd: root });
        expect(first.started).toBe(true);
        expect(first.pid).toBeGreaterThan(0);

        const status = await ptyHostStatus(root, agent);
        expect(status.running).toBe(true);
        expect(status.pid).toBe(first.pid);

        const second = await ensurePtyHost(root, agent, { shell: SHELL, cwd: root });
        expect(second.started).toBe(false);
        expect(second.pid).toBe(first.pid); // même hôte, pas un second process
      }),
    45000,
  );

  it('refuse de démarrer un hôte pour un agent absent du registre (défense en profondeur)', async () => {
    await expect(
      ensurePtyHost(root, 'agent-jamais-enregistre', { shell: SHELL, cwd: root }),
    ).rejects.toMatchObject({ code: 'PTY_HOST_UNKNOWN_AGENT' });
  });

  it(
    "le pty de l'hôte est réellement joignable : commande initiale exécutée, atteignable par un attach client",
    () =>
      withRealPtySlot(async () => {
        await ensurePtyHost(root, agent, {
          shell: SHELL,
          cwd: root,
          initialCommand: 'echo MARQUEUR-HOTE-DETACHE',
        });

        let buffer = '';
        const conn = await connectWithRetry(root, agent, { onData: (text) => (buffer += text) });
        await waitFor(() => buffer.includes(`MARQUEUR-HOTE-DETACHE${ECHO_EOL}`));

        conn.close();
      }),
    45000,
  );

  it(
    'stopPtyHost termine le process hôte et retire le PID file',
    () =>
      withRealPtySlot(async () => {
        const { pid } = await ensurePtyHost(root, agent, { shell: SHELL, cwd: root });

        const result = await stopPtyHost(root, agent);
        expect(result.stopped).toBe(true);

        await waitFor(() => {
          try {
            process.kill(pid, 0);
            return false; // encore vivant
          } catch {
            return true; // mort
          }
        });

        const status = await ptyHostStatus(root, agent);
        expect(status.running).toBe(false);
        expect(status.stale).toBe(false); // PID file nettoyé, pas juste orphelin
      }),
    45000,
  );

  it('stopPtyHost est idempotent sans hôte vivant', async () => {
    const result = await stopPtyHost(root, agent);
    expect(result.stopped).toBe(false);
    expect(result.wasStale).toBe(false);
  });

  it("ptyHostStatus signale 'stale' un PID file dont le process est mort", async () => {
    const pidFile = path.join(root, '.striart', 'pty', agent, 'host.pid');
    await mkdir(path.dirname(pidFile), { recursive: true });
    await writeFile(
      pidFile,
      JSON.stringify({ pid: 999_999_999, startedAt: new Date().toISOString() }),
      'utf8',
    );

    const status = await ptyHostStatus(root, agent);
    expect(status.running).toBe(false);
    expect(status.stale).toBe(true);

    const content = await readFile(pidFile, 'utf8').catch(() => null);
    expect(content).not.toBeNull(); // ptyHostStatus lit, ne nettoie jamais lui-même
  });
});

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { isProcessAlive } from '../../src/process-tree.js';
import { ensurePtyHost, ptyHostStatus, stopPtyHost } from '../../src/pty-host.ts';
import {
  REAL_PTY_WAIT_MS,
  connectWithRetry,
  quietShell,
  seedAgentRegistry,
  waitFor,
  withRealPtySlot,
} from '../helpers/pty-test-utils.js';

// Shell SANS profil : ces tests portent sur l'hôte, pas sur le démarrage du
// profil PowerShell (cf. quietShell). Le démarrage du shell par défaut du
// produit, profil compris, a son propre test plus bas.
const { shell: SHELL, args: SHELL_ARGS } = quietShell();
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

  it('démarre un hôte détaché, idempotent sur un second appel pour le même agent', () =>
    withRealPtySlot(async () => {
      const first = await ensurePtyHost(root, agent, {
        shell: SHELL,
        args: SHELL_ARGS,
        cwd: root,
      });
      expect(first.started).toBe(true);
      expect(first.pid).toBeGreaterThan(0);

      const status = await ptyHostStatus(root, agent);
      expect(status.running).toBe(true);
      expect(status.pid).toBe(first.pid);

      const second = await ensurePtyHost(root, agent, {
        shell: SHELL,
        args: SHELL_ARGS,
        cwd: root,
      });
      expect(second.started).toBe(false);
      expect(second.pid).toBe(first.pid); // même hôte, pas un second process
    }));

  it('refuse de démarrer un hôte pour un agent absent du registre (défense en profondeur)', async () => {
    await expect(
      ensurePtyHost(root, 'agent-jamais-enregistre', { shell: SHELL, args: SHELL_ARGS, cwd: root }),
    ).rejects.toMatchObject({ code: 'PTY_HOST_UNKNOWN_AGENT' });
  });

  it("le pty de l'hôte est réellement joignable : commande initiale exécutée, atteignable par un attach client", () =>
    withRealPtySlot(async () => {
      await ensurePtyHost(root, agent, {
        shell: SHELL,
        args: SHELL_ARGS,
        cwd: root,
        initialCommand: 'echo MARQUEUR-HOTE-DETACHE',
      });

      let buffer = '';
      const conn = await connectWithRetry(root, agent, { onData: (text) => (buffer += text) });
      await waitFor(() => buffer.includes(`MARQUEUR-HOTE-DETACHE${ECHO_EOL}`), REAL_PTY_WAIT_MS);

      conn.close();
    }));

  // Seul test qui lance le shell par défaut du PRODUIT, profils compris
  // (aucun pty.shell/pty.shellArgs configuré). Budget volontairement large :
  // Windows PowerShell 5.1 charge les profils utilisateur puis ses modules —
  // mesuré 8,5-12,7 s sous charge (3-3,8 s avec -NoProfile). 75 s laisse une
  // marge de six fois la pire mesure, sous le budget de 90 s par test ; un
  // dépassement ici signale un vrai problème de démarrage du shell par défaut,
  // pas du bruit de charge. Séparé des autres tests pour que ce coût (et sa
  // fragilité potentielle) ne contamine aucune assertion sur l'hôte.
  const DEFAULT_SHELL_WAIT_MS = 75_000;
  it('le shell par défaut du produit (avec profil) démarre et exécute la commande initiale', () =>
    withRealPtySlot(async () => {
      await ensurePtyHost(root, agent, { cwd: root, initialCommand: 'echo MARQUEUR-SHELL-DEFAUT' });

      let buffer = '';
      const conn = await connectWithRetry(root, agent, { onData: (text) => (buffer += text) });
      await waitFor(
        () => buffer.includes(`MARQUEUR-SHELL-DEFAUT${ECHO_EOL}`),
        DEFAULT_SHELL_WAIT_MS,
      );
      conn.close();
    }));

  it('stopPtyHost termine le process hôte et retire le PID file', () =>
    withRealPtySlot(async () => {
      const { pid } = await ensurePtyHost(root, agent, {
        shell: SHELL,
        args: SHELL_ARGS,
        cwd: root,
      });

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
    }));

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

  // PID recyclé : un process étranger porte le numéro de l'hôte mort. Le
  // croire vivant bloquait `cleanClones` (SESSION_LIVE à vie) et
  // `ensurePtyHost` (aucun hôte relancé) ; `stopPtyHost` le tuait.
  it('ptyHostStatus : un PID vivant qui n’est pas un hôte de pty est stale, jamais tué', async () => {
    const stranger = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1e9)'], {
      stdio: 'ignore',
    });
    try {
      await waitFor(() => isProcessAlive(stranger.pid));
      const pidFile = path.join(root, '.striart', 'pty', agent, 'host.pid');
      await mkdir(path.dirname(pidFile), { recursive: true });
      await writeFile(
        pidFile,
        JSON.stringify({ pid: stranger.pid, startedAt: new Date().toISOString() }),
        'utf8',
      );
      const status = await ptyHostStatus(root, agent);
      expect(status).toMatchObject({ running: false, stale: true, pid: stranger.pid });
      const stopped = await stopPtyHost(root, agent);
      expect(stopped).toMatchObject({ stopped: false, wasStale: true });
      expect(isProcessAlive(stranger.pid)).toBe(true);
    } finally {
      stranger.kill();
    }
  });
});

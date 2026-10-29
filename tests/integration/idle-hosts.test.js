import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTempRepo } from '../helpers/temp-repo.js';
import { quietShell, withRealPtySlot } from '../helpers/pty-test-utils.js';
import { initStriart } from '../../src/init.ts';
import { createAgent, readRegistry } from '../../src/clone.ts';
import { runAutonomousTask } from '../../src/orchestrator.ts';
import { isProcessAlive } from '../../src/process-tree.ts';
import { acpHostStatus } from '../../src/acp/host.ts';
import { ensurePtyHost, ptyHostStatus, stopPtyHost } from '../../src/pty-host.ts';
import { ptyHostOutputFilePath, readPtyHostLastOutput } from '../../src/pty-host-state.ts';
import { sweepIdle } from '../../src/idle/sweep.ts';

/**
 * GC d'inactivité — fermeture des sessions portées par un HÔTE détaché (ACP,
 * terminal). Mêmes principes que idle-sweep.test.js : horloge virtuelle, vrais
 * process, clone conservé.
 */
const FAKE_ACP = fileURLToPath(new URL('../helpers/fake-acp-agent.cjs', import.meta.url));
const HOUR = 3_600_000;
const MIN = 60_000;
const FAST = { ackWaitMs: 4_000, exitWaitMs: 15_000, termGraceMs: 2_000 };

async function waitFor(fn, timeoutMs = 25_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > deadline) throw new Error('condition non atteinte à temps');
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

describe('GC d’inactivité — sessions portées par un hôte (intégration)', () => {
  let repo;
  let userHome;
  const aborts = [];
  const sessions = [];

  async function configure(idle, extra = {}) {
    await writeFile(
      path.join(repo.root, '.striartrc.json'),
      JSON.stringify({
        agentProfiles: {
          'fake-acp': { command: process.execPath, args: [FAKE_ACP], acp: true },
        },
        testCommand: 'node -e "process.exit(0)"',
        idle,
        ...extra,
      }),
    );
    await writeFile(
      path.join(userHome, 'config.json'),
      JSON.stringify({ idle: { closeRoots: [repo.root] } }),
    );
  }

  beforeEach(async () => {
    repo = await createTempRepo();
    await initStriart(repo.root);
    userHome = await mkdtemp(path.join(os.tmpdir(), 'striart-userhome-'));
    process.env.STRIART_CONFIG_HOME = userHome;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ response: JSON.stringify({ files: [] }) }),
      })),
    );
  });

  afterEach(async () => {
    for (const ac of aborts.splice(0)) ac.abort();
    await Promise.allSettled(sessions.splice(0));
    delete process.env.FAKE_ACP_MODE;
    delete process.env.STRIART_CONFIG_HOME;
    vi.unstubAllGlobals();
    await rm(userHome, { recursive: true, force: true }).catch(() => undefined);
    await repo.cleanup();
  });

  it('session ACP (hôte détaché) inactive : avertie puis fermée par l’arrêt propre de l’hôte ; clone conservé', async () => {
    await configure({ action: 'close' });
    process.env.FAKE_ACP_MODE = 'hang';
    const ac = new AbortController();
    aborts.push(ac);
    const promise = runAutonomousTask({
      root: repo.root,
      agent: 'agent-acp',
      prompt: 'tâche ACP qui traîne',
      profile: 'fake-acp',
      signal: ac.signal,
    });
    sessions.push(promise);
    const host = await waitFor(async () => {
      const s = await acpHostStatus(repo.root, 'agent-acp', { fresh: true });
      const meta = (await readRegistry(repo.root))['agent-acp'];
      return s.running && s.listening && meta?.sessionPid === s.pid ? s : null;
    });

    const t0 = Date.now() + 3 * HOUR;
    const first = await sweepIdle({ root: repo.root, now: t0, timings: FAST });
    expect(first.agents[0]).toMatchObject({ host: 'acp', session: 'live', state: 'idle' });
    expect(first.warned).toEqual(['agent-acp']);
    expect(isProcessAlive(host.pid)).toBe(true);

    const second = await sweepIdle({ root: repo.root, now: t0 + 6 * MIN, timings: FAST });
    expect(second.closed).toEqual([{ agent: 'agent-acp', host: 'acp', code: 'CLOSED' }]);
    await waitFor(() => !isProcessAlive(host.pid));

    const result = await promise;
    expect(result.cleaned).toBe(false);
    expect((await readRegistry(repo.root))['agent-acp']).toBeTruthy();
    expect(await stat(result.clonePath)).toBeTruthy();
  });

  describe('terminal (hôte de pty)', () => {
    const { shell, args } = quietShell();

    async function openTerminal() {
      const meta = await createAgent({ root: repo.root, name: 'agent-t', mode: 'attended' });
      const { pid } = await ensurePtyHost(repo.root, 'agent-t', { shell, args, cwd: meta.path });
      return { meta, pid };
    }

    afterEach(async () => {
      await stopPtyHost(repo.root, 'agent-t').catch(() => undefined);
    });

    /** Attend que l'hôte natif ait publié sa dernière sortie (le shell écrit son invite). */
    const publishedOutput = (pid) =>
      waitFor(() => readPtyHostLastOutput(repo.root, 'agent-t', pid), 30_000);

    it('sortie inobservable (hôte qui ne publie pas) : rapporté inactif mais JAMAIS fermé par défaut (closePty: false)', () =>
      withRealPtySlot(async () => {
        await configure({ action: 'close' });
        const { pid } = await openTerminal();
        // Hôte d'une version antérieure : aucun `host.output`. Retiré après sa première publication
        // (le shell est silencieux ensuite, rien ne le réécrit).
        await publishedOutput(pid);
        await rm(ptyHostOutputFilePath(repo.root, 'agent-t'), { force: true });
        const t0 = Date.now() + 3 * HOUR;
        await sweepIdle({ root: repo.root, now: t0, timings: FAST });
        const report = await sweepIdle({ root: repo.root, now: t0 + 6 * MIN, timings: FAST });
        expect(report.agents[0]).toMatchObject({ host: 'pty', session: 'live', state: 'idle' });
        expect(report.agents[0].closeBlockedBy).toContain('PTY_OUTPUT_UNOBSERVABLE');
        expect(report.closed).toEqual([]);
        expect(isProcessAlive(pid)).toBe(true);
        expect((await ptyHostStatus(repo.root, 'agent-t')).running).toBe(true);
      }));

    it('dernière sortie PUBLIÉE par l’hôte natif : fermé après avertissement et grâce, SANS closePty', () =>
      withRealPtySlot(async () => {
        await configure({ action: 'close' });
        const { meta, pid } = await openTerminal();
        const published = await publishedOutput(pid);
        expect(published).toBeGreaterThan(Date.now() - 60_000);
        const t0 = Date.now() + 3 * HOUR;
        const first = await sweepIdle({ root: repo.root, now: t0, timings: FAST });
        expect(first.agents[0]).toMatchObject({ host: 'pty', session: 'live', state: 'idle' });
        expect(first.agents[0].signals).toContainEqual(
          expect.objectContaining({ name: 'sessionOutput', status: 'known' }),
        );
        expect(first.warned).toEqual(['agent-t']);
        const report = await sweepIdle({ root: repo.root, now: t0 + 6 * MIN, timings: FAST });
        expect(report.closed).toEqual([{ agent: 'agent-t', host: 'pty', code: 'CLOSED' }]);
        await waitFor(() => !isProcessAlive(pid));
        expect(await stat(meta.path)).toBeTruthy();
        expect((await readRegistry(repo.root))['agent-t']).toBeTruthy();
      }));

    it('sortie publiée mais RÉCENTE (horloge réelle) : l’agent reste actif, rien n’est fermé', () =>
      withRealPtySlot(async () => {
        await configure({ action: 'close' });
        const { pid } = await openTerminal();
        await publishedOutput(pid);
        const report = await sweepIdle({
          root: repo.root,
          now: Date.now() + 2 * MIN,
          timings: FAST,
        });
        expect(report.agents[0]).toMatchObject({ host: 'pty', state: 'active' });
        expect(report.closed).toEqual([]);
        expect(isProcessAlive(pid)).toBe(true);
      }));

    it('closePty: true (relâchement explicite) : l’hôte est arrêté proprement, clone conservé', () =>
      withRealPtySlot(async () => {
        await configure({ action: 'close', closePty: true });
        const { meta, pid } = await openTerminal();
        const t0 = Date.now() + 3 * HOUR;
        await sweepIdle({ root: repo.root, now: t0, timings: FAST });
        const report = await sweepIdle({ root: repo.root, now: t0 + 6 * MIN, timings: FAST });
        expect(report.closed).toEqual([{ agent: 'agent-t', host: 'pty', code: 'CLOSED' }]);
        await waitFor(() => !isProcessAlive(pid));
        expect(await stat(meta.path)).toBeTruthy();
        expect((await readRegistry(repo.root))['agent-t']).toBeTruthy();
      }));
  });
});

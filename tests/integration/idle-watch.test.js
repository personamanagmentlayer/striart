import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTempRepo } from '../helpers/temp-repo.js';
import { initStriart } from '../../src/init.js';
import { readRegistry } from '../../src/clone.js';
import { runAutonomousTask } from '../../src/orchestrator.js';
import { isProcessAlive } from '../../src/process-tree.js';
import { startWatchLoop } from '../../src/watch-loop.ts';
import { outputBeatPath } from '../../src/idle/paths.ts';

/**
 * `striart watch` : balayage d'inactivité périodique, hors chaîne de merge. Horloge
 * virtuelle injectée (prise de test `idleSweep`) pour franchir avertissement et grâce.
 */
const FAKE_AGENT = fileURLToPath(new URL('../helpers/fake-agent.cjs', import.meta.url));
const HOUR = 3_600_000;
const MIN = 60_000;

async function waitFor(fn, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > deadline) throw new Error('condition non atteinte à temps');
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

describe('watch — balayage d’inactivité (intégration)', () => {
  let repo;
  let userHome;
  let loop;
  const aborts = [];
  const sessions = [];

  async function configure(idle) {
    await writeFile(
      path.join(repo.root, '.striartrc.json'),
      JSON.stringify({
        agentProfiles: { fake: { command: process.execPath, args: [FAKE_AGENT, '{{prompt}}'] } },
        testCommand: 'node -e "process.exit(0)"',
        // fetchIntervalMs: 0 coupe le fetch silencieux et la réconciliation : seul le GC tourne.
        fetchIntervalMs: 0,
        idle,
      }),
    );
    await writeFile(
      path.join(userHome, 'config.json'),
      JSON.stringify({ idle: { closeRoots: [repo.root] } }),
    );
  }

  async function startHangingSession() {
    process.env.FAKE_AGENT_MODE = 'hang';
    const ac = new AbortController();
    aborts.push(ac);
    const promise = runAutonomousTask({
      root: repo.root,
      agent: 'agent-a',
      prompt: 'tâche qui traîne',
      profile: 'fake',
      signal: ac.signal,
    });
    sessions.push(promise);
    const meta = await waitFor(async () => {
      const m = (await readRegistry(repo.root))['agent-a'];
      return m?.sessionPid &&
        m.sessionOwnerPid &&
        (await stat(outputBeatPath(repo.root, 'agent-a')).catch(() => null))
        ? m
        : null;
    });
    return { meta, promise };
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
    await loop?.stop({ drain: true }).catch(() => undefined);
    loop = null;
    for (const ac of aborts.splice(0)) ac.abort();
    await Promise.allSettled(sessions.splice(0));
    delete process.env.FAKE_AGENT_MODE;
    delete process.env.STRIART_CONFIG_HOME;
    vi.unstubAllGlobals();
    await rm(userHome, { recursive: true, force: true }).catch(() => undefined);
    await repo.cleanup();
  });

  it('avertit puis ferme la session inactive, via des événements typés de la boucle', async () => {
    await configure({ action: 'close' });
    const { meta, promise } = await startHangingSession();
    let clock = Date.now() + 3 * HOUR;
    const events = [];
    loop = await startWatchLoop({
      root: repo.root,
      merge: false,
      usePolling: true,
      onEvent: (event) => events.push(event),
      idleSweep: { intervalMs: 400, now: () => clock },
    });

    await waitFor(() => events.find((e) => e.type === 'idle-warned'));
    expect(events.find((e) => e.type === 'idle-warned')).toMatchObject({
      agent: 'agent-a',
      willClose: true,
    });
    expect(isProcessAlive(meta.sessionPid)).toBe(true);
    expect(events.some((e) => e.type === 'idle-closed')).toBe(false);

    clock += 6 * MIN; // la grâce est écoulée
    await waitFor(() => events.find((e) => e.type === 'idle-closed'));
    expect(events.find((e) => e.type === 'idle-closed')).toMatchObject({
      agent: 'agent-a',
      host: 'process',
      code: 'CLOSED',
    });
    await waitFor(() => !isProcessAlive(meta.sessionPid));
    expect((await promise).cleaned).toBe(false);
    expect(events.some((e) => e.type === 'idle-error')).toBe(false);
  });

  it('idle.enabled: false : aucun balayage, aucun événement', async () => {
    await configure({ enabled: false, action: 'close' });
    const { meta } = await startHangingSession();
    const events = [];
    loop = await startWatchLoop({
      root: repo.root,
      merge: false,
      usePolling: true,
      onEvent: (event) => events.push(event),
      idleSweep: { intervalMs: 300, now: () => Date.now() + 3 * HOUR },
    });
    await new Promise((resolve) => setTimeout(resolve, 1500));
    expect(events.filter((e) => e.type.startsWith('idle-'))).toEqual([]);
    expect(isProcessAlive(meta.sessionPid)).toBe(true);
  });
});

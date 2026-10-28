/**
 * Filet à l'exécution, avec de VRAIS clones : deux agents qui touchent le même
 * fichier non prédit → signal ; session vivante → aucun rebase ; agents disjoints
 * → aucun bruit ; coût git borné et mesuré.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { simpleGit } from 'simple-git';
import { createTempRepo } from '../helpers/temp-repo.js';
import { initStriart } from '../../src/init.js';
import { createAgent, readRegistry, updateAgentMeta } from '../../src/clone.js';
import { onStriartEvent } from '../../src/events.js';
import { loadConfig } from '../../src/config.js';
import { collectStatus } from '../../src/status.ts';
import { collectControlState } from '../../src/control/state.ts';
import { createOverlapMonitor, observeOverlaps, resetOverlapCache } from '../../src/overlap.ts';
import { startWatchLoop } from '../../src/watch-loop.ts';

const GATE_OK = 'node -e "process.exit(0)"';

const setConfig = (root, config) =>
  writeFile(path.join(root, '.striartrc.json'), JSON.stringify(config));

async function commitInAgent(info, fileName, content, message = `feat: ${fileName}`) {
  const git = simpleGit(info.path);
  await git.addConfig('user.name', 'Agent');
  await git.addConfig('user.email', 'agent@example.com');
  await writeFile(path.join(info.path, fileName), content);
  await git.add([fileName]);
  await git.commit(message);
}

async function commitInMain(repo, fileName, content) {
  await writeFile(path.join(repo.root, fileName), content);
  await repo.git.add([fileName]);
  await repo.git.commit(`feat: ${fileName} (main)`);
}

describe('chevauchement observé (intégration)', () => {
  let repo;
  let events;
  let off;

  beforeEach(async () => {
    resetOverlapCache();
    repo = await createTempRepo();
    await initStriart(repo.root);
    await setConfig(repo.root, { testCommand: GATE_OK, fetchIntervalMs: 0 });
    events = [];
    off = onStriartEvent((_c, e) => {
      if (e.type.startsWith('overlap:')) events.push(e);
    });
  });

  afterEach(async () => {
    off();
    await repo.cleanup();
  });

  const monitor = async (extra = {}) =>
    createOverlapMonitor({
      root: repo.root,
      config: await loadConfig(repo.root),
      allowSync: true,
      ...extra,
    });

  it('deux agents touchent le même fichier NON prédit → signal, événement, coût borné', async () => {
    const a = await createAgent({ root: repo.root, name: 'agent-a', predictedFiles: ['src/a.js'] });
    const b = await createAgent({ root: repo.root, name: 'agent-b', predictedFiles: ['src/b.js'] });
    await commitInAgent(a, 'shared-hidden.js', 'export const a = 1;\n');
    await commitInAgent(b, 'shared-hidden.js', 'export const b = 2;\n');

    const m = await monitor();
    const { report, fresh } = await m.cycle();
    expect(report.overlaps).toHaveLength(1);
    expect(report.overlaps[0]).toMatchObject({
      kind: 'agents',
      agents: ['agent-a', 'agent-b'],
      files: ['shared-hidden.js'],
    });
    expect(fresh).toHaveLength(1);
    expect(events.filter((e) => e.type === 'overlap:observed')).toHaveLength(1);
    expect(events[0].message).toContain('shared-hidden.js');
    // Coût : 1 rev-parse cible + 3 appels au plus par agent, sous le plafond.
    expect(report.cost.gitCalls).toBeLessThanOrEqual(1 + 3 * 2);
    expect(report.cost.gitCalls).toBeLessThanOrEqual(report.cost.budget);
    expect(report.coverage).toEqual({ committed: true, uncommitted: false });

    // Cycle suivant sans changement : même signal, PAS de nouvel événement, cache servi.
    const again = await m.cycle();
    expect(again.fresh).toEqual([]);
    expect(events.filter((e) => e.type === 'overlap:observed')).toHaveLength(1);
    expect(again.report.cost.cacheHits).toBe(2);
    expect(again.report.cost.gitCalls).toBe(1 + 2); // rev-parse cible + un HEAD par agent
  });

  it('agents disjoints : aucun signal, aucun événement', async () => {
    const a = await createAgent({ root: repo.root, name: 'agent-a' });
    const b = await createAgent({ root: repo.root, name: 'agent-b' });
    await commitInAgent(a, 'only-a.js', 'a\n');
    await commitInAgent(b, 'only-b.js', 'b\n');
    const { report, fresh, caughtUp } = await (await monitor()).cycle();
    expect(report.overlaps).toEqual([]);
    expect(fresh).toEqual([]);
    expect(caughtUp).toEqual([]);
    expect(events).toEqual([]);
  });

  it('tenue de livre commune (CHANGELOG, docs) : ignorée comme au Router', async () => {
    const a = await createAgent({ root: repo.root, name: 'agent-a' });
    const b = await createAgent({ root: repo.root, name: 'agent-b' });
    await commitInAgent(a, 'CHANGELOG.md', 'a\n');
    await commitInAgent(b, 'CHANGELOG.md', 'b\n');
    const { report } = await (await monitor()).cycle();
    expect(report.overlaps).toEqual([]);
    expect(report.ignoredShared).toBeGreaterThan(0);
  });

  it("sharedFiles: 'keep' : la tenue de livre redevient un fichier comme un autre", async () => {
    await setConfig(repo.root, {
      testCommand: GATE_OK,
      fetchIntervalMs: 0,
      tokens: { router: { sharedFiles: { mode: 'keep' } } },
    });
    const a = await createAgent({ root: repo.root, name: 'agent-a' });
    const b = await createAgent({ root: repo.root, name: 'agent-b' });
    await commitInAgent(a, 'CHANGELOG.md', 'a\n');
    await commitInAgent(b, 'CHANGELOG.md', 'b\n');
    const { report } = await (await monitor()).cycle();
    expect(report.overlaps).toHaveLength(1);
  });

  it('la cible avance sur un fichier que l’agent touche → signal « target » puis rebase anticipé', async () => {
    const a = await createAgent({ root: repo.root, name: 'agent-a' });
    await commitInAgent(a, 'lib.js', 'agent\n');
    await commitInMain(repo, 'other.js', 'x\n'); // main avance, sans toucher lib.js
    expect((await (await monitor()).cycle()).report.overlaps).toEqual([]);

    await commitInMain(repo, 'lib.js', 'main\n'); // maintenant OUI
    const sync = vi.fn(async () => ({ status: 'REBASE_CONFLICT' }));
    const m = await monitor({ sync });
    const { report, caughtUp } = await m.cycle();
    expect(report.overlaps).toHaveLength(1);
    expect(report.overlaps[0]).toMatchObject({
      kind: 'target',
      agents: ['agent-a'],
      files: ['lib.js'],
    });
    expect(sync).toHaveBeenCalledTimes(1);
    expect(caughtUp).toEqual([{ agent: 'agent-a', status: 'REBASE_CONFLICT' }]);
    // Un conflit n'est pas retenté en boucle.
    await m.cycle();
    expect(sync).toHaveBeenCalledTimes(1);
  });

  it('rebase anticipé RÉEL : la primitive existante rebase un clone propre, jamais de merge', async () => {
    const a = await createAgent({ root: repo.root, name: 'agent-a' });
    await commitInAgent(a, 'lib.js', 'agent\n');
    await commitInMain(repo, 'lib2.js', 'x\n');
    await commitInMain(repo, 'lib.js', 'main\n');
    const mainBefore = (await repo.git.revparse(['HEAD'])).trim();
    const { caughtUp } = await (await monitor()).cycle();
    // Même fichier des deux côtés : rebase en conflit → annulé, pas de merge, main intact.
    expect(caughtUp).toHaveLength(1);
    expect(['REBASE_CONFLICT', 'REBASED']).toContain(caughtUp[0].status);
    expect((await repo.git.revparse(['HEAD'])).trim()).toBe(mainBefore);
    expect((await simpleGit(a.path).status()).isClean()).toBe(true);
  });

  it('SESSION VIVANTE : aucun rebase, aucun verrou pris, signal conservé', async () => {
    const a = await createAgent({ root: repo.root, name: 'agent-a' });
    await commitInAgent(a, 'lib.js', 'agent\n');
    await commitInMain(repo, 'lib.js', 'main\n');
    await updateAgentMeta(repo.root, 'agent-a', { sessionPid: process.pid });
    const sync = vi.fn();
    const m = await monitor({ sync });
    const first = await m.cycle();
    expect(sync).not.toHaveBeenCalled();
    expect(first.report.overlaps).toHaveLength(1);
    expect(first.caughtUp).toEqual([{ agent: 'agent-a', status: 'SKIPPED_SESSION' }]);
    // Répété : toujours rien, et pas re-signalé en boucle.
    const second = await m.cycle();
    expect(sync).not.toHaveBeenCalled();
    expect(second.caughtUp).toEqual([]);
    // Le clone n'a pas bougé.
    expect((await readRegistry(repo.root))['agent-a'].baseCommit).toBe(a.baseCommit);
  });

  it('watch --no-merge (allowSync: false) ou overlap.autoSync: false : jamais de rebase', async () => {
    const a = await createAgent({ root: repo.root, name: 'agent-a' });
    await commitInAgent(a, 'lib.js', 'agent\n');
    await commitInMain(repo, 'lib.js', 'main\n');
    const sync = vi.fn();
    const noMerge = await monitor({ sync, allowSync: false });
    expect((await noMerge.cycle()).report.overlaps).toHaveLength(1);
    await setConfig(repo.root, {
      testCommand: GATE_OK,
      fetchIntervalMs: 0,
      overlap: { autoSync: false },
    });
    const off2 = await monitor({ sync });
    await off2.cycle();
    expect(sync).not.toHaveBeenCalled();
  });

  it('overlap.enabled: false : aucune observation, zéro appel git', async () => {
    await setConfig(repo.root, {
      testCommand: GATE_OK,
      fetchIntervalMs: 0,
      overlap: { enabled: false },
    });
    const a = await createAgent({ root: repo.root, name: 'agent-a' });
    const b = await createAgent({ root: repo.root, name: 'agent-b' });
    await commitInAgent(a, 'x.js', 'a\n');
    await commitInAgent(b, 'x.js', 'b\n');
    const report = await observeOverlaps({ root: repo.root, config: await loadConfig(repo.root) });
    expect(report.overlaps).toEqual([]);
    expect(report.cost.gitCalls).toBe(0);
  });

  it('budget d’appels git : le surplus est DIFFÉRÉ et déclaré, jamais ignoré en silence', async () => {
    await setConfig(repo.root, {
      testCommand: GATE_OK,
      fetchIntervalMs: 0,
      overlap: { maxGitCalls: 4 },
    });
    for (const n of ['agent-a', 'agent-b', 'agent-c']) {
      const info = await createAgent({ root: repo.root, name: n });
      await commitInAgent(info, 'x.js', `${n}\n`);
    }
    const report = await observeOverlaps({ root: repo.root, config: await loadConfig(repo.root) });
    expect(report.cost.gitCalls).toBeLessThanOrEqual(4);
    expect(report.deferred.length).toBeGreaterThan(0);
    expect(report.agentsObserved + report.deferred.length).toBe(3);
  });

  it('les modifications NON commitées ne sont pas vues (limite déclarée)', async () => {
    const a = await createAgent({ root: repo.root, name: 'agent-a' });
    const b = await createAgent({ root: repo.root, name: 'agent-b' });
    await writeFile(path.join(a.path, 'wip.js'), 'a\n');
    await writeFile(path.join(b.path, 'wip.js'), 'b\n');
    const { report } = await (await monitor()).cycle();
    expect(report.overlaps).toEqual([]);
    expect(report.coverage.uncommitted).toBe(false);
  });

  it('status et Control Protocol portent le champ additif `overlaps`', async () => {
    const a = await createAgent({ root: repo.root, name: 'agent-a' });
    const b = await createAgent({ root: repo.root, name: 'agent-b' });
    await commitInAgent(a, 'x.js', 'a\n');
    await commitInAgent(b, 'x.js', 'b\n');
    const status = await collectStatus(repo.root);
    expect(status.overlaps.overlaps).toHaveLength(1);
    const state = await collectControlState(repo.root);
    expect(state.overlaps.overlaps).toHaveLength(1);
    expect(state.overlaps.cost.gitCalls).toBeGreaterThan(0);
  });

  it('boucle watch : le signal part sur le flux (événement `overlap`) sans merge', async () => {
    const a = await createAgent({ root: repo.root, name: 'agent-a' });
    const b = await createAgent({ root: repo.root, name: 'agent-b' });
    const seen = [];
    const loop = await startWatchLoop({
      root: repo.root,
      merge: false,
      usePolling: true,
      onEvent: (e) => seen.push(e),
    });
    try {
      await loop.ready;
      await commitInAgent(a, 'x.js', 'a\n');
      await commitInAgent(b, 'x.js', 'b\n');
      const deadline = Date.now() + 60_000;
      while (!seen.some((e) => e.type === 'overlap') && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 100));
      }
      const overlap = seen.find((e) => e.type === 'overlap');
      expect(overlap).toMatchObject({
        overlap: { kind: 'agents', agents: ['agent-a', 'agent-b'], files: ['x.js'] },
      });
      expect(seen.some((e) => e.type === 'merge')).toBe(false);
    } finally {
      await loop.stop();
    }
  });
});

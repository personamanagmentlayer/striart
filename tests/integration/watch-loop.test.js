import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { simpleGit } from 'simple-git';
import { createTempRepo } from '../helpers/temp-repo.js';
import { initStriart } from '../../src/init.js';
import { createAgent, updateAgentMeta } from '../../src/clone.js';
import { startWatchLoop } from '../../src/watch-loop.ts';

const GATE_OK = 'node -e "process.exit(0)"';

async function setConfig(root, config) {
  await writeFile(path.join(root, '.striartrc.json'), JSON.stringify(config));
}

async function commitInAgent(info, fileName, message) {
  const git = simpleGit(info.path);
  await git.addConfig('user.name', 'Agent');
  await git.addConfig('user.email', 'agent@example.com');
  await writeFile(path.join(info.path, fileName), `// ${message}\n`);
  await git.add([fileName]);
  await git.commit(message);
}

/** Attend qu'un événement satisfaisant `predicate` ait été émis. */
function waitForEvent(events, predicate, timeoutMs = 60_000) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const tick = () => {
      const found = events.find(predicate);
      if (found) return resolve(found);
      if (Date.now() > deadline)
        return reject(
          new Error(`événement attendu non reçu : ${JSON.stringify(events.map((e) => e.type))}`),
        );
      setTimeout(tick, 50);
    };
    tick();
  });
}

describe('startWatchLoop (intégration)', () => {
  let repo;
  let loop;

  beforeEach(async () => {
    repo = await createTempRepo();
    await initStriart(repo.root);
    // fetchIntervalMs: 0 → pas de fetch ni de réconciliation périodiques :
    // le test ne voit que les événements qu'il provoque.
    await setConfig(repo.root, { testCommand: GATE_OK, fetchIntervalMs: 0 });
  });

  afterEach(async () => {
    await loop?.stop();
    loop = null;
    await repo.cleanup();
  });

  it('un commit sur la branche de tâche déclenche commit → merge (MERGED), dans cet ordre', async () => {
    const agent = await createAgent({ root: repo.root, name: 'agent-a' });
    const events = [];
    loop = await startWatchLoop({
      root: repo.root,
      merge: true,
      usePolling: true,
      onEvent: (e) => events.push(e),
    });
    await loop.ready;
    expect(events[0]).toMatchObject({ type: 'started', merge: true });

    await commitInAgent(agent, 'a.js', 'feat: a');
    const merged = await waitForEvent(events, (e) => e.type === 'merge');
    expect(merged.result).toMatchObject({ status: 'MERGED', agent: 'agent-a' });
    const types = events.map((e) => e.type);
    expect(types.indexOf('commit')).toBeLessThan(types.indexOf('merge'));
  });

  it('--no-merge : les commits sont signalés, jamais mergés', async () => {
    const agent = await createAgent({ root: repo.root, name: 'agent-a' });
    const events = [];
    loop = await startWatchLoop({
      root: repo.root,
      merge: false,
      usePolling: true,
      onEvent: (e) => events.push(e),
    });
    await loop.ready;
    await commitInAgent(agent, 'b.js', 'feat: b');
    await waitForEvent(events, (e) => e.type === 'commit');
    await loop.stop();
    expect(events.some((e) => e.type === 'merge')).toBe(false);
  });

  it('un agent autonome n’est pas mergé par le watcher (sa fin de cycle s’en charge)', async () => {
    const agent = await createAgent({
      root: repo.root,
      name: 'agent-auto',
      mode: 'autonomous',
      profile: 'x',
    });
    await updateAgentMeta(repo.root, 'agent-auto', { mode: 'autonomous' });
    const events = [];
    loop = await startWatchLoop({
      root: repo.root,
      merge: true,
      usePolling: true,
      onEvent: (e) => events.push(e),
    });
    await loop.ready;
    await commitInAgent(agent, 'c.js', 'feat: c');
    const skipped = await waitForEvent(events, (e) => e.type === 'merge-skipped');
    expect(skipped).toMatchObject({ agent: 'agent-auto', reason: 'autonomous' });
  });

  it('stop() : plus aucun événement après l’arrêt', async () => {
    const agent = await createAgent({ root: repo.root, name: 'agent-a' });
    const events = [];
    loop = await startWatchLoop({
      root: repo.root,
      merge: false,
      usePolling: true,
      onEvent: (e) => events.push(e),
    });
    await loop.ready;
    await loop.stop();
    const count = events.length;
    await commitInAgent(agent, 'd.js', 'feat: d');
    await new Promise((resolve) => setTimeout(resolve, 1500));
    expect(events).toHaveLength(count);
    expect(loop.isBusy()).toBe(false);
  });
});

describe('startWatchLoop : arrêt pendant un merge (intégration)', () => {
  let repo;
  let loop;

  beforeEach(async () => {
    repo = await createTempRepo();
    await initStriart(repo.root);
    // Gate lent : le premier merge est encore en vol quand l'arrêt tombe.
    await setConfig(repo.root, {
      testCommand: 'node -e "setTimeout(() => {}, 4000)"',
      fetchIntervalMs: 0,
    });
  });

  afterEach(async () => {
    await loop?.stop({ drain: false });
    loop = null;
    await repo.cleanup();
  });

  // Avant : stop() coupait l'émission tout de suite puis attendait TOUTE la
  // chaîne — chaque merge en file passait le Test Gate après Ctrl+C, sans
  // qu'aucun résultat soit rapporté.
  it('termine et rapporte l’opération en vol ; les merges en file ne partent pas et sont signalés', async () => {
    const a = await createAgent({ root: repo.root, name: 'agent-a' });
    const b = await createAgent({ root: repo.root, name: 'agent-b' });
    const events = [];
    loop = await startWatchLoop({
      root: repo.root,
      merge: true,
      usePolling: true,
      onEvent: (e) => events.push(e),
    });
    await loop.ready;
    await commitInAgent(a, 'a.js', 'feat: a');
    await waitForEvent(events, (e) => e.type === 'commit' && e.agent === 'agent-a');
    await commitInAgent(b, 'b.js', 'feat: b');
    await waitForEvent(events, (e) => e.type === 'commit' && e.agent === 'agent-b');
    expect(loop.isBusy()).toBe(true);

    await loop.stop();

    const merges = events.filter((e) => e.type === 'merge');
    expect(merges).toHaveLength(1);
    expect(merges[0].result).toMatchObject({ status: 'MERGED', agent: 'agent-a' });
    expect(events).toContainEqual({ type: 'merge-deferred', agent: 'agent-b' });
    expect(loop.isBusy()).toBe(false);
    const log = await simpleGit(repo.root).log();
    expect(log.all.some((c) => c.message.includes('agent-b'))).toBe(false);
  });
});

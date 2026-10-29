import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createTempRepo } from '../helpers/temp-repo.js';
import { initStriart } from '../../src/init.ts';
import { ControlHub } from '../../src/control/hub.ts';
import { createChangeFeed } from '../../src/mcp/change-feed.ts';
import { withStateLock } from '../../src/state-lock.ts';
import { striartDir } from '../../src/paths.ts';

const settle = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Bruit d'infrastructure : verrou d'état, cassure, file du verrou, suppression en cours. */
async function makeNoise(root) {
  const dir = striartDir(root);
  await withStateLock(dir, async () => {});
  await writeFile(path.join(dir, 'state.lock.break'), 'x');
  await rm(path.join(dir, 'state.lock.break'), { force: true });
  await mkdir(path.join(dir, 'removing'), { recursive: true });
  await writeFile(path.join(dir, 'removing', 'agent-a.json'), '{}');
  await mkdir(path.join(dir, 'lock-queue'), { recursive: true });
  await writeFile(path.join(dir, 'lock-queue', '0001.json'), '{}');
}

describe('watchers de .striart/ — le bruit des verrous ne rafraîchit rien (intégration)', () => {
  let repo;
  beforeEach(async () => {
    repo = await createTempRepo();
    await initStriart(repo.root);
  });
  afterEach(async () => {
    await repo.cleanup();
  });

  it('ControlHub : prise du verrou d’état, cassure, removing/ et lock-queue/ ne provoquent aucune collecte', async () => {
    const hub = new ControlHub({ root: repo.root, debounceMs: 50, maxDelayMs: 200 });
    const transport = {
      policy: 'drop',
      write() {},
      bufferedBytes: () => 0,
      disconnect() {},
      onceDrained() {},
    };
    await hub.subscribe(transport, { initial: 'return' });
    await settle(600); // le watcher a fini son scan initial
    const before = hub.stats().collections;
    await makeNoise(repo.root);
    await settle(1200);
    expect(hub.stats().collections).toBe(before);
    // Contrôle positif : un vrai fichier d'état, lui, rafraîchit.
    await writeFile(path.join(striartDir(repo.root), 'state.json'), '{"manualMode":true}');
    await settle(1200);
    expect(hub.stats().collections).toBeGreaterThan(before);
    await hub.close();
  }, 30_000);

  it('flux de changements MCP : même bruit, aucun lot ; un fichier d’état réel produit un lot', async () => {
    const feed = createChangeFeed(repo.root, { debounceMs: 50 });
    const batches = [];
    const off = feed.subscribe((batch) => batches.push(batch));
    await settle(600);
    await makeNoise(repo.root);
    await settle(1200);
    // Les lots reçus accompagnent l'échec : quel chemin a déclenché le rafraîchissement ?
    expect(batches, JSON.stringify(batches)).toHaveLength(0);
    await writeFile(path.join(striartDir(repo.root), 'state.json'), '{"manualMode":true}');
    await settle(1200);
    expect(batches.length).toBeGreaterThan(0);
    off();
    await feed.close();
  }, 30_000);
});

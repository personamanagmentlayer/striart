import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { simpleGit } from 'simple-git';
import { createTempRepo } from '../helpers/temp-repo.js';
import { initStriart } from '../../src/init.js';
import { createAgent } from '../../src/clone.js';
import { watchAgents } from '../../src/watcher.js';

function waitForCommit(events, predicate, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Aucun événement de commit reçu en ${timeoutMs}ms`)),
      timeoutMs,
    );
    events.listeners.push((event) => {
      if (predicate(event)) {
        clearTimeout(timer);
        resolve(event);
      }
    });
  });
}

describe('watcher (intégration)', () => {
  let repo;
  let watcher;

  beforeEach(async () => {
    repo = await createTempRepo();
  });

  afterEach(async () => {
    if (watcher) await watcher.close();
    await repo.cleanup();
  });

  it('détecte un nouveau commit d’un agent', async () => {
    await initStriart(repo.root);
    const info = await createAgent({ root: repo.root, name: 'agent-a' });

    const events = { listeners: [] };
    watcher = watchAgents({
      root: repo.root,
      usePolling: true, // fiabilise le test cross-platform
      onCommit: (event) => events.listeners.forEach((l) => l(event)),
    });
    await new Promise((resolve) => watcher.on('ready', resolve));

    const pending = waitForCommit(events, (e) => e.agent === 'agent-a');

    const agentGit = simpleGit(info.path);
    await agentGit.addConfig('user.name', 'Agent A');
    await agentGit.addConfig('user.email', 'agent-a@example.com');
    await writeFile(path.join(info.path, 'new-file.js'), 'export {};\n');
    await agentGit.add(['new-file.js']);
    await agentGit.commit('feat: nouveau fichier');
    const expectedSha = (await agentGit.revparse(['HEAD'])).trim();

    const event = await pending;
    expect(event.agent).toBe('agent-a');
    expect(event.branch).toBe(info.branch);
    expect(event.sha).toBe(expectedSha);
  });

  it('déduplique : réécrire la même ref ne redéclenche pas de commit', async () => {
    await initStriart(repo.root);
    const info = await createAgent({ root: repo.root, name: 'agent-a' });

    const received = [];
    watcher = watchAgents({
      root: repo.root,
      usePolling: true,
      onCommit: (event) => received.push(event),
    });
    await new Promise((resolve) => watcher.on('ready', resolve));

    const agentGit = simpleGit(info.path);
    await agentGit.addConfig('user.name', 'Agent A');
    await agentGit.addConfig('user.email', 'agent-a@example.com');
    await writeFile(path.join(info.path, 'f.js'), 'export {};\n');
    await agentGit.add(['f.js']);
    await agentGit.commit('feat: f');
    const sha = (await agentGit.revparse(['HEAD'])).trim();

    // Attendre le premier événement.
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('premier événement jamais reçu')), 10000);
      const check = setInterval(() => {
        if (received.length > 0) {
          clearTimeout(t);
          clearInterval(check);
          resolve();
        }
      }, 100);
    });
    expect(received).toHaveLength(1);

    // Réécrire la même ref (même SHA) : touch sans nouveau commit.
    const refPath = received[0].refPath;
    await writeFile(refPath, `${sha}\n`);
    await new Promise((resolve) => setTimeout(resolve, 2000));

    expect(received).toHaveLength(1); // aucun événement dupliqué
  });
});

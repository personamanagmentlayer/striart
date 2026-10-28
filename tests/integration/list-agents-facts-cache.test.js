import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import path from 'node:path';
import { writeFile } from 'node:fs/promises';

const instances = vi.hoisted(() => ({ count: 0 }));
vi.mock('simple-git', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    simpleGit: (...args) => {
      instances.count += 1;
      return actual.simpleGit(...args);
    },
  };
});

const { createTempRepo } = await import('../helpers/temp-repo.js');
const { initStriart } = await import('../../src/init.js');
const { cloneGit, createAgent, listAgents, readRegistry } = await import('../../src/clone.js');

/**
 * Les faits git d'un clone sont mémoïsés par signature de références : tant
 * qu'ils sont servis par le cache, `listAgents` ne doit pas fabriquer d'instance
 * git (env copié, config) pour rien — le cockpit relit l'état à chaque
 * changement. Et le cache ne ment jamais : un commit change la signature.
 */
describe('listAgents — cache des faits git', () => {
  let repo;
  beforeEach(async () => {
    repo = await createTempRepo();
    await initStriart(repo.root);
  });
  afterEach(async () => {
    await repo.cleanup();
  });

  it('une lecture servie par le cache ne construit aucune instance git ; un nouveau commit est vu', async () => {
    for (const name of ['agent-a', 'agent-b', 'agent-c'])
      await createAgent({ root: repo.root, name, command: 'claude' });
    const first = await listAgents(repo.root);
    expect(first.map((a) => a.pendingCommits)).toEqual([0, 0, 0]);

    instances.count = 0;
    const second = await listAgents(repo.root);
    expect(instances.count).toBe(0);
    expect(second.map((a) => a.head)).toEqual(first.map((a) => a.head));

    const meta = (await readRegistry(repo.root))['agent-b'];
    const git = cloneGit(meta.path);
    await writeFile(path.join(meta.path, 'x.txt'), 'x\n');
    await git.add(['-A']);
    await git.commit('feat: x');

    instances.count = 0;
    const third = await listAgents(repo.root);
    // Seul le clone modifié relit git ; les autres restent servis par le cache.
    expect(instances.count).toBe(1);
    expect(third.find((a) => a.name === 'agent-b')).toMatchObject({
      pendingCommits: 1,
      lastMessage: 'feat: x',
    });
    expect(third.find((a) => a.name === 'agent-a')?.pendingCommits).toBe(0);
    expect(third.find((a) => a.name === 'agent-b')?.head).not.toBe(
      first.find((a) => a.name === 'agent-b')?.head,
    );
  });
});

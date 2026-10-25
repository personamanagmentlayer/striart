import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createTempRepo } from '../helpers/temp-repo.js';
import { initStriart } from '../../src/init.js';
import { readRegistry } from '../../src/clone.js';
import { runTask, startAgent } from '../../src/orchestrator.js';

async function setConfig(root, config) {
  await writeFile(path.join(root, '.striartrc.json'), JSON.stringify(config));
}

describe('startAgent (intégration)', () => {
  let repo;

  beforeEach(async () => {
    repo = await createTempRepo();
    await initStriart(repo.root);
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await repo.cleanup();
  });

  it('compose la config elle-même (secretPatterns, cloneFilter) et démarre l’agent', async () => {
    await setConfig(repo.root, { secretPatterns: ['.env'] });
    const info = await startAgent({ root: repo.root, name: 'agent-a', command: 'aider' });
    expect(info).toMatchObject({ name: 'agent-a', command: 'aider' });
    expect((await readRegistry(repo.root))['agent-a']).toBeDefined();
  });

  // Régression (audit CLI 2026-10-18) : avec une targetBranch inexistante,
  // `start` réussissait et c'est `merge` qui échouait, bien plus tard.
  it('targetBranch inexistante → UNKNOWN_BRANCH, aucun clone créé', async () => {
    await setConfig(repo.root, { targetBranch: 'nope' });
    await expect(startAgent({ root: repo.root, name: 'agent-a' })).rejects.toMatchObject({
      code: 'UNKNOWN_BRANCH',
    });
    await expect(stat(path.join(repo.root, '.striart', 'agents', 'agent-a'))).rejects.toThrow();
  });

  it('runTask refuse la même configuration AVANT d’appeler le Router (LLM)', async () => {
    await setConfig(repo.root, { targetBranch: 'nope' });
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    await expect(
      runTask({ root: repo.root, agent: 'agent-a', prompt: 'ajoute un test' }),
    ).rejects.toMatchObject({ code: 'UNKNOWN_BRANCH' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { simpleGit } from 'simple-git';
import { backdateDir, createTempRepo } from '../helpers/temp-repo.js';
import { initStriart } from '../../src/init.js';
import { createAgent, readRegistry, reuseAgent } from '../../src/clone.js';
import { runTask, stopAgent } from '../../src/orchestrator.js';

async function setConfig(root, config) {
  await writeFile(path.join(root, '.striartrc.json'), JSON.stringify(config));
}

/** Avance le main d'un commit et retourne son SHA. */
async function advanceMain(root, file, content) {
  const git = simpleGit(root);
  await writeFile(path.join(root, file), content);
  await git.add([file]);
  await git.commit(`feat: ${file}`);
  return (await git.revparse(['HEAD'])).trim();
}

describe('Réutilisation de clone (start --reuse)', () => {
  let repo;

  beforeEach(async () => {
    repo = await createTempRepo();
    await initStriart(repo.root);
    await setConfig(repo.root, { testCommand: 'node -e "process.exit(0)"' });
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await repo.cleanup();
  });

  /** Archive type : agent créé puis arrêté, clone conservé, vieilli d'une heure. */
  async function makeArchive(name = 'agent-a') {
    const info = await createAgent({ root: repo.root, name });
    await stopAgent({ root: repo.root, agent: name });
    await backdateDir(info.path);
    return info;
  }

  it('réhabilite une archive : resync sur le main courant, nouvelle branche, untracked conservés', async () => {
    const archive = await makeArchive();
    const oldBranch = archive.branch;
    // Trace d'une vie antérieure : un untracked (node_modules simulé) survit.
    await writeFile(path.join(archive.path, 'scratch.txt'), 'garder\n');
    // Le main avance APRÈS l'archivage : le reuse doit rattraper ce commit.
    const newMain = await advanceMain(repo.root, 'nouveau.js', 'export const n = 1;\n');
    await backdateDir(archive.path); // les écritures du test ne comptent pas comme présence

    const info = await reuseAgent({ root: repo.root, name: 'agent-a' });

    expect(info.reused).toBe(true);
    expect(info.baseCommit).toBe(newMain);
    expect(info.branch).not.toBe(oldBranch);
    expect(info.branch).toMatch(/^striart\/agent-a\/task-/);
    // Le worktree est bien sur le main courant…
    expect(await readFile(path.join(info.path, 'nouveau.js'), 'utf8')).toContain('n = 1');
    // …les untracked de l'ancienne vie sont toujours là (repartir chaud)…
    expect(await readFile(path.join(info.path, 'scratch.txt'), 'utf8')).toBe('garder\n');
    // …et l'agent est réenregistré.
    expect((await readRegistry(repo.root))['agent-a']).toMatchObject({ reused: true });
  });

  it('refuse un agent encore actif (AGENT_EXISTS) et une archive inexistante (REUSE_NO_CLONE)', async () => {
    await createAgent({ root: repo.root, name: 'agent-actif' });
    await expect(reuseAgent({ root: repo.root, name: 'agent-actif' })).rejects.toMatchObject({
      code: 'AGENT_EXISTS',
    });
    await expect(reuseAgent({ root: repo.root, name: 'agent-fantome' })).rejects.toMatchObject({
      code: 'REUSE_NO_CLONE',
    });
  });

  it('refuse une archive à activité disque récente (REUSE_IN_USE), heuristique contournable par force', async () => {
    const info = await createAgent({ root: repo.root, name: 'agent-a' });
    await stopAgent({ root: repo.root, agent: 'agent-a' });
    // Pas de backdate : le clone vient d'être écrit, il est "présent".
    await expect(reuseAgent({ root: repo.root, name: 'agent-a' })).rejects.toMatchObject({
      code: 'REUSE_IN_USE',
    });
    const reused = await reuseAgent({ root: repo.root, name: 'agent-a', force: true });
    expect(reused.path).toBe(info.path);
  });

  it('refuse de détruire du travail : non commité (REUSE_DIRTY) et commits hors main (REUSE_UNMERGED)', async () => {
    const archive = await makeArchive();

    // Travail non commité apparu dans l'archive.
    await writeFile(path.join(archive.path, 'README.md'), 'modifié après coup\n');
    await backdateDir(archive.path);
    await expect(reuseAgent({ root: repo.root, name: 'agent-a' })).rejects.toMatchObject({
      code: 'REUSE_DIRTY',
    });

    // Commit local absent du main : refusé aussi (il serait réécrit).
    const git = simpleGit(archive.path);
    await git.addConfig('user.name', 'Agent');
    await git.addConfig('user.email', 'agent@example.com');
    await git.add(['README.md']);
    await git.commit('travail orphelin');
    await backdateDir(archive.path);
    await expect(reuseAgent({ root: repo.root, name: 'agent-a' })).rejects.toMatchObject({
      code: 'REUSE_UNMERGED',
    });

    // force assume la perte : l'archive est réalignée sur le main.
    const info = await reuseAgent({ root: repo.root, name: 'agent-a', force: true });
    expect(info.reused).toBe(true);
    expect((await simpleGit(info.path).status()).isClean()).toBe(true);
  });

  it('runTask --reuse : exige un nom d’agent explicite (REUSE_NEEDS_AGENT), et la file mémorise reuse', async () => {
    await expect(
      runTask({ root: repo.root, prompt: 'tâche sans nom', reuse: true }),
    ).rejects.toMatchObject({ code: 'REUSE_NEEDS_AGENT' });

    // Collision volontaire : la tâche part en file AVEC son intention de reuse.
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ response: '{"files":["src/x.js"]}' }),
      }),
    );
    await runTask({ root: repo.root, agent: 'agent-un', prompt: 'tâche un' });
    const queued = await runTask({
      root: repo.root,
      agent: 'agent-deux',
      prompt: 'tâche deux',
      reuse: true,
    });
    expect(queued.status).toBe('QUEUED');
    expect(queued.task.reuse).toBe(true);
  });
});

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { simpleGit } from 'simple-git';
import { createTempRepo } from '../helpers/temp-repo.js';
import { initStriart } from '../../src/init.js';
import { createAgent, readRegistry } from '../../src/clone.js';
import { mergeAgentCommit, rollbackLastMerge } from '../../src/orchestrator.js';

const GATE_OK = 'node -e "process.exit(0)"';

async function setConfig(root, config) {
  await writeFile(path.join(root, '.striartrc.json'), JSON.stringify(config));
}

async function commitInAgent(info, fileName, content, message) {
  const git = simpleGit(info.path);
  await git.addConfig('user.name', 'Agent');
  await git.addConfig('user.email', 'agent@example.com');
  await writeFile(path.join(info.path, fileName), content);
  await git.add([fileName]);
  await git.commit(message);
  return (await git.revparse(['HEAD'])).trim();
}

describe('striart rollback (intégration)', () => {
  let repo;
  let agent;

  beforeEach(async () => {
    repo = await createTempRepo();
    await initStriart(repo.root);
    await setConfig(repo.root, { testCommand: GATE_OK });
    agent = await createAgent({ root: repo.root, name: 'agent-a' });
  });

  afterEach(async () => {
    await repo.cleanup();
  });

  it('merge local non poussé → reset, agent recalé, commits re-mergeables', async () => {
    const preMergeHead = (await repo.git.revparse(['HEAD'])).trim();
    const agentSha = await commitInAgent(agent, 'feature.js', 'export const f = 1;\n', 'feat: f');
    const merged = await mergeAgentCommit({ root: repo.root, agent: 'agent-a' });
    expect(merged.status).toBe('MERGED');

    const result = await rollbackLastMerge({ root: repo.root });

    expect(result).toMatchObject({
      status: 'ROLLED_BACK',
      mode: 'reset',
      agent: 'agent-a',
      agentResynced: true,
    });
    // La branche cible est revenue exactement à l'état pré-merge.
    expect((await repo.git.revparse(['HEAD'])).trim()).toBe(preMergeHead);
    await expect(readFile(path.join(repo.root, 'feature.js'), 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    });

    // Le pointeur de merge de l'agent est recalé : ses commits redeviennent
    // en attente, et un nouveau merge les reprend.
    const meta = (await readRegistry(repo.root))['agent-a'];
    expect(meta.lastMergedCommit).not.toBe(agentSha);
    const remerged = await mergeAgentCommit({ root: repo.root, agent: 'agent-a' });
    expect(remerged.status).toBe('MERGED');
    await expect(readFile(path.join(repo.root, 'feature.js'), 'utf8')).resolves.toContain('f = 1');
  });

  it('merge déjà poussé sur origin → revert, historique conservé', async () => {
    // Un vrai remote bare + autoPush : le merge part sur origin.
    const remoteDir = await mkdtemp(path.join(os.tmpdir(), 'striart-remote-'));
    await simpleGit(remoteDir).init(['--bare', '-b', 'main']);
    await repo.git.addRemote('origin', remoteDir);
    await setConfig(repo.root, { testCommand: GATE_OK, autoPush: true });

    try {
      await commitInAgent(agent, 'feature.js', 'export const f = 1;\n', 'feat: f');
      const merged = await mergeAgentCommit({ root: repo.root, agent: 'agent-a' });
      expect(merged.status).toBe('MERGED');
      expect(merged.pushError).toBeNull();
      const mergeSha = (await repo.git.revparse(['HEAD'])).trim();

      const result = await rollbackLastMerge({ root: repo.root });

      expect(result).toMatchObject({ status: 'ROLLED_BACK', mode: 'revert', agent: 'agent-a' });
      // Le merge poussé reste dans l'historique, un revert l'annule par-dessus.
      const log = await repo.git.log({ maxCount: 2 });
      expect(log.latest.message).toContain('Revert');
      expect(log.all[1].hash).toBe(mergeSha);
      await expect(readFile(path.join(repo.root, 'feature.js'), 'utf8')).rejects.toMatchObject({
        code: 'ENOENT',
      });
    } finally {
      await rm(remoteDir, { recursive: true, force: true, maxRetries: 5 });
    }
  });

  it("refuse si le dernier commit n'est pas un merge Striart", async () => {
    await writeFile(path.join(repo.root, 'human.js'), 'const h = 1;\n');
    await repo.git.add(['human.js']);
    await repo.git.commit('feat: commit humain');

    await expect(rollbackLastMerge({ root: repo.root })).rejects.toMatchObject({
      code: 'NOT_A_STRIART_MERGE',
    });
    // Rien n'a bougé.
    await expect(readFile(path.join(repo.root, 'human.js'), 'utf8')).resolves.toContain('h = 1');
  });

  it('refuse si le repo principal a des modifications en cours', async () => {
    await commitInAgent(agent, 'feature.js', 'export const f = 1;\n', 'feat: f');
    await mergeAgentCommit({ root: repo.root, agent: 'agent-a' });
    await writeFile(path.join(repo.root, 'feature.js'), 'export const f = 2; // WIP humain\n');

    await expect(rollbackLastMerge({ root: repo.root })).rejects.toMatchObject({
      code: 'MAIN_DIRTY',
    });
  });
});

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { simpleGit } from 'simple-git';
import { createTempRepo } from '../helpers/temp-repo.js';
import { initStriart } from '../../src/init.js';
import { createAgent } from '../../src/clone.js';
import { mergeAgentCommit, promoteStaging } from '../../src/orchestrator.js';

const GATE_OK = 'node -e "process.exit(0)"';
const GATE_KO = 'node -e "console.error(\'integration cassée\'); process.exit(1)"';
const STAGING = 'striart/staging';

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
}

describe('striart promote — pipeline staging → main (intégration)', () => {
  let repo;
  let agent;

  beforeEach(async () => {
    repo = await createTempRepo(); // branche main + commit initial
    await repo.git.checkoutLocalBranch(STAGING); // le staging part de main
    await initStriart(repo.root);
    await setConfig(repo.root, { testCommand: GATE_OK, targetBranch: STAGING, mainBranch: 'main' });
    agent = await createAgent({ root: repo.root, name: 'agent-a' });
  });

  afterEach(async () => {
    await repo.cleanup();
  });

  it('rien à promouvoir → UP_TO_DATE', async () => {
    const result = await promoteStaging({ root: repo.root });
    expect(result.status).toBe('UP_TO_DATE');
  });

  it('cycle complet : merge agent → staging, promote → main fast-forwardé', async () => {
    await commitInAgent(agent, 'feature.js', 'export const f = 1;\n', 'feat: f');
    const merged = await mergeAgentCommit({ root: repo.root, agent: 'agent-a' });
    expect(merged.status).toBe('MERGED');

    // Le merge est sur staging, main n'a pas bougé.
    const mainBefore = (await repo.git.revparse(['main'])).trim();
    const stagingHead = (await repo.git.revparse(['HEAD'])).trim();
    expect(mainBefore).not.toBe(stagingHead);

    const result = await promoteStaging({ root: repo.root });
    expect(result.status).toBe('PROMOTED');
    expect(result.commits).toBeGreaterThan(0);

    // main est exactement au niveau du staging, avec le fichier de l'agent.
    expect((await repo.git.revparse(['main'])).trim()).toBe(stagingHead);
    const shown = await repo.git.show(['main:feature.js']);
    expect(shown).toContain('f = 1');
  });

  it('gate global rouge → main intact + ticket, staging conservé sans --rollback', async () => {
    await commitInAgent(agent, 'feature.js', 'x\n', 'feat: f');
    await mergeAgentCommit({ root: repo.root, agent: 'agent-a' });
    await setConfig(repo.root, {
      testCommand: GATE_OK,
      promoteTestCommand: GATE_KO, // le gate local passait, l'intégration casse
      targetBranch: STAGING,
      mainBranch: 'main',
    });

    const mainBefore = (await repo.git.revparse(['main'])).trim();
    const stagingBefore = (await repo.git.revparse(['HEAD'])).trim();

    const result = await promoteStaging({ root: repo.root });
    expect(result.status).toBe('GATE_FAILED');
    expect(result.rolledBack).toBe(false);
    expect(result.ticket.reason).toBe('PROMOTION_GATE_FAILED');

    // main n'a pas bougé d'un poil, le staging non plus (analyse humaine possible).
    expect((await repo.git.revparse(['main'])).trim()).toBe(mainBefore);
    expect((await repo.git.revparse(['HEAD'])).trim()).toBe(stagingBefore);
    const log = await readFile(path.join(result.ticket.dir, 'test-output.log'), 'utf8');
    expect(log).toContain('integration cassée');
  });

  it('gate global rouge avec --rollback → staging remis au niveau de main', async () => {
    await commitInAgent(agent, 'feature.js', 'x\n', 'feat: f');
    await mergeAgentCommit({ root: repo.root, agent: 'agent-a' });
    await setConfig(repo.root, {
      testCommand: GATE_OK,
      promoteTestCommand: GATE_KO,
      targetBranch: STAGING,
      mainBranch: 'main',
    });

    const result = await promoteStaging({ root: repo.root, rollback: true });
    expect(result.status).toBe('GATE_FAILED');
    expect(result.rolledBack).toBe(true);
    expect((await repo.git.revparse(['HEAD'])).trim()).toBe(
      (await repo.git.revparse(['main'])).trim(),
    );
  });

  it('main ayant avancé hors pipeline → MAIN_DIVERGED, rien n’est touché', async () => {
    await commitInAgent(agent, 'feature.js', 'x\n', 'feat: f');
    await mergeAgentCommit({ root: repo.root, agent: 'agent-a' });

    // Quelqu'un commite directement sur main.
    await repo.git.checkout('main');
    await writeFile(path.join(repo.root, 'hotfix.js'), 'hotfix\n');
    await repo.git.add(['hotfix.js']);
    await repo.git.commit('fix: hotfix direct sur main');
    await repo.git.checkout(STAGING);

    await expect(promoteStaging({ root: repo.root })).rejects.toMatchObject({
      code: 'MAIN_DIVERGED',
    });
  });

  it('promotion désactivée sans mainBranch', async () => {
    await setConfig(repo.root, { testCommand: GATE_OK, targetBranch: STAGING });
    await expect(promoteStaging({ root: repo.root })).rejects.toMatchObject({
      code: 'PROMOTION_DISABLED',
    });
  });
});

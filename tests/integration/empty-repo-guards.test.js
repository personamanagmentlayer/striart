/**
 * Dépôt principal SANS commit (HEAD « non né ») : toute opération mutante qui
 * lit HEAD refuse par une erreur CLASSÉE et actionnable, jamais par le message
 * brut de git (`UNEXPECTED: fatal: ambiguous argument 'HEAD'`). Même refus que
 * `start` (UNKNOWN_BRANCH) ; une HEAD non née sur une AUTRE branche que
 * `targetBranch` est un TARGET_BRANCH_MISMATCH, pas une erreur de git.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { simpleGit } from 'simple-git';
import { createTempRepo } from '../helpers/temp-repo.js';
import { initStriart } from '../../src/init.ts';
import { createAgent } from '../../src/clone.ts';
import { mergeAgentCommit, promoteStaging, rollbackLastMerge } from '../../src/orchestrator.ts';

const GATE_OK = 'node -e "process.exit(0)"';

async function setConfig(root, config) {
  await writeFile(path.join(root, '.striartrc.json'), JSON.stringify(config));
}

describe('dépôt principal sans commit (intégration)', () => {
  let root;

  beforeEach(async () => {
    root = await mkdtemp(path.join(await realpath(os.tmpdir()), 'striart-empty-'));
    const git = simpleGit(root);
    await git.init(['-b', 'main']);
    await git.addConfig('user.name', 'Striart Test');
    await git.addConfig('user.email', 'striart-test@example.com');
    await initStriart(root);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true, maxRetries: 5 }).catch(() => {});
  });

  it('rollback : UNKNOWN_BRANCH classé, pas le message brut de git', async () => {
    await setConfig(root, { testCommand: GATE_OK });
    const error = await rollbackLastMerge({ root }).catch((e) => e);
    expect(error).toMatchObject({ code: 'UNKNOWN_BRANCH', kind: 'failure' });
    expect(error.details).toMatchObject({ branch: 'main', setting: 'targetBranch' });
    expect(error.message).not.toMatch(/ambiguous argument/);
  });

  it('promote (mainBranch configuré) : UNKNOWN_BRANCH classé', async () => {
    await setConfig(root, { testCommand: GATE_OK, targetBranch: 'staging', mainBranch: 'main' });
    const error = await promoteStaging({ root }).catch((e) => e);
    expect(error).toMatchObject({ code: 'UNKNOWN_BRANCH' });
    expect(error.message).not.toMatch(/ambiguous argument/);
  });

  it('promote --rollback : UNKNOWN_BRANCH classé', async () => {
    await setConfig(root, { testCommand: GATE_OK, targetBranch: 'staging', mainBranch: 'main' });
    const error = await promoteStaging({ root, rollback: true }).catch((e) => e);
    expect(error).toMatchObject({ code: 'UNKNOWN_BRANCH' });
  });
});

describe('HEAD non née sur une autre branche que targetBranch (intégration)', () => {
  let repo;

  beforeEach(async () => {
    repo = await createTempRepo();
    await initStriart(repo.root);
    await setConfig(repo.root, { testCommand: GATE_OK });
    const agent = await createAgent({ root: repo.root, name: 'agent-a' });
    const agentGit = simpleGit(agent.path);
    await agentGit.addConfig('user.name', 'Agent');
    await agentGit.addConfig('user.email', 'agent@example.com');
    await writeFile(path.join(agent.path, 'feature.js'), 'export const f = 1;\n');
    await agentGit.add(['feature.js']);
    await agentGit.commit('feat: f');
    // `main` existe toujours, mais HEAD pointe sur une branche orpheline vide.
    await repo.git.raw(['checkout', '--orphan', 'orpheline']);
    await repo.git.raw(['rm', '-rf', '--quiet', '.']);
  });

  afterEach(async () => {
    await repo.cleanup();
  });

  it('rollback : TARGET_BRANCH_MISMATCH classé', async () => {
    const error = await rollbackLastMerge({ root: repo.root }).catch((e) => e);
    expect(error).toMatchObject({ code: 'TARGET_BRANCH_MISMATCH' });
    expect(error.details).toMatchObject({ currentBranch: 'orpheline', expectedBranch: 'main' });
  });

  it('merge : TARGET_BRANCH_MISMATCH classé', async () => {
    const error = await mergeAgentCommit({ root: repo.root, agent: 'agent-a' }).catch((e) => e);
    expect(error).toMatchObject({ code: 'TARGET_BRANCH_MISMATCH' });
  });
});

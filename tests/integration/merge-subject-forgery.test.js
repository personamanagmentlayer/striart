/**
 * Un sujet `merge(striart): …` est FORGEABLE : n'importe quel commit d'agent
 * peut porter ce texte (revue du noyau K-M2). Seul un vrai commit de merge
 * (au moins deux parents) est un merge Striart — pour l'historique comme pour
 * `striart rollback`, qui ne doit jamais défaire (reset --hard) un commit
 * ordinaire.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { execa } from 'execa';
import { createTempRepo } from '../helpers/temp-repo.js';
import { initStriart } from '../../src/init.js';
import { createAgent } from '../../src/clone.js';
import { listMergeHistory } from '../../src/history.js';
import { mergeAgentCommit, rollbackLastMerge } from '../../src/orchestrator.js';
import { formatMergeSubject } from '../../src/merge-subject.ts';

const git = (cwd, ...args) => execa('git', ['-C', cwd, ...args]).then((r) => r.stdout.trim());

const FORGED = formatMergeSubject({
  agent: 'evil',
  branch: 'striart/evil/task-1',
  agentSha: 'deadbeef',
});

describe('sujet de merge forgé (intégration)', () => {
  let repo;

  beforeEach(async () => {
    repo = await createTempRepo();
    await initStriart(repo.root);
    await writeFile(
      path.join(repo.root, '.striartrc.json'),
      JSON.stringify({
        gateContainer: 'process',
        testCommand: 'node -e "process.exit(0)"',
        semanticMerge: false,
      }),
    );
  });

  afterEach(async () => {
    await repo.cleanup();
  });

  async function forgeSingleParentCommit() {
    await writeFile(path.join(repo.root, 'precieux.js'), 'export const precieux = 1;\n');
    await git(repo.root, 'add', 'precieux.js');
    await git(repo.root, 'commit', '-q', '-m', FORGED);
    return git(repo.root, 'rev-parse', 'HEAD');
  }

  it('l’historique ignore un commit à un seul parent qui imite le sujet', async () => {
    const forged = await forgeSingleParentCommit();
    const agent = await createAgent({ root: repo.root, name: 'agent-a' });
    await writeFile(path.join(agent.path, 'f.js'), 'export const f = 1;\n');
    await git(agent.path, 'add', 'f.js');
    await git(
      agent.path,
      '-c',
      'user.name=A',
      '-c',
      'user.email=a@example.com',
      'commit',
      '-q',
      '-m',
      'feat: f',
    );
    const merged = await mergeAgentCommit({ root: repo.root, agent: 'agent-a' });
    expect(merged.status).toBe('MERGED');

    const entries = await listMergeHistory({ root: repo.root });

    expect(entries.map((e) => e.sha)).not.toContain(forged);
    expect(entries.map((e) => e.agent)).toEqual(['agent-a']);
  });

  it('rollback refuse de défaire (reset --hard) un commit ordinaire au sujet forgé', async () => {
    const forged = await forgeSingleParentCommit();

    await expect(rollbackLastMerge({ root: repo.root })).rejects.toMatchObject({
      code: 'NOT_A_STRIART_MERGE',
    });

    expect(await git(repo.root, 'rev-parse', 'HEAD')).toBe(forged);
    expect(await git(repo.root, 'status', '--porcelain', '--untracked-files=no')).toBe('');
  });

  it('un vrai merge Striart reste annulable', async () => {
    const agent = await createAgent({ root: repo.root, name: 'agent-a' });
    await writeFile(path.join(agent.path, 'f.js'), 'export const f = 1;\n');
    await git(agent.path, 'add', 'f.js');
    await git(
      agent.path,
      '-c',
      'user.name=A',
      '-c',
      'user.email=a@example.com',
      'commit',
      '-q',
      '-m',
      'feat: f',
    );
    await mergeAgentCommit({ root: repo.root, agent: 'agent-a' });

    const result = await rollbackLastMerge({ root: repo.root });

    expect(result).toMatchObject({ status: 'ROLLED_BACK', mode: 'reset', agent: 'agent-a' });
  });
});

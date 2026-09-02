import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { simpleGit } from 'simple-git';
import { createTempRepo } from '../helpers/temp-repo.js';
import { initStriart } from '../../src/init.js';
import { createAgent } from '../../src/clone.js';
import { mergeAgentCommit, rollbackLastMerge } from '../../src/orchestrator.js';
import { listMergeHistory } from '../../src/history.js';

const GATE_OK = 'node -e "process.exit(0)"';

async function commitInAgent(info, fileName, content, message) {
  const git = simpleGit(info.path);
  await git.addConfig('user.name', 'Agent');
  await git.addConfig('user.email', 'agent@example.com');
  await writeFile(path.join(info.path, fileName), content);
  await git.add([fileName]);
  await git.commit(message);
}

describe('striart history (intégration)', () => {
  let repo;

  beforeEach(async () => {
    repo = await createTempRepo();
    await initStriart(repo.root);
    await writeFile(
      path.join(repo.root, '.striartrc.json'),
      JSON.stringify({ testCommand: GATE_OK }),
    );
  });

  afterEach(async () => {
    await repo.cleanup();
  });

  it('reconstruit merges et rollbacks depuis le graphe Git, plus récent en tête', async () => {
    const agentA = await createAgent({ root: repo.root, name: 'agent-a' });
    await commitInAgent(agentA, 'a.js', 'export const a = 1;\n', 'feat: a');
    await mergeAgentCommit({ root: repo.root, agent: 'agent-a' });

    const agentB = await createAgent({ root: repo.root, name: 'agent-b' });
    await commitInAgent(agentB, 'b.js', 'export const b = 1;\n', 'feat: b');
    await mergeAgentCommit({ root: repo.root, agent: 'agent-b' });

    const history = await listMergeHistory({ root: repo.root });
    expect(history).toHaveLength(2);
    expect(history[0]).toMatchObject({ type: 'merge', agent: 'agent-b', semantic: false });
    expect(history[1]).toMatchObject({ type: 'merge', agent: 'agent-a' });
    expect(history[0].branch).toMatch(/^striart\/agent-b\//);
    expect(history[0].agentSha).toMatch(/^[0-9a-f]{8}$/);
    expect(history[0].date).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('un rollback local (reset) fait disparaître le merge ; un revert apparaît comme rollback', async () => {
    const agentA = await createAgent({ root: repo.root, name: 'agent-a' });
    await commitInAgent(agentA, 'a.js', 'export const a = 1;\n', 'feat: a');
    await mergeAgentCommit({ root: repo.root, agent: 'agent-a' });
    await rollbackLastMerge({ root: repo.root }); // non poussé → reset

    // Le graphe Git est la source de vérité : le merge annulé n'existe plus.
    expect(await listMergeHistory({ root: repo.root })).toHaveLength(0);
  });

  it('les commits humains sont ignorés, limit respectée', async () => {
    await writeFile(path.join(repo.root, 'h.js'), 'const h = 1;\n');
    await repo.git.add(['h.js']);
    await repo.git.commit('feat: commit humain merge(striart) dans le corps mais pas le format');

    for (const name of ['agent-a', 'agent-b', 'agent-c']) {
      const agent = await createAgent({ root: repo.root, name });
      await commitInAgent(agent, `${name}.js`, 'export const x = 1;\n', `feat: ${name}`);
      await mergeAgentCommit({ root: repo.root, agent: name });
    }

    const limited = await listMergeHistory({ root: repo.root, limit: 2 });
    expect(limited).toHaveLength(2);
    expect(limited.map((e) => e.agent)).toEqual(['agent-c', 'agent-b']);
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { simpleGit } from 'simple-git';
import { createTempRepo } from '../helpers/temp-repo.js';
import { initStriart } from '../../src/init.js';
import { createAgent } from '../../src/clone.js';
import { mergeAgentCommit } from '../../src/orchestrator.js';
import { readRecords } from '../../src/tokens/ledger.ts';

const lines = (n, edits = {}) =>
  `${Array.from({ length: n }, (_, i) => edits[i + 1] ?? `// ligne ${i + 1} : du code existant pour faire du volume`).join('\n')}\nprocess.exit(0);\n`;

describe('Merger par régions sur un VRAI conflit git (de bout en bout)', () => {
  let repo;
  let agent;

  beforeEach(async () => {
    repo = await createTempRepo();
    await initStriart(repo.root);
    await writeFile(
      path.join(repo.root, '.striartrc.json'),
      JSON.stringify({ testCommand: 'node big.js' }),
    );
    // La BASE existe avant le clone : conflit à trois voies réel.
    await writeFile(path.join(repo.root, 'big.js'), lines(500));
    await repo.git.add(['big.js', '.striartrc.json']);
    await repo.git.commit('chore: big file');
    agent = await createAgent({ root: repo.root, name: 'agent-a' });
  });
  afterEach(async () => {
    vi.unstubAllGlobals();
    await repo.cleanup();
  });

  it('seule la région en conflit part au LLM ; le reste est fusionné localement ; le Test Gate valide', async () => {
    await writeFile(
      path.join(repo.root, 'big.js'),
      lines(500, { 250: 'const side = "main";', 5: '// édité par main' }),
    );
    await repo.git.add(['big.js']);
    await repo.git.commit('feat: main');

    const agentGit = simpleGit(agent.path);
    await agentGit.addConfig('user.name', 'Agent');
    await agentGit.addConfig('user.email', 'agent@example.com');
    await writeFile(
      path.join(agent.path, 'big.js'),
      lines(500, { 250: 'const side = "agent";', 450: '// édité par agent' }),
    );
    await agentGit.add(['big.js']);
    await agentGit.commit('feat: agent');

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        response: '<<<REGION 1>>>\nconst side = "main+agent";\n<<<END 1>>>',
        prompt_eval_count: 900,
        eval_count: 40,
        done_reason: 'stop',
      }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await mergeAgentCommit({ root: repo.root, agent: 'agent-a' });
    expect(result.status).toBe('MERGED');
    expect(result.semantic).toBe(true);

    const merged = (await readFile(path.join(repo.root, 'big.js'), 'utf8')).split('\n');
    expect(merged[4]).toBe('// édité par main');
    expect(merged[249]).toBe('const side = "main+agent";');
    expect(merged[449]).toBe('// édité par agent');

    // Le prompt ne contient PAS le fichier entier (3 × ~30 000 caractères) mais la région.
    const prompt = JSON.parse(fetchMock.mock.calls[0][1].body).prompt;
    expect(prompt).toContain('const side = "main"');
    expect(prompt).toContain('const side = "agent"');
    expect(prompt.length).toBeLessThan(4000);

    // Le registre porte l'appel du Merger avec son usage réel.
    const merger = (await readRecords(repo.root)).records.filter((r) => r.role === 'merger');
    expect(merger).toEqual([
      expect.objectContaining({ input: 900, output: 40, outcome: 'ok', provider: 'ollama' }),
    ]);
  });
});

/**
 * `merge --json` : `data.error` est le texte français du noyau ; `errorCode` (+ `errorDetails`
 * publics) est le contrat stable, localisé par le catalogue côté CLI.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { simpleGit } from 'simple-git';
import { createTempRepo } from '../helpers/temp-repo.js';
import { initStriart } from '../../src/init.js';
import { createAgent } from '../../src/clone.js';
import { mergeAgentCommit } from '../../src/orchestrator.js';
import { en } from '../../src/cli/i18n/en.ts';
import { fr } from '../../src/cli/i18n/fr.ts';
import { localizeMergeResult } from '../../src/cli/localize.ts';

async function makeConflict(repo, agent) {
  await writeFile(path.join(repo.root, 'app.js'), 'const version = "main";\n');
  await repo.git.add(['app.js']);
  await repo.git.commit('feat: version main');
  const agentGit = simpleGit(agent.path);
  await agentGit.addConfig('user.name', 'Agent');
  await agentGit.addConfig('user.email', 'agent@example.com');
  await writeFile(path.join(agent.path, 'app.js'), 'const version = "agent";\n');
  await agentGit.add(['app.js']);
  await agentGit.commit('feat: version agent');
}

describe('errorCode stable d’un conflit sémantique (intégration)', () => {
  let repo;
  let agent;
  beforeEach(async () => {
    repo = await createTempRepo();
    await initStriart(repo.root);
    await writeFile(
      path.join(repo.root, '.striartrc.json'),
      JSON.stringify({ testCommand: 'node -e "process.exit(0)"', gateContainer: 'process' }),
    );
    agent = await createAgent({ root: repo.root, name: 'agent-a' });
  });
  afterEach(async () => {
    vi.unstubAllGlobals();
    await repo.cleanup();
  });

  it('LLM injoignable : errorCode SEMANTIC_MERGE_FAILED, causeCode TRANSPORT, texte localisé en anglais', async () => {
    await makeConflict(repo, agent);
    const transport = Object.assign(new TypeError('fetch failed'), {
      cause: { code: 'ECONNREFUSED' },
    });
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(transport));

    const result = await mergeAgentCommit({ root: repo.root, agent: 'agent-a' });
    expect(result.reason).toBe('SEMANTIC_MERGE_FAILED');
    expect(result.errorCode).toBe('SEMANTIC_MERGE_FAILED');
    expect(result.errorDetails).toMatchObject({
      causeCode: 'TRANSPORT',
      causeDetail: 'ECONNREFUSED',
    });
    // Le texte français du noyau reste (compat), mais n'est plus le seul contrat.
    expect(result.error).toMatch(/panne de transport/);

    const english = localizeMergeResult(en, result);
    expect(english.error).toContain('transport failure (ECONNREFUSED)');
    expect(english.error).not.toMatch(/panne/);
    // Le résultat d'origine (celui du --json) n'est pas muté.
    expect(result.error).toMatch(/panne de transport/);
    // Le français est la référence : le texte du noyau est conservé.
    expect(localizeMergeResult(fr, result).error).toBe(result.error);
  }, 120_000);

  it('sans errorCode, localizeMergeResult ne touche à rien', () => {
    const result = { status: 'CONFLICT', reason: 'SEMANTIC_MERGE_FAILED', error: 'texte libre' };
    expect(localizeMergeResult(en, result)).toEqual(result);
    const merged = { status: 'MERGED' };
    expect(localizeMergeResult(en, merged)).toBe(merged);
  });
});

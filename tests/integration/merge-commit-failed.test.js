/**
 * Commit de merge refusé par git (hook pre-commit, identité) et intégrité de la
 * PREMIÈRE passe de fusion LLM (revue du noyau K-I4, K-I8).
 *
 *  - `mainGit.commit(...)` n'était pas gardé : un hook qui échoue laissait le
 *    principal « merging » avec une erreur brute. Le merge ouvert par
 *    l'opération est annulé et l'échec est nommé (MERGE_COMMIT_FAILED), pour le
 *    merge automatique comme pour la résolution manuelle (même chemin) ;
 *  - la première passe de fusion LLM contrôlait seulement le verrou : un merge
 *    annulé PENDANT l'appel LLM voyait quand même la fusion écrite dans le
 *    worktree du principal.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { execa } from 'execa';
import { createTempRepo } from '../helpers/temp-repo.js';
import { initStriart } from '../../src/init.js';
import { createAgent, readRegistry } from '../../src/clone.js';
import { applyTicketResolution, mergeAgentCommit } from '../../src/orchestrator.js';
import { listConflictTickets, prepareResolutionScaffold } from '../../src/conflicts.js';

const GATE_OK = 'node -e "process.exit(0)"';
const git = (cwd, ...args) => execa('git', ['-C', cwd, ...args]).then((r) => r.stdout.trim());

async function setConfig(root, config) {
  await writeFile(path.join(root, '.striartrc.json'), JSON.stringify(config));
}

async function commitIn(dir, fileName, content, message) {
  await writeFile(path.join(dir, fileName), content);
  await git(dir, 'add', fileName);
  await git(
    dir,
    '-c',
    'user.name=Agent',
    '-c',
    'user.email=a@example.com',
    'commit',
    '-q',
    '-m',
    message,
  );
  return git(dir, 'rev-parse', 'HEAD');
}

const HOOK = path.join('.git', 'hooks', 'pre-commit');
const installFailingHook = (root) =>
  // Mode exécutable : git IGNORE un hook sans le bit x sous POSIX (le test ne
  // vérifiait « hook en échec » que sous Windows).
  writeFile(path.join(root, HOOK), '#!/bin/sh\necho "hook: refus de test" >&2\nexit 1\n', {
    mode: 0o755,
  });
const removeHook = (root) => rm(path.join(root, HOOK), { force: true });

async function expectNotMerging(root) {
  await expect(stat(path.join(root, '.git', 'MERGE_HEAD'))).rejects.toMatchObject({
    code: 'ENOENT',
  });
  expect(await git(root, 'status', '--porcelain', '--untracked-files=no')).toBe('');
  await expect(stat(path.join(root, '.striart', 'merge-state-changed.json'))).rejects.toMatchObject(
    {
      code: 'ENOENT',
    },
  );
}

describe('commit de merge refusé par git (intégration)', () => {
  let repo;
  let agent;

  beforeEach(async () => {
    repo = await createTempRepo();
    await initStriart(repo.root);
    await setConfig(repo.root, {
      gateContainer: 'process',
      testCommand: GATE_OK,
      semanticMerge: false,
    });
    agent = await createAgent({ root: repo.root, name: 'agent-a' });
  });

  afterEach(async () => {
    await removeHook(repo.root);
    await repo.cleanup();
  });

  it('merge automatique : hook pre-commit en échec → COMMIT_HOOK_REJECTED (ticket), merge annulé, principal propre, rien d’enregistré ; relançable', async () => {
    await commitIn(agent.path, 'feature.js', 'export const f = 1;\n', 'feat: f');
    const before = await git(repo.root, 'rev-parse', 'HEAD');
    await installFailingHook(repo.root);

    const error = await mergeAgentCommit({ root: repo.root, agent: 'agent-a' }).catch((e) => e);

    expect(error).toMatchObject({ code: 'COMMIT_HOOK_REJECTED', kind: 'failure' });
    expect(error.hint).toMatch(/hook/i);
    expect(await git(repo.root, 'rev-parse', 'HEAD')).toBe(before);
    await expectNotMerging(repo.root);
    expect((await readRegistry(repo.root))['agent-a'].lastMergedCommit ?? null).toBeNull();

    // L'échec n'a rien empoisonné : hook retiré, le même merge aboutit.
    await removeHook(repo.root);
    const retry = await mergeAgentCommit({ root: repo.root, agent: 'agent-a' });
    expect(retry.status).toBe('MERGED');
  });

  it('résolution manuelle (même chemin) : hook en échec → COMMIT_HOOK_REJECTED, ticket toujours OUVERT, principal propre', async () => {
    await writeFile(path.join(repo.root, 'app.js'), 'const v = "main";\n');
    await git(repo.root, 'add', 'app.js');
    await git(repo.root, 'commit', '-q', '-m', 'feat: main');
    await commitIn(agent.path, 'app.js', 'const v = "agent";\n', 'feat: agent');
    const conflict = await mergeAgentCommit({ root: repo.root, agent: 'agent-a' });
    expect(conflict.status).toBe('CONFLICT');
    const ticketId = conflict.ticket.id;
    await prepareResolutionScaffold(repo.root, ticketId);
    const before = await git(repo.root, 'rev-parse', 'HEAD');
    await installFailingHook(repo.root);

    const error = await applyTicketResolution({ root: repo.root, ticketId }).catch((e) => e);

    expect(error).toMatchObject({ code: 'COMMIT_HOOK_REJECTED' });
    expect(await git(repo.root, 'rev-parse', 'HEAD')).toBe(before);
    await expectNotMerging(repo.root);
    // Le ticket d'origine reste intact : aucun nouveau ticket ne l'écrase.
    const open = await listConflictTickets(repo.root);
    expect(open.map((t) => t.id)).toContain(ticketId);
    expect(open.find((t) => t.id === ticketId)).toMatchObject({ reason: 'MERGE_CONFLICT' });

    await removeHook(repo.root);
    const retry = await applyTicketResolution({ root: repo.root, ticketId });
    expect(retry.status).toBe('MERGED');
  });
});

describe('première passe de fusion LLM — intégrité du merge (intégration)', () => {
  let repo;
  let agent;

  beforeEach(async () => {
    repo = await createTempRepo();
    await initStriart(repo.root);
    await setConfig(repo.root, {
      gateContainer: 'process',
      testCommand: GATE_OK,
      semanticMerge: true,
    });
    agent = await createAgent({ root: repo.root, name: 'agent-a' });
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await repo.cleanup();
  });

  it('merge annulé PENDANT l’appel LLM → MERGE_STATE_CHANGED, la fusion LLM n’est PAS écrite dans le principal', async () => {
    await writeFile(path.join(repo.root, 'app.js'), 'const v = "main";\n');
    await git(repo.root, 'add', 'app.js');
    await git(repo.root, 'commit', '-q', '-m', 'feat: main');
    await commitIn(agent.path, 'app.js', 'const v = "agent";\n', 'feat: agent');
    const before = await git(repo.root, 'rev-parse', 'HEAD');
    // Pendant que le LLM « réfléchit », quelqu'un annule le merge ouvert.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        await git(repo.root, 'merge', '--abort');
        return { ok: true, json: async () => ({ response: 'const v = "FUSION LLM";\n' }) };
      }),
    );

    const error = await mergeAgentCommit({ root: repo.root, agent: 'agent-a' }).catch((e) => e);

    expect(error).toMatchObject({ code: 'MERGE_STATE_CHANGED' });
    const content = await readFile(path.join(repo.root, 'app.js'), 'utf8');
    expect(content.replaceAll('\r\n', '\n')).toBe('const v = "main";\n');
    expect(await git(repo.root, 'rev-parse', 'HEAD')).toBe(before);
    expect(await git(repo.root, 'status', '--porcelain', '--untracked-files=no')).toBe('');
  });
});

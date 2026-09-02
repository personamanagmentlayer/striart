import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { simpleGit } from 'simple-git';
import { createTempRepo } from '../helpers/temp-repo.js';
import { initStriart } from '../../src/init.js';
import { createAgent, readRegistry, updateAgentMeta } from '../../src/clone.js';
import { mergeAgentCommit, stopAgent } from '../../src/orchestrator.js';

const GATE_OK = 'node -e "process.exit(0)"';
const GATE_KO = 'node -e "console.error(\'tests cassés\'); process.exit(1)"';

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

async function listConflictTickets(root) {
  return readdir(path.join(root, '.striart', 'conflicts'));
}

// "Propre" au sens du merge : aucun fichier suivi modifié/staged, aucun conflit.
// (Les fichiers untracked générés par striart init ne comptent pas.)
async function expectMergeAborted(git) {
  const status = await git.status();
  expect(status.conflicted).toEqual([]);
  expect(status.staged).toEqual([]);
  expect(status.modified).toEqual([]);
}

describe('striart merge + test gate (intégration)', () => {
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

  it('merge un commit propre quand le Test Gate passe', async () => {
    const sha = await commitInAgent(agent, 'feature.js', 'export const x = 1;\n', 'feat: x');

    const result = await mergeAgentCommit({ root: repo.root, agent: 'agent-a' });
    expect(result.status).toBe('MERGED');
    expect(result.sha).toBe(sha);

    // Le fichier de l'agent est arrivé dans le repo principal, commit de merge créé.
    await expect(readFile(path.join(repo.root, 'feature.js'), 'utf8')).resolves.toContain('x = 1');
    const log = await repo.git.log({ maxCount: 1 });
    expect(log.latest.message).toContain('merge(striart): agent-a');

    const registry = await readRegistry(repo.root);
    expect(registry['agent-a'].lastMergedCommit).toBe(sha);

    // Second appel sans nouveau commit → UP_TO_DATE.
    const again = await mergeAgentCommit({ root: repo.root, agent: 'agent-a' });
    expect(again.status).toBe('UP_TO_DATE');
  });

  it('abort + ticket GATE_FAILED quand le Test Gate échoue', async () => {
    await setConfig(repo.root, { testCommand: GATE_KO });
    await commitInAgent(agent, 'broken.js', 'export const y = 2;\n', 'feat: y');

    const result = await mergeAgentCommit({ root: repo.root, agent: 'agent-a' });
    expect(result.status).toBe('GATE_FAILED');

    // Règle d'or n°2 : merge annulé, repo principal intact et propre.
    await expect(stat(path.join(repo.root, 'broken.js'))).rejects.toThrow();
    await expectMergeAborted(repo.git);
    expect((await repo.git.log()).latest.message).toBe('chore: initial commit');

    // Ticket créé avec le log du gate.
    const tickets = await listConflictTickets(repo.root);
    expect(tickets).toHaveLength(1);
    const ticket = JSON.parse(
      await readFile(
        path.join(repo.root, '.striart', 'conflicts', tickets[0], 'ticket.json'),
        'utf8',
      ),
    );
    expect(ticket).toMatchObject({ agent: 'agent-a', reason: 'GATE_FAILED' });
    const gateLog = await readFile(
      path.join(repo.root, '.striart', 'conflicts', tickets[0], 'test-output.log'),
      'utf8',
    );
    expect(gateLog).toContain('tests cassés');

    // Pas de lastMergedCommit : le commit reste "en attente".
    const registry = await readRegistry(repo.root);
    expect(registry['agent-a'].lastMergedCommit).toBeUndefined();
  });

  it('abort + ticket MERGE_CONFLICT sur un conflit textuel (fusion sémantique désactivée)', async () => {
    await setConfig(repo.root, { testCommand: GATE_OK, semanticMerge: false });
    // Le repo principal et l'agent modifient la même ligne de README.md.
    await writeFile(path.join(repo.root, 'README.md'), '# version main\n');
    await repo.git.add(['README.md']);
    await repo.git.commit('feat: main édite le README');

    await commitInAgent(agent, 'README.md', '# version agent\n', 'feat: agent édite le README');

    const result = await mergeAgentCommit({ root: repo.root, agent: 'agent-a' });
    expect(result.status).toBe('CONFLICT');
    expect(result.conflictedFiles).toEqual(['README.md']);

    // Merge annulé : README de main intact, repo propre.
    // git merge --abort peut restaurer le fichier en CRLF (autocrlf Windows) : on normalise.
    const readme = await readFile(path.join(repo.root, 'README.md'), 'utf8');
    expect(readme.replaceAll('\r\n', '\n')).toBe('# version main\n');
    await expectMergeAborted(repo.git);

    const tickets = await listConflictTickets(repo.root);
    expect(tickets).toHaveLength(1);
    const ticket = JSON.parse(
      await readFile(
        path.join(repo.root, '.striart', 'conflicts', tickets[0], 'ticket.json'),
        'utf8',
      ),
    );
    expect(ticket).toMatchObject({ reason: 'MERGE_CONFLICT', conflictedFiles: ['README.md'] });
  });

  it('refuse de merger sur un working tree sale', async () => {
    await writeFile(path.join(repo.root, 'wip.txt'), 'travail en cours\n');
    await repo.git.add(['wip.txt']);
    await commitInAgent(agent, 'feature.js', 'x\n', 'feat: x');

    await expect(mergeAgentCommit({ root: repo.root, agent: 'agent-a' })).rejects.toMatchObject({
      code: 'MAIN_DIRTY',
    });
  });

  it('refuse de merger depuis une autre branche que targetBranch', async () => {
    await repo.git.checkoutLocalBranch('feature-x');
    await commitInAgent(agent, 'feature.js', 'x\n', 'feat: x');

    await expect(mergeAgentCommit({ root: repo.root, agent: 'agent-a' })).rejects.toMatchObject({
      code: 'TARGET_BRANCH_MISMATCH',
    });
  });

  it('refuse un agent inconnu', async () => {
    await expect(mergeAgentCommit({ root: repo.root, agent: 'fantome' })).rejects.toMatchObject({
      code: 'AGENT_UNKNOWN',
    });
  });

  it('refuse de merger tant que la session autonome du clone est vivante (SESSION_LIVE)', async () => {
    // Merger une session vivante pousserait ses commits INTERMÉDIAIRES dans la
    // branche cible et ferait courir ce merge contre le merge de fin de cycle.
    await commitInAgent(agent, 'feature.js', 'x\n', 'feat: x');
    await updateAgentMeta(repo.root, 'agent-a', { sessionPid: process.pid });
    await expect(mergeAgentCommit({ root: repo.root, agent: 'agent-a' })).rejects.toMatchObject({
      code: 'SESSION_LIVE',
    });

    // Un PID mort (crash) ne gèle pas le merge : contrôle de vitalité.
    await updateAgentMeta(repo.root, 'agent-a', { sessionPid: 999_999_999 });
    expect((await mergeAgentCommit({ root: repo.root, agent: 'agent-a' })).status).toBe('MERGED');
  });
});

describe('striart stop (intégration)', () => {
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

  it('retire du registre mais conserve le clone sur disque', async () => {
    const result = await stopAgent({ root: repo.root, agent: 'agent-a' });
    expect((await readRegistry(repo.root))['agent-a']).toBeUndefined();
    await expect(stat(result.clonePath)).resolves.toBeTruthy(); // règle d'or n°3
  });

  it('refuse si des commits ne sont pas mergés, sauf --force', async () => {
    await commitInAgent(agent, 'feature.js', 'x\n', 'feat: x');
    await expect(stopAgent({ root: repo.root, agent: 'agent-a' })).rejects.toMatchObject({
      code: 'AGENT_HAS_PENDING',
    });
    await stopAgent({ root: repo.root, agent: 'agent-a', force: true });
    expect((await readRegistry(repo.root))['agent-a']).toBeUndefined();
  });

  it('refuse un stop — même --force — tant que la session autonome vit', async () => {
    // Toutes les protections aval (SESSION_LIVE de cleanClones, abstention de
    // rebase) reposent sur l'entrée au registre : la retirer sous une session
    // vivante les désarmerait toutes et ferait échouer son merge final.
    await updateAgentMeta(repo.root, 'agent-a', { sessionPid: process.pid });
    await expect(stopAgent({ root: repo.root, agent: 'agent-a' })).rejects.toMatchObject({
      code: 'SESSION_LIVE',
    });
    await expect(
      stopAgent({ root: repo.root, agent: 'agent-a', force: true }),
    ).rejects.toMatchObject({ code: 'SESSION_LIVE' });

    // Un PID mort (crash) rend la main : le garde ne gèle rien indéfiniment.
    await updateAgentMeta(repo.root, 'agent-a', { sessionPid: 999_999_999 });
    await stopAgent({ root: repo.root, agent: 'agent-a' });
    expect((await readRegistry(repo.root))['agent-a']).toBeUndefined();
  });

  it('merge puis stop : le cycle complet passe', async () => {
    await commitInAgent(agent, 'feature.js', 'x\n', 'feat: x');
    const merged = await mergeAgentCommit({ root: repo.root, agent: 'agent-a' });
    expect(merged.status).toBe('MERGED');
    const result = await stopAgent({ root: repo.root, agent: 'agent-a' });
    expect(result.started).toEqual([]);
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { simpleGit } from 'simple-git';
import { createTempRepo } from '../helpers/temp-repo.js';
import { initStriart } from '../../src/init.js';
import { createAgent, listAgents, updateAgentMeta } from '../../src/clone.js';
import { mergeAgentCommit, syncAgentWithMain, syncAllAgents } from '../../src/orchestrator.js';
import { checkAgentsBehind } from '../../src/sync.js';

const GATE_OK = 'node -e "process.exit(0)"';

async function setConfig(root, config) {
  await writeFile(path.join(root, '.striartrc.json'), JSON.stringify(config));
}

async function commitInMain(repo, fileName, content, message) {
  await writeFile(path.join(repo.root, fileName), content);
  await repo.git.add([fileName]);
  await repo.git.commit(message);
}

async function commitInAgent(info, fileName, content, message) {
  const git = simpleGit(info.path);
  await git.addConfig('user.name', 'Agent');
  await git.addConfig('user.email', 'agent@example.com');
  await writeFile(path.join(info.path, fileName), content);
  await git.add([fileName]);
  await git.commit(message);
}

describe('striart sync — rebase automatique (intégration)', () => {
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

  it('rebase un agent en retard sur main', async () => {
    await commitInMain(repo, 'nouveau.js', 'export const n = 1;\n', 'feat: nouveau depuis main');
    await commitInAgent(agent, 'travail.js', 'export const t = 1;\n', 'feat: travail agent');

    const result = await syncAgentWithMain({ root: repo.root, agent: 'agent-a' });
    expect(result.status).toBe('REBASED');
    expect(result.rebasedCommits).toBe(1);

    // L'agent a reçu le fichier de main ET conservé son travail.
    await expect(readFile(path.join(agent.path, 'nouveau.js'), 'utf8')).resolves.toContain('n = 1');
    await expect(readFile(path.join(agent.path, 'travail.js'), 'utf8')).resolves.toContain('t = 1');

    // Le comptage des commits en attente reste correct après réécriture des SHAs.
    const agents = await listAgents(repo.root);
    expect(agents[0].pendingCommits).toBe(1);
  });

  it('agent déjà à jour → UP_TO_DATE', async () => {
    const result = await syncAgentWithMain({ root: repo.root, agent: 'agent-a' });
    expect(result.status).toBe('UP_TO_DATE');
  });

  it('checkAgentsBehind mesure le retard sans toucher le working tree', async () => {
    await commitInMain(repo, 'nouveau.js', 'x\n', 'feat: main avance');
    // L'agent a du travail non commité : le fetch silencieux ne doit PAS y toucher.
    await writeFile(path.join(agent.path, 'wip.js'), 'const wip = 1;\n');

    let results = await checkAgentsBehind({ root: repo.root });
    expect(results).toEqual([{ agent: 'agent-a', behind: 1 }]);
    // Le worktree est intact et l'agent n'a pas reçu le fichier de main.
    await expect(readFile(path.join(agent.path, 'wip.js'), 'utf8')).resolves.toContain('wip');
    await expect(readFile(path.join(agent.path, 'nouveau.js'), 'utf8')).rejects.toThrow();

    // Après rebase (worktree nettoyé), le retard tombe à zéro.
    const { rm } = await import('node:fs/promises');
    await rm(path.join(agent.path, 'wip.js'));
    await syncAgentWithMain({ root: repo.root, agent: 'agent-a' });
    results = await checkAgentsBehind({ root: repo.root });
    expect(results).toEqual([{ agent: 'agent-a', behind: 0 }]);
  });

  it('autoStash: false → ne touche jamais un worktree agent avec du travail en cours', async () => {
    await setConfig(repo.root, { testCommand: GATE_OK, autoStash: false });
    await commitInMain(repo, 'nouveau.js', 'x\n', 'feat: main avance');
    // L'agent a un fichier non commité : il est peut-être en train d'écrire.
    await writeFile(path.join(agent.path, 'en-cours.js'), 'const wip = true;\n');

    const result = await syncAgentWithMain({ root: repo.root, agent: 'agent-a' });
    expect(result.status).toBe('SKIPPED_DIRTY');
    // Rien n'a bougé.
    await expect(readFile(path.join(agent.path, 'en-cours.js'), 'utf8')).resolves.toContain('wip');
    await expect(readFile(path.join(agent.path, 'nouveau.js'), 'utf8')).rejects.toThrow();
  });

  it('stash auto : travail en cours disjoint des commits entrants → rebase + restauration', async () => {
    // Scénario nominal : A a poussé backend/api.ts, B travaille sur frontend/Button.tsx.
    await commitInMain(repo, 'api.ts', 'export const api = 1;\n', 'feat: backend api');
    await writeFile(path.join(agent.path, 'Button.tsx'), 'export const Button = null; // WIP\n');

    const result = await syncAgentWithMain({ root: repo.root, agent: 'agent-a' });
    expect(result.status).toBe('REBASED');
    expect(result.stashed).toBe(true);

    // L'agent a reçu l'API de main ET son travail non commité est restauré.
    await expect(readFile(path.join(agent.path, 'api.ts'), 'utf8')).resolves.toContain('api = 1');
    await expect(readFile(path.join(agent.path, 'Button.tsx'), 'utf8')).resolves.toContain('WIP');

    // Button.tsx est toujours non commité (l'agent reprend exactement où il en était).
    const status = await simpleGit(agent.path).status();
    expect(status.not_added).toContain('Button.tsx');
    // Et le stash est vide : rien d'oublié.
    const stashes = await simpleGit(agent.path).stashList();
    expect(stashes.total).toBe(0);
  });

  it('stash auto refusé si le travail en cours chevauche les commits entrants', async () => {
    // Le Router s'est trompé : main ET l'agent touchent README.md.
    await commitInMain(repo, 'README.md', '# version main\n', 'feat: main édite README');
    await writeFile(path.join(agent.path, 'README.md'), '# WIP agent non commité\n');

    const result = await syncAgentWithMain({ root: repo.root, agent: 'agent-a' });
    expect(result.status).toBe('SKIPPED_DIRTY');
    expect(result.overlap).toEqual(['README.md']);
    // Le travail non commité de l'agent est intact.
    await expect(readFile(path.join(agent.path, 'README.md'), 'utf8')).resolves.toContain(
      'WIP agent',
    );
  });

  it('rebase en conflit → annulé proprement, branche agent intacte', async () => {
    await commitInMain(repo, 'shared.js', 'const v = "main";\n', 'feat: main');
    await commitInAgent(agent, 'shared.js', 'const v = "agent";\n', 'feat: agent');
    const agentGit = simpleGit(agent.path);
    const headBefore = (await agentGit.revparse(['HEAD'])).trim();

    const result = await syncAgentWithMain({ root: repo.root, agent: 'agent-a' });
    expect(result.status).toBe('REBASE_CONFLICT');

    const headAfter = (await agentGit.revparse(['HEAD'])).trim();
    expect(headAfter).toBe(headBefore);
    expect((await agentGit.status()).isClean()).toBe(true);
  });

  it('un renommage côté main compte pour ses deux chemins (check conservateur)', async () => {
    // main renomme README.md → GUIDE.md ; l'agent a du travail non commité sur README.md.
    await repo.git.mv('README.md', 'GUIDE.md');
    await repo.git.commit('refactor: renomme README en GUIDE');
    await writeFile(path.join(agent.path, 'README.md'), "# WIP agent sur l'ancien chemin\n");

    const result = await syncAgentWithMain({ root: repo.root, agent: 'agent-a' });
    // L'ancien chemin (README.md) fait partie des fichiers entrants (--no-renames) :
    // le stash serait risqué → rebase reporté.
    expect(result.status).toBe('SKIPPED_DIRTY');
    expect(result.overlap).toContain('README.md');
  });

  it('une suppression locale non commitée compte comme fichier dirty', async () => {
    // main modifie README.md ; l'agent l'a supprimé localement sans commiter.
    await commitInMain(repo, 'README.md', '# version main\n', 'feat: main édite README');
    const { rm } = await import('node:fs/promises');
    await rm(path.join(agent.path, 'README.md'));

    const result = await syncAgentWithMain({ root: repo.root, agent: 'agent-a' });
    expect(result.status).toBe('SKIPPED_DIRTY');
    expect(result.overlap).toContain('README.md');
  });

  it('syncAllAgents notifie l’humain quand un agent est bloqué sur une base obsolète (overlap)', async () => {
    await setConfig(repo.root, {
      testCommand: GATE_OK,
      webhookUrl: 'https://hooks.slack.com/services/test',
    });
    await commitInMain(repo, 'README.md', '# version main\n', 'feat: main édite README');
    await writeFile(path.join(agent.path, 'README.md'), '# WIP agent\n');

    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);
    const results = await syncAllAgents({ root: repo.root });
    vi.unstubAllGlobals();

    expect(results[0]).toMatchObject({ status: 'SKIPPED_DIRTY', overlap: ['README.md'] });
    const webhookCalls = fetchMock.mock.calls.filter(([url]) =>
      String(url).includes('hooks.slack.com'),
    );
    expect(webhookCalls).toHaveLength(1);
    const message = JSON.parse(webhookCalls[0][1].body).text;
    expect(message).toContain('agent-a');
    expect(message).toContain('README.md');
    expect(message).toContain('conflit probable');
  });

  it('syncAllAgents rebase tous les agents actifs sauf exceptions', async () => {
    const agentB = await createAgent({ root: repo.root, name: 'agent-b' });
    await commitInMain(repo, 'nouveau.js', 'x\n', 'feat: main avance');

    const results = await syncAllAgents({ root: repo.root, except: ['agent-b'] });
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ agent: 'agent-a', status: 'REBASED' });

    // agent-b n'a pas été touché.
    const agentBGit = simpleGit(agentB.path);
    const behind = await agentBGit
      .raw(['rev-list', '--count', 'HEAD..FETCH_HEAD'])
      .catch(() => 'no-fetch');
    expect(behind).toBe('no-fetch'); // jamais fetché
  });

  it('mergeAgentCommit rebase d’abord : main avancé + commit agent → MERGED sans conflit', async () => {
    await commitInMain(repo, 'cote-main.js', 'export const m = 1;\n', 'feat: côté main');
    await commitInAgent(agent, 'cote-agent.js', 'export const a = 1;\n', 'feat: côté agent');

    const result = await mergeAgentCommit({ root: repo.root, agent: 'agent-a' });
    expect(result.status).toBe('MERGED');
    expect(result.rebase?.status).toBe('REBASED');

    // Les deux fichiers coexistent dans main.
    await expect(readFile(path.join(repo.root, 'cote-main.js'), 'utf8')).resolves.toContain(
      'm = 1',
    );
    await expect(readFile(path.join(repo.root, 'cote-agent.js'), 'utf8')).resolves.toContain(
      'a = 1',
    );
  });

  it('autoRebase: false → pas de rebase avant merge', async () => {
    await setConfig(repo.root, { testCommand: GATE_OK, autoRebase: false });
    await commitInAgent(agent, 'x.js', 'x\n', 'feat: x');
    const result = await mergeAgentCommit({ root: repo.root, agent: 'agent-a' });
    expect(result.status).toBe('MERGED');
    expect(result.rebase).toBeNull();
  });
});

describe('sync — abstention pendant une session autonome (intégration)', () => {
  let repo;

  beforeEach(async () => {
    repo = await createTempRepo();
    await initStriart(repo.root);
  });

  afterEach(async () => {
    await repo.cleanup();
  });

  /** Fait avancer main pour que le rebase ait réellement quelque chose à faire. */
  async function advanceMain() {
    await writeFile(path.join(repo.root, 'nouveau.txt'), 'main a avancé\n');
    await repo.git.add(['nouveau.txt']);
    await repo.git.commit('feat: main avance');
  }

  it('n’effleure pas le clone d’un agent dont la session tourne', async () => {
    await createAgent({ root: repo.root, name: 'robot', mode: 'autonomous', profile: 'claude' });
    await advanceMain();
    // PID garanti vivant : celui du process de test lui-même.
    await updateAgentMeta(repo.root, 'robot', { sessionPid: process.pid });

    const [result] = await syncAllAgents({ root: repo.root });
    expect(result.status).toBe('SKIPPED_SESSION');
    expect(result.pid).toBe(process.pid);
  });

  it('le garde vit dans la primitive : le sync UNITAIRE refuse aussi une session vivante', async () => {
    // `striart sync <agent>` et le bouton Sync du dashboard passent par
    // syncAgentWithMain sans la boucle syncAllAgents : le garde doit tenir là.
    await createAgent({ root: repo.root, name: 'robot', mode: 'autonomous', profile: 'claude' });
    await advanceMain();
    await updateAgentMeta(repo.root, 'robot', { sessionPid: process.pid });

    const result = await syncAgentWithMain({ root: repo.root, agent: 'robot' });
    expect(result.status).toBe('SKIPPED_SESSION');
    expect(result.pid).toBe(process.pid);
  });

  it('reprend le rebase dès que la session est finie', async () => {
    await createAgent({ root: repo.root, name: 'robot', mode: 'autonomous', profile: 'claude' });
    await advanceMain();
    await updateAgentMeta(repo.root, 'robot', { sessionPid: null });

    const [result] = await syncAllAgents({ root: repo.root });
    expect(result.status).toBe('REBASED');
  });

  it('un PID mort (crash de session) ne gèle pas le clone indéfiniment', async () => {
    // Auto-guérison : sans contrôle de vitalité, un PID laissé au registre par
    // un crash bloquerait tout rebase de ce clone pour toujours.
    await createAgent({ root: repo.root, name: 'robot', mode: 'autonomous', profile: 'claude' });
    await advanceMain();
    await updateAgentMeta(repo.root, 'robot', { sessionPid: 999_999_999 });

    const [result] = await syncAllAgents({ root: repo.root });
    expect(result.status).toBe('REBASED');
  });

  it('un agent supervisé n’est jamais concerné par cette abstention', async () => {
    await createAgent({ root: repo.root, name: 'humain', command: 'claude' });
    await advanceMain();

    const [result] = await syncAllAgents({ root: repo.root });
    expect(result.status).toBe('REBASED');
  });
});

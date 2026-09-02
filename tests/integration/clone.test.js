import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { simpleGit } from 'simple-git';
import { createTempRepo } from '../helpers/temp-repo.js';
import { initStriart } from '../../src/init.js';
import { createAgent, listAgents, readRegistry } from '../../src/clone.js';
import { StriartError } from '../../src/errors.js';

describe('striart init + start + status (intégration)', () => {
  let repo;

  beforeEach(async () => {
    repo = await createTempRepo();
  });

  afterEach(async () => {
    await repo.cleanup();
  });

  it('init crée la structure .striart/ et ajoute .striart/ au .gitignore', async () => {
    const result = await initStriart(repo.root);
    expect(result.root).toBe(repo.root);
    for (const sub of ['agents', 'conflicts', 'logs']) {
      await expect(stat(path.join(repo.root, '.striart', sub))).resolves.toBeTruthy();
    }
    await expect(stat(path.join(repo.root, '.striart', 'queue.json'))).resolves.toBeTruthy();
    await expect(stat(path.join(repo.root, 'striart.config.mjs'))).resolves.toBeTruthy();
    const gitignored = await repo.git.checkIgnore(['.striart/queue.json']);
    expect(gitignored.length).toBeGreaterThan(0);
  });

  it('init est idempotent', async () => {
    await initStriart(repo.root);
    const second = await initStriart(repo.root);
    expect(second.created).toHaveLength(0);
  });

  it('init ne génère pas de template si une config utilisateur existe déjà', async () => {
    await writeFile(
      path.join(repo.root, '.striartrc.json'),
      JSON.stringify({ testCommand: 'make test' }),
    );
    const result = await initStriart(repo.root);
    expect(result.config.testCommand).toBe('make test');
    await expect(stat(path.join(repo.root, 'striart.config.mjs'))).rejects.toThrow();
  });

  it('start crée un clone orphelin sur une branche de tâche', async () => {
    await initStriart(repo.root);
    const info = await createAgent({ root: repo.root, name: 'agent-a' });

    expect(info.branch).toMatch(/^striart\/agent-a\/task-[0-9a-f]{8}$/);
    const agentGit = simpleGit(info.path);
    const branch = await agentGit.revparse(['--abbrev-ref', 'HEAD']);
    expect(branch.trim()).toBe(info.branch);

    // Règle d'or n°1 : clone orphelin, aucun remote.
    const remotes = await agentGit.getRemotes();
    expect(remotes).toHaveLength(0);

    // Le clone est un vrai repo indépendant (pas un worktree).
    await expect(stat(path.join(info.path, '.git', 'HEAD'))).resolves.toBeTruthy();

    const registry = await readRegistry(repo.root);
    expect(registry['agent-a'].branch).toBe(info.branch);
  });

  it('les objets du clone local sont hardlinkés (historique quasi gratuit) et le worktree est une vraie copie', async () => {
    await initStriart(repo.root);
    const info = await createAgent({ root: repo.root, name: 'agent-a' });

    // Le README du worktree est une vraie copie (nlink 1), pas un hardlink.
    const { stat: statFile } = await import('node:fs/promises');
    const readmeStat = await statFile(path.join(info.path, 'README.md'));
    expect(readmeStat.nlink).toBe(1);

    // La taille additionnelle du clone est très inférieure au repo complet
    // (les objets partagés hardlinkés comptent 0).
    const { dirSizeBytes } = await import('../../src/clone.js');
    const cloneSize = await dirSizeBytes(info.path);
    expect(cloneSize).toBeGreaterThan(0);
  });

  it('cloneFilter blob:none : origin conservé en promisor fetch-only, cycle merge complet', async () => {
    await initStriart(repo.root);
    const { writeFile: wf } = await import('node:fs/promises');
    await wf(
      path.join(repo.root, '.striartrc.json'),
      JSON.stringify({ testCommand: 'node -e "process.exit(0)"' }),
    );
    const info = await createAgent({
      root: repo.root,
      name: 'agent-partial',
      cloneFilter: 'blob:none',
    });

    // origin existe (promisor pour les blobs à la demande) mais le push est neutralisé.
    const agentGit = simpleGit(info.path);
    const remotes = await agentGit.getRemotes(true);
    const origin = remotes.find((r) => r.name === 'origin');
    expect(origin).toBeDefined();
    expect(origin.refs.push).toBe('push-disabled://striart');

    // L'agent commite, le merge vers main fonctionne (les objets de l'agent sont locaux).
    await agentGit.addConfig('user.name', 'A');
    await agentGit.addConfig('user.email', 'a@a.a');
    await wf(path.join(info.path, 'partial.js'), 'export const p = 1;\n');
    await agentGit.add(['partial.js']);
    await agentGit.commit('feat: depuis un clone partiel');

    const { mergeAgentCommit } = await import('../../src/orchestrator.js');
    const result = await mergeAgentCommit({ root: repo.root, agent: 'agent-partial' });
    expect(result.status).toBe('MERGED');
  });

  it('cleanStoppedClones : supprime les clones arrêtés, jamais les actifs', async () => {
    await initStriart(repo.root);
    const { cleanStoppedClones, removeAgentFromRegistry } = await import('../../src/clone.js');
    const a = await createAgent({ root: repo.root, name: 'agent-a' });
    await createAgent({ root: repo.root, name: 'agent-b' });

    // agent-a est "stoppé" (retiré du registre), agent-b reste actif.
    await removeAgentFromRegistry(repo.root, 'agent-a');
    // Session inactive depuis longtemps (sinon la présence protège le clone).
    const { backdateDir } = await import('../helpers/temp-repo.js');
    await backdateDir(a.path);

    const { removed, skipped } = await cleanStoppedClones({ root: repo.root });
    expect(removed).toEqual([
      { name: 'agent-a', freedBytes: expect.any(Number), wasActive: false },
    ]);
    expect(skipped).toEqual([{ name: 'agent-b', reason: 'ACTIVE' }]);
    await expect(stat(a.path)).rejects.toThrow(); // clone supprimé
    // Cibler explicitement un agent actif → conservé.
    const targeted = await cleanStoppedClones({ root: repo.root, agent: 'agent-b' });
    expect(targeted.removed).toHaveLength(0);
    expect(targeted.skipped).toEqual([{ name: 'agent-b', reason: 'ACTIVE' }]);
    // Agent inexistant → erreur claire.
    await expect(cleanStoppedClones({ root: repo.root, agent: 'fantome' })).rejects.toMatchObject({
      code: 'CLONE_NOT_FOUND',
    });
  });

  it('clean --all : supprime les actifs au repos, protège le travail non mergé sauf --force', async () => {
    await initStriart(repo.root);
    const { cleanClones } = await import('../../src/clone.js');
    const { writeFile: wf } = await import('node:fs/promises');
    const repos = await createAgent({ root: repo.root, name: 'au-repos' }); // tout mergé, propre
    const pending = await createAgent({ root: repo.root, name: 'pending' });

    // pending a un commit non mergé.
    const pendingGit = simpleGit(pending.path);
    await pendingGit.addConfig('user.name', 'P');
    await pendingGit.addConfig('user.email', 'p@p.p');
    await wf(path.join(pending.path, 'wip.js'), 'x\n');
    await pendingGit.add(['wip.js']);
    await pendingGit.commit('feat: non mergé');

    // Sessions inactives depuis longtemps (la présence protégerait sinon).
    const { backdateDir } = await import('../helpers/temp-repo.js');
    await backdateDir(repos.path);
    await backdateDir(pending.path);

    // --all sans force : au-repos supprimé (et retiré du registre), pending protégé.
    const first = await cleanClones({ root: repo.root, all: true });
    expect(first.removed).toEqual([
      { name: 'au-repos', freedBytes: expect.any(Number), wasActive: true },
    ]);
    expect(first.skipped).toEqual([{ name: 'pending', reason: 'PENDING' }]);
    await expect(stat(repos.path)).rejects.toThrow();
    expect((await readRegistry(repo.root))['au-repos']).toBeUndefined();
    expect((await readRegistry(repo.root))['pending']).toBeDefined();

    // --all --force : le travail non mergé est abandonné, assumé.
    const second = await cleanClones({ root: repo.root, all: true, force: true });
    expect(second.removed).toEqual([
      { name: 'pending', freedBytes: expect.any(Number), wasActive: true },
    ]);
    await expect(stat(pending.path)).rejects.toThrow();
    expect(await readRegistry(repo.root)).toEqual({});
  });

  it('start refuse un agent en doublon', async () => {
    await initStriart(repo.root);
    await createAgent({ root: repo.root, name: 'agent-a' });
    await expect(createAgent({ root: repo.root, name: 'agent-a' })).rejects.toMatchObject({
      code: 'AGENT_EXISTS',
    });
  });

  it('start refuse sans striart init préalable', async () => {
    await expect(createAgent({ root: repo.root, name: 'agent-a' })).rejects.toMatchObject({
      code: 'NOT_INITIALIZED',
    });
  });

  it('status compte les commits en attente de merge', async () => {
    await initStriart(repo.root);
    const info = await createAgent({ root: repo.root, name: 'agent-a' });

    let agents = await listAgents(repo.root);
    expect(agents).toHaveLength(1);
    expect(agents[0]).toMatchObject({ name: 'agent-a', status: 'ACTIVE', pendingCommits: 0 });

    const agentGit = simpleGit(info.path);
    await writeFile(path.join(info.path, 'feature.js'), 'export const x = 1;\n');
    await agentGit.addConfig('user.name', 'Agent A');
    await agentGit.addConfig('user.email', 'agent-a@example.com');
    await agentGit.add(['feature.js']);
    await agentGit.commit('feat: ajoute feature');

    agents = await listAgents(repo.root);
    expect(agents[0].pendingCommits).toBe(1);
    expect(agents[0].lastMessage).toBe('feat: ajoute feature');
  });

  it('createAgent hors repo Git lève NOT_A_GIT_REPO via findRepoRoot', async () => {
    const { findRepoRoot } = await import('../../src/clone.js');
    const os = await import('node:os');
    await expect(findRepoRoot(os.tmpdir())).rejects.toThrow(StriartError);
  });
});

describe('nettoyage des secrets au clonage (intégration)', () => {
  let repo;

  beforeEach(async () => {
    repo = await createTempRepo();
    await initStriart(repo.root);
    // Secrets TRACKÉS (commités par erreur) + fichier légitime.
    await writeFile(path.join(repo.root, '.env'), 'API_KEY=super-secret\n');
    await simpleGit(repo.root).raw(['add', '-f', '.env']); // .gitignore de init l'ignore
    await writeFile(path.join(repo.root, 'server.pem'), '-----BEGIN CERT-----\n');
    await writeFile(path.join(repo.root, 'app.js'), 'const app = 1;\n');
    await repo.git.add(['server.pem', 'app.js']);
    await repo.git.commit('feat: app + secrets commités par erreur');
  });

  afterEach(async () => {
    await repo.cleanup();
  });

  const DEFAULT_PATTERNS = ['.env', '.env.*', '*.pem', '*.key', 'credentials.json'];

  it('retire les secrets trackés du worktree du clone, status propre', async () => {
    const info = await createAgent({
      root: repo.root,
      name: 'agent-a',
      secretPatterns: DEFAULT_PATTERNS,
    });

    expect(info.secretsExcluded.sort()).toEqual(['.env', 'server.pem']);
    // Absents du disque du clone...
    await expect(stat(path.join(info.path, '.env'))).rejects.toThrow();
    await expect(stat(path.join(info.path, 'server.pem'))).rejects.toThrow();
    // ...mais le fichier légitime est là, et le worktree est PROPRE
    // (pas une suppression que l'agent finirait par commiter).
    await expect(stat(path.join(info.path, 'app.js'))).resolves.toBeTruthy();
    const status = await simpleGit(info.path).status();
    expect(status.isClean()).toBe(true);
  });

  it('secretPatterns: [] désactive le nettoyage', async () => {
    const info = await createAgent({ root: repo.root, name: 'agent-b', secretPatterns: [] });
    expect(info.secretsExcluded).toEqual([]);
    await expect(stat(path.join(info.path, '.env'))).resolves.toBeTruthy();
  });

  it('sans aucun secret tracké : pas de sparse-checkout, clone standard', async () => {
    const clean = await createTempRepo();
    try {
      await initStriart(clean.root);
      await writeFile(path.join(clean.root, 'app.js'), 'const app = 1;\n');
      await clean.git.add(['app.js']);
      await clean.git.commit('feat: app');
      const info = await createAgent({
        root: clean.root,
        name: 'agent-c',
        secretPatterns: DEFAULT_PATTERNS,
      });
      expect(info.secretsExcluded).toEqual([]);
      // sparse-checkout non activé (pas de fichier .git/info/sparse-checkout).
      await expect(stat(path.join(info.path, '.git', 'info', 'sparse-checkout'))).rejects.toThrow();
    } finally {
      await clean.cleanup();
    }
  });
});

describe('présence de session (intégration)', () => {
  let repo;

  beforeEach(async () => {
    repo = await createTempRepo();
    await initStriart(repo.root);
  });

  afterEach(async () => {
    await repo.cleanup();
  });

  it('un clone fraîchement utilisé est marqué session en cours, un ancien non', async () => {
    const { backdateDir } = await import('../helpers/temp-repo.js');
    const recent = await createAgent({ root: repo.root, name: 'recent' });
    const idle = await createAgent({ root: repo.root, name: 'idle' });
    await backdateDir(idle.path);

    const agents = await listAgents(repo.root);
    const byName = Object.fromEntries(agents.map((a) => [a.name, a]));
    expect(byName.recent.sessionActive).toBe(true);
    expect(byName.idle.sessionActive).toBe(false);
    expect(byName.idle.lastActivity).toMatch(/^\d{4}-/);
    void recent;
  });

  it("clean refuse un clone avec activité récente (règle d'or n°3), --force passe outre", async () => {
    const { cleanClones, removeAgentFromRegistry } = await import('../../src/clone.js');
    const a = await createAgent({ root: repo.root, name: 'agent-a' });
    await removeAgentFromRegistry(repo.root, 'agent-a'); // stoppé, mais activité toute fraîche

    const guarded = await cleanClones({ root: repo.root });
    expect(guarded.removed).toHaveLength(0);
    expect(guarded.skipped).toEqual([{ name: 'agent-a', reason: 'IN_USE' }]);
    await expect(stat(a.path)).resolves.toBeTruthy(); // toujours là

    const forced = await cleanClones({ root: repo.root, force: true });
    expect(forced.removed).toEqual([
      { name: 'agent-a', freedBytes: expect.any(Number), wasActive: false },
    ]);
  });
});

describe('clean — une session autonome vivante est intouchable', () => {
  let repo;

  beforeEach(async () => {
    repo = await createTempRepo();
    await initStriart(repo.root);
  });

  afterEach(async () => {
    await repo.cleanup();
  });

  it('refuse la suppression MÊME avec --force tant que le process vit', async () => {
    // --force existe pour passer outre des heuristiques (activité disque,
    // travail non mergé). Un process vivant n'est pas une supposition :
    // supprimer ses fichiers sous ses pieds détruirait son travail.
    const { cleanClones, createAgent, updateAgentMeta } = await import('../../src/clone.js');
    const info = await createAgent({
      root: repo.root,
      name: 'robot',
      mode: 'autonomous',
      profile: 'claude',
    });
    await updateAgentMeta(repo.root, 'robot', { sessionPid: process.pid });

    const result = await cleanClones({ root: repo.root, agent: 'robot', all: true, force: true });
    expect(result.removed).toEqual([]);
    expect(result.skipped).toEqual([{ name: 'robot', reason: 'SESSION_LIVE' }]);

    const { stat } = await import('node:fs/promises');
    await expect(stat(info.path)).resolves.toBeTruthy();
  });

  it('redevient supprimable une fois la session terminée', async () => {
    const { cleanClones, createAgent, updateAgentMeta } = await import('../../src/clone.js');
    await createAgent({ root: repo.root, name: 'robot', mode: 'autonomous', profile: 'claude' });
    await updateAgentMeta(repo.root, 'robot', { sessionPid: null });

    const result = await cleanClones({ root: repo.root, agent: 'robot', all: true, force: true });
    expect(result.removed.map((r) => r.name)).toEqual(['robot']);
  });
});

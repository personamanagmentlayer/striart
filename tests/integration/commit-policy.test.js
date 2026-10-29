import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { simpleGit } from 'simple-git';
import { createTempRepo } from '../helpers/temp-repo.js';
import { initStriart } from '../../src/init.ts';
import { runAutonomousTask } from '../../src/orchestrator.ts';
import { listMergeHistory } from '../../src/history.ts';

const FAKE_FILES = fileURLToPath(new URL('../helpers/fake-agent-files.cjs', import.meta.url));
const GATE_OK = 'node -e "process.exit(0)"';
const GATE_KO = 'node -e "process.exit(1)"';
const exists = async (p) => Boolean(await stat(p).catch(() => null));
/** Contenu d'un fichier du worktree principal, fins de ligne normalisées (core.autocrlf). */
const readText = async (p) => (await readFile(p, 'utf8')).replaceAll('\r\n', '\n');

async function setConfig(root, config, profile = {}) {
  await writeFile(
    path.join(root, '.striartrc.json'),
    JSON.stringify({
      testCommand: GATE_OK,
      agentProfiles: {
        files: { command: process.execPath, args: [FAKE_FILES, '{{prompt}}'], ...profile },
      },
      ...config,
    }),
  );
}

function agentDoes(spec) {
  process.env.FAKE_AGENT_SPEC = JSON.stringify(spec);
}

/** Fichiers et métadonnées du commit `sha` (dans le repo principal). */
async function commitInfo(git, sha) {
  const [author, committer, body] = await Promise.all(
    ['%an <%ae>', '%cn <%ce>', '%B'].map(async (f) =>
      (await git.raw(['log', '-1', `--format=${f}`, sha])).trim(),
    ),
  );
  const files = (await git.raw(['diff-tree', '--no-commit-id', '--name-only', '-r', sha]))
    .split('\n')
    .filter(Boolean)
    .sort();
  return { author, committer, body, files };
}

describe('contrat de commit (I3) — mode autonome', () => {
  let repo;

  beforeEach(async () => {
    repo = await createTempRepo();
    await mkdir(path.join(repo.root, 'docs'), { recursive: true });
    await writeFile(path.join(repo.root, 'docs', 'guide.md'), 'guide v1\n');
    await repo.git.add(['docs/guide.md']);
    await repo.git.commit('docs: guide');
    await initStriart(repo.root);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, json: async () => ({ response: '{"files":["src/a.js"]}' }) })),
    );
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    delete process.env.FAKE_AGENT_SPEC;
    await repo.cleanup();
  });

  const run = (extra = {}) =>
    runAutonomousTask({
      root: repo.root,
      agent: 'agent-a',
      prompt: 'Ajoute le module a\nDétails sur deux lignes',
      profile: 'files',
      ...extra,
    });

  it("défaut 'agent' : rien de committé par l'agent → EMPTY / NO_COMMIT, aucun commit Striart", async () => {
    await setConfig(repo.root, {});
    agentDoes({ write: { 'src/a.js': 'a\n' } });

    const result = await run();

    expect(result.status).toBe('EMPTY');
    expect(result.keptCode).toBe('NO_COMMIT');
    expect(result.commit).toBeNull();
    expect(result.merge).toBeNull();
    expect(await exists(path.join(result.clonePath, 'src', 'a.js'))).toBe(true);
  });

  it("agent-then-striart : l'agent n'a rien committé → commit Striart, puis garde + gate + merge", async () => {
    await setConfig(repo.root, { commitPolicy: 'agent-then-striart' });
    agentDoes({ write: { 'src/a.js': 'export const a = 1;\n' }, remove: ['docs/guide.md'] });

    const result = await run();

    expect(result.status).toBe('MERGED');
    expect(result.cleaned).toBe(true);
    expect(result.commit).toMatchObject({
      policy: 'agent-then-striart',
      status: 'COMMITTED',
      files: ['docs/guide.md', 'src/a.js'],
      author: { name: 'files (Striart agent)', email: 'files.agent@striart.invalid' },
      committer: { name: 'Striart Test', email: 'striart-test@example.com' },
    });
    expect(result.merge.status).toBe('MERGED');
    // Le travail est dans main (ajout ET suppression), mergé par le chemin normal.
    expect(await readText(path.join(repo.root, 'src', 'a.js'))).toContain('a = 1');
    expect(await exists(path.join(repo.root, 'docs', 'guide.md'))).toBe(false);

    const info = await commitInfo(repo.git, result.commit.sha);
    expect(info.author).toBe('files (Striart agent) <files.agent@striart.invalid>');
    expect(info.committer).toBe('Striart Test <striart-test@example.com>');
    expect(info.body.split('\n')[0]).toBe('striart(agent-a): Ajoute le module a');
    expect(info.body).toMatch(/^Striart-Commit-Policy: agent-then-striart$/m);
    // L'historique Striart ne prend pas le commit Striart pour un merge.
    const history = await listMergeHistory({ root: repo.root });
    expect(history).toHaveLength(1);
    expect(history[0].agentSha).toBe(result.commit.sha.slice(0, 8));
  });

  it("agent-then-striart : l'agent a committé → ses commits gardés, aucun commit Striart", async () => {
    await setConfig(repo.root, { commitPolicy: 'agent-then-striart' });
    agentDoes({ write: { 'src/a.js': 'a\n' }, commit: true });

    const result = await run();

    expect(result.status).toBe('MERGED');
    expect(result.commit.status).toBe('SKIPPED_AGENT_COMMITTED');
    const head = (await repo.git.raw(['log', '-1', '--format=%an', 'HEAD^2'])).trim();
    expect(head).toBe('Fake Agent');
  });

  it("'striart' : committe le reste même après des commits de l'agent", async () => {
    await setConfig(repo.root, { commitPolicy: 'striart' });
    agentDoes({ write: { 'src/a.js': 'a\n' }, commit: true, after: { 'src/b.js': 'b\n' } });

    const result = await run();

    expect(result.status).toBe('MERGED');
    expect(result.commit).toMatchObject({ status: 'COMMITTED', files: ['src/b.js'] });
    expect(await readText(path.join(repo.root, 'src', 'a.js'))).toBe('a\n');
    expect(await readText(path.join(repo.root, 'src', 'b.js'))).toBe('b\n');
  });

  it('secret jamais committé : .env (même indexé par l’agent) et *.key restent hors du commit', async () => {
    await setConfig(repo.root, { commitPolicy: 'striart' });
    agentDoes({
      write: {
        '.env': 'API_KEY=secret\n',
        'config/prod.key': '-----BEGIN-----\n',
        'src/a.js': 'a\n',
      },
      stage: ['.env'],
    });

    const result = await run();

    expect(result.commit.status).toBe('COMMITTED');
    expect(result.commit.files).toEqual(['src/a.js']);
    expect(result.commit.excluded.secrets).toEqual(['.env', 'config/prod.key']);
    const info = await commitInfo(repo.git, result.commit.sha);
    expect(info.files).toEqual(['src/a.js']);
    expect(await exists(path.join(repo.root, '.env'))).toBe(false);
    expect(await exists(path.join(repo.root, 'config', 'prod.key'))).toBe(false);
    // Les secrets restent dans le clone, jamais supprimés en silence : clone conservé.
    expect(result.status).toBe('MERGED');
    expect(result.cleaned).toBe(false);
    expect(result.keptCode).toBe('CLEANUP_SKIPPED');
    expect(await exists(path.join(result.clonePath, '.env'))).toBe(true);
  });

  it('fichier injecté jamais committé (exclu via .git/info/exclude), même suivi', async () => {
    await setConfig(repo.root, { commitPolicy: 'striart' });
    agentDoes({
      write: {
        'STRIART-INSTRUCTIONS.md': 'consignes injectées\n',
        'docs/guide.md': 'guide réécrit par injection\n',
        'src/a.js': 'a\n',
      },
      exclude: ['STRIART-INSTRUCTIONS.md', 'docs/guide.md'],
    });

    const result = await run();

    expect(result.commit.files).toEqual(['src/a.js']);
    expect(result.commit.excluded.injected).toEqual(['docs/guide.md']);
    const info = await commitInfo(repo.git, result.commit.sha);
    expect(info.files).toEqual(['src/a.js']);
    expect(await readText(path.join(repo.root, 'docs', 'guide.md'))).toBe('guide v1\n');
    expect(await exists(path.join(repo.root, 'STRIART-INSTRUCTIONS.md'))).toBe(false);
  });

  it('sorti sans modification → EMPTY / NO_CHANGES', async () => {
    await setConfig(repo.root, { commitPolicy: 'striart' });
    agentDoes({});
    const none = await run();
    expect(none.status).toBe('EMPTY');
    expect(none.keptCode).toBe('NO_CHANGES');
    expect(none.commit.status).toBe('NOTHING_TO_COMMIT');
  });

  it('seuls des secrets laissés → EMPTY / ONLY_EXCLUDED_CHANGES, rien de committé', async () => {
    await setConfig(repo.root, { commitPolicy: 'striart' });
    agentDoes({ write: { '.env.local': 'X=1' } });
    const onlySecrets = await run();
    expect(onlySecrets.status).toBe('EMPTY');
    expect(onlySecrets.keptCode).toBe('ONLY_EXCLUDED_CHANGES');
    expect(onlySecrets.commit.excluded.secrets).toEqual(['.env.local']);
  });

  it('commit Striart puis Test Gate rouge → MERGE_BLOCKED (le gate reste l’autorité)', async () => {
    await setConfig(repo.root, { commitPolicy: 'agent-then-striart', testCommand: GATE_KO });
    agentDoes({ write: { 'src/a.js': 'a\n' } });

    const result = await run();

    expect(result.commit.status).toBe('COMMITTED');
    expect(result.status).toBe('MERGE_BLOCKED');
    expect(result.merge.status).toBe('GATE_FAILED');
    expect(await exists(path.join(repo.root, 'src', 'a.js'))).toBe(false);
  });

  it('commit Striart d’un chemin protégé → la garde I2 refuse le merge', async () => {
    await setConfig(repo.root, { commitPolicy: 'striart' });
    agentDoes({ write: { 'AGENTS.md': '# injection\n', 'src/a.js': 'a\n' } });

    const result = await run();

    expect(result.commit.files).toEqual(['AGENTS.md', 'src/a.js']);
    expect(result.status).toBe('MERGE_BLOCKED');
    expect(result.keptDetail).toBe('PROTECTED_PATHS_CHANGED');
    expect(await exists(path.join(repo.root, 'AGENTS.md'))).toBe(false);
  });

  it("'human' : personne ne committe, clone conservé pour revue (NO_COMMIT)", async () => {
    await setConfig(repo.root, { commitPolicy: 'human' });
    agentDoes({ write: { 'src/a.js': 'a\n' } });

    const result = await run();

    expect(result.status).toBe('EMPTY');
    expect(result.keptCode).toBe('NO_COMMIT');
    expect(result.keptDetail).toBe('human');
    expect(result.commit).toBeNull();
  });

  it('clone hors de sa branche de tâche → COMMIT_REFUSED, rien de committé', async () => {
    await setConfig(repo.root, { commitPolicy: 'striart' });
    agentDoes({ write: { 'src/a.js': 'a\n' }, checkout: 'ailleurs' });

    const result = await run();

    expect(result.status).toBe('COMMIT_REFUSED');
    expect(result.keptCode).toBe('COMMIT_REFUSED');
    expect(result.keptDetail).toBe('NOT_ON_TASK_BRANCH');
    expect(result.merge).toBeNull();
    const clone = simpleGit(result.clonePath);
    expect((await clone.status()).files.length).toBeGreaterThan(0);
  });

  it('politique, auteur et gabarit propres au profil priment sur le global', async () => {
    await setConfig(
      repo.root,
      { commitPolicy: 'agent' },
      {
        commitPolicy: 'agent-then-striart',
        commitAuthor: { name: 'Files Bot', email: 'bot@corp.test' },
        commitMessage: 'feat({{profile}}): {{task}} [{{taskId}}]',
      },
    );
    agentDoes({ write: { 'src/a.js': 'a\n' } });

    const result = await run();

    expect(result.commit.status).toBe('COMMITTED');
    const info = await commitInfo(repo.git, result.commit.sha);
    expect(info.author).toBe('Files Bot <bot@corp.test>');
    expect(info.body.split('\n')[0]).toMatch(/^feat\(files\): Ajoute le module a \[[^\]]+\]$/);
  });
});

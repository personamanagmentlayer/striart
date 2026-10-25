/**
 * Promotion et rollback — garde-fous avant l'effet irréversible (revue du
 * noyau K-M10, K-M11) :
 *  - le Test Gate de promotion teste le WORKTREE : si le staging a bougé ou
 *    si le gate a modifié des fichiers suivis, le SHA promu n'est plus celui
 *    qui a été testé → refus, rien n'est promu ;
 *  - `rollbackLastMerge` revérifie le verrou avant reset --hard / revert ;
 *  - « poussé ? » se décide sur la référence FRAÎCHE de la cible distante
 *    (fetch), et sans certitude on choisit `revert` (jamais de réécriture d'un
 *    historique peut-être publié).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execa } from 'execa';

const hooks = vi.hoisted(() => ({
  /** @type {null | ((dir: string, args: string[]) => Promise<void>)} */
  afterRaw: null,
}));

vi.mock('simple-git', async (importOriginal) => {
  const actual = await importOriginal();
  const wrap = (git, dir) => {
    const proxy = new Proxy(git, {
      get(target, prop) {
        const value = Reflect.get(target, prop);
        if (typeof value !== 'function') return value;
        if (prop === 'raw') {
          return async (...args) => {
            const out = await value.apply(target, args);
            if (hooks.afterRaw) await hooks.afterRaw(dir, args.flat());
            return out;
          };
        }
        return (...args) => {
          const out = value.apply(target, args);
          return out === target ? proxy : out;
        };
      },
    });
    return proxy;
  };
  const simpleGit = (dirOrOptions, options) => {
    const dir =
      typeof dirOrOptions === 'string' ? dirOrOptions : (dirOrOptions?.baseDir ?? process.cwd());
    return wrap(actual.simpleGit(dirOrOptions, options), path.resolve(dir));
  };
  return { ...actual, simpleGit, default: simpleGit };
});

const { createTempRepo } = await import('../helpers/temp-repo.js');
const { initStriart } = await import('../../src/init.js');
const { createAgent } = await import('../../src/clone.js');
const { mergeAgentCommit, promoteStaging, rollbackLastMerge } =
  await import('../../src/orchestrator.js');

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

describe('promotion — le SHA promu est celui qui a été testé (intégration)', () => {
  let repo;
  const STAGING = 'striart/staging';

  beforeEach(async () => {
    hooks.afterRaw = null;
    repo = await createTempRepo();
    await initStriart(repo.root);
    await git(repo.root, 'checkout', '-q', '-b', STAGING);
    await commitIn(repo.root, 'f.js', 'export const f = 1;\n', 'feat: f (testé)');
  });

  afterEach(async () => {
    await repo.cleanup();
  });

  async function gateScript(name, body) {
    const file = path.join(repo.root, '.striart', name);
    await writeFile(file, body);
    return `node ${JSON.stringify(file)}`;
  }

  it('un fichier SUIVI modifié par le gate → MAIN_DIRTY, rien n’est promu', async () => {
    const mainBefore = await git(repo.root, 'rev-parse', 'main');
    const testCommand = await gateScript(
      'dirty-gate.cjs',
      "require('node:fs').appendFileSync('f.js', '// modifié par le gate\\n');",
    );
    await setConfig(repo.root, { testCommand, targetBranch: STAGING, mainBranch: 'main' });

    const error = await promoteStaging({ root: repo.root }).catch((e) => e);

    expect(error).toMatchObject({ code: 'MAIN_DIRTY' });
    expect(await git(repo.root, 'rev-parse', 'main')).toBe(mainBefore);
  });

  it('un commit au CONTENU différent arrivé pendant le gate → MERGE_STATE_CHANGED, rien n’est promu', async () => {
    const mainBefore = await git(repo.root, 'rev-parse', 'main');
    const testCommand = await gateScript(
      'late-content-commit.cjs',
      "const { execFileSync: x } = require('node:child_process'); require('node:fs').writeFileSync('g.js', 'export const g = 1;\\n'); x('git', ['add', 'g.js']); x('git', ['-c', 'user.name=x', '-c', 'user.email=x@example.com', 'commit', '-q', '-m', 'non testé']);",
    );
    await setConfig(repo.root, { testCommand, targetBranch: STAGING, mainBranch: 'main' });

    const error = await promoteStaging({ root: repo.root }).catch((e) => e);

    expect(error).toMatchObject({ code: 'MERGE_STATE_CHANGED' });
    expect(await git(repo.root, 'rev-parse', 'main')).toBe(mainBefore);
  });

  it('témoin : gate qui ne touche à rien → promotion normale', async () => {
    await setConfig(repo.root, {
      gateContainer: 'process',
      testCommand: GATE_OK,
      targetBranch: STAGING,
      mainBranch: 'main',
    });

    const result = await promoteStaging({ root: repo.root });

    expect(result.status).toBe('PROMOTED');
    expect(await git(repo.root, 'rev-parse', 'main')).toBe(
      await git(repo.root, 'rev-parse', STAGING),
    );
  });
});

describe('rollback — verrou et historique publié (intégration)', () => {
  let repo;
  let origin;
  let agent;

  beforeEach(async () => {
    hooks.afterRaw = null;
    repo = await createTempRepo();
    await initStriart(repo.root);
    await setConfig(repo.root, {
      gateContainer: 'process',
      testCommand: GATE_OK,
      semanticMerge: false,
    });
    origin = await mkdtemp(path.join(os.tmpdir(), 'striart-origin-'));
    await git(origin, 'init', '-q', '--bare', '-b', 'main');
    await git(repo.root, 'remote', 'add', 'origin', origin);
    await git(repo.root, 'push', '-q', '-u', 'origin', 'main');
    agent = await createAgent({ root: repo.root, name: 'agent-a' });
    await commitIn(agent.path, 'f.js', 'export const f = 1;\n', 'feat: f');
    const merged = await mergeAgentCommit({ root: repo.root, agent: 'agent-a' });
    expect(merged.status).toBe('MERGED');
  });

  afterEach(async () => {
    hooks.afterRaw = null;
    await rm(origin, { recursive: true, force: true, maxRetries: 5 }).catch(() => {});
    await repo.cleanup();
  });

  it('merge publié par un autre chemin (référence distante locale PÉRIMÉE) → revert, historique publié intact', async () => {
    // Poussé vers l'URL (pas le nom du remote) : refs/remotes/origin/main reste périmée.
    await git(repo.root, 'push', '-q', origin, 'HEAD:main');
    const published = await git(repo.root, 'rev-parse', 'HEAD');

    const result = await rollbackLastMerge({ root: repo.root });

    expect(result).toMatchObject({ status: 'ROLLED_BACK', mode: 'revert' });
    // Le merge publié est toujours un ancêtre de HEAD : aucune réécriture.
    expect(
      await git(repo.root, 'merge-base', '--is-ancestor', published, 'HEAD').then(() => true),
    ).toBe(true);
  });

  it('remote injoignable : pas de certitude → revert (jamais de reset --hard sur un historique peut-être publié)', async () => {
    await rm(origin, { recursive: true, force: true, maxRetries: 5 });

    const result = await rollbackLastMerge({ root: repo.root });

    expect(result).toMatchObject({ status: 'ROLLED_BACK', mode: 'revert' });
  });

  it('rien de publié et remote joignable → reset, comme avant', async () => {
    const result = await rollbackLastMerge({ root: repo.root });

    expect(result).toMatchObject({ status: 'ROLLED_BACK', mode: 'reset' });
  });

  it('verrou repris par un autre juste avant l’effet → LOCK_LOST, HEAD intact', async () => {
    const before = await git(repo.root, 'rev-parse', 'HEAD');
    const lockFile = path.join(repo.root, '.striart', 'main.lock');
    let stolen = false;
    hooks.afterRaw = async (dir, args) => {
      // Dernier contrôle de « poussé ? » : juste avant reset / revert.
      if (stolen || args[0] !== 'rev-list' || path.resolve(dir) !== path.resolve(repo.root)) return;
      stolen = true;
      const info = JSON.parse(await readFile(lockFile, 'utf8'));
      await writeFile(lockFile, JSON.stringify({ ...info, token: 'autre' }));
    };

    const error = await rollbackLastMerge({ root: repo.root }).catch((e) => e);

    expect(stolen).toBe(true);
    expect(error).toMatchObject({ code: 'LOCK_LOST' });
    expect(await git(repo.root, 'rev-parse', 'HEAD')).toBe(before);
    await rm(lockFile, { force: true });
  });
});

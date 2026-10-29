/**
 * Intégrité du merge (lot L1, audit de concurrence) :
 *  - le SHA enregistré (sujet de merge, lastMergedCommit, résultat) est
 *    EXACTEMENT celui qui a été mergé (second parent du commit de merge),
 *    même si l'agent commite pendant le merge ;
 *  - aucun `FETCH_HEAD` n'est lu : un fetch concurrent (autre contexte,
 *    humain dans le clone ou le principal) est sans effet ;
 *  - avant le commit : verrou toujours à nous (LOCK_LOST), MERGE_HEAD et HEAD
 *    inchangés (MERGE_STATE_CHANGED) — sinon refus, rien n'est commité ;
 *  - la promotion pousse le SHA exact qui a passé le Test Gate.
 *
 * Les points d'injection passent par un enrobage de simple-git (le vrai git
 * tourne dessous) : c'est le seul moyen déterministe de placer un événement
 * concurrent ENTRE deux commandes git de l'orchestrateur.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { execa } from 'execa';

const hooks = vi.hoisted(() => ({
  /** @type {null | ((dir: string, args: string[]) => Promise<void>)} */
  afterRevparse: null,
  /** @type {null | ((dir: string, args: string[]) => Promise<void>)} */
  afterFetch: null,
}));

vi.mock('simple-git', async (importOriginal) => {
  const actual = await importOriginal();
  const wrap = (git, dir) => {
    const proxy = new Proxy(git, {
      get(target, prop) {
        const value = Reflect.get(target, prop);
        if (typeof value !== 'function') return value;
        if (prop === 'revparse') {
          return async (...args) => {
            const out = await value.apply(target, args);
            if (hooks.afterRevparse) await hooks.afterRevparse(dir, args.flat());
            return out;
          };
        }
        if (prop === 'fetch' || prop === 'raw') {
          return async (...args) => {
            const out = await value.apply(target, args);
            const flat = args.flat();
            const isFetch = prop === 'fetch' || flat[0] === 'fetch';
            if (isFetch && hooks.afterFetch) await hooks.afterFetch(dir, flat);
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
const { initStriart } = await import('../../src/init.ts');
const { createAgent, readRegistry } = await import('../../src/clone.ts');
const {
  applyTicketResolution,
  checkAgentsBehind,
  mergeAgentCommit,
  promoteStaging,
  reconcile,
  stopAgent,
} = await import('../../src/orchestrator.ts');
const { parseMergeSubject } = await import('../../src/merge-subject.ts');
const { prepareResolutionScaffold, safeFileName } = await import('../../src/conflicts.ts');
const { en } = await import('../../src/cli/i18n/en.ts');
const { reserveMainSession, withMainLock } = await import('../../src/lock.ts');
const { stopMainSession } = await import('../../src/main-session.ts');
const { readState } = await import('../../src/state.ts');

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
    '-m',
    message,
  );
  return git(dir, 'rev-parse', 'HEAD');
}

/** Script de Test Gate écrit sous .striart/ (ignoré par git : le principal reste propre). */
async function gateScript(root, name, body) {
  const file = path.join(root, '.striart', name);
  await writeFile(file, body);
  return file;
}

async function expectRecordedEqualsMerged(root, result) {
  const head = await git(root, 'rev-parse', 'HEAD');
  const secondParent = await git(root, 'rev-parse', 'HEAD^2');
  const subject = parseMergeSubject(await git(root, 'log', '-1', '--format=%s', 'HEAD'));
  expect(result.status).toBe('MERGED');
  expect(result.mergeSha).toBe(head);
  expect(result.sha).toBe(secondParent);
  expect(subject.agentSha).toBe(secondParent.slice(0, 8));
  expect((await readRegistry(root))['agent-a'].lastMergedCommit).toBe(secondParent);
}

// Budget : celui du projet `integration` (90 s, vitest.config.js) — mesuré le
// 2026-10-24, le cas le plus lent dure ~24 s isolé (clone, fetchs, rebase,
// merge et Test Gate réels sous l'enrobage de simple-git), soit ~3x de marge
// sous la charge de la suite complète. Ne pas relever sans nouvelle mesure.
describe('intégrité du merge sous concurrence (intégration)', () => {
  let repo;
  let agent;

  beforeEach(async () => {
    hooks.afterRevparse = null;
    hooks.afterFetch = null;
    repo = await createTempRepo();
    await initStriart(repo.root);
    await setConfig(repo.root, { testCommand: GATE_OK, semanticMerge: false });
    agent = await createAgent({ root: repo.root, name: 'agent-a' });
  });

  afterEach(async () => {
    hooks.afterRevparse = null;
    hooks.afterFetch = null;
    await rm(path.join(repo.root, '.striart', 'main.lock'), { force: true });
    await repo.cleanup();
  });

  it("commit de l'agent intercalé entre la lecture de sa tête et le fetch → le SHA enregistré est le second parent du merge", async () => {
    await commitIn(agent.path, 'a.js', 'export const a = 1;\n', 'feat: a');
    const clone = path.resolve(agent.path);
    let injected = 0;
    const inject = async () => {
      injected += 1;
      await commitIn(
        clone,
        `late-${injected}.js`,
        `export const l = ${injected};\n`,
        'feat: tardif',
      );
    };
    // Lecture de la tête du clone (ancien chemin) → l'agent commite aussitôt.
    hooks.afterRevparse = async (dir, args) => {
      if (dir === clone && args.length === 1 && args[0] === 'HEAD') {
        hooks.afterRevparse = null;
        await inject();
      }
    };
    // Et juste après le fetch par le principal : l'agent commite encore.
    hooks.afterFetch = async (dir) => {
      if (dir === path.resolve(repo.root)) {
        hooks.afterFetch = null;
        await inject();
      }
    };

    const result = await mergeAgentCommit({ root: repo.root, agent: 'agent-a' });
    hooks.afterRevparse = null;
    hooks.afterFetch = null;
    expect(injected).toBeGreaterThan(0);
    await expectRecordedEqualsMerged(repo.root, result);
  });

  it('FETCH_HEAD écrasé par un fetch concurrent après chaque fetch → sync, merge et retard mesuré non affectés', async () => {
    // Commits « empoisonnés » : une branche sans rapport, 3 commits devant.
    await git(repo.root, 'checkout', '-q', '-b', 'poison');
    for (const n of [1, 2, 3]) await commitIn(repo.root, `poison-${n}.js`, 'x\n', `poison ${n}`);
    const poison = await git(repo.root, 'rev-parse', 'HEAD');
    await git(repo.root, 'checkout', '-q', 'main');
    // Le clone doit posséder ces objets (sinon un rebase dessus échouerait
    // pour une autre raison) : fetch explicite, hors de l'orchestrateur.
    await git(agent.path, 'fetch', '-q', path.resolve(repo.root), 'poison');

    await commitIn(repo.root, 'main-1.js', 'export const m = 1;\n', 'feat: main avance');
    const mainTip = await git(repo.root, 'rev-parse', 'HEAD');
    await commitIn(agent.path, 'a.js', 'export const a = 1;\n', 'feat: a');

    hooks.afterFetch = async (dir) => {
      await writeFile(path.join(dir, '.git', 'FETCH_HEAD'), `${poison}\t\tbranch 'poison' of x\n`);
    };

    const [behind] = await checkAgentsBehind({ root: repo.root });
    expect(behind).toMatchObject({ agent: 'agent-a', behind: 1 });

    const result = await mergeAgentCommit({ root: repo.root, agent: 'agent-a' });
    hooks.afterFetch = null;
    expect(result.rebase?.status).toBe('REBASED');
    expect(result.rebase.mainHead).toBe(mainTip);
    await expectRecordedEqualsMerged(repo.root, result);
    // Rien de la branche empoisonnée n'est arrivé, ni dans le principal ni dans le clone.
    await expect(readFile(path.join(repo.root, 'poison-1.js'), 'utf8')).rejects.toThrow();
    expect(await git(agent.path, 'rev-parse', 'HEAD^')).toBe(mainTip);
    // Les refs privées ne sont jamais des branches (ni watcher, ni push).
    expect(await git(agent.path, 'for-each-ref', '--format=%(refname)', 'refs/heads')).not.toMatch(
      /striart\/(target|behind)/,
    );
  });

  it('MERGE_HEAD remplacé pendant le Test Gate → MERGE_STATE_CHANGED, rien de commité', async () => {
    const initial = await git(repo.root, 'rev-parse', 'HEAD');
    const script = await gateScript(
      repo.root,
      'forge-merge-head.cjs',
      "require('node:fs').writeFileSync(require('node:path').join(process.cwd(), '.git', 'MERGE_HEAD'), process.argv[2] + '\\n');",
    );
    await setConfig(repo.root, {
      testCommand: `node ${JSON.stringify(script)} ${initial}`,
      semanticMerge: false,
    });
    await commitIn(agent.path, 'a.js', 'export const a = 1;\n', 'feat: a');

    const error = await mergeAgentCommit({ root: repo.root, agent: 'agent-a' }).catch((e) => e);
    expect(error).toMatchObject({ code: 'MERGE_STATE_CHANGED', kind: 'refusal' });
    expect(error.details).toMatchObject({ agent: 'agent-a', actualMergeHead: initial });
    expect(en.errors('MERGE_STATE_CHANGED', error.details)).toMatch(/nothing was committed/);
    expect(await git(repo.root, 'rev-parse', 'HEAD')).toBe(initial);
    expect((await readRegistry(repo.root))['agent-a'].lastMergedCommit ?? null).toBeNull();
  });

  it('verrou repris par un autre pendant le Test Gate → LOCK_LOST, rien de commité, verrou de l’autre intact', async () => {
    const initial = await git(repo.root, 'rev-parse', 'HEAD');
    const script = await gateScript(
      repo.root,
      'steal-lock.cjs',
      [
        "const fs = require('node:fs');",
        "const file = require('node:path').join(process.cwd(), '.striart', 'main.lock');",
        "const info = JSON.parse(fs.readFileSync(file, 'utf8'));",
        "fs.writeFileSync(file, JSON.stringify({ ...info, token: 'intrus', label: 'intrus' }));",
      ].join('\n'),
    );
    await setConfig(repo.root, {
      testCommand: `node ${JSON.stringify(script)}`,
      semanticMerge: false,
    });
    await commitIn(agent.path, 'a.js', 'export const a = 1;\n', 'feat: a');

    const error = await mergeAgentCommit({ root: repo.root, agent: 'agent-a' }).catch((e) => e);
    expect(error).toMatchObject({ code: 'LOCK_LOST', kind: 'refusal' });
    expect(en.errors('LOCK_LOST', error.details)).toMatch(/merge:agent-a/);
    expect(await git(repo.root, 'rev-parse', 'HEAD')).toBe(initial);
    const lock = JSON.parse(await readFile(path.join(repo.root, '.striart', 'main.lock'), 'utf8'));
    expect(lock.token).toBe('intrus');
  });

  it('résolution manuelle : MERGE_HEAD remplacé pendant le Test Gate → MERGE_STATE_CHANGED, ticket ouvert', async () => {
    await writeFile(path.join(repo.root, 'app.js'), 'const v = "main";\n');
    await git(repo.root, 'add', 'app.js');
    await git(repo.root, 'commit', '-q', '-m', 'feat: main');
    await commitIn(agent.path, 'app.js', 'const v = "agent";\n', 'feat: agent');
    const conflict = await mergeAgentCommit({ root: repo.root, agent: 'agent-a' });
    expect(conflict.status).toBe('CONFLICT');
    await prepareResolutionScaffold(repo.root, conflict.ticket.id);
    await writeFile(
      path.join(conflict.ticket.dir, `${safeFileName('app.js')}.resolved`),
      'const v = "humain";\n',
    );
    const before = await git(repo.root, 'rev-parse', 'HEAD');
    const script = await gateScript(
      repo.root,
      'forge-merge-head.cjs',
      "require('node:fs').writeFileSync(require('node:path').join(process.cwd(), '.git', 'MERGE_HEAD'), process.argv[2] + '\\n');",
    );
    await setConfig(repo.root, {
      testCommand: `node ${JSON.stringify(script)} ${before}`,
      semanticMerge: false,
    });

    await expect(
      applyTicketResolution({ root: repo.root, ticketId: conflict.ticket.id }),
    ).rejects.toMatchObject({ code: 'MERGE_STATE_CHANGED' });
    expect(await git(repo.root, 'rev-parse', 'HEAD')).toBe(before);
  });

  it('promotion : un commit arrivé sur le staging pendant le Test Gate n’est PAS promu', async () => {
    const STAGING = 'striart/staging';
    await git(repo.root, 'checkout', '-q', '-b', STAGING);
    await commitIn(repo.root, 'f.js', 'export const f = 1;\n', 'feat: f (testé)');
    const tested = await git(repo.root, 'rev-parse', 'HEAD');
    const script = await gateScript(
      repo.root,
      'late-commit.cjs',
      "require('node:child_process').execFileSync('git', ['-c', 'user.name=x', '-c', 'user.email=x@example.com', 'commit', '--allow-empty', '-q', '-m', 'non testé'], { cwd: process.cwd() });",
    );
    await setConfig(repo.root, {
      testCommand: `node ${JSON.stringify(script)}`,
      targetBranch: STAGING,
      mainBranch: 'main',
    });

    const result = await promoteStaging({ root: repo.root });
    expect(result).toMatchObject({ status: 'PROMOTED', sha: tested });
    expect(await git(repo.root, 'rev-parse', 'main')).toBe(tested);
  });

  it('I2 : SHA de l’agent déjà contenu dans la cible → UP_TO_DATE (alreadyMerged), sans Test Gate', async () => {
    // Gate rouge : s'il tournait, le résultat serait GATE_FAILED / MERGE_STATE_CHANGED.
    await setConfig(repo.root, { testCommand: 'node -e "process.exit(1)"', semanticMerge: false });
    const sha = await commitIn(agent.path, 'a.js', 'export const a = 1;\n', 'feat: a');
    // Le travail de l'agent est arrivé dans la cible par un autre chemin (fast-forward humain).
    await git(
      repo.root,
      'fetch',
      '-q',
      path.resolve(agent.path),
      (await readRegistry(repo.root))['agent-a'].branch,
    );
    await git(repo.root, 'merge', '-q', '--ff-only', sha);

    const result = await mergeAgentCommit({ root: repo.root, agent: 'agent-a' });
    expect(result).toMatchObject({ status: 'UP_TO_DATE', alreadyMerged: true });
    expect((await readRegistry(repo.root))['agent-a'].lastMergedCommit).toBe(result.sha);
    expect(await git(repo.root, 'rev-parse', 'HEAD')).toBe(sha); // aucun commit de merge
  });

  it('I2 : même cas sans rebase préalable (autoRebase: false)', async () => {
    await setConfig(repo.root, {
      testCommand: 'node -e "process.exit(1)"',
      semanticMerge: false,
      autoRebase: false,
    });
    const sha = await commitIn(agent.path, 'a.js', 'export const a = 1;\n', 'feat: a');
    await git(
      repo.root,
      'fetch',
      '-q',
      path.resolve(agent.path),
      (await readRegistry(repo.root))['agent-a'].branch,
    );
    await git(repo.root, 'merge', '-q', '--no-ff', '-m', 'merge humain', sha);
    const result = await mergeAgentCommit({ root: repo.root, agent: 'agent-a' });
    expect(result).toMatchObject({ status: 'UP_TO_DATE', alreadyMerged: true, sha });
  });

  it('B1 (garde d’index) : index modifié pendant le Test Gate → MERGE_STATE_CHANGED, rien de commité', async () => {
    const initial = await git(repo.root, 'rev-parse', 'HEAD');
    const script = await gateScript(
      repo.root,
      'touch-index.cjs',
      [
        "const fs = require('node:fs');",
        "fs.writeFileSync('intrus.js', 'contamination\\n');",
        "require('node:child_process').execFileSync('git', ['add', 'intrus.js']);",
      ].join('\n'),
    );
    await setConfig(repo.root, {
      testCommand: `node ${JSON.stringify(script)}`,
      semanticMerge: false,
    });
    await commitIn(agent.path, 'a.js', 'export const a = 1;\n', 'feat: a');
    const error = await mergeAgentCommit({ root: repo.root, agent: 'agent-a' }).catch((e) => e);
    expect(error).toMatchObject({ code: 'MERGE_STATE_CHANGED', details: { indexChanged: true } });
    expect(await git(repo.root, 'rev-parse', 'HEAD')).toBe(initial);
  });

  it('m5 : après MERGE_STATE_CHANGED, la prochaine opération REFUSE d’annuler le merge tiers (MERGE_RECOVERY_BLOCKED) ; levée par l’humain', async () => {
    const initial = await git(repo.root, 'rev-parse', 'HEAD');
    const script = await gateScript(
      repo.root,
      'forge-merge-head.cjs',
      "require('node:fs').writeFileSync(require('node:path').join(process.cwd(), '.git', 'MERGE_HEAD'), process.argv[2] + '\\n');",
    );
    await setConfig(repo.root, {
      testCommand: `node ${JSON.stringify(script)} ${initial}`,
      semanticMerge: false,
    });
    await commitIn(agent.path, 'a.js', 'export const a = 1;\n', 'feat: a');
    await expect(mergeAgentCommit({ root: repo.root, agent: 'agent-a' })).rejects.toMatchObject({
      code: 'MERGE_STATE_CHANGED',
    });

    const blocked = await withMainLock(repo.root, 'suivante', async () => 'jamais').catch((e) => e);
    expect(blocked).toMatchObject({
      code: 'MERGE_RECOVERY_BLOCKED',
      kind: 'refusal',
      hint: 'git merge --abort',
    });
    expect(en.errors('MERGE_RECOVERY_BLOCKED', blocked.details)).toMatch(/git merge --abort/);
    // Le MERGE_HEAD tiers est toujours là : rien n'a été annulé.
    expect((await readFile(path.join(repo.root, '.git', 'MERGE_HEAD'), 'utf8')).trim()).toBe(
      initial,
    );

    // L'humain tranche (ici : il annule lui-même) → tout repart, marqueur levé.
    await git(repo.root, 'merge', '--abort');
    expect(await withMainLock(repo.root, 'reprise', async () => 'ok')).toBe('ok');
    await expect(
      readFile(path.join(repo.root, '.striart', 'merge-state-changed.json'), 'utf8'),
    ).rejects.toThrow();
  });

  it('B1 : verrou perdu pendant l’appel LLM → LOCK_LOST AVANT d’écrire la fusion dans le principal', async () => {
    await setConfig(repo.root, { testCommand: GATE_OK, semanticMerge: true });
    await writeFile(path.join(repo.root, 'app.js'), 'const v = "main";\n');
    await git(repo.root, 'add', 'app.js');
    await git(repo.root, 'commit', '-q', '-m', 'feat: main');
    await commitIn(agent.path, 'app.js', 'const v = "agent";\n', 'feat: agent');
    const lockFile = path.join(repo.root, '.striart', 'main.lock');
    // Pendant que le LLM « réfléchit », un autre process casse et reprend le verrou.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        const info = JSON.parse(await readFile(lockFile, 'utf8'));
        await writeFile(lockFile, JSON.stringify({ ...info, token: 'autre' }));
        return { ok: true, json: async () => ({ response: 'const v = "FUSION LLM";\n' }) };
      }),
    );
    try {
      await expect(mergeAgentCommit({ root: repo.root, agent: 'agent-a' })).rejects.toMatchObject({
        code: 'LOCK_LOST',
      });
    } finally {
      vi.unstubAllGlobals();
    }
    expect(await readFile(path.join(repo.root, 'app.js'), 'utf8')).not.toContain('FUSION LLM');
  });

  it('I1 : échec LLM tardif pendant un retry, après écriture du fichier 1 → abort propre + ticket + échec compté (aucun faux MERGE_STATE_CHANGED)', async () => {
    await setConfig(repo.root, {
      testCommand: 'node -e "process.exit(1)"',
      semanticGateRetries: 1,
    });
    // Deux fichiers en conflit : le retry réécrit a.js (l'index change) puis
    // le LLM échoue sur b.js — l'empreinte d'index datée d'avant le retry
    // ne doit pas être prise pour l'œuvre d'un tiers.
    for (const name of ['a.js', 'b.js']) {
      await writeFile(path.join(repo.root, name), `export const v = "main ${name}";\n`);
      await git(repo.root, 'add', name);
    }
    await git(repo.root, 'commit', '-q', '-m', 'feat: main');
    await writeFile(path.join(agent.path, 'a.js'), 'export const v = "agent a";\n');
    await writeFile(path.join(agent.path, 'b.js'), 'export const v = "agent b";\n');
    await git(agent.path, 'add', 'a.js', 'b.js');
    await git(
      agent.path,
      '-c',
      'user.name=Agent',
      '-c',
      'user.email=a@example.com',
      'commit',
      '-q',
      '-m',
      'feat: agent',
    );
    const before = await git(repo.root, 'rev-parse', 'HEAD');
    let calls = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        calls += 1;
        // 1-2 : fusion initiale (a.js, b.js) ; 3 : retry sur a.js ; 4+ : b.js échoue.
        if (calls <= 3)
          return { ok: true, json: async () => ({ response: `// fusion ${calls}\n` }) };
        throw new Error('ECONNREFUSED');
      }),
    );
    try {
      const result = await mergeAgentCommit({ root: repo.root, agent: 'agent-a' });
      expect(result.status).toBe('GATE_FAILED');
      expect(result.ticket).toBeTruthy();
    } finally {
      vi.unstubAllGlobals();
    }
    expect(calls).toBeGreaterThanOrEqual(4);
    expect(await git(repo.root, 'rev-parse', 'HEAD')).toBe(before);
    await expect(readFile(path.join(repo.root, '.git', 'MERGE_HEAD'), 'utf8')).rejects.toThrow();
    await expect(
      readFile(path.join(repo.root, '.striart', 'merge-state-changed.json'), 'utf8'),
    ).rejects.toThrow();
    expect((await readState(repo.root)).semanticFailureStreak).toBe(1);
  });

  it('M3 : marqueur impossible à écrire → MERGE_STATE_CHANGED le dit (markerWritten: false), sans promettre une protection absente', async () => {
    const initial = await git(repo.root, 'rev-parse', 'HEAD');
    // Pendant le gate : MERGE_HEAD forgé ET un DOSSIER à la place du marqueur
    // (l'écriture atomique du marqueur échouera).
    const script = await gateScript(
      repo.root,
      'forge-and-block-marker.cjs',
      [
        "const fs = require('node:fs');",
        "const path = require('node:path');",
        "fs.writeFileSync(path.join(process.cwd(), '.git', 'MERGE_HEAD'), process.argv[2] + '\\n');",
        "fs.mkdirSync(path.join(process.cwd(), '.striart', 'merge-state-changed.json'));",
      ].join('\n'),
    );
    await setConfig(repo.root, {
      testCommand: `node ${JSON.stringify(script)} ${initial}`,
      semanticMerge: false,
    });
    await commitIn(agent.path, 'a.js', 'export const a = 1;\n', 'feat: a');

    const error = await mergeAgentCommit({ root: repo.root, agent: 'agent-a' }).catch((e) => e);
    expect(error).toMatchObject({ code: 'MERGE_STATE_CHANGED', details: { markerWritten: false } });
    expect(error.message).not.toMatch(/n'annulera pas ce merge/);
    expect(en.errors('MERGE_STATE_CHANGED', error.details)).toMatch(/could not be recorded/);
  });

  it('M4 : un marqueur périmé (autre MERGE_HEAD) ne bloque pas un autre merge ; le marqueur est levé', async () => {
    const head = await git(repo.root, 'rev-parse', 'HEAD');
    await writeFile(path.join(repo.root, '.git', 'MERGE_HEAD'), `${head}\n`);
    await writeFile(
      path.join(repo.root, '.striart', 'merge-state-changed.json'),
      JSON.stringify({
        at: new Date().toISOString(),
        operation: 'merge:ancien',
        mergeHead: 'a'.repeat(40),
      }),
    );
    // Ce merge-là n'est pas celui du marqueur : récupération normale (abort).
    expect(await withMainLock(repo.root, 'suivante', async () => 'ok')).toBe('ok');
    await expect(readFile(path.join(repo.root, '.git', 'MERGE_HEAD'), 'utf8')).rejects.toThrow();
    await expect(
      readFile(path.join(repo.root, '.striart', 'merge-state-changed.json'), 'utf8'),
    ).rejects.toThrow();
  });

  it('M4 : striart lock --start (reserveMainSession) reste possible pendant que l’humain termine le merge tiers, sans l’annuler', async () => {
    const head = await git(repo.root, 'rev-parse', 'HEAD');
    await writeFile(path.join(repo.root, '.git', 'MERGE_HEAD'), `${head}\n`);
    await writeFile(
      path.join(repo.root, '.striart', 'merge-state-changed.json'),
      JSON.stringify({ at: new Date().toISOString(), operation: 'merge:agent-a', mergeHead: head }),
    );
    try {
      const session = await reserveMainSession(repo.root, {
        reason: 'terminer le merge tiers',
        pid: process.pid,
        explicitPid: true,
      });
      expect(session.pid).toBe(process.pid);
      // Le merge de l'humain est intact.
      expect((await readFile(path.join(repo.root, '.git', 'MERGE_HEAD'), 'utf8')).trim()).toBe(
        head,
      );
    } finally {
      await stopMainSession(repo.root);
    }
  });

  it('refs privées incoming : retirées par stop, et balayées par reconcile pour un agent disparu', async () => {
    const sha = await commitIn(agent.path, 'a.js', 'export const a = 1;\n', 'feat: a');
    expect((await mergeAgentCommit({ root: repo.root, agent: 'agent-a' })).status).toBe('MERGED');
    const refs = () =>
      git(repo.root, 'for-each-ref', '--format=%(refname)', 'refs/striart/incoming/');
    expect(await refs()).toContain('refs/striart/incoming/agent-a');

    await git(repo.root, 'update-ref', 'refs/striart/incoming/fantome', sha);
    await reconcile({ root: repo.root });
    expect(await refs()).not.toContain('fantome');
    expect(await refs()).toContain('refs/striart/incoming/agent-a');

    await stopAgent({ root: repo.root, agent: 'agent-a' });
    expect(await refs()).toBe('');
  });
});

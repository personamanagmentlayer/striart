/**
 * Livraison HORS verrou (lot « livraison, hooks de la cible, mode branche »).
 *
 * Invariant n°1 : le verrou principal n'est jamais tenu pendant une opération
 * longue. Le push vers `origin` (hook pre-push d'entreprise, authentification,
 * proxy lent) l'était : `finalizeMergeCommit` et `promoteStaging` poussaient
 * SOUS `withMainLock`. Le push est désormais un effet différé, exécuté après la
 * libération du verrou, du SHA EXACT testé.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execa } from 'execa';
import { createTempRepo } from '../helpers/temp-repo.js';
import { initStriart } from '../../src/init.ts';
import { createAgent } from '../../src/clone.ts';
import { withMainLock } from '../../src/lock.ts';
import {
  applyTicketResolution,
  mergeAgentCommit,
  promoteStaging,
  rollbackLastMerge,
} from '../../src/orchestrator.ts';
import { prepareResolutionScaffold } from '../../src/conflicts.ts';

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

const exists = (p) =>
  stat(p).then(
    () => true,
    () => false,
  );

async function waitFor(predicate, timeoutMs = 120_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`waitFor : délai de ${timeoutMs} ms dépassé`);
}

/**
 * Hook pre-push du principal. Mode `always` : dort `sleepMs` à CHAQUE push. Sinon :
 * le PREMIER push reste bloqué jusqu'à `releasePrePush` (les suivants passent) —
 * aucune durée fixe, donc aucune course avec la lenteur de la machine.
 */
function installSleepingPrePush(root, sleepMs, { always = false } = {}) {
  const script = always
    ? `require('fs').writeFileSync('.git/pre-push-started','1');setTimeout(()=>require('fs').writeFileSync('.git/pre-push-finished','1'),${sleepMs});`
    : `const fs=require('fs');if(fs.existsSync('.git/pre-push-started'))process.exit(0);fs.writeFileSync('.git/pre-push-started','1');const t=setInterval(()=>{if(fs.existsSync('.git/release-push'))clearInterval(t)},50);`;
  return writeFile(
    path.join(root, '.git', 'hooks', 'pre-push'),
    `#!/bin/sh
node -e "${script}"
`,
    { mode: 0o755 },
  );
}

const releasePrePush = (root) => writeFile(path.join(root, '.git', 'release-push'), '1');

describe('livraison hors verrou (intégration)', () => {
  let repo;
  let origin;
  let agentA;
  let agentB;

  beforeEach(async () => {
    repo = await createTempRepo();
    await initStriart(repo.root);
    origin = await mkdtemp(path.join(os.tmpdir(), 'striart-origin-'));
    await git(origin, 'init', '-q', '--bare', '-b', 'main');
    await git(repo.root, 'remote', 'add', 'origin', origin);
    await git(repo.root, 'push', '-q', '-u', 'origin', 'main');
    await setConfig(repo.root, {
      gateContainer: 'process',
      testCommand: GATE_OK,
      semanticMerge: false,
      autoPush: true,
    });
    agentA = await createAgent({ root: repo.root, name: 'agent-a' });
    agentB = await createAgent({ root: repo.root, name: 'agent-b' });
  });

  afterEach(async () => {
    await rm(path.join(repo.root, '.git', 'hooks', 'pre-push'), { force: true });
    await rm(origin, { recursive: true, force: true, maxRetries: 5 }).catch(() => {});
    await repo.cleanup();
  });

  it('un hook pre-push de 8 s NE GÈLE PAS le verrou : un second merge et un sondage du verrou passent pendant le push', async () => {
    await installSleepingPrePush(repo.root, 0);
    await commitIn(agentA.path, 'a.js', 'export const a = 1;\n', 'feat: a');
    await commitIn(agentB.path, 'b.js', 'export const b = 1;\n', 'feat: b');

    let firstSettled = false;
    const first = mergeAgentCommit({ root: repo.root, agent: 'agent-a' }).finally(() => {
      firstSettled = true;
    });
    await waitFor(() => exists(path.join(repo.root, '.git', 'pre-push-started')));

    // Le push de A est en cours : le verrou doit être LIBRE.
    const probeStart = Date.now();
    await withMainLock(repo.root, 'probe', async () => undefined);
    expect(Date.now() - probeStart).toBeLessThan(15_000);
    expect(firstSettled).toBe(false);

    // Un second merge commite pendant que le push de A dort.
    const second = mergeAgentCommit({ root: repo.root, agent: 'agent-b' });
    await waitFor(
      async () => Number(await git(repo.root, 'rev-list', '--count', '--merges', 'HEAD')) === 2,
    );
    expect(firstSettled).toBe(false);

    await releasePrePush(repo.root);
    const [a, b] = await Promise.all([first, second]);
    expect(a.status).toBe('MERGED');
    expect(b.status).toBe('MERGED');
    expect(a.pushError).toBeNull();
    expect(b.pushError).toBeNull();
    // Les pushs sont sérialisés et exacts : l'origin porte le dernier merge testé.
    expect(a.delivery).toMatchObject({ mode: 'push', ref: 'main', sha: a.mergeSha, pushed: true });
    expect(b.delivery).toMatchObject({ mode: 'push', ref: 'main', sha: b.mergeSha, pushed: true });
    expect(await git(origin, 'rev-parse', 'refs/heads/main')).toBe(
      await git(repo.root, 'rev-parse', 'HEAD'),
    );
  }, 300_000);

  it('push non fast-forward (origin a avancé) : erreur NOMMÉE avec piste, merge local conservé, jamais de force', async () => {
    const other = await mkdtemp(path.join(os.tmpdir(), 'striart-other-'));
    try {
      await git(other, 'clone', '-q', origin, '.');
      await commitIn(other, 'x.js', 'export const x = 1;\n', 'feat: x (ailleurs)');
      await git(other, 'push', '-q', 'origin', 'HEAD:main');
      const remoteTip = await git(origin, 'rev-parse', 'refs/heads/main');
      await commitIn(agentA.path, 'a.js', 'export const a = 1;\n', 'feat: a');

      const merged = await mergeAgentCommit({ root: repo.root, agent: 'agent-a' });

      expect(merged.status).toBe('MERGED');
      expect(merged.pushError).toMatch(/PUSH_NON_FAST_FORWARD/);
      expect(merged.delivery).toMatchObject({
        pushed: false,
        code: 'PUSH_NON_FAST_FORWARD',
        sha: merged.mergeSha,
      });
      expect(merged.delivery.hint).toMatch(/fetch|merge|rebase/i);
      expect(await git(origin, 'rev-parse', 'refs/heads/main')).toBe(remoteTip);
      expect(await git(repo.root, 'rev-parse', 'HEAD')).toBe(merged.mergeSha);
    } finally {
      await rm(other, { recursive: true, force: true, maxRetries: 5 }).catch(() => {});
    }
  });

  it('pushTimeoutMs : un push bloqué est tué (arbre de process), PUSH_TIMEOUT visible, verrou libre', async () => {
    await setConfig(repo.root, {
      gateContainer: 'process',
      testCommand: GATE_OK,
      semanticMerge: false,
      autoPush: true,
      pushTimeoutMs: 1500,
    });
    await installSleepingPrePush(repo.root, 5000, { always: true });
    await commitIn(agentA.path, 'a.js', 'export const a = 1;\n', 'feat: a');
    const remoteBefore = await git(origin, 'rev-parse', 'refs/heads/main');

    const merged = await mergeAgentCommit({ root: repo.root, agent: 'agent-a' });

    expect(merged.status).toBe('MERGED');
    expect(merged.pushError).toMatch(/PUSH_TIMEOUT/);
    expect(merged.delivery).toMatchObject({ pushed: false, code: 'PUSH_TIMEOUT' });
    expect(await git(origin, 'rev-parse', 'refs/heads/main')).toBe(remoteBefore);
    // Le hook (petit-fils du push) a été tué : il n'écrit jamais son marqueur de fin.
    await new Promise((r) => setTimeout(r, 4500));
    expect(await exists(path.join(repo.root, '.git', 'pre-push-finished'))).toBe(false);
    await withMainLock(repo.root, 'probe', async () => undefined);
  }, 300_000);

  it('Test Gate rouge : aucun commit, aucun push', async () => {
    await setConfig(repo.root, {
      gateContainer: 'process',
      testCommand: 'node -e "process.exit(1)"',
      semanticMerge: false,
      autoPush: true,
    });
    await commitIn(agentA.path, 'a.js', 'export const a = 1;\n', 'feat: a');
    const remoteBefore = await git(origin, 'rev-parse', 'refs/heads/main');
    const localBefore = await git(repo.root, 'rev-parse', 'HEAD');

    const result = await mergeAgentCommit({ root: repo.root, agent: 'agent-a' });

    expect(result.status).toBe('GATE_FAILED');
    expect(await git(origin, 'rev-parse', 'refs/heads/main')).toBe(remoteBefore);
    expect(await git(repo.root, 'rev-parse', 'HEAD')).toBe(localBefore);
  });

  it('mode « branch » : le SHA testé part vers striart/<agent>/<tâche>, la cible distante n’avance pas', async () => {
    await setConfig(repo.root, {
      gateContainer: 'process',
      testCommand: GATE_OK,
      semanticMerge: false,
      autoPush: true,
      delivery: 'branch',
    });
    const remoteBefore = await git(origin, 'rev-parse', 'refs/heads/main');
    await commitIn(agentA.path, 'a.js', 'export const a = 1;\n', 'feat: a');

    const merged = await mergeAgentCommit({ root: repo.root, agent: 'agent-a' });

    expect(merged.status).toBe('MERGED');
    expect(merged.pushError).toBeNull();
    expect(merged.delivery).toMatchObject({ mode: 'branch', sha: merged.mergeSha, pushed: true });
    expect(merged.delivery.ref).toMatch(/^striart\/agent-a\/[A-Za-z0-9._-]+$/);
    expect(await git(origin, 'rev-parse', `refs/heads/${merged.delivery.ref}`)).toBe(
      merged.mergeSha,
    );
    expect(await git(origin, 'rev-parse', 'refs/heads/main')).toBe(remoteBefore);
  });

  it('mode « push » (défaut) : le SHA exact du merge part vers la branche cible', async () => {
    await commitIn(agentA.path, 'a.js', 'export const a = 1;\n', 'feat: a');

    const merged = await mergeAgentCommit({ root: repo.root, agent: 'agent-a' });

    expect(merged.pushError).toBeNull();
    expect(merged.delivery).toMatchObject({ mode: 'push', ref: 'main', pushed: true });
    expect(await git(origin, 'rev-parse', 'refs/heads/main')).toBe(merged.mergeSha);
  });

  it('autoPush false : aucune livraison', async () => {
    await setConfig(repo.root, {
      gateContainer: 'process',
      testCommand: GATE_OK,
      semanticMerge: false,
    });
    const remoteBefore = await git(origin, 'rev-parse', 'refs/heads/main');
    await commitIn(agentA.path, 'a.js', 'export const a = 1;\n', 'feat: a');

    const merged = await mergeAgentCommit({ root: repo.root, agent: 'agent-a' });

    expect(merged.pushError).toBeNull();
    expect(merged.delivery ?? null).toBeNull();
    expect(await git(origin, 'rev-parse', 'refs/heads/main')).toBe(remoteBefore);
  });

  it('résolution manuelle : la livraison est elle aussi différée hors verrou et rapportée', async () => {
    await writeFile(path.join(repo.root, 'app.js'), 'const v = "main";\n');
    await git(repo.root, 'add', 'app.js');
    await git(repo.root, 'commit', '-q', '-m', 'feat: main');
    await git(repo.root, 'push', '-q', 'origin', 'main');
    await commitIn(agentA.path, 'app.js', 'const v = "agent";\n', 'feat: agent');
    const conflict = await mergeAgentCommit({ root: repo.root, agent: 'agent-a' });
    expect(conflict.status).toBe('CONFLICT');
    await prepareResolutionScaffold(repo.root, conflict.ticket.id);
    await installSleepingPrePush(repo.root, 0);

    const pending = applyTicketResolution({ root: repo.root, ticketId: conflict.ticket.id });
    await waitFor(() => exists(path.join(repo.root, '.git', 'pre-push-started')));
    const probeStart = Date.now();
    await withMainLock(repo.root, 'probe', async () => undefined);
    expect(Date.now() - probeStart).toBeLessThan(15_000);

    await releasePrePush(repo.root);
    const result = await pending;
    expect(result.status).toBe('MERGED');
    expect(result.pushError).toBeNull();
    expect(result.delivery).toMatchObject({ pushed: true, sha: result.mergeSha });
    expect(await git(origin, 'rev-parse', 'refs/heads/main')).toBe(result.mergeSha);
  }, 300_000);

  it('promotion : le SHA testé de staging part vers mainBranch hors verrou', async () => {
    const STAGING = 'striart/staging';
    await git(repo.root, 'checkout', '-q', '-b', STAGING);
    await setConfig(repo.root, {
      gateContainer: 'process',
      testCommand: GATE_OK,
      targetBranch: STAGING,
      mainBranch: 'main',
      autoPush: true,
    });
    const staged = await commitIn(repo.root, 'f.js', 'export const f = 1;\n', 'feat: f');
    await installSleepingPrePush(repo.root, 0);

    const pending = promoteStaging({ root: repo.root });
    await waitFor(() => exists(path.join(repo.root, '.git', 'pre-push-started')));
    const probeStart = Date.now();
    await withMainLock(repo.root, 'probe', async () => undefined);
    expect(Date.now() - probeStart).toBeLessThan(15_000);

    await releasePrePush(repo.root);
    const result = await pending;
    expect(result.status).toBe('PROMOTED');
    expect(result.pushError).toBeNull();
    expect(result.delivery).toMatchObject({ mode: 'push', ref: 'main', sha: staged, pushed: true });
    expect(await git(origin, 'rev-parse', 'refs/heads/main')).toBe(staged);
  }, 300_000);

  it('rollback d’un merge publié : le revert est borné et nettoyé quand git le refuse (signature impossible) — HEAD et état intacts', async () => {
    await commitIn(agentA.path, 'a.js', 'export const a = 1;' + String.fromCharCode(10), 'feat: a');
    const merged = await mergeAgentCommit({ root: repo.root, agent: 'agent-a' });
    expect(merged.pushError).toBeNull();
    await git(repo.root, 'config', 'commit.gpgsign', 'true');
    await git(repo.root, 'config', 'gpg.program', 'striart-no-such-signer');

    const error = await rollbackLastMerge({ root: repo.root }).catch((e) => e);

    expect(error).toMatchObject({ code: 'MERGE_COMMIT_FAILED' });
    expect(await git(repo.root, 'rev-parse', 'HEAD')).toBe(merged.mergeSha);
    expect(await exists(path.join(repo.root, '.git', 'REVERT_HEAD'))).toBe(false);
    expect(await exists(path.join(repo.root, '.git', 'sequencer'))).toBe(false);
    expect(await git(repo.root, 'status', '--porcelain', '--untracked-files=no')).toBe('');
  }, 300_000);

  it('livraison d’un SHA qui n’est plus dans la branche locale (rollback intercalé) : PUSH_SUPERSEDED, rien de publié', async () => {
    const { deliverSha } = await import('../../src/delivery.ts');
    await commitIn(agentA.path, 'a.js', 'export const a = 1;\n', 'feat: a');
    const merged = await mergeAgentCommit({ root: repo.root, agent: 'agent-a' });
    const remoteAfterMerge = await git(origin, 'rev-parse', 'refs/heads/main');
    expect(remoteAfterMerge).toBe(merged.mergeSha);
    // Un commit local orphelin (jamais dans main) : sa livraison serait la publication
    // d'un travail défait.
    await git(repo.root, 'checkout', '-q', '--detach');
    const orphan = await commitIn(repo.root, 'o.js', 'export const o = 1;\n', 'wip: orphelin');
    await git(repo.root, 'checkout', '-q', 'main');

    const outcome = await deliverSha({
      root: repo.root,
      sha: orphan,
      ref: 'main',
      localBranch: 'main',
      timeoutMs: 10_000,
    });

    expect(outcome).toMatchObject({ pushed: false, code: 'PUSH_SUPERSEDED' });
    expect(await git(origin, 'rev-parse', 'refs/heads/main')).toBe(remoteAfterMerge);
    expect(await readFile(path.join(repo.root, 'a.js'), 'utf8')).toContain('a = 1');
  });
});

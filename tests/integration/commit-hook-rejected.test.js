/**
 * Hooks de la CIBLE et signature au moment du commit de merge (lot « livraison,
 * hooks de la cible, mode branche »).
 *
 * `git commit` lance pre-commit / commit-msg de l'entreprise et une éventuelle
 * signature GPG/SSH SOUS le verrou principal. Un hook qui REJETTE devient un
 * ticket explicite (COMMIT_HOOK_REJECTED) — sortie conservée et bornée, merge
 * annulé, compteur d'échecs sémantiques inchangé. Un hook ou une signature qui
 * BLOQUE est tué au délai `commitTimeoutMs` (arbre de process) et suit le même
 * chemin. Jamais de `--no-verify`.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { execa } from 'execa';
import { createTempRepo } from '../helpers/temp-repo.js';
import { initStriart } from '../../src/init.ts';
import { createAgent, readRegistry } from '../../src/clone.ts';
import { mergeAgentCommit } from '../../src/orchestrator.ts';
import { listConflictTickets } from '../../src/conflicts.ts';
import { readState } from '../../src/state.ts';

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

const hookPath = (root, name = 'pre-commit') => path.join(root, '.git', 'hooks', name);
const installHook = (root, body, name = 'pre-commit') =>
  writeFile(hookPath(root, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });

const exists = (p) =>
  stat(p).then(
    () => true,
    () => false,
  );

describe('hooks de la cible au commit de merge (intégration)', () => {
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
    await commitIn(agent.path, 'feature.js', 'export const f = 1;\n', 'feat: f');
  });

  afterEach(async () => {
    await rm(hookPath(repo.root), { force: true });
    await rm(hookPath(repo.root, 'commit-msg'), { force: true });
    await repo.cleanup();
  });

  it('hook qui rejette : ticket COMMIT_HOOK_REJECTED avec la sortie du hook, merge annulé, compteur sémantique inchangé, relançable', async () => {
    const before = await git(repo.root, 'rev-parse', 'HEAD');
    const stateBefore = await readState(repo.root);
    await installHook(repo.root, 'echo "lint: règle X violée" >&2\nexit 1');

    const error = await mergeAgentCommit({ root: repo.root, agent: 'agent-a' }).catch((e) => e);

    expect(error).toMatchObject({ code: 'COMMIT_HOOK_REJECTED', kind: 'failure' });
    expect(error.details).toMatchObject({ agent: 'agent-a' });
    expect(error.details.ticketId).toEqual(expect.any(String));
    expect(await git(repo.root, 'rev-parse', 'HEAD')).toBe(before);
    await expect(stat(path.join(repo.root, '.git', 'MERGE_HEAD'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    expect(await git(repo.root, 'status', '--porcelain', '--untracked-files=no')).toBe('');
    expect(await readState(repo.root)).toEqual(stateBefore);
    expect((await readRegistry(repo.root))['agent-a'].lastMergedCommit ?? null).toBeNull();

    const tickets = await listConflictTickets(repo.root);
    const ticket = tickets.find((t) => t.id === error.details.ticketId);
    expect(ticket).toMatchObject({ reason: 'COMMIT_HOOK_REJECTED', agent: 'agent-a' });
    const log = await readFile(path.join(ticket.dir, 'test-output.log'), 'utf8');
    expect(log).toContain('lint: règle X violée');

    // Rien d'empoisonné : hook retiré, le même merge aboutit et le ticket du hook se ferme.
    await rm(hookPath(repo.root), { force: true });
    const retry = await mergeAgentCommit({ root: repo.root, agent: 'agent-a' });
    expect(retry.status).toBe('MERGED');
    expect(
      (await listConflictTickets(repo.root)).filter((t) => t.reason === 'COMMIT_HOOK_REJECTED'),
    ).toEqual([]);
  });

  it('un jeton affiché par le hook est caviardé dans le ticket ET dans le message/--json', async () => {
    const pattern = 'sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789';
    const exact = 'valeur-exacte-sans-motif-9f8e7d6c';
    const previous = process.env.STRIART_TEST_HOOK_TOKEN;
    process.env.STRIART_TEST_HOOK_TOKEN = exact;
    try {
      await installHook(repo.root, `echo "auth ${pattern} et ${exact}" >&2\nexit 1`);

      const error = await mergeAgentCommit({ root: repo.root, agent: 'agent-a' }).catch((e) => e);

      expect(error).toMatchObject({ code: 'COMMIT_HOOK_REJECTED' });
      const ticket = (await listConflictTickets(repo.root)).find(
        (t) => t.id === error.details.ticketId,
      );
      const log = await readFile(path.join(ticket.dir, 'test-output.log'), 'utf8');
      const surfaces = [log, error.message, JSON.stringify(error.details), error.hint];
      for (const text of surfaces) {
        expect(text).not.toContain(pattern);
        expect(text).not.toContain('AbCdEfGhIjKlMnOpQr');
        expect(text).not.toContain(exact);
      }
      expect(log).toContain('auth ');
      expect(error.message).toContain('auth ');
    } finally {
      if (previous === undefined) delete process.env.STRIART_TEST_HOOK_TOKEN;
      else process.env.STRIART_TEST_HOOK_TOKEN = previous;
    }
  });

  it('commit-msg qui rejette est traité de la même façon', async () => {
    await installHook(repo.root, 'echo "message refusé" >&2\nexit 1', 'commit-msg');

    const error = await mergeAgentCommit({ root: repo.root, agent: 'agent-a' }).catch((e) => e);

    expect(error).toMatchObject({ code: 'COMMIT_HOOK_REJECTED' });
  });

  it('la sortie du hook est BORNÉE dans le ticket', async () => {
    await installHook(
      repo.root,
      `node -e "process.stderr.write('x'.repeat(300000)+'FIN-DU-HOOK\\n')"\nexit 1`,
    );

    const error = await mergeAgentCommit({ root: repo.root, agent: 'agent-a' }).catch((e) => e);

    expect(error).toMatchObject({ code: 'COMMIT_HOOK_REJECTED' });
    const ticket = (await listConflictTickets(repo.root)).find(
      (t) => t.id === error.details.ticketId,
    );
    const log = await readFile(path.join(ticket.dir, 'test-output.log'), 'utf8');
    expect(log.length).toBeLessThan(40_000);
    // La FIN est conservée (c'est là que sont les violations récentes).
    expect(log).toContain('FIN-DU-HOOK');
  });

  it('hook qui BLOQUE : tué au délai commitTimeoutMs (arbre de process), même chemin, verrou libre', async () => {
    await setConfig(repo.root, {
      gateContainer: 'process',
      testCommand: GATE_OK,
      semanticMerge: false,
      commitTimeoutMs: 1500,
    });
    await installHook(
      repo.root,
      `node -e "setTimeout(()=>require('fs').writeFileSync('.git/hook-finished','1'),4000)"`,
    );

    const error = await mergeAgentCommit({ root: repo.root, agent: 'agent-a' }).catch((e) => e);

    expect(error).toMatchObject({ code: 'COMMIT_HOOK_REJECTED' });
    expect(error.details).toMatchObject({ timedOut: true });
    await expect(stat(path.join(repo.root, '.git', 'MERGE_HEAD'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    await new Promise((r) => setTimeout(r, 4500));
    expect(await exists(path.join(repo.root, '.git', 'hook-finished'))).toBe(false);
  }, 300_000);

  it('échec de commit SANS hook (signature impossible) : MERGE_COMMIT_FAILED, pas de faux ticket de hook', async () => {
    await git(repo.root, 'config', 'commit.gpgsign', 'true');
    await git(repo.root, 'config', 'gpg.program', 'striart-no-such-signer');

    const error = await mergeAgentCommit({ root: repo.root, agent: 'agent-a' }).catch((e) => e);

    expect(error).toMatchObject({ code: 'MERGE_COMMIT_FAILED' });
    await expect(stat(path.join(repo.root, '.git', 'MERGE_HEAD'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    expect(
      (await listConflictTickets(repo.root)).filter((t) => t.reason === 'COMMIT_HOOK_REJECTED'),
    ).toEqual([]);
  });

  it('jamais de --no-verify : un hook qui réussit est bien exécuté', async () => {
    await installHook(repo.root, `node -e "require('fs').writeFileSync('.git/hook-ran','1')"`);

    const merged = await mergeAgentCommit({ root: repo.root, agent: 'agent-a' });

    expect(merged.status).toBe('MERGED');
    expect(await exists(path.join(repo.root, '.git', 'hook-ran'))).toBe(true);
  });
});

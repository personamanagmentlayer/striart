/**
 * `STASH_CONFLICT` après un rebase RÉUSSI (revue du noyau K-M6) : le rebase a
 * eu lieu, donc la base de comptage de l'agent (`baseCommit`,
 * `lastMergedCommit`) doit suivre la tête de la cible — l'état du registre ne
 * doit pas mentir sur le clone parce que le stash n'a pas pu être rejoué.
 *
 * Cas construit : un fichier NON SUIVI `a` côté agent (stashé avec -u) et un
 * commit entrant qui crée `a/b.txt` — les chemins diffèrent (`a` ≠ `a/b.txt`),
 * la disjonction « prouvée » passe, mais le `stash pop` ne peut pas recréer le
 * fichier `a` là où un dossier `a/` existe désormais.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { execa } from 'execa';
import { createTempRepo } from '../helpers/temp-repo.js';
import { initStriart } from '../../src/init.ts';
import { createAgent, readRegistry } from '../../src/clone.ts';
import { syncAgentWithMain } from '../../src/orchestrator.ts';

const git = (cwd, ...args) => execa('git', ['-C', cwd, ...args]).then((r) => r.stdout.trim());

describe('sync — STASH_CONFLICT après rebase réussi (intégration)', () => {
  let repo;
  let agent;

  beforeEach(async () => {
    repo = await createTempRepo();
    await initStriart(repo.root);
    await writeFile(
      path.join(repo.root, '.striartrc.json'),
      JSON.stringify({ testCommand: 'node -e "process.exit(0)"' }),
    );
    agent = await createAgent({ root: repo.root, name: 'agent-a' });
  });

  afterEach(async () => {
    await repo.cleanup();
  });

  it('la base de comptage suit la tête de la cible malgré le conflit de stash ; le travail reste dans le stash', async () => {
    // Travail local de l'agent : un fichier non suivi `a` et un commit à lui.
    await writeFile(path.join(agent.path, 'travail.js'), 'export const t = 1;\n');
    await git(agent.path, 'add', 'travail.js');
    await git(
      agent.path,
      '-c',
      'user.name=A',
      '-c',
      'user.email=a@example.com',
      'commit',
      '-q',
      '-m',
      'feat: travail',
    );
    await writeFile(path.join(agent.path, 'a'), 'fichier non suivi de l’agent\n');
    // Commit entrant sur la cible : un DOSSIER `a/`.
    await mkdir(path.join(repo.root, 'a'), { recursive: true });
    await writeFile(path.join(repo.root, 'a', 'b.txt'), 'dans le dossier\n');
    await git(repo.root, 'add', 'a/b.txt');
    await git(repo.root, 'commit', '-q', '-m', 'feat: dossier a');
    const mainHead = await git(repo.root, 'rev-parse', 'HEAD');
    const before = (await readRegistry(repo.root))['agent-a'];

    const result = await syncAgentWithMain({ root: repo.root, agent: 'agent-a' });

    expect(result.status).toBe('STASH_CONFLICT');
    // Le rebase a bien eu lieu…
    expect(await git(agent.path, 'rev-parse', 'HEAD^')).toBe(mainHead);
    // …donc le registre le dit (avant le correctif : baseCommit inchangé).
    const after = (await readRegistry(repo.root))['agent-a'];
    expect(before.baseCommit).not.toBe(mainHead);
    expect(after.baseCommit).toBe(mainHead);
    // Rien n'est perdu : le fichier de l'agent est dans le stash.
    expect(await git(agent.path, 'stash', 'list')).toMatch(/striart-autostash-agent-a/);
    expect(await git(agent.path, 'show', 'stash@{0}^3:a')).toContain('fichier non suivi');
    expect(await readFile(path.join(agent.path, 'a', 'b.txt'), 'utf8')).toContain(
      'dans le dossier',
    );
  });
});

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { simpleGit } from 'simple-git';
import { createTempRepo } from '../helpers/temp-repo.js';
import { initStriart } from '../../src/init.ts';
import { createAgent, readRegistry } from '../../src/clone.ts';
import { publishAgentCollab } from '../../src/orchestration/unit.ts';

const exists = async (p) => Boolean(await stat(p).catch(() => null));
const TEAM = {
  group: 'team-0123456789ab',
  kind: 'team',
  cadence: 'turns',
  roles: ['impl', 'tests'],
  round: 1,
  files: { impl: ['src/**'], tests: [] },
};

describe('orchestration — fraîcheur des consignes injectées (agent supervisé)', () => {
  let repo;

  beforeEach(async () => {
    repo = await createTempRepo();
    await initStriart(repo.root);
    await writeFile(
      path.join(repo.root, '.striartrc.json'),
      JSON.stringify({ agentCommand: 'claude' }),
    );
  });

  afterEach(async () => {
    await repo.cleanup();
  });

  it('le fichier injecté suit le rôle courant à chaque changement de meta.collab', async () => {
    const info = await createAgent({ root: repo.root, name: 'agent-a', command: null });
    const rules = path.join(info.path, '.claude', 'rules', 'striart.md');
    // Avant toute collaboration : pas de bloc.
    expect(await readFile(rules, 'utf8')).not.toContain('Collaboration');

    await publishAgentCollab(repo.root, 'agent-a', { ...TEAM, activeRole: 'impl' });
    let text = await readFile(rules, 'utf8');
    expect(text).toContain('Your role now: `impl`');
    expect(text).toContain('Write scope for `impl`: `src/**`');

    await publishAgentCollab(repo.root, 'agent-a', { ...TEAM, activeRole: 'tests' });
    text = await readFile(rules, 'utf8');
    expect(text).toContain('Your role now: `tests`');
    expect(text).not.toContain('Your role now: `impl`');
    expect(text).toContain('`tests`: read-only');

    // Fin de tour : plus de rôle courant, l'état est publié ET le fichier rafraîchi.
    await publishAgentCollab(repo.root, 'agent-a', { ...TEAM, activeRole: null });
    text = await readFile(rules, 'utf8');
    expect(text).toContain('Your role is stated in each turn prompt');
    expect((await readRegistry(repo.root))['agent-a'].collab.activeRole).toBeNull();
    // Statut git du clone propre : le fichier reste non suivi/exclu.
    expect((await simpleGit(info.path).raw(['status', '--porcelain', '-uall'])).trim()).toBe('');
  });

  it('agent AUTONOME : le registre est mis à jour, AUCUN fichier injecté dans le clone', async () => {
    const info = await createAgent({
      root: repo.root,
      name: 'agent-b',
      command: null,
      mode: 'autonomous',
    });
    await publishAgentCollab(repo.root, 'agent-b', { ...TEAM, activeRole: 'impl' });
    expect((await readRegistry(repo.root))['agent-b'].collab.activeRole).toBe('impl');
    expect(await exists(path.join(info.path, '.claude', 'rules', 'striart.md'))).toBe(false);
  });

  it('échec de la régénération : avertissement, jamais un échec (clone disparu)', async () => {
    const info = await createAgent({ root: repo.root, name: 'agent-c', command: null });
    const { rm } = await import('node:fs/promises');
    await rm(info.path, { recursive: true, force: true });
    await expect(
      publishAgentCollab(repo.root, 'agent-c', { ...TEAM, activeRole: 'impl' }),
    ).resolves.toBeUndefined();
    expect((await readRegistry(repo.root))['agent-c'].collab.activeRole).toBe('impl');
  });
});

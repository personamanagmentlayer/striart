import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import path from 'node:path';
import { createTempRepo } from '../helpers/temp-repo.js';
import { initStriart } from '../../src/init.ts';
import { cloneGit, createAgent, listAgents, readRegistry } from '../../src/clone.ts';
import { writeFile } from 'node:fs/promises';
import { writeJsonAtomic } from '../../src/json-file.ts';

/**
 * `listAgents` inspecte les clones en parallèle borné (la collecte d'état du
 * dashboard est refaite à chaque changement : 4 process git par agent pris l'un
 * après l'autre rendaient 50 agents ≈ 50 s). Le parallélisme ne doit rien
 * changer au contrat : ordre du registre conservé, un statut par entrée.
 */
describe('listAgents — inspection parallèle bornée', () => {
  let repo;
  beforeEach(async () => {
    repo = await createTempRepo();
    await initStriart(repo.root);
  });
  afterEach(async () => {
    await repo.cleanup();
  });

  it('conserve l’ordre du registre et rend un statut par agent (clone réel et clones manquants mêlés)', async () => {
    await createAgent({ root: repo.root, name: 'agent-real', command: 'claude' });
    const registry = await readRegistry(repo.root);
    const template = registry['agent-real'];
    const names = [];
    const mixed = {};
    // Plus d'entrées que la concurrence (6) : les files de travailleurs tournent.
    for (let i = 0; i < 20; i += 1) {
      const name = `agent-${String(i).padStart(2, '0')}`;
      names.push(name);
      mixed[name] =
        i % 5 === 0
          ? { ...template, name }
          : { ...template, name, path: path.join(repo.root, 'inexistant', name) };
    }
    await writeJsonAtomic(path.join(repo.root, '.striart', 'agents.json'), mixed);

    const agents = await listAgents(repo.root);
    expect(agents.map((a) => a.name)).toEqual(names);
    for (const [i, agent] of agents.entries())
      expect(agent.status, agent.name).toBe(i % 5 === 0 ? 'ACTIVE' : 'MISSING');
  });

  it('les faits git mémoïsés suivent chaque commit, sans attendre l’expiration du cache', async () => {
    await createAgent({ root: repo.root, name: 'agent-live', command: 'claude' });
    const [before] = await listAgents(repo.root);
    expect(before).toMatchObject({ pendingCommits: 0, status: 'ACTIVE' });
    // Deuxième lecture : servie par le cache, identique.
    expect((await listAgents(repo.root))[0]).toMatchObject({
      head: before.head,
      pendingCommits: 0,
    });

    const meta = (await readRegistry(repo.root))['agent-live'];
    const git = cloneGit(meta.path);
    for (const n of [1, 2]) {
      await writeFile(
        path.join(meta.path, `f${n}.txt`),
        `${n}
`,
      );
      await git.add(['-A']);
      await git.commit(`feat: commit ${n}`);
      const [after] = await listAgents(repo.root);
      expect(after.pendingCommits, `après le commit ${n}`).toBe(n);
      expect(after.lastMessage).toBe(`feat: commit ${n}`);
      expect(after.head).not.toBe(before.head);
    }
  });
});

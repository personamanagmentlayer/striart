import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTempRepo } from '../helpers/temp-repo.js';
import { initStriart } from '../../src/init.js';
import { readRegistry } from '../../src/clone.js';
import { applyPlan } from '../../src/orchestrator.js';
import { readQueue } from '../../src/queue.js';

function mockRouter(filesByPrompt) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url, options) => {
      const { prompt } = JSON.parse(options.body);
      const match = Object.entries(filesByPrompt).find(([needle]) => prompt.includes(needle));
      return {
        ok: true,
        json: async () => ({ response: JSON.stringify({ files: match ? match[1] : [] }) }),
      };
    }),
  );
}

describe('striart plan (tâches-as-code)', () => {
  let repo;

  beforeEach(async () => {
    repo = await createTempRepo();
    await initStriart(repo.root);
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await repo.cleanup();
  });

  it('--dry-run valide et n’applique rien', async () => {
    mockRouter({ schema: ['db.js'], auth: ['auth.js'] });
    const planText = `
version: 1
tasks:
  - id: schema
    prompt: migrate schema
  - id: auth
    prompt: refactor auth
    after: schema
`;
    const result = await applyPlan({ root: repo.root, planText, dryRun: true });
    expect(result.dryRun).toBe(true);
    expect(result.tasks.map((t) => t.id)).toEqual(['schema', 'auth']);
    expect(result.tasks[1].after).toBe('schema');
    // Rien n'a été créé.
    expect(await readRegistry(repo.root)).toEqual({});
    expect(await readQueue(repo.root)).toEqual([]);
  });

  it('applique un graphe : la dépendance résout l’id de plan en nom d’agent réel', async () => {
    // Fichiers DISJOINTS : sans `after`, tout partirait en parallèle. C'est la
    // dépendance déclarée — pas une collision — qui séquentialise.
    mockRouter({ schema: ['db.js'], auth: ['auth.js'], ui: ['ui.js'] });
    const planText = `
version: 1
tasks:
  - id: schema
    agent: db-schema
    prompt: migrate schema
  - id: auth
    agent: jwt-auth
    prompt: refactor auth
    after: schema
  - id: ui
    prompt: update ui
    after: auth
`;
    const result = await applyPlan({ root: repo.root, planText });
    expect(result.dryRun).toBe(false);

    // schema : aucune dépendance → démarré.
    expect(result.results[0]).toMatchObject({
      id: 'schema',
      agent: 'db-schema',
      status: 'STARTED',
    });
    // auth : dépend de schema (vivant) → en file, `after` résolu au NOM d'agent.
    expect(result.results[1]).toMatchObject({ id: 'auth', agent: 'jwt-auth', status: 'QUEUED' });
    // ui : dépend de auth → en file aussi.
    expect(result.results[2]).toMatchObject({ status: 'QUEUED' });

    const queue = await readQueue(repo.root);
    const authTask = queue.find((t) => t.agent === 'jwt-auth');
    expect(authTask.after).toBe('db-schema'); // l'id `schema` a bien été résolu

    // Un seul agent actif (schema) ; les deux autres attendent.
    expect(Object.keys(await readRegistry(repo.root))).toEqual(['db-schema']);
  });

  it('un plan invalide n’applique aucune tâche (validation avant effet de bord)', async () => {
    mockRouter({ a: ['a.js'] });
    // La 2e tâche est invalide (prompt manquant) : la 1re ne doit pas partir.
    const planText = `
version: 1
tasks:
  - prompt: tache a
  - id: b
`;
    await expect(applyPlan({ root: repo.root, planText })).rejects.toMatchObject({
      code: 'PLAN_INVALID',
    });
    expect(await readRegistry(repo.root)).toEqual({});
  });
});

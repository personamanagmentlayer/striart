import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createTempRepo } from '../helpers/temp-repo.js';
import { initStriart } from '../../src/init.ts';
import { readRegistry } from '../../src/clone.ts';
import { retryQueue, runTask, stopAgent } from '../../src/orchestrator.ts';
import { readQueue } from '../../src/queue.ts';
import { writeJsonAtomic } from '../../src/json-file.ts';

/** Router mocké : des fichiers DISJOINTS par prompt — --after doit bloquer
 *  seul, sans l'aide d'aucune collision. */
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

describe('striart run --after (dépendances de tâches)', () => {
  let repo;

  beforeEach(async () => {
    repo = await createTempRepo();
    await initStriart(repo.root);
    mockRouter({ fondation: ['db.js'], facade: ['api.js'], toiture: ['ui.js'] });
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await repo.cleanup();
  });

  it('réf inconnue → AFTER_UNKNOWN, rien en file (échec à vide)', async () => {
    await expect(
      runTask({ root: repo.root, agent: 'b', prompt: 'facade', after: 'fantome' }),
    ).rejects.toMatchObject({ code: 'AFTER_UNKNOWN' });
    expect(await readQueue(repo.root)).toEqual([]);
  });

  it('enfile SANS collision, ajourne au retry tant que la dépendance vit, part à sa fin', async () => {
    const a = await runTask({ root: repo.root, agent: 'a', prompt: 'fondation' });
    expect(a.status).toBe('STARTED');

    // Fichiers disjoints (db.js vs api.js) : seule la dépendance bloque.
    const b = await runTask({ root: repo.root, agent: 'b', prompt: 'facade', after: 'a' });
    expect(b.status).toBe('QUEUED');
    expect(b.collisions).toEqual([]);
    expect(b.task.after).toBe('a');

    // La dépendance vit → ajournée, PAS démarrée.
    const retry1 = await retryQueue({ root: repo.root });
    expect(retry1.started).toEqual([]);
    expect(retry1.stillWaiting.map((t) => t.agent)).toEqual(['b']);

    // Fin du travail référencé → déblocage AUTOMATIQUE : stopAgent relance
    // la file lui-même, sans queue --retry manuel.
    const stopped = await stopAgent({ root: repo.root, agent: 'a' });
    expect(stopped.started.map((s) => s.task.agent)).toEqual(['b']);
    expect((await readRegistry(repo.root)).b).toBeDefined();
    expect(await readQueue(repo.root)).toEqual([]);
  });

  it('la référence marche aussi par id de tâche, à travers la file', async () => {
    await runTask({ root: repo.root, agent: 'a', prompt: 'fondation' });
    // b en collision avec a (mêmes fichiers) → en file.
    mockRouter({ fondation: ['db.js'], facade: ['db.js'], toiture: ['ui.js'] });
    const b = await runTask({ root: repo.root, agent: 'b', prompt: 'facade' });
    expect(b.status).toBe('QUEUED');

    // c dépend de la TÂCHE b (par id), pas d'un agent actif.
    const c = await runTask({ root: repo.root, agent: 'c', prompt: 'toiture', after: b.task.id });
    expect(c.status).toBe('QUEUED');

    // a vit → b bloquée (collision) → c bloquée (dépendance sur b).
    const retry = await retryQueue({ root: repo.root });
    expect(retry.started).toEqual([]);
    expect(retry.stillWaiting.map((t) => t.agent).sort()).toEqual(['b', 'c']);
  });

  it('cycle de dépendances → AFTER_CYCLE, refusé au run', async () => {
    // File fabriquée à la main : deux tâches qui se référencent mutuellement
    // (inatteignable par l'API grâce aux gardes, mais un queue.json édité ne
    // doit jamais faire boucler l'orchestrateur).
    await writeJsonAtomic(path.join(repo.root, '.striart', 'queue.json'), [
      {
        id: 'task-aaaa',
        status: 'WAITING',
        agent: 'x',
        prompt: 'p',
        predictedFiles: [],
        collisions: [],
        command: null,
        after: 'y',
        createdAt: new Date().toISOString(),
      },
      {
        id: 'task-bbbb',
        status: 'WAITING',
        agent: 'y',
        prompt: 'p',
        predictedFiles: [],
        collisions: [],
        command: null,
        after: 'x',
        createdAt: new Date().toISOString(),
      },
    ]);
    await expect(
      runTask({ root: repo.root, agent: 'z', prompt: 'toiture', after: 'x' }),
    ).rejects.toMatchObject({ code: 'AFTER_CYCLE' });

    // Et le cycle direct : z --after une chaîne qui reviendrait sur z.
    await writeJsonAtomic(path.join(repo.root, '.striart', 'queue.json'), [
      {
        id: 'task-cccc',
        status: 'WAITING',
        agent: 'w',
        prompt: 'p',
        predictedFiles: [],
        collisions: [],
        command: null,
        after: 'z',
        createdAt: new Date().toISOString(),
      },
    ]);
    await expect(
      runTask({ root: repo.root, agent: 'z', prompt: 'toiture', after: 'w' }),
    ).rejects.toMatchObject({ code: 'AFTER_CYCLE' });
  });
});

describe('striart run --allow-historical-secrets à travers la file', () => {
  let repo;

  beforeEach(async () => {
    repo = await createTempRepo();
    await initStriart(repo.root);
    // Fichiers IDENTIQUES par prompt : collision garantie entre 'a' et 'b'.
    mockRouter({ fondation: ['shared.js'], facade: ['shared.js'] });
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await repo.cleanup();
  });

  /** .env tracké puis retiré : absent du worktree actuel, présent dans
   *  l'historique — secretPatterns par défaut (config.js) inclut '.env'. */
  async function commitThenRemoveEnv() {
    await writeFile(path.join(repo.root, '.env'), 'API_KEY=super-secret\n');
    await repo.git.raw(['add', '-f', '.env']);
    await repo.git.commit('feat: ajoute .env par erreur');
    await repo.git.rm(['.env']);
    await repo.git.commit('fix: retire .env de l’historique courant');
  }

  it('allowHistoricalSecrets posé à l’enfilage survit au dégagement de la file (HISTORICAL_SECRETS_FOUND contourné)', async () => {
    // 'a' démarre AVANT que le secret n'entre dans l'historique : seul le
    // dégagement (différé) de 'b' doit affronter le garde-fou.
    const a = await runTask({ root: repo.root, agent: 'a', prompt: 'fondation' });
    expect(a.status).toBe('STARTED');
    await commitThenRemoveEnv();

    const b = await runTask({
      root: repo.root,
      agent: 'b',
      prompt: 'facade',
      allowHistoricalSecrets: true,
    });
    expect(b.status).toBe('QUEUED');
    expect(b.task.allowHistoricalSecrets).toBe(true);
    expect((await readQueue(repo.root))[0].allowHistoricalSecrets).toBe(true);

    // Fin de 'a' → déblocage automatique de 'b', malgré le secret historique.
    const stopped = await stopAgent({ root: repo.root, agent: 'a' });
    expect(stopped.started.map((s) => s.task.agent)).toEqual(['b']);
    expect((await readRegistry(repo.root)).b).toBeDefined();
  });

  it('sans force : la tâche reste ajournée (HISTORICAL_SECRETS_FOUND), sans casser le dégagement des autres', async () => {
    const a = await runTask({ root: repo.root, agent: 'a', prompt: 'fondation' });
    expect(a.status).toBe('STARTED');
    await commitThenRemoveEnv();

    const b = await runTask({ root: repo.root, agent: 'b', prompt: 'facade' });
    expect(b.status).toBe('QUEUED');
    expect(b.task.allowHistoricalSecrets).toBe(false);

    const stopped = await stopAgent({ root: repo.root, agent: 'a' });
    expect(stopped.started).toEqual([]);
    expect(stopped.stillWaiting.map((t) => t.agent)).toEqual(['b']);
    expect(stopped.stillWaiting[0].blockedReason).toBe('HISTORICAL_SECRETS_FOUND');
    expect((await readRegistry(repo.root)).b).toBeUndefined();

    // La tâche reste en file (pas perdue) pour un futur `queue --retry`
    // une fois le secret révoqué.
    expect((await readQueue(repo.root)).map((t) => t.agent)).toEqual(['b']);
  });

  // Régression (audit CLI 2026-10-18) : `force` était persisté et rejoué au
  // dégagement, où il levait AUSSI les gardes de perte de travail de
  // reuseAgent — un consentement donné sur un état qui a changé depuis.
  it('le consentement à perdre du travail (force) n’est jamais persisté dans la file', async () => {
    const a = await runTask({ root: repo.root, agent: 'a', prompt: 'fondation' });
    expect(a.status).toBe('STARTED');

    const b = await runTask({ root: repo.root, agent: 'b', prompt: 'facade', force: true });
    expect(b.status).toBe('QUEUED');
    const [persisted] = await readQueue(repo.root);
    expect(persisted).not.toHaveProperty('force');
    expect(persisted.allowHistoricalSecrets).toBe(false);
  });

  it('une file écrite par une version <= 0.10 (champ force) reste lue comme consentement aux secrets', async () => {
    const a = await runTask({ root: repo.root, agent: 'a', prompt: 'fondation' });
    expect(a.status).toBe('STARTED');
    await commitThenRemoveEnv();
    const b = await runTask({ root: repo.root, agent: 'b', prompt: 'facade' });
    expect(b.status).toBe('QUEUED');

    // Réécrit la tâche au format de la 0.10 : `force: true`, pas de nouveau champ.
    const queueFile = path.join(repo.root, '.striart', 'queue.json');
    const legacy = JSON.parse(await readFile(queueFile, 'utf8')).map(
      ({ allowHistoricalSecrets: _ignored, ...task }) => ({ ...task, force: true }),
    );
    await writeFile(queueFile, JSON.stringify(legacy));

    const stopped = await stopAgent({ root: repo.root, agent: 'a' });
    expect(stopped.started.map((s) => s.task.agent)).toEqual(['b']);
  });
});

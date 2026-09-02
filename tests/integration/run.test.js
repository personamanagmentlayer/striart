import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTempRepo } from '../helpers/temp-repo.js';
import { initStriart } from '../../src/init.js';
import { readRegistry } from '../../src/clone.js';
import {
  getQueueDashboard,
  retryQueue,
  runTask,
  slugifyPrompt,
  stopAgent,
} from '../../src/orchestrator.js';
import { readLocks } from '../../src/locks.js';
import { enqueueTask, readQueue } from '../../src/queue.js';
import { readJson, writeJsonAtomic } from '../../src/json-file.js';
import path from 'node:path';

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

describe('striart run + queue (intégration)', () => {
  let repo;

  beforeEach(async () => {
    repo = await createTempRepo();
    await initStriart(repo.root);
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await repo.cleanup();
  });

  it("avertit (sans bloquer) quand deux agents sont liés par le graphe d'imports", async () => {
    const { writeFile } = await import('node:fs/promises');
    await writeFile(path.join(repo.root, 'auth.js'), 'export function hash() {}\n');
    await writeFile(path.join(repo.root, 'login.js'), "import { hash } from './auth.js';\n");
    await repo.git.add(['auth.js', 'login.js']);
    await repo.git.commit('feat: auth + login');

    mockRouter({ 'refactor auth': ['auth.js'], 'page de login': ['login.js'] });
    const first = await runTask({ root: repo.root, prompt: 'refactor auth' });
    expect(first.status).toBe('STARTED');
    expect(first.semanticWarnings).toEqual([]);

    // login.js importe auth.js (tenu par l'agent 1) : pas de collision Git,
    // mais un avertissement sémantique — et le start N'EST PAS bloqué.
    const second = await runTask({ root: repo.root, prompt: 'page de login' });
    expect(second.status).toBe('STARTED');
    expect(second.semanticWarnings).toEqual([
      { agent: first.info.name, links: [{ file: 'auth.js', importedBy: 'login.js' }] },
    ]);
  });

  it('monorepo : avertit (sans bloquer) quand deux agents touchent des packages liés', async () => {
    const { mkdir, writeFile } = await import('node:fs/promises');
    const writeJson = async (rel, data) => {
      await mkdir(path.join(repo.root, path.dirname(rel)), { recursive: true });
      await writeFile(path.join(repo.root, rel), JSON.stringify(data));
    };
    await writeJson('package.json', { name: 'monorepo', workspaces: ['packages/*'] });
    await writeJson('packages/auth/package.json', { name: '@acme/auth' });
    await writeJson('packages/ui/package.json', {
      name: '@acme/ui',
      dependencies: { '@acme/auth': '*' },
    });
    await writeFile(path.join(repo.root, 'packages', 'auth', 'hash.js'), 'export const h = 1;\n');
    await writeFile(path.join(repo.root, 'packages', 'ui', 'button.js'), 'export const b = 1;\n');
    await repo.git.add(['.']);
    await repo.git.commit('feat: monorepo');

    mockRouter({
      'le hash': ['packages/auth/hash.js'],
      'le bouton': ['packages/ui/button.js'],
    });
    const first = await runTask({ root: repo.root, prompt: 'améliore le hash' });
    expect(first.status).toBe('STARTED');

    const second = await runTask({ root: repo.root, prompt: 'améliore le bouton' });
    expect(second.status).toBe('STARTED'); // packages liés = avertissement, PAS de file d'attente
    expect(second.workspaceWarnings).toEqual([
      {
        agent: first.info.name,
        links: [{ mine: '@acme/ui', theirs: '@acme/auth', direction: 'depends-on' }],
      },
    ]);
  });

  it('lance un agent quand le Router ne voit aucune collision', async () => {
    mockRouter({ 'refactor auth': ['src/auth.js'] });
    const result = await runTask({ root: repo.root, agent: 'agent-a', prompt: 'refactor auth' });
    expect(result.status).toBe('STARTED');
    expect(result.predictedFiles).toEqual(['src/auth.js']);

    const registry = await readRegistry(repo.root);
    expect(registry['agent-a'].predictedFiles).toEqual(['src/auth.js']);
    expect(registry['agent-a'].prompt).toBe('refactor auth');
  });

  it('met en file d’attente quand les prédictions se chevauchent', async () => {
    mockRouter({
      'refactor auth': ['src/auth/schema.ts', 'src/auth/db.ts'],
      'migrer la db auth': ['src/auth/db.ts'],
    });
    await runTask({ root: repo.root, agent: 'agent-a', prompt: 'refactor auth' });
    const result = await runTask({
      root: repo.root,
      agent: 'agent-b',
      prompt: 'migrer la db auth',
    });

    expect(result.status).toBe('QUEUED');
    expect(result.collisions).toEqual([{ agent: 'agent-a', files: ['src/auth/db.ts'] }]);

    const queue = await readQueue(repo.root);
    expect(queue).toHaveLength(1);
    expect(queue[0]).toMatchObject({ agent: 'agent-b', status: 'WAITING' });

    // agent-b n'a PAS été cloné
    const registry = await readRegistry(repo.root);
    expect(registry['agent-b']).toBeUndefined();
  });

  it('refuse un agent déjà actif ou déjà en attente', async () => {
    mockRouter({ a: ['x.js'], b: ['x.js'] });
    await runTask({ root: repo.root, agent: 'agent-a', prompt: 'a' });
    await expect(
      runTask({ root: repo.root, agent: 'agent-a', prompt: 'autre' }),
    ).rejects.toMatchObject({
      code: 'AGENT_EXISTS',
    });
    await runTask({ root: repo.root, agent: 'agent-b', prompt: 'b' }); // → QUEUED
    await expect(runTask({ root: repo.root, agent: 'agent-b', prompt: 'b' })).rejects.toMatchObject(
      {
        code: 'AGENT_QUEUED',
      },
    );
  });

  it('refuse un prompt vide', async () => {
    await expect(
      runTask({ root: repo.root, agent: 'agent-a', prompt: '  ' }),
    ).rejects.toMatchObject({
      code: 'EMPTY_PROMPT',
    });
  });

  it('retryQueue relance une tâche une fois l’agent bloquant retiré', async () => {
    mockRouter({ a: ['src/db.ts'], b: ['src/db.ts'] });
    await runTask({ root: repo.root, agent: 'agent-a', prompt: 'a' });
    await runTask({ root: repo.root, agent: 'agent-b', prompt: 'b' }); // → QUEUED

    // Toujours bloqué tant qu'agent-a est actif
    let result = await retryQueue({ root: repo.root });
    expect(result.started).toHaveLength(0);
    expect(result.stillWaiting).toHaveLength(1);

    // Simule le merge d'agent-a (Phase 2) : retrait du registre
    const registryPath = path.join(repo.root, '.striart', 'agents.json');
    const registry = await readJson(registryPath, { fallback: {} });
    delete registry['agent-a'];
    await writeJsonAtomic(registryPath, registry);

    result = await retryQueue({ root: repo.root });
    expect(result.started).toHaveLength(1);
    expect(result.started[0].task.agent).toBe('agent-b');
    expect(await readQueue(repo.root)).toHaveLength(0);

    const updated = await readRegistry(repo.root);
    expect(updated['agent-b'].predictedFiles).toEqual(['src/db.ts']);
  });

  it('stopAgent débloque automatiquement la tâche en attente', async () => {
    mockRouter({ a: ['src/db.ts'], b: ['src/db.ts'] });
    await runTask({ root: repo.root, agent: 'agent-a', prompt: 'a' });
    await runTask({ root: repo.root, agent: 'agent-b', prompt: 'b' }); // → QUEUED

    const result = await stopAgent({ root: repo.root, agent: 'agent-a' });
    expect(result.started).toHaveLength(1);
    expect(result.started[0].task.agent).toBe('agent-b');
    expect(await readQueue(repo.root)).toHaveLength(0);
    expect((await readRegistry(repo.root))['agent-b']).toBeDefined();
  });

  it('la commande par agent traverse run → registre, et queue → déblocage', async () => {
    mockRouter({ a: ['src/db.ts'], b: ['src/db.ts'] });
    await runTask({ root: repo.root, agent: 'agent-a', prompt: 'a', command: 'claude' });
    await runTask({
      root: repo.root,
      agent: 'agent-b',
      prompt: 'b',
      command: 'aider --model gpt-4o',
    }); // → QUEUED

    expect((await readRegistry(repo.root))['agent-a'].command).toBe('claude');
    expect((await readQueue(repo.root))[0].command).toBe('aider --model gpt-4o');

    // Au déblocage, l'agent-b garde son outil.
    const { started } = await stopAgent({ root: repo.root, agent: 'agent-a' });
    expect(started[0].info.command).toBe('aider --model gpt-4o');
    expect((await readRegistry(repo.root))['agent-b'].command).toBe('aider --model gpt-4o');
  });

  it('verrous optimistes : locks.json suit le cycle de vie des agents', async () => {
    mockRouter({ a: ['src/db.ts', 'src/api.ts'] });
    await runTask({ root: repo.root, agent: 'agent-a', prompt: 'a' });
    expect(await readLocks(repo.root)).toEqual({ 'src/db.ts': 'agent-a', 'src/api.ts': 'agent-a' });

    await stopAgent({ root: repo.root, agent: 'agent-a' });
    expect(await readLocks(repo.root)).toEqual({});
  });

  it('striart queue : dashboard RUNNING + WAITING avec blocages recalculés', async () => {
    mockRouter({ a: ['src/db.ts'], b: ['src/db.ts', 'src/ui.tsx'] });
    await runTask({ root: repo.root, agent: 'agent-a', prompt: 'a' });
    await runTask({ root: repo.root, agent: 'agent-b', prompt: 'b' }); // → QUEUED

    const rows = await getQueueDashboard({ root: repo.root });
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ agent: 'agent-a', status: 'RUNNING', files: ['src/db.ts'] });
    expect(rows[1]).toMatchObject({
      agent: 'agent-b',
      status: 'WAITING',
      blockedBy: [{ agent: 'agent-a', files: ['src/db.ts'] }],
    });
  });

  it('slugifyPrompt : accents retirés, tronqué, fallback', () => {
    expect(slugifyPrompt('Faire le login')).toBe('faire-le-login');
    expect(slugifyPrompt('Refactor éàç ûï')).toBe('refactor-eac-ui');
    expect(slugifyPrompt('Un prompt très long qui dépasse largement la limite')).toMatch(
      /^[a-z0-9-]{1,24}$/,
    );
    expect(slugifyPrompt('!!! ???')).toBe('agent');
  });

  it('striart run "prompt" : nom d’agent dérivé du prompt, unique', async () => {
    mockRouter({ 'Faire le login': ['src/login.js'] });
    const first = await runTask({ root: repo.root, prompt: 'Faire le login' });
    expect(first.status).toBe('STARTED');
    expect(first.info.name).toBe('faire-le-login');
    expect((await readRegistry(repo.root))['faire-le-login']).toBeDefined();

    // Même prompt relancé → nom suffixé, pas de collision de nom.
    mockRouter({ 'Faire le login': ['src/autre.js'] });
    const second = await runTask({ root: repo.root, prompt: 'Faire le login' });
    expect(second.status).toBe('STARTED');
    expect(second.info.name).toBe('faire-le-login-2');
  });

  it('la file d’attente survit à un cycle enqueue/read', async () => {
    const task = await enqueueTask(repo.root, {
      agent: 'agent-x',
      prompt: 'p',
      predictedFiles: ['a.js'],
      collisions: [{ agent: 'agent-a', files: ['a.js'] }],
    });
    const queue = await readQueue(repo.root);
    expect(queue).toEqual([task]);
  });
});

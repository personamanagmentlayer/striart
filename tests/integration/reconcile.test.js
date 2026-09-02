import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTempRepo } from '../helpers/temp-repo.js';
import { initStriart } from '../../src/init.js';
import { readRegistry, removeAgentFromRegistry, updateAgentMeta } from '../../src/clone.js';
import { reconcile, runTask } from '../../src/orchestrator.js';
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

describe('striart reconcile (level-triggered)', () => {
  let repo;

  beforeEach(async () => {
    repo = await createTempRepo();
    await initStriart(repo.root);
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await repo.cleanup();
  });

  it('neutralise un PID de session mort laissé au registre', async () => {
    mockRouter({ fondation: ['db.js'] });
    await runTask({ root: repo.root, agent: 'a', prompt: 'fondation' });
    // Simule un crash de session autonome : un PID qui ne tourne plus reste
    // inscrit. 0x7fffffff est un PID quasi certainement mort.
    await updateAgentMeta(repo.root, 'a', { sessionPid: 0x7fffffff });

    const result = await reconcile({ root: repo.root });
    expect(result.sessionPidsCleared).toEqual(['a']);
    expect((await readRegistry(repo.root)).a.sessionPid).toBeNull();
  });

  it('ne touche pas un PID de session VIVANT', async () => {
    mockRouter({ fondation: ['db.js'] });
    await runTask({ root: repo.root, agent: 'a', prompt: 'fondation' });
    // process.pid est vivant : la session ne doit pas être neutralisée.
    await updateAgentMeta(repo.root, 'a', { sessionPid: process.pid });

    const result = await reconcile({ root: repo.root });
    expect(result.sessionPidsCleared).toEqual([]);
    expect((await readRegistry(repo.root)).a.sessionPid).toBe(process.pid);
  });

  it('débloque une tâche dont le bloqueur a disparu SANS passer par stopAgent', async () => {
    // db.js commun → b entre en collision avec a et va en file.
    mockRouter({ fondation: ['db.js'], facade: ['db.js'] });
    await runTask({ root: repo.root, agent: 'a', prompt: 'fondation' });
    const b = await runTask({ root: repo.root, agent: 'b', prompt: 'facade' });
    expect(b.status).toBe('QUEUED');

    // Le bloqueur est retiré du registre par un chemin qui NE rejoue PAS la
    // file (simule `striart clean` ou un crash) : la tâche reste coincée.
    await removeAgentFromRegistry(repo.root, 'a');
    expect((await readQueue(repo.root)).map((t) => t.agent)).toEqual(['b']);

    // La réconciliation la fait converger, sans action manuelle.
    const result = await reconcile({ root: repo.root });
    expect(result.started.map((s) => s.task.agent)).toEqual(['b']);
    expect((await readRegistry(repo.root)).b).toBeDefined();
    expect(await readQueue(repo.root)).toEqual([]);
  });

  it('est idempotente : une seconde passe sur un état stable ne change rien', async () => {
    mockRouter({ fondation: ['db.js'], facade: ['db.js'] });
    await runTask({ root: repo.root, agent: 'a', prompt: 'fondation' });
    await runTask({ root: repo.root, agent: 'b', prompt: 'facade' }); // en file (collision)

    const first = await reconcile({ root: repo.root });
    // a vit toujours → b reste bloquée, rien démarré.
    expect(first.started).toEqual([]);
    expect(first.sessionPidsCleared).toEqual([]);

    const second = await reconcile({ root: repo.root });
    expect(second.started).toEqual([]);
    expect(second.sessionPidsCleared).toEqual([]);
    // Registre inchangé entre les deux passes.
    expect(Object.keys(await readRegistry(repo.root)).sort()).toEqual(['a']);
    expect((await readQueue(repo.root)).map((t) => t.agent)).toEqual(['b']);
  });
});

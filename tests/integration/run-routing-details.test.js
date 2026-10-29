/**
 * `predictFilesDetailed` : le détail du Router (raison de sérialisation, tenue de
 * livre, expansions) est propagé dans le résultat de `runTask`, le registre, la
 * file et la vue d'état — SANS changer les décisions de collision.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createTempRepo } from '../helpers/temp-repo.js';
import { initStriart } from '../../src/init.ts';
import { runTask, getQueueDashboard } from '../../src/orchestrator.ts';
import { collectStatus } from '../../src/status.ts';
import { resetRootCache } from '../../src/tokens/call.ts';
import { resetUsageIndex } from '../../src/tokens/ledger.ts';

const llm = (payload) =>
  vi.fn(async () => ({ ok: true, json: async () => ({ response: JSON.stringify(payload) }) }));

describe('run : détails du Router propagés', () => {
  let repo;

  beforeEach(async () => {
    resetUsageIndex();
    resetRootCache();
    repo = await createTempRepo();
    await initStriart(repo.root);
    await writeFile(path.join(repo.root, 'a.js'), 'export const a = 1;\n');
    await writeFile(path.join(repo.root, 'CHANGELOG.md'), '# c\n');
    await repo.git.add(['a.js', 'CHANGELOG.md']);
    await repo.git.commit('chore: files');
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await repo.cleanup();
  });

  it('STARTED : `routing` porte fichiers, tenue de livre écartée, expansions ; décisions inchangées', async () => {
    vi.stubGlobal('fetch', llm({ files: ['a.js', 'CHANGELOG.md'] }));
    const result = await runTask({ root: repo.root, agent: 'agent-a', prompt: 'corrige a.js' });
    expect(result.status).toBe('STARTED');
    expect(result.predictedFiles).toEqual(['a.js']); // la tenue de livre reste hors collision
    expect(result.routing).toBeTruthy();
    expect(result.routing.shared).toEqual(['CHANGELOG.md']);
    expect(result.routing.files.map((f) => f.path)).toContain('a.js');
    expect(result.routing.serialized).toBeNull();
    // Le détail brut du LLM ne sort jamais.
    expect(JSON.stringify(result.routing)).not.toContain('"sample"');

    // Visible dans la vue d'état (agents) et la file (lignes RUNNING).
    const status = await collectStatus(repo.root);
    expect(status.agents.find((a) => a.name === 'agent-a').routing.shared).toEqual([
      'CHANGELOG.md',
    ]);
    const rows = await getQueueDashboard({ root: repo.root });
    expect(rows.find((r) => r.agent === 'agent-a').routing).toBeTruthy();
  });

  it('QUEUED : la raison de la mise en file (collision) est décidée comme avant, `routing` en plus', async () => {
    vi.stubGlobal('fetch', llm({ files: ['a.js'] }));
    await runTask({ root: repo.root, agent: 'agent-a', prompt: 'corrige a.js' });
    const queued = await runTask({
      root: repo.root,
      agent: 'agent-b',
      prompt: 'corrige aussi a.js',
    });
    expect(queued.status).toBe('QUEUED');
    expect(queued.collisions[0].agent).toBe('agent-a');
    expect(queued.routing.files.map((f) => f.path)).toContain('a.js');
    const row = (await getQueueDashboard({ root: repo.root })).find((r) => r.agent === 'agent-b');
    expect(row.routing.files.map((f) => f.path)).toContain('a.js');
    expect(row.status).toBe('WAITING');
  });

  it('sérialisation prudente : la raison est exposée', async () => {
    vi.stubGlobal(
      'fetch',
      llm({ files: [{ path: 'a.js', confidence: 0.9 }], scope: 'broad', confidence: 0.2 }),
    );
    await writeFile(
      path.join(repo.root, '.striartrc.json'),
      JSON.stringify({ tokens: { router: { prompt: 'v3' } } }),
    );
    const result = await runTask({ root: repo.root, agent: 'agent-a', prompt: 'renomme partout' });
    expect(result.predictedFiles).toEqual(['**']);
    expect(result.routing.serialized).toMatchObject({ kind: 'vague' });
  });
});

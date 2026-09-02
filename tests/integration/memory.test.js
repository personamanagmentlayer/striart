import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { simpleGit } from 'simple-git';
import { backdateDir, createTempRepo } from '../helpers/temp-repo.js';
import { initStriart } from '../../src/init.js';
import { createAgent, listAgents } from '../../src/clone.js';
import { mergeAgentCommit, runTask, stopAgent } from '../../src/orchestrator.js';
import {
  CLONE_MEMORY_FILE,
  refreshCloneMemories,
  updateMemoryAfterMerge,
} from '../../src/memory.js';

const GATE_OK = 'node -e "process.exit(0)"';
const SUMMARY = '- Nouvelle API : `hashPassword(password: string) → string` dans auth.js';

async function setConfig(root, config) {
  await writeFile(path.join(root, '.striartrc.json'), JSON.stringify(config));
}

async function commitInAgent(info, fileName, content, message) {
  const git = simpleGit(info.path);
  await git.addConfig('user.name', 'Agent');
  await git.addConfig('user.email', 'agent@example.com');
  await writeFile(path.join(info.path, fileName), content);
  await git.add([fileName]);
  await git.commit(message);
}

function mockLLM(response) {
  const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ response }) });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('Memory Layer (intégration)', () => {
  let repo;

  beforeEach(async () => {
    repo = await createTempRepo();
    await initStriart(repo.root);
    await setConfig(repo.root, { testCommand: GATE_OK, memoryLayer: true });
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await repo.cleanup();
  });

  it('après un merge : mémoire générée, diffusée aux clones actifs, worktrees toujours propres', async () => {
    const agentA = await createAgent({ root: repo.root, name: 'agent-a' });
    const agentB = await createAgent({ root: repo.root, name: 'agent-b' });
    const fetchMock = mockLLM(SUMMARY);

    await commitInAgent(
      agentA,
      'auth.js',
      'export function hashPassword(p) { return p; }\n',
      'feat: hashPassword',
    );
    const result = await mergeAgentCommit({ root: repo.root, agent: 'agent-a' });

    expect(result.status).toBe('MERGED');
    expect(result.memory).toMatchObject({ updated: true });
    // Le prompt du LLM contenait le diff du merge.
    const body = JSON.parse(fetchMock.mock.calls.at(-1)[1].body);
    expect(body.prompt).toContain('hashPassword');

    // Mémoire centrale écrite, entrée datée avec l'agent et le résumé.
    const central = await readFile(path.join(repo.root, '.striart', 'memory.md'), 'utf8');
    expect(central).toContain('agent agent-a');
    expect(central).toContain('hashPassword(password: string)');

    // L'AUTRE agent voit la mémoire dans son clone — c'est tout l'intérêt.
    const inCloneB = await readFile(path.join(agentB.path, CLONE_MEMORY_FILE), 'utf8');
    expect(inCloneB).toContain('hashPassword');
    // Untracked + ignoré localement : le worktree reste PROPRE (sinon le
    // rebase auto serait bloqué en SKIPPED_DIRTY à chaque cycle).
    expect((await simpleGit(agentB.path).status()).isClean()).toBe(true);
  });

  it('un nouvel agent démarre avec la mémoire existante', async () => {
    const agentA = await createAgent({ root: repo.root, name: 'agent-a' });
    mockLLM(SUMMARY);
    await commitInAgent(agentA, 'auth.js', 'export const x = 1;\n', 'feat: x');
    await mergeAgentCommit({ root: repo.root, agent: 'agent-a' });

    const late = await createAgent({ root: repo.root, name: 'agent-tardif' });
    const memory = await readFile(path.join(late.path, CLONE_MEMORY_FILE), 'utf8');
    expect(memory).toContain('hashPassword');
    expect((await simpleGit(late.path).status()).isClean()).toBe(true);
  });

  it('LLM injoignable → le merge PASSE quand même (advisory, jamais bloquant)', async () => {
    const agentA = await createAgent({ root: repo.root, name: 'agent-a' });
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));

    await commitInAgent(agentA, 'auth.js', 'export const x = 1;\n', 'feat: x');
    const result = await mergeAgentCommit({ root: repo.root, agent: 'agent-a' });

    expect(result.status).toBe('MERGED');
    expect(result.memory.updated).toBe(false);
    expect(result.memory.error).toBeTruthy();
  });

  it('temps réel : chaque agent voit les fichiers prédits des autres — actifs, en file, et le retrait au stop', async () => {
    // Le Router (LLM mocké) prédit des fichiers différents par tâche.
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ response: '{"files":["src/auth.js"]}' }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ response: '{"files":["src/billing.js"]}' }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ response: '{"files":["src/auth.js"]}' }),
      });
    vi.stubGlobal('fetch', fetchMock);

    await runTask({ root: repo.root, agent: 'agent-a', prompt: 'refondre le login' });
    await runTask({ root: repo.root, agent: 'agent-b', prompt: 'ajouter la facturation' });
    // Collision volontaire avec agent-a → QUEUED.
    const queued = await runTask({
      root: repo.root,
      agent: 'agent-c',
      prompt: 'retoucher le login',
    });
    expect(queued.status).toBe('QUEUED');

    // agent-a voit agent-b (actif) et agent-c (en file), jamais lui-même.
    const registry = await listAgents(repo.root);
    const cloneA = registry.find((a) => a.name === 'agent-a').path;
    const inA = await readFile(path.join(cloneA, CLONE_MEMORY_FILE), 'utf8');
    expect(inA).toContain('agent-b');
    expect(inA).toContain('src/billing.js');
    expect(inA).toContain('agent-c');
    expect(inA).toContain('en file');
    expect(inA).not.toContain('- **agent-a**');
    // Le worktree reste propre (untracked + exclu localement).
    expect((await simpleGit(cloneA).status()).isClean()).toBe(true);

    // agent-b voit agent-a et sa zone prédite.
    const cloneB = registry.find((a) => a.name === 'agent-b').path;
    const inB = await readFile(path.join(cloneB, CLONE_MEMORY_FILE), 'utf8');
    expect(inB).toContain('- **agent-a**');
    expect(inB).toContain('src/auth.js');

    // Stop d'agent-b (sans commit) → sa mention disparaît chez agent-a, et le
    // déblocage de la file y fait apparaître agent-c comme ACTIF désormais.
    await stopAgent({ root: repo.root, agent: 'agent-b' });
    const afterStop = await readFile(path.join(cloneA, CLONE_MEMORY_FILE), 'utf8');
    expect(afterStop).not.toContain('agent-b');
  });

  it('temps réel : écriture idempotente — un second passage sans changement ne touche aucun fichier', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ response: '{"files":["src/a.js"]}' }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ response: '{"files":["src/b.js"]}' }),
      });
    vi.stubGlobal('fetch', fetchMock);
    await runTask({ root: repo.root, agent: 'agent-a', prompt: 'tâche a' });
    await runTask({ root: repo.root, agent: 'agent-b', prompt: 'tâche b' });

    const { readRegistry } = await import('../../src/clone.js');
    const registry = await readRegistry(repo.root);
    // Premier passage explicite pour stabiliser, second mesuré.
    await refreshCloneMemories(repo.root, registry, []);
    const updated = await refreshCloneMemories(repo.root, registry, []);
    expect(updated).toBe(0);
  });

  it("présence : l'écriture de la mémoire par Striart ne marque PAS le clone comme session active", async () => {
    const agentA = await createAgent({ root: repo.root, name: 'agent-a' });
    await createAgent({
      root: repo.root,
      name: 'agent-b',
      predictedFiles: ['src/x.js'],
    });
    // Clone vieilli d'une heure : aucune activité de coding.
    await backdateDir(agentA.path);
    // Striart rafraîchit la mémoire (fichier écrit à l'instant dans le worktree).
    const { readRegistry } = await import('../../src/clone.js');
    await refreshCloneMemories(repo.root, await readRegistry(repo.root), []);
    expect(await readFile(path.join(agentA.path, CLONE_MEMORY_FILE), 'utf8')).toContain('agent-b');

    const a = (await listAgents(repo.root)).find((x) => x.name === 'agent-a');
    // Sans l'exclusion de CLONE_MEMORY_FILE de la mesure, ce serait true.
    expect(a.sessionActive).toBe(false);
  });

  it('fenêtre glissante : memoryMaxEntries borne le fichier', async () => {
    await setConfig(repo.root, { testCommand: GATE_OK, memoryLayer: true, memoryMaxEntries: 2 });
    const config = {
      ...JSON.parse(await readFile(path.join(repo.root, '.striartrc.json'), 'utf8')),
      ollamaModel: 'llama3.1:8b',
      ollamaHost: 'http://localhost:11434',
      llm: null,
      memoryMaxEntries: 2,
    };
    mockLLM('- API n');

    for (let i = 1; i <= 3; i += 1) {
      const result = await updateMemoryAfterMerge({
        root: repo.root,
        config,
        agent: `agent-${i}`,
        sha: String(i).repeat(40),
        diff: 'diff',
      });
      expect(result.updated).toBe(true);
    }
    const central = await readFile(path.join(repo.root, '.striart', 'memory.md'), 'utf8');
    const entries = central.match(/^## /gm) ?? [];
    expect(entries).toHaveLength(2);
    // Les plus récentes en tête, la plus ancienne évincée.
    expect(central).toContain('agent-3');
    expect(central).toContain('agent-2');
    expect(central).not.toContain('agent-1');
  });
});

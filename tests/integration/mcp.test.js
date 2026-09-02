import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execa } from 'execa';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { simpleGit } from 'simple-git';
import { writeFile } from 'node:fs/promises';
import { createTempRepo } from '../helpers/temp-repo.js';
import { initStriart } from '../../src/init.js';
import { createAgent } from '../../src/clone.js';
import { handleMcpRequest } from '../../src/mcp.js';

const CLI = fileURLToPath(new URL('../../src/cli.js', import.meta.url));

/**
 * Client MCP stdio minimal : envoie des requêtes ligne à ligne, collecte les
 * réponses par id. Le serveur ne termine qu'à la fermeture de stdin.
 */
async function mcpSession(root, requests) {
  const subprocess = execa(process.execPath, [CLI, 'mcp'], {
    cwd: root,
    reject: false,
    input: requests.map((r) => JSON.stringify(r)).join('\n') + '\n',
    timeout: 60_000,
  });
  const { stdout, exitCode } = await subprocess;
  const responses = stdout
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  return { responses, exitCode, byId: new Map(responses.map((r) => [r.id, r])) };
}

describe('striart mcp (intégration stdio)', () => {
  let repo;

  beforeEach(async () => {
    repo = await createTempRepo();
    await initStriart(repo.root);
  });

  afterEach(async () => {
    await repo.cleanup();
  });

  it('poignée de main, liste des outils, status et queue sur un vrai repo', async () => {
    await createAgent({ root: repo.root, name: 'agent-mcp' });

    const { responses, byId, exitCode } = await mcpSession(repo.root, [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: 'striart_status', arguments: {} },
      },
      {
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/call',
        params: { name: 'striart_queue', arguments: {} },
      },
    ]);

    expect(exitCode).toBe(0);
    // stdout ne porte QUE du JSON-RPC : la moindre ligne de log le romprait.
    expect(responses).toHaveLength(4); // la notification ne répond pas

    expect(byId.get(1).result.serverInfo.name).toBe('striart');
    expect(byId.get(2).result.tools).toHaveLength(5);

    const status = JSON.parse(byId.get(3).result.content[0].text);
    expect(status.agents.map((a) => a.name)).toContain('agent-mcp');
    expect(status.daemon.running).toBe(false);

    const queue = JSON.parse(byId.get(4).result.content[0].text);
    expect(Array.isArray(queue)).toBe(true);
  });

  it('striart_merge de bout en bout : commit agent → merge + Test Gate verts', async () => {
    await writeFile(
      path.join(repo.root, '.striartrc.json'),
      JSON.stringify({ testCommand: 'node -e "process.exit(0)"' }),
    );
    const info = await createAgent({ root: repo.root, name: 'agent-a' });
    const git = simpleGit(info.path);
    await git.addConfig('user.name', 'A');
    await git.addConfig('user.email', 'a@a.a');
    await writeFile(path.join(info.path, 'f.js'), 'export const x = 1;\n');
    await git.add(['f.js']);
    await git.commit('feat: x');

    const { byId } = await mcpSession(repo.root, [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
      {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'striart_merge', arguments: { agent: 'agent-a' } },
      },
    ]);

    const merge = JSON.parse(byId.get(2).result.content[0].text);
    expect(merge.status).toBe('MERGED');
    const log = await simpleGit(repo.root).log();
    expect(log.latest.message).toContain('striart');
  });

  it('une ligne surdimensionnée est rejetée sans planter le serveur', async () => {
    // Borne anti-OOM : une requête > 1 Mo est refusée (parse error), et le
    // serveur reste vivant pour la requête suivante.
    const huge = '{"jsonrpc":"2.0","id":9,"method":"ping","x":"' + 'A'.repeat(1_100_000) + '"}';
    const subprocess = execa(process.execPath, [CLI, 'mcp'], {
      cwd: repo.root,
      reject: false,
      input: huge + '\n' + JSON.stringify({ jsonrpc: '2.0', id: 10, method: 'ping' }) + '\n',
      timeout: 60_000,
    });
    const { stdout, exitCode } = await subprocess;
    const responses = stdout
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l));
    expect(exitCode).toBe(0);
    // La ligne géante → erreur de parse ; le ping suivant → réponse normale.
    expect(responses.some((r) => r.error && r.error.code === -32700)).toBe(true);
    expect(responses.some((r) => r.id === 10 && r.result)).toBe(true);
  });

  it('un agent inconnu revient en isError lisible, le serveur survit', async () => {
    const { byId, exitCode } = await mcpSession(repo.root, [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
      {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'striart_merge', arguments: { agent: 'fantome' } },
      },
      { jsonrpc: '2.0', id: 3, method: 'ping' },
    ]);
    expect(byId.get(2).result.isError).toBe(true);
    expect(byId.get(2).result.content[0].text).toContain('AGENT_UNKNOWN');
    // Le serveur a survécu à l'échec métier : le ping suivant répond.
    expect(byId.get(3).result).toEqual({});
    expect(exitCode).toBe(0);
  });
});

describe('MCP — handlers en process (couverture réelle des outils)', () => {
  let repo;

  beforeEach(async () => {
    repo = await createTempRepo();
    await initStriart(repo.root);
    await writeFile(
      path.join(repo.root, '.striartrc.json'),
      JSON.stringify({ testCommand: 'node -e "process.exit(0)"' }),
    );
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await repo.cleanup();
  });

  const call = (name, args = {}) =>
    handleMcpRequest(
      { root: repo.root, env: {} },
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } },
    );

  it('striart_status agrège agents, file, tickets, état et watcher sur un vrai repo', async () => {
    await createAgent({ root: repo.root, name: 'agent-a' });
    const res = await call('striart_status');
    expect(res.result.isError).toBeUndefined();
    const state = JSON.parse(res.result.content[0].text);
    expect(state.agents.map((a) => a.name)).toEqual(['agent-a']);
    expect(state).toMatchObject({ tickets: [], daemon: { running: false } });
    expect(state.queue).toBeDefined();
  });

  it('striart_run lance une tâche via le Router (LLM mocké) et striart_queue la voit', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue({ ok: true, json: async () => ({ response: '{"files":["a.js"]}' }) }),
    );
    const run = await call('striart_run', { prompt: 'faire le travail', agent: 'agent-mcp' });
    expect(JSON.parse(run.result.content[0].text).status).toBe('STARTED');

    const queue = await call('striart_queue');
    expect(queue.result.isError).toBeUndefined();
    const rows = JSON.parse(queue.result.content[0].text);
    expect(rows.find((t) => t.agent === 'agent-mcp')).toMatchObject({ status: 'RUNNING' });
  });

  it('striart_merge sans commit → UP_TO_DATE ; striart_resolve inconnu → isError typé', async () => {
    await createAgent({ root: repo.root, name: 'agent-a' });
    const merge = await call('striart_merge', { agent: 'agent-a' });
    expect(JSON.parse(merge.result.content[0].text).status).toBe('UP_TO_DATE');

    const resolve = await call('striart_resolve', { ticketId: 'ticket-fantome' });
    expect(resolve.result.isError).toBe(true);
    expect(resolve.result.content[0].text).toContain('TICKET_UNKNOWN');
  });
});

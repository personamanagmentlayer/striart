/**
 * La garde « ticket déjà résolu » vit dans `closeConflictTicket` (domaine) : elle vaut pour la CLI,
 * le Control Protocol (dont le dashboard n'est qu'un client), et le MCP n'a — par construction —
 * aucun outil de fermeture (seulement `striart_resolve_apply`, déjà gardé par l'orchestrateur).
 * Écrit AVANT le déplacement de la garde hors de la CLI.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createTempRepo } from '../helpers/temp-repo.js';
import { initStriart } from '../../src/init.js';
import {
  closeConflictTicket,
  createConflictTicket,
  listConflictTickets,
} from '../../src/conflicts.js';
import { startDashboard } from '../../src/dashboard.js';
import { handleMcpRequest } from '../../src/mcp.js';
import { call, rpc, signIn, useLoopbackDashboard } from '../helpers/control-client.js';

const CLI = fileURLToPath(new URL('../../src/cli.js', import.meta.url));

function runCli(args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd,
      env: { ...process.env, STRIART_LANG: 'en' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

async function newTicket(root, sha = 'a') {
  return createConflictTicket(root, {
    agent: 'agent-a',
    branch: 'striart/agent-a/task-x',
    sha: sha.repeat(40),
    reason: 'MERGE_CONFLICT',
    conflictedFiles: ['src/a.ts'],
    resolutions: [{ path: 'src/a.ts', base: 'b', ours: 'o', theirs: 't', llmAttempt: null }],
  });
}

describe('closeConflictTicket — garde « déjà résolu » dans le domaine', () => {
  let repo;
  beforeEach(async () => {
    repo = await createTempRepo();
    await initStriart(repo.root);
  });
  afterEach(async () => {
    await repo.cleanup();
  });

  it('domaine : la première fermeture réussit, la seconde est refusée TICKET_ALREADY_RESOLVED', async () => {
    const ticket = await newTicket(repo.root);
    const closed = await closeConflictTicket(repo.root, ticket.id);
    expect(closed.resolved).toBe(true);
    await expect(closeConflictTicket(repo.root, ticket.id)).rejects.toMatchObject({
      code: 'TICKET_ALREADY_RESOLVED',
      details: { ticketId: ticket.id },
    });
    // Le marqueur d'origine n'est pas réécrit par la tentative refusée.
    expect(await listConflictTickets(repo.root)).toHaveLength(0);
  });

  it('domaine : un ticket inconnu reste TICKET_UNKNOWN', async () => {
    await expect(closeConflictTicket(repo.root, 'fantome')).rejects.toMatchObject({
      code: 'TICKET_UNKNOWN',
    });
  });

  it('domaine : l’option idempotente (fermetures internes de doublons) ne lève pas', async () => {
    const ticket = await newTicket(repo.root);
    await closeConflictTicket(repo.root, ticket.id);
    const again = await closeConflictTicket(repo.root, ticket.id, { idempotent: true });
    expect(again.resolved).toBe(true);
  });

  it('CLI : resolve --close deux fois → sortie 0 puis 3 TICKET_ALREADY_RESOLVED', async () => {
    const ticket = await newTicket(repo.root);
    const first = await runCli(['resolve', '--close', ticket.id], repo.root);
    expect(first.code).toBe(0);
    const second = await runCli(['resolve', '--close', ticket.id], repo.root);
    expect(second.code).toBe(3);
    expect(second.stderr).toContain('TICKET_ALREADY_RESOLVED');
  });

  it('Control Protocol / dashboard : ticket.close deux fois → refus typé (kind refusal)', async () => {
    await useLoopbackDashboard(repo.root);
    const ticket = await newTicket(repo.root);
    const server = await startDashboard({ root: repo.root, port: 0 });
    try {
      const { cookie } = await signIn(server);
      const ok = await call(server, cookie, 'ticket.close', { id: ticket.id });
      expect(ok.data).toMatchObject({ action: 'close', ticket: { id: ticket.id, resolved: true } });
      const again = await rpc(server, cookie, 'ticket.close', { id: ticket.id });
      expect(again.body.error.data.error).toMatchObject({
        code: 'TICKET_ALREADY_RESOLVED',
        kind: 'refusal',
      });
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('MCP : aucun outil de fermeture ; striart_resolve_apply sur un ticket résolu → TICKET_ALREADY_RESOLVED', async () => {
    const ticket = await newTicket(repo.root);
    await closeConflictTicket(repo.root, ticket.id);
    const caller = { agent: null, boundBy: null, readOnly: false, scope: 'orchestrator' };
    const ctx = { root: repo.root, env: {}, caller };
    const tools = (await handleMcpRequest(ctx, { jsonrpc: '2.0', id: 1, method: 'tools/list' }))
      .result.tools;
    expect(tools.map((t) => t.name).filter((n) => /close/i.test(n))).toEqual([]);
    const res = await handleMcpRequest(ctx, {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'striart_resolve_apply', arguments: { ticketId: ticket.id } },
    });
    expect(res.result.isError).toBe(true);
    expect(res.result.content[0].text).toContain('TICKET_ALREADY_RESOLVED');
  });
});

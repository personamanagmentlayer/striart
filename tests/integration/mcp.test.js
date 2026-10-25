import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execa } from 'execa';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { simpleGit } from 'simple-git';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createTempRepo } from '../helpers/temp-repo.js';
import { initStriart } from '../../src/init.js';
import { createAgent } from '../../src/clone.js';
import { createCollabGroup } from '../../src/collab/channel.ts';
import { mergeAgentCommit, promoteStaging } from '../../src/orchestrator.js';
import { withMainLock } from '../../src/lock.js';
import { handleMcpRequest, startMcpServer } from '../../src/mcp.js';
import { resolveMcpSettings } from '../../src/mcp/settings.ts';

const CLI = fileURLToPath(new URL('../../src/cli.js', import.meta.url));
const ORCHESTRATOR = { agent: null, boundBy: null, readOnly: false, scope: 'orchestrator' };
const GATE_OK = 'node -e "process.exit(0)"';

/** Environnement du serveur lancé : sans la garde de profondeur héritée d'un éventuel parent. */
const cleanEnv = (extra = {}) => {
  const env = { ...process.env, ...extra };
  if (!('STRIART_SESSION' in extra)) delete env.STRIART_SESSION;
  return env;
};

/**
 * Client MCP stdio minimal : envoie des requêtes ligne à ligne, collecte les
 * réponses par id. Le serveur ne termine qu'à la fermeture de stdin.
 */
async function mcpSession(cwd, requests, { args = [], env = {} } = {}) {
  const subprocess = execa(process.execPath, [CLI, 'mcp', ...args], {
    cwd,
    reject: false,
    env: cleanEnv(env),
    extendEnv: false,
    input: requests.map((r) => JSON.stringify(r)).join('\n') + '\n',
    timeout: 60_000,
  });
  const { stdout, stderr, exitCode } = await subprocess;
  const responses = stdout
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  return { responses, exitCode, stderr, byId: new Map(responses.map((r) => [r.id, r])) };
}

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

const listNames = (response) => response.result.tools.map((t) => t.name);

describe('striart mcp (intégration stdio)', () => {
  let repo;

  beforeEach(async () => {
    repo = await createTempRepo();
    await initStriart(repo.root);
  });

  afterEach(async () => {
    await repo.cleanup();
  });

  it('depuis le principal sans mcp.scope : poignée de main, lecture seule, status et queue', async () => {
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
      {
        jsonrpc: '2.0',
        id: 5,
        method: 'tools/call',
        params: { name: 'striart_merge', arguments: { agent: 'agent-mcp' } },
      },
    ]);

    expect(exitCode).toBe(0);
    // stdout ne porte QUE du JSON-RPC : la moindre ligne de log le romprait.
    expect(responses).toHaveLength(5); // la notification ne répond pas

    expect(byId.get(1).result.serverInfo.name).toBe('striart');
    // D6 : hors clone, sans mcp.scope: 'orchestrator', aucun outil mutant.
    expect(listNames(byId.get(2))).toEqual(['striart_status', 'striart_queue', 'striart_ticket']);

    const status = JSON.parse(byId.get(3).result.content[0].text);
    expect(status.agents.map((a) => a.name)).toContain('agent-mcp');
    expect(status.daemon.running).toBe(false);
    expect(byId.get(3).result.structuredContent.agents).toHaveLength(1);

    const queue = JSON.parse(byId.get(4).result.content[0].text);
    expect(Array.isArray(queue)).toBe(true);

    expect(byId.get(5).result._meta['striart/error'].code).toBe('MCP_SCOPE_DENIED');
  });

  it('niveau orchestrateur (config explicite) : striart_merge de bout en bout, Test Gate vert', async () => {
    await setConfig(repo.root, { testCommand: GATE_OK, mcp: { scope: 'orchestrator' } });
    const info = await createAgent({ root: repo.root, name: 'agent-a' });
    await commitInAgent(info, 'f.js', 'export const x = 1;\n', 'feat: x');

    const { byId, stderr } = await mcpSession(repo.root, [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: 'striart_merge', arguments: { agent: 'agent-a' } },
      },
    ]);

    expect(listNames(byId.get(2))).toContain('striart_run');
    const merge = JSON.parse(byId.get(3).result.content[0].text);
    expect(merge.status).toBe('MERGED');
    expect(byId.get(3).result.structuredContent.status).toBe('MERGED');
    const log = await simpleGit(repo.root).log();
    expect(log.latest.message).toContain('striart');
    // Le relâchement est journalisé (stderr) au démarrage.
    expect(stderr).toMatch(/orchestrator scope/);
  });

  it('ère moderne sans poignée de main : server/discover puis tools/call servis en 2026-07-28', async () => {
    const meta = {
      'io.modelcontextprotocol/protocolVersion': '2026-07-28',
      'io.modelcontextprotocol/clientCapabilities': {},
    };
    const { byId } = await mcpSession(repo.root, [
      { jsonrpc: '2.0', id: 1, method: 'server/discover', params: { _meta: meta } },
      {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'striart_status', arguments: {}, _meta: meta },
      },
      {
        jsonrpc: '2.0',
        id: 3,
        method: 'resources/read',
        params: { uri: 'striart://status', _meta: meta },
      },
    ]);
    expect(byId.get(1).result.supportedVersions).toContain('2026-07-28');
    expect(byId.get(2).result.resultType).toBe('complete');
    expect(byId.get(2).result.structuredContent.daemon.running).toBe(false);
    expect(JSON.parse(byId.get(3).result.contents[0].text).agents).toEqual([]);
  });

  it('une ligne surdimensionnée est rejetée sans planter le serveur', async () => {
    // Borne anti-OOM (mcp.maxLineBytes, 1 Mio par défaut) : la ligne est
    // écartée au fil de l'eau, le serveur reste vivant pour la suivante.
    const huge = '{"jsonrpc":"2.0","id":9,"method":"ping","x":"' + 'A'.repeat(1_100_000) + '"}';
    const subprocess = execa(process.execPath, [CLI, 'mcp'], {
      cwd: repo.root,
      reject: false,
      env: cleanEnv(),
      extendEnv: false,
      input: huge + '\n' + JSON.stringify({ jsonrpc: '2.0', id: 10, method: 'ping' }) + '\n',
      timeout: 60_000,
    });
    const { stdout, exitCode } = await subprocess;
    const responses = stdout
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l));
    expect(exitCode).toBe(0);
    expect(responses.some((r) => r.error && r.error.code === -32700)).toBe(true);
    expect(responses.some((r) => r.id === 10 && r.result)).toBe(true);
    expect(responses.some((r) => r.id === 9)).toBe(false);
  });

  it('un agent inconnu revient en isError lisible, le serveur survit', async () => {
    await setConfig(repo.root, { mcp: { scope: 'orchestrator' } });
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
    expect(byId.get(3).result).toEqual({});
    expect(exitCode).toBe(0);
  });
});

describe('striart mcp — bornage au clone appelant (D6)', () => {
  let repo;
  let agentA;
  let agentB;

  beforeEach(async () => {
    repo = await createTempRepo();
    await initStriart(repo.root);
    await setConfig(repo.root, { testCommand: GATE_OK });
    agentA = await createAgent({ root: repo.root, name: 'agent-a' });
    agentB = await createAgent({ root: repo.root, name: 'agent-b' });
    await commitInAgent(agentA, 'a.js', 'export const a = 1;\n', 'feat: a');
    await commitInAgent(agentB, 'b.js', 'export const b = 1;\n', 'feat: b');
  });

  afterEach(async () => {
    await repo.cleanup();
  });

  it('lancé depuis le clone : racine principale résolue, borné à son agent', async () => {
    const { byId, exitCode } = await mcpSession(path.join(agentA.path), [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
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
        params: { name: 'striart_merge', arguments: { agent: 'agent-b' } },
      },
      {
        jsonrpc: '2.0',
        id: 5,
        method: 'tools/call',
        params: { name: 'striart_merge', arguments: {} },
      },
    ]);
    expect(exitCode).toBe(0);
    const names = listNames(byId.get(2));
    expect(names).toContain('striart_merge');
    expect(names).not.toContain('striart_run');
    // La vue d'état est celle du PRINCIPAL (le clone n'a pas de .striart/).
    const status = JSON.parse(byId.get(3).result.content[0].text);
    expect(status.agents.map((a) => a.name).sort()).toEqual(['agent-a', 'agent-b']);
    // Hors périmètre : refusé, rien n'est mergé.
    expect(byId.get(4).result._meta['striart/error'].code).toBe('MCP_SCOPE_DENIED');
    // Son propre agent (argument par défaut) : mergé.
    expect(byId.get(5).result.structuredContent).toMatchObject({
      status: 'MERGED',
      agent: 'agent-a',
    });
    const files = await simpleGit(repo.root).raw(['ls-tree', '--name-only', 'HEAD']);
    expect(files).toContain('a.js');
    expect(files).not.toContain('b.js');
  });

  it('--root --agent --read-only sous STRIART_SESSION=1 (contrat ACP) : lecture seule nommée', async () => {
    const elsewhere = await mkdtemp(path.join(os.tmpdir(), 'striart-mcp-cwd-'));
    try {
      const { byId, exitCode } = await mcpSession(
        elsewhere,
        [
          { jsonrpc: '2.0', id: 1, method: 'tools/list' },
          {
            jsonrpc: '2.0',
            id: 2,
            method: 'tools/call',
            params: { name: 'striart_merge', arguments: {} },
          },
          {
            jsonrpc: '2.0',
            id: 3,
            method: 'tools/call',
            params: { name: 'striart_queue', arguments: {} },
          },
        ],
        {
          args: ['--root', repo.root, '--agent', 'agent-a', '--read-only'],
          env: { STRIART_SESSION: '1' },
        },
      );
      expect(exitCode).toBe(0);
      // Lecture seule : seule la LECTURE du canal de collaboration reste exposée.
      expect(listNames(byId.get(1))).toEqual([
        'striart_status',
        'striart_queue',
        'striart_ticket',
        'striart_collab_read',
      ]);
      expect(byId.get(2).result._meta['striart/error'].code).toBe('MCP_READ_ONLY');
      expect(byId.get(3).result.isError).toBeUndefined();
    } finally {
      await rm(elsewhere, { recursive: true, force: true });
    }
  });

  it('--read-only --collab (contrat ACP) : post accordé, merge toujours refusé ; sans agent, --collab inerte', async () => {
    const elsewhere = await mkdtemp(path.join(os.tmpdir(), 'striart-mcp-cwd-'));
    try {
      const requests = [
        { jsonrpc: '2.0', id: 1, method: 'tools/list' },
        {
          jsonrpc: '2.0',
          id: 2,
          method: 'tools/call',
          params: { name: 'striart_merge', arguments: {} },
        },
      ];
      const bound = await mcpSession(elsewhere, requests, {
        args: ['--root', repo.root, '--agent', 'agent-a', '--read-only', '--collab'],
        env: { STRIART_SESSION: '1' },
      });
      expect(bound.exitCode).toBe(0);
      expect(listNames(bound.byId.get(1))).toEqual([
        'striart_status',
        'striart_queue',
        'striart_ticket',
        'striart_collab_read',
        'striart_collab_post',
      ]);
      expect(bound.byId.get(2).result._meta['striart/error'].code).toBe('MCP_READ_ONLY');

      const unbound = await mcpSession(elsewhere, requests.slice(0, 1), {
        args: ['--root', repo.root, '--read-only', '--collab'],
        env: { STRIART_SESSION: '1' },
      });
      expect(unbound.exitCode).toBe(0);
      expect(listNames(unbound.byId.get(1))).toEqual([
        'striart_status',
        'striart_queue',
        'striart_ticket',
      ]);
    } finally {
      await rm(elsewhere, { recursive: true, force: true });
    }
  });

  it('canal de collaboration de bout en bout : deux clones, STRIART_SESSION=1 (profondeur 1), expéditeur déduit du clone', async () => {
    const a = agentA;
    const b = agentB;
    const group = await createCollabGroup(repo.root, {
      kind: 'team',
      members: [
        { agent: 'agent-a', role: 'impl' },
        { agent: 'agent-b', role: 'tests' },
      ],
    });
    const tool = (id, name, args) => ({
      jsonrpc: '2.0',
      id,
      method: 'tools/call',
      params: { name, arguments: args },
    });
    const nested = { env: { STRIART_SESSION: '1' } };

    // agent-a (cwd = son clone) : outils exposés à profondeur 1, mutants Striart refusés.
    const posted = await mcpSession(
      a.path,
      [
        { jsonrpc: '2.0', id: 1, method: 'tools/list' },
        tool(2, 'striart_collab_post', {
          kind: 'question',
          to: 'tests',
          body: 'Quelle signature pour parse() ?',
        }),
        tool(3, 'striart_collab_post', { kind: 'note', body: 'x', to: 'role-inconnu' }),
        tool(4, 'striart_collab_post', { kind: 'verdict', body: '{"verdict":"approve"}' }),
        tool(5, 'striart_collab_post', { kind: 'note', body: 'x', agent: 'agent-b' }),
        tool(6, 'striart_merge', {}),
      ],
      nested,
    );
    expect(posted.exitCode).toBe(0);
    expect(listNames(posted.byId.get(1))).toEqual([
      'striart_status',
      'striart_queue',
      'striart_ticket',
      'striart_collab_read',
      'striart_collab_post',
    ]);
    expect(posted.byId.get(2).result.structuredContent.message).toMatchObject({
      seq: 1,
      group: group.id,
      from: { agent: 'agent-a', role: 'impl' },
      to: 'tests',
      kind: 'question',
    });
    expect(posted.byId.get(3).result._meta['striart/error'].code).toBe('COLLAB_RECIPIENT_UNKNOWN');
    // La garde « relecteur pendant son tour » est celle du canal : agent-a n'est pas relecteur.
    expect(posted.byId.get(4).result._meta['striart/error'].code).toBe('COLLAB_KIND_FORBIDDEN');
    expect(posted.byId.get(5).result._meta['striart/error'].code).toBe('INVALID_ARGUMENT');
    expect(posted.byId.get(6).result._meta['striart/error'].code).toBe('MCP_DEPTH_LIMIT');

    // agent-b lit : le message de a, encadré NON FIABLE ; jamais ses propres messages ; rien pour un tiers.
    const read = await mcpSession(
      b.path,
      [tool(1, 'striart_collab_read', {}), tool(2, 'striart_collab_read', { sinceSeq: 1 })],
      nested,
    );
    const first = read.byId.get(1).result.structuredContent;
    expect(first.groups).toEqual([{ id: group.id, seq: 1 }]);
    expect(first.messages).toHaveLength(1);
    expect(first.messages[0]).toMatchObject({ seq: 1, from: { agent: 'agent-a', role: 'impl' } });
    expect(first.messages[0].body).toContain('<<<STRIART-UNTRUSTED ');
    expect(first.messages[0].body).toContain('Quelle signature pour parse() ?');
    expect(read.byId.get(2).result.structuredContent.messages).toEqual([]);

    const own = await mcpSession(a.path, [tool(1, 'striart_collab_read', {})], nested);
    expect(own.byId.get(1).result.structuredContent.messages).toEqual([]);

    // Depuis le principal (aucun agent appelant) : le canal n'est pas exposé.
    const main = await mcpSession(repo.root, [
      { jsonrpc: '2.0', id: 1, method: 'tools/list' },
      tool(2, 'striart_collab_read', {}),
    ]);
    expect(listNames(main.byId.get(1))).not.toContain('striart_collab_read');
    expect(main.byId.get(2).result._meta['striart/error'].code).toBe('MCP_SCOPE_DENIED');
  });

  it('valeurs invalides refusées AVANT de servir (stdout vide) : root, agent inconnu, contradiction', async () => {
    const notInit = await mkdtemp(path.join(os.tmpdir(), 'striart-mcp-noinit-'));
    try {
      const badRoot = await mcpSession(repo.root, [], { args: ['--root', notInit] });
      expect(badRoot.exitCode).toBe(2);
      expect(badRoot.stderr).toContain('MCP_ROOT_INVALID');
      expect(badRoot.responses).toHaveLength(0);
    } finally {
      await rm(notInit, { recursive: true, force: true });
    }
    const unknown = await mcpSession(repo.root, [], { args: ['--agent', 'fantome'] });
    expect(unknown.exitCode).toBe(1);
    expect(unknown.stderr).toContain('AGENT_UNKNOWN');
    expect(unknown.responses).toHaveLength(0);

    const conflict = await mcpSession(agentA.path, [], { args: ['--agent', 'agent-b'] });
    expect(conflict.exitCode).toBe(2);
    expect(conflict.stderr).toContain('MCP_SCOPE_CONFLICT');
    expect(conflict.responses).toHaveLength(0);

    const badName = await mcpSession(repo.root, [], { args: ['--agent', '../x'] });
    expect(badName.exitCode).toBe(2);
    expect(badName.responses).toHaveLength(0);
  });
});

/** Script de Test Gate qui journalise ses intervalles (détection de chevauchement). */
async function writeGateScript(dir) {
  const script = path.join(dir, 'gate.mjs');
  await writeFile(
    script,
    [
      "import { appendFileSync } from 'node:fs';",
      'const [log, ms] = process.argv.slice(2);',
      'appendFileSync(log, `start ${Date.now()}\\n`);',
      'setTimeout(() => { appendFileSync(log, `end ${Date.now()}\\n`); }, Number(ms));',
    ].join('\n'),
  );
  return script;
}

const gateCommand = (script, log, ms) => `node "${script}" "${log}" ${ms}`;

describe('MCP — annulation et concurrence sur un vrai dépôt (en process)', () => {
  let repo;
  let scratch;

  beforeEach(async () => {
    repo = await createTempRepo();
    scratch = await mkdtemp(path.join(os.tmpdir(), 'striart-mcp-gate-'));
  });

  afterEach(async () => {
    await repo.cleanup();
    await rm(scratch, { recursive: true, force: true });
  });

  const startLoop = () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const chunks = [];
    output.on('data', (c) => chunks.push(c.toString()));
    const done = startMcpServer({
      root: repo.root,
      env: {},
      caller: ORCHESTRATOR,
      settings: resolveMcpSettings(null),
      input,
      output,
    });
    const responses = () =>
      chunks
        .join('')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l));
    const send = (msg) => input.write(`${JSON.stringify(msg)}\n`);
    return { input, send, responses, done };
  };

  const waitFor = async (predicate, timeoutMs = 30_000) => {
    const deadline = Date.now() + timeoutMs;
    while (!(await predicate())) {
      if (Date.now() > deadline) throw new Error('condition jamais remplie');
      await new Promise((r) => setTimeout(r, 50));
    }
  };

  it('notifications/cancelled pendant le Test Gate : pas de réponse, merge mené à terme, dépôt jamais laissé en « merging »', async () => {
    await initStriart(repo.root);
    const script = await writeGateScript(scratch);
    const gateLog = path.join(scratch, 'gate.log');
    await setConfig(repo.root, { testCommand: gateCommand(script, gateLog, 1500) });
    const info = await createAgent({ root: repo.root, name: 'agent-a' });
    await commitInAgent(info, 'f.js', 'export const x = 1;\n', 'feat: x');

    const { input, send, responses, done } = startLoop();
    send({
      jsonrpc: '2.0',
      id: 41,
      method: 'tools/call',
      params: { name: 'striart_merge', arguments: { agent: 'agent-a' } },
    });
    // Le Test Gate a démarré : le merge --no-commit est en cours sous verrou.
    await waitFor(async () => (await readFile(gateLog, 'utf8').catch(() => '')).includes('start'));
    expect(await stat(path.join(repo.root, '.git', 'MERGE_HEAD')).catch(() => null)).not.toBeNull();
    send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 41 } });
    input.end();
    await done; // la fin de stdin ATTEND le merge en vol

    expect(responses().filter((r) => r.id === 41)).toHaveLength(0);
    expect(await stat(path.join(repo.root, '.git', 'MERGE_HEAD')).catch(() => null)).toBeNull();
    const log = await simpleGit(repo.root).log();
    expect(log.latest.message).toContain('striart');
    expect(await readFile(gateLog, 'utf8')).toMatch(/end/);
  });

  it('annulé pendant l’attente du verrou principal : le merge ne démarre JAMAIS', async () => {
    await initStriart(repo.root);
    await setConfig(repo.root, { testCommand: GATE_OK });
    const info = await createAgent({ root: repo.root, name: 'agent-a' });
    await commitInAgent(info, 'f.js', 'export const x = 1;\n', 'feat: x');
    const headBefore = (await repo.git.revparse(['HEAD'])).trim();

    // Une autre opération tient le verrou (même process, autre contexte async).
    let releaseHolder;
    const holder = withMainLock(
      repo.root,
      'test-holder',
      () => new Promise((r) => (releaseHolder = r)),
    );
    await waitFor(async () => releaseHolder !== undefined);

    const { input, send, responses, done } = startLoop();
    send({
      jsonrpc: '2.0',
      id: 51,
      method: 'tools/call',
      params: { name: 'striart_merge', arguments: { agent: 'agent-a' } },
    });
    await new Promise((r) => setTimeout(r, 500)); // le merge attend le verrou
    send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 51 } });
    await new Promise((r) => setTimeout(r, 300));
    releaseHolder();
    await holder;
    input.end();
    await done;

    expect(responses().filter((r) => r.id === 51)).toHaveLength(0);
    // Rien n'a été mergé : la tête n'a pas bougé, aucun merge en cours.
    expect((await repo.git.revparse(['HEAD'])).trim()).toBe(headBefore);
    expect(await stat(path.join(repo.root, '.git', 'MERGE_HEAD')).catch(() => null)).toBeNull();
  });

  it('striart_promote (niveau orchestrateur) : Test Gate global puis fast-forward de main', async () => {
    const STAGING = 'striart/staging';
    await repo.git.checkoutLocalBranch(STAGING);
    await initStriart(repo.root);
    await setConfig(repo.root, { testCommand: GATE_OK, targetBranch: STAGING, mainBranch: 'main' });
    const a = await createAgent({ root: repo.root, name: 'agent-a' });
    await commitInAgent(a, 'a.js', 'export const a = 1;\n', 'feat: a');
    expect((await mergeAgentCommit({ root: repo.root, agent: 'agent-a' })).status).toBe('MERGED');
    const r = await handleMcpRequest(
      { root: repo.root, env: {}, caller: ORCHESTRATOR },
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'striart_promote', arguments: {} },
      },
    );
    expect(r.result.structuredContent.status).toBe('PROMOTED');
    expect((await repo.git.revparse(['main'])).trim()).toBe(
      (await repo.git.revparse([STAGING])).trim(),
    );
  });

  it('deux merges MCP simultanés et un promote concurrent ne se chevauchent jamais (verrou L1)', async () => {
    const STAGING = 'striart/staging';
    await repo.git.checkoutLocalBranch(STAGING);
    await initStriart(repo.root);
    const script = await writeGateScript(scratch);
    const gateLog = path.join(scratch, 'gate.log');
    await setConfig(repo.root, {
      testCommand: gateCommand(script, gateLog, 400),
      targetBranch: STAGING,
      mainBranch: 'main',
    });
    const a = await createAgent({ root: repo.root, name: 'agent-a' });
    const b = await createAgent({ root: repo.root, name: 'agent-b' });
    const c = await createAgent({ root: repo.root, name: 'agent-c' });
    await commitInAgent(a, 'a.js', 'export const a = 1;\n', 'feat: a');
    await commitInAgent(b, 'b.js', 'export const b = 1;\n', 'feat: b');
    await commitInAgent(c, 'c.js', 'export const c = 1;\n', 'feat: c');
    // Le staging a de l'avance sur main : le promote aura un vrai Test Gate.
    expect((await mergeAgentCommit({ root: repo.root, agent: 'agent-c' })).status).toBe('MERGED');
    await writeFile(gateLog, '');

    const { input, send, responses, done } = startLoop();
    send({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'striart_merge', arguments: { agent: 'agent-a' } },
    });
    send({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'striart_merge', arguments: { agent: 'agent-b' } },
    });
    const promote = promoteStaging({ root: repo.root });
    await waitFor(() => responses().filter((r) => r.id === 1 || r.id === 2).length === 2, 480_000);
    const promoted = await promote;
    input.end();
    await done;

    const results = responses().filter((r) => r.id === 1 || r.id === 2);
    for (const r of results) expect(r.result.structuredContent.status).toBe('MERGED');
    expect(['PROMOTED', 'UP_TO_DATE']).toContain(promoted.status);
    // Alternance stricte start/end : deux Test Gates n'ont jamais tourné en même temps.
    const events = (await readFile(gateLog, 'utf8'))
      .split('\n')
      .filter(Boolean)
      .map((l) => l.split(' ')[0]);
    expect(events.length).toBeGreaterThanOrEqual(6);
    events.forEach((kind, i) => expect(kind).toBe(i % 2 === 0 ? 'start' : 'end'));
  }, 600_000); // 4 merges + 1 promote sérialisés sous le verrou : voir vitest.config.js (budget propre > défaut)
});

describe('MCP — handlers en process (couverture réelle des outils)', () => {
  let repo;

  beforeEach(async () => {
    repo = await createTempRepo();
    await initStriart(repo.root);
    await setConfig(repo.root, { testCommand: GATE_OK });
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await repo.cleanup();
  });

  const call = (name, args = {}, caller = ORCHESTRATOR) =>
    handleMcpRequest(
      { root: repo.root, env: {}, caller },
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
    expect(queue.result.structuredContent.tasks).toEqual(rows);
  });

  it('striart_merge sans commit → UP_TO_DATE ; ticket inconnu → isError typé', async () => {
    await createAgent({ root: repo.root, name: 'agent-a' });
    const merge = await call('striart_merge', { agent: 'agent-a' });
    expect(JSON.parse(merge.result.content[0].text).status).toBe('UP_TO_DATE');

    for (const name of ['striart_resolve_apply', 'striart_resolve_prepare', 'striart_ticket']) {
      const r = await call(name, { ticketId: 'ticket-fantome' });
      expect(r.result.isError).toBe(true);
      expect(r.result.content[0].text).toContain('TICKET_UNKNOWN');
    }
  });

  it('ressources : liste (status, tickets, journaux) et journal borné au périmètre de l’agent', async () => {
    const logs = path.join(repo.root, '.striart', 'logs');
    await writeFile(path.join(logs, 'session-agent-a-1a2b3c4d.log'), 'a\n');
    await writeFile(path.join(logs, 'session-agent-b-5e6f7a8b.log'), 'secret de b\n');
    const list = async (caller) =>
      (
        await handleMcpRequest(
          { root: repo.root, env: {}, caller },
          { jsonrpc: '2.0', id: 1, method: 'resources/list' },
        )
      ).result.resources.map((r) => r.uri);
    const all = await list(ORCHESTRATOR);
    expect(all).toEqual(
      expect.arrayContaining([
        'striart://status',
        'striart://tickets',
        'striart://logs/session-agent-a-1a2b3c4d.log',
        'striart://logs/session-agent-b-5e6f7a8b.log',
      ]),
    );
    const boundA = { agent: 'agent-a', boundBy: 'cwd', readOnly: false, scope: 'agent' };
    const mine = await list(boundA);
    expect(mine).toContain('striart://logs/session-agent-a-1a2b3c4d.log');
    expect(mine).not.toContain('striart://logs/session-agent-b-5e6f7a8b.log');
    const denied = await handleMcpRequest(
      { root: repo.root, env: {}, caller: boundA },
      {
        jsonrpc: '2.0',
        id: 2,
        method: 'resources/read',
        params: { uri: 'striart://logs/session-agent-b-5e6f7a8b.log' },
      },
    );
    expect(denied.error.code).toBe(-32002);
    const traversal = await handleMcpRequest(
      { root: repo.root, env: {}, caller: ORCHESTRATOR },
      {
        jsonrpc: '2.0',
        id: 3,
        method: 'resources/read',
        params: { uri: 'striart://logs/../agents.json' },
      },
    );
    expect(traversal.error.code).toBe(-32002);
  });

  it('journaux : un agent dont le nom est préfixe d’un autre ne lit pas ses journaux', async () => {
    const logs = path.join(repo.root, '.striart', 'logs');
    await writeFile(path.join(logs, 'session-auth-1a2b3c4d.log'), 'auth\n');
    await writeFile(path.join(logs, 'session-auth-ui-5e6f7a8b.log'), 'secret de auth-ui\n');
    await writeFile(
      path.join(logs, 'session-auth-deadbeef-12345678.log'),
      'secret de auth-deadbeef\n',
    );
    const caller = { agent: 'auth', boundBy: 'cwd', readOnly: false, scope: 'agent' };
    const ctx = { root: repo.root, env: {}, caller };
    const listed = (
      await handleMcpRequest(ctx, { jsonrpc: '2.0', id: 1, method: 'resources/list' })
    ).result.resources.map((r) => r.uri);
    expect(listed).toContain('striart://logs/session-auth-1a2b3c4d.log');
    expect(listed).not.toContain('striart://logs/session-auth-ui-5e6f7a8b.log');
    expect(listed).not.toContain('striart://logs/session-auth-deadbeef-12345678.log');
    for (const name of ['session-auth-ui-5e6f7a8b.log', 'session-auth-deadbeef-12345678.log']) {
      const denied = await handleMcpRequest(ctx, {
        jsonrpc: '2.0',
        id: 2,
        method: 'resources/read',
        params: { uri: `striart://logs/${name}` },
      });
      expect(denied.error.code).toBe(-32002);
      const sub = await handleMcpRequest(ctx, {
        jsonrpc: '2.0',
        id: 3,
        method: 'resources/subscribe',
        params: { uri: `striart://logs/${name}` },
      });
      expect(sub.error).toBeDefined();
    }
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { createTempRepo } from '../helpers/temp-repo.js';
import { initStriart } from '../../src/init.js';
import { readRegistry } from '../../src/clone.js';
import { listConflictTickets } from '../../src/conflicts.js';
import { readQueue } from '../../src/queue.js';
import { acpHostStatus } from '../../src/acp/host.ts';
import { serveAcpAgent } from '../../src/acp-agent/server.ts';
import { en } from '../../src/cli/i18n/en.ts';

/**
 * Proxy ACP `striart acp` (lot I10), de bout en bout : un faux CLIENT IDE
 * (ce test) parle ACP au proxy, qui crée un clone, y lance l'agent amont
 * (faux agent ACP, hôte de session persistant d'I6) et merge sous Test Gate.
 * Vrais process, vrais dépôts : intégration.
 */
const FAKE_ACP = fileURLToPath(new URL('../helpers/fake-acp-agent.cjs', import.meta.url));
const CLI = fileURLToPath(new URL('../../src/cli.js', import.meta.url));
const GATE_OK = 'node -e "process.exit(0)"';
const GATE_KO = 'node -e "console.error(\'tests cassés\'); process.exit(1)"';

const exists = async (p) => Boolean(await stat(p).catch(() => null));

function mockRouter(files) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ ok: true, json: async () => ({ response: JSON.stringify({ files }) }) })),
  );
}

async function waitFor(fn, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > deadline) throw new Error('condition non atteinte à temps');
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/** Faux client ACP d'éditeur : ndjson sur deux flux en mémoire, réponses aux requêtes de l'agent. */
class FakeIde {
  constructor({ onPermission = null } = {}) {
    this.toAgent = new PassThrough();
    this.fromAgent = new PassThrough();
    this.updates = [];
    this.agentRequests = [];
    this.pending = new Map();
    this.nextId = 1;
    this.onPermission =
      onPermission ??
      ((params) => ({ outcome: { outcome: 'selected', optionId: params.options[0].optionId } }));
    readline.createInterface({ input: this.fromAgent }).on('line', (line) => this.onLine(line));
  }

  onLine(line) {
    const msg = JSON.parse(line);
    if (msg.id != null && msg.method === undefined) {
      const entry = this.pending.get(msg.id);
      if (!entry) return;
      this.pending.delete(msg.id);
      if (msg.error) entry.reject(Object.assign(new Error(msg.error.message), { rpc: msg.error }));
      else entry.resolve(msg.result);
      return;
    }
    if (msg.method === 'session/update') {
      this.updates.push(msg.params);
      return;
    }
    if (msg.id != null) {
      this.agentRequests.push(msg);
      const reply = (result) =>
        this.toAgent.write(`${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result })}\n`);
      if (msg.method === 'session/request_permission') reply(this.onPermission(msg.params));
      else
        this.toAgent.write(
          `${JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'no' } })}\n`,
        );
    }
  }

  request(method, params) {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      this.pending.set(id, { resolve, reject });
      this.toAgent.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }

  notify(method, params) {
    this.toAgent.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
  }

  texts(sessionId) {
    return this.updates
      .filter((u) => u.sessionId === sessionId && u.update.sessionUpdate === 'agent_message_chunk')
      .map((u) => u.update.content?.text ?? '')
      .join('');
  }

  async open(cwd, extra = {}) {
    const init = await this.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: true },
      clientInfo: { name: 'fake-ide', version: '1.0.0' },
    });
    const session = await this.request('session/new', { cwd, mcpServers: [], ...extra });
    return { init, session };
  }
}

describe('proxy ACP striart acp (lot I10)', () => {
  let repo;
  let ide;
  let served;

  async function setConfig(config) {
    await writeFile(
      path.join(repo.root, '.striartrc.json'),
      JSON.stringify({
        agentProfiles: {
          'fake-acp': { command: process.execPath, args: [FAKE_ACP], acp: true },
          'fake-acp-2': { command: process.execPath, args: [FAKE_ACP], acp: true },
        },
        testCommand: GATE_OK,
        ...config,
        acpAgent: {
          profiles: ['fake-acp', 'fake-acp-2'],
          defaultProfile: 'fake-acp-2',
          ...(config.acpAgent ?? {}),
        },
      }),
    );
  }

  const prompt = (sessionId, text) =>
    ide.request('session/prompt', { sessionId, prompt: [{ type: 'text', text }] });

  beforeEach(async () => {
    repo = await createTempRepo();
    await initStriart(repo.root);
    mockRouter(['feature.js']);
    ide = new FakeIde();
    served = serveAcpAgent({
      input: ide.toAgent,
      output: ide.fromAgent,
      rootOption: null,
      profileOption: null,
      m: en,
      version: '0.0.0-test',
    });
  });

  afterEach(async () => {
    ide.toAgent.end();
    await served.catch(() => {});
    vi.unstubAllGlobals();
    delete process.env.FAKE_ACP_MODE;
    delete process.env.FAKE_ACP_DELAY_MS;
    await repo.cleanup();
  });

  it('session IDE complète : profil choisi, deux prompts, updates relayés, permission arbitrée dans l’IDE, fermeture → mergé sous Test Gate', async () => {
    await setConfig({});
    process.env.FAKE_ACP_MODE = 'permission-commit';

    const { init, session } = await ide.open(repo.root, {
      mcpServers: [{ name: 'ide-fs', command: 'ide-mcp', args: [], env: [] }],
    });
    expect(init.protocolVersion).toBe(1);
    expect(init.agentCapabilities.sessionCapabilities.close).toEqual({});
    expect(init.authMethods.map((m) => m.id)).toEqual(['striart-local']);
    const sid = session.sessionId;
    const profileOption = session.configOptions.find((o) => o.id === 'profile');
    expect(profileOption.currentValue).toBe('fake-acp-2');
    expect(profileOption.options.map((o) => o.value)).toEqual(['fake-acp', 'fake-acp-2']);
    expect(session.configOptions.find((o) => o.id === 'permissions').currentValue).toBe('ask');

    const changed = await ide.request('session/set_config_option', {
      sessionId: sid,
      configId: 'profile',
      value: 'fake-acp',
    });
    expect(changed.configOptions.find((o) => o.id === 'profile').currentValue).toBe('fake-acp');

    const first = await prompt(sid, 'ajoute une feature');
    expect(first.stopReason).toBe('end_turn');
    const agent = Object.keys(await readRegistry(repo.root))[0];
    expect(agent).toBeTruthy();
    // SESSION_LIVE : le PID publié est celui de l'hôte persistant, vivant entre les prompts.
    const meta = (await readRegistry(repo.root))[agent];
    const host = await acpHostStatus(repo.root, agent, { fresh: true });
    expect(host.running).toBe(true);
    expect(meta.sessionPid).toBe(host.pid);
    expect(meta.mode).toBe('autonomous');

    // Profil figé une fois la session démarrée.
    await expect(
      ide.request('session/set_config_option', {
        sessionId: sid,
        configId: 'profile',
        value: 'fake-acp-2',
      }),
    ).rejects.toMatchObject({ rpc: { data: { code: 'ACP_PROXY_OPTION_LOCKED' } } });

    const second = await prompt(sid, 'deuxième consigne');
    expect(second.stopReason).toBe('end_turn');

    // Updates de l'agent amont relayés, étiquetés, sessionId réécrit.
    const upstream = ide.updates.filter((u) => u.update._meta?.striart?.origin === 'upstream');
    expect(upstream.length).toBeGreaterThan(0);
    expect(upstream.every((u) => u.sessionId === sid)).toBe(true);
    expect(ide.texts(sid)).toContain('travail sur');
    expect(ide.texts(sid)).toContain('deuxième consigne');
    expect(ide.texts(sid)).toContain('not passed to the upstream agent');
    // Commandes Striart annoncées.
    const commands = ide.updates.find(
      (u) => u.update.sessionUpdate === 'available_commands_update',
    );
    expect(commands.update.availableCommands.map((c) => c.name)).toContain('striart-finish');

    // Permissions arbitrées DANS l'IDE (politique ask), rattachées à l'appel d'outil de l'agent.
    const permissions = ide.agentRequests.filter((r) => r.method === 'session/request_permission');
    expect(permissions).toHaveLength(2);
    expect(permissions[0].params.toolCall.toolCallId).toBe('tc-1');
    expect(permissions[0].params.sessionId).toBe(sid);
    // Jamais une capacité fs/terminal de l'IDE.
    expect(ide.agentRequests.every((r) => r.method === 'session/request_permission')).toBe(true);

    await ide.request('session/close', { sessionId: sid });
    const merged = await readFile(path.join(repo.root, 'feature.js'), 'utf8');
    expect(merged).toContain('deuxième consigne');
    expect(await readRegistry(repo.root)).toEqual({});
    expect(ide.texts(sid)).toContain('Test Gate green');
    expect((await acpHostStatus(repo.root, agent, { fresh: true })).running).toBe(false);
  });

  it('fs/terminal vers le principal : jamais servis — ni par l’IDE, ni par Striart hors du clone', async () => {
    await setConfig({});
    process.env.FAKE_ACP_MODE = 'fs-escape';
    const { session } = await ide.open(repo.root);
    // fs-escape : end_turn seulement si l'écriture hors clone a été REFUSÉE.
    expect((await prompt(session.sessionId, 'évasion fs')).stopReason).toBe('end_turn');
    expect(await exists(path.join(repo.root, '.striart', 'evasion.txt'))).toBe(false);
    await ide.request('session/close', { sessionId: session.sessionId });

    // Le premier clone (vide) est conservé : même prédiction → collision du
    // Router, refus explicite (collisionPolicy 'fail'), aucun clone ni tâche en file.
    const { session: blocked } = await ide.open(repo.root);
    await expect(prompt(blocked.sessionId, 'évasion fs bis')).rejects.toMatchObject({
      rpc: { data: { code: 'ACP_PROXY_COLLISION' } },
    });
    expect(Object.keys(await readRegistry(repo.root))).toHaveLength(1);
    expect(await readQueue(repo.root)).toEqual([]);
    // Une prédiction disjointe passe.
    mockRouter(['other.js']);
    process.env.FAKE_ACP_MODE = 'terminal-escape';
    const { session: s2 } = await ide.open(repo.root);
    expect((await prompt(s2.sessionId, 'évasion terminal')).stopReason).toBe('end_turn');
    await ide.request('session/close', { sessionId: s2.sessionId });

    // Aucune requête fs/* ni terminal/* n'a jamais atteint l'IDE.
    expect(ide.agentRequests.filter((r) => /^(fs|terminal)\//.test(r.method))).toEqual([]);
    // Et le proxy ne sert pas ces méthodes s'il les reçoit.
    await expect(
      ide.request('fs/read_text_file', {
        sessionId: s2.sessionId,
        path: path.join(repo.root, 'README.md'),
      }),
    ).rejects.toMatchObject({ rpc: { code: -32601 } });
  });

  it('session/cancel : tour annulé, session vivante ; fermeture → clone conservé, dépôt jamais en état merging', async () => {
    await setConfig({});
    process.env.FAKE_ACP_MODE = 'hang';
    const { session } = await ide.open(repo.root);
    const sid = session.sessionId;
    const pending = prompt(sid, 'tâche interminable');
    const agent = await waitFor(async () => {
      const [name] = Object.keys(await readRegistry(repo.root));
      if (!name) return null;
      return (await acpHostStatus(repo.root, name, { fresh: true })).listening ? name : null;
    });
    // Le handshake amont peut être encore en cours : l'annulation ne se perd pas.
    ide.notify('session/cancel', { sessionId: sid });
    expect((await pending).stopReason).toBe('cancelled');
    expect(ide.texts(sid)).toContain('turn cancelled');
    expect((await acpHostStatus(repo.root, agent, { fresh: true })).running).toBe(true);

    await ide.request('session/close', { sessionId: sid });
    expect(await exists(path.join(repo.root, '.git', 'MERGE_HEAD'))).toBe(false);
    const registry = await readRegistry(repo.root);
    expect(registry[agent]).toBeDefined();
    expect(registry[agent].sessionPid ?? null).toBeNull();
    expect(await exists(registry[agent].path)).toBe(true);
    expect(ide.texts(sid)).toMatch(/CANCELLED/);
    expect((await acpHostStatus(repo.root, agent, { fresh: true })).running).toBe(false);
  });

  it('Test Gate rouge → clone conservé et signalé à l’IDE (/striart-finish), session close ensuite', async () => {
    await setConfig({ testCommand: GATE_KO });
    process.env.FAKE_ACP_MODE = 'commit';
    const { session } = await ide.open(repo.root);
    const sid = session.sessionId;
    expect((await prompt(sid, 'ajoute une feature')).stopReason).toBe('end_turn');
    const [agent] = Object.keys(await readRegistry(repo.root));

    expect((await prompt(sid, '/striart-finish')).stopReason).toBe('end_turn');
    expect(ide.texts(sid)).toContain('merge blocked');
    expect(ide.texts(sid)).toContain('Clone kept');
    const registry = await readRegistry(repo.root);
    expect(registry[agent]).toBeDefined();
    expect(await exists(registry[agent].path)).toBe(true);
    expect(await exists(path.join(repo.root, 'feature.js'))).toBe(false);
    expect(await exists(path.join(repo.root, '.git', 'MERGE_HEAD'))).toBe(false);
    expect((await listConflictTickets(repo.root)).length).toBeGreaterThan(0);

    await expect(prompt(sid, 'encore')).rejects.toMatchObject({
      rpc: { data: { code: 'ACP_PROXY_SESSION_ENDED' } },
    });
  });

  it('merge manuel (option de session) : fermeture → clone conservé sans merge, MERGE_DEFERRED', async () => {
    await setConfig({});
    process.env.FAKE_ACP_MODE = 'commit';
    const { session } = await ide.open(repo.root);
    const sid = session.sessionId;
    await ide.request('session/set_config_option', {
      sessionId: sid,
      configId: 'merge',
      value: 'manual',
    });
    expect((await prompt(sid, 'ajoute une feature')).stopReason).toBe('end_turn');
    const [agent] = Object.keys(await readRegistry(repo.root));
    await ide.request('session/close', { sessionId: sid });
    expect(await exists(path.join(repo.root, 'feature.js'))).toBe(false);
    expect((await readRegistry(repo.root))[agent]).toBeDefined();
    expect(ide.texts(sid)).toContain(`striart merge ${agent}`);
  });

  it('IDE déconnecté sans fin de session (onDisconnect: keep) → session amont close, clone conservé, rien mergé', async () => {
    await setConfig({});
    process.env.FAKE_ACP_MODE = 'commit';
    const { session } = await ide.open(repo.root);
    expect((await prompt(session.sessionId, 'ajoute une feature')).stopReason).toBe('end_turn');
    const [agent] = Object.keys(await readRegistry(repo.root));
    ide.toAgent.end();
    await served;
    expect(await exists(path.join(repo.root, 'feature.js'))).toBe(false);
    const meta = (await readRegistry(repo.root))[agent];
    expect(meta).toBeDefined();
    expect(meta.sessionPid ?? null).toBeNull();
    expect((await acpHostStatus(repo.root, agent, { fresh: true })).running).toBe(false);
  });
});

describe('striart acp (CLI)', () => {
  let repo;

  beforeEach(async () => {
    repo = await createTempRepo();
    await initStriart(repo.root);
    await writeFile(
      path.join(repo.root, '.striartrc.json'),
      JSON.stringify({
        agentProfiles: { 'fake-acp': { command: process.execPath, args: [FAKE_ACP], acp: true } },
        acpAgent: { profiles: ['fake-acp'] },
      }),
    );
  });

  afterEach(async () => {
    await repo.cleanup();
  });

  const run = (env = {}) =>
    new Promise((resolve) => {
      const child = spawn(process.execPath, [CLI, 'acp'], {
        cwd: repo.root,
        env: { ...process.env, STRIART_LANG: 'en', ...env },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let stdout = '';
      child.stdout.on('data', (c) => (stdout += c));
      child.on('close', (code) => resolve({ code, stdout }));
      child.stdin.write(
        `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: 1, clientCapabilities: {} } })}\n`,
      );
      child.stdin.write(
        `${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'session/new', params: { cwd: repo.root, mcpServers: [] } })}\n`,
      );
      setTimeout(() => child.stdin.end(), 1_500);
    });

  it('stdout ne porte que le protocole : initialize, session/new avec options de session, sortie 0 à la fermeture de stdin', async () => {
    const { code, stdout } = await run();
    expect(code).toBe(0);
    const lines = stdout
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    const init = lines.find((l) => l.id === 1);
    expect(init.result.agentInfo.name).toBe('striart');
    const created = lines.find((l) => l.id === 2);
    expect(created.result.configOptions.find((o) => o.id === 'profile').currentValue).toBe(
      'fake-acp',
    );
    expect(lines.every((l) => l.jsonrpc === '2.0')).toBe(true);
  });

  it('refusé dans une session d’agent Striart (plan humain), sans un octet sur stdout', async () => {
    const { code, stdout } = await run({ STRIART_SESSION: '1' });
    expect(code).toBe(3);
    expect(stdout).toBe('');
  });
});

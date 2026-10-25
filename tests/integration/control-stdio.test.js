import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { execa } from 'execa';
import { createTempRepo } from '../helpers/temp-repo.js';
import { initStriart } from '../../src/init.js';
import { createAgent } from '../../src/clone.js';
import { createConflictTicket, listConflictTickets } from '../../src/conflicts.js';
import { SCHEMA_ROOT, methodSpec, resultSchema } from '../../src/control/schema.ts';
import { createValidator } from '../../src/control/validate.ts';
import { encodeFrame } from '../../src/control/framing.ts';

const CLI = fileURLToPath(new URL('../../src/cli.js', import.meta.url));
const validate = createValidator(SCHEMA_ROOT);
const ref = (name) => ({ $ref: `#/components/schemas/${name}` });

/** Client stdio minimal : NDJSON ou Content-Length, réponses par id, notifications à part. */
function startApi(cwd, { framing = 'ndjson', env = {} } = {}) {
  const args = [CLI, 'api', '--stdio', ...(framing === 'ndjson' ? [] : ['--framing', framing])];
  const child = spawn(process.execPath, args, {
    cwd,
    env: { ...process.env, STRIART_LANG: 'en', ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let buffer = Buffer.alloc(0);
  const messages = [];
  const waiters = [];
  let stderr = '';
  child.stderr.on('data', (d) => (stderr += d));
  const push = (message) => {
    messages.push(message);
    for (const waiter of [...waiters]) {
      if (waiter.match(message)) {
        waiters.splice(waiters.indexOf(waiter), 1);
        waiter.resolve(message);
      }
    }
  };
  child.stdout.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    for (;;) {
      if (framing === 'ndjson') {
        const nl = buffer.indexOf(10);
        if (nl === -1) return;
        const line = buffer.subarray(0, nl).toString('utf8');
        buffer = buffer.subarray(nl + 1);
        if (line.trim()) push(JSON.parse(line));
      } else {
        const end = buffer.indexOf('\r\n\r\n');
        if (end === -1) return;
        const length = Number(/Content-Length: (\d+)/.exec(buffer.subarray(0, end).toString())[1]);
        if (buffer.length < end + 4 + length) return;
        push(JSON.parse(buffer.subarray(end + 4, end + 4 + length).toString('utf8')));
        buffer = buffer.subarray(end + 4 + length);
      }
    }
  });
  const wait = (match, timeoutMs = 30_000) => {
    const found = messages.find(match);
    if (found) return Promise.resolve(found);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`no matching message; stderr: ${stderr}`)),
        timeoutMs,
      );
      waiters.push({
        match,
        resolve: (m) => {
          clearTimeout(timer);
          resolve(m);
        },
      });
    });
  };
  let nextId = 1;
  return {
    child,
    messages,
    get stderr() {
      return stderr;
    },
    send(message) {
      child.stdin.write(encodeFrame(framing, message));
    },
    async call(method, params) {
      const id = nextId++;
      child.stdin.write(
        encodeFrame(framing, { jsonrpc: '2.0', id, method, ...(params ? { params } : {}) }),
      );
      return wait((m) => m.id === id);
    },
    wait,
    async close() {
      child.stdin.end();
      const code = await new Promise((resolve) => child.once('exit', resolve));
      return code;
    },
  };
}

describe('striart api --stdio (intégration)', () => {
  let repo;
  let api;

  beforeEach(async () => {
    repo = await createTempRepo();
    await initStriart(repo.root);
    await createConflictTicket(repo.root, {
      agent: 'agent-a',
      branch: 'striart/agent-a/task-x',
      sha: 'b'.repeat(40),
      reason: 'MERGE_CONFLICT',
      conflictedFiles: ['src/a.ts'],
      resolutions: [{ path: 'src/a.ts', base: 'b', ours: 'o', theirs: 't', llmAttempt: null }],
    });
  });

  afterEach(async () => {
    if (api && api.child.exitCode === null) api.child.kill();
    api = null;
    await repo.cleanup();
  });

  it('handshake, état, ticket 3-way : documents conformes aux schémas publiés ; stdout = protocole seul', async () => {
    api = startApi(repo.root);
    const init = await api.call('control.initialize', {
      protocolVersion: 1,
      client: { name: 'test' },
    });
    expect(validate(resultSchema(methodSpec('control.initialize')), init.result)).toBeNull();
    expect(init.result.data).toMatchObject({
      transport: 'stdio',
      protocolVersion: 1,
      schemaVersion: 1,
    });

    const state = await api.call('state.get');
    expect(validate(resultSchema(methodSpec('state.get')), state.result)).toBeNull();

    const [ticket] = await listConflictTickets(repo.root);
    const detail = await api.call('ticket.get', { id: ticket.id });
    expect(validate(resultSchema(methodSpec('ticket.get')), detail.result)).toBeNull();
    expect(detail.result.data.resolutions[0]).toMatchObject({ base: 'b', ours: 'o', theirs: 't' });

    const discover = await api.call('rpc.discover');
    expect(discover.result.data.openrpc).toBe('1.3.2');
    expect(discover.result.data.methods.map((m) => m.name)).toContain('permission.answer');

    expect(await api.close()).toBe(0);
    // Chaque message de stdout est un message JSON-RPC 2.0 : rien d'autre n'y passe.
    for (const message of api.messages) expect(message.jsonrpc).toBe('2.0');
  });

  it('abonnement : état initial dans la réponse, puis state.changed (seq croissante) sur changement disque', async () => {
    api = startApi(repo.root);
    const sub = await api.call('state.subscribe');
    expect(sub.result.data.seq).toBe(1);
    const id = sub.result.data.subscriptionId;
    await createAgent({ root: repo.root, name: 'agent-stdio' });
    const changed = await api.wait(
      (m) =>
        m.method === 'state.changed' && m.params.state.agents.some((a) => a.name === 'agent-stdio'),
    );
    expect(changed.params.subscriptionId).toBe(id);
    expect(changed.params.seq).toBeGreaterThan(1);
    expect(validate(ref('StateChangedParams'), changed.params)).toBeNull();
    // Aucune notification n'a précédé la réponse de state.subscribe.
    const order = api.messages.map((m) => m.id ?? m.method);
    expect(order.indexOf(sub.id)).toBeLessThan(order.indexOf('state.changed'));
    expect(await api.close()).toBe(0);
  });

  it('cadrage Content-Length (vscode-jsonrpc, lsp4j) : même protocole', async () => {
    api = startApi(repo.root, { framing: 'content-length' });
    const init = await api.call('control.initialize', { protocolVersion: 1 });
    expect(init.result.ok).toBe(true);
    const err = await api.call('agent.merge', { agent: 'inconnu' });
    expect(err.error.data.error).toMatchObject({ code: 'AGENT_UNKNOWN', kind: 'failure' });
    expect(validate(ref('ErrorDocument'), err.error.data)).toBeNull();
    expect(await api.close()).toBe(0);
  });

  it('JSON illisible ou trop gros : erreur typée, la connexion continue', async () => {
    api = startApi(repo.root);
    api.child.stdin.write('{oops\n');
    const parse = await api.wait((m) => m.error?.code === -32700);
    expect(parse.error.data.error.code).toBe('CONTROL_PARSE_ERROR');
    api.child.stdin.write(`${'x'.repeat(1024 * 1024 + 10)}\n`);
    const big = await api.wait((m) => m.error?.data?.error?.code === 'CONTROL_MESSAGE_TOO_LARGE');
    expect(big.id).toBeNull();
    const ok = await api.call('state.get');
    expect(ok.result.ok).toBe(true);
    expect(await api.close()).toBe(0);
  });

  it('refusé dans une session d’agent (STRIART_SESSION=1) : plan humain, rien sur stdout, sortie 3', async () => {
    const result = await execa(process.execPath, [CLI, 'api', '--stdio'], {
      cwd: repo.root,
      env: { ...process.env, STRIART_SESSION: '1', STRIART_LANG: 'en' },
      input: '',
      reject: false,
    });
    expect(result.exitCode).toBe(3);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('CONTROL_NESTED_SESSION');
  });

  it('--schema imprime les documents publiés ; sans transport → erreur d’usage', async () => {
    const openrpc = await execa(process.execPath, [CLI, 'api', '--schema'], { cwd: repo.root });
    expect(JSON.parse(openrpc.stdout).openrpc).toBe('1.3.2');
    const bundle = await execa(process.execPath, [CLI, 'api', '--schema', 'json-schema'], {
      cwd: repo.root,
    });
    expect(JSON.parse(bundle.stdout).$ref).toBe('#/$defs/Document');
    const none = await execa(process.execPath, [CLI, 'api'], { cwd: repo.root, reject: false });
    expect(none.exitCode).toBe(2);
    const bad = await execa(process.execPath, [CLI, 'api', '--stdio', '--framing', 'xml'], {
      cwd: repo.root,
      reject: false,
    });
    expect(bad.exitCode).toBe(2);
  });
});

describe('contrat commun CLI --json ↔ protocole (intégration)', () => {
  let repo;

  beforeEach(async () => {
    repo = await createTempRepo();
    await initStriart(repo.root);
    await createAgent({ root: repo.root, name: 'agent-a' });
  });

  afterEach(async () => {
    await repo.cleanup();
  });

  it('striart status --json : document et données valident les MÊMES définitions que state.get', async () => {
    const { stdout } = await execa(process.execPath, [CLI, 'status', '--json'], { cwd: repo.root });
    const doc = JSON.parse(stdout);
    expect(validate(ref('Document'), doc)).toBeNull();
    expect(validate(ref('StatusData'), doc.data)).toBeNull();
  });

  it('une erreur CLI --json et la même erreur du protocole portent le même objet error', async () => {
    const cli = await execa(process.execPath, [CLI, 'merge', 'fantome', '--json'], {
      cwd: repo.root,
      env: { ...process.env, STRIART_LANG: 'en' },
      reject: false,
    });
    const cliDoc = JSON.parse(cli.stdout);
    expect(validate(ref('ErrorDocument'), cliDoc)).toBeNull();

    const api = startApi(repo.root);
    try {
      const response = await api.call('agent.merge', { agent: 'fantome' });
      const protocolDoc = response.error.data;
      expect(validate(ref('ErrorDocument'), protocolDoc)).toBeNull();
      expect(protocolDoc.error).toEqual(cliDoc.error);
      expect(protocolDoc.schemaVersion).toBe(cliDoc.schemaVersion);
    } finally {
      await api.close();
    }
  });
});

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ControlClient, type StatusInfo } from '../../src/core/client.ts';
import { BinaryError, ConnectionLostError, RequestTimeoutError, RpcError } from '../../src/core/errors.ts';
import type { Transport, TransportClose } from '../../src/core/transport.ts';
import type { ControlState } from '../../src/core/types.ts';
import { FakeServer, ManualTimers, ServerError, doc, flush, makeState } from './fake-server.ts';

function setup(options: { servers?: Array<FakeServer | Error>; maxAttempts?: number } = {}) {
  const timers = new ManualTimers();
  const servers = options.servers ?? [new FakeServer()];
  let index = 0;
  const logs: string[] = [];
  const client = new ControlClient({
    clientName: 'test',
    clientVersion: '0.0.0',
    requestTimeoutMs: 1000,
    actionTimeoutMs: 60_000,
    reconnect: { initialMs: 1000, maxMs: 8000, maxAttempts: options.maxAttempts ?? 3 },
    random: () => 0,
    timers,
    connect: () => {
      const next = servers[Math.min(index, servers.length - 1)];
      index += 1;
      if (next instanceof Error) throw next;
      return next as Transport;
    },
  });
  const statuses: StatusInfo[] = [];
  const states: ControlState[] = [];
  client.on('status', (s) => statuses.push(s));
  client.on('state', (s) => states.push(s));
  client.on('log', (_level, message) => logs.push(message));
  return { client, timers, servers, statuses, states, logs, attempts: () => index };
}

const last = <T>(xs: T[]): T => xs[xs.length - 1]!;

describe('ControlClient: négociation', () => {
  it('initialise, s’abonne, expose le premier état', async () => {
    const { client, statuses, states, servers } = setup();
    client.start();
    await flush();
    assert.equal(last(statuses).status, 'connected');
    assert.equal(last(statuses).serverVersion, '9.9.9');
    assert.equal(states.length, 1);
    const server = servers[0] as FakeServer;
    assert.deepEqual(
      server.received.map((m) => m.method),
      ['control.initialize', 'state.subscribe'],
    );
    assert.deepEqual((server.received[0]!.params as Record<string, unknown>).protocolVersion, 1);
  });

  it('refuse un serveur sans state.subscribe (incompatible, pas de reprise)', async () => {
    const server = new FakeServer();
    server.handlers.set('control.initialize', () =>
      doc('control.initialize', {
        protocolVersion: 1,
        schemaVersion: 1,
        server: { name: 'striart', version: '1' },
        transport: 'stdio',
        locale: 'en',
        methods: ['control.initialize'],
        notifications: ['state.changed'],
      }),
    );
    const { client, statuses, timers } = setup({ servers: [server] });
    client.start();
    await flush();
    assert.equal(last(statuses).status, 'blocked');
    assert.equal(last(statuses).code, 'PROTOCOL_INCOMPATIBLE');
    assert.deepEqual(timers.pendingDelays(), []);
  });

  it('refuse une version de protocole inattendue', async () => {
    const server = new FakeServer();
    server.handlers.set('control.initialize', () => doc('control.initialize', { protocolVersion: 2 }));
    const { client, statuses } = setup({ servers: [server] });
    client.start();
    await flush();
    assert.equal(last(statuses).status, 'blocked');
  });

  it('binaire introuvable : état explicite, aucune reprise automatique', async () => {
    const { client, statuses, timers } = setup({ servers: [new BinaryError('BINARY_NOT_FOUND', 'nope')] });
    client.start();
    await flush();
    assert.equal(last(statuses).status, 'binary-missing');
    assert.equal(last(statuses).code, 'BINARY_NOT_FOUND');
    assert.deepEqual(timers.pendingDelays(), []);
  });
});

describe('ControlClient: état et notifications', () => {
  it('applique state.changed et ignore une révision périmée', async () => {
    const { client, states, servers } = setup();
    client.start();
    await flush();
    const server = servers[0] as FakeServer;
    server.notify('state.changed', { subscriptionId: 'sub-1', seq: 2, state: makeState(3), droppedNotices: 0 });
    server.notify('state.changed', { subscriptionId: 'sub-1', seq: 3, state: makeState(2), droppedNotices: 0 });
    assert.deepEqual(
      states.map((s) => s.revision),
      [1, 3],
    );
    assert.equal(client.state?.revision, 3);
  });

  it('accepte une nouvelle instance même avec une révision plus basse', async () => {
    const { client, states, servers } = setup();
    client.start();
    await flush();
    const server = servers[0] as FakeServer;
    server.notify('state.changed', { subscriptionId: 'sub-1', seq: 2, state: makeState(5), droppedNotices: 0 });
    server.notify('state.changed', {
      subscriptionId: 'sub-1',
      seq: 3,
      state: makeState(1, { instanceId: 'inst-2' }),
      droppedNotices: 0,
    });
    assert.equal(last(states).instanceId, 'inst-2');
  });

  it('ignore une notification d’un autre abonnement', async () => {
    const { client, states, servers } = setup();
    client.start();
    await flush();
    (servers[0] as FakeServer).notify('state.changed', {
      subscriptionId: 'autre',
      seq: 2,
      state: makeState(9),
      droppedNotices: 0,
    });
    assert.equal(states.length, 1);
  });

  it('rejette (sans planter) une notification mal formée', async () => {
    const { client, servers, states } = setup();
    client.start();
    await flush();
    const server = servers[0] as FakeServer;
    server.notify('state.changed', { subscriptionId: 'sub-1', seq: 2, state: { agents: 'oups' }, droppedNotices: 0 });
    server.sendRaw('ceci n’est pas du JSON\n');
    server.send({ jsonrpc: '1.0', id: 1 });
    assert.equal(client.invalidMessages, 3);
    assert.equal(states.length, 1);
    assert.equal(client.status.status, 'connected');
  });

  it('relaie control.notice', async () => {
    const { client, servers } = setup();
    const notices: string[] = [];
    client.on('notice', (n) => notices.push(n.message));
    client.start();
    await flush();
    (servers[0] as FakeServer).notify('control.notice', { seq: 1, type: 'autonomous:merged', message: 'fait' });
    assert.deepEqual(notices, ['fait']);
  });

  it('écarte un message trop gros et continue', async () => {
    const { client, servers, states, logs } = setup();
    client.start();
    await flush();
    const server = servers[0] as FakeServer;
    server.sendRaw(Buffer.alloc(1024 * 1024 + 10, 0x61));
    server.sendRaw('\n');
    server.notify('state.changed', { subscriptionId: 'sub-1', seq: 2, state: makeState(2), droppedNotices: 0 });
    assert.equal(client.invalidMessages, 1);
    assert.ok(logs.some((l) => l.includes('oversized')));
    assert.equal(last(states).revision, 2);
  });

  it('gère un message découpé en plusieurs morceaux et plusieurs messages par morceau', async () => {
    const { client, servers, states } = setup();
    client.start();
    await flush();
    const server = servers[0] as FakeServer;
    const a = JSON.stringify({
      jsonrpc: '2.0',
      method: 'state.changed',
      params: { subscriptionId: 'sub-1', seq: 2, state: makeState(2), droppedNotices: 0 },
    });
    const b = JSON.stringify({
      jsonrpc: '2.0',
      method: 'state.changed',
      params: { subscriptionId: 'sub-1', seq: 3, state: makeState(3), droppedNotices: 0 },
    });
    const all = Buffer.from(`${a}\n${b}\n`);
    server.sendRaw(all.subarray(0, 40));
    server.sendRaw(all.subarray(40, a.length + 10));
    server.sendRaw(all.subarray(a.length + 10));
    assert.deepEqual(
      states.map((s) => s.revision),
      [1, 2, 3],
    );
  });
});

describe('ControlClient: appels', () => {
  it('rend le document désenveloppé', async () => {
    const { client, servers } = setup();
    (servers[0] as FakeServer).handlers.set('agent.merge', (params) =>
      doc('agent.merge', { status: 'MERGED', agent: params.agent }),
    );
    client.start();
    await flush();
    const result = await client.call('agent.merge', { agent: 'a1' }, 'action');
    assert.equal(result.outcome, 'ok');
    assert.deepEqual(result.data, { status: 'MERGED', agent: 'a1' });
  });

  it('transforme une erreur serveur en RpcError (code stable, hint)', async () => {
    const { client, servers } = setup();
    (servers[0] as FakeServer).handlers.set('agent.merge', () => new ServerError('AGENT_HAS_PENDING'));
    client.start();
    await flush();
    await assert.rejects(client.call('agent.merge', { agent: 'a1' }), (e: unknown) => {
      assert.ok(e instanceof RpcError);
      assert.equal(e.code, 'AGENT_HAS_PENDING');
      assert.equal(e.hint, 'striart status');
      return true;
    });
  });

  it('délai de requête : RequestTimeoutError, connexion conservée, réponse tardive ignorée', async () => {
    const { client, servers, timers, logs } = setup();
    const server = servers[0] as FakeServer;
    server.handlers.set('doctor.run', () => undefined);
    client.start();
    await flush();
    const pending = client.call('doctor.run');
    timers.advance(1001);
    await assert.rejects(pending, RequestTimeoutError);
    assert.equal(client.status.status, 'connected');
    const id = server.received.find((m) => m.method === 'doctor.run')!.id;
    server.send({ jsonrpc: '2.0', id, result: doc('doctor.run', {}) });
    assert.ok(logs.some((l) => l.includes('already timed out')));
    assert.equal(client.invalidMessages, 0);
  });

  it('une action utilise le délai long', async () => {
    const { client, servers, timers } = setup();
    const server = servers[0] as FakeServer;
    server.handlers.set('agent.merge', () => undefined);
    client.start();
    await flush();
    const pending = client.call('agent.merge', { agent: 'a' }, 'action');
    timers.advance(30_000);
    let settled = false;
    pending.then(
      () => (settled = true),
      () => (settled = true),
    );
    await flush();
    assert.equal(settled, false);
    timers.advance(30_001);
    await assert.rejects(pending, RequestTimeoutError);
  });

  it('refuse un résultat dont la commande ne correspond pas', async () => {
    const { client, servers } = setup();
    (servers[0] as FakeServer).handlers.set('agent.sync', () => doc('autre.chose', {}));
    client.start();
    await flush();
    await assert.rejects(client.call('agent.sync'), /result\.command/);
  });

  it('appel hors connexion : ConnectionLostError', async () => {
    const { client } = setup();
    await assert.rejects(client.call('state.get'), ConnectionLostError);
  });

  it('coupure pendant un appel : l’appel est rejeté', async () => {
    const { client, servers } = setup({ servers: [new FakeServer(), new FakeServer()] });
    const server = servers[0] as FakeServer;
    server.handlers.set('agent.merge', () => undefined);
    client.start();
    await flush();
    const pending = client.call('agent.merge', { agent: 'a' }, 'action');
    server.end({ code: 1, signal: null, stderr: '', error: null });
    await assert.rejects(pending, ConnectionLostError);
  });

  it('réponse sans requête correspondante : comptée invalide', async () => {
    const { client, servers } = setup();
    client.start();
    await flush();
    (servers[0] as FakeServer).send({ jsonrpc: '2.0', id: 999, result: doc('x', {}) });
    assert.equal(client.invalidMessages, 1);
  });
});

describe('ControlClient: reprise', () => {
  const close = (server: FakeServer, over: Partial<TransportClose> = {}) =>
    server.end({ code: 1, signal: null, stderr: '', error: null, ...over });

  it('reprend avec backoff exponentiel puis se reconnecte et remet le compteur à zéro', async () => {
    const { client, servers, statuses, timers, attempts } = setup({ servers: [new FakeServer(), new FakeServer()] });
    client.start();
    await flush();
    close(servers[0] as FakeServer);
    assert.equal(last(statuses).status, 'offline');
    assert.equal(last(statuses).attempt, 1);
    // random() = 0 → moitié du délai exponentiel : 500 ms.
    assert.deepEqual(timers.pendingDelays(), [500]);
    timers.advance(500);
    await flush();
    assert.equal(attempts(), 2);
    assert.equal(last(statuses).status, 'connected');
    assert.equal(last(statuses).attempt, 0);
  });

  it('abandonne après maxAttempts puis repart sur reconnect() manuel', async () => {
    const failing = () => {
      const s = new FakeServer();
      s.handlers.set('control.initialize', () => undefined);
      return s;
    };
    const s1 = new FakeServer();
    const { client, servers, timers, statuses, attempts } = setup({
      servers: [s1, failing(), failing(), new FakeServer()],
      maxAttempts: 2,
    });
    client.start();
    await flush();
    close(s1);
    timers.advance(500);
    await flush();
    // Négociation muette : délai de requête (1000 ms) → échec → reprise n°2.
    timers.advance(1000);
    await flush();
    timers.advance(2000);
    await flush();
    timers.advance(1000);
    await flush();
    assert.equal(last(statuses).status, 'offline');
    assert.equal(last(statuses).code, 'RECONNECT_EXHAUSTED');
    assert.deepEqual(timers.pendingDelays(), []);
    assert.equal(attempts(), 3);
    void servers;
    client.reconnect();
    await flush();
    assert.equal(last(statuses).status, 'connected');
  });

  it('NOT_INITIALIZED sur stderr : terminal, aucune reprise', async () => {
    const dying = new FakeServer();
    dying.handlers.set('control.initialize', () => undefined);
    const { client, statuses, timers } = setup({ servers: [dying] });
    client.start();
    await flush();
    close(dying, { stderr: '✗ error: .striart/ not found in /x. (NOT_INITIALIZED)\n  → striart init\n' });
    assert.equal(last(statuses).status, 'not-initialized');
    assert.deepEqual(
      timers.pendingDelays().filter((d) => d !== 1000),
      [],
    );
  });

  it('CONTROL_NESTED_SESSION : bloqué, aucune reprise', async () => {
    const dying = new FakeServer();
    dying.handlers.set('control.initialize', () => undefined);
    const { client, statuses } = setup({ servers: [dying] });
    client.start();
    await flush();
    close(dying, { stderr: 'error: refused in an agent session (CONTROL_NESTED_SESSION)' });
    assert.equal(last(statuses).status, 'blocked');
    assert.equal(last(statuses).code, 'CONTROL_NESTED_SESSION');
  });

  it('ENOENT au lancement : binary-missing', async () => {
    const dying = new FakeServer();
    dying.handlers.set('control.initialize', () => undefined);
    const { client, statuses } = setup({ servers: [dying] });
    client.start();
    await flush();
    const error = Object.assign(new Error('spawn striart ENOENT'), { code: 'ENOENT' });
    close(dying, { error, code: -2 });
    assert.equal(last(statuses).status, 'binary-missing');
  });

  it('stop() ferme proprement et n’enclenche aucune reprise', async () => {
    const { client, servers, timers, statuses } = setup();
    client.start();
    await flush();
    await client.stop();
    assert.equal(last(statuses).status, 'stopped');
    assert.equal((servers[0] as FakeServer).closed, true);
    assert.deepEqual(timers.pendingDelays(), []);
  });
});

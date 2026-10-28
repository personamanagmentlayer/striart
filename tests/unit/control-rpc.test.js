import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { en } from '../../src/cli/i18n/en.ts';
import { ControlHub } from '../../src/control/hub.ts';
import { afterWrite, handleMessage } from '../../src/control/rpc.ts';
import { SCHEMA_ROOT, methodSpec, resultSchema } from '../../src/control/schema.ts';
import { createValidator } from '../../src/control/validate.ts';

const validate = createValidator(SCHEMA_ROOT);
const ERROR_DOCUMENT = { $ref: '#/components/schemas/ErrorDocument' };

/** Contexte du répartiteur sans disque : collecte d'état injectée. */
function makeCtx(transport = 'stdio') {
  const hub = new ControlHub({
    root: '/repo',
    watchDisk: false,
    collect: async () => ({
      agents: [],
      tasks: [],
      tickets: [],
      heatmap: [],
      history: [],
      state: { semanticFailureStreak: 0, manualMode: false },
      daemon: {
        running: false,
        stale: false,
        verified: false,
        pid: null,
        startedAt: null,
        logPath: '/l',
        url: null,
      },
      permissions: [],
      elicitations: [],
      orchestration: { runs: [], groups: [] },
      reviews: [],
      overlaps: {
        targetBranch: 'main',
        overlaps: [],
        deferred: [],
        errors: [],
        agentsObserved: 0,
        ignoredShared: 0,
        skippedUnsafe: 0,
        truncated: false,
        coverage: { committed: true, uncommitted: false },
        cost: { gitCalls: 0, budget: 64, cacheHits: 0, durationMs: 0 },
        generatedAt: '2026-01-01T00:00:00.000Z',
      },
      idle: { available: false, reason: 'NOT_COMPUTED_IN_THIS_TEST' },
      mainSession: null,
      profiles: [],
      config: {
        testCommand: 'npm test',
        targetBranch: 'main',
        semanticMerge: true,
        autoRebase: true,
        autoPush: false,
      },
      generatedAt: new Date().toISOString(),
    }),
  });
  const subscriptions = new Set();
  return {
    root: '/repo',
    hub,
    m: en,
    locale: 'en',
    version: '0.0.0-test',
    transport,
    connection:
      transport === 'stdio'
        ? {
            async subscribe() {
              const r = await hub.subscribe(
                {
                  policy: 'coalesce',
                  write: () => {},
                  bufferedBytes: () => 0,
                  disconnect: () => {},
                  onceDrained: () => {},
                },
                { initial: 'return' },
              );
              subscriptions.add(r.subscriptionId);
              return r;
            },
            unsubscribe: (id) => subscriptions.delete(id) && hub.unsubscribe(id),
          }
        : null,
  };
}

const req = (method, params, id = 1) => ({
  jsonrpc: '2.0',
  id,
  method,
  ...(params ? { params } : {}),
});

describe('répartiteur JSON-RPC du Striart Control Protocol', () => {
  let ctx;
  beforeEach(() => {
    ctx = makeCtx();
  });
  afterEach(async () => {
    await ctx.hub.close();
  });

  it('control.initialize : version négociée, méthodes du transport, document conforme au schéma publié', async () => {
    const response = await handleMessage(
      req('control.initialize', { protocolVersion: 1, client: { name: 'vscode' } }),
      ctx,
    );
    expect(response).toMatchObject({ jsonrpc: '2.0', id: 1 });
    expect(validate(resultSchema(methodSpec('control.initialize')), response.result)).toBeNull();
    expect(response.result.data.methods).toContain('state.subscribe');
    expect(response.result.data.notifications).toEqual(['state.changed', 'control.notice']);

    const http = makeCtx('http');
    const viaHttp = await handleMessage(req('control.initialize', { protocolVersion: 1 }), http);
    expect(viaHttp.result.data.methods).not.toContain('state.subscribe');
    await http.hub.close();

    const v2 = await handleMessage(req('control.initialize', { protocolVersion: 2 }), ctx);
    expect(v2.error.data.error).toMatchObject({
      code: 'CONTROL_VERSION_UNSUPPORTED',
      kind: 'usage',
    });
  });

  it('state.get : document de résultat valide (ControlState), révision et instance', async () => {
    const response = await handleMessage(req('state.get'), ctx);
    expect(validate(resultSchema(methodSpec('state.get')), response.result)).toBeNull();
    expect(response.result.data).toMatchObject({ instanceId: ctx.hub.instanceId, revision: 1 });
  });

  it('state.subscribe / unsubscribe : abonnement activé APRÈS la réponse, id inconnu refusé', async () => {
    const response = await handleMessage(req('state.subscribe'), ctx);
    expect(response.result.data).toMatchObject({
      subscriptionId: expect.stringMatching(/^sub-\d+$/),
      seq: 1,
    });
    afterWrite(response);
    const id = response.result.data.subscriptionId;
    expect(
      (await handleMessage(req('state.unsubscribe', { subscriptionId: id }), ctx)).result.data,
    ).toEqual({
      subscriptionId: id,
      unsubscribed: true,
    });
    const again = await handleMessage(req('state.unsubscribe', { subscriptionId: id }), ctx);
    expect(again.error.data.error.code).toBe('CONTROL_SUBSCRIPTION_UNKNOWN');
  });

  it('erreurs de forme : -32600 / -32601 / -32602, toujours avec le document d’erreur du contrat', async () => {
    const cases = [
      [{ id: 1, method: 'state.get' }, -32600, 'CONTROL_INVALID_REQUEST'],
      [{ jsonrpc: '2.0', id: {}, method: 'state.get' }, -32600, 'CONTROL_INVALID_REQUEST'],
      [{ jsonrpc: '2.0', id: 1 }, -32600, 'CONTROL_INVALID_REQUEST'],
      ['nope', -32600, 'CONTROL_INVALID_REQUEST'],
      [req('nope.nope'), -32601, 'CONTROL_METHOD_UNKNOWN'],
      [{ jsonrpc: '2.0', id: 1, method: 'state.get', params: [1] }, -32602, 'INVALID_ARGUMENT'],
      [req('state.get', { extra: true }), -32602, 'INVALID_ARGUMENT'],
      [req('agent.merge', {}), -32602, 'INVALID_AGENT_NAME'],
      [req('agent.merge', { agent: 'a b' }), -32602, 'INVALID_AGENT_NAME'],
      [req('task.run', { prompt: '   ' }), -32602, 'EMPTY_PROMPT'],
      [req('task.run', { prompt: 'x', mode: 'yolo' }), -32602, 'INVALID_ARGUMENT'],
      [req('permission.answer', { id: '../x', option: 'ok' }), -32602, 'PERMISSION_ID_INVALID'],
      [req('ticket.get', { id: '../../etc' }), -32602, 'INVALID_ARGUMENT'],
      [[], -32600, 'CONTROL_INVALID_REQUEST'],
      [Array.from({ length: 33 }, () => req('state.get')), -32600, 'CONTROL_INVALID_REQUEST'],
    ];
    for (const [message, rpcCode, code] of cases) {
      const response = await handleMessage(message, ctx);
      expect(response.error.code, JSON.stringify(message).slice(0, 60)).toBe(rpcCode);
      expect(response.error.data.error.code).toBe(code);
      expect(validate(ERROR_DOCUMENT, response.error.data)).toBeNull();
    }
  });

  it('un paramètre fautif n’est jamais recopié dans l’erreur (un prompt peut porter un secret)', async () => {
    const secret = 'ghp_SECRETSECRETSECRET';
    const response = await handleMessage(req('agent.merge', { agent: secret }), ctx);
    expect(JSON.stringify(response)).not.toContain(secret);
  });

  it('notification (sans id) : exécutée, aucune réponse ; lot : ordre conservé, notifications omises', async () => {
    expect(await handleMessage({ jsonrpc: '2.0', method: 'state.get' }, ctx)).toBeNull();
    const batch = await handleMessage(
      [
        req('state.get', undefined, 'a'),
        { jsonrpc: '2.0', method: 'state.get' },
        req('nope', undefined, 'b'),
      ],
      ctx,
    );
    expect(batch.map((r) => r.id)).toEqual(['a', 'b']);
    expect(batch[1].error.code).toBe(-32601);
  });

  it('HTTP : state.subscribe n’est pas servi (abonnement par GET /events)', async () => {
    const http = makeCtx('http');
    const response = await handleMessage(req('state.subscribe'), http);
    expect(response.error.data.error.code).toBe('CONTROL_METHOD_UNAVAILABLE');
    await http.hub.close();
  });

  it('M13 : un id entier non sûr (au-delà de 2^53) ou fractionnaire est refusé', async () => {
    for (const id of [1.5, 2 ** 53, 1e21]) {
      const response = await handleMessage({ jsonrpc: '2.0', id, method: 'state.get' }, ctx);
      expect(response.error.data.error.code).toBe('CONTROL_INVALID_REQUEST');
    }
  });

  it('M13 : une notification (sans id) qui active un abonnement exécute quand même son activation', async () => {
    const frames = [];
    const hub = ctx.hub;
    ctx.connection = {
      async subscribe() {
        return hub.subscribe(
          {
            policy: 'coalesce',
            write: (method, params) => frames.push({ method, params }),
            bufferedBytes: () => 0,
            disconnect: () => {},
            onceDrained: () => {},
          },
          { initial: 'return' },
        );
      },
      unsubscribe: () => true,
    };
    const response = await handleMessage({ jsonrpc: '2.0', method: 'state.subscribe' }, ctx);
    expect(response).toBeNull();
    hub.notice('t', 'after');
    expect(frames.map((f) => f.method)).toEqual(['control.notice']);
  });
});

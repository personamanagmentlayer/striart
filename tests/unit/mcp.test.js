import { describe, expect, it } from 'vitest';
import { PassThrough } from 'node:stream';
import { handleMcpRequest, startMcpServer } from '../../src/mcp.js';

const CTX = { root: 'C:/nulle-part', env: {} };
const NESTED = { root: 'C:/nulle-part', env: { STRIART_SESSION: '1' } };

describe('MCP — dispatch JSON-RPC', () => {
  it('initialize répond version de protocole, capacités tools et identité', async () => {
    const r = await handleMcpRequest(CTX, { jsonrpc: '2.0', id: 1, method: 'initialize' });
    expect(r.id).toBe(1);
    expect(r.result.protocolVersion).toBeTruthy();
    expect(r.result.capabilities.tools).toBeDefined();
    expect(r.result.serverInfo.name).toBe('striart');
  });

  it('tools/list expose les 5 outils, chacun avec description et schéma', async () => {
    const r = await handleMcpRequest(CTX, { jsonrpc: '2.0', id: 2, method: 'tools/list' });
    const names = r.result.tools.map((t) => t.name).sort();
    expect(names).toEqual([
      'striart_merge',
      'striart_queue',
      'striart_resolve',
      'striart_run',
      'striart_status',
    ]);
    for (const tool of r.result.tools) {
      expect(tool.description.length).toBeGreaterThan(20);
      expect(tool.inputSchema.type).toBe('object');
    }
  });

  it('les notifications ne reçoivent jamais de réponse', async () => {
    expect(
      await handleMcpRequest(CTX, { jsonrpc: '2.0', method: 'notifications/initialized' }),
    ).toBeNull();
  });

  it('méthode inconnue → erreur -32601 ; outil inconnu → -32602', async () => {
    const m = await handleMcpRequest(CTX, { jsonrpc: '2.0', id: 3, method: 'resources/list' });
    expect(m.error.code).toBe(-32601);
    const t = await handleMcpRequest(CTX, {
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: { name: 'striart_exec' },
    });
    expect(t.error.code).toBe(-32602);
  });

  it('un échec métier revient en résultat isError, pas en erreur protocole', async () => {
    // root inexistant → l'outil échoue ; le modèle appelant doit LIRE l'échec.
    const r = await handleMcpRequest(CTX, {
      jsonrpc: '2.0',
      id: 5,
      method: 'tools/call',
      params: { name: 'striart_status', arguments: {} },
    });
    expect(r.error).toBeUndefined();
    expect(r.result.isError).toBe(true);
    expect(r.result.content[0].text.length).toBeGreaterThan(0);
  });
});

describe('MCP — garde de profondeur (session autonome)', () => {
  it.each(['striart_run', 'striart_merge', 'striart_resolve'])(
    '%s est refusé sous STRIART_SESSION=1, avec le motif',
    async (name) => {
      const r = await handleMcpRequest(NESTED, {
        jsonrpc: '2.0',
        id: 6,
        method: 'tools/call',
        params: { name, arguments: { prompt: 'x', agent: 'a', ticketId: 't' } },
      });
      expect(r.result.isError).toBe(true);
      expect(r.result.content[0].text).toContain('profondeur');
    },
  );

  it('les outils de LECTURE restent accessibles à un agent (status, queue)', async () => {
    // Même refusée sur le fond (root inexistant), la garde ne doit PAS
    // intercepter : l'erreur vient de l'outil, pas de la profondeur.
    const r = await handleMcpRequest(NESTED, {
      jsonrpc: '2.0',
      id: 7,
      method: 'tools/call',
      params: { name: 'striart_queue', arguments: {} },
    });
    expect(r.result.content[0].text).not.toContain('profondeur');
  });
});

describe('MCP — boucle stdio en process (flux injectés)', () => {
  const startLoop = () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const chunks = [];
    output.on('data', (c) => chunks.push(c.toString()));
    // root factice : les cas testés ici (parse, bornes, notifications,
    // initialize) n'atteignent jamais le disque.
    const done = startMcpServer({ root: '/tmp/nulle-part', input, output });
    const responses = () =>
      chunks
        .join('')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l));
    const send = (line) => input.write(`${line}\n`);
    return { input, send, responses, done };
  };
  const flushed = () => new Promise((resolve) => setImmediate(resolve));

  it('répond à initialize, ignore les lignes vides et les notifications, résout à la fermeture', async () => {
    const { input, send, responses, done } = startLoop();
    send('');
    send(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }));
    send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }));
    await flushed();
    const out = responses();
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe(1);
    expect(out[0].result.serverInfo.name).toBe('striart');
    input.end();
    await done; // stdin fermé → la promesse du serveur se résout.
  });

  it('JSON invalide → -32700, et le serveur SURVIT (requête suivante servie)', async () => {
    const { input, send, responses, done } = startLoop();
    send('{pas du json');
    send(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'ping' }));
    await flushed();
    const out = responses();
    expect(out[0].error.code).toBe(-32700);
    expect(out[1]).toEqual({ jsonrpc: '2.0', id: 2, result: {} });
    input.end();
    await done;
  });

  it('ligne > 1 Mo → -32700 « trop volumineuse », sans parse ni OOM', async () => {
    const { input, send, responses, done } = startLoop();
    send('x'.repeat(1_000_001));
    await flushed();
    expect(responses()[0].error.message).toMatch(/volumineuse/);
    input.end();
    await done;
  });

  it("l'env injecté porte la garde de profondeur jusqu'à la boucle", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const chunks = [];
    output.on('data', (c) => chunks.push(c.toString()));
    const done = startMcpServer({
      root: '/tmp/nulle-part',
      input,
      output,
      env: { STRIART_SESSION: '1' },
    });
    input.write(
      `${JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'striart_run', arguments: { prompt: 'x' } } })}\n`,
    );
    await flushed();
    const out = JSON.parse(chunks.join('').split('\n')[0]);
    expect(out.result.isError).toBe(true);
    expect(out.result.content[0].text).toMatch(/profondeur/);
    input.end();
    await done;
  });
});

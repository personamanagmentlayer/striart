import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { en } from '../../src/cli/i18n/en.ts';
import { serveStdio } from '../../src/control/stdio.ts';

/** Sortie factice : `write` rend false tant que `drain()` n'a pas été appelé. */
function fakeOutput({ throwOnFirst = false } = {}) {
  const out = new EventEmitter();
  out.lines = [];
  out.writableLength = 0;
  let first = true;
  out.write = (text) => {
    if (throwOnFirst && first) {
      first = false;
      throw new Error('EPIPE simulé');
    }
    out.lines.push(text);
    out.writableLength += Buffer.byteLength(text);
    return false;
  };
  out.drain = () => {
    out.writableLength = 0;
    out.emit('drain');
  };
  return out;
}

const request = (id) => `${JSON.stringify({ jsonrpc: '2.0', id, method: 'rpc.discover' })}\n`;
const tick = () => new Promise((resolve) => setTimeout(resolve, 50));

function serve(input, output, extra = {}) {
  return serveStdio({
    root: '/repo',
    input,
    output,
    framing: 'ndjson',
    m: en,
    locale: 'en',
    version: '0.0.0-test',
    ...extra,
  });
}

describe('transport stdio du protocole de contrôle', () => {
  it('M4 : une écriture qui échoue ne produit pas d’unhandledRejection et la connexion continue', async () => {
    const input = new PassThrough();
    const output = fakeOutput({ throwOnFirst: true });
    const done = serve(input, output, { maxBufferedBytes: 1 << 30 });
    input.write(request(1));
    await tick();
    input.write(request(2));
    await tick();
    input.end();
    await done;
    expect(output.lines.some((l) => l.includes('"id":2'))).toBe(true);
  });

  it('M4 : contre-pression — la lecture de stdin s’arrête tant que le client ne lit pas ses réponses', async () => {
    const input = new PassThrough();
    const output = fakeOutput();
    const done = serve(input, output, { maxBufferedBytes: 1 });
    for (let id = 1; id <= 80; id += 1) input.write(request(id));
    await tick();
    const beforeDrain = output.lines.length;
    expect(beforeDrain).toBeLessThan(40);
    // Le client se remet à lire : tout est servi.
    for (let i = 0; i < 200 && output.lines.length < 80; i += 1) {
      output.drain();
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    input.end();
    await done;
    expect(output.lines).toHaveLength(80);
  });

  it('M4 : l’arrêt demandé libère une lecture bloquée par la contre-pression', async () => {
    const input = new PassThrough();
    const output = fakeOutput();
    const controller = new AbortController();
    const done = serve(input, output, { maxBufferedBytes: 1, signal: controller.signal });
    for (let id = 1; id <= 80; id += 1) input.write(request(id));
    await tick();
    controller.abort();
    await expect(done).resolves.toBeDefined();
  });
});

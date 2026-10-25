import { describe, expect, it } from 'vitest';
import { Readable } from 'node:stream';
import { encodeFrame, readFrames } from '../../src/control/framing.ts';

async function collect(chunks, framing, max) {
  const out = [];
  for await (const frame of readFrames(
    Readable.from(chunks.map((c) => Buffer.from(c))),
    framing,
    max,
  ))
    out.push('text' in frame ? frame.text : { code: frame.error.code, fatal: frame.fatal });
  return out;
}

describe('cadrage stdio du protocole', () => {
  it('ndjson : un message par ligne, lignes vides ignorées, CRLF toléré, découpage arbitraire', async () => {
    expect(await collect(['{"a":1}\n\n{"b"', ':2}\r\n{"c":3}'], 'ndjson')).toEqual([
      '{"a":1}',
      '{"b":2}',
      '{"c":3}',
    ]);
  });

  it('ndjson : un message trop gros est écarté et signalé, le flux continue', async () => {
    const out = await collect([`${'x'.repeat(50)}\n{"ok":1}\n`], 'ndjson', 20);
    expect(out).toEqual([{ code: 'CONTROL_MESSAGE_TOO_LARGE', fatal: false }, '{"ok":1}']);
  });

  it('content-length : trames LSP, UTF-8 multi-octets, coupées n’importe où', async () => {
    const a = encodeFrame('content-length', { m: 'é😀' });
    const b = encodeFrame('content-length', { n: 2 });
    const all = a + b;
    const bytes = Buffer.from(all);
    const chunks = [bytes.subarray(0, 7), bytes.subarray(7, 30), bytes.subarray(30)].map((c) =>
      c.toString('latin1'),
    );
    // Reconstitue des Buffers exacts (latin1 est bijectif octet ↔ caractère).
    const frames = [];
    for await (const f of readFrames(
      Readable.from(chunks.map((c) => Buffer.from(c, 'latin1'))),
      'content-length',
    ))
      frames.push(f.text);
    expect(frames.map((t) => JSON.parse(t))).toEqual([{ m: 'é😀' }, { n: 2 }]);
  });

  it('content-length : corps trop gros écarté sans être bufferisé, la trame suivante passe', async () => {
    const big = `Content-Length: 100\r\n\r\n${'y'.repeat(100)}`;
    const out = await collect(
      [big, encodeFrame('content-length', { ok: true })],
      'content-length',
      50,
    );
    expect(out).toEqual([{ code: 'CONTROL_MESSAGE_TOO_LARGE', fatal: false }, '{"ok":true}']);
  });

  it('content-length : en-têtes illisibles = désynchronisation FATALE (on ne devine pas)', async () => {
    expect(await collect(['garbage\r\n\r\n{}'], 'content-length')).toEqual([
      { code: 'CONTROL_INVALID_REQUEST', fatal: true },
    ]);
    expect(await collect(['Content-Length: -1\r\n\r\n'], 'content-length')).toEqual([
      { code: 'CONTROL_INVALID_REQUEST', fatal: true },
    ]);
    expect(await collect([`X-Junk: ${'z'.repeat(9000)}`], 'content-length')).toEqual([
      { code: 'CONTROL_INVALID_REQUEST', fatal: true },
    ]);
  });

  it('encodeFrame ndjson : une seule ligne même si les données contiennent des sauts de ligne', () => {
    const line = encodeFrame('ndjson', { text: 'a\nb\r\nc' });
    expect(line.endsWith('\n')).toBe(true);
    expect(line.slice(0, -1)).not.toMatch(/[\r\n]/);
  });
});

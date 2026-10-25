import { describe, expect, it } from 'vitest';
import { PassThrough, Readable } from 'node:stream';
import { boundedLines } from '../../src/line-reader.ts';

const collect = async (iterable) => {
  const out = [];
  for await (const line of iterable) out.push(line);
  return out;
};

describe('boundedLines — découpe bornée', () => {
  it('découpe sur \\n et \\r\\n, émet la dernière ligne sans saut final', async () => {
    const stream = Readable.from([Buffer.from('a\r\nbb\n'), Buffer.from('\nccc')]);
    expect(await collect(boundedLines(stream, { maxLineBytes: 10 }))).toEqual([
      'a',
      'bb',
      '',
      'ccc',
    ]);
  });

  it('ne coupe jamais un caractère multi-octets réparti sur deux chunks', async () => {
    const bytes = Buffer.from('é€😀\n', 'utf8');
    // Un chunk par octet : chaque caractère est fendu au pire endroit.
    const chunks = [...bytes].map((b) => Buffer.from([b]));
    expect(await collect(boundedLines(Readable.from(chunks), { maxLineBytes: 64 }))).toEqual([
      'é€😀',
    ]);
  });

  it('écarte une ligne trop longue, signale les octets jetés, et reprend à la suivante', async () => {
    const dropped = [];
    const stream = Readable.from([
      Buffer.from('x'.repeat(30)),
      Buffer.from('y'.repeat(30) + '\nok\n'),
    ]);
    const lines = await collect(
      boundedLines(stream, { maxLineBytes: 16, onOverflow: (n) => dropped.push(n) }),
    );
    expect(lines).toEqual(['ok']);
    expect(dropped).toEqual([60]);
  });

  it('la borne est exacte : maxLineBytes passe, maxLineBytes + 1 est écarté (\\r exclu)', async () => {
    const dropped = [];
    const stream = Readable.from([Buffer.from('abcd\r\nabcde\nabcd')]);
    const lines = await collect(
      boundedLines(stream, { maxLineBytes: 4, onOverflow: (n) => dropped.push(n) }),
    );
    expect(lines).toEqual(['abcd', 'abcd']);
    expect(dropped).toEqual([5]);
  });

  it("ne retient pas en mémoire une ligne géante sans \\n (pas d'accumulation)", async () => {
    // 64 Mo poussés sans saut de ligne : un lecteur qui accumule garderait
    // tout ; ici la mémoire retenue reste bornée et la ligne finit écartée.
    const input = new PassThrough();
    const dropped = [];
    const iter = boundedLines(input, { maxLineBytes: 1024, onOverflow: (n) => dropped.push(n) });
    const done = collect(iter);
    const block = Buffer.alloc(1024 * 1024, 0x41);
    const before = process.memoryUsage().arrayBuffers;
    for (let i = 0; i < 64; i++) {
      if (!input.write(block)) await new Promise((r) => input.once('drain', r));
    }
    const peak = process.memoryUsage().arrayBuffers;
    input.end('\nsuite\n');
    expect(await done).toEqual(['suite']);
    expect(dropped).toEqual([64 * 1024 * 1024]);
    // Marge large (GC non déterministe) mais très en dessous des 64 Mo.
    expect(peak - before).toBeLessThan(32 * 1024 * 1024);
  });

  it('accepte un flux de chaînes (setEncoding) et refuse des options invalides', async () => {
    const stream = Readable.from(['ligne 1\nligne', ' 2\n']);
    expect(await collect(boundedLines(stream, { maxLineBytes: 100 }))).toEqual([
      'ligne 1',
      'ligne 2',
    ]);
    expect(() => boundedLines(Readable.from([]), { maxLineBytes: 0 })).toThrow(/maxLineBytes/);
    expect(() =>
      boundedLines(Readable.from([]), { maxLineBytes: 10, encoding: 'utf16le' }),
    ).toThrow(/encoding/);
  });
});

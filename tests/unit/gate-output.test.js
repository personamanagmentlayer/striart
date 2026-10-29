// Parties pures du Test Gate (src/gate.js) : plafond de journal en flux et
// argv du shell. Aucun process : unitaire.
import { describe, expect, it } from 'vitest';
import { TailBuffer, gateShellArgv } from '../../src/gate.ts';

describe('TailBuffer — la FIN de la sortie, en mémoire bornée', () => {
  it('sous le plafond : tout est conservé, rien n’est tronqué', () => {
    const tail = new TailBuffer(100);
    tail.push('abc');
    tail.push(Buffer.from('def'));
    expect(tail.toString()).toBe('abcdef');
    expect(tail.truncated).toBe(false);
    expect(tail.bytes).toBe(6);
  });

  it('au-delà : les plus anciens octets sont écartés, jamais plus que le plafond', () => {
    const tail = new TailBuffer(10);
    for (let i = 0; i < 1000; i++) tail.push(`${String(i).padStart(3, '0')}|`);
    expect(tail.bytes).toBeLessThanOrEqual(10);
    expect(tail.truncated).toBe(true);
    expect(tail.toString().endsWith('999|')).toBe(true);
    expect(tail.dropped).toBe(4000 - tail.bytes);
  });

  it('un seul gros morceau est coupé net (fin gardée)', () => {
    const tail = new TailBuffer(5);
    tail.push('0123456789');
    expect(tail.toString()).toBe('56789');
    expect(tail.dropped).toBe(5);
  });

  it('morceaux multi-octets : la concaténation se décode en une fois (pas de coupure par morceau)', () => {
    const tail = new TailBuffer(100);
    const bytes = Buffer.from('é€😀', 'utf8');
    for (const byte of bytes) tail.push(Buffer.from([byte]));
    expect(tail.toString()).toBe('é€😀');
  });
});

describe('gateShellArgv — argv du shell (jamais d’interprétation par un shell caché)', () => {
  it('POSIX : /bin/sh -c <commande>', () => {
    expect(gateShellArgv('npm test', 'linux')).toEqual({
      argv: ['/bin/sh', '-c', 'npm test'],
      windowsVerbatimArguments: false,
    });
  });

  it('Windows : ComSpec /d /s /c "<commande>" en arguments verbatim (comme execa shell:true)', () => {
    expect(
      gateShellArgv('npm test && echo "a b"', 'win32', { ComSpec: 'C:\\Windows\\cmd.exe' }),
    ).toEqual({
      argv: ['C:\\Windows\\cmd.exe', '/d', '/s', '/c', '"npm test && echo "a b""'],
      windowsVerbatimArguments: true,
    });
    expect(gateShellArgv('x', 'win32', {}).argv[0]).toBe('cmd.exe');
  });
});

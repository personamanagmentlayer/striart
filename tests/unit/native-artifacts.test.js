import { describe, expect, it } from 'vitest';
import {
  binaryFileName,
  checksumFileName,
  detectBinaryTarget,
  formatChecksumLine,
  parseCargoLock,
  parseChecksumLine,
  platformPackageManifest,
} from '../../scripts/native-artifacts.ts';
import { nativePlatform } from '../../src/native.ts';

function pe(machine) {
  const b = Buffer.alloc(256);
  b.write('MZ', 0, 'latin1');
  b.writeUInt32LE(0x80, 0x3c);
  b.writeUInt32LE(0x00004550, 0x80);
  b.writeUInt16LE(machine, 0x84);
  return b;
}

function elf(machine, { interp = false } = {}) {
  const b = Buffer.alloc(512);
  b.writeUInt32BE(0x7f454c46, 0);
  b[4] = 2;
  b[5] = 1;
  b.writeUInt16LE(machine, 18);
  b.writeBigUInt64LE(64n, 32); // e_phoff
  b.writeUInt16LE(56, 54); // e_phentsize
  b.writeUInt16LE(2, 56); // e_phnum
  b.writeUInt32LE(1, 64); // PT_LOAD
  b.writeUInt32LE(interp ? 3 : 1, 120);
  return b;
}

function macho(cputype) {
  const b = Buffer.alloc(64);
  b.writeUInt32LE(0xfeedfacf, 0);
  b.writeUInt32LE(cputype, 4);
  return b;
}

describe('detectBinaryTarget', () => {
  it('PE x64 / arm64', () => {
    expect(detectBinaryTarget(pe(0x8664))).toEqual({ os: 'win32', cpu: 'x64', dynamic: false });
    expect(detectBinaryTarget(pe(0xaa64))).toMatchObject({ os: 'win32', cpu: 'arm64' });
    expect(detectBinaryTarget(pe(0x014c))).toBeNull(); // i386
  });

  it('ELF : CPU et lien dynamique (PT_INTERP)', () => {
    expect(detectBinaryTarget(elf(0x3e))).toEqual({ os: 'linux', cpu: 'x64', dynamic: false });
    expect(detectBinaryTarget(elf(0xb7, { interp: true }))).toEqual({
      os: 'linux',
      cpu: 'arm64',
      dynamic: true,
    });
  });

  it('Mach-O 64 mince ; universel et inconnu refusés', () => {
    expect(detectBinaryTarget(macho(0x01000007))).toMatchObject({ os: 'darwin', cpu: 'x64' });
    expect(detectBinaryTarget(macho(0x0100000c))).toMatchObject({ os: 'darwin', cpu: 'arm64' });
    const fat = Buffer.alloc(64);
    fat.writeUInt32BE(0xcafebabe, 0);
    expect(detectBinaryTarget(fat)).toBeNull();
    expect(detectBinaryTarget(Buffer.from('#!/bin/sh\necho hi\n'.padEnd(80)))).toBeNull();
  });
});

describe('empreintes sha256sum', () => {
  it('format et relecture stricte', () => {
    const sha = 'f'.repeat(64);
    const line = formatChecksumLine(sha, 'striart-native.exe');
    expect(line).toBe(`${sha}  striart-native.exe\n`);
    expect(parseChecksumLine(line, 'striart-native.exe')).toBe(sha);
    expect(parseChecksumLine(line, 'striart-native')).toBeNull();
    expect(parseChecksumLine('zz  striart-native', 'striart-native')).toBeNull();
  });
  it('noms de fichiers par OS', () => {
    expect(binaryFileName({ os: 'win32' })).toBe('striart-native.exe');
    expect(checksumFileName({ os: 'linux' })).toBe('striart-native.sha256');
  });
});

describe('parseCargoLock', () => {
  it('blocs [[package]], tableaux multi-lignes, source et somme', () => {
    const lock = `# auto
version = 4

[[package]]
name = "libc"
version = "0.2.190"
source = "registry+https://github.com/rust-lang/crates.io-index"
checksum = "${'1'.repeat(64)}"

[[package]]
name = "striart-native"
version = "0.1.0"
dependencies = [
 "libc",
]
`;
    expect(parseCargoLock(lock)).toEqual([
      {
        name: 'libc',
        version: '0.2.190',
        source: 'registry+https://github.com/rust-lang/crates.io-index',
        checksum: '1'.repeat(64),
      },
      { name: 'striart-native', version: '0.1.0', source: null, checksum: null },
    ]);
  });
  it('ligne inattendue = erreur, jamais ignorée', () => {
    expect(() => parseCargoLock('[[package]]\nname "x"\n')).toThrow(/unexpected line/);
  });
});

describe('platformPackageManifest', () => {
  it('os/cpu restreints, bin/ seul, version du paquet principal', () => {
    const manifest = platformPackageManifest(nativePlatform('darwin', 'arm64'), {
      name: '@jumsay/striart',
      version: '0.11.0',
      license: 'MIT',
      repository: { type: 'git', url: 'x' },
      publishConfig: { registry: 'r' },
    });
    expect(manifest).toMatchObject({
      name: '@jumsay/striart-native-darwin-arm64',
      version: '0.11.0',
      os: ['darwin'],
      cpu: ['arm64'],
      files: ['bin/'],
      publishConfig: { registry: 'r' },
    });
    expect(manifest).not.toHaveProperty('scripts');
  });
});

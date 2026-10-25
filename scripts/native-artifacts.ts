// Artefacts natifs (binaires `striart-native` par plateforme) — fonctions
// partagées par scripts/native-stage.ts (CI : dépôt des binaires construits)
// et scripts/pack.ts (archives des paquets de plateforme, manifeste signé,
// SBOM). Fonctions pures, testées en unitaire (tests/unit/native-artifacts.test.js).

import path from 'node:path';
import type { NativePlatform } from '../src/native.ts';

/** Nom du fichier binaire dans le dossier d'une plateforme. */
export function binaryFileName(platform: Pick<NativePlatform, 'os'>): string {
  return platform.os === 'win32' ? 'striart-native.exe' : 'striart-native';
}

/** Fichier d'empreinte d'un binaire déposé (format `sha256sum`). */
export function checksumFileName(platform: Pick<NativePlatform, 'os'>): string {
  return `${binaryFileName(platform)}.sha256`;
}

/** Ligne `sha256sum` : `<hex>  <fichier>`. */
export function formatChecksumLine(sha256: string, fileName: string): string {
  return `${sha256}  ${fileName}\n`;
}

/** Empreinte d'une ligne `sha256sum` pour `fileName` ; null si absente ou mal formée. */
export function parseChecksumLine(text: string, fileName: string): string | null {
  for (const line of text.split(/\r?\n/)) {
    const match = /^([0-9a-f]{64}) [ *](.+)$/.exec(line.trim());
    if (match && match[2] === fileName) return match[1];
  }
  return null;
}

export interface BinaryTarget {
  os: 'win32' | 'darwin' | 'linux';
  cpu: 'x64' | 'arm64';
  /** ELF seulement : présence d'un interpréteur (PT_INTERP) = lien dynamique. */
  dynamic: boolean;
}

/**
 * OS et CPU d'un exécutable, lus dans son en-tête (PE, ELF 64 bits, Mach-O
 * 64 bits mince). Null pour tout autre format — dont les binaires
 * universels Mach-O, que la distribution ne publie pas.
 */
export function detectBinaryTarget(bytes: Buffer): BinaryTarget | null {
  if (bytes.length < 64) return null;
  // PE : « MZ », e_lfanew → « PE\0\0 », Machine.
  if (bytes[0] === 0x4d && bytes[1] === 0x5a) {
    const pe = bytes.readUInt32LE(0x3c);
    if (pe + 6 > bytes.length || bytes.readUInt32LE(pe) !== 0x00004550) return null;
    const machine = bytes.readUInt16LE(pe + 4);
    if (machine === 0x8664) return { os: 'win32', cpu: 'x64', dynamic: false };
    if (machine === 0xaa64) return { os: 'win32', cpu: 'arm64', dynamic: false };
    return null;
  }
  // ELF 64 bits petit-boutiste.
  if (bytes.readUInt32BE(0) === 0x7f454c46) {
    if (bytes[4] !== 2 || bytes[5] !== 1) return null;
    const machine = bytes.readUInt16LE(18);
    const cpu = machine === 0x3e ? 'x64' : machine === 0xb7 ? 'arm64' : null;
    if (!cpu) return null;
    const phoff = Number(bytes.readBigUInt64LE(32));
    const phentsize = bytes.readUInt16LE(54);
    const phnum = bytes.readUInt16LE(56);
    let dynamic = false;
    for (let i = 0; i < phnum; i += 1) {
      const at = phoff + i * phentsize;
      if (at + 4 > bytes.length) return null;
      if (bytes.readUInt32LE(at) === 3) dynamic = true; // PT_INTERP
    }
    return { os: 'linux', cpu, dynamic };
  }
  // Mach-O 64 bits mince (MH_MAGIC_64 en petit-boutiste).
  if (bytes.readUInt32LE(0) === 0xfeedfacf) {
    const cputype = bytes.readUInt32LE(4);
    if (cputype === 0x01000007) return { os: 'darwin', cpu: 'x64', dynamic: false };
    if (cputype === 0x0100000c) return { os: 'darwin', cpu: 'arm64', dynamic: false };
    return null;
  }
  return null;
}

/** package.json d'un paquet de plateforme. */
export function platformPackageManifest(
  platform: NativePlatform,
  main: Record<string, unknown>,
): Record<string, unknown> {
  const manifest: Record<string, unknown> = {
    name: platform.packageName,
    version: main.version,
    description: `Binaire natif de Striart (striart-native) pour ${platform.key} — dépendance optionnelle de ${String(main.name)}, vérifiée au chargement contre son manifeste signé.`,
    license: main.license,
    repository: main.repository,
    os: [platform.os],
    cpu: [platform.cpu],
    files: ['bin/'],
    // Le binaire doit exister sur disque (Yarn PnP, gestionnaires à archive).
    preferUnplugged: true,
  };
  if (main.publishConfig) manifest.publishConfig = main.publishConfig;
  if (main.author) manifest.author = main.author;
  return manifest;
}

export interface CargoLockPackage {
  name: string;
  version: string;
  source: string | null;
  checksum: string | null;
}

/**
 * Paquets de Cargo.lock (format TOML v3/v4 : blocs `[[package]]` à clés
 * simples). Suffisant pour le SBOM ; aucune autre forme n'est acceptée en
 * silence : une ligne de bloc inattendue est une erreur.
 */
export function parseCargoLock(text: string): CargoLockPackage[] {
  const packages: CargoLockPackage[] = [];
  let current: Record<string, string> | null = null;
  let inArray = false;
  const flush = () => {
    if (!current) return;
    if (!current.name || !current.version)
      throw new Error('Cargo.lock: package without name/version');
    packages.push({
      name: current.name,
      version: current.version,
      source: current.source ?? null,
      checksum: current.checksum ?? null,
    });
  };
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (inArray) {
      if (line.endsWith(']')) inArray = false;
      continue;
    }
    if (line === '' || line.startsWith('#')) continue;
    if (line === '[[package]]') {
      flush();
      current = {};
      continue;
    }
    if (line.startsWith('[')) {
      flush();
      current = null;
      continue;
    }
    const match = /^([a-z_]+)\s*=\s*(.*)$/.exec(line);
    if (!match) throw new Error(`Cargo.lock: unexpected line "${line}"`);
    const [, key, value] = match;
    if (value.startsWith('[')) {
      inArray = !value.endsWith(']');
      continue;
    }
    const string = /^"([^"]*)"$/.exec(value);
    if (current && string) current[key] = string[1];
  }
  flush();
  return packages;
}

/** Chemin POSIX relatif `a/b` → chemin natif sous `root`. */
export function underRoot(root: string, posixRelative: string): string {
  return path.join(root, ...posixRelative.split('/'));
}

#!/usr/bin/env node
// Dépose un binaire `striart-native` construit dans le dossier d'entrée de
// scripts/pack.ts (`--native-dir`), avec son empreinte SHA-256.
//
// Usage : node scripts/native-stage.ts [--platform <clé>] [--out-dir <dossier>]
//                                       [--from <binaire>]
//         (ou : npm run native:stage -- <options>)
//
// - `--platform` : clé `<os>-<cpu>` (win32-x64, linux-arm64…) ; défaut : la
//   plateforme courante.
// - `--from` : binaire à déposer ; défaut : native/target/<cible Rust>/release/
//   (build croisé de la CI), puis native/target/release/ pour la plateforme
//   courante (`npm run native:build`).
// - `--out-dir` : défaut dist/native/.
//
// Contrôle fail closed : l'en-tête de l'exécutable (PE / ELF / Mach-O) doit
// correspondre à la plateforme annoncée, et un binaire Linux doit être lié
// statiquement (musl) — un seul binaire pour glibc et musl.
//
// Sortie : `<out>/<clé>/striart-native[.exe]` et `….sha256`. Données sur
// stdout (chemin déposé), diagnostics sur stderr. Sorties : 0, 1 échec, 2 usage.

import { createHash } from 'node:crypto';
import { promises as fs, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { NATIVE_PLATFORMS, nativePlatform } from '../src/native.ts';
import {
  binaryFileName,
  checksumFileName,
  detectBinaryTarget,
  formatChecksumLine,
} from './native-artifacts.ts';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

class StageError extends Error {
  readonly code: string;
  readonly usage: boolean;

  constructor(message: string, code: string, usage = false) {
    super(message);
    this.code = code;
    this.usage = usage;
  }
}

async function exists(file: string): Promise<boolean> {
  return fs
    .stat(file)
    .then((s) => s.isFile())
    .catch(() => false);
}

export async function stageNativeBinary({
  platformKey,
  outDir,
  from,
}: {
  platformKey: string;
  outDir: string;
  from: string | null;
}): Promise<{ path: string; sha256: string; size: number }> {
  const platform = NATIVE_PLATFORMS.find((p) => p.key === platformKey);
  if (!platform) {
    throw new StageError(
      `Plateforme inconnue : ${platformKey} (connues : ${NATIVE_PLATFORMS.map((p) => p.key).join(', ')}).`,
      'STAGE_USAGE',
      true,
    );
  }
  const exe = binaryFileName(platform);
  const host = nativePlatform();
  const candidates = from
    ? [path.resolve(from)]
    : [
        path.join(REPO_ROOT, 'native', 'target', platform.rustTarget, 'release', exe),
        ...(host?.key === platform.key
          ? [path.join(REPO_ROOT, 'native', 'target', 'release', exe)]
          : []),
      ];
  let source: string | null = null;
  for (const candidate of candidates) {
    if (await exists(candidate)) {
      source = candidate;
      break;
    }
  }
  if (!source) {
    throw new StageError(
      `Binaire ${platform.key} introuvable (${candidates.join(', ')}). Construire d'abord (depuis native/, pour la toolchain épinglée) : cargo build --release --locked --bin striart-native --target ${platform.rustTarget}`,
      'STAGE_BINARY_MISSING',
    );
  }
  const bytes = await fs.readFile(source);
  const target = detectBinaryTarget(bytes);
  if (!target || target.os !== platform.os || target.cpu !== platform.cpu) {
    throw new StageError(
      `${source} n'est pas un exécutable ${platform.key} (en-tête : ${target ? `${target.os}-${target.cpu}` : 'inconnu'}).`,
      'STAGE_FORMAT_MISMATCH',
    );
  }
  if (target.dynamic) {
    throw new StageError(
      `${source} est lié dynamiquement : la distribution Linux exige un binaire musl statique (cible ${platform.rustTarget}).`,
      'STAGE_NOT_STATIC',
    );
  }
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const dir = path.join(outDir, platform.key);
  await fs.mkdir(dir, { recursive: true });
  const dest = path.join(dir, exe);
  await fs.writeFile(dest, bytes, { mode: 0o755 });
  await fs.writeFile(path.join(dir, checksumFileName(platform)), formatChecksumLine(sha256, exe));
  return { path: dest, sha256, size: bytes.length };
}

async function main(): Promise<void> {
  try {
    let values;
    try {
      ({ values } = parseArgs({
        args: process.argv.slice(2),
        strict: true,
        allowPositionals: false,
        options: {
          platform: { type: 'string' },
          'out-dir': { type: 'string' },
          from: { type: 'string' },
          help: { type: 'boolean', short: 'h', default: false },
        },
      }));
    } catch (error) {
      throw new StageError((error as Error).message, 'STAGE_USAGE', true);
    }
    if (values.help) {
      process.stdout.write(
        'Usage : node scripts/native-stage.ts [--platform <clé>] [--out-dir <dossier>] [--from <binaire>]\n',
      );
      return;
    }
    const platformKey = values.platform ?? nativePlatform()?.key;
    if (!platformKey) {
      throw new StageError(
        `Plateforme courante ${process.platform}-${process.arch} non publiée : préciser --platform.`,
        'STAGE_USAGE',
        true,
      );
    }
    const result = await stageNativeBinary({
      platformKey,
      outDir: path.resolve(values['out-dir'] ?? path.join(REPO_ROOT, 'dist', 'native')),
      from: values.from ?? null,
    });
    process.stderr.write(`${platformKey} : ${result.sha256} (${result.size} octets)\n`);
    process.stdout.write(`${result.path}\n`);
  } catch (error) {
    if (error instanceof StageError) {
      process.stderr.write(`✖ ${error.message}\n  [${error.code}]\n`);
      process.exitCode = error.usage ? 2 : 1;
      return;
    }
    process.stderr.write(`✖ Erreur inattendue : ${(error as Error)?.message ?? String(error)}\n`);
    process.exitCode = 1;
  }
}

function isEntryPoint(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    // Chemin d'entrée illisible : ce n'est pas nous.
    return false;
  }
}

if (isEntryPoint()) await main();

// src/native.ts contre de vrais binaires : résolution (variable explicite,
// build de dev, paquet de plateforme), vérification d'intégrité fail closed
// (empreinte, signature, versions), validation positive du protocole.
// Binaire construit par tests/helpers/native-setup.js (globalSetup).
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { copyFile, mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  NATIVE_MANIFEST_FILE,
  NATIVE_SIGNATURE_FILE,
  getNativeBinary,
  nativePlatform,
  nativeProcessInfo,
  resetNativeBinaryCache,
  resolveNativeBinary,
  sha256File,
} from '../../src/native.ts';
import { minisign } from '../../src/native-signature-minisign.ts';
import { nativeBinaryPath, nativeFixturePath, REPO_ROOT } from '../helpers/native.js';
import { requireNativeBuild } from '../helpers/native-build.js';
import { readNativeCrateVersion } from '../../scripts/pack.ts';

// Échec explicite (sortie cargo) si le binaire natif ne compile pas.
beforeAll(() => requireNativeBuild(REPO_ROOT));

const host = nativePlatform();

async function expectStriartError(promise, code, reason) {
  const error = await promise.then(
    () => null,
    (e) => e,
  );
  expect(error, `expected ${code}`).not.toBeNull();
  expect(error.code).toBe(code);
  if (reason) expect(error.details.reason).toBe(reason);
  return error;
}

/**
 * Paquet Striart INSTALLÉ simulé : racine (package.json, manifeste signé,
 * clé publique) + paquet de plateforme (le vrai binaire), comme
 * scripts/pack.ts les produit.
 */
async function installedLayout({
  version = '9.9.9',
  binary = nativeBinaryPath(),
  nativeVersion,
  ephemeral = false,
} = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'striart-native-layout-'));
  const pkgDir = path.join(root, 'node_modules', ...host.packageName.split('/'));
  const binaryDest = path.join(pkgDir, ...host.binaryPath.split('/'));
  await mkdir(path.dirname(binaryDest), { recursive: true });
  await copyFile(binary, binaryDest);
  await writeFile(
    path.join(pkgDir, 'package.json'),
    JSON.stringify({ name: host.packageName, version }),
  );
  await writeFile(
    path.join(root, 'package.json'),
    JSON.stringify({ name: '@jumsay/striart', version }),
  );
  const sha256 = await sha256File(binaryDest);
  const size = (await readFile(binaryDest)).length;
  const manifest = {
    schemaVersion: 1,
    protocol: 1,
    version,
    nativeVersion: nativeVersion ?? (await readNativeCrateVersion()),
    ...(ephemeral ? { ephemeral: true } : {}),
    binaries: {
      [host.key]: { package: host.packageName, path: host.binaryPath, sha256, size },
    },
  };
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  await writeFile(path.join(root, NATIVE_MANIFEST_FILE), manifestBytes);
  const pair = minisign.generateKeyPair();
  await mkdir(path.join(root, 'native', 'keys'), { recursive: true });
  await writeFile(path.join(root, 'native', 'keys', 'minisign.pub'), pair.publicKey);
  const { signature, keyId } = minisign.sign(
    manifestBytes,
    pair.secret,
    pair.publicKey,
    NATIVE_MANIFEST_FILE,
  );
  await writeFile(
    path.join(root, NATIVE_SIGNATURE_FILE),
    JSON.stringify({ scheme: 'minisign', keyId, signature }),
  );
  return {
    root,
    binaryDest,
    keyId,
    // Les archives de test sont signées d'une clé jetable : sa confiance est
    // déclarée EXPLICITEMENT (comme le ferait native.trustedKeyIds), jamais
    // implicite.
    options: {
      env: {},
      packageRoot: root,
      resolvePackageDir: () => pkgDir,
      trustedKeyIds: [keyId],
    },
    pkgDir,
    cleanup: () => rm(root, { recursive: true, force: true, maxRetries: 3 }),
  };
}

describe('résolution du binaire natif', () => {
  const layouts = [];
  afterEach(async () => {
    while (layouts.length) await layouts.pop().cleanup();
    delete process.env.STRIART_PROTOCOL_FIXTURE;
    resetNativeBinaryCache();
  });

  beforeAll(() => {
    expect(host, `plateforme ${process.platform}-${process.arch} non publiée`).not.toBeNull();
  });

  it('checkout du dépôt : build de dev, poignée de main conforme', async () => {
    const binary = await resolveNativeBinary({ env: {}, packageRoot: REPO_ROOT });
    expect(binary.source).toBe('dev-build');
    expect(binary.path).toBe(nativeBinaryPath());
    expect(binary.protocol).toBe(1);
    expect(binary.platform).toBe(host.key);
    expect(binary.verification.status).toBe('dev-build');
    expect(binary.verification.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('checkout sans build : NATIVE_UNAVAILABLE avec la commande de construction', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'striart-native-nobuild-'));
    layouts.push({ cleanup: () => rm(root, { recursive: true, force: true }) });
    await mkdir(path.join(root, 'native'), { recursive: true });
    await writeFile(path.join(root, 'native', 'Cargo.toml'), '[workspace]\n');
    const error = await expectStriartError(
      resolveNativeBinary({ env: {}, packageRoot: root }),
      'NATIVE_UNAVAILABLE',
      'DEV_BUILD_MISSING',
    );
    expect(error.hint).toBe('npm run native:build');
  });

  it('STRIART_NATIVE_BIN : chemin absolu exigé, fichier existant, source « explicit »', async () => {
    await expectStriartError(
      resolveNativeBinary({ env: { STRIART_NATIVE_BIN: 'relative/striart-native' } }),
      'NATIVE_UNAVAILABLE',
      'ENV_NOT_ABSOLUTE',
    );
    await expectStriartError(
      resolveNativeBinary({ env: { STRIART_NATIVE_BIN: path.join(os.tmpdir(), 'nope-native') } }),
      'NATIVE_UNAVAILABLE',
      'ENV_MISSING',
    );
    const binary = await resolveNativeBinary({ env: { STRIART_NATIVE_BIN: nativeBinaryPath() } });
    expect(binary.source).toBe('env');
    expect(binary.verification.status).toBe('explicit');
  });

  it('paquet installé : manifeste signé + empreinte vérifiés', async () => {
    const layout = await installedLayout();
    layouts.push(layout);
    const binary = await resolveNativeBinary(layout.options);
    expect(binary.source).toBe('package');
    expect(binary.packageName).toBe(host.packageName);
    expect(binary.verification).toMatchObject({
      status: 'verified',
      scheme: 'minisign',
      keyId: layout.keyId,
    });
  });

  it('paquet signé d’une clé INCONNUE du code et de la config : KEY_NOT_TRUSTED (S-I5)', async () => {
    const layout = await installedLayout();
    layouts.push(layout);
    // Même archive, mais sans confiance déclarée : un paquet qui embarque sa
    // propre clé ne se vérifie plus lui-même.
    const error = await expectStriartError(
      resolveNativeBinary({ ...layout.options, trustedKeyIds: [] }),
      'NATIVE_INTEGRITY_FAILED',
      'KEY_NOT_TRUSTED',
    );
    expect(error.details.keyId).toBe(layout.keyId);
  });

  it('config utilisateur native.trustedKeyIds : la clé déclarée est acceptée, une clé invalide ignorée', async () => {
    const layout = await installedLayout();
    layouts.push(layout);
    const home = await mkdtemp(path.join(os.tmpdir(), 'striart-native-uc-'));
    layouts.push({ cleanup: () => rm(home, { recursive: true, force: true }) });
    const withoutOverride = { ...layout.options };
    delete withoutOverride.trustedKeyIds;
    const env = { STRIART_CONFIG_HOME: home };
    await writeFile(
      path.join(home, 'config.json'),
      JSON.stringify({ native: { trustedKeyIds: [layout.keyId] } }),
      { mode: 0o600 },
    );
    const trusted = await resolveNativeBinary({ ...withoutOverride, env });
    expect(trusted.verification.keyId).toBe(layout.keyId);
    // Config invalide : aucune confiance supplémentaire (jamais un élargissement).
    await writeFile(
      path.join(home, 'config.json'),
      JSON.stringify({ native: { trustedKeyIds: ['pas-un-keyid'] } }),
      { mode: 0o600 },
    );
    await expectStriartError(
      resolveNativeBinary({ ...withoutOverride, env }),
      'NATIVE_INTEGRITY_FAILED',
      'KEY_NOT_TRUSTED',
    );
  });

  it('manifeste signé d’une clé JETABLE : EPHEMERAL_SIGNATURE, même clé déclarée de confiance (N-I1)', async () => {
    const layout = await installedLayout({ ephemeral: true });
    layouts.push(layout);
    await expectStriartError(
      resolveNativeBinary(layout.options),
      'NATIVE_INTEGRITY_FAILED',
      'EPHEMERAL_SIGNATURE',
    );
    // Seul l'auto-contrôle de pack.ts (--dry-run) l'accepte, explicitement.
    const binary = await resolveNativeBinary({ ...layout.options, allowEphemeral: true });
    expect(binary.verification.status).toBe('verified');
  });

  it('version du crate déclarée par le manifeste ≠ binaire exécuté : NATIVE_VERSION_MISMATCH (M19)', async () => {
    const layout = await installedLayout({ nativeVersion: '7.7.7' });
    layouts.push(layout);
    await expectStriartError(
      resolveNativeBinary(layout.options),
      'NATIVE_INTEGRITY_FAILED',
      'NATIVE_VERSION_MISMATCH',
    );
  });

  it('binaire altéré (un octet) : NATIVE_INTEGRITY_FAILED, jamais exécuté', async () => {
    const layout = await installedLayout();
    layouts.push(layout);
    const bytes = await readFile(layout.binaryDest);
    bytes[bytes.length - 1] ^= 0xff;
    await writeFile(layout.binaryDest, bytes);
    const error = await expectStriartError(
      resolveNativeBinary(layout.options),
      'NATIVE_INTEGRITY_FAILED',
      'DIGEST_MISMATCH',
    );
    expect(error.kind).toBe('refusal');
  });

  it('manifeste modifié après signature : SIGNATURE_INVALID', async () => {
    const layout = await installedLayout();
    layouts.push(layout);
    const file = path.join(layout.root, NATIVE_MANIFEST_FILE);
    const text = await readFile(file, 'utf8');
    await writeFile(file, text.replace('"protocol": 1', '"protocol": 1 '));
    await expectStriartError(
      resolveNativeBinary(layout.options),
      'NATIVE_INTEGRITY_FAILED',
      'SIGNATURE_INVALID',
    );
  });

  it('clé publique remplacée : SIGNATURE_INVALID', async () => {
    const layout = await installedLayout();
    layouts.push(layout);
    await writeFile(
      path.join(layout.root, 'native', 'keys', 'minisign.pub'),
      minisign.generateKeyPair().publicKey,
    );
    await expectStriartError(
      resolveNativeBinary(layout.options),
      'NATIVE_INTEGRITY_FAILED',
      'SIGNATURE_INVALID',
    );
  });

  it('schéma de signature inconnu : refusé (jamais « non vérifié »)', async () => {
    const layout = await installedLayout();
    layouts.push(layout);
    const file = path.join(layout.root, NATIVE_SIGNATURE_FILE);
    const sig = JSON.parse(await readFile(file, 'utf8'));
    await writeFile(file, JSON.stringify({ ...sig, scheme: 'none' }));
    await expectStriartError(
      resolveNativeBinary(layout.options),
      'NATIVE_INTEGRITY_FAILED',
      'SIGNATURE_UNREADABLE',
    );
  });

  it('manifeste absent du paquet publié : MANIFEST_MISSING', async () => {
    const layout = await installedLayout();
    layouts.push(layout);
    await rm(path.join(layout.root, NATIVE_MANIFEST_FILE));
    await expectStriartError(
      resolveNativeBinary(layout.options),
      'NATIVE_INTEGRITY_FAILED',
      'MANIFEST_MISSING',
    );
  });

  it('paquet de plateforme non installé : NATIVE_UNAVAILABLE PACKAGE_MISSING', async () => {
    const layout = await installedLayout();
    layouts.push(layout);
    await expectStriartError(
      resolveNativeBinary({ ...layout.options, resolvePackageDir: () => null }),
      'NATIVE_UNAVAILABLE',
      'PACKAGE_MISSING',
    );
  });

  it('paquet de plateforme d’une autre version : PACKAGE_VERSION_MISMATCH', async () => {
    const layout = await installedLayout();
    layouts.push(layout);
    const pkg = path.join(path.dirname(path.dirname(layout.binaryDest)), 'package.json');
    await writeFile(pkg, JSON.stringify({ name: host.packageName, version: '1.0.0' }));
    await expectStriartError(
      resolveNativeBinary(layout.options),
      'NATIVE_INTEGRITY_FAILED',
      'PACKAGE_VERSION_MISMATCH',
    );
  });

  it('plateforme non publiée : NATIVE_UNAVAILABLE PLATFORM_UNSUPPORTED', async () => {
    const layout = await installedLayout();
    layouts.push(layout);
    await expectStriartError(
      resolveNativeBinary({ ...layout.options, platform: 'freebsd', arch: 'x64' }),
      'NATIVE_UNAVAILABLE',
      'PLATFORM_UNSUPPORTED',
    );
  });
});

describe('protocole : validation positive des réponses', () => {
  const fixture = () => ({ env: { STRIART_NATIVE_BIN: nativeFixturePath('protocol-fixture') } });
  afterEach(() => {
    delete process.env.STRIART_PROTOCOL_FIXTURE;
    resetNativeBinaryCache();
  });

  it.each([
    ['stdout-garbage', 'STDOUT_NOT_JSON'],
    ['stdout-multiline', 'STDOUT_SHAPE'],
    ['protocol-2', 'PROTOCOL_MISMATCH'],
    ['wrong-platform', 'PLATFORM_MISMATCH'],
    ['stderr-garbage', 'STDERR_INVALID'],
  ])('%s → NATIVE_PROTOCOL_ERROR (%s)', async (mode, reason) => {
    process.env.STRIART_PROTOCOL_FIXTURE = mode;
    await expectStriartError(resolveNativeBinary(fixture()), 'NATIVE_PROTOCOL_ERROR', reason);
  });

  it('erreur JSON conforme → NATIVE_COMMAND_FAILED avec le code natif', async () => {
    process.env.STRIART_PROTOCOL_FIXTURE = 'native-error';
    const error = await expectStriartError(
      resolveNativeBinary(fixture()),
      'NATIVE_COMMAND_FAILED',
      'NATIVE_ERROR',
    );
    expect(error.details.nativeCode).toBe('SNAPSHOT_FAILED');
  });

  it('proc info de forme invalide → NATIVE_PROTOCOL_ERROR, jamais une table vide', async () => {
    process.env.STRIART_PROTOCOL_FIXTURE = 'ok-version-bad-info';
    process.env.STRIART_NATIVE_BIN = nativeFixturePath('protocol-fixture');
    try {
      await expectStriartError(
        nativeProcessInfo([process.pid]),
        'NATIVE_PROTOCOL_ERROR',
        'PROC_INFO_INVALID',
      );
    } finally {
      delete process.env.STRIART_NATIVE_BIN;
    }
  });

  it('le binaire du process est mis en cache, et revérifié s’il change sur disque', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'striart-native-cache-'));
    const copy = path.join(dir, path.basename(nativeBinaryPath()));
    await copyFile(nativeBinaryPath(), copy);
    process.env.STRIART_NATIVE_BIN = copy;
    try {
      const a = await getNativeBinary();
      expect(await getNativeBinary()).toBe(a);
      const later = new Date(Date.now() + 60_000);
      await utimes(copy, later, later);
      const b = await getNativeBinary();
      expect(b).not.toBe(a);
      expect(b.verification.sha256).toBe(a.verification.sha256);
    } finally {
      delete process.env.STRIART_NATIVE_BIN;
      await rm(dir, { recursive: true, force: true, maxRetries: 3 });
    }
  });
});

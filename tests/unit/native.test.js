// Validation positive des documents du binaire natif (fonctions pures de
// src/native.ts) — sans binaire ni disque.
import { describe, expect, it } from 'vitest';
import {
  NATIVE_PLATFORMS,
  isSafePackagePath,
  nativePlatform,
  parseJobReport,
  parseNativeErrorLine,
  assertJobComplete,
  parseNativeManifest,
  parseNativeSignatureFile,
  parseProcInfoDocument,
  parseTreeKillDocument,
} from '../../src/native.ts';

const SHA = 'a'.repeat(64);
const manifest = (binaries) => ({
  schemaVersion: 1,
  protocol: 1,
  version: '0.11.0',
  nativeVersion: '0.1.0',
  binaries,
});
const entry = (key) => {
  const p = NATIVE_PLATFORMS.find((x) => x.key === key);
  return { package: p.packageName, path: p.binaryPath, sha256: SHA, size: 10 };
};

describe('plateformes publiées', () => {
  it('six plateformes, Linux en musl statique, nommage des paquets', () => {
    expect(NATIVE_PLATFORMS.map((p) => p.key)).toEqual([
      'win32-x64',
      'win32-arm64',
      'darwin-x64',
      'darwin-arm64',
      'linux-x64',
      'linux-arm64',
    ]);
    expect(nativePlatform('linux', 'arm64')).toMatchObject({
      rustTarget: 'aarch64-unknown-linux-musl',
      packageName: '@jumsay/striart-native-linux-arm64',
      binaryPath: 'bin/striart-native',
    });
    expect(nativePlatform('win32', 'x64').binaryPath).toBe('bin/striart-native.exe');
    expect(nativePlatform('freebsd', 'x64')).toBeNull();
    expect(nativePlatform('linux', 'ia32')).toBeNull();
  });
});

describe('isSafePackagePath', () => {
  it('relatif POSIX seulement', () => {
    expect(isSafePackagePath('bin/striart-native')).toBe(true);
    for (const bad of ['', '/bin/x', '../x', 'bin/../x', 'bin\\x', 'C:/x', 'bin//x', './x']) {
      expect(isSafePackagePath(bad), bad).toBe(false);
    }
  });
});

describe('parseNativeManifest', () => {
  it('accepte un manifeste conforme', () => {
    const parsed = parseNativeManifest(manifest({ 'linux-x64': entry('linux-x64') }));
    expect(parsed.binaries['linux-x64'].sha256).toBe(SHA);
    expect(parsed.nativeVersion).toBe('0.1.0');
    expect(parsed.ephemeral).toBeUndefined();
  });

  it('conserve le marqueur ephemeral d’un manifeste signé d’une clé jetable', () => {
    const parsed = parseNativeManifest({
      ...manifest({ 'linux-x64': entry('linux-x64') }),
      ephemeral: true,
    });
    expect(parsed.ephemeral).toBe(true);
  });

  it.each([
    ['schéma inconnu', { ...manifest({ 'linux-x64': entry('linux-x64') }), schemaVersion: 2 }],
    ['sans binaire', manifest({})],
    ['plateforme inconnue', manifest({ 'linux-ia32': entry('linux-x64') })],
    ['paquet d’une autre plateforme', manifest({ 'linux-x64': entry('linux-arm64') })],
    ['chemin évadé', manifest({ 'linux-x64': { ...entry('linux-x64'), path: '../../evil' } })],
    ['empreinte mal formée', manifest({ 'linux-x64': { ...entry('linux-x64'), sha256: 'ABC' } })],
    ['taille nulle', manifest({ 'linux-x64': { ...entry('linux-x64'), size: 0 } })],
    ['version invalide', { ...manifest({ 'linux-x64': entry('linux-x64') }), version: 'latest' }],
    [
      'sans nativeVersion',
      (({ nativeVersion: _n, ...rest }) => rest)(manifest({ 'linux-x64': entry('linux-x64') })),
    ],
    [
      'nativeVersion invalide',
      { ...manifest({ 'linux-x64': entry('linux-x64') }), nativeVersion: 'x' },
    ],
    [
      'marqueur ephemeral invalide',
      { ...manifest({ 'linux-x64': entry('linux-x64') }), ephemeral: false },
    ],
    ['pas un objet', []],
  ])('refuse : %s', (_label, raw) => {
    expect(() => parseNativeManifest(raw)).toThrow();
  });
});

describe('parseNativeSignatureFile', () => {
  it('schéma enregistré obligatoire', () => {
    const ok = { scheme: 'minisign', keyId: 'BA72381DD088AC9C', signature: 'x' };
    expect(parseNativeSignatureFile(ok)).toEqual(ok);
    expect(() => parseNativeSignatureFile({ ...ok, scheme: 'none' })).toThrow(/unknown/);
    expect(() => parseNativeSignatureFile({ ...ok, keyId: 'a b' })).toThrow();
    expect(() => parseNativeSignatureFile({ ...ok, signature: '' })).toThrow();
  });
});

describe('parseProcInfoDocument', () => {
  const row = { pid: 4, ppid: null, name: 'x', commandLine: null, startTimeMs: 1 };
  it('accepte les champs nuls permis', () => {
    expect(parseProcInfoDocument({ processes: [row], missing: [7] })).toEqual([row]);
  });
  it.each([
    [{ processes: [{ ...row, pid: 0 }], missing: [] }],
    [{ processes: [{ ...row, pid: '4' }], missing: [] }],
    [{ processes: [{ ...row, startTimeMs: -1 }], missing: [] }],
    [{ processes: [{ ...row, name: null }], missing: [] }],
    [{ processes: [row], missing: ['7'] }],
    [{ processes: [row] }],
    [null],
  ])('refuse %j', (raw) => {
    expect(() => parseProcInfoDocument(raw)).toThrow();
  });
});

describe('parseTreeKillDocument', () => {
  it('accepte, puis refuse un état de racine inconnu', () => {
    const doc = {
      root: 10,
      rootState: 'dead',
      killed: [{ pid: 11, startTimeMs: 5 }],
      failed: [{ pid: 12, reason: 'access denied' }],
      survivors: [],
      complete: true,
      rounds: 1,
    };
    expect(parseTreeKillDocument(doc).killed).toEqual([{ pid: 11, startTimeMs: 5 }]);
    expect(parseTreeKillDocument(doc)).toMatchObject({ survivors: [], complete: true });
    expect(() => parseTreeKillDocument({ ...doc, rootState: 'zombie' })).toThrow();
    expect(() => parseTreeKillDocument({ ...doc, killed: [{ pid: -1 }] })).toThrow();
  });

  it('survivors / complete EXIGÉS et cohérents (N-I6) : jamais « éteint » par défaut', () => {
    const doc = {
      root: 10,
      rootState: 'alive',
      killed: [],
      failed: [{ pid: 12, reason: 'access denied' }],
      survivors: [{ pid: 12, startTimeMs: 5 }],
      complete: false,
      rounds: 1,
    };
    expect(parseTreeKillDocument(doc)).toMatchObject({
      complete: false,
      survivors: [{ pid: 12, startTimeMs: 5 }],
    });
    // Binaire périmé : champs absents → refus, pas « complete » supposé.
    const stale = { ...doc };
    delete stale.survivors;
    delete stale.complete;
    expect(() => parseTreeKillDocument(stale)).toThrow(/survivors/);
    // Contradiction interne.
    expect(() => parseTreeKillDocument({ ...doc, complete: true })).toThrow(/contradicts/);
    expect(() => parseTreeKillDocument({ ...doc, survivors: [], complete: false })).toThrow(
      /contradicts/,
    );
  });
});

describe('parseJobReport', () => {
  const report = {
    pid: 7,
    exitCode: 0,
    signal: null,
    timedOut: false,
    interrupted: null,
    orphansKilled: 1,
    orphanPids: [8],
    killedOnTimeout: 0,
    killedPids: [],
    survivorPids: [],
    complete: true,
    graceMs: 500,
    durationMs: 12,
  };
  it('accepte un rapport cohérent', () => {
    expect(parseJobReport(report)).toEqual(report);
  });
  it('survivorPids / complete exigés et cohérents (N-I6)', () => {
    const partial = { ...report };
    delete partial.complete;
    expect(() => parseJobReport(partial)).toThrow();
    expect(() => parseJobReport({ ...report, survivorPids: [9] })).toThrow();
    expect(parseJobReport({ ...report, survivorPids: [9], complete: false })).toMatchObject({
      complete: false,
      survivorPids: [9],
    });
  });
  it('assertJobComplete : JOB_TERMINATE_INCOMPLETE tant que des process survivent', () => {
    expect(() => assertJobComplete({ complete: true, survivorPids: [] })).not.toThrow();
    expect(() => assertJobComplete({ complete: false, survivorPids: [9, 10] })).toThrow(
      expect.objectContaining({
        code: 'JOB_TERMINATE_INCOMPLETE',
        details: { survivors: [9, 10] },
      }),
    );
  });
  it('refuse un compte qui contredit sa liste, ou un champ manquant', () => {
    expect(() => parseJobReport({ ...report, orphansKilled: 2 })).toThrow();
    expect(() => parseJobReport({ ...report, timedOut: 'no' })).toThrow();
    const partial = { ...report };
    delete partial.durationMs;
    expect(() => parseJobReport(partial)).toThrow();
  });
});

describe('parseNativeErrorLine', () => {
  it('dernière ligne de stderr seulement, code au format stable', () => {
    expect(
      parseNativeErrorLine('child noise\n{"error":{"code":"SPAWN_FAILED","message":"m"}}\n'),
    ).toEqual({ code: 'SPAWN_FAILED', message: 'm' });
    expect(parseNativeErrorLine('panicked at x')).toBeNull();
    expect(parseNativeErrorLine('{"error":{"code":"lower","message":"m"}}')).toBeNull();
    expect(parseNativeErrorLine('')).toBeNull();
  });
});

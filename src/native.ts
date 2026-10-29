/**
 * Accès au binaire natif `striart-native` (crate native/, Rust) : résolution,
 * vérification d'intégrité, exécution et validation de ses réponses.
 *
 * Résolution, dans cet ordre — la source retenue est toujours visible
 * (`striart doctor`), jamais un basculement muet :
 *  1. `STRIART_NATIVE_BIN` : chemin ABSOLU désigné explicitement (binaire
 *     construit à la main, plateforme hors liste). Choix assumé de
 *     l'utilisateur : son intégrité n'est pas vérifiée, doctor le signale ;
 *  2. build de développement `native/target/release/striart-native` d'un
 *     checkout du dépôt (présence de `native/Cargo.toml`) — `npm run
 *     native:build` ;
 *  3. paquet de plateforme `@jumsay/striart-native-<os>-<cpu>` (dépendance
 *     optionnelle du paquet publié, patron esbuild), vérifié contre le
 *     manifeste SIGNÉ embarqué dans le paquet principal : signature du
 *     manifeste (schéma nommé, voir native-signature.ts), puis SHA-256 et
 *     taille du binaire.
 *
 * Ancre de confiance : la signature du manifeste prouve que le manifeste, la
 * clé publique du paquet et les binaires sont COHÉRENTS ; elle ne prouve pas
 * leur provenance — un paquet principal malveillant embarquerait sa propre
 * clé. Le `keyId` signataire est donc comparé à une liste de clés de
 * confiance qui vit HORS du paquet vérifié : `PINNED_NATIVE_KEY_IDS` (constante
 * du code publié, elle-même livrée par npm — la provenance du paquet
 * principal reste l'affaire du registre : scope `@jumsay`, attestation de
 * provenance) et `native.trustedKeyIds` de la config UTILISATEUR (jamais celle
 * du dépôt). Clé inconnue → `NATIVE_INTEGRITY_FAILED` (KEY_NOT_TRUSTED). Un
 * manifeste marqué `ephemeral` (clé jetable de vérification locale) est
 * refusé à l'exécution (EPHEMERAL_SIGNATURE).
 *
 * Aucune source utilisable → `NATIVE_UNAVAILABLE` ; manifeste absent,
 * signature invalide, empreinte divergente → `NATIVE_INTEGRITY_FAILED`
 * (fail closed : le binaire n'est jamais exécuté).
 *
 * Exécution : argv uniquement (`shell: false`), délai borné, stdout = un
 * document JSON validé positivement, stderr = une ligne d'erreur JSON
 * (`{"error":{"code","message"}}`). Le protocole est versionné : un binaire
 * d'une autre version de protocole est refusé (`NATIVE_PROTOCOL_ERROR`).
 *
 * Coût : résolution + vérification + poignée de main (`version`) une fois
 * par process ; chaque appel revérifie seulement l'identité disque du
 * binaire (taille, date, inode) et refait la vérification complète si elle
 * a changé.
 */
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execa } from 'execa';
import type { ResultPromise } from 'execa';
import { StriartError } from './errors.ts';
import { getSignatureScheme, publicKeyPath, signatureSchemeNames } from './native-signature.ts';
import {
  PTY_MIN_CLIENT_QUEUE_BYTES,
  ptyMaxInitialBytes,
  ptyMinClientQueueBytes,
} from './pty-limits.ts';

/** Version du protocole parlé par ce paquet (voir native/striart-native/src/protocol.rs). */
export const NATIVE_PROTOCOL_VERSION = 1;

/** Variable d'environnement qui désigne explicitement le binaire. */
export const NATIVE_BIN_ENV = 'STRIART_NATIVE_BIN';

export const NATIVE_MANIFEST_FILE = 'native-manifest.json';
export const NATIVE_SIGNATURE_FILE = 'native-manifest.sig.json';
export const NATIVE_MANIFEST_SCHEMA = 1;

/**
 * Identifiants des clés de signature de confiance, épinglés DANS LE CODE (donc
 * hors du paquet de données vérifié : manifeste, signature, clé publique,
 * binaires). Format de `minisign` : 16 chiffres hexadécimaux majuscules.
 * Rotation = nouvelle valeur ici, dans le même commit que
 * `native/keys/minisign.pub` ; l'ancienne clé reste listée tant que des
 * releases qu'elle a signées sont supportées.
 */
export const PINNED_NATIVE_KEY_IDS: readonly string[] = Object.freeze(['BA72381DD088AC9C']);

/** Forme d'un identifiant de clé (celle de `formatKeyId`). */
export const NATIVE_KEY_ID_RE = /^[0-9A-F]{16}$/;

export interface NativePlatform {
  /** Clé `<process.platform>-<process.arch>`. */
  key: string;
  os: 'win32' | 'darwin' | 'linux';
  cpu: 'x64' | 'arm64';
  /** Cible Rust construite par la CI (Linux : musl statique, voir CONTRIBUTING.md). */
  rustTarget: string;
  packageName: string;
  /** Chemin du binaire dans son paquet. */
  binaryPath: string;
}

const PACKAGE_PREFIX = '@jumsay/striart-native-';

function platformEntry(
  os: NativePlatform['os'],
  cpu: NativePlatform['cpu'],
  rustTarget: string,
): NativePlatform {
  const key = `${os}-${cpu}`;
  return {
    key,
    os,
    cpu,
    rustTarget,
    packageName: `${PACKAGE_PREFIX}${key}`,
    binaryPath: os === 'win32' ? 'bin/striart-native.exe' : 'bin/striart-native',
  };
}

/**
 * Plateformes publiées. Linux : binaires musl liés statiquement — un seul
 * binaire par CPU tourne aussi bien sur glibc que sur musl (Alpine), d'où
 * l'absence de variante libc.
 */
export const NATIVE_PLATFORMS: readonly NativePlatform[] = Object.freeze([
  platformEntry('win32', 'x64', 'x86_64-pc-windows-msvc'),
  platformEntry('win32', 'arm64', 'aarch64-pc-windows-msvc'),
  platformEntry('darwin', 'x64', 'x86_64-apple-darwin'),
  platformEntry('darwin', 'arm64', 'aarch64-apple-darwin'),
  platformEntry('linux', 'x64', 'x86_64-unknown-linux-musl'),
  platformEntry('linux', 'arm64', 'aarch64-unknown-linux-musl'),
]);

export function nativePlatform(
  platform: string = process.platform,
  arch: string = process.arch,
): NativePlatform | null {
  return NATIVE_PLATFORMS.find((p) => p.key === `${platform}-${arch}`) ?? null;
}

/** Noms Rust (`std::env::consts`) d'une plateforme Node. */
const RUST_OS: Record<string, string> = { win32: 'windows', darwin: 'macos', linux: 'linux' };
const RUST_ARCH: Record<string, string> = { x64: 'x86_64', arm64: 'aarch64' };

// ── Manifeste ────────────────────────────────────────────────────────────

export interface NativeManifestEntry {
  package: string;
  path: string;
  sha256: string;
  size: number;
}

export interface NativeManifest {
  schemaVersion: number;
  protocol: number;
  /** Version commune du paquet principal et des paquets de plateforme. */
  version: string;
  /**
   * Version du crate `striart-native` (Cargo.toml) dont sont issus les
   * binaires. La poignée de main `version` du binaire installé doit la
   * rapporter à l'identique : lie les octets exécutés à ce que le mainteneur a
   * déclaré avoir construit.
   */
  nativeVersion: string;
  /**
   * Présent (`true`) quand le manifeste a été signé par une clé JETABLE
   * (`--ephemeral-signing-key`, vérification locale) : l'archive se vérifie
   * elle-même sans garantie de provenance. Refusé à l'exécution.
   */
  ephemeral?: true;
  binaries: Record<string, NativeManifestEntry>;
}

export interface NativeSignatureFile {
  scheme: string;
  keyId: string;
  signature: string;
}

const SHA256_RE = /^[0-9a-f]{64}$/;
const SEMVER_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Chemin relatif sûr dans un paquet (ni absolu, ni `..`, séparateurs POSIX). */
export function isSafePackagePath(value: string): boolean {
  if (!value || value.includes('\\') || value.startsWith('/') || /^[A-Za-z]:/.test(value)) {
    return false;
  }
  return value.split('/').every((part) => part !== '' && part !== '.' && part !== '..');
}

/** Validation positive du manifeste. Lève (Error) avec la raison. */
export function parseNativeManifest(raw: unknown): NativeManifest {
  if (!isRecord(raw)) throw new Error('manifest is not an object');
  const { schemaVersion, protocol, version, nativeVersion, binaries, ephemeral } = raw;
  if (schemaVersion !== NATIVE_MANIFEST_SCHEMA) throw new Error('unsupported manifest schema');
  if (!Number.isSafeInteger(protocol) || (protocol as number) < 1) {
    throw new Error('invalid protocol');
  }
  if (typeof version !== 'string' || !SEMVER_RE.test(version)) throw new Error('invalid version');
  if (typeof nativeVersion !== 'string' || !SEMVER_RE.test(nativeVersion)) {
    throw new Error('invalid nativeVersion');
  }
  if (ephemeral !== undefined && ephemeral !== true) throw new Error('invalid ephemeral marker');
  if (!isRecord(binaries) || Object.keys(binaries).length === 0) {
    throw new Error('no binaries');
  }
  const parsed: Record<string, NativeManifestEntry> = {};
  for (const [key, entry] of Object.entries(binaries)) {
    const platform = NATIVE_PLATFORMS.find((p) => p.key === key);
    if (!platform) throw new Error(`unknown platform ${key}`);
    if (!isRecord(entry)) throw new Error(`${key}: entry is not an object`);
    if (entry.package !== platform.packageName) throw new Error(`${key}: unexpected package`);
    if (typeof entry.path !== 'string' || !isSafePackagePath(entry.path)) {
      throw new Error(`${key}: unsafe path`);
    }
    if (typeof entry.sha256 !== 'string' || !SHA256_RE.test(entry.sha256)) {
      throw new Error(`${key}: invalid sha256`);
    }
    if (!Number.isSafeInteger(entry.size) || (entry.size as number) <= 0) {
      throw new Error(`${key}: invalid size`);
    }
    parsed[key] = {
      package: entry.package,
      path: entry.path,
      sha256: entry.sha256,
      size: entry.size as number,
    };
  }
  return {
    schemaVersion: NATIVE_MANIFEST_SCHEMA,
    protocol: protocol as number,
    version,
    nativeVersion,
    ...(ephemeral === true ? { ephemeral: true as const } : {}),
    binaries: parsed,
  };
}

export function parseNativeSignatureFile(raw: unknown): NativeSignatureFile {
  if (!isRecord(raw)) throw new Error('signature file is not an object');
  const { scheme, keyId, signature } = raw;
  if (typeof scheme !== 'string' || !getSignatureScheme(scheme)) {
    throw new Error(
      `unknown signature scheme ${JSON.stringify(scheme)} (known: ${signatureSchemeNames().join(', ')})`,
    );
  }
  if (typeof keyId !== 'string' || !/^[0-9A-Za-z._:-]{1,128}$/.test(keyId)) {
    throw new Error('invalid key id');
  }
  if (typeof signature !== 'string' || signature.length === 0 || signature.length > 65_536) {
    throw new Error('invalid signature');
  }
  return { scheme, keyId, signature };
}

// ── Résolution ───────────────────────────────────────────────────────────

export type NativeSource = 'env' | 'dev-build' | 'package';

export interface NativeVerification {
  /**
   * - `verified`  : signature du manifeste ET empreinte du binaire vérifiées ;
   * - `explicit`  : binaire désigné par STRIART_NATIVE_BIN, non vérifié ;
   * - `dev-build` : build local d'un checkout, non signé par construction.
   */
  status: 'verified' | 'explicit' | 'dev-build';
  scheme: string | null;
  keyId: string | null;
  sha256: string;
}

export interface NativeBinary {
  path: string;
  source: NativeSource;
  platform: string;
  packageName: string | null;
  /** Version rapportée par le binaire (`version`). */
  version: string;
  protocol: number;
  /** Commandes annoncées par `version` (vide pour un binaire qui ne les liste pas). */
  commands: string[];
  verification: NativeVerification;
}

interface DiskIdentity {
  size: number;
  mtimeMs: number;
  ino: number;
}

export interface ResolveNativeOptions {
  env?: NodeJS.ProcessEnv;
  /** Racine du paquet Striart (défaut : celle de ce module). */
  packageRoot?: string;
  platform?: string;
  arch?: string;
  /** Dossier d'un paquet installé, ou null (défaut : résolution Node depuis packageRoot). */
  resolvePackageDir?: (packageName: string) => string | null;
  /**
   * Clés de confiance SUPPLÉMENTAIRES (en plus de `PINNED_NATIVE_KEY_IDS`).
   * Absent : lues dans la config utilisateur (`native.trustedKeyIds`).
   * Fourni (même vide) : la config utilisateur n'est PAS lue — appelants
   * déterministes (scripts/pack.ts, tests).
   */
  trustedKeyIds?: readonly string[];
  /**
   * Accepte un manifeste marqué `ephemeral`. Réservé à l'auto-contrôle de
   * scripts/pack.ts (--dry-run) : jamais au chargement du paquet installé.
   */
  allowEphemeral?: boolean;
}

const DEFAULT_PACKAGE_ROOT = fileURLToPath(new URL('..', import.meta.url));

function executableName(platform: string): string {
  return platform === 'win32' ? 'striart-native.exe' : 'striart-native';
}

function unavailable(
  message: string,
  reason: string,
  details: Record<string, unknown>,
  hint: string,
): StriartError {
  return new StriartError(message, {
    code: 'NATIVE_UNAVAILABLE',
    details: { reason, ...details },
    hint,
  });
}

function integrityFailure(
  message: string,
  reason: string,
  details: Record<string, unknown>,
): StriartError {
  return new StriartError(message, {
    code: 'NATIVE_INTEGRITY_FAILED',
    details: { reason, ...details },
    hint: 'réinstaller Striart (npm install), puis striart doctor',
  });
}

async function fileIdentity(file: string): Promise<DiskIdentity | null> {
  const info = await stat(file).catch(() => null);
  if (!info || !info.isFile()) return null;
  return { size: info.size, mtimeMs: info.mtimeMs, ino: info.ino };
}

export async function sha256File(file: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

function defaultPackageResolver(packageRoot: string) {
  const require = createRequire(path.join(packageRoot, 'package.json'));
  return (packageName: string): string | null => {
    try {
      return path.dirname(require.resolve(`${packageName}/package.json`));
    } catch {
      // Dépendance optionnelle non installée (--omit=optional, mauvaise
      // plateforme d'installation) : signalé par l'appelant, jamais ignoré.
      return null;
    }
  };
}

/**
 * Clés de confiance de la config utilisateur (`native.trustedKeyIds`). Une
 * config absente donne la liste vide ; une config ILLISIBLE ou invalide aussi
 * — elle n'élargit alors rien (fail closed) et `striart doctor` la signale
 * (USER_CONFIG_INVALID / USER_CONFIG_UNSAFE).
 */
async function userTrustedKeyIds(env: NodeJS.ProcessEnv): Promise<readonly string[]> {
  try {
    const { readUserConfig } = await import('./user-config.ts');
    return (await readUserConfig({ env })).native.trustedKeyIds;
  } catch {
    // Voir la doc de la fonction : aucune confiance supplémentaire.
    return [];
  }
}

async function readJson(file: string): Promise<unknown> {
  return JSON.parse(await readFile(file, 'utf8'));
}

export interface Located {
  /** Version du crate déclarée par le manifeste signé (source `package` seulement). */
  nativeVersion?: string;
  path: string;
  source: NativeSource;
  platform: string;
  packageName: string | null;
  verification: NativeVerification;
}

/**
 * Localise et VÉRIFIE le binaire (signature, empreinte) sans l'exécuter —
 * aussi utilisé par scripts/pack.ts pour contrôler l'archive produite, pour
 * chaque plateforme, avant publication.
 */
export async function locateNativeBinary(options: ResolveNativeOptions = {}): Promise<Located> {
  const env = options.env ?? process.env;
  const packageRoot = options.packageRoot ?? DEFAULT_PACKAGE_ROOT;
  const platformName = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const platformKey = `${platformName}-${arch}`;

  const explicit = env[NATIVE_BIN_ENV];
  if (explicit !== undefined && explicit !== '') {
    if (!path.isAbsolute(explicit)) {
      throw unavailable(
        `${NATIVE_BIN_ENV} doit être un chemin absolu.`,
        'ENV_NOT_ABSOLUTE',
        { variable: NATIVE_BIN_ENV },
        `${NATIVE_BIN_ENV}=<chemin absolu de striart-native>`,
      );
    }
    if (!(await fileIdentity(explicit))) {
      throw unavailable(
        `${NATIVE_BIN_ENV} désigne un fichier absent : ${explicit}`,
        'ENV_MISSING',
        { path: explicit, variable: NATIVE_BIN_ENV },
        `vérifier ${NATIVE_BIN_ENV}, ou la retirer pour utiliser le binaire du paquet`,
      );
    }
    return {
      path: explicit,
      source: 'env',
      platform: platformKey,
      packageName: null,
      verification: {
        status: 'explicit',
        scheme: null,
        keyId: null,
        sha256: await sha256File(explicit),
      },
    };
  }

  const cargoManifest = path.join(packageRoot, 'native', 'Cargo.toml');
  const manifestPath = path.join(packageRoot, NATIVE_MANIFEST_FILE);
  const isCheckout = Boolean(await fileIdentity(cargoManifest));
  const hasManifest = Boolean(await fileIdentity(manifestPath));
  if (isCheckout && !hasManifest) {
    const devBuild = path.join(
      packageRoot,
      'native',
      'target',
      'release',
      executableName(platformName),
    );
    if (!(await fileIdentity(devBuild))) {
      throw unavailable(
        `Binaire natif non construit dans ce checkout (${devBuild}).`,
        'DEV_BUILD_MISSING',
        { path: devBuild, platform: platformKey },
        'npm run native:build',
      );
    }
    return {
      path: devBuild,
      source: 'dev-build',
      platform: platformKey,
      packageName: null,
      verification: {
        status: 'dev-build',
        scheme: null,
        keyId: null,
        sha256: await sha256File(devBuild),
      },
    };
  }

  const platform = nativePlatform(platformName, arch);
  if (!platform) {
    throw unavailable(
      `Aucun binaire natif publié pour la plateforme ${platformKey}.`,
      'PLATFORM_UNSUPPORTED',
      { platform: platformKey, supported: NATIVE_PLATFORMS.map((p) => p.key) },
      `construire striart-native (native/) et le désigner par ${NATIVE_BIN_ENV}`,
    );
  }
  if (!hasManifest) {
    throw integrityFailure(
      `Manifeste des binaires natifs absent du paquet (${NATIVE_MANIFEST_FILE}) : empreinte attendue inconnue.`,
      'MANIFEST_MISSING',
      { path: manifestPath },
    );
  }

  // 1. Le manifeste et sa signature.
  const manifestBytes = await readFile(manifestPath);
  let signatureFile: NativeSignatureFile;
  let manifest: NativeManifest;
  try {
    signatureFile = parseNativeSignatureFile(
      await readJson(path.join(packageRoot, NATIVE_SIGNATURE_FILE)),
    );
  } catch (error) {
    throw integrityFailure(
      `Signature du manifeste natif illisible : ${(error as Error).message}.`,
      'SIGNATURE_UNREADABLE',
      { path: path.join(packageRoot, NATIVE_SIGNATURE_FILE) },
    );
  }
  const scheme = getSignatureScheme(signatureFile.scheme);
  if (!scheme) {
    // parseNativeSignatureFile l'a déjà refusé : défense en profondeur.
    throw integrityFailure('Schéma de signature inconnu.', 'SCHEME_UNKNOWN', {
      scheme: signatureFile.scheme,
    });
  }
  const keyFile = path.join(packageRoot, ...publicKeyPath(scheme.name).split('/'));
  let keyId: string;
  try {
    const publicKey = await readFile(keyFile, 'utf8');
    ({ keyId } = scheme.verify(manifestBytes, signatureFile.signature, publicKey));
  } catch (error) {
    throw integrityFailure(
      `Signature du manifeste natif invalide (${scheme.name}) : ${(error as Error).message}.`,
      'SIGNATURE_INVALID',
      { scheme: scheme.name, keyFile },
    );
  }
  // Ancre de confiance HORS du paquet : la clé qui a signé doit être connue
  // du code (épinglée) ou de la config utilisateur. Sans cela, un paquet qui
  // embarque sa propre clé se vérifierait lui-même.
  const trusted = new Set<string>(PINNED_NATIVE_KEY_IDS);
  for (const id of options.trustedKeyIds ?? (await userTrustedKeyIds(env))) trusted.add(id);
  if (!trusted.has(keyId)) {
    throw integrityFailure(
      `Le manifeste natif est signé par la clé ${keyId}, absente des clés de confiance de Striart.`,
      'KEY_NOT_TRUSTED',
      { keyId, trusted: [...trusted] },
    );
  }
  try {
    manifest = parseNativeManifest(JSON.parse(manifestBytes.toString('utf8')));
  } catch (error) {
    throw integrityFailure(
      `Manifeste natif invalide : ${(error as Error).message}.`,
      'MANIFEST_INVALID',
      { path: manifestPath },
    );
  }
  if (manifest.ephemeral === true && options.allowEphemeral !== true) {
    throw integrityFailure(
      'Le manifeste natif est signé par une clé JETABLE (archive de vérification locale) : refusé.',
      'EPHEMERAL_SIGNATURE',
      { keyId },
    );
  }
  const mainVersion = await readJson(path.join(packageRoot, 'package.json'))
    .then((pkg) => (isRecord(pkg) ? pkg.version : null))
    .catch(() => null);
  if (mainVersion !== manifest.version) {
    throw integrityFailure(
      `Manifeste natif d'une autre version (${manifest.version}) que le paquet (${String(mainVersion)}).`,
      'MANIFEST_VERSION_MISMATCH',
      { manifestVersion: manifest.version, packageVersion: mainVersion },
    );
  }

  // 2. Le paquet de plateforme et son binaire.
  const entry = manifest.binaries[platform.key];
  if (!entry) {
    throw unavailable(
      `Le paquet publié ne déclare pas de binaire natif pour ${platform.key}.`,
      'PLATFORM_NOT_PUBLISHED',
      { platform: platform.key, published: Object.keys(manifest.binaries) },
      `construire striart-native (native/) et le désigner par ${NATIVE_BIN_ENV}`,
    );
  }
  const resolvePackageDir = options.resolvePackageDir ?? defaultPackageResolver(packageRoot);
  const packageDir = resolvePackageDir(entry.package);
  if (!packageDir) {
    throw unavailable(
      `Paquet natif ${entry.package} non installé.`,
      'PACKAGE_MISSING',
      { package: entry.package, platform: platform.key },
      'npm install (sans --omit=optional ni --no-optional)',
    );
  }
  const platformManifest = await readJson(path.join(packageDir, 'package.json')).catch(() => null);
  if (
    !isRecord(platformManifest) ||
    platformManifest.name !== entry.package ||
    platformManifest.version !== manifest.version
  ) {
    throw integrityFailure(
      `Paquet natif ${entry.package} d'une autre version que le manifeste (${manifest.version}).`,
      'PACKAGE_VERSION_MISMATCH',
      {
        package: entry.package,
        expected: manifest.version,
        actual: isRecord(platformManifest) ? (platformManifest.version ?? null) : null,
      },
    );
  }
  const binaryPath = path.join(packageDir, ...entry.path.split('/'));
  const identity = await fileIdentity(binaryPath);
  if (!identity) {
    throw unavailable(
      `Binaire natif absent du paquet ${entry.package} (${binaryPath}).`,
      'BINARY_MISSING',
      { path: binaryPath, package: entry.package },
      'réinstaller Striart (npm install)',
    );
  }
  const digest = await sha256File(binaryPath);
  if (identity.size !== entry.size || digest !== entry.sha256) {
    throw integrityFailure(
      `Empreinte du binaire natif non conforme au manifeste signé (${binaryPath}).`,
      'DIGEST_MISMATCH',
      { path: binaryPath, expected: entry.sha256, actual: digest },
    );
  }
  return {
    path: binaryPath,
    source: 'package',
    platform: platform.key,
    packageName: entry.package,
    nativeVersion: manifest.nativeVersion,
    verification: { status: 'verified', scheme: scheme.name, keyId, sha256: digest },
  };
}

/**
 * Résout, vérifie et identifie le binaire (poignée de main `version`). Sans
 * cache : voir `getNativeBinary` pour l'accès courant.
 */
export async function resolveNativeBinary(
  options: ResolveNativeOptions = {},
): Promise<NativeBinary> {
  const located = await locateNativeBinary(options);
  const handshake = await execNative(located.path, ['version'], HANDSHAKE_TIMEOUT_MS);
  const doc = handshake as Record<string, unknown>;
  if (
    !isRecord(doc) ||
    doc.name !== 'striart-native' ||
    typeof doc.version !== 'string' ||
    !Number.isSafeInteger(doc.protocol)
  ) {
    throw protocolError('réponse de « version » invalide', 'VERSION_INVALID', located.path);
  }
  if (doc.protocol !== NATIVE_PROTOCOL_VERSION) {
    throw protocolError(
      `protocole ${String(doc.protocol)} au lieu de ${NATIVE_PROTOCOL_VERSION}`,
      'PROTOCOL_MISMATCH',
      located.path,
    );
  }
  // Le binaire exécuté doit être celui que le manifeste signé dit avoir
  // construit : même version de crate (les octets sont déjà liés par SHA-256 ;
  // ceci détecte un manifeste qui aurait été produit pour un autre build).
  if (located.nativeVersion !== undefined && doc.version !== located.nativeVersion) {
    throw integrityFailure(
      `Le binaire natif rapporte la version ${doc.version} alors que le manifeste signé déclare ${located.nativeVersion}.`,
      'NATIVE_VERSION_MISMATCH',
      { declared: located.nativeVersion, reported: doc.version },
    );
  }
  const [platformName, arch] = located.platform.split('-');
  if (doc.os !== RUST_OS[platformName] || doc.arch !== RUST_ARCH[arch]) {
    throw protocolError(
      `binaire ${String(doc.os)}/${String(doc.arch)} sur ${located.platform}`,
      'PLATFORM_MISMATCH',
      located.path,
    );
  }
  const commands =
    Array.isArray(doc.commands) && doc.commands.every((c) => typeof c === 'string')
      ? (doc.commands as string[])
      : [];
  return { ...located, version: doc.version, protocol: doc.protocol as number, commands };
}

/**
 * Binaire vérifié qui sait servir `command` : un binaire d'un même protocole
 * mais antérieur (build de développement périmé, `STRIART_NATIVE_BIN` vers
 * une ancienne version) est refusé explicitement plutôt que de mourir en
 * erreur d'usage au milieu d'un démarrage.
 */
export async function requireNativeCommand(command: string): Promise<NativeBinary> {
  const binary = await getNativeBinary();
  if (!binary.commands.includes(command)) {
    throw protocolError(
      `commande « ${command} » absente du binaire`,
      'COMMAND_MISSING',
      binary.path,
    );
  }
  return binary;
}

let cache: { binary: Promise<NativeBinary>; identity: DiskIdentity | null } | null = null;

/** Binaire vérifié du process courant (vérification refaite si le fichier change). */
export async function getNativeBinary(): Promise<NativeBinary> {
  if (cache) {
    const current = cache;
    const binary = await current.binary;
    const identity = await fileIdentity(binary.path);
    if (
      identity &&
      current.identity &&
      identity.size === current.identity.size &&
      identity.mtimeMs === current.identity.mtimeMs &&
      identity.ino === current.identity.ino
    ) {
      return binary;
    }
    if (cache === current) cache = null;
  }
  const binary = resolveNativeBinary();
  const entry: { binary: Promise<NativeBinary>; identity: DiskIdentity | null } = {
    binary,
    identity: null,
  };
  cache = entry;
  try {
    const resolved = await binary;
    entry.identity = await fileIdentity(resolved.path);
    return resolved;
  } catch (error) {
    // Un échec n'est pas mis en cache : l'appel suivant (après npm install,
    // native:build) réessaie.
    if (cache === entry) cache = null;
    throw error;
  }
}

/** Oublie le binaire vérifié (tests). */
export function resetNativeBinaryCache(): void {
  cache = null;
}

// ── Exécution ────────────────────────────────────────────────────────────

const HANDSHAKE_TIMEOUT_MS = 15_000;
const QUERY_TIMEOUT_MS = 15_000;
const TREE_KILL_TIMEOUT_MS = 60_000;
/** Plus grande réponse acceptée (4 096 process × lignes de commande longues). */
const MAX_OUTPUT_BYTES = 32 * 1024 * 1024;

function protocolError(what: string, reason: string, binaryPath: string): StriartError {
  return new StriartError(`Réponse du binaire natif non conforme : ${what}.`, {
    code: 'NATIVE_PROTOCOL_ERROR',
    details: { reason, path: binaryPath },
    hint: 'striart doctor',
  });
}

/** Erreur `{"error":{"code","message"}}` de la dernière ligne de stderr, si conforme. */
export function parseNativeErrorLine(stderr: string): { code: string; message: string } | null {
  const last = stderr.trimEnd().split(/\r?\n/).at(-1) ?? '';
  try {
    const parsed: unknown = JSON.parse(last);
    if (!isRecord(parsed) || !isRecord(parsed.error)) return null;
    const { code, message } = parsed.error;
    if (typeof code !== 'string' || !/^[A-Z][A-Z0-9_]{0,63}$/.test(code)) return null;
    return { code, message: typeof message === 'string' ? message : '' };
  } catch {
    // Pas du JSON : l'appelant le traite comme une violation du protocole.
    return null;
  }
}

async function execNative(binaryPath: string, args: string[], timeoutMs: number): Promise<unknown> {
  const command = args.slice(0, 2).join(' ');
  const result = await execa(binaryPath, args, {
    reject: false,
    timeout: timeoutMs,
    windowsHide: true,
    stdin: 'ignore',
    maxBuffer: MAX_OUTPUT_BYTES,
    stripFinalNewline: false,
  });
  if (result.timedOut) {
    throw new StriartError(`Le binaire natif n'a pas répondu en ${timeoutMs} ms (${command}).`, {
      code: 'NATIVE_COMMAND_FAILED',
      details: { reason: 'TIMEOUT', command, path: binaryPath },
      hint: 'striart doctor',
    });
  }
  if (result.exitCode === undefined) {
    throw new StriartError(`Lancement du binaire natif impossible (${command}).`, {
      code: 'NATIVE_COMMAND_FAILED',
      details: { reason: 'SPAWN', command, path: binaryPath },
      hint: 'striart doctor',
      cause: result.cause,
    });
  }
  if (result.exitCode !== 0) {
    const nativeError = parseNativeErrorLine(String(result.stderr ?? ''));
    if (!nativeError) {
      throw protocolError(
        `sortie ${result.exitCode} sans erreur JSON (${command})`,
        'STDERR_INVALID',
        binaryPath,
      );
    }
    throw new StriartError(
      `Le binaire natif a échoué (${command}) : ${nativeError.code} — ${nativeError.message}`,
      {
        code: 'NATIVE_COMMAND_FAILED',
        details: {
          reason: 'NATIVE_ERROR',
          command,
          nativeCode: nativeError.code,
          exitCode: result.exitCode,
          path: binaryPath,
        },
        hint: 'striart doctor',
      },
    );
  }
  const stdout = String(result.stdout ?? '');
  if (!stdout.endsWith('\n') || stdout.slice(0, -1).includes('\n')) {
    throw protocolError(
      `stdout n'est pas un document JSON d'une ligne (${command})`,
      'STDOUT_SHAPE',
      binaryPath,
    );
  }
  try {
    return JSON.parse(stdout);
  } catch {
    throw protocolError(`stdout n'est pas du JSON (${command})`, 'STDOUT_NOT_JSON', binaryPath);
  }
}

/** Exécute une commande du binaire vérifié et rend son document JSON (non validé). */
export async function runNative(args: string[], timeoutMs: number): Promise<unknown> {
  const binary = await getNativeBinary();
  return execNative(binary.path, args, timeoutMs);
}

// ── proc info ────────────────────────────────────────────────────────────

export interface NativeProcessRecord {
  pid: number;
  ppid: number | null;
  /** Nom d'image brut (`node.exe`, `/usr/bin/zsh`, `-bash`). */
  name: string;
  commandLine: string | null;
  /** Création, ms depuis l'epoch Unix ; null si illisible (droits). */
  startTimeMs: number | null;
}

const isPid = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) > 0 && (value as number) <= 0xffff_ffff;

/** Validation positive d'un document `proc info`. */
export function parseProcInfoDocument(raw: unknown): NativeProcessRecord[] {
  if (!isRecord(raw) || !Array.isArray(raw.processes) || !Array.isArray(raw.missing)) {
    throw new Error('expected {processes: [], missing: []}');
  }
  if (!raw.missing.every(isPid)) throw new Error('invalid missing list');
  return raw.processes.map((row: unknown, index: number) => {
    if (!isRecord(row)) throw new Error(`processes[${index}] is not an object`);
    const { pid, ppid, name, commandLine, startTimeMs } = row;
    const startOk =
      startTimeMs === null || (Number.isSafeInteger(startTimeMs) && (startTimeMs as number) >= 0);
    if (
      !isPid(pid) ||
      !(ppid === null || isPid(ppid)) ||
      typeof name !== 'string' ||
      !(commandLine === null || typeof commandLine === 'string') ||
      !startOk
    ) {
      throw new Error(`processes[${index}] has invalid fields`);
    }
    return {
      pid,
      ppid: ppid as number | null,
      name,
      commandLine: commandLine as string | null,
      startTimeMs: startTimeMs as number | null,
    };
  });
}

/** Le binaire refuse plus de PID par appel : on découpe. */
const MAX_PIDS_PER_CALL = 4096;

/**
 * Identité de plusieurs PID, en un appel natif par tranche de 4 096. Un PID
 * absent de la réponse (mort, jamais attribué) est absent du résultat.
 * Lève une StriartError NATIVE_* si le binaire est indisponible ou non
 * conforme — jamais une table vide qui passerait pour « aucun process ».
 */
export async function nativeProcessInfo(pids: readonly number[]): Promise<NativeProcessRecord[]> {
  const valid = [...new Set(pids)].filter(isPid);
  const records: NativeProcessRecord[] = [];
  for (let i = 0; i < valid.length; i += MAX_PIDS_PER_CALL) {
    const chunk = valid.slice(i, i + MAX_PIDS_PER_CALL);
    const binary = await getNativeBinary();
    const raw = await execNative(
      binary.path,
      ['proc', 'info', '--pids', chunk.join(',')],
      QUERY_TIMEOUT_MS,
    );
    try {
      records.push(...parseProcInfoDocument(raw));
    } catch (error) {
      throw protocolError(
        `proc info : ${(error as Error).message}`,
        'PROC_INFO_INVALID',
        binary.path,
      );
    }
  }
  return records;
}

// ── proc tree-kill ───────────────────────────────────────────────────────

export interface NativeTreeKillResult {
  root: number;
  rootState: 'alive' | 'dead' | 'foreign';
  killed: { pid: number; startTimeMs: number | null }[];
  failed: { pid: number; reason: string }[];
  /** Process de l'arbre ENCORE vivants après le dernier balayage. */
  survivors: { pid: number; startTimeMs: number | null }[];
  /** `survivors` vide : l'arbre est éteint. Jamais déduit d'un simple succès de l'appel. */
  complete: boolean;
}

export function parseTreeKillDocument(raw: unknown): NativeTreeKillResult {
  if (!isRecord(raw) || !isPid(raw.root)) throw new Error('invalid root');
  if (!['alive', 'dead', 'foreign'].includes(raw.rootState as string)) {
    throw new Error('invalid rootState');
  }
  if (!Array.isArray(raw.killed) || !Array.isArray(raw.failed)) throw new Error('invalid lists');
  const killed = raw.killed.map((k: unknown) => {
    if (!isRecord(k) || !isPid(k.pid)) throw new Error('invalid killed entry');
    const start = k.startTimeMs;
    if (!(start === null || (Number.isSafeInteger(start) && (start as number) >= 0))) {
      throw new Error('invalid killed entry');
    }
    return { pid: k.pid, startTimeMs: start as number | null };
  });
  const failed = raw.failed.map((f: unknown) => {
    if (!isRecord(f) || !isPid(f.pid) || typeof f.reason !== 'string') {
      throw new Error('invalid failed entry');
    }
    return { pid: f.pid, reason: f.reason };
  });
  // `survivors` et `complete` sont EXIGÉS : un binaire qui ne les rend pas
  // (build périmé) ne peut pas affirmer que l'arbre est éteint.
  if (!Array.isArray(raw.survivors) || typeof raw.complete !== 'boolean') {
    throw new Error('missing survivors/complete');
  }
  const survivors = raw.survivors.map((k: unknown) => {
    if (!isRecord(k) || !isPid(k.pid)) throw new Error('invalid survivor entry');
    const start = k.startTimeMs;
    if (!(start === null || (Number.isSafeInteger(start) && (start as number) >= 0))) {
      throw new Error('invalid survivor entry');
    }
    return { pid: k.pid, startTimeMs: start as number | null };
  });
  if (raw.complete !== (survivors.length === 0)) {
    throw new Error('complete contradicts survivors');
  }
  return {
    root: raw.root,
    rootState: raw.rootState as NativeTreeKillResult['rootState'],
    killed,
    failed,
    survivors,
    complete: raw.complete,
  };
}

/**
 * Tue l'arbre de process enraciné en `pid` (descendants compris, racine
 * morte comprise si `rootStartedMs` — son heure de création, telle que lue
 * par `nativeProcessInfo` — est connue).
 */
export async function nativeTreeKill(
  pid: number,
  { rootStartedMs }: { rootStartedMs?: number | null } = {},
): Promise<NativeTreeKillResult> {
  if (!isPid(pid)) {
    throw new StriartError(`PID invalide : ${String(pid)}`, {
      code: 'INVALID_PID',
      details: { pid },
    });
  }
  const args = ['proc', 'tree-kill', '--pid', String(pid)];
  if (rootStartedMs !== undefined && rootStartedMs !== null) {
    args.push('--root-started-ms', String(rootStartedMs));
  }
  const binary = await getNativeBinary();
  const raw = await execNative(binary.path, args, TREE_KILL_TIMEOUT_MS);
  try {
    return parseTreeKillDocument(raw);
  } catch (error) {
    throw protocolError(
      `proc tree-kill : ${(error as Error).message}`,
      'TREE_KILL_INVALID',
      binary.path,
    );
  }
}

// ── job run ──────────────────────────────────────────────────────────────

export interface NativeJobReport {
  pid: number;
  /** Code de sortie normalisé par l'appelant (Windows : uint32 brut). */
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  interrupted: string | null;
  orphansKilled: number;
  orphanPids: number[];
  killedOnTimeout: number;
  killedPids: number[];
  /** Process du conteneur ENCORE vivants après le nettoyage. */
  survivorPids: number[];
  /** `survivorPids` vide : le conteneur est éteint. */
  complete: boolean;
  graceMs: number;
  durationMs: number;
}

/**
 * Le nettoyage du conteneur a-t-il abouti ? Lève `JOB_TERMINATE_INCOMPLETE`
 * sinon : un appelant qui conclurait « aucun orphelin » d'un rapport dont des
 * process survivent déclarerait vert un gate qui laisse des process derrière
 * lui (fail closed).
 */
export function assertJobComplete(
  report: Pick<NativeJobReport, 'complete' | 'survivorPids'>,
): void {
  if (report.complete) return;
  throw new StriartError(
    `Le nettoyage du conteneur de process n'a pas abouti : ${report.survivorPids.length} process vivant(s) (${report.survivorPids.slice(0, 8).join(', ')}).`,
    {
      code: 'JOB_TERMINATE_INCOMPLETE',
      details: { survivors: report.survivorPids.slice(0, 64) },
      hint: 'tuer ces process à la main (striart doctor), puis relancer',
    },
  );
}

export function parseJobReport(raw: unknown): NativeJobReport {
  if (!isRecord(raw)) throw new Error('report is not an object');
  const count = (v: unknown) => Number.isSafeInteger(v) && (v as number) >= 0;
  const pidList = (v: unknown): v is number[] => Array.isArray(v) && v.every(isPid);
  const {
    pid,
    exitCode,
    signal,
    timedOut,
    interrupted,
    orphansKilled,
    orphanPids,
    killedOnTimeout,
    killedPids,
    survivorPids,
    complete,
    graceMs,
    durationMs,
  } = raw;
  if (
    !isPid(pid) ||
    !(exitCode === null || Number.isSafeInteger(exitCode)) ||
    !(signal === null || typeof signal === 'string') ||
    typeof timedOut !== 'boolean' ||
    !(interrupted === null || typeof interrupted === 'string') ||
    !count(orphansKilled) ||
    !pidList(orphanPids) ||
    orphanPids.length !== orphansKilled ||
    !count(killedOnTimeout) ||
    !pidList(killedPids) ||
    killedPids.length !== killedOnTimeout ||
    !pidList(survivorPids) ||
    typeof complete !== 'boolean' ||
    complete !== (survivorPids.length === 0) ||
    !count(graceMs) ||
    !count(durationMs)
  ) {
    throw new Error('report has invalid fields');
  }
  return {
    pid,
    exitCode: exitCode as number | null,
    signal: signal as string | null,
    timedOut,
    interrupted: interrupted as string | null,
    orphansKilled: orphansKilled as number,
    orphanPids,
    killedOnTimeout: killedOnTimeout as number,
    killedPids,
    survivorPids,
    complete,
    graceMs: graceMs as number,
    durationMs: durationMs as number,
  };
}

export interface NativeJobOptions {
  /** Programme et arguments — jamais interprétés par un shell. */
  argv: readonly string[];
  cwd: string;
  /** Délai de grâce laissé aux descendants après la sortie du programme. */
  graceMs: number;
  /** Délai total ; au-delà, tout le conteneur est tué. */
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  /**
   * `false` : `env` EST l'environnement complet du programme (rien n'est
   * hérité du process Striart). Défaut `true` (execa fusionne `process.env`).
   */
  extendEnv?: boolean;
  /** Windows : arguments transmis sans requotage (`cmd.exe /d /s /c "…"`). */
  windowsVerbatimArguments?: boolean;
  /** Entrelace stdout et stderr dans `all` (journal du Test Gate). */
  all?: boolean;
  /**
   * `false` : la sortie n'est PAS accumulée par execa (flux à consommer par
   * l'appelant, qui borne sa propre mémoire). Défaut `true` (execa borne le
   * tampon à 100 Mio et lève au-delà).
   */
  buffer?: boolean;
}

export interface NativeJob {
  /** Le process `striart-native job run` ; ses flux sont ceux du programme. */
  subprocess: ResultPromise<{ all: boolean; reject: false }>;
  /** Rapport final, disponible à la sortie du process. */
  report: Promise<NativeJobReport>;
}

/**
 * Lance `argv` dans un conteneur de process natif (Job Object / groupe +
 * subreaper) : primitive du Test Gate (orphelins comptés et tués après le
 * délai de grâce). Les flux du programme arrivent au fil de l'eau sur ceux de
 * `subprocess`.
 */
export async function startNativeJob(options: NativeJobOptions): Promise<NativeJob> {
  const { argv, cwd, graceMs, timeoutMs, env, windowsVerbatimArguments = false } = options;
  if (argv.length === 0 || !argv[0]) {
    throw new StriartError('Commande vide.', {
      code: 'INVALID_ARGUMENT',
      details: { option: 'argv' },
    });
  }
  if (!Number.isSafeInteger(graceMs) || graceMs < 0 || graceMs > 600_000) {
    throw new StriartError(`Délai de grâce invalide : ${graceMs}`, {
      code: 'INVALID_ARGUMENT',
      details: { option: 'graceMs', value: graceMs },
    });
  }
  if (timeoutMs !== undefined && (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1)) {
    throw new StriartError(`Délai invalide : ${timeoutMs}`, {
      code: 'INVALID_ARGUMENT',
      details: { option: 'timeoutMs', value: timeoutMs },
    });
  }
  const binary = await getNativeBinary();
  const dir = await mkdtemp(path.join(os.tmpdir(), 'striart-job-'));
  const reportFile = path.join(dir, 'report.json');
  const args = ['job', 'run', '--grace-ms', String(graceMs)];
  if (timeoutMs !== undefined) args.push('--timeout-ms', String(timeoutMs));
  args.push('--report-file', reportFile);
  if (windowsVerbatimArguments) args.push('--windows-verbatim-args');
  args.push('--', ...argv);
  const subprocess = execa(binary.path, args, {
    cwd,
    env,
    extendEnv: options.extendEnv ?? true,
    reject: false,
    all: options.all ?? false,
    buffer: options.buffer ?? true,
    windowsHide: true,
    stdin: 'ignore',
  }) as NativeJob['subprocess'];
  const report = (async () => {
    try {
      const result = await subprocess;
      const text = await readFile(reportFile, 'utf8').catch(() => null);
      if (text === null) {
        const nativeError = parseNativeErrorLine(String(result.stderr ?? ''));
        throw new StriartError(
          `Le conteneur de process natif n'a pas produit de rapport${nativeError ? ` : ${nativeError.code} — ${nativeError.message}` : ''}.`,
          {
            code: 'NATIVE_COMMAND_FAILED',
            details: {
              reason: 'NO_REPORT',
              command: 'job run',
              nativeCode: nativeError?.code ?? null,
              exitCode: result.exitCode ?? null,
              path: binary.path,
            },
            hint: 'striart doctor',
          },
        );
      }
      try {
        return parseJobReport(JSON.parse(text));
      } catch (error) {
        throw protocolError(
          `job run : ${(error as Error).message}`,
          'JOB_REPORT_INVALID',
          binary.path,
        );
      }
    } finally {
      await rm(dir, { recursive: true, force: true, maxRetries: 3 }).catch(() => {
        // Reliquat dans le dossier temporaire de l'OS : sans effet sur le
        // rapport déjà lu (ou l'erreur déjà levée).
      });
    }
  })();
  // Un appelant qui n'attend que `subprocess` ne doit pas déclencher un
  // `unhandledRejection` (qui tue le process Node) quand le rapport est
  // illisible : le rejet est marqué traité ici, et reste observable par tout
  // appelant qui attend `report`.
  report.catch(() => undefined);
  return { subprocess, report };
}

// ── pty-host ─────────────────────────────────────────────────────────────

/** Sortie de `pty-host` : un hôte vivant tient déjà l'agent (voir native/…/pty_host). */
export const PTY_HOST_EXIT_ALREADY_RUNNING = 3;

/** Bornes acceptées par `pty-host` (native/striart-native/src/pty_host/mod.rs). */
export const PTY_HOST_LIMITS = Object.freeze({
  maxDimension: 1_000,
  replayBytes: { min: 1_024, max: 16 * 1024 * 1024 },
  clientQueueBytes: { min: PTY_MIN_CLIENT_QUEUE_BYTES, max: 256 * 1024 * 1024 },
  killGraceMs: { min: 0, max: 60_000 },
  maxInitialBytes: ptyMaxInitialBytes(),
});

export interface NativePtyHostOptions {
  agent: string;
  /** Dossier d'état ABSOLU de l'agent (`.striart/pty/<agent>`). */
  stateDir: string;
  /** Canal d'attache (named pipe ou socket), dérivé par `attachSocketPath`. */
  endpoint: string;
  cwd: string;
  /** Programme hébergé et ses arguments — jamais interprétés par un shell. */
  program: string;
  args?: readonly string[];
  cols?: number;
  rows?: number;
  /** Écrite dans le pty juste après le démarrage, Entrée ajoutée. */
  initial?: string | null;
  /** POSIX : `TERM` du programme. */
  term?: string | null;
  replayBytes?: number;
  clientQueueBytes?: number;
  killGraceMs?: number;
  /** Hôte « possédé » : il s'arrête à la mort de ce process. */
  parentPid?: number | null;
}

function ptyHostArgumentError(option: string, value: unknown): StriartError {
  return new StriartError(`Invalid pty host option ${option}.`, {
    code: 'INVALID_ARGUMENT',
    details: { option, value: typeof value === 'number' ? value : null },
  });
}

function boundedInteger(
  option: string,
  value: number | undefined,
  { min, max }: { min: number; max: number },
): string | null {
  if (value === undefined) return null;
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw ptyHostArgumentError(option, value);
  }
  return String(value);
}

/**
 * argv de `striart-native pty-host` (sans le binaire). Validation positive
 * des valeurs AVANT le lancement : le binaire les revalide (défense en
 * profondeur), mais une erreur ici est nommée et immédiate au lieu d'une
 * sortie 2 lue dans un journal.
 */
export function nativePtyHostArgs(options: NativePtyHostOptions): string[] {
  const { agent, stateDir, endpoint, cwd, program } = options;
  if (!path.isAbsolute(stateDir)) throw ptyHostArgumentError('stateDir', null);
  if (!path.isAbsolute(cwd)) throw ptyHostArgumentError('cwd', null);
  if (!program) throw ptyHostArgumentError('program', null);
  const args = ['pty-host', '--agent', agent, '--state-dir', stateDir, '--endpoint', endpoint];
  args.push('--cwd', cwd);
  const optional: Array<[string, string | null]> = [
    ['--cols', boundedInteger('cols', options.cols, { min: 1, max: PTY_HOST_LIMITS.maxDimension })],
    ['--rows', boundedInteger('rows', options.rows, { min: 1, max: PTY_HOST_LIMITS.maxDimension })],
    [
      '--replay-bytes',
      boundedInteger('replayBytes', options.replayBytes, PTY_HOST_LIMITS.replayBytes),
    ],
    [
      '--client-queue-bytes',
      boundedInteger(
        'clientQueueBytes',
        options.clientQueueBytes,
        PTY_HOST_LIMITS.clientQueueBytes,
      ),
    ],
    [
      '--kill-grace-ms',
      boundedInteger('killGraceMs', options.killGraceMs, PTY_HOST_LIMITS.killGraceMs),
    ],
    [
      '--parent-pid',
      boundedInteger('parentPid', options.parentPid ?? undefined, { min: 1, max: 0xffff_ffff }),
    ],
  ];
  // La file d'un client doit accueillir le rejeu ET deux frames de sortie
  // (valeurs absentes : défauts de l'hôte). Refusé ici, nommément, plutôt
  // que d'évincer chaque client en boucle ou de lire un usage 2 du binaire.
  const effectiveQueue = options.clientQueueBytes ?? 4 * 1024 * 1024;
  const queueFloor = ptyMinClientQueueBytes(options.replayBytes ?? 65_536);
  if (effectiveQueue < queueFloor) {
    throw ptyHostArgumentError('clientQueueBytes', options.clientQueueBytes ?? null);
  }
  for (const [flag, value] of optional) if (value !== null) args.push(flag, value);
  if (options.initial) {
    if (Buffer.byteLength(options.initial, 'utf8') > PTY_HOST_LIMITS.maxInitialBytes) {
      throw ptyHostArgumentError('initial', null);
    }
    args.push('--initial', options.initial);
  }
  if (options.term) {
    if (!/^[A-Za-z0-9.-]{1,64}$/.test(options.term)) throw ptyHostArgumentError('term', null);
    args.push('--term', options.term);
  }
  args.push('--', program, ...(options.args ?? []));
  return args;
}

/** Binaire vérifié + argv de `pty-host` (NATIVE_UNAVAILABLE si absent). */
export async function nativePtyHostCommand(
  options: NativePtyHostOptions,
): Promise<{ file: string; args: string[] }> {
  const args = nativePtyHostArgs(options);
  const binary = await requireNativeCommand('pty-host');
  return { file: binary.path, args };
}

// ── Diagnostic (striart doctor) ──────────────────────────────────────────

/**
 * État du binaire natif. Forme plate (pas d'union discriminée) : lisible
 * telle quelle depuis les modules JS vérifiés par tsc (strict: false).
 */
export interface NativeDiagnostic {
  /** Binaire résolu, vérifié et identifié ; null en cas d'échec. */
  binary: NativeBinary | null;
  /** Échec (code NATIVE_*, message, piste, détails) ; null en cas de succès. */
  error: {
    code: string;
    message: string;
    hint: string | null;
    details: Record<string, unknown>;
  } | null;
  platform: string;
}

/** État du binaire natif pour `striart doctor`. Ne lève jamais. */
export async function nativeDiagnostic(): Promise<NativeDiagnostic> {
  const platform = `${process.platform}-${process.arch}`;
  try {
    return { binary: await getNativeBinary(), error: null, platform };
  } catch (error) {
    const known = error instanceof StriartError;
    return {
      binary: null,
      error: {
        code: known ? error.code : 'NATIVE_UNAVAILABLE',
        message: error instanceof Error ? error.message : String(error),
        hint: known ? error.hint : null,
        details: known ? error.details : {},
      },
      platform,
    };
  }
}

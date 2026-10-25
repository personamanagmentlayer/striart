// Test de fumée du paquet PUBLIÉ : construit l'archive comme une release
// (scripts/pack.ts), l'installe dans un projet consommateur vierge, puis lance
// le binaire installé. Rien d'autre ne prouve que le paquet démarre une fois
// sous node_modules — où Node refuse le type stripping des .ts
// (ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING, cause de l'incident v0.10.0).
//
// Projet vitest dédié `pack` (vitest.config.js) : `npm run test:pack`. Réseau
// requis pour installer les dépendances du paquet ; `--prefer-offline` sert le
// cache npm local quand il est chaud (hors réseau : cache préalablement
// rempli par un `npm ci` du dépôt + une première exécution).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { createTempRepo } from '../helpers/temp-repo.js';
import { resolveNpmCli } from '../../scripts/pack.ts';
import { stageNativeBinary } from '../../scripts/native-stage.ts';
import { nativePlatform } from '../../src/native.ts';
import { getSignatureScheme } from '../../src/native-signature.ts';
import { nativeBinaryPath, REPO_ROOT as NATIVE_REPO_ROOT } from '../helpers/native.js';
import { requireNativeBuild } from '../helpers/native-build.js';

const execFileAsync = promisify(execFile);
const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const PACKAGE_NAME = '@jumsay/striart';

/**
 * Environnement des process enfants : sans les variables `npm_*` héritées de
 * `npm run` (elles décrivent le DÉPÔT Striart — prefix local, scripts — pas le
 * projet consommateur), sans couleur.
 */
function childEnv(extra = {}) {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !/^npm_/i.test(key)),
  );
  return { ...env, NO_COLOR: '1', FORCE_COLOR: '0', STRIART_LANG: 'en', ...extra };
}

async function run(file, args, cwd, extraEnv = {}) {
  try {
    const { stdout, stderr } = await execFileAsync(file, args, {
      cwd,
      env: childEnv(extraEnv),
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      windowsHide: true,
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    if (typeof error.code !== 'number') throw error; // échec de lancement, pas de sortie
    return { code: error.code, stdout: error.stdout ?? '', stderr: error.stderr ?? '' };
  }
}

async function listFiles(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await listFiles(full)));
    else out.push(full);
  }
  return out;
}

describe('paquet npm publié (pack → install → exécution)', () => {
  let work;
  let consumer;
  let installedDir;
  /** Lance le `striart` INSTALLÉ, tel qu'un utilisateur l'appelle. */
  let striart;
  /** Variante SANS la confiance utilisateur dans la clé de signature de l'archive. */
  let striartUntrusted;
  let repoVersion;

  beforeAll(async () => {
    repoVersion = JSON.parse(await readFile(path.join(REPO_ROOT, 'package.json'), 'utf8')).version;
    work = await mkdtemp(path.join(os.tmpdir(), 'striart-pack-smoke-'));

    requireNativeBuild(NATIVE_REPO_ROOT);
    // Binaire natif de la plateforme courante (construit par le globalSetup),
    // déposé comme le fait la CI pour chacune des six plateformes.
    const host = nativePlatform();
    if (!host) throw new Error(`plateforme ${process.platform}-${process.arch} non publiée`);
    const nativeDir = path.join(work, 'native');
    await stageNativeBinary({ platformKey: host.key, outDir: nativeDir, from: nativeBinaryPath() });

    // Clé de signature PROPRE À CE TEST : l'archive est signée comme une
    // release (clé privée en variable d'environnement, clé publique fournie par
    // --signing-public-key), mais d'une clé que le code n'épingle pas. La
    // confiance est déclarée comme le ferait un utilisateur : `native.trustedKeyIds`
    // de SA config. (--ephemeral-signing-key n'est plus possible hors
    // --dry-run : une archive signée d'une clé jetable ne doit pas être
    // installable.)
    const scheme = getSignatureScheme('minisign');
    const pair = scheme.generateKeyPair();
    const publicKeyFile = path.join(work, 'test-signing.pub');
    await writeFile(publicKeyFile, pair.publicKey);
    const probe = Buffer.from('smoke');
    const signingKeyId = scheme.sign(probe, pair.secret, pair.publicKey, 'smoke').keyId;
    const configHome = path.join(work, 'user-config');
    await mkdir(configHome, { recursive: true });
    const configFile = path.join(configHome, 'config.json');
    await writeFile(configFile, JSON.stringify({ native: { trustedKeyIds: [signingKeyId] } }));
    await chmod(configFile, 0o600).catch(() => undefined);
    const trustedEnv = { STRIART_CONFIG_HOME: configHome };
    const emptyHome = path.join(work, 'user-config-empty');
    await mkdir(emptyHome, { recursive: true });
    const untrustedEnv = { STRIART_CONFIG_HOME: emptyHome };

    // --allow-dirty : ce test vérifie l'arbre de travail du développeur (la
    // boucle locale) ; la release réelle, elle, refuse un arbre modifié.
    // --native-platforms : seule la plateforme courante — la vérification au
    // chargement est la même que pour une release (src/native.ts).
    const pack = await run(
      process.execPath,
      [
        path.join(REPO_ROOT, 'scripts', 'pack.ts'),
        '--json',
        '--allow-dirty',
        '--out-dir',
        path.join(work, 'out'),
        '--native-dir',
        nativeDir,
        '--native-platforms',
        host.key,
        '--signing-public-key',
        publicKeyFile,
      ],
      REPO_ROOT,
      { STRIART_NATIVE_SIGNING_KEY: pair.secret.key },
    );
    if (pack.code !== 0)
      throw new Error(`scripts/pack.ts a échoué (${pack.code}) :\n${pack.stderr}`);
    const packed = JSON.parse(pack.stdout);
    const { tarball } = packed;
    const platformTarball = packed.native.platforms[0].tarball;

    consumer = path.join(work, 'consumer');
    await mkdir(consumer, { recursive: true });
    await writeFile(
      path.join(consumer, 'package.json'),
      `${JSON.stringify({ name: 'striart-consumer', version: '1.0.0', private: true }, null, 2)}\n`,
    );
    const install = await run(
      process.execPath,
      // Les deux archives ensemble : la dépendance optionnelle exacte du
      // paquet principal est satisfaite par l'archive de plateforme locale.
      [
        resolveNpmCli(),
        'install',
        '--no-audit',
        '--no-fund',
        '--prefer-offline',
        platformTarball,
        tarball,
      ],
      consumer,
    );
    if (install.code !== 0) {
      throw new Error(`npm install du .tgz a échoué (${install.code}) :\n${install.stderr}`);
    }

    installedDir = path.join(consumer, 'node_modules', ...PACKAGE_NAME.split('/'));
    const installedManifest = JSON.parse(
      await readFile(path.join(installedDir, 'package.json'), 'utf8'),
    );
    const binTarget = path.join(installedDir, installedManifest.bin.striart);
    const shim = path.join(consumer, 'node_modules', '.bin', 'striart');
    const launcher =
      process.platform === 'win32'
        ? // Le shim .cmd ne se lance pas sans shell (Node refuse un .cmd en
          // shell: false) : on vérifie sa présence et on exécute la cible bin
          // déclarée, exactement ce que fait le shim.
          (args, cwd, env) => run(process.execPath, [binTarget, ...args], cwd, env)
        : // POSIX : le lien .bin lui-même — prouve aussi shebang et bit exécutable.
          (args, cwd, env) => run(shim, args, cwd, env);
    striart = (args, cwd) => launcher(args, cwd, trustedEnv);
    striartUntrusted = (args, cwd) => launcher(args, cwd, untrustedEnv);
    if (process.platform === 'win32' && !existsSync(`${shim}.cmd`)) {
      throw new Error(`Shim npm absent : ${shim}.cmd`);
    }
  }, 900_000); // > hookTimeout du projet : install à froid mesurée à 4 min 33 s sous Windows

  afterAll(async () => {
    if (!work) return;
    try {
      await rm(work, { recursive: true, force: true, maxRetries: 5 });
    } catch {
      // Windows sous charge (antivirus sur node_modules) : un reliquat dans
      // %TEMP% ne doit pas faire échouer un test qui a réussi.
    }
  });

  it('le paquet installé ne contient aucun .ts (Node refuse de les exécuter sous node_modules)', async () => {
    const tsFiles = (await listFiles(installedDir)).filter((f) => /\.(ts|tsx|mts|cts)$/.test(f));
    expect(tsFiles).toEqual([]);
  });

  it('striart --version : exit 0 et version du package.json', async () => {
    const result = await striart(['--version'], consumer);
    expect(result.stderr).not.toMatch(/ERR_/);
    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toBe(repoVersion);
  });

  it('striart doctor : binaire natif du paquet de plateforme, signature et empreinte vérifiées', async () => {
    const result = await striart(['doctor', '--json'], consumer);
    const parsed = JSON.parse(result.stdout);
    const checks = parsed.checks ?? parsed.data?.checks;
    const native = checks.find((c) => c.id === 'native');
    expect(native, result.stdout).toBeDefined();
    expect(native.level).toBe('ok');
    expect(native.params).toMatchObject({
      source: 'package',
      verification: 'verified',
      scheme: 'minisign',
    });
    expect(native.params.path).toContain(path.join('node_modules', '@jumsay'));
  });

  it('sans la clé de l’archive dans les clés de confiance, le binaire natif est REFUSÉ (S-I5)', async () => {
    const result = await striartUntrusted(['doctor', '--json'], consumer);
    const parsed = JSON.parse(result.stdout);
    const checks = parsed.checks ?? parsed.data?.checks;
    const native = checks.find((c) => c.id === 'native');
    expect(native, result.stdout).toBeDefined();
    expect(native.level).not.toBe('ok');
    expect(JSON.stringify(native)).toMatch(/KEY_NOT_TRUSTED|NATIVE_INTEGRITY_FAILED/);
  });

  it('striart --help : exit 0 et aide affichée', async () => {
    const result = await striart(['--help'], consumer);
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/Usage: striart/);
  });

  it('striart init puis status --json dans un dépôt git : exit 0, JSON valide', async () => {
    const repo = await createTempRepo();
    try {
      const init = await striart(['init'], repo.root);
      expect(init.code, init.stderr).toBe(0);

      const status = await striart(['status', '--json'], repo.root);
      expect(status.code, status.stderr).toBe(0);
      const parsed = JSON.parse(status.stdout);
      // Document --json enveloppé : { schemaVersion, command, ok, data }.
      expect(parsed).toMatchObject({ ok: true, command: 'status' });
      expect(parsed.data).toHaveProperty('agents');
      expect(Array.isArray(parsed.data.agents)).toBe(true);
    } finally {
      await repo.cleanup();
    }
  });
});

// Build du binaire natif pour les tests, mis en cache par empreinte des
// sources Rust (tests/helpers/native-setup.js, globalSetup de vitest).
//
// - Empreinte : SHA-256 des chemins et contenus de native/**/*.rs, des
//   Cargo.toml, de Cargo.lock et de rust-toolchain.toml (target/ exclu).
// - Tampon `native/target/release/.striart-native-build.json` : empreinte du
//   dernier build réussi. Empreinte identique et sorties présentes → aucun
//   cargo (passe à coût nul).
// - Sinon, build UNE fois sous un verrou inter-process (mkdir atomique
//   `native/target/.striart-native-build.lock`) : plusieurs vitest lancés en
//   parallèle attendent le même build au lieu de le refaire ensemble ; le
//   tampon est relu après acquisition. Un verrou abandonné (propriétaire mort
//   ou trop vieux) est cassé sous un second verrou (`.break`) qui revérifie
//   l'état : deux vitest ne peuvent pas se retrouver tous deux « propriétaires ».
// - Échec de compilation : le setup N'ÉCHOUE PAS globalement. L'échec est
//   enregistré (`.striart-native-build-failure.json`, sortie cargo comprise),
//   et les binaires PÉRIMÉS sont retirés de target/release (renommés
//   `*.stale`, ou supprimés ; un retrait impossible est lui-même enregistré) :
//   un test ne peut jamais tourner contre un binaire qui ne correspond plus
//   aux sources. Les tests qui exigent le natif échouent alors explicitement —
//   `requireNativeBuild()` lève avec la sortie cargo, et src/native.ts rend
//   NATIVE_UNAVAILABLE (« npm run native:build »).
// - Sans cargo, des binaires dont la fraîcheur ne peut PAS être prouvée sont
//   enregistrés comme tels (`.striart-native-unverified.json`) :
//   `requireNativeBuild()` les refuse, sauf STRIART_NATIVE_ALLOW_STALE=1
//   (choix explicite de l'utilisateur).
// - STRIART_NATIVE_BIN désigne le binaire testé, mais les FIXTURES (exemples
//   du crate) restent construites et vérifiées comme d'habitude : elles
//   doivent correspondre aux sources, pas à un binaire arbitraire.
import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

export const STAMP_FILE = '.striart-native-build.json';
export const FAILURE_FILE = '.striart-native-build-failure.json';
export const UNVERIFIED_FILE = '.striart-native-unverified.json';
const LOCK_DIR = '.striart-native-build.lock';
/** Un verrou plus vieux que ce délai, ou dont le PID est mort, est un débris. */
export const BUILD_LOCK_STALE_MS = 20 * 60_000;
/** Le verrou de cassure est tenu quelques ms : plus vieux que ceci, c'est un débris. */
const BREAK_LOCK_STALE_MS = 30_000;
const EXE = process.platform === 'win32' ? '.exe' : '';

/** Le binaire testé. */
export const BINARY_OUTPUT = `striart-native${EXE}`;
/** Fixtures des tests (exemples du crate, jamais livrés). */
export const FIXTURE_OUTPUTS = [
  path.join('examples', `process-fixture${EXE}`),
  path.join('examples', `protocol-fixture${EXE}`),
  path.join('examples', `pty-fixture${EXE}`),
];
/** Binaires que les tests exigent, relatifs à native/target/release. */
export const REQUIRED_OUTPUTS = [BINARY_OUTPUT, ...FIXTURE_OUTPUTS];

const releaseDir = (repoRoot) => path.join(repoRoot, 'native', 'target', 'release');

async function listSources(dir, base, out) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name === 'target') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) await listSources(full, base, out);
    else if (
      entry.name.endsWith('.rs') ||
      ['Cargo.toml', 'Cargo.lock', 'rust-toolchain.toml'].includes(entry.name)
    ) {
      out.push(path.relative(base, full).split(path.sep).join('/'));
    }
  }
  return out;
}

/** Empreinte des sources Rust (chemins triés + contenus). */
export async function nativeSourceFingerprint(repoRoot) {
  const nativeDir = path.join(repoRoot, 'native');
  const files = (await listSources(nativeDir, nativeDir, [])).sort();
  const hash = createHash('sha256');
  for (const file of files) {
    hash.update(`${file}\0`);
    hash.update(await readFile(path.join(nativeDir, ...file.split('/'))));
    hash.update('\0');
  }
  return hash.digest('hex');
}

async function readJson(file) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    // Absent ou illisible : traité comme « aucun build enregistré ».
    return null;
  }
}

const outputsPresent = (repoRoot, outputs) =>
  outputs.every((rel) => existsSync(path.join(releaseDir(repoRoot), rel)));

function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

async function ownerIsStale(lockDir, now) {
  const owner = await readJson(path.join(lockDir, 'owner'));
  const info = await stat(lockDir).catch(() => null);
  if (!info) return false; // déjà parti : rien à casser
  const age = now() - info.mtimeMs;
  return age > BUILD_LOCK_STALE_MS || Boolean(owner && !isPidAlive(owner.pid));
}

/**
 * Casse un verrou abandonné. Les cassures sont sérialisées par un second
 * verrou (`<lock>.break`), et l'état est REVÉRIFIÉ une fois celui-ci tenu :
 * un verrou fraîchement pris par un autre vitest entre notre constat et notre
 * suppression n'est jamais retiré (sinon deux process se croiraient
 * propriétaires du build).
 */
async function breakStaleLock(lockDir, now) {
  const breakDir = `${lockDir}.break`;
  try {
    await mkdir(breakDir);
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
    const info = await stat(breakDir).catch(() => null);
    if (info && now() - info.mtimeMs > BREAK_LOCK_STALE_MS) {
      await rm(breakDir, { recursive: true, force: true });
    }
    return; // un autre casse déjà : on réessaiera au tour suivant
  }
  try {
    if (await ownerIsStale(lockDir, now)) {
      await rm(lockDir, { recursive: true, force: true });
    }
  } finally {
    await rm(breakDir, { recursive: true, force: true });
  }
}

async function acquireLock(lockDir, { now = Date.now, sleep, waitMs }) {
  const deadline = now() + waitMs;
  for (;;) {
    try {
      await mkdir(lockDir);
      await writeFile(path.join(lockDir, 'owner'), JSON.stringify({ pid: process.pid, at: now() }));
      return;
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
    }
    if (await ownerIsStale(lockDir, now)) {
      await breakStaleLock(lockDir, now);
      continue;
    }
    if (now() > deadline) {
      throw new Error(`verrou de build natif tenu depuis trop longtemps : ${lockDir}`);
    }
    await sleep(250);
  }
}

/**
 * Retire un binaire périmé : renommé en `*.stale`, à défaut supprimé. Un
 * retrait impossible (fichier tenu ouvert sous Windows) est RENDU, jamais
 * avalé ni levé : l'appelant l'enregistre dans l'échec.
 */
async function retireStale(file) {
  if (!existsSync(file)) return null;
  try {
    await rename(file, `${file}.stale`);
    return null;
  } catch {
    // Renommage impossible (cible `.stale` tenue, droits) : suppression.
  }
  try {
    await rm(file, { force: true });
    return null;
  } catch (error) {
    return `${file}: ${error?.message ?? String(error)}`;
  }
}

/**
 * Assure un binaire natif à jour. Ne lève pas pour un échec de compilation
 * (rendu `status: 'failed'`) ; lève seulement sur une erreur d'outillage
 * imprévue (disque). Statuts : `explicit` (STRIART_NATIVE_BIN : le binaire est
 * celui de l'utilisateur, les fixtures sont tout de même à jour), `cached`,
 * `built`, `failed`, `no-cargo` (sorties présentes dont la fraîcheur n'est pas
 * prouvable), `missing` (ni cargo ni sorties).
 *
 * `build(scope)` : `scope` vaut `'all'` (binaire et exemples) ou `'examples'`
 * (STRIART_NATIVE_BIN : seuls les exemples).
 */
export async function ensureNativeBuild({
  repoRoot,
  env = process.env,
  cargo,
  build,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  lockWaitMs = BUILD_LOCK_STALE_MS,
}) {
  const explicit = Boolean(env.STRIART_NATIVE_BIN);
  const scope = explicit ? 'examples' : 'all';
  const outputs = explicit ? FIXTURE_OUTPUTS : REQUIRED_OUTPUTS;
  const release = releaseDir(repoRoot);
  const stampFile = path.join(release, STAMP_FILE);
  const failureFile = path.join(release, FAILURE_FILE);
  const unverifiedFile = path.join(release, UNVERIFIED_FILE);
  const fingerprint = await nativeSourceFingerprint(repoRoot);
  const upToDate = async () =>
    (await readJson(stampFile))?.fingerprint === fingerprint && outputsPresent(repoRoot, outputs);
  const done = async (status) => {
    await rm(unverifiedFile, { force: true });
    return { status: explicit && status === 'cached' ? 'explicit' : status, fingerprint };
  };

  if (await upToDate()) return done(explicit ? 'explicit' : 'cached');
  if (!cargo) {
    // Fraîcheur NON prouvée : enregistrée, et refusée par requireNativeBuild.
    const present = outputsPresent(repoRoot, outputs);
    if (present) {
      await mkdir(release, { recursive: true });
      await writeFile(
        unverifiedFile,
        JSON.stringify({ fingerprint, at: new Date().toISOString(), scope }),
      );
    }
    return present
      ? { status: 'no-cargo', fingerprint }
      : { status: explicit ? 'explicit' : 'missing', fingerprint };
  }
  const lockDir = path.join(repoRoot, 'native', 'target', LOCK_DIR);
  await mkdir(path.dirname(lockDir), { recursive: true });
  await acquireLock(lockDir, { sleep, waitMs: lockWaitMs });
  try {
    if (await upToDate()) return done(explicit ? 'explicit' : 'cached');
    const result = await build(scope);
    await mkdir(release, { recursive: true });
    if (result.ok && outputsPresent(repoRoot, outputs)) {
      await writeFile(stampFile, JSON.stringify({ fingerprint, at: new Date().toISOString() }));
      await rm(failureFile, { force: true });
      return done(explicit ? 'explicit' : 'built');
    }
    // Échec : sorties périmées retirées, échec enregistré pour les tests.
    const undeletable = [];
    for (const rel of outputs) {
      const problem = await retireStale(path.join(release, rel));
      if (problem) undeletable.push(problem);
    }
    await rm(stampFile, { force: true });
    await rm(unverifiedFile, { force: true });
    const output = String(result.output ?? '').slice(-20_000);
    await writeFile(
      failureFile,
      JSON.stringify({
        fingerprint,
        at: new Date().toISOString(),
        output,
        ...(undeletable.length > 0 ? { undeletable } : {}),
      }),
    );
    return { status: 'failed', fingerprint, output, undeletable };
  } finally {
    await rm(lockDir, { recursive: true, force: true });
  }
}

/**
 * Garde des tests qui exigent le binaire natif : lève une erreur explicite
 * (sortie cargo comprise) si le dernier build a échoué, si le binaire manque,
 * ou si sa fraîcheur n'est pas prouvée (jamais un saut silencieux).
 */
export function requireNativeBuild(repoRoot, env = process.env) {
  const release = releaseDir(repoRoot);
  let failure = null;
  try {
    failure = JSON.parse(readFileSync(path.join(release, FAILURE_FILE), 'utf8'));
  } catch {
    // Pas d'échec enregistré.
  }
  if (failure) {
    throw new Error(
      `Le binaire natif ne compile pas (npm run native:build) — ce test l'exige.\n--- sortie cargo ---\n${failure.output}${
        failure.undeletable?.length
          ? `\n--- binaires périmés non retirés ---\n${failure.undeletable.join('\n')}`
          : ''
      }`,
    );
  }
  // Les fixtures sont exigées même avec STRIART_NATIVE_BIN.
  const required = env.STRIART_NATIVE_BIN ? FIXTURE_OUTPUTS : REQUIRED_OUTPUTS;
  const missing = required.filter((rel) => !existsSync(path.join(release, rel)));
  if (missing.length > 0) {
    throw new Error(
      `Binaire natif absent (${missing.join(', ')}) : installer Rust (https://rustup.rs) puis « npm run native:build »${
        env.STRIART_NATIVE_BIN
          ? ' (les fixtures de test sont construites même avec STRIART_NATIVE_BIN)'
          : ''
      }.`,
    );
  }
  if (existsSync(path.join(release, UNVERIFIED_FILE)) && env.STRIART_NATIVE_ALLOW_STALE !== '1') {
    throw new Error(
      'Binaire natif non reconstruit (cargo introuvable) : sa conformité aux sources ne peut pas être prouvée. ' +
        'Installer Rust (https://rustup.rs), ou accepter explicitement le risque avec STRIART_NATIVE_ALLOW_STALE=1.',
    );
  }
}

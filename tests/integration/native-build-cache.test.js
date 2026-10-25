// Cache de build du binaire natif des tests (tests/helpers/native-build.js) :
// empreinte des sources, build unique sous verrou, échec enregistré sans
// bloquer la suite, binaire périmé retiré. Build simulé (aucun cargo).
import { afterEach, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  FAILURE_FILE,
  FIXTURE_OUTPUTS,
  REQUIRED_OUTPUTS,
  UNVERIFIED_FILE,
  ensureNativeBuild,
  nativeSourceFingerprint,
  requireNativeBuild,
} from '../helpers/native-build.js';

const roots = [];
afterEach(async () => {
  while (roots.length) await rm(roots.pop(), { recursive: true, force: true, maxRetries: 3 });
});

async function fakeRepo() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'striart-native-cache-'));
  roots.push(root);
  await mkdir(path.join(root, 'native', 'crate', 'src'), { recursive: true });
  await writeFile(path.join(root, 'native', 'Cargo.toml'), '[workspace]\n');
  await writeFile(path.join(root, 'native', 'Cargo.lock'), 'version = 4\n');
  await writeFile(path.join(root, 'native', 'crate', 'src', 'main.rs'), 'fn main() {}\n');
  return root;
}

const release = (root) => path.join(root, 'native', 'target', 'release');

/** Build simulé : écrit les sorties attendues (ou échoue), compte les appels. */
function fakeBuild(root, { ok = true, delayMs = 0 } = {}) {
  const calls = { count: 0 };
  const build = async () => {
    calls.count += 1;
    await new Promise((r) => setTimeout(r, delayMs));
    if (!ok) return { ok: false, output: 'error[E0425]: cannot find value `x`' };
    for (const rel of REQUIRED_OUTPUTS) {
      const file = path.join(release(root), rel);
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, `binary ${calls.count}`);
    }
    return { ok: true, output: '' };
  };
  return { build, calls };
}

describe('build natif des tests, mis en cache par empreinte', () => {
  it('premier passage : build ; passage suivant sans changement : aucun cargo', async () => {
    const root = await fakeRepo();
    const { build, calls } = fakeBuild(root);
    expect(
      (await ensureNativeBuild({ repoRoot: root, env: {}, cargo: 'cargo', build })).status,
    ).toBe('built');
    expect(
      (await ensureNativeBuild({ repoRoot: root, env: {}, cargo: 'cargo', build })).status,
    ).toBe('cached');
    expect(calls.count).toBe(1);
  });

  it('source Rust modifiée : nouvelle empreinte, rebuild', async () => {
    const root = await fakeRepo();
    const { build, calls } = fakeBuild(root);
    const before = await nativeSourceFingerprint(root);
    await ensureNativeBuild({ repoRoot: root, env: {}, cargo: 'cargo', build });
    await writeFile(path.join(root, 'native', 'crate', 'src', 'main.rs'), 'fn main() { }\n');
    expect(await nativeSourceFingerprint(root)).not.toBe(before);
    expect(
      (await ensureNativeBuild({ repoRoot: root, env: {}, cargo: 'cargo', build })).status,
    ).toBe('built');
    expect(calls.count).toBe(2);
  });

  it('target/ n’entre pas dans l’empreinte', async () => {
    const root = await fakeRepo();
    const before = await nativeSourceFingerprint(root);
    await mkdir(path.join(root, 'native', 'target', 'x'), { recursive: true });
    await writeFile(path.join(root, 'native', 'target', 'x', 'gen.rs'), 'x');
    expect(await nativeSourceFingerprint(root)).toBe(before);
  });

  it('vitest parallèles : un seul build sous le verrou inter-process', async () => {
    const root = await fakeRepo();
    const { build, calls } = fakeBuild(root, { delayMs: 300 });
    const results = await Promise.all(
      [1, 2, 3].map(() => ensureNativeBuild({ repoRoot: root, env: {}, cargo: 'cargo', build })),
    );
    expect(calls.count).toBe(1);
    expect(results.map((r) => r.status).sort()).toEqual(['built', 'cached', 'cached']);
  });

  it('échec de compilation : ne lève pas, binaire périmé retiré, tests natifs en échec explicite', async () => {
    const root = await fakeRepo();
    await ensureNativeBuild({
      repoRoot: root,
      env: {},
      cargo: 'cargo',
      build: fakeBuild(root).build,
    });
    await writeFile(path.join(root, 'native', 'crate', 'src', 'main.rs'), 'fn main() { x }\n');
    const outcome = await ensureNativeBuild({
      repoRoot: root,
      env: {},
      cargo: 'cargo',
      build: fakeBuild(root, { ok: false }).build,
    });
    expect(outcome.status).toBe('failed');
    const binary = path.join(release(root), REQUIRED_OUTPUTS[0]);
    expect(existsSync(binary)).toBe(false);
    expect(existsSync(`${binary}.stale`)).toBe(true);
    expect(
      JSON.parse(await readFile(path.join(release(root), FAILURE_FILE), 'utf8')).output,
    ).toContain('E0425');
    expect(() => requireNativeBuild(root, {})).toThrow(/ne compile pas[\s\S]*E0425/);
  });

  it('build réparé : échec oublié, garde levée', async () => {
    const root = await fakeRepo();
    await ensureNativeBuild({
      repoRoot: root,
      env: {},
      cargo: 'cargo',
      build: fakeBuild(root, { ok: false }).build,
    });
    await writeFile(
      path.join(root, 'native', 'crate', 'src', 'main.rs'),
      'fn main() {}\n// fixed\n',
    );
    expect(
      (
        await ensureNativeBuild({
          repoRoot: root,
          env: {},
          cargo: 'cargo',
          build: fakeBuild(root).build,
        })
      ).status,
    ).toBe('built');
    expect(() => requireNativeBuild(root, {})).not.toThrow();
  });

  it('les trois fixtures (dont pty-fixture) font partie des sorties exigées', () => {
    expect(FIXTURE_OUTPUTS.map((f) => path.basename(f, '.exe'))).toEqual([
      'process-fixture',
      'protocol-fixture',
      'pty-fixture',
    ]);
    for (const fixture of FIXTURE_OUTPUTS) expect(REQUIRED_OUTPUTS).toContain(fixture);
  });

  it('sans cargo : sorties absentes → garde en échec ; présentes mais non prouvées à jour → refusées (M20)', async () => {
    const root = await fakeRepo();
    expect((await ensureNativeBuild({ repoRoot: root, env: {}, cargo: null })).status).toBe(
      'missing',
    );
    expect(() => requireNativeBuild(root, {})).toThrow(/Binaire natif absent/);
    await fakeBuild(root).build();
    expect((await ensureNativeBuild({ repoRoot: root, env: {}, cargo: null })).status).toBe(
      'no-cargo',
    );
    expect(existsSync(path.join(release(root), UNVERIFIED_FILE))).toBe(true);
    // Fail closed : un binaire dont la fraîcheur est inconnue n'est pas utilisé en silence.
    expect(() => requireNativeBuild(root, {})).toThrow(/ne peut pas être prouvée/);
    // Choix explicite de l'utilisateur.
    expect(() => requireNativeBuild(root, { STRIART_NATIVE_ALLOW_STALE: '1' })).not.toThrow();
    // Un build réussi lève le doute.
    await writeFile(path.join(root, 'native', 'crate', 'src', 'main.rs'), 'fn main() { 1; }\n');
    expect(
      (
        await ensureNativeBuild({
          repoRoot: root,
          env: {},
          cargo: 'cargo',
          build: fakeBuild(root).build,
        })
      ).status,
    ).toBe('built');
    expect(existsSync(path.join(release(root), UNVERIFIED_FILE))).toBe(false);
    expect(() => requireNativeBuild(root, {})).not.toThrow();
  });

  it('STRIART_NATIVE_BIN : le binaire n’est pas reconstruit, mais les FIXTURES sont construites et exigées (M20)', async () => {
    const root = await fakeRepo();
    const env = { STRIART_NATIVE_BIN: '/x/striart-native' };
    const scopes = [];
    const build = async (scope) => {
      scopes.push(scope);
      for (const rel of FIXTURE_OUTPUTS) {
        const file = path.join(release(root), rel);
        await mkdir(path.dirname(file), { recursive: true });
        await writeFile(file, 'fixture');
      }
      return { ok: true, output: '' };
    };
    // Fixtures absentes : la garde échoue même avec STRIART_NATIVE_BIN.
    expect(() => requireNativeBuild(root, env)).toThrow(/Binaire natif absent[\s\S]*fixture/);
    expect((await ensureNativeBuild({ repoRoot: root, env, cargo: 'cargo', build })).status).toBe(
      'explicit',
    );
    expect(scopes).toEqual(['examples']);
    expect(() => requireNativeBuild(root, env)).not.toThrow();
    // Sources modifiées : les fixtures sont reconstruites (jamais périmées).
    await writeFile(path.join(root, 'native', 'crate', 'src', 'main.rs'), 'fn main() { 2; }\n');
    await ensureNativeBuild({ repoRoot: root, env, cargo: 'cargo', build });
    expect(scopes).toEqual(['examples', 'examples']);
  });

  it('verrou abandonné par un process mort : récupéré', async () => {
    const root = await fakeRepo();
    const lock = path.join(root, 'native', 'target', '.striart-native-build.lock');
    await mkdir(lock, { recursive: true });
    await writeFile(path.join(lock, 'owner'), JSON.stringify({ pid: 2 ** 31 - 2, at: 0 }));
    const { build, calls } = fakeBuild(root);
    expect(
      (await ensureNativeBuild({ repoRoot: root, env: {}, cargo: 'cargo', build })).status,
    ).toBe('built');
    expect(calls.count).toBe(1);
  });

  it('verrou abandonné convoité par plusieurs vitest : un seul build, aucun double propriétaire (M20)', async () => {
    const root = await fakeRepo();
    const lock = path.join(root, 'native', 'target', '.striart-native-build.lock');
    await mkdir(lock, { recursive: true });
    await writeFile(path.join(lock, 'owner'), JSON.stringify({ pid: 2 ** 31 - 2, at: 0 }));
    // Section critique observable : deux builds simultanés seraient détectés.
    let inside = 0;
    let overlap = false;
    const calls = { count: 0 };
    const build = async () => {
      calls.count += 1;
      inside += 1;
      overlap ||= inside > 1;
      await new Promise((r) => setTimeout(r, 150));
      for (const rel of REQUIRED_OUTPUTS) {
        const file = path.join(release(root), rel);
        await mkdir(path.dirname(file), { recursive: true });
        await writeFile(file, 'binary');
      }
      inside -= 1;
      return { ok: true, output: '' };
    };
    const results = await Promise.all(
      [1, 2, 3, 4, 5, 6].map(() =>
        ensureNativeBuild({ repoRoot: root, env: {}, cargo: 'cargo', build }),
      ),
    );
    expect(overlap).toBe(false);
    expect(calls.count).toBe(1);
    expect(results.filter((r) => r.status === 'built')).toHaveLength(1);
  });

  it('retrait de binaire périmé impossible : l’échec est enregistré, jamais une exception', async () => {
    const root = await fakeRepo();
    await ensureNativeBuild({
      repoRoot: root,
      env: {},
      cargo: 'cargo',
      build: fakeBuild(root).build,
    });
    await writeFile(path.join(root, 'native', 'crate', 'src', 'main.rs'), 'fn main() { 3; }\n');
    // Une sortie « périmée » qui est un dossier non vide ne peut ni être
    // supprimée par rm({force}) sans recursive, ni... renommée vers un nom
    // occupé : on occupe `<fichier>.stale` par un dossier non vide ET le
    // fichier par un dossier non vide, rm(force) sans recursive échoue.
    const target = path.join(release(root), REQUIRED_OUTPUTS[0]);
    await rm(target, { force: true });
    await mkdir(path.join(target, 'inner'), { recursive: true });
    await mkdir(path.join(`${target}.stale`, 'inner'), { recursive: true });
    const outcome = await ensureNativeBuild({
      repoRoot: root,
      env: {},
      cargo: 'cargo',
      build: async () => ({ ok: false, output: 'boom' }),
    });
    expect(outcome.status).toBe('failed');
    const failure = JSON.parse(await readFile(path.join(release(root), FAILURE_FILE), 'utf8'));
    expect(failure.undeletable?.length ?? 0).toBeGreaterThan(0);
    expect(() => requireNativeBuild(root, {})).toThrow(/non retirés/);
  });
});

// globalSetup des projets vitest `integration` et `pack` : binaire natif
// (striart-native) et fixtures de test à jour des sources Rust, sans
// reconstruire à chaque passe (cache par empreinte, voir native-build.js).
//
// - STRIART_NATIVE_BIN défini : binaire désigné explicitement (non reconstruit),
//   mais les fixtures de test (exemples du crate) sont construites à jour ;
// - empreinte des sources inchangée depuis le dernier build réussi : aucun
//   cargo ;
// - sinon build (cargo de PATH ou de ~/.cargo/bin), une seule fois même si
//   plusieurs vitest tournent en parallèle ;
// - échec du build : la suite N'EST PAS bloquée. L'échec est enregistré, les
//   binaires périmés retirés, et seuls les tests qui exigent le natif
//   échouent — explicitement (requireNativeBuild : sortie cargo ; sinon
//   NATIVE_UNAVAILABLE de src/native.ts). Jamais de saut silencieux.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ensureNativeBuild } from './native-build.js';
import { NATIVE_RELEASE_DIR, REPO_ROOT } from './native.js';

export function findCargo() {
  const probe = spawnSync('cargo', ['--version'], { encoding: 'utf8', windowsHide: true });
  if (probe.status === 0) return 'cargo';
  const fromRustup = path.join(
    os.homedir(),
    '.cargo',
    'bin',
    process.platform === 'win32' ? 'cargo.exe' : 'cargo',
  );
  return existsSync(fromRustup) ? fromRustup : null;
}

function cargoBuild(cargo, scope = 'all') {
  // `all` : binaire et exemples ; `examples` (STRIART_NATIVE_BIN) : les
  // fixtures seules, le binaire testé étant celui de l'utilisateur.
  const targets = scope === 'examples' ? ['--examples'] : ['--bins', '--examples'];
  const result = spawnSync(cargo, ['build', '--release', '--locked', ...targets], {
    // cwd native/ : rustup y lit rust-toolchain.toml (toolchain épinglée).
    cwd: path.join(REPO_ROOT, 'native'),
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
  });
  return {
    ok: result.status === 0,
    output: `${result.stdout ?? ''}${result.stderr ?? ''}${
      result.error
        ? `
${result.error.message}`
        : ''
    }`,
  };
}

export default async function setup() {
  const cargo = findCargo();
  const outcome = await ensureNativeBuild({
    repoRoot: REPO_ROOT,
    cargo,
    build: (scope) => cargoBuild(cargo, scope),
  });
  const say = (text) => process.stderr.write(`${text}\n`);
  if (outcome.status === 'failed') {
    say(
      `⚠ Binaire natif : la compilation a échoué — les tests qui l'exigent échoueront avec la sortie cargo (npm run native:build).\n${outcome.output.slice(-4_000)}`,
    );
  } else if (outcome.status === 'no-cargo') {
    say(
      `⚠ cargo introuvable : la conformité du binaire natif existant (${NATIVE_RELEASE_DIR}) aux sources ne peut pas être prouvée — les tests qui l'exigent échoueront (STRIART_NATIVE_ALLOW_STALE=1 pour l'accepter explicitement).`,
    );
  } else if (outcome.status === 'missing') {
    say(
      '⚠ Binaire natif absent et cargo introuvable : les tests qui l’exigent échoueront. Installer Rust (https://rustup.rs) puis « npm run native:build ».',
    );
  }
}

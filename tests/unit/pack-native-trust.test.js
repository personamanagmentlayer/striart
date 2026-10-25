// Ancre de confiance du binaire natif (S-I5 / N-I1 / N-I2 / M19) — parties pures :
// garde --ephemeral-signing-key, clé épinglée cohérente avec la clé publique du
// dépôt, manifeste marqué, lecture de la version du crate.
import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  assertEphemeralOnlyInDryRun,
  buildNativeManifest,
  packRelease,
  parseCli,
  readNativeCrateVersion,
  selectNativePlatforms,
} from '../../scripts/pack.ts';
import { PINNED_NATIVE_KEY_IDS, NATIVE_KEY_ID_RE } from '../../src/native.ts';
import { formatKeyId, parsePublicKey } from '../../src/native-signature-minisign.ts';

describe('--ephemeral-signing-key interdit hors --dry-run (N-I1)', () => {
  const refused = expect.objectContaining({
    code: 'PACK_EPHEMERAL_REQUIRES_DRY_RUN',
    usage: true,
  });

  it('la ligne de commande refuse la clé jetable sans --dry-run (sortie 2)', () => {
    expect(() => parseCli(['--native-dir', 'x', '--ephemeral-signing-key'])).toThrow(refused);
    expect(parseCli(['--native-dir', 'x', '--ephemeral-signing-key', '--dry-run'])).toMatchObject({
      ephemeralSigningKey: true,
      dryRun: true,
    });
  });

  it('la garde est aussi celle de l’API (packRelease) : refus AVANT tout travail', async () => {
    expect(() => assertEphemeralOnlyInDryRun(true, false)).toThrow(refused);
    expect(() => assertEphemeralOnlyInDryRun(true, true)).not.toThrow();
    expect(() => assertEphemeralOnlyInDryRun(false, false)).not.toThrow();
    await expect(
      packRelease(
        {
          outDir: os.tmpdir(),
          dryRun: false,
          allowDirty: true,
          keepStaging: false,
          nativeDir: null, // jamais atteint : la garde passe avant
          nativePlatforms: null,
          signingScheme: 'minisign',
          ephemeralSigningKey: true,
        },
        () => undefined,
      ),
    ).rejects.toThrow(refused);
  });

  it('clé jetable et clé alternative sont incompatibles', () => {
    expect(() =>
      parseCli(['--ephemeral-signing-key', '--dry-run', '--signing-public-key', 'k.pub']),
    ).toThrow(expect.objectContaining({ code: 'PACK_USAGE', usage: true }));
    expect(parseCli(['--signing-public-key', 'k.pub']).signingPublicKey).toBe(
      path.resolve('k.pub'),
    );
  });
});

describe('clé de confiance épinglée dans le code', () => {
  it('le keyId épinglé est celui de native/keys/minisign.pub du dépôt (aucune dérive)', async () => {
    const pub = await readFile(new URL('../../native/keys/minisign.pub', import.meta.url), 'utf8');
    const keyId = formatKeyId(parsePublicKey(pub).keyId);
    expect(PINNED_NATIVE_KEY_IDS).toContain(keyId);
    for (const id of PINNED_NATIVE_KEY_IDS) expect(id).toMatch(NATIVE_KEY_ID_RE);
  });
});

describe('manifeste natif : marqueur ephemeral et version du crate', () => {
  const platforms = selectNativePlatforms(['linux-x64']);
  const artifacts = platforms.map((platform) => ({
    platform,
    source: '/x',
    sha256: 'a'.repeat(64),
    size: 10,
  }));

  it('un manifeste destiné à une clé jetable le dit (signé avec lui)', () => {
    const manifest = buildNativeManifest('0.11.0', artifacts, {
      nativeVersion: '0.1.0',
      ephemeral: true,
    });
    expect(manifest.ephemeral).toBe(true);
    expect(JSON.stringify(manifest)).toContain('"ephemeral":true');
    expect(
      buildNativeManifest('0.11.0', artifacts, { nativeVersion: '0.1.0' }).ephemeral,
    ).toBeUndefined();
  });

  it('readNativeCrateVersion lit le Cargo.toml du crate, et refuse son absence', async () => {
    expect(await readNativeCrateVersion()).toMatch(/^\d+\.\d+\.\d+/);
    const dir = await mkdtemp(path.join(os.tmpdir(), 'striart-cargo-'));
    try {
      const toml = path.join(dir, 'Cargo.toml');
      await writeFile(toml, '[package]\nname = "x"\nversion = "3.4.5"\n');
      expect(await readNativeCrateVersion(toml)).toBe('3.4.5');
      await writeFile(toml, '[package]\nname = "x"\n');
      await expect(readNativeCrateVersion(toml)).rejects.toThrow(
        expect.objectContaining({ code: 'PACK_NATIVE_VERSION_UNREADABLE' }),
      );
      await expect(readNativeCrateVersion(path.join(dir, 'absent.toml'))).rejects.toThrow(
        expect.objectContaining({ code: 'PACK_NATIVE_VERSION_UNREADABLE' }),
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

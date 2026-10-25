// scripts/native-keygen.ts : paire de clés de signature — atomicité (M21),
// clé privée jamais écrasée ni écrite dans le dépôt, chiffrement.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { KeygenError, generateSigningKeys } from '../../scripts/native-keygen.ts';
import { getSignatureScheme } from '../../src/native-signature.ts';

const FAST_KDF = { opslimit: 32_768n, memlimit: 16_777_216n };
const scheme = getSignatureScheme('minisign');

describe('native-keygen', () => {
  let work;
  let repo;
  let outside;

  beforeEach(async () => {
    work = await mkdtemp(path.join(os.tmpdir(), 'striart-keygen-'));
    repo = path.join(work, 'repo');
    outside = path.join(work, 'secrets');
    await mkdir(path.join(repo, 'native', 'keys'), { recursive: true });
    await mkdir(outside, { recursive: true });
  });
  afterEach(async () => {
    await chmod(path.join(repo, 'native', 'keys'), 0o755).catch(() => undefined);
    await rm(work, { recursive: true, force: true, maxRetries: 3 });
  });

  it('écrit la paire : publique dans le dépôt, privée dehors, cohérentes', async () => {
    const secretOut = path.join(outside, 'sign.key');
    const result = await generateSigningKeys({
      repoRoot: repo,
      secretOut,
      password: null,
    });
    const publicKey = await readFile(path.join(repo, 'native', 'keys', 'minisign.pub'), 'utf8');
    const secret = await readFile(secretOut, 'utf8');
    expect(result.keyId).toMatch(/^[0-9A-F]{16}$/);
    expect(result.encrypted).toBe(false);
    const signed = scheme.sign(Buffer.from('x'), { key: secret, password: null }, publicKey, 'x');
    expect(signed.keyId).toBe(result.keyId);
    if (process.platform !== 'win32') {
      expect((await stat(secretOut)).mode & 0o777).toBe(0o600);
    }
  });

  it('clé privée chiffrée : le mot de passe est exigé pour signer', async () => {
    const secretOut = path.join(outside, 'enc.key');
    const result = await generateSigningKeys({
      repoRoot: repo,
      secretOut,
      password: 'correct horse',
      kdf: FAST_KDF,
    });
    expect(result.encrypted).toBe(true);
    const publicKey = await readFile(path.join(repo, 'native', 'keys', 'minisign.pub'), 'utf8');
    const secret = await readFile(secretOut, 'utf8');
    expect(secret).toContain('encrypted secret key');
    expect(() =>
      scheme.sign(Buffer.from('x'), { key: secret, password: 'wrong' }, publicKey, 'x'),
    ).toThrow();
    expect(
      scheme.sign(Buffer.from('x'), { key: secret, password: 'correct horse' }, publicKey, 'x')
        .keyId,
    ).toBe(result.keyId);
  });

  it('refus : secret dans le dépôt, chemin relatif, secret existant, clé publique existante sans --rotate', async () => {
    await expect(
      generateSigningKeys({ repoRoot: repo, secretOut: path.join(repo, 'k.key'), password: null }),
    ).rejects.toThrow(/jamais être écrite dans le dépôt/);
    await expect(
      generateSigningKeys({ repoRoot: repo, secretOut: 'k.key', password: null }),
    ).rejects.toThrow(expect.objectContaining({ usage: true }));
    const existing = path.join(outside, 'exists.key');
    await writeFile(existing, 'precieux');
    await expect(
      generateSigningKeys({ repoRoot: repo, secretOut: existing, password: null }),
    ).rejects.toThrow(/jamais écrasé/);
    expect(await readFile(existing, 'utf8')).toBe('precieux');
    await generateSigningKeys({
      repoRoot: repo,
      secretOut: path.join(outside, 'a.key'),
      password: null,
    });
    await expect(
      generateSigningKeys({
        repoRoot: repo,
        secretOut: path.join(outside, 'b.key'),
        password: null,
      }),
    ).rejects.toThrow(/--rotate/);
    const rotated = await generateSigningKeys({
      repoRoot: repo,
      secretOut: path.join(outside, 'c.key'),
      password: null,
      rotate: true,
    });
    expect(rotated.keyId).toMatch(/^[0-9A-F]{16}$/);
  });

  it('M21 : si la clé publique ne peut pas être écrite, AUCUN secret en clair ne subsiste', async () => {
    // native/keys est un FICHIER : mkdir/écriture de la clé publique échoue.
    await rm(path.join(repo, 'native', 'keys'), { recursive: true });
    await writeFile(path.join(repo, 'native', 'keys'), 'pas un dossier');
    const secretOut = path.join(outside, 'orphan.key');
    const error = await generateSigningKeys({ repoRoot: repo, secretOut, password: null }).then(
      () => null,
      (e) => e,
    );
    expect(error).toBeInstanceOf(KeygenError);
    expect(error.message).toMatch(/rien n'a été créé/);
    await expect(stat(secretOut)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

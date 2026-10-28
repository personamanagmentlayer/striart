import { describe, expect, it } from 'vitest';
import { createHash, sign as cryptoSign } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import {
  blake2b,
  formatKeyId,
  generateMinisignKeyPair,
  minisign,
  parsePublicKey,
  parseSecretKey,
  scryptParams,
} from '../../src/native-signature-minisign.ts';
import {
  DEFAULT_SIGNATURE_SCHEME,
  getSignatureScheme,
  publicKeyPath,
  signatureSchemeNames,
} from '../../src/native-signature.ts';

const fixture = (name) =>
  readFile(fileURLToPath(new URL(`../fixtures/minisign/${name}`, import.meta.url)));

describe('registre des schémas de signature', () => {
  it('minisign par défaut ; un nom inconnu ou mal formé ne résout rien', () => {
    expect(DEFAULT_SIGNATURE_SCHEME).toBe('minisign');
    expect(signatureSchemeNames()).toEqual(['minisign']);
    expect(getSignatureScheme('minisign')).toBe(minisign);
    for (const name of ['cosign', 'none', '', '../x', 'MiniSign']) {
      expect(getSignatureScheme(name)).toBeNull();
    }
  });

  it('clé publique par schéma, jamais un chemin construit depuis un nom invalide', () => {
    expect(publicKeyPath('minisign')).toBe('native/keys/minisign.pub');
    expect(() => publicKeyPath('../etc/passwd')).toThrow();
  });
});

describe('BLAKE2b (RFC 7693)', () => {
  it('vecteur de référence BLAKE2b-256("abc")', () => {
    expect(blake2b(Buffer.from('abc'), 32).toString('hex')).toBe(
      'bddd813c634239723171ef3fee98579b94964e3bb1cb3e427262c8c068d52319',
    );
  });

  it('BLAKE2b-512 identique à celui d’OpenSSL, aux frontières de bloc', () => {
    for (const n of [0, 1, 127, 128, 129, 255, 256, 1000]) {
      const data = Buffer.alloc(n, n % 251);
      expect(blake2b(data, 64).equals(createHash('blake2b512').update(data).digest())).toBe(true);
    }
  });

  it('refuse une longueur de sortie hors 1..64', () => {
    expect(() => blake2b(Buffer.alloc(1), 0)).toThrow(RangeError);
    expect(() => blake2b(Buffer.alloc(1), 65)).toThrow(RangeError);
  });
});

describe('paramètres scrypt de libsodium (pickparams)', () => {
  it('défauts de minisign (2^25, 1 Gio) → N=2^20, r=8, p=1', () => {
    expect(scryptParams(33_554_432n, 1_073_741_824n)).toEqual({ N: 2 ** 20, r: 8, p: 1 });
  });
  it('limites de rsign (2^20, 32 Mio) → N=2^15, r=8, p=1', () => {
    expect(scryptParams(1_048_576n, 33_554_432n)).toEqual({ N: 2 ** 15, r: 8, p: 1 });
  });
});

describe('interopérabilité avec l’outil minisign (vecteurs produits par rsign2)', () => {
  it('vérifie une signature préhachée produite par rsign2', async () => {
    const result = minisign.verify(
      await fixture('data.txt'),
      (await fixture('data.txt.minisig')).toString('utf8'),
      (await fixture('rsign.pub')).toString('utf8'),
    );
    expect(result.keyId).toBe('743C9FB8D0C304A7');
  });

  it('déchiffre une clé privée rsign2 (scrypt, mot de passe vide) et signe avec', async () => {
    const publicKey = (await fixture('rsign.pub')).toString('utf8');
    const secret = {
      key: (await fixture('rsign-empty-password-TEST-ONLY.key')).toString('utf8'),
      password: '',
    };
    const data = Buffer.from('payload');
    const { signature } = minisign.sign(data, secret, publicKey, 'payload.bin');
    expect(minisign.verify(data, signature, publicKey).keyId).toBe('743C9FB8D0C304A7');
  });
});

describe('minisign : signature et vérification', () => {
  const pair = generateMinisignKeyPair();
  const secret = { key: pair.secretKey, password: null };
  const data = Buffer.from('{"schemaVersion":1}\n');
  const { signature } = minisign.sign(data, secret, pair.publicKey, 'native-manifest.json');

  it('aller-retour, identifiant de clé au format minisign', () => {
    expect(minisign.verify(data, signature, pair.publicKey)).toEqual({ keyId: pair.keyId });
    expect(pair.keyId).toBe(formatKeyId(parsePublicKey(pair.publicKey).keyId));
    expect(signature).toMatch(/trusted comment: timestamp:\d+\tfile:native-manifest\.json\thashed/);
  });

  it('données modifiées : refus', () => {
    expect(() =>
      minisign.verify(Buffer.from('{"schemaVersion":2}\n'), signature, pair.publicKey),
    ).toThrow(/does not match/);
  });

  it('commentaire de confiance modifié : refus (signature globale)', () => {
    const forged = signature.replace('file:native-manifest.json', 'file:other.json');
    expect(() => minisign.verify(data, forged, pair.publicKey)).toThrow(/trusted comment/);
  });

  it('autre clé publique : refus nommant les deux clés', () => {
    const other = generateMinisignKeyPair();
    expect(() => minisign.verify(data, signature, other.publicKey)).toThrow(/signed by key/);
  });

  it('signature mal formée : refus', () => {
    expect(() => minisign.verify(data, 'garbage', pair.publicKey)).toThrow();
    const lines = signature.split('\n');
    lines[1] = `${lines[1].slice(0, -4)}AAAA`;
    expect(() => minisign.verify(data, lines.join('\n'), pair.publicKey)).toThrow();
  });

  it('signature historique non préhachée (« Ed ») acceptée', () => {
    const parsed = parsePublicKey(pair.publicKey);
    const { seed } = parseSecretKey(pair.secretKey, null);
    const jwkKey = {
      key: {
        kty: 'OKP',
        crv: 'Ed25519',
        d: seed.toString('base64url'),
        x: parsed.key.toString('base64url'),
      },
      format: 'jwk',
    };
    const raw = cryptoSign(null, data, jwkKey);
    const trusted = 'timestamp:1\tfile:x';
    const global = cryptoSign(null, Buffer.concat([raw, Buffer.from(trusted)]), jwkKey);
    const legacy =
      `untrusted comment: legacy\n${Buffer.concat([Buffer.from('Ed'), parsed.keyId, raw]).toString('base64')}\n` +
      `trusted comment: ${trusted}\n${global.toString('base64')}\n`;
    expect(minisign.verify(data, legacy, pair.publicKey).keyId).toBe(pair.keyId);
  });

  it('signer avec une clé qui n’est pas la clé publiée : refus', () => {
    const other = generateMinisignKeyPair();
    expect(() => minisign.sign(data, secret, other.publicKey, 'x')).toThrow(/not the published/);
  });

  it('clé privée chiffrée : mot de passe requis, mauvais mot de passe détecté', () => {
    const encrypted = generateMinisignKeyPair({
      password: 'pw',
      opslimit: 32_768n,
      memlimit: 16_777_216n,
    });
    const ok = minisign.sign(
      data,
      { key: encrypted.secretKey, password: 'pw' },
      encrypted.publicKey,
      'x',
    );
    expect(minisign.verify(data, ok.signature, encrypted.publicKey).keyId).toBe(encrypted.keyId);
    expect(() => parseSecretKey(encrypted.secretKey, null)).toThrow(/password is required/);
    expect(() => parseSecretKey(encrypted.secretKey, 'bad')).toThrow(/checksum mismatch/);
  });

  it('paire jetable du registre (--ephemeral-signing-key) utilisable telle quelle', () => {
    const ephemeral = minisign.generateKeyPair();
    const { signature: s } = minisign.sign(data, ephemeral.secret, ephemeral.publicKey, 'x');
    expect(() => minisign.verify(data, s, ephemeral.publicKey)).not.toThrow();
  });
});

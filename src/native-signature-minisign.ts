/**
 * Schéma de signature `minisign` (Ed25519) — format de Frank Denis
 * (https://jedisct1.github.io/minisign/), lisible et produit par l'outil
 * `minisign` et par `rsign2` : une clé générée ou une signature produite
 * ailleurs se vérifie ici, et réciproquement.
 *
 * Tout passe par node:crypto (Ed25519, BLAKE2b-512, scrypt) : aucune
 * dépendance. Seul BLAKE2b-256 (somme de contrôle de la clé privée) n'est pas
 * exposé par OpenSSL dans Node : il est implémenté ici (RFC 7693), croisé en
 * test avec le BLAKE2b-512 natif.
 *
 * Formats (base64 standard, une ligne chacun) :
 * - clé publique : `"Ed"` ‖ keyId (8) ‖ pk (32) ;
 * - signature : `"ED"` (préhachée BLAKE2b-512, défaut) ou `"Ed"` (historique)
 *   ‖ keyId (8) ‖ sig (64), puis `trusted comment: …`, puis la signature
 *   globale Ed25519 de (sig ‖ commentaire de confiance) ;
 * - clé privée : `"Ed"` ‖ kdf (`"Sc"` scrypt ou `\0\0` en clair) ‖ `"B2"` ‖
 *   sel (32) ‖ opslimit (8 LE) ‖ memlimit (8 LE) ‖ [keyId (8) ‖ sk (64) ‖
 *   somme BLAKE2b-256 (32)] — ce dernier bloc XORé au flux scrypt si chiffrée.
 */
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  scryptSync,
  sign as cryptoSign,
  verify as cryptoVerify,
} from 'node:crypto';
import type { SignatureScheme, SigningSecret } from './native-signature.ts';

const UNTRUSTED = 'untrusted comment: ';
const TRUSTED = 'trusted comment: ';
const KEY_ALG = 'Ed';
const SECRET_BLOCK_LENGTH = 8 + 64 + 32;
const SECRET_KEY_LENGTH = 2 + 2 + 2 + 32 + 8 + 8 + SECRET_BLOCK_LENGTH;

export interface MinisignPublicKey {
  keyId: Buffer;
  key: Buffer;
}

/** Identifiant affiché par minisign : l'entier 64 bits petit-boutiste, en hexadécimal. */
export function formatKeyId(keyId: Buffer): string {
  return Buffer.from(keyId).reverse().toString('hex').toUpperCase();
}

/** Base64 standard strict (alphabet, bourrage, longueur attendue). */
function decodeBase64(text: string, length: number, what: string): Buffer {
  const trimmed = text.trim();
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(trimmed) || trimmed.length % 4 !== 0) {
    throw new Error(`${what}: invalid base64`);
  }
  const bytes = Buffer.from(trimmed, 'base64');
  if (bytes.length !== length) {
    throw new Error(`${what}: expected ${length} bytes, got ${bytes.length}`);
  }
  return bytes;
}

function lines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0);
}

export function parsePublicKey(text: string): MinisignPublicKey {
  const [comment, blob] = lines(text);
  if (comment === undefined || blob === undefined || !comment.startsWith(UNTRUSTED)) {
    throw new Error('minisign public key: expected an untrusted comment then the key');
  }
  const bytes = decodeBase64(blob, 42, 'minisign public key');
  if (bytes.subarray(0, 2).toString('latin1') !== KEY_ALG) {
    throw new Error('minisign public key: unsupported algorithm');
  }
  return { keyId: bytes.subarray(2, 10), key: bytes.subarray(10, 42) };
}

function ed25519PublicKey(raw: Buffer) {
  return createPublicKey({
    key: { kty: 'OKP', crv: 'Ed25519', x: raw.toString('base64url') },
    format: 'jwk',
  });
}

function ed25519PrivateKey(seed: Buffer, publicKey: Buffer) {
  return createPrivateKey({
    key: {
      kty: 'OKP',
      crv: 'Ed25519',
      d: seed.toString('base64url'),
      x: publicKey.toString('base64url'),
    },
    format: 'jwk',
  });
}

function blake2b512(data: Buffer): Buffer {
  return createHash('blake2b512').update(data).digest();
}

interface ParsedSignature {
  prehashed: boolean;
  keyId: Buffer;
  signature: Buffer;
  trustedComment: string;
  globalSignature: Buffer;
}

export function parseSignature(text: string): ParsedSignature {
  const [comment, blob, trusted, global] = lines(text);
  if (
    comment === undefined ||
    blob === undefined ||
    trusted === undefined ||
    global === undefined ||
    !comment.startsWith(UNTRUSTED) ||
    !trusted.startsWith(TRUSTED)
  ) {
    throw new Error(
      'minisign signature: expected untrusted comment, signature, trusted comment, global signature',
    );
  }
  const bytes = decodeBase64(blob, 74, 'minisign signature');
  const alg = bytes.subarray(0, 2).toString('latin1');
  if (alg !== 'ED' && alg !== 'Ed') {
    throw new Error('minisign signature: unsupported algorithm');
  }
  return {
    prehashed: alg === 'ED',
    keyId: bytes.subarray(2, 10),
    signature: bytes.subarray(10, 74),
    trustedComment: trusted.slice(TRUSTED.length),
    globalSignature: decodeBase64(global, 64, 'minisign global signature'),
  };
}

function verifyMinisign(data: Buffer, signatureText: string, publicKeyText: string) {
  const publicKey = parsePublicKey(publicKeyText);
  const parsed = parseSignature(signatureText);
  if (!parsed.keyId.equals(publicKey.keyId)) {
    throw new Error(
      `minisign: signed by key ${formatKeyId(parsed.keyId)}, expected ${formatKeyId(publicKey.keyId)}`,
    );
  }
  const key = ed25519PublicKey(publicKey.key);
  const message = parsed.prehashed ? blake2b512(data) : data;
  if (!cryptoVerify(null, message, key, parsed.signature)) {
    throw new Error('minisign: signature does not match the data');
  }
  const global = Buffer.concat([parsed.signature, Buffer.from(parsed.trustedComment, 'utf8')]);
  if (!cryptoVerify(null, global, key, parsed.globalSignature)) {
    throw new Error('minisign: trusted comment signature is invalid');
  }
  return { keyId: formatKeyId(publicKey.keyId) };
}

// ── BLAKE2b (RFC 7693), pour la somme de contrôle des clés privées ────────

const MASK64 = (1n << 64n) - 1n;
const BLAKE2B_IV = [
  0x6a09e667f3bcc908n,
  0xbb67ae8584caa73bn,
  0x3c6ef372fe94f82bn,
  0xa54ff53a5f1d36f1n,
  0x510e527fade682d1n,
  0x9b05688c2b3e6c1fn,
  0x1f83d9abfb41bd6bn,
  0x5be0cd19137e2179n,
];
const SIGMA = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
  [14, 10, 4, 8, 9, 15, 13, 6, 1, 12, 0, 2, 11, 7, 5, 3],
  [11, 8, 12, 0, 5, 2, 15, 13, 10, 14, 3, 6, 7, 1, 9, 4],
  [7, 9, 3, 1, 13, 12, 11, 14, 2, 6, 5, 10, 4, 0, 15, 8],
  [9, 0, 5, 7, 2, 4, 10, 15, 14, 1, 11, 12, 6, 8, 3, 13],
  [2, 12, 6, 10, 0, 11, 8, 3, 4, 13, 7, 5, 15, 14, 1, 9],
  [12, 5, 1, 15, 14, 13, 4, 10, 0, 7, 6, 3, 9, 2, 8, 11],
  [13, 11, 7, 14, 12, 1, 3, 9, 5, 0, 15, 4, 8, 6, 2, 10],
  [6, 15, 14, 9, 11, 3, 0, 8, 12, 2, 13, 7, 1, 4, 10, 5],
  [10, 2, 8, 4, 7, 6, 1, 5, 15, 11, 9, 14, 3, 12, 13, 0],
];

const rotr64 = (x: bigint, n: bigint) => ((x >> n) | (x << (64n - n))) & MASK64;

function blake2bCompress(h: bigint[], block: Buffer, counter: bigint, last: boolean): void {
  const v = [...h, ...BLAKE2B_IV];
  v[12] ^= counter & MASK64;
  v[13] ^= counter >> 64n;
  if (last) v[14] ^= MASK64;
  const m = Array.from({ length: 16 }, (_, i) => block.readBigUInt64LE(i * 8));
  const g = (a: number, b: number, c: number, d: number, x: bigint, y: bigint) => {
    v[a] = (v[a] + v[b] + x) & MASK64;
    v[d] = rotr64(v[d] ^ v[a], 32n);
    v[c] = (v[c] + v[d]) & MASK64;
    v[b] = rotr64(v[b] ^ v[c], 24n);
    v[a] = (v[a] + v[b] + y) & MASK64;
    v[d] = rotr64(v[d] ^ v[a], 16n);
    v[c] = (v[c] + v[d]) & MASK64;
    v[b] = rotr64(v[b] ^ v[c], 63n);
  };
  for (let round = 0; round < 12; round += 1) {
    const s = SIGMA[round % 10];
    g(0, 4, 8, 12, m[s[0]], m[s[1]]);
    g(1, 5, 9, 13, m[s[2]], m[s[3]]);
    g(2, 6, 10, 14, m[s[4]], m[s[5]]);
    g(3, 7, 11, 15, m[s[6]], m[s[7]]);
    g(0, 5, 10, 15, m[s[8]], m[s[9]]);
    g(1, 6, 11, 12, m[s[10]], m[s[11]]);
    g(2, 7, 8, 13, m[s[12]], m[s[13]]);
    g(3, 4, 9, 14, m[s[14]], m[s[15]]);
  }
  for (let i = 0; i < 8; i += 1) h[i] ^= v[i] ^ v[i + 8];
}

/** BLAKE2b sans clé, sortie de `outLength` octets (1 à 64). */
export function blake2b(data: Buffer, outLength: number): Buffer {
  if (!Number.isInteger(outLength) || outLength < 1 || outLength > 64) {
    throw new RangeError('blake2b: output length must be 1..64');
  }
  const h = [...BLAKE2B_IV];
  h[0] ^= 0x01010000n ^ BigInt(outLength);
  const blocks = Math.max(1, Math.ceil(data.length / 128));
  for (let i = 0; i < blocks; i += 1) {
    const block = Buffer.alloc(128);
    data.copy(block, 0, i * 128, Math.min(data.length, (i + 1) * 128));
    const last = i === blocks - 1;
    const counter = BigInt(last ? data.length : (i + 1) * 128);
    blake2bCompress(h, block, counter, last);
  }
  const out = Buffer.alloc(64);
  h.forEach((word, i) => out.writeBigUInt64LE(word, i * 8));
  return out.subarray(0, outLength);
}

// ── Clés privées ──────────────────────────────────────────────────────────

/**
 * Paramètres scrypt de libsodium (`crypto_pwhash_scryptsalsa208sha256`,
 * fonction `pickparams`) — ceux que minisign dérive de opslimit/memlimit.
 */
export function scryptParams(
  opslimit: bigint,
  memlimit: bigint,
): { N: number; r: number; p: number } {
  const ops = opslimit < 32768n ? 32768n : opslimit;
  const r = 8n;
  let nLog2 = 1n;
  let p: bigint;
  const pickN = (maxN: bigint) => {
    for (nLog2 = 1n; nLog2 < 63n; nLog2 += 1n) {
      if (1n << nLog2 > maxN / 2n) break;
    }
  };
  if (ops < memlimit / 32n) {
    p = 1n;
    pickN(ops / (r * 4n));
  } else {
    pickN(memlimit / (r * 128n));
    let maxrp = ops / 4n / (1n << nLog2);
    if (maxrp > 0x3fffffffn) maxrp = 0x3fffffffn;
    p = maxrp / r;
  }
  return { N: Number(1n << nLog2), r: Number(r), p: Number(p) };
}

function scryptStream(password: string, salt: Buffer, opslimit: bigint, memlimit: bigint): Buffer {
  const { N, r, p } = scryptParams(opslimit, memlimit);
  return scryptSync(Buffer.from(password, 'utf8'), salt, SECRET_BLOCK_LENGTH, {
    N,
    r,
    p,
    maxmem: 128 * N * r * p + 32 * 1024 * 1024,
  });
}

function xor(a: Buffer, b: Buffer): Buffer {
  const out = Buffer.alloc(a.length);
  for (let i = 0; i < a.length; i += 1) out[i] = a[i] ^ b[i];
  return out;
}

interface SecretKey {
  keyId: Buffer;
  seed: Buffer;
  publicKey: Buffer;
}

export function parseSecretKey(text: string, password: string | null): SecretKey {
  const [comment, blob] = lines(text);
  if (comment === undefined || blob === undefined || !comment.startsWith(UNTRUSTED)) {
    throw new Error('minisign secret key: expected an untrusted comment then the key');
  }
  const bytes = decodeBase64(blob, SECRET_KEY_LENGTH, 'minisign secret key');
  const sigAlg = bytes.subarray(0, 2);
  const kdfAlg = bytes.subarray(2, 4).toString('latin1');
  const checksumAlg = bytes.subarray(4, 6).toString('latin1');
  if (sigAlg.toString('latin1') !== KEY_ALG || checksumAlg !== 'B2') {
    throw new Error('minisign secret key: unsupported algorithm');
  }
  const salt = bytes.subarray(6, 38);
  const opslimit = bytes.readBigUInt64LE(38);
  const memlimit = bytes.readBigUInt64LE(46);
  let block: Buffer = bytes.subarray(54);
  if (kdfAlg === 'Sc') {
    if (password === null) {
      throw new Error('minisign secret key: encrypted, a password is required');
    }
    block = xor(block, scryptStream(password, salt, opslimit, memlimit));
  } else if (kdfAlg !== '\0\0') {
    throw new Error('minisign secret key: unsupported key derivation');
  }
  const keyId = block.subarray(0, 8);
  const secret = block.subarray(8, 72);
  const checksum = block.subarray(72, 104);
  const expected = blake2b(Buffer.concat([sigAlg, keyId, secret]), 32);
  if (!checksum.equals(expected)) {
    throw new Error('minisign secret key: checksum mismatch (wrong password or corrupted key)');
  }
  const seed = secret.subarray(0, 32);
  const publicKey = secret.subarray(32, 64);
  // La moitié publique stockée doit être celle que la graine engendre.
  const derived = Buffer.from(
    createPublicKey(ed25519PrivateKey(seed, publicKey)).export({ format: 'jwk' }).x ?? '',
    'base64url',
  );
  if (!derived.equals(publicKey)) {
    throw new Error('minisign secret key: inconsistent key material');
  }
  return { keyId, seed, publicKey };
}

/**
 * Nouvelle paire de clés au format minisign. `password` nul : clé privée en
 * clair (protégée par le coffre de secrets de la CI, comme `minisign -W`).
 * Paramètres scrypt par défaut : ceux de minisign (opslimit 2^25, memlimit
 * 1 Gio) — surchargeables pour les tests.
 */
export function generateMinisignKeyPair({
  password = null,
  opslimit = 33_554_432n,
  memlimit = 1_073_741_824n,
}: { password?: string | null; opslimit?: bigint; memlimit?: bigint } = {}): {
  publicKey: string;
  secretKey: string;
  keyId: string;
} {
  const { privateKey } = generateKeyPairSync('ed25519');
  const jwk = privateKey.export({ format: 'jwk' });
  const seed = Buffer.from(jwk.d ?? '', 'base64url');
  const pk = Buffer.from(jwk.x ?? '', 'base64url');
  const keyId = randomBytes(8);
  const sigAlg = Buffer.from(KEY_ALG, 'latin1');
  const secret = Buffer.concat([seed, pk]);
  const checksum = blake2b(Buffer.concat([sigAlg, keyId, secret]), 32);
  const salt = randomBytes(32);
  let block: Buffer = Buffer.concat([keyId, secret, checksum]);
  const limits = Buffer.alloc(16);
  if (password) {
    limits.writeBigUInt64LE(opslimit, 0);
    limits.writeBigUInt64LE(memlimit, 8);
    block = xor(block, scryptStream(password, salt, opslimit, memlimit));
  }
  const secretBlob = Buffer.concat([
    sigAlg,
    Buffer.from(password ? 'Sc' : '\0\0', 'latin1'),
    Buffer.from('B2', 'latin1'),
    salt,
    limits,
    block,
  ]);
  const id = formatKeyId(keyId);
  return {
    publicKey: `${UNTRUSTED}minisign public key ${id}\n${Buffer.concat([sigAlg, keyId, pk]).toString('base64')}\n`,
    secretKey: `${UNTRUSTED}minisign ${password ? 'encrypted ' : ''}secret key\n${secretBlob.toString('base64')}\n`,
    keyId: id,
  };
}

/**
 * Horodatage de la signature : SOURCE_DATE_EPOCH (convention reproducible-builds,
 * entier de secondes) s'il est défini, sinon l'heure courante. Fixé à la date du
 * commit par la CI de release, il rend l'archive reproductible (Ed25519 est
 * déterministe). Une valeur mal formée est refusée, jamais ignorée.
 */
export function signingTimestamp(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.SOURCE_DATE_EPOCH;
  if (raw === undefined || raw === '') return Math.floor(Date.now() / 1000);
  if (!/^\d{1,12}$/.test(raw)) {
    throw new Error('SOURCE_DATE_EPOCH must be an integer number of seconds');
  }
  return Number(raw);
}

function signMinisign(
  data: Buffer,
  secret: SigningSecret,
  publicKeyText: string,
  fileName: string,
  timestamp = signingTimestamp(),
) {
  const key = parseSecretKey(secret.key, secret.password);
  const expected = parsePublicKey(publicKeyText);
  if (!expected.keyId.equals(key.keyId) || !expected.key.equals(key.publicKey)) {
    throw new Error(
      `minisign: the signing key (${formatKeyId(key.keyId)}) is not the published public key (${formatKeyId(expected.keyId)})`,
    );
  }
  if (/[\r\n]/.test(fileName)) throw new Error('minisign: file name must be a single line');
  const privateKey = ed25519PrivateKey(key.seed, key.publicKey);
  const signature = cryptoSign(null, blake2b512(data), privateKey);
  const trustedComment = `timestamp:${timestamp}\tfile:${fileName}\thashed`;
  const globalSignature = cryptoSign(
    null,
    Buffer.concat([signature, Buffer.from(trustedComment, 'utf8')]),
    privateKey,
  );
  const blob = Buffer.concat([Buffer.from('ED', 'latin1'), key.keyId, signature]);
  return {
    signature:
      `${UNTRUSTED}signature from minisign secret key\n${blob.toString('base64')}\n` +
      `${TRUSTED}${trustedComment}\n${globalSignature.toString('base64')}\n`,
    keyId: formatKeyId(key.keyId),
  };
}

export const minisign: SignatureScheme = {
  name: 'minisign',
  verify: verifyMinisign,
  sign: (data, secret, publicKey, fileName) => signMinisign(data, secret, publicKey, fileName),
  generateKeyPair: (options = {}) => {
    const password = options.password ? options.password : null;
    const pair = generateMinisignKeyPair({ password, ...options.kdf });
    return { publicKey: pair.publicKey, secret: { key: pair.secretKey, password } };
  },
};

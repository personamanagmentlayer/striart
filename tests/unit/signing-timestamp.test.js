import { describe, expect, it } from 'vitest';
import { minisign, signingTimestamp } from '../../src/native-signature-minisign.ts';

describe('horodatage de signature (archive reproductible)', () => {
  it('SOURCE_DATE_EPOCH fixe l’horodatage ; absent = heure courante', () => {
    expect(signingTimestamp({ SOURCE_DATE_EPOCH: '1700000000' })).toBe(1700000000);
    const now = Math.floor(Date.now() / 1000);
    expect(Math.abs(signingTimestamp({}) - now)).toBeLessThan(5);
  });

  it('une valeur mal formée est refusée (jamais ignorée)', () => {
    for (const bad of ['abc', '1.5', '-1', '12345678901234'])
      expect(() => signingTimestamp({ SOURCE_DATE_EPOCH: bad })).toThrow(/SOURCE_DATE_EPOCH/);
  });

  it('deux signatures du même manifeste avec la même date sont identiques', () => {
    const { publicKey, secret } = minisign.generateKeyPair();
    const data = Buffer.from('manifest');
    const prev = process.env.SOURCE_DATE_EPOCH;
    process.env.SOURCE_DATE_EPOCH = '1700000000';
    try {
      const a = minisign.sign(data, secret, publicKey, 'manifest.json');
      const b = minisign.sign(data, secret, publicKey, 'manifest.json');
      expect(a.signature).toBe(b.signature);
      expect(a.signature).toContain('timestamp:1700000000');
      expect(minisign.verify(data, a.signature, publicKey).keyId).toBe(a.keyId);
    } finally {
      if (prev === undefined) delete process.env.SOURCE_DATE_EPOCH;
      else process.env.SOURCE_DATE_EPOCH = prev;
    }
  });
});

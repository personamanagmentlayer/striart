// Config utilisateur : `native.trustedKeyIds` (clés de signature de confiance
// en plus de la clé épinglée dans le code). Décision de l'utilisateur, jamais
// celle du dépôt : validation stricte, rien d'implicite.
import { describe, expect, it } from 'vitest';
import { DEFAULT_USER_CONFIG, validateUserConfig } from '../../src/user-config.ts';

describe('user-config native.trustedKeyIds', () => {
  it('défaut : aucune clé supplémentaire', () => {
    expect(DEFAULT_USER_CONFIG.native.trustedKeyIds).toEqual([]);
    expect(validateUserConfig({}).native.trustedKeyIds).toEqual([]);
  });

  it('accepte des keyId minisign (16 chiffres hexadécimaux majuscules)', () => {
    const ids = ['BA72381DD088AC9C', '0123456789ABCDEF'];
    expect(validateUserConfig({ native: { trustedKeyIds: ids } }).native.trustedKeyIds).toEqual(
      ids,
    );
  });

  it.each([
    ['minuscules', ['ba72381dd088ac9c']],
    ['trop court', ['BA72381D']],
    ['pas un hexadécimal', ['ZZ72381DD088AC9C']],
    ['pas une chaîne', [42]],
    ['trop de clés', Array.from({ length: 17 }, () => 'BA72381DD088AC9C')],
    ['pas un tableau', 'BA72381DD088AC9C'],
  ])('refuse : %s', (_label, trustedKeyIds) => {
    expect(() => validateUserConfig({ native: { trustedKeyIds } })).toThrow(
      expect.objectContaining({ code: 'USER_CONFIG_INVALID' }),
    );
  });

  it('clé inconnue sous « native » refusée (une faute de frappe ne relâche rien)', () => {
    expect(() => validateUserConfig({ native: { trustedKeys: [] } })).toThrow(
      expect.objectContaining({ code: 'USER_CONFIG_INVALID' }),
    );
    expect(() => validateUserConfig({ native: [] })).toThrow(
      expect.objectContaining({ code: 'USER_CONFIG_INVALID' }),
    );
  });
});

import { describe, expect, it } from 'vitest';
import { boundPermissionOptions } from '../../src/permissions.ts';
import { sanitizeAgentText } from '../../src/collab/message.ts';

describe('permissions — texte d’agent borné et neutralisé (S-M4, S-M8)', () => {
  it('retient au plus 16 options, identifiants imprimables, noms neutralisés', () => {
    const many = Array.from({ length: 40 }, (_, i) => ({ optionId: `opt-${i}`, name: `n${i}` }));
    expect(boundPermissionOptions(many)).toHaveLength(16);
    const out = boundPermissionOptions([
      { optionId: 'allow', name: 'Autoriser\u202e\u200b évil', kind: 'allow_once' },
      { optionId: 'bad id with spaces', name: 'x' },
      { optionId: '../../x', name: 'y' },
      { optionId: 'long', name: 'é'.repeat(1000) },
    ]);
    expect(out.map((o) => o.optionId)).toEqual(['allow', 'long']);
    expect(out[0].name).toBe('Autoriser évil');
    expect(Buffer.byteLength(out[1].name, 'utf8')).toBeLessThanOrEqual(256);
  });

  it('une liste non-tableau donne zéro option (fail closed)', () => {
    expect(boundPermissionOptions(null)).toEqual([]);
    expect(boundPermissionOptions('allow')).toEqual([]);
  });

  it('sanitizeAgentText retire caractères Tag et zéro-largeur (instructions invisibles)', () => {
    const hidden = String.fromCodePoint(0xe0041, 0xe0042);
    expect(sanitizeAgentText(`ok${hidden}\u200b\u2060\ufeffgo`, 100).text).toBe('okgo');
  });
});

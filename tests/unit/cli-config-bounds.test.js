import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, listUnknownConfigKeys } from '../../src/config.ts';

/**
 * C-M5 (doctor) : la liste des clés de premier niveau inconnues qu'affiche
 * `striart doctor`. Les bornes de délai (2^31-1 ms) et la politique de refus
 * des clés inconnues sont contractualisées dans tests/unit/config-bounds.test.js.
 */
describe('listUnknownConfigKeys', () => {
  it('liste les clés de premier niveau que Striart ne connaît pas', () => {
    expect(listUnknownConfigKeys({ ...DEFAULT_CONFIG, configPath: null })).toEqual([]);
    expect(listUnknownConfigKeys({ testTimeoutMz: 1, targetBranch: 'x', zzz: 2 })).toEqual([
      'testTimeoutMz',
      'zzz',
    ]);
  });

  it('connaît toutes les clés validées, même absentes des défauts', () => {
    expect(listUnknownConfigKeys({ agentProfiles: {}, acpAgent: {}, llmRoles: {} })).toEqual([]);
  });

  it('$schema (référence de schéma de l’éditeur) n’est pas une clé inconnue', () => {
    expect(listUnknownConfigKeys({ $schema: 'https://example.invalid/s.json' })).toEqual([]);
  });
});

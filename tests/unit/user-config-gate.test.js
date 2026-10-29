import { describe, expect, it } from 'vitest';
import { DEFAULT_USER_CONFIG, validateUserConfig } from '../../src/user-config.ts';
import { collectRelaxations } from '../../src/doctor-relaxations.ts';

const gate = (value) => validateUserConfig({ gate: value }).gate;
const refused = (value, key = 'gate.envAllow') => {
  try {
    validateUserConfig({ gate: value });
  } catch (error) {
    expect(error.code).toBe('USER_CONFIG_INVALID');
    expect(error.details.key).toBe(key);
    return;
  }
  throw new Error('aucune erreur levée');
};

describe('config UTILISATEUR — bloc gate (plafond de gateEnv)', () => {
  it('défaut : aucune variable supplémentaire autorisée', () => {
    expect(DEFAULT_USER_CONFIG.gate).toEqual({ envAllow: [] });
    expect(validateUserConfig({}).gate).toEqual({ envAllow: [] });
    expect(gate({})).toEqual({ envAllow: [] });
  });

  it('accepte noms, PREFIXE_* et *_SUFFIXE', () => {
    expect(gate({ envAllow: ['MYAPP_*', 'REGION', '*_REGION'] }).envAllow).toEqual([
      'MYAPP_*',
      'REGION',
      '*_REGION',
    ]);
  });

  it.each([
    ['clé d’API', ['OPENAI_API_KEY']],
    ['webhook', ['SLACK_WEBHOOK_URL']],
    ['motif invalide', ['a b']],
    ['non chaîne', [42]],
    ['joker seul', ['*']],
  ])('refuse %s', (_label, envAllow) => {
    refused({ envAllow });
  });

  it('refuse plus de 128 entrées, un non-tableau, un non-objet et toute clé inconnue', () => {
    refused({ envAllow: Array.from({ length: 129 }, (_, i) => `V${i}`) });
    refused({ envAllow: 'MYAPP_*' });
    refused('x', 'gate');
    refused({ envAllow: [], extra: 1 }, 'gate.extra');
  });

  it('accepte exactement 128 entrées', () => {
    expect(
      gate({ envAllow: Array.from({ length: 128 }, (_, i) => `V${i}`) }).envAllow,
    ).toHaveLength(128);
  });

  it('un gate.envAllow non vide figure dans les relâchements (nom stable gate.envAllow)', () => {
    const none = collectRelaxations({ config: {}, userGateEnvAllow: [] });
    expect(none.names).not.toContain('gate.envAllow');
    const some = collectRelaxations({ config: {}, userGateEnvAllow: ['MYAPP_*'] });
    expect(some.names).toContain('gate.envAllow');
  });

  it('collectRelaxations intègre hardeningRelaxations (gateEnv inherit, privateStateDir false)', () => {
    const r = collectRelaxations({
      config: { gateEnv: 'inherit', privateStateDir: false },
    });
    expect(r.names).toEqual(expect.arrayContaining(['gateEnv', 'privateStateDir']));
    expect(collectRelaxations({ config: {} }).names).toEqual([]);
  });
});

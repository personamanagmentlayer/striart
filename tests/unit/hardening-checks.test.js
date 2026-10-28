import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, validateConfig } from '../../src/config.js';
import { checkGateEnv, hardeningRelaxations } from '../../src/hardening-checks.ts';

describe('config — gateEnv / privateStateDir', () => {
  it('défauts sûrs : environnement du gate filtré, données locales privées', () => {
    expect(DEFAULT_CONFIG.gateEnv).toBeNull();
    expect(DEFAULT_CONFIG.privateStateDir).toBe(true);
    expect(() => validateConfig({})).not.toThrow();
  });

  it.each([null, 'inherit', [], ['MYAPP_*', 'REGION']])('gateEnv accepte %j', (value) => {
    expect(() => validateConfig({ gateEnv: value })).not.toThrow();
  });

  it.each([
    'all',
    true,
    ['OPENAI_API_KEY'],
    ['*_API_KEY'],
    ['a b'],
    [42],
    Array.from({ length: 65 }, (_, i) => `V${i}`),
  ])('gateEnv refuse %j', (value) => {
    expect(() => validateConfig({ gateEnv: value })).toThrowError(/gateEnv/);
  });

  it('privateStateDir est un booléen', () => {
    expect(() => validateConfig({ privateStateDir: false })).not.toThrow();
    expect(() => validateConfig({ privateStateDir: 'no' })).toThrowError(/privateStateDir/);
  });
});

describe('hardeningRelaxations (ligne `relaxations` de doctor)', () => {
  it('ne signale rien par défaut', () => {
    expect(hardeningRelaxations(DEFAULT_CONFIG)).toEqual([]);
    expect(hardeningRelaxations({ gateEnv: ['MYAPP_*'], privateStateDir: true })).toEqual([]);
  });

  it('signale gateEnv inherit et privateStateDir false', () => {
    expect(hardeningRelaxations({ gateEnv: 'inherit', privateStateDir: false })).toEqual([
      'gateEnv',
      'privateStateDir',
    ]);
  });
});

describe('checkGateEnv (contrôle doctor)', () => {
  const baseEnv = { PATH: '/bin', OPENAI_API_KEY: 'k', MYAPP_REGION: 'eu' };

  it('ok : environnement filtré, clés retirées comptées', () => {
    const check = checkGateEnv({}, [], baseEnv);
    expect(check.status).toBe('ok');
    expect(check.id).toBe('gate-env.filtered');
    expect(check.params.removedSecrets).toBe(1);
  });

  it('warn : inherit', () => {
    expect(checkGateEnv({ gateEnv: 'inherit' }, [], baseEnv).id).toBe('gate-env.inherit');
  });

  it('warn : demandes du dépôt non autorisées par la config utilisateur (noms seulement)', () => {
    const check = checkGateEnv({ gateEnv: ['MYAPP_*'] }, [], baseEnv);
    expect(check).toMatchObject({
      status: 'warn',
      id: 'gate-env.refused',
      params: { names: ['MYAPP_*'] },
    });
    expect(checkGateEnv({ gateEnv: ['MYAPP_*'] }, ['MYAPP_*'], baseEnv).status).toBe('ok');
  });
});

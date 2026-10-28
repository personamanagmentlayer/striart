import { describe, expect, it } from 'vitest';
import {
  DEFAULT_USER_CONFIG,
  rootKey,
  userConfigPath,
  validateUserConfig,
} from '../../src/user-config.ts';
import { StriartError } from '../../src/errors.js';

describe('config UTILISATEUR de Striart — emplacement', () => {
  it('Linux / macOS : $XDG_CONFIG_HOME/striart/config.json, sinon ~/.config', () => {
    expect(userConfigPath({ platform: 'linux', env: {}, home: '/home/u' })).toBe(
      '/home/u/.config/striart/config.json',
    );
    expect(
      userConfigPath({ platform: 'darwin', env: { XDG_CONFIG_HOME: '/x' }, home: '/Users/u' }),
    ).toBe('/x/striart/config.json');
    // XDG relatif : invalide par la spécification, ignoré.
    expect(userConfigPath({ platform: 'linux', env: { XDG_CONFIG_HOME: 'rel' }, home: '/h' })).toBe(
      '/h/.config/striart/config.json',
    );
  });

  it('Windows : %APPDATA%\\striart\\config.json', () => {
    expect(
      userConfigPath({
        platform: 'win32',
        env: { APPDATA: 'C:\\Users\\u\\AppData\\Roaming' },
        home: 'C:\\Users\\u',
      }),
    ).toBe('C:\\Users\\u\\AppData\\Roaming\\striart\\config.json');
  });

  it('STRIART_CONFIG_HOME (absolu) l’emporte partout', () => {
    expect(
      userConfigPath({
        platform: 'win32',
        env: { STRIART_CONFIG_HOME: 'D:\\cfg', APPDATA: 'C:\\A' },
        home: 'C:\\u',
      }),
    ).toBe('D:\\cfg\\config.json');
  });
});

describe('config UTILISATEUR — validation (données seules, stricte)', () => {
  it('défaut vide pour hooks.trustedRoots, env.allow, native.trustedKeyIds et gate.envAllow', () => {
    expect(DEFAULT_USER_CONFIG).toEqual({
      hooks: { trustedRoots: [] },
      env: { allow: [] },
      idle: { closeRoots: [] },
      native: { trustedKeyIds: [] },
      gate: { envAllow: [] },
      network: {
        proxy: null,
        noProxy: null,
        caFile: null,
        allowedHosts: [],
        allowInsecureHosts: [],
        offline: false,
        tlsMinVersion: null,
      },
    });
    expect(validateUserConfig({})).toEqual(DEFAULT_USER_CONFIG);
  });

  it('accepte hooks.trustedRoots absolus, complétés des autres défauts', () => {
    expect(validateUserConfig({ hooks: { trustedRoots: ['/srv/repo', 'C:\\r'] } })).toEqual({
      ...DEFAULT_USER_CONFIG,
      hooks: { trustedRoots: ['/srv/repo', 'C:\\r'] },
    });
  });

  it('accepte env.allow et native.trustedKeyIds valides', () => {
    expect(
      validateUserConfig({
        env: { allow: ['MY_API_KEY', 'ACME_*'] },
        native: { trustedKeyIds: ['0123456789ABCDEF'] },
      }),
    ).toEqual({
      ...DEFAULT_USER_CONFIG,
      env: { allow: ['MY_API_KEY', 'ACME_*'] },
      native: { trustedKeyIds: ['0123456789ABCDEF'] },
    });
  });

  it.each([
    ['racine non objet', []],
    ['clé inconnue', { theme: 'x' }],
    ['clé hooks inconnue', { hooks: { trusted: [] } }],
    ['racine relative', { hooks: { trustedRoots: ['repo'] } }],
    ['saut de ligne', { hooks: { trustedRoots: ['/a\nb'] } }],
    ['non chaîne', { hooks: { trustedRoots: [3] } }],
    ['racine du système de fichiers', { hooks: { trustedRoots: ['/'] } }],
    ['clé env inconnue', { env: { deny: [] } }],
    ['env.allow non tableau', { env: { allow: 'X' } }],
    ['env.allow : liste noire', { env: { allow: ['PATH'] } }],
    ['clé native inconnue', { native: { keys: [] } }],
    ['keyId en minuscules', { native: { trustedKeyIds: ['0123456789abcdef'] } }],
    ['keyId trop court', { native: { trustedKeyIds: ['ABCD'] } }],
    ['keyId non chaîne', { native: { trustedKeyIds: [12] } }],
  ])('refuse : %s (USER_CONFIG_INVALID)', (_l, value) => {
    expect(() => validateUserConfig(value)).toThrow(StriartError);
    try {
      validateUserConfig(value);
    } catch (error) {
      expect(error.code).toBe('USER_CONFIG_INVALID');
    }
  });
});

describe('comparaison des racines', () => {
  it('sans casse sous Windows et macOS, avec casse sous Linux, séparateurs finaux ignorés', () => {
    expect(rootKey('C:\\Repo\\', 'win32')).toBe(rootKey('c:\\repo', 'win32'));
    expect(rootKey('/Users/U/Repo', 'darwin')).toBe(rootKey('/users/u/repo/', 'darwin'));
    expect(rootKey('/srv/Repo', 'linux')).not.toBe(rootKey('/srv/repo', 'linux'));
  });
});

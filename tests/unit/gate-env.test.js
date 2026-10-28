import { describe, expect, it } from 'vitest';
import {
  buildGateEnv,
  collectConfiguredSecretEnvNames,
  validateGateEnvPattern,
} from '../../src/gate-env.ts';

const WIN_BASE = {
  Path: 'C:\\Windows\\System32',
  SystemRoot: 'C:\\Windows',
  ComSpec: 'C:\\Windows\\System32\\cmd.exe',
  PATHEXT: '.COM;.EXE;.CMD',
  TEMP: 'C:\\Temp',
  USERPROFILE: 'C:\\Users\\me',
  OPENAI_API_KEY: 'sk-openai-secret-value-1234',
  ANTHROPIC_API_KEY: 'sk-ant-secret-value-12345',
  SLACK_WEBHOOK_URL: 'https://hooks.slack.com/services/T/B/X',
  GITHUB_TOKEN: 'ghp_token',
  NPM_TOKEN: 'npm_token',
  MY_INTERNAL_KEY: 'internal-secret-value',
  npm_config_registry: 'https://registry.example/',
  HTTPS_PROXY: 'http://proxy:3128',
  NODE_OPTIONS: '--max-old-space-size=4096',
  MYAPP_REGION: 'eu',
  MYAPP_PASSWORD: 'pw',
  STRIART_SESSION: '1',
  STRIART_LANG: 'fr',
};

const names = (env) => Object.keys(env).sort();

describe('buildGateEnv — défaut', () => {
  it('garde le nécessaire à npm test / git / node, retire clés d’API, jetons et webhooks', () => {
    const { env, inherited, removedSecrets } = buildGateEnv({
      baseEnv: WIN_BASE,
      secretNames: ['MY_INTERNAL_KEY'],
      platform: 'win32',
    });
    expect(inherited).toBe(false);
    expect(names(env)).toEqual(
      [
        'ComSpec',
        'HTTPS_PROXY',
        'NODE_OPTIONS',
        'PATHEXT',
        'Path',
        'STRIART_LANG',
        'SystemRoot',
        'TEMP',
        'USERPROFILE',
        'npm_config_registry',
      ].sort(),
    );
    expect(removedSecrets).toEqual(
      ['ANTHROPIC_API_KEY', 'MY_INTERNAL_KEY', 'OPENAI_API_KEY', 'SLACK_WEBHOOK_URL'].sort(),
    );
    expect(Object.values(env).join('|')).not.toMatch(/secret|ghp_|npm_token|hooks\.slack/i);
  });

  it('ne transmet jamais STRIART_SESSION (garde de profondeur d’orchestration)', () => {
    const { env } = buildGateEnv({ baseEnv: WIN_BASE, platform: 'win32' });
    expect(env.STRIART_SESSION).toBeUndefined();
  });

  it('compare sans casse les noms intégrés (http_proxy, npm_config_* sous Linux)', () => {
    const { env } = buildGateEnv({
      baseEnv: { PATH: '/bin', http_proxy: 'http://p', npm_config_cache: '/c', FOO: 'x' },
      platform: 'linux',
    });
    expect(names(env)).toEqual(['PATH', 'http_proxy', 'npm_config_cache']);
  });

  it('exclut les NPM_CONFIG_* qui portent un jeton d’authentification', () => {
    const { env } = buildGateEnv({
      baseEnv: { PATH: '/bin', npm_config__authtoken: 'tok', npm_config_registry: 'r' },
      platform: 'linux',
    });
    expect(names(env)).toEqual(['PATH', 'npm_config_registry']);
  });
});

describe('buildGateEnv — variables demandées par le dépôt', () => {
  it('sont écartées et rapportées sans autorisation de la config utilisateur', () => {
    const { env, refused } = buildGateEnv({
      baseEnv: WIN_BASE,
      repo: ['MYAPP_*', 'MYAPP_REGION'],
      userAllow: [],
      platform: 'win32',
    });
    expect(env.MYAPP_REGION).toBeUndefined();
    expect(refused).toEqual(['MYAPP_*', 'MYAPP_REGION']);
  });

  it('passent quand un motif utilisateur les couvre', () => {
    const { env, refused } = buildGateEnv({
      baseEnv: WIN_BASE,
      repo: ['MYAPP_REGION'],
      userAllow: ['MYAPP_*'],
      platform: 'win32',
    });
    expect(env.MYAPP_REGION).toBe('eu');
    expect(refused).toEqual([]);
  });

  it('une demande plus large que l’autorisation est refusée (le dépôt n’élargit pas)', () => {
    const narrow = buildGateEnv({
      baseEnv: WIN_BASE,
      repo: ['MYAPP_*'],
      userAllow: ['MYAPP_REGION'],
      platform: 'win32',
    });
    expect(narrow.refused).toEqual(['MYAPP_*']);
    expect(narrow.env.MYAPP_REGION).toBeUndefined();
  });

  it('une variable nommée par l’utilisateur l’emporte sur le filtre « ressemble à un secret »', () => {
    const { env } = buildGateEnv({
      baseEnv: WIN_BASE,
      repo: ['MYAPP_PASSWORD'],
      userAllow: ['MYAPP_PASSWORD'],
      platform: 'win32',
    });
    expect(env.MYAPP_PASSWORD).toBe('pw');
  });

  it('JAMAIS une clé d’API ni un webhook, même demandés et autorisés', () => {
    const { env, refused } = buildGateEnv({
      baseEnv: WIN_BASE,
      repo: ['OPENAI_API_KEY', 'SLACK_WEBHOOK_URL', '*_API_KEY'],
      userAllow: ['OPENAI_API_KEY', 'SLACK_WEBHOOK_URL', '*_API_KEY'],
      platform: 'win32',
    });
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.SLACK_WEBHOOK_URL).toBeUndefined();
    expect(refused.sort()).toEqual(['*_API_KEY', 'OPENAI_API_KEY', 'SLACK_WEBHOOK_URL'].sort());
  });

  it('JAMAIS une variable désignée par la config (apiKeyEnv), même demandée et autorisée', () => {
    const { env } = buildGateEnv({
      baseEnv: WIN_BASE,
      repo: ['MY_INTERNAL_KEY'],
      userAllow: ['MY_INTERNAL_KEY'],
      secretNames: ['MY_INTERNAL_KEY'],
      platform: 'win32',
    });
    expect(env.MY_INTERNAL_KEY).toBeUndefined();
  });
});

describe('buildGateEnv — inherit (relâchement explicite)', () => {
  it('rend tout l’environnement et le signale', () => {
    const { env, inherited } = buildGateEnv({
      baseEnv: WIN_BASE,
      repo: 'inherit',
      platform: 'win32',
    });
    expect(inherited).toBe(true);
    expect(env.OPENAI_API_KEY).toBe(WIN_BASE.OPENAI_API_KEY);
  });
});

describe('validateGateEnvPattern / collectConfiguredSecretEnvNames', () => {
  it('accepte nom, PREFIXE_* et *_SUFFIXE ; refuse le reste et les clés d’API', () => {
    expect(validateGateEnvPattern('MYAPP_REGION')).toBeNull();
    expect(validateGateEnvPattern('MYAPP_*')).toBeNull();
    expect(validateGateEnvPattern('*_REGION')).toBeNull();
    expect(validateGateEnvPattern('*')).not.toBeNull();
    expect(validateGateEnvPattern('A B')).not.toBeNull();
    expect(validateGateEnvPattern('A=B')).not.toBeNull();
    expect(validateGateEnvPattern(42)).not.toBeNull();
    expect(validateGateEnvPattern('OPENAI_API_KEY')).not.toBeNull();
    expect(validateGateEnvPattern('*_API_KEY')).not.toBeNull();
    expect(validateGateEnvPattern('SLACK_WEBHOOK_URL')).not.toBeNull();
  });

  it('collecte apiKeyEnv du LLM, des rôles et urlEnv des notifiers', () => {
    expect(
      collectConfiguredSecretEnvNames({
        llm: { apiKeyEnv: 'A_KEY' },
        llmRoles: { router: { apiKeyEnv: 'B_KEY' }, merger: null },
        notifiers: [{ urlEnv: 'HOOK_URL' }, {}],
      }),
    ).toEqual(['A_KEY', 'B_KEY', 'HOOK_URL']);
    expect(collectConfiguredSecretEnvNames({})).toEqual([]);
  });
});

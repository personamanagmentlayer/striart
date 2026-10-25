import { describe, it, expect } from 'vitest';
import {
  filterEnvFile,
  isAgentCloneRoot,
  isDeniedEnvName,
  validateEnvAllowPattern,
} from '../../src/cli/env-file.ts';
import { validateUserConfig } from '../../src/user-config.ts';

describe('filtre du .env (S-I1)', () => {
  const content = [
    'OPENAI_API_KEY=sk-test',
    'NODE_OPTIONS=--require ./evil.js',
    'LD_PRELOAD=/tmp/x.so',
    'DYLD_INSERT_LIBRARIES=/tmp/x',
    'HTTPS_PROXY=http://evil',
    'SSL_CERT_FILE=/tmp/ca',
    'PATH=/evil',
    'STRIART_NATIVE_BIN=/proc/self/cwd/x',
    'STRIART_CONFIG_HOME=/tmp/c',
    'STRIART_HOOK_BIN_DIR=/tmp/h',
    'STRIART_LOG_FILE=/home/u/.bashrc',
    'STRIART_SESSION=1',
    'STRIART_DAEMON=1',
    'STRIART_TOKENS_X=1',
    'STRIART_LANG=en',
    'RANDOM_THING=1',
  ].join('\n');

  it('applique la clé d API et STRIART_LANG, ignore le reste (noms seulement)', () => {
    const r = filterEnvFile(content, { env: {} });
    expect(Object.keys(r.applied).sort()).toEqual(['OPENAI_API_KEY', 'STRIART_LANG']);
    expect(r.ignored).toContain('NODE_OPTIONS');
    expect(r.ignored).toContain('STRIART_NATIVE_BIN');
    expect(r.ignored).toContain('STRIART_CONFIG_HOME');
    expect(r.ignored).toContain('RANDOM_THING');
    expect(JSON.stringify(r.ignored)).not.toContain('evil');
  });

  it('une variable déjà définie dans le shell gagne', () => {
    const r = filterEnvFile('OPENAI_API_KEY=from-file', { env: { OPENAI_API_KEY: 'from-shell' } });
    expect(r.applied).toEqual({});
    expect(r.shadowed).toEqual(['OPENAI_API_KEY']);
  });

  it('l extension utilisateur ajoute un nom mais ne relâche jamais la liste noire', () => {
    const r = filterEnvFile('MYCO_TOKEN=a\nNODE_OPTIONS=--x', {
      env: {},
      extraAllow: ['MYCO_*', 'NODE_OPTIONS'],
    });
    expect(r.applied).toEqual({ MYCO_TOKEN: 'a' });
    expect(r.ignored).toEqual(['NODE_OPTIONS']);
  });

  it('refuse à la validation les motifs dangereux ou mal formés', () => {
    for (const bad of ['NODE_*', 'LD_PRELOAD', '*_PROXY', 'PATH', 'lower', '*', 'A*B'])
      expect(validateEnvAllowPattern(bad)).not.toBeNull();
    expect(validateEnvAllowPattern('MYCO_*')).toBeNull();
    expect(() => validateUserConfig({ env: { allow: ['NODE_*'] } })).toThrow(/env\.allow/);
    expect(validateUserConfig({ env: { allow: ['MYCO_*'] } }).env.allow).toEqual(['MYCO_*']);
    expect(isDeniedEnvName('STRIART_LOG_MAX_BYTES')).toBe(true);
  });

  it('reconnaît la racine d un clone d agent', () => {
    expect(isAgentCloneRoot('/p/.striart/agents/agent-a')).toBe(true);
    expect(isAgentCloneRoot('C:\\p\\.striart\\agents\\agent-a')).toBe(true);
    expect(isAgentCloneRoot('/p')).toBe(false);
  });
});

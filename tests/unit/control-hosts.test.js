import { describe, expect, it } from 'vitest';
import { hostAllowed, parseAllowedHost, parseAllowedHosts } from '../../src/control/hosts.ts';
import { DEFAULT_CONFIG, validateConfig } from '../../src/config.js';
import { StriartError } from '../../src/errors.js';

const rules = (...list) => {
  const parsed = parseAllowedHosts(list);
  if (!('rules' in parsed)) throw new Error(`pattern refused: ${parsed.problem}`);
  return parsed.rules;
};

describe('dashboardAllowedHosts — motifs', () => {
  it.each([
    ['striart.example.com', 'exact', 'striart.example.com', null],
    ['Mon-Poste', 'exact', 'mon-poste', null],
    ['striart.example.com:8443', 'exact', 'striart.example.com', 8443],
    ['*.app.github.dev', 'wildcard', 'app.github.dev', null],
    ['*.app.github.dev:443', 'wildcard', 'app.github.dev', 443],
    ['192.168.1.20', 'exact', '192.168.1.20', null],
    ['10.0.0.5:3456', 'exact', '10.0.0.5', 3456],
  ])('accepte %s', (entry, kind, host, port) => {
    expect(parseAllowedHost(entry)).toMatchObject({ kind, host, port });
  });

  it.each([
    ['*', 'GLOBAL_WILDCARD'],
    ['*.', 'GLOBAL_WILDCARD'],
    ['*.com', 'WILDCARD_SUFFIX_TOO_BROAD'],
    ['a.*.example.com', 'WILDCARD_POSITION'],
    ['**.example.com', 'WILDCARD_POSITION'],
    ['*.*.example.com', 'WILDCARD_POSITION'],
    ['ex*.example.com', 'WILDCARD_POSITION'],
    ['example.com*', 'WILDCARD_POSITION'],
    ['8.8.8.8', 'PUBLIC_IP_REFUSED'],
    ['203.0.113.7:3456', 'PUBLIC_IP_REFUSED'],
    ['*.10.0.0.1', 'WILDCARD_POSITION'],
    ['[::1]', 'IPV6_REFUSED'],
    ['::1', 'IPV6_REFUSED'],
    ['https://example.com', 'FORBIDDEN_CHARACTER'],
    ['example.com/path', 'FORBIDDEN_CHARACTER'],
    ['user@example.com', 'FORBIDDEN_CHARACTER'],
    ['exa mple.com', 'FORBIDDEN_CHARACTER'],
    ['example.com:0', 'INVALID_PORT'],
    ['example.com:70000', 'INVALID_PORT'],
    ['example.com:', 'INVALID_PORT'],
    ['-bad.example.com', 'INVALID_HOSTNAME'],
    ['a..b', 'INVALID_HOSTNAME'],
    ['1.2.3.999', 'INVALID_HOSTNAME'],
    ['', 'EMPTY'],
    ['   ', 'EMPTY'],
    [42, 'NOT_A_STRING'],
    [null, 'NOT_A_STRING'],
  ])('refuse %j (%s)', (entry, problem) => {
    expect(parseAllowedHost(entry)).toEqual({ problem });
  });
});

describe('dashboardAllowedHosts — comparaison à l’en-tête Host', () => {
  it('liste vide : rien n’est admis (comportement strict par défaut)', () => {
    expect(hostAllowed('x.app.github.dev', [])).toBe(false);
  });

  it('nom exact, casse ignorée, port libre ou imposé', () => {
    const r = rules('striart.example.com', 'fixed.example.com:8443');
    expect(hostAllowed('STRIART.example.com', r)).toBe(true);
    expect(hostAllowed('striart.example.com:1234', r)).toBe(true);
    expect(hostAllowed('fixed.example.com:8443', r)).toBe(true);
    expect(hostAllowed('fixed.example.com:9999', r)).toBe(false);
    expect(hostAllowed('fixed.example.com', r)).toBe(false);
    expect(hostAllowed('evil.com', r)).toBe(false);
  });

  it('le joker ne couvre qu’UNE étiquette, jamais le suffixe nu, jamais un suffixe collé', () => {
    const r = rules('*.app.github.dev');
    expect(hostAllowed('abc-3456.app.github.dev', r)).toBe(true);
    expect(hostAllowed('abc-3456.app.github.dev:443', r)).toBe(true);
    expect(hostAllowed('app.github.dev', r)).toBe(false);
    expect(hostAllowed('a.b.app.github.dev', r)).toBe(false);
    expect(hostAllowed('evilapp.github.dev', r)).toBe(false);
    expect(hostAllowed('x.app.github.dev.evil.com', r)).toBe(false);
  });

  it('un Host mal formé ou absent est refusé', () => {
    const r = rules('*.app.github.dev');
    for (const bad of [
      undefined,
      null,
      '',
      'x.app.github.dev:abc',
      'x.app.github.dev:1:2',
      'x y.app.github.dev',
      '[::1]',
    ])
      expect(hostAllowed(bad, r)).toBe(false);
  });
});

describe('dashboardAllowedHosts — config', () => {
  it('défaut : liste vide', () => {
    expect(DEFAULT_CONFIG.dashboardAllowedHosts).toEqual([]);
  });

  it('accepte une liste valide', () => {
    expect(() => validateConfig({ dashboardAllowedHosts: ['*.app.github.dev'] })).not.toThrow();
  });

  it.each([['*'], ['*.com'], ['8.8.8.8'], [42], ['a b']])(
    'refuse %j au chargement : CONFIG_INVALID avec reason et field, SANS écho de la valeur',
    (...list) => {
      let error;
      try {
        validateConfig({ dashboardAllowedHosts: list });
      } catch (e) {
        error = e;
      }
      expect(error).toBeInstanceOf(StriartError);
      expect(error.code).toBe('CONFIG_INVALID');
      expect(error.details).toMatchObject({
        key: 'dashboardAllowedHosts',
        field: 'dashboardAllowedHosts[0]',
      });
      expect(typeof error.details.reason).toBe('string');
      const dump = JSON.stringify({ message: error.message, details: error.details });
      for (const v of list)
        if (typeof v === 'string' && v.length > 2) expect(dump).not.toContain(v);
    },
  );

  it('refuse une valeur qui n’est pas une liste', () => {
    expect(() => validateConfig({ dashboardAllowedHosts: '*.app.github.dev' })).toThrow(
      StriartError,
    );
  });
});

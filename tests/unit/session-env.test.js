import { describe, expect, it } from 'vitest';
import { applyEnvAllowlist, sessionNetworkEnv } from '../../src/session-env.ts';

const CA = '/corp/ca.pem';

describe('sessionNetworkEnv — réseau d’entreprise dans l’environnement d’une session', () => {
  it('pose NODE_EXTRA_CA_CERTS depuis network.caFile (config utilisateur) quand l’env n’en a pas', () => {
    const out = sessionNetworkEnv({ PATH: 'x' }, { caFile: CA });
    expect(out.env.NODE_EXTRA_CA_CERTS).toBe(CA);
    expect(out.caFile).toBe('applied');
    expect(out.env.PATH).toBe('x');
  });

  it('n’écrase JAMAIS un NODE_EXTRA_CA_CERTS déjà choisi dans le shell (et le dit)', () => {
    const out = sessionNetworkEnv({ NODE_EXTRA_CA_CERTS: '/shell/ca.pem' }, { caFile: CA });
    expect(out.env.NODE_EXTRA_CA_CERTS).toBe('/shell/ca.pem');
    expect(out.caFile).toBe('shadowed');
  });

  it('sans caFile : l’env est transmis tel quel, rien n’est ajouté', () => {
    const out = sessionNetworkEnv({ PATH: 'x' }, { caFile: null });
    expect(out.env).toEqual({ PATH: 'x' });
    expect(out.caFile).toBe('none');
    expect(sessionNetworkEnv({ PATH: 'x' }, null).env).toEqual({ PATH: 'x' });
  });

  it('transmet les variables de proxy déjà présentes, dans toutes les casses', () => {
    const base = {
      HTTP_PROXY: 'http://p:3128',
      https_proxy: 'http://p:3128',
      NO_PROXY: 'localhost,.corp',
      no_proxy: 'localhost',
    };
    expect(sessionNetworkEnv(base, null).env).toEqual(base);
  });

  it.each(['STRIART_PROXY_AUTH', 'striart_proxy_auth'])(
    'ne propage JAMAIS %s (identifiants du proxy)',
    (name) => {
      const out = sessionNetworkEnv(
        { [name]: 'user:pw', HTTPS_PROXY: 'http://p:3128' },
        { caFile: CA },
      );
      expect(Object.keys(out.env).map((k) => k.toUpperCase())).not.toContain('STRIART_PROXY_AUTH');
      expect(JSON.stringify(out.env)).not.toContain('user:pw');
      expect(out.env.HTTPS_PROXY).toBe('http://p:3128');
    },
  );

  it('ne modifie pas l’objet d’entrée', () => {
    const base = Object.freeze({ STRIART_PROXY_AUTH: 'u:p' });
    expect(() => sessionNetworkEnv(base, { caFile: CA })).not.toThrow();
    expect(base.STRIART_PROXY_AUTH).toBe('u:p');
  });
});

/**
 * Allégement de confiance (lot O, priorité 5 — `AgentProfile.envAllow`).
 * `null` : comportement inchangé (hérite tout). Un tableau — même vide — ne
 * garde que les noms exacts listés, jamais plus.
 */
describe('applyEnvAllowlist — restriction déclarée de l’environnement hérité', () => {
  const base = { PATH: '/bin', OPENAI_API_KEY: 'sk-secret', HOME: '/home/u' };

  it('null (défaut) : transmet tout, inchangé', () => {
    expect(applyEnvAllowlist(base, null)).toEqual(base);
  });

  it('ne garde que les noms listés, un secret non listé disparaît', () => {
    const out = applyEnvAllowlist(base, ['PATH']);
    expect(out).toEqual({ PATH: '/bin' });
    expect(out).not.toHaveProperty('OPENAI_API_KEY');
  });

  it('liste vide : rien n’est hérité', () => {
    expect(applyEnvAllowlist(base, [])).toEqual({});
  });

  it('un nom listé mais absent de l’environnement est simplement omis', () => {
    expect(applyEnvAllowlist({ PATH: '/bin' }, ['PATH', 'MISSING'])).toEqual({ PATH: '/bin' });
  });

  it('ne modifie pas l’objet d’entrée', () => {
    const frozen = Object.freeze({ PATH: '/bin', SECRET: 'x' });
    expect(() => applyEnvAllowlist(frozen, ['PATH'])).not.toThrow();
    expect(frozen.SECRET).toBe('x');
  });
});

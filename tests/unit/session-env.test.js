import { describe, expect, it } from 'vitest';
import { sessionNetworkEnv } from '../../src/session-env.ts';

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

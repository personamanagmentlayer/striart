import { describe, expect, it } from 'vitest';
import { DEFAULT_USER_CONFIG, validateUserConfig } from '../../src/user-config.ts';
import { validateConfig } from '../../src/config.ts';
import { filterEnvFile } from '../../src/cli/env-file.ts';

const net = (network) => validateUserConfig({ network }).network;
const refused = (network, key) => {
  try {
    validateUserConfig({ network });
  } catch (error) {
    expect(error.code).toBe('USER_CONFIG_INVALID');
    if (key) expect(error.details.key).toBe(key);
    return;
  }
  throw new Error('aucune erreur levée');
};

describe('config UTILISATEUR — bloc network (données seules, stricte)', () => {
  it('défauts : tout vide / faux / nul', () => {
    expect(DEFAULT_USER_CONFIG.network).toEqual({
      proxy: null,
      noProxy: null,
      caFile: null,
      allowedHosts: [],
      allowInsecureHosts: [],
      offline: false,
      tlsMinVersion: null,
    });
    expect(validateUserConfig({}).network).toEqual(DEFAULT_USER_CONFIG.network);
  });

  it('accepte un bloc complet (hôtes normalisés en minuscules)', () => {
    expect(
      net({
        proxy: 'http://proxy.corp.example:3128',
        noProxy: 'localhost,.corp.example',
        caFile: '/etc/ssl/corp-ca.pem',
        allowedHosts: ['API.Anthropic.com', '*.corp.example'],
        allowInsecureHosts: ['ollama.corp.example'],
        offline: true,
        tlsMinVersion: 'TLSv1.3',
      }),
    ).toEqual({
      proxy: 'http://proxy.corp.example:3128',
      noProxy: 'localhost,.corp.example',
      caFile: '/etc/ssl/corp-ca.pem',
      allowedHosts: ['api.anthropic.com', '*.corp.example'],
      allowInsecureHosts: ['ollama.corp.example'],
      offline: true,
      tlsMinVersion: 'TLSv1.3',
    });
  });

  it('clé inconnue refusée (network.* et racine)', () => {
    refused({ nope: 1 }, 'network.nope');
    refused('texte', 'network');
  });

  it('proxy : URL http(s) SANS identifiants (ils vont dans STRIART_PROXY_AUTH)', () => {
    refused({ proxy: 'http://alice:secret@proxy:3128' }, 'network.proxy');
    refused({ proxy: 'socks5://proxy:1080' }, 'network.proxy');
    refused({ proxy: 'pas une url' }, 'network.proxy');
    refused({ proxy: 42 }, 'network.proxy');
  });

  it('caFile : chemin absolu sans caractère de contrôle', () => {
    refused({ caFile: 'relatif/ca.pem' }, 'network.caFile');
    refused({ caFile: '/x\0y' }, 'network.caFile');
    expect(net({ caFile: 'C:\\certs\\ca.pem' }).caFile).toBe('C:\\certs\\ca.pem');
  });

  it('allowedHosts / allowInsecureHosts : noms d’hôte ou *.suffixe, jamais « * » seul, plafonnés', () => {
    for (const bad of ['*', '*.', 'a b', 'http://x', 'x/y', '', 'exemple.com:443']) {
      refused({ allowedHosts: [bad] }, 'network.allowedHosts');
      refused({ allowInsecureHosts: [bad] }, 'network.allowInsecureHosts');
    }
    refused({ allowedHosts: 'x.example' }, 'network.allowedHosts');
    refused({ allowedHosts: Array.from({ length: 129 }, (_, i) => `h${i}.example`) });
  });

  it('offline booléen, tlsMinVersion TLSv1.2 | TLSv1.3', () => {
    refused({ offline: 'yes' }, 'network.offline');
    refused({ tlsMinVersion: 'TLSv1.1' }, 'network.tlsMinVersion');
    refused({ tlsMinVersion: 'SSLv3' }, 'network.tlsMinVersion');
    expect(net({ tlsMinVersion: 'TLSv1.2' }).tlsMinVersion).toBe('TLSv1.2');
  });
});

describe('réglages réseau : jamais la config du dépôt ni son .env', () => {
  it('une clé « network » dans la config du dépôt est refusée (unknownConfigKeys: error)', () => {
    expect(() => validateConfig({ network: { offline: false, allowedHosts: [] } })).toThrow();
  });

  it('le .env du dépôt ne peut poser ni proxy, ni CA, ni politique réseau STRIART_*', () => {
    const content = [
      'HTTPS_PROXY=http://evil:3128',
      'https_proxy=http://evil:3128',
      'HTTP_PROXY=http://evil:3128',
      'ALL_PROXY=http://evil:3128',
      'NO_PROXY=*',
      'NODE_EXTRA_CA_CERTS=/tmp/evil.pem',
      'NODE_USE_ENV_PROXY=1',
      'NODE_TLS_REJECT_UNAUTHORIZED=0',
      'SSL_CERT_FILE=/tmp/evil.pem',
      'STRIART_OFFLINE=0',
      'STRIART_ALLOWED_HOSTS=evil.example',
      'STRIART_TLS_MIN_VERSION=TLSv1.2',
      'STRIART_PROXY_AUTH=alice:secret',
      'STRIART_CA_FILE=/tmp/evil.pem',
      'OPENAI_API_KEY=sk-ok',
    ].join('\n');
    const { applied, ignored } = filterEnvFile(content, { env: {} });
    expect(Object.keys(applied)).toEqual(['OPENAI_API_KEY']);
    expect(ignored).toHaveLength(14);
  });

  it('même une extension env.allow de l’utilisateur ne peut pas viser ces variables', () => {
    for (const pattern of [
      'STRIART_OFFLINE',
      'STRIART_ALLOWED_HOSTS',
      'STRIART_PROXY_AUTH',
      'STRIART_TLS_MIN_VERSION',
      'STRIART_*',
      'HTTPS_PROXY',
    ]) {
      expect(() => validateUserConfig({ env: { allow: [pattern] } })).toThrowError(
        expect.objectContaining({ code: 'USER_CONFIG_INVALID' }),
      );
    }
  });
});

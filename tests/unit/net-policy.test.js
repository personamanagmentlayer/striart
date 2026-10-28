import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  hostMatches,
  isLoopbackHost,
  netFetch,
  resetNetState,
  resolveNetworkPolicy,
} from '../../src/net.ts';
import { DEFAULT_USER_CONFIG } from '../../src/user-config.ts';
import { errorKindOf, StriartError } from '../../src/errors.js';

/** Config utilisateur avec un bloc réseau partiel (les autres blocs : défauts). */
const userWith =
  (network = {}) =>
  async () => ({
    ...DEFAULT_USER_CONFIG,
    network: { ...DEFAULT_USER_CONFIG.network, ...network },
  });

const ok = () => ({ ok: true, status: 200, headers: new Headers(), json: async () => ({}) });

/** Les opérations réseau de ce fichier passent par un transport factice : aucun appel réel. */
function call(url, { user = {}, env = {}, init = {}, transport = vi.fn(async () => ok()) } = {}) {
  return {
    transport,
    promise: netFetch(
      url,
      { purpose: 'llm', ...init },
      { env, userConfig: userWith(user), transport },
    ),
  };
}

const codeOf = async (promise) => {
  try {
    await promise;
  } catch (error) {
    return error instanceof StriartError ? error.code : `autre:${error}`;
  }
  return null;
};

afterEach(() => resetNetState());

describe('net — classification des erreurs', () => {
  it('NET_OFFLINE, NET_HOST_NOT_ALLOWED et NET_INSECURE_TRANSPORT sont des refus (sortie 3)', () => {
    for (const code of [
      'NET_OFFLINE',
      'NET_HOST_NOT_ALLOWED',
      'NET_INSECURE_TRANSPORT',
      'NET_REDIRECT_REFUSED',
    ]) {
      expect(errorKindOf(code)).toBe('refusal');
    }
    for (const code of ['NET_PROXY_UNSUPPORTED', 'NET_TLS_UNTRUSTED', 'NET_CA_INVALID']) {
      expect(errorKindOf(code)).toBe('failure');
    }
  });
});

describe('net — hôtes', () => {
  it('boucle locale reconnue (localhost, 127.x, [::1])', () => {
    for (const h of ['localhost', 'LOCALHOST', '127.0.0.1', '127.1.2.3', '[::1]']) {
      expect(isLoopbackHost(h)).toBe(true);
    }
    for (const h of ['example.com', '127.0.0.1.evil.test', '10.0.0.1', 'localhost.evil.test']) {
      expect(isLoopbackHost(h)).toBe(false);
    }
  });

  it('hostMatches : exact ou *.suffixe (sous-domaines seulement), insensible à la casse', () => {
    expect(hostMatches('API.openai.com', ['api.openai.com'])).toBe(true);
    expect(hostMatches('eu.api.example.com', ['*.example.com'])).toBe(true);
    expect(hostMatches('example.com', ['*.example.com'])).toBe(false);
    expect(hostMatches('evilexample.com', ['*.example.com'])).toBe(false);
    expect(hostMatches('example.com.', ['example.com'])).toBe(true);
    expect(hostMatches('x.test', [])).toBe(false);
  });
});

describe('net — politique (offline, liste blanche, HTTPS)', () => {
  it('offline : tout appel non local est refusé AVANT le transport ; la boucle locale passe', async () => {
    const refused = call('https://api.openai.com/v1/chat', { user: { offline: true } });
    expect(await codeOf(refused.promise)).toBe('NET_OFFLINE');
    expect(refused.transport).not.toHaveBeenCalled();

    const local = call('http://localhost:11434/api/generate', { user: { offline: true } });
    expect(await codeOf(local.promise)).toBeNull();
    expect(local.transport).toHaveBeenCalledTimes(1);
  });

  it("offline par l'environnement du shell (STRIART_OFFLINE=1)", async () => {
    const r = call('https://hooks.slack.com/x', { env: { STRIART_OFFLINE: '1' } });
    expect(await codeOf(r.promise)).toBe('NET_OFFLINE');
  });

  it('allowedHosts : hôte hors liste refusé, hôte listé et joker acceptés, boucle locale exemptée', async () => {
    const user = { allowedHosts: ['api.anthropic.com', '*.corp.example'] };
    const out = call('https://api.openai.com/v1', { user });
    expect(await codeOf(out.promise)).toBe('NET_HOST_NOT_ALLOWED');
    expect(out.transport).not.toHaveBeenCalled();
    expect(await codeOf(call('https://api.anthropic.com/v1', { user }).promise)).toBeNull();
    expect(await codeOf(call('https://llm.corp.example/v1', { user }).promise)).toBeNull();
    expect(await codeOf(call('http://127.0.0.1:11434/x', { user }).promise)).toBeNull();
  });

  it("allowedHosts : config utilisateur ET environnement se cumulent (intersection, jamais l'union)", async () => {
    const user = { allowedHosts: ['a.example', 'b.example'] };
    const env = { STRIART_ALLOWED_HOSTS: 'b.example, c.example' };
    expect(await codeOf(call('https://a.example/', { user, env }).promise)).toBe(
      'NET_HOST_NOT_ALLOWED',
    );
    expect(await codeOf(call('https://c.example/', { user, env }).promise)).toBe(
      'NET_HOST_NOT_ALLOWED',
    );
    expect(await codeOf(call('https://b.example/', { user, env }).promise)).toBeNull();
  });

  it('HTTP en clair vers un hôte distant : refusé MÊME SANS clé API ; relâchement par hôte, config utilisateur', async () => {
    const r = call('http://ollama.corp.example:11434/api/generate');
    expect(await codeOf(r.promise)).toBe('NET_INSECURE_TRANSPORT');
    expect(r.transport).not.toHaveBeenCalled();
    const relaxed = call('http://ollama.corp.example:11434/api/generate', {
      user: { allowInsecureHosts: ['ollama.corp.example'] },
    });
    expect(await codeOf(relaxed.promise)).toBeNull();
    // Le relâchement ne couvre que l'hôte nommé.
    const other = call('http://autre.corp.example/', {
      user: { allowInsecureHosts: ['ollama.corp.example'] },
    });
    expect(await codeOf(other.promise)).toBe('NET_INSECURE_TRANSPORT');
  });

  it("schéma autre que http(s) et URL invalide : NET_URL_INVALID, jamais d'appel", async () => {
    expect(await codeOf(call('file:///etc/passwd').promise)).toBe('NET_URL_INVALID');
    expect(await codeOf(call('ftp://x.example/').promise)).toBe('NET_URL_INVALID');
    expect(await codeOf(call('pas une url').promise)).toBe('NET_URL_INVALID');
  });

  it('NODE_TLS_REJECT_UNAUTHORIZED=0 : refusé vers un hôte distant (vérification TLS coupée)', async () => {
    const r = call('https://api.openai.com/v1', { env: { NODE_TLS_REJECT_UNAUTHORIZED: '0' } });
    expect(await codeOf(r.promise)).toBe('NET_INSECURE_TRANSPORT');
    expect(r.transport).not.toHaveBeenCalled();
  });

  it('config utilisateur illisible : fail closed vers un hôte distant, la boucle locale reste servie', async () => {
    const broken = async () => {
      throw new StriartError('x', { code: 'USER_CONFIG_INVALID' });
    };
    const transport = vi.fn(async () => ok());
    const remote = netFetch(
      'https://api.openai.com/v1',
      { purpose: 'llm' },
      { env: {}, userConfig: broken, transport },
    );
    expect(await codeOf(remote)).toBe('USER_CONFIG_INVALID');
    expect(transport).not.toHaveBeenCalled();
    const local = netFetch(
      'http://localhost:11434/',
      { purpose: 'probe' },
      { env: {}, userConfig: broken, transport },
    );
    expect(await codeOf(local)).toBeNull();
  });
});

describe('net — redirections', () => {
  it('redirect: "error" imposé, quoi que demande l’appelant', async () => {
    const r = call('https://api.openai.com/v1', { init: { redirect: 'follow' } });
    await r.promise;
    expect(r.transport.mock.calls[0][1].redirect).toBe('error');
  });

  it('une redirection refusée par le transport devient NET_REDIRECT_REFUSED (jamais retentée comme panne)', async () => {
    const transport = vi.fn(async () => {
      throw Object.assign(new TypeError('fetch failed'), {
        cause: new Error('unexpected redirect'),
      });
    });
    expect(await codeOf(call('https://api.openai.com/', { transport }).promise)).toBe(
      'NET_REDIRECT_REFUSED',
    );
  });

  it('suivi borné (maxRedirects) : chaque saut repasse par la politique ; saut vers un hôte hors liste refusé', async () => {
    const redirect = (to) => ({
      ok: false,
      status: 302,
      headers: new Headers({ location: to }),
      body: null,
    });
    const user = { allowedHosts: ['releases.example', 'objects.example'] };
    const good = vi
      .fn()
      .mockResolvedValueOnce(redirect('https://objects.example/a.tgz'))
      .mockResolvedValueOnce(ok());
    const res = await netFetch(
      'https://releases.example/a',
      { purpose: 'acp-download', maxRedirects: 2 },
      { env: {}, userConfig: userWith(user), transport: good },
    );
    expect(res.ok).toBe(true);
    expect(good.mock.calls.map((c) => c[0].toString())).toEqual([
      'https://releases.example/a',
      'https://objects.example/a.tgz',
    ]);
    expect(good.mock.calls[0][1].redirect).toBe('manual');

    const evil = vi.fn().mockResolvedValueOnce(redirect('https://evil.example/a.tgz'));
    const code = await codeOf(
      netFetch(
        'https://releases.example/a',
        { purpose: 'acp-download', maxRedirects: 2 },
        { env: {}, userConfig: userWith(user), transport: evil },
      ),
    );
    expect(code).toBe('NET_HOST_NOT_ALLOWED');
    expect(evil).toHaveBeenCalledTimes(1);

    // Un saut vers HTTP en clair est refusé.
    const downgrade = vi.fn().mockResolvedValueOnce(redirect('http://objects.example/a.tgz'));
    expect(
      await codeOf(
        netFetch(
          'https://releases.example/a',
          { purpose: 'acp-download', maxRedirects: 2 },
          { env: {}, userConfig: userWith(user), transport: downgrade },
        ),
      ),
    ).toBe('NET_INSECURE_TRANSPORT');

    // Trop de sauts.
    const loop = vi.fn(async () => redirect('https://releases.example/b'));
    expect(
      await codeOf(
        netFetch(
          'https://releases.example/a',
          { purpose: 'acp-download', maxRedirects: 2 },
          { env: {}, userConfig: userWith(user), transport: loop },
        ),
      ),
    ).toBe('NET_REDIRECT_REFUSED');
  });
});

describe('net — TLS', () => {
  it.each([
    'SELF_SIGNED_CERT_IN_CHAIN',
    'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
    'DEPTH_ZERO_SELF_SIGNED_CERT',
    'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
    'CERT_HAS_EXPIRED',
    'ERR_TLS_CERT_ALTNAME_INVALID',
  ])('erreur de certificat %s → NET_TLS_UNTRUSTED avec piste CA', async (certCode) => {
    const transport = vi.fn(async () => {
      throw Object.assign(new TypeError('fetch failed'), {
        cause: Object.assign(new Error('certificate problem'), { code: certCode }),
      });
    });
    const { promise } = call('https://api.openai.com/v1', { transport });
    const error = await promise.catch((e) => e);
    expect(error).toBeInstanceOf(StriartError);
    expect(error.code).toBe('NET_TLS_UNTRUSTED');
    expect(error.hint).toMatch(/NODE_EXTRA_CA_CERTS/);
    expect(error.hint).toMatch(/use-system-ca/);
    expect(error.details).toMatchObject({ host: 'api.openai.com', certCode });
  });

  it('une panne réseau ordinaire garde sa nature (TypeError) : le retry des appelants reste valable', async () => {
    const boom = Object.assign(new TypeError('fetch failed'), {
      cause: Object.assign(new Error('refused'), { code: 'ECONNREFUSED' }),
    });
    const transport = vi.fn(async () => {
      throw boom;
    });
    await expect(call('https://api.openai.com/', { transport }).promise).rejects.toBe(boom);
  });
});

describe('net — proxy : capacités de Node', () => {
  const proxyEnv = { HTTPS_PROXY: 'http://proxy.corp.example:3128' };

  it('proxy posé mais ni API runtime ni NODE_USE_ENV_PROXY → NET_PROXY_UNSUPPORTED actionnable', async () => {
    const transport = vi.fn(async () => ok());
    const error = await netFetch(
      'https://api.openai.com/v1',
      { purpose: 'llm' },
      {
        env: proxyEnv,
        userConfig: userWith(),
        transport,
        capabilities: { runtimeProxyApi: false, startupProxyFlag: false },
      },
    ).catch((e) => e);
    expect(error.code).toBe('NET_PROXY_UNSUPPORTED');
    expect(error.hint).toMatch(/NODE_USE_ENV_PROXY=1/);
    expect(transport).not.toHaveBeenCalled();
  });

  it('NO_PROXY qui couvre la cible : aucune erreur même sans mécanisme de proxy', async () => {
    const transport = vi.fn(async () => ok());
    await netFetch(
      'https://api.openai.com/v1',
      { purpose: 'llm' },
      {
        env: { ...proxyEnv, NO_PROXY: '.openai.com' },
        userConfig: userWith(),
        transport,
        capabilities: { runtimeProxyApi: false, startupProxyFlag: false },
      },
    );
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it('boucle locale : jamais concernée par le proxy', async () => {
    const transport = vi.fn(async () => ok());
    await netFetch(
      'http://localhost:11434/api/tags',
      { purpose: 'probe' },
      {
        env: proxyEnv,
        userConfig: userWith(),
        transport,
        capabilities: { runtimeProxyApi: false, startupProxyFlag: false },
      },
    );
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it('NODE_USE_ENV_PROXY=1 posé au démarrage : proxy actif via Node, rien à faire', async () => {
    const transport = vi.fn(async () => ok());
    await netFetch(
      'https://api.openai.com/v1',
      { purpose: 'llm' },
      {
        env: proxyEnv,
        userConfig: userWith(),
        transport,
        capabilities: { runtimeProxyApi: false, startupProxyFlag: true },
      },
    );
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it('proxy de la config utilisateur sans API runtime : refusé (le flag de démarrage ne lit que l’environnement)', async () => {
    const error = await netFetch(
      'https://api.openai.com/v1',
      { purpose: 'llm' },
      {
        env: {},
        userConfig: userWith({ proxy: 'http://proxy.corp.example:3128' }),
        transport: vi.fn(async () => ok()),
        capabilities: { runtimeProxyApi: false, startupProxyFlag: true },
      },
    ).catch((e) => e);
    expect(error.code).toBe('NET_PROXY_UNSUPPORTED');
  });

  it('schéma de proxy non supporté (socks5) : NET_PROXY_UNSUPPORTED', async () => {
    const error = await netFetch(
      'https://api.openai.com/v1',
      { purpose: 'llm' },
      {
        env: { HTTPS_PROXY: 'socks5://proxy:1080' },
        userConfig: userWith(),
        transport: vi.fn(async () => ok()),
        capabilities: { runtimeProxyApi: true, startupProxyFlag: false },
      },
    ).catch((e) => e);
    expect(error.code).toBe('NET_PROXY_UNSUPPORTED');
  });
});

describe('net — résolution de la politique', () => {
  it('défauts : rien de restreint, rien de relâché', () => {
    const policy = resolveNetworkPolicy(DEFAULT_USER_CONFIG.network, {});
    expect(policy.offline).toBe(false);
    expect(policy.allowLists).toEqual([]);
    expect(policy.allowInsecureHosts).toEqual([]);
    expect(policy.tlsMinVersion).toBeNull();
    expect(policy.proxy.configured).toBe(false);
  });

  it('proxy : minuscules acceptées, config utilisateur prioritaire, identifiants jamais exposés', () => {
    const fromEnv = resolveNetworkPolicy(DEFAULT_USER_CONFIG.network, {
      https_proxy: 'http://alice:secret@proxy.corp.example:3128',
      no_proxy: 'internal.example',
    });
    expect(fromEnv.proxy.source).toBe('environment');
    expect(fromEnv.proxy.display.https).toBe('http://proxy.corp.example:3128');
    expect(JSON.stringify(fromEnv.proxy.display)).not.toContain('secret');
    const fromUser = resolveNetworkPolicy(
      { ...DEFAULT_USER_CONFIG.network, proxy: 'http://other.corp.example:8080' },
      { HTTPS_PROXY: 'http://proxy.corp.example:3128' },
    );
    expect(fromUser.proxy.source).toBe('user-config');
    expect(fromUser.proxy.display.https).toBe('http://other.corp.example:8080');
  });

  it('tlsMinVersion : la plus stricte des deux sources ; valeur inconnue en environnement refusée', () => {
    expect(
      resolveNetworkPolicy(
        { ...DEFAULT_USER_CONFIG.network, tlsMinVersion: 'TLSv1.2' },
        { STRIART_TLS_MIN_VERSION: 'TLSv1.3' },
      ).tlsMinVersion,
    ).toBe('TLSv1.3');
    expect(() =>
      resolveNetworkPolicy(DEFAULT_USER_CONFIG.network, { STRIART_TLS_MIN_VERSION: 'SSLv3' }),
    ).toThrowError(expect.objectContaining({ code: 'USER_CONFIG_INVALID' }));
  });
});

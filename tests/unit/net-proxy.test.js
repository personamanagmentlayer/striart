import http from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { netFetch, resetNetState } from '../../src/net.ts';
import { DEFAULT_USER_CONFIG } from '../../src/user-config.ts';

/**
 * Proxy HTTP factice local : consigne ce qu'il reçoit.
 *  - requête en clair vers un hôte http:// → forme absolue (`POST http://hôte/…`) ;
 *  - cible https:// → méthode CONNECT hôte:443 (refusée : aucun TLS ici, on
 *    prouve seulement que le trafic passe par lui).
 * Aucun appel réseau réel : le proxy répond lui-même.
 */
function startFakeProxy() {
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push({
      method: req.method,
      url: req.url,
      auth: req.headers['proxy-authorization'] ?? null,
    });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"via":"proxy"}');
  });
  server.on('connect', (req, socket) => {
    seen.push({
      method: 'CONNECT',
      url: req.url,
      auth: req.headers['proxy-authorization'] ?? null,
    });
    socket.end('HTTP/1.1 502 Bad Gateway\r\nconnection: close\r\n\r\n');
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () =>
      resolve({
        seen,
        port: server.address().port,
        close: () => new Promise((r) => server.close(r)),
      }),
    );
  });
}

const userNone = async () => ({ ...DEFAULT_USER_CONFIG });

describe('net — proxy d’entreprise (proxy factice local)', () => {
  let proxy;
  beforeEach(async () => {
    proxy = await startFakeProxy();
  });
  afterEach(async () => {
    resetNetState();
    await proxy.close();
  });

  it('HTTP_PROXY posé : une requête http:// distante transite par le proxy (forme absolue)', async () => {
    const env = { HTTP_PROXY: `http://127.0.0.1:${proxy.port}` };
    const res = await netFetch(
      'http://llm.internal.test:11434/api/generate',
      { purpose: 'llm', method: 'POST', body: '{}' },
      { env, userConfig: async () => withInsecure(['llm.internal.test']) },
    );
    expect(await res.json()).toEqual({ via: 'proxy' });
    expect(proxy.seen).toHaveLength(1);
    expect(proxy.seen[0]).toMatchObject({
      method: 'POST',
      url: 'http://llm.internal.test:11434/api/generate',
    });
  });

  it('HTTPS_PROXY posé : une cible https:// part en CONNECT hôte:port vers le proxy', async () => {
    const env = { HTTPS_PROXY: `http://127.0.0.1:${proxy.port}` };
    await netFetch(
      'https://api.example.test/v1/chat',
      { purpose: 'llm', signal: AbortSignal.timeout(5000) },
      { env, userConfig: userNone },
    ).catch(() => undefined); // le proxy factice refuse le tunnel : seul le trajet compte
    expect(proxy.seen).toEqual([
      expect.objectContaining({ method: 'CONNECT', url: 'api.example.test:443' }),
    ]);
  });

  it('NO_PROXY évite le proxy : connexion directe (échec DNS), le proxy ne voit rien', async () => {
    const env = {
      HTTP_PROXY: `http://127.0.0.1:${proxy.port}`,
      NO_PROXY: 'llm.internal.test',
    };
    await expect(
      netFetch(
        'http://llm.internal.test:11434/x',
        { purpose: 'llm', signal: AbortSignal.timeout(5000) },
        { env, userConfig: async () => withInsecure(['llm.internal.test']) },
      ),
    ).rejects.toThrow();
    expect(proxy.seen).toEqual([]);
  });

  it('la boucle locale ne passe jamais par le proxy, sans NO_PROXY explicite', async () => {
    const target = http.createServer((_req, res) => res.end('direct'));
    await new Promise((r) => target.listen(0, '127.0.0.1', r));
    try {
      const env = { HTTP_PROXY: `http://127.0.0.1:${proxy.port}` };
      const res = await netFetch(
        `http://127.0.0.1:${target.address().port}/`,
        { purpose: 'probe' },
        { env, userConfig: userNone },
      );
      expect(await res.text()).toBe('direct');
      expect(proxy.seen).toEqual([]);
    } finally {
      await new Promise((r) => target.close(r));
    }
  });

  it('proxy de la config utilisateur + authentification par STRIART_PROXY_AUTH (jamais en config)', async () => {
    const env = { STRIART_PROXY_AUTH: 'alice:s3cret' };
    await netFetch(
      'http://llm.internal.test:11434/x',
      { purpose: 'llm' },
      {
        env,
        userConfig: async () => ({
          ...DEFAULT_USER_CONFIG,
          network: {
            ...DEFAULT_USER_CONFIG.network,
            proxy: `http://127.0.0.1:${proxy.port}`,
            allowInsecureHosts: ['llm.internal.test'],
          },
        }),
      },
    );
    expect(proxy.seen[0].auth).toBe(`Basic ${Buffer.from('alice:s3cret').toString('base64')}`);
  });
});

function withInsecure(hosts) {
  return {
    ...DEFAULT_USER_CONFIG,
    network: { ...DEFAULT_USER_CONFIG.network, allowInsecureHosts: hosts },
  };
}

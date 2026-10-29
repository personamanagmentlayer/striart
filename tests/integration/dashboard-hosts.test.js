import { afterEach, describe, expect, it } from 'vitest';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createTempRepo } from '../helpers/temp-repo.js';
import { initStriart } from '../../src/init.ts';
import { startDashboard } from '../../src/dashboard.ts';
import { baseUrl, rawRequest, signIn, useLoopbackDashboard } from '../helpers/control-client.js';

/**
 * dashboardAllowedHosts : relâche UNIQUEMENT le contrôle Host. Le jeton, le
 * cookie SameSite=Strict, Sec-Fetch-Site, l'anti-CSRF et Origin restent exigés.
 */
describe('dashboard — dashboardAllowedHosts (intégration)', () => {
  let repo;
  let server;

  async function start(allowed) {
    repo = await createTempRepo();
    await initStriart(repo.root);
    await useLoopbackDashboard(repo.root);
    if (allowed)
      await writeFile(
        path.join(repo.root, '.striartrc.json'),
        JSON.stringify({ dashboardAllowedHosts: allowed, dashboardHostname: 'localhost' }),
      );
    server = await startDashboard({ root: repo.root, port: 0 });
    return server.address().port;
  }

  afterEach(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
    server = null;
    await repo?.cleanup();
  });

  const PUBLIC = 'abc-3456.app.github.dev';
  const rpcBody = '{"jsonrpc":"2.0","id":1,"method":"state.get"}';

  it('par défaut (liste vide) : un hôte public est refusé 403', async () => {
    const port = await start(null);
    const res = await rawRequest(port, '/', { headers: { Host: PUBLIC } });
    expect(res.status).toBe(403);
  });

  it('hôte non listé refusé même quand une liste existe', async () => {
    const port = await start(['*.app.github.dev']);
    for (const host of ['evil.example.com', 'a.b.app.github.dev', 'app.github.dev']) {
      expect((await rawRequest(port, '/', { headers: { Host: host } })).status, host).toBe(403);
    }
  });

  it('hôte listé : passe la barrière Host mais le jeton reste exigé (401, pas de fuite)', async () => {
    const port = await start(['*.app.github.dev']);
    const res = await rawRequest(port, '/', { headers: { Host: PUBLIC } });
    expect(res.status).toBe(401);
    expect(res.body).not.toContain(repo.root);
    const rpc = await rawRequest(port, '/rpc', {
      method: 'POST',
      headers: {
        Host: PUBLIC,
        'X-Striart': '1',
        'Content-Type': 'application/json',
        Origin: `https://${PUBLIC}`,
      },
      body: rpcBody,
    });
    expect(rpc.status).toBe(401);
  });

  it('hôte listé + session valide : page et RPC servis, cookie toujours HttpOnly; SameSite=Strict', async () => {
    const port = await start(['*.app.github.dev']);
    const { cookie, setCookie } = await signIn(server);
    expect(setCookie).toMatch(/HttpOnly/);
    expect(setCookie).toMatch(/SameSite=Strict/);
    const page = await rawRequest(port, '/', { headers: { Host: PUBLIC, Cookie: cookie } });
    expect(page.status).toBe(200);
    const rpc = await rawRequest(port, '/rpc', {
      method: 'POST',
      headers: {
        Host: PUBLIC,
        Cookie: cookie,
        'X-Striart': '1',
        'Content-Type': 'application/json',
        Origin: `https://${PUBLIC}`,
      },
      body: rpcBody,
    });
    expect(rpc.status).toBe(200);
  });

  it('l’anti-CSRF et Origin restent exigés sur un hôte listé', async () => {
    const port = await start(['*.app.github.dev']);
    const { cookie } = await signIn(server);
    const base = { Host: PUBLIC, Cookie: cookie, 'Content-Type': 'application/json' };
    const post = (headers) =>
      rawRequest(port, '/rpc', { method: 'POST', headers: { ...base, ...headers }, body: rpcBody });
    // Sans X-Striart.
    expect((await post({ Origin: `https://${PUBLIC}` })).status).toBe(403);
    // Origin d'un autre site, ou du loopback au lieu du Host reçu.
    expect((await post({ 'X-Striart': '1', Origin: 'https://evil.example.com' })).status).toBe(403);
    expect((await post({ 'X-Striart': '1', Origin: baseUrl(server) })).status).toBe(403);
    // Absent.
    expect((await post({ 'X-Striart': '1' })).status).toBe(403);
    // Sec-Fetch-Site cross-site.
    expect(
      (
        await post({
          'X-Striart': '1',
          Origin: `https://${PUBLIC}`,
          'Sec-Fetch-Site': 'cross-site',
        })
      ).status,
    ).toBe(403);
  });

  it('un cookie de session ne vaut pas jeton pour un hôte non listé', async () => {
    const port = await start(['*.app.github.dev']);
    const { cookie } = await signIn(server);
    const res = await rawRequest(port, '/', {
      headers: { Host: 'evil.example.com', Cookie: cookie },
    });
    expect(res.status).toBe(403);
  });

  it('la boucle locale reste admise avec une liste (rien n’est retiré)', async () => {
    const port = await start(['*.app.github.dev']);
    expect((await rawRequest(port, '/')).status).toBe(401);
  });
});

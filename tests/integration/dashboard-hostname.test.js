import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTempRepo } from '../helpers/temp-repo.js';
import { initStriart } from '../../src/init.ts';
import { startDashboard } from '../../src/dashboard.ts';
import { readTokenFile } from '../../src/control/auth.ts';
import { rawRequest } from '../helpers/control-client.js';

/**
 * S-I4 : le cookie de session est host-only. Servi sous `localhost`, un
 * navigateur le renvoie à tout serveur `localhost:*` (RFC 6265 §8.5) ; par
 * défaut le dashboard est donc servi sous `<id-aléatoire>.localhost` et la
 * boucle locale « nue » n'est plus servie. Node ne résout pas `*.localhost` :
 * on se connecte en 127.0.0.1 avec le Host que le navigateur enverrait.
 */
describe('dashboard — nom d’hôte propre à l’instance (S-I4)', () => {
  let repo;
  let server;

  beforeEach(async () => {
    repo = await createTempRepo();
    await initStriart(repo.root);
  });
  afterEach(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
    server = null;
    await repo.cleanup();
  });

  const hostOfUrl = (url) => new URL(url).host;

  it('défaut : lien et baseUrl sous <id>.localhost, id aléatoire propre à l’instance', async () => {
    server = await startDashboard({ root: repo.root, port: 0 });
    const { port } = server.address();
    const { url } = server.striart.signInUrl();
    const host = new URL(url).hostname;
    expect(host).toMatch(/^s[0-9a-f]{16}\.localhost$/);
    expect(server.striart.baseUrl).toBe(`http://${host}:${port}`);
    // Publié dans le fichier de jeton (le lien --link du daemon en dépend).
    expect((await readTokenFile(repo.root, port)).hostname).toBe(host);
  });

  it('l’id change d’une instance à l’autre', async () => {
    server = await startDashboard({ root: repo.root, port: 0 });
    const first = new URL(server.striart.baseUrl).hostname;
    await new Promise((resolve) => server.close(resolve));
    server = await startDashboard({ root: repo.root, port: 0 });
    expect(new URL(server.striart.baseUrl).hostname).not.toBe(first);
  });

  it('Host <id>.localhost : le lien ouvre une session, cookie host-only (pas de Domain)', async () => {
    server = await startDashboard({ root: repo.root, port: 0 });
    const { port } = server.address();
    const { url } = server.striart.signInUrl();
    const res = await rawRequest(port, `${new URL(url).pathname}${new URL(url).search}`, {
      headers: { Host: hostOfUrl(url) },
    });
    expect(res.status).toBe(303);
    const cookie = String(res.headers['set-cookie']);
    expect(cookie).toContain('HttpOnly');
    expect(cookie).not.toMatch(/Domain=/i);
  });

  it('Host localhost / 127.0.0.1 / [::1] : refusé 403, même avec un cookie valide rejoué', async () => {
    server = await startDashboard({ root: repo.root, port: 0 });
    const { port } = server.address();
    const { url } = server.striart.signInUrl();
    const signed = await rawRequest(port, `${new URL(url).pathname}${new URL(url).search}`, {
      headers: { Host: hostOfUrl(url) },
    });
    const cookie = String(signed.headers['set-cookie']).split(';')[0];
    for (const host of [`localhost:${port}`, `127.0.0.1:${port}`, `[::1]:${port}`]) {
      const replay = await rawRequest(port, '/', { headers: { Host: host, Cookie: cookie } });
      expect(replay.status, host).toBe(403);
    }
    const ok = await rawRequest(port, '/', { headers: { Host: hostOfUrl(url), Cookie: cookie } });
    expect(ok.status).toBe(200);
  });

  it('un autre sous-domaine .localhost (id deviné) est refusé', async () => {
    server = await startDashboard({ root: repo.root, port: 0 });
    const { port } = server.address();
    const res = await rawRequest(port, '/', {
      headers: { Host: `sdeadbeefdeadbeef.localhost:${port}` },
    });
    expect(res.status).toBe(403);
  });

  it("dashboardHostname: 'localhost' : repli, localhost servi, aucun hostname publié", async () => {
    const { useLoopbackDashboard } = await import('../helpers/control-client.js');
    await useLoopbackDashboard(repo.root);
    server = await startDashboard({ root: repo.root, port: 0 });
    const { port } = server.address();
    expect(server.striart.baseUrl).toBe(`http://localhost:${port}`);
    expect((await readTokenFile(repo.root, port)).hostname).toBeNull();
    const res = await rawRequest(port, '/', { headers: { Host: `localhost:${port}` } });
    expect(res.status).toBe(401);
  });
});

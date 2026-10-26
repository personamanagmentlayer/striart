import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { readFile, rm, stat, writeFile } from 'node:fs/promises';
import { execa } from 'execa';
import { createTempRepo } from '../helpers/temp-repo.js';
import { initStriart } from '../../src/init.js';
import { createAgent } from '../../src/clone.js';
import { createConflictTicket } from '../../src/conflicts.js';
import { enqueueTask } from '../../src/queue.js';
import { startDashboard } from '../../src/dashboard.js';
import { readTokenFile, tokenFilePath } from '../../src/control/auth.ts';
import {
  baseUrl,
  call,
  rawRequest,
  rpc,
  signIn,
  sseReader,
  waitFor,
  useLoopbackDashboard,
} from '../helpers/control-client.js';

/**
 * D5 — jeton obligatoire sur le dashboard (transport HTTP du Striart Control
 * Protocol) : sans session obtenue par un lien à usage unique, RIEN ne sort
 * (ni page, ni état, ni flux) ; le lien n'est pas rejouable ; le jeton n'est
 * jamais visible ; le fichier de jeton n'est lisible que par l'utilisateur.
 */
describe('dashboard — authentification par jeton (intégration)', () => {
  let repo;
  let server;

  beforeEach(async () => {
    repo = await createTempRepo();
    await initStriart(repo.root);
    await useLoopbackDashboard(repo.root);
    await createAgent({ root: repo.root, name: 'agent-secret-name', command: 'claude' });
    server = await startDashboard({ root: repo.root, port: 0 });
  });

  afterEach(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
    server = null;
    await repo.cleanup();
  });

  it('URL nue (aucun cookie : autre utilisateur, ancien favori) → 401 partout, sans fuite d’état', async () => {
    const { port } = server.address();
    for (const [route, method] of [
      ['/', 'GET'],
      ['/index.html', 'GET'],
      ['/events', 'GET'],
      ['/api/state', 'GET'],
      ['/api/events', 'GET'],
      ['/api/ticket/x', 'GET'],
      ['/rpc', 'POST'],
    ]) {
      const res = await rawRequest(port, route, {
        method,
        headers: { 'X-Striart': '1', 'Content-Type': 'application/json', Origin: baseUrl(server) },
        body: method === 'POST' ? '{"jsonrpc":"2.0","id":1,"method":"state.get"}' : null,
      });
      expect(res.status, `${method} ${route}`).toBe(401);
      expect(res.body).not.toContain('agent-secret-name');
      expect(res.body).not.toContain(repo.root);
    }
    // Message clair pour l'URL nue : quoi faire pour entrer.
    const page = await rawRequest(port, '/');
    expect(page.body).toContain('striart dashboard --link');
    // Rien d'exploitable dans la réponse JSON-RPC non plus.
    const { status, body } = await rpc(server, null, 'state.get');
    expect(status).toBe(401);
    expect(body.error.data.error).toMatchObject({
      code: 'CONTROL_UNAUTHENTICATED',
      kind: 'refusal',
    });
    expect(body).not.toHaveProperty('result');
  });

  it('cookie forgé, mal formé ou d’un autre port → 401', async () => {
    const { port } = server.address();
    for (const cookie of [
      `striart_session_${port}=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`,
      `striart_session_${port}=../../etc`,
      `striart_session_${port}=`,
      `striart_session_1=${'A'.repeat(43)}`,
    ]) {
      expect((await rpc(server, cookie, 'state.get')).status, cookie).toBe(401);
      expect((await rawRequest(port, '/', { headers: { Cookie: cookie } })).status).toBe(401);
    }
  });

  it('lien à usage unique : échangé contre un cookie HttpOnly; SameSite=Strict; Path=/, puis NON rejouable', async () => {
    const { cookie, setCookie, url } = await signIn(server);
    expect(setCookie).toMatch(/HttpOnly/);
    expect(setCookie).toMatch(/SameSite=Strict/);
    expect(setCookie).toMatch(/Path=\//);
    expect(setCookie).not.toMatch(/Domain=/i);

    // La session ouvre l'état et la page.
    const page = await fetch(`${baseUrl(server)}/`, { headers: { Cookie: cookie } });
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('Striart');
    const state = await call(server, cookie, 'state.get');
    expect(state.data.agents[0].name).toBe('agent-secret-name');

    // Rejeu du même lien : refusé, aucun nouveau cookie.
    const replay = await fetch(url, { redirect: 'manual' });
    expect(replay.status).toBe(403);
    expect(replay.headers.get('set-cookie')).toBeNull();
    expect(await replay.text()).toContain('striart dashboard --link');
  });

  it('code altéré, absent ou expiré → 403, jamais de session', async () => {
    const { url } = server.striart.signInUrl();
    const tampered = url.replace(/.$/, (c) => (c === 'A' ? 'B' : 'A'));
    for (const target of [
      tampered,
      `${baseUrl(server)}/auth`,
      `${baseUrl(server)}/auth?code=v1.x.y.z`,
      `${baseUrl(server)}/auth?code=${'a'.repeat(5000)}`,
    ]) {
      const res = await fetch(target, { redirect: 'manual' });
      expect(res.status, target.slice(0, 80)).toBe(403);
      expect(res.headers.get('set-cookie')).toBeNull();
    }
    const expired = server.striart.signInUrl({ ttlMs: 1 });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect((await fetch(expired.url, { redirect: 'manual' })).status).toBe(403);
  });

  it('le jeton n’apparaît ni dans le lien, ni dans le cookie, ni dans les réponses', async () => {
    const { port } = server.address();
    const { token } = await readTokenFile(repo.root, port);
    const secret = token.toString('base64url');
    const { cookie, url } = await signIn(server);
    expect(url).not.toContain(secret);
    expect(cookie).not.toContain(secret);
    const page = await (await fetch(`${baseUrl(server)}/`, { headers: { Cookie: cookie } })).text();
    expect(page).not.toContain(secret);
    const state = JSON.stringify(await call(server, cookie, 'state.get'));
    expect(state).not.toContain(secret);
  });

  it('fichier de jeton : lisible par l’utilisateur courant SEUL (0600 POSIX, ACL protégée Windows)', async () => {
    const file = tokenFilePath(repo.root, server.address().port);
    if (process.platform === 'win32') {
      // Chemins System32 explicites : le `whoami` de Git Bash masque celui de Windows.
      const system32 = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32');
      const { stdout } = await execa(path.join(system32, 'whoami.exe'), [
        '/user',
        '/fo',
        'csv',
        '/nh',
      ]);
      const sid = /"(S-1-[0-9-]+)"/.exec(stdout)[1];
      const dump = path.join(os.tmpdir(), `striart-acl-${process.pid}-${Date.now()}.txt`);
      await execa(path.join(system32, 'icacls.exe'), [file, '/save', dump]);
      const sddl = /D:[^\r\n]*/.exec((await readFile(dump)).toString('utf16le'))[0];
      await rm(dump, { force: true });
      // Protégée (P : aucun ACE hérité du dossier), un seul ACE : l'utilisateur.
      expect(sddl).toMatch(/^D:P/);
      const aces = [...sddl.matchAll(/\(([^)]*)\)/g)].map((m) => m[1].split(';'));
      expect(aces.length).toBe(1);
      // Le formateur SDDL substitue un alias au SID de l'administrateur local (RID 500,
      // ex. `runneradmin` en CI → `LA`) : le MÊME compte, jamais un autre.
      const aliases = /^S-1-5-21-\d+-\d+-\d+-500$/.test(sid) ? [sid, 'LA'] : [sid];
      expect(aliases).toContain(aces[0][5]);
    } else {
      expect((await stat(file)).mode & 0o777).toBe(0o600);
      expect((await stat(path.dirname(file))).mode & 0o077).toBe(0);
    }
  });

  it('le fichier de jeton est retiré à l’arrêt du serveur', async () => {
    const file = tokenFilePath(repo.root, server.address().port);
    await stat(file);
    await new Promise((resolve) => server.close(resolve));
    server = null;
    await expect(stat(file)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('en PLUS du cookie : Origin étranger, X-Striart absent, Content-Type simple, Sec-Fetch-Site cross-site → 403', async () => {
    const { cookie } = await signIn(server);
    const cases = [
      { Origin: 'http://evil.example' },
      { Origin: 'http://localhost:1' }, // autre port local : même site, autre origine
      { 'X-Striart': '' },
      { 'Content-Type': 'text/plain' },
      { 'Sec-Fetch-Site': 'cross-site' },
      { 'Sec-Fetch-Site': 'same-site' },
    ];
    for (const headers of cases) {
      const res = await rpc(server, cookie, 'semantic.unlock', {}, { headers });
      expect(res.status, JSON.stringify(headers)).toBe(403);
      expect(res.body.error.data.error.code).toMatch(/^CONTROL_(ORIGIN|CSRF)_REFUSED$/);
    }
    // POST sans Origin du tout (formulaire d'un client non navigateur) : refusé aussi.
    const noOrigin = await rawRequest(server.address().port, '/rpc', {
      method: 'POST',
      headers: { Cookie: cookie, 'X-Striart': '1', 'Content-Type': 'application/json' },
      body: '{"jsonrpc":"2.0","id":1,"method":"state.get"}',
    });
    expect(noOrigin.status).toBe(403);
  });

  it('Host non local → 403 AVANT tout, même avec un cookie valide (DNS rebinding)', async () => {
    const { cookie } = await signIn(server);
    const { port } = server.address();
    for (const route of ['/', '/events', '/rpc', '/auth?code=x']) {
      const res = await rawRequest(port, route, {
        method: route === '/rpc' ? 'POST' : 'GET',
        headers: {
          Host: 'evil.example',
          Cookie: cookie,
          'X-Striart': '1',
          Origin: 'http://evil.example',
        },
      });
      expect(res.status, route).toBe(403);
    }
  });

  it('en-têtes de sécurité : CSP stricte sans unsafe-inline, nosniff, no-referrer, no-store, frame-ancestors none', async () => {
    const { cookie } = await signIn(server);
    const res = await fetch(`${baseUrl(server)}/`, { headers: { Cookie: cookie } });
    const csp = res.headers.get('content-security-policy');
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).not.toContain('unsafe-inline');
    expect(csp).toMatch(/script-src 'sha256-/);
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
    expect(res.headers.get('cache-control')).toContain('no-store');
  });

  it('les anciennes routes /api/* répondent 410 (rupture assumée, message clair) une fois connecté', async () => {
    const { cookie } = await signIn(server);
    const res = await fetch(`${baseUrl(server)}/api/state`, { headers: { Cookie: cookie } });
    expect(res.status).toBe(410);
    expect(await res.text()).toMatch(/POST \/rpc/);
  });
});

describe('dashboard — SSE avec contre-pression (intégration)', () => {
  let repo;
  let server;

  beforeEach(async () => {
    repo = await createTempRepo();
    await initStriart(repo.root);
    await useLoopbackDashboard(repo.root);
  });

  afterEach(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
    server = null;
    await repo.cleanup();
  });

  it('chaque trame porte un numéro de séquence ; la reconnexion repart de l’état complet', async () => {
    server = await startDashboard({ root: repo.root, port: 0 });
    const { cookie } = await signIn(server);
    const res = await fetch(`${baseUrl(server)}/events`, { headers: { Cookie: cookie } });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const next = sseReader(res.body);
    const first = await next('state.changed');
    expect(first.message).toMatchObject({ jsonrpc: '2.0', method: 'state.changed' });
    expect(first.message.params.seq).toBe(1);
    expect(first.id).toBe('1');
    expect(first.message.params.state.revision).toBeGreaterThanOrEqual(1);

    await createAgent({ root: repo.root, name: 'agent-sse' });
    let frame;
    do {
      frame = await next('state.changed');
    } while (!frame.message.params.state.agents.some((a) => a.name === 'agent-sse'));
    expect(frame.message.params.seq).toBeGreaterThan(1);
    expect(Number(frame.id)).toBe(frame.message.params.seq);
    expect(frame.message.params.state.revision).toBeGreaterThan(
      first.message.params.state.revision,
    );
    await next.cancel();

    // Reconnexion : nouvel abonnement, état complet d'emblée (idempotent).
    const again = await fetch(`${baseUrl(server)}/events`, { headers: { Cookie: cookie } });
    const nextAgain = sseReader(again.body);
    const fresh = await nextAgain('state.changed');
    expect(fresh.message.params.seq).toBe(1);
    expect(fresh.message.params.state.agents.map((a) => a.name)).toContain('agent-sse');
    await nextAgain.cancel();
  });

  it('un client SSE lent est déconnecté explicitement ; un client rapide continue d’être servi', async () => {
    // Seuil minimal autorisé, et un état volumineux (prompts des tickets) :
    // chaque trame dépasse de loin les tampons du noyau.
    await writeFile(
      path.join(repo.root, '.striartrc.json'),
      JSON.stringify({
        testCommand: 'node -e "process.exit(0)"',
        controlSseMaxBufferedBytes: 65_536,
        dashboardHostname: 'localhost',
      }),
    );
    for (let i = 0; i < 3; i += 1) {
      await createConflictTicket(repo.root, {
        agent: `agent-${i}`,
        branch: `striart/agent-${i}/task-x`,
        sha: String(i).repeat(40),
        reason: 'GATE_FAILED',
        prompt: 'p'.repeat(1_500_000),
        conflictedFiles: ['src/a.ts'],
      });
    }
    server = await startDashboard({ root: repo.root, port: 0 });
    const { port } = server.address();
    const { cookie } = await signIn(server);

    // Client lent : envoie sa requête puis ne lit plus jamais.
    const slow = net.connect(port, '127.0.0.1');
    await new Promise((resolve) => slow.once('connect', resolve));
    slow.write(`GET /events HTTP/1.1\r\nHost: localhost:${port}\r\nCookie: ${cookie}\r\n\r\n`);
    slow.pause();
    let slowClosed = false;
    slow.on('close', () => {
      slowClosed = true;
    });
    slow.on('error', () => {
      // ECONNRESET attendu : c'est la déconnexion explicite.
    });

    // Client rapide : lit en continu.
    const fast = await fetch(`${baseUrl(server)}/events`, { headers: { Cookie: cookie } });
    const nextFast = sseReader(fast.body);
    await nextFast('state.changed');
    await waitFor(() => server.striart.stats().subscribers === 2);

    // Changements successifs jusqu'à ce que le hub coupe le client lent.
    let n = 0;
    await waitFor(
      async () => {
        await enqueueTask(repo.root, {
          agent: `queued-${n++}`,
          prompt: 'x',
          predictedFiles: ['src/a.ts'],
          collisions: [],
        });
        // Le client rapide consomme ce qui arrive.
        await nextFast('state.changed', 10_000);
        return server.striart.stats().slowDisconnects >= 1;
      },
      { timeoutMs: 60_000, intervalMs: 50 },
    );
    expect(server.striart.stats().subscribers).toBe(1);

    // Le client rapide est toujours servi après la coupure.
    await enqueueTask(repo.root, {
      agent: 'after-cut',
      prompt: 'x',
      predictedFiles: [],
      collisions: [],
    });
    let frame;
    do {
      frame = await nextFast('state.changed', 20_000);
    } while (!frame.message.params.state.tasks.some((t) => t.agent === 'after-cut'));

    // Le client lent constate la coupure dès qu'il relit.
    slow.resume();
    await waitFor(() => slowClosed, { timeoutMs: 20_000 });
    await nextFast.cancel();
  }, 120_000);
});

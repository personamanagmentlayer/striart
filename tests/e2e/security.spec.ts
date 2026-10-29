import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { expect, test } from '@playwright/test';
import { DashboardServer } from './support/dashboard-server.ts';
import { rawRequest } from './support/helpers.ts';

/**
 * Connexion et surface de sécurité CÔTÉ NAVIGATEUR : lien à usage unique,
 * barrières Host, CSP effective, absence d'inline non maîtrisé, aucune fuite
 * de jeton (URL, Referer, stockage, console), contenu non fiable inerte.
 * Complète les tests d'intégration (HTTP brut) par ce que seul un vrai
 * navigateur applique : la CSP, SameSite, Referrer-Policy, le DOM final.
 */

let server: DashboardServer;
test.beforeAll(async () => {
  server = await DashboardServer.start({
    agents: 1,
    tickets: 1,
    queue: 1,
    permissions: 1,
    elicitation: true,
    mainSession: true,
  });
});
test.afterAll(async () => {
  await server.close();
});

test.describe('connexion par lien à usage unique', () => {
  test('le lien ouvre le dashboard, le code quitte l’URL et ne sert qu’une fois', async ({
    browser,
  }) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    const { url } = await server.link();
    const code = new URL(url).searchParams.get('code')!;
    await page.goto(url);
    await page.waitForURL(`${server.baseUrl}/`);
    // Après la redirection, ni l'URL ni l'historique ne contiennent le code.
    expect(page.url()).not.toContain(code);
    await expect(page.locator('#agents .agent').first()).toBeVisible();
    const entries = await page.evaluate(() => ({
      href: location.href,
      referrer: document.referrer,
      cookie: document.cookie,
      local: localStorage.length,
      session: sessionStorage.length,
    }));
    expect(entries.href).not.toContain('code=');
    expect(entries.referrer, 'Referer de la page').toBe('');
    expect(entries.cookie, 'le cookie de session est HttpOnly').toBe('');
    expect(entries.local + entries.session, 'aucun stockage navigateur').toBe(0);
    const cookies = await context.cookies();
    expect(cookies).toHaveLength(1);
    expect(cookies[0]).toMatchObject({ httpOnly: true, sameSite: 'Strict', path: '/' });
    expect(cookies[0].domain).not.toMatch(/^\./);

    // Rejeu du même lien dans un contexte vierge : refusé, message actionnable.
    const stranger = await browser.newContext();
    const strangerPage = await stranger.newPage();
    const response = await strangerPage.goto(url);
    expect(response?.status()).toBe(403);
    await expect(strangerPage.locator('main')).toContainText('striart dashboard --link');
    expect(await stranger.cookies()).toHaveLength(0);
    await context.close();
    await stranger.close();
  });

  test('jeton absent, code altéré ou vide : refus sans session', async ({ browser }) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    const { url } = await server.link();
    for (const target of [
      `${server.baseUrl}/auth`,
      `${server.baseUrl}/auth?code=`,
      `${server.baseUrl}/auth?code=v1.faux.faux.faux`,
      url.slice(0, -2) + 'AA',
    ]) {
      const response = await page.goto(target);
      expect(response?.status(), target).toBe(403);
    }
    expect(await context.cookies()).toHaveLength(0);
    // Sans session : la page ne divulgue rien du dépôt.
    const bare = await page.goto(`${server.baseUrl}/`);
    expect(bare?.status()).toBe(401);
    const html = await page.content();
    expect(html).not.toContain('agent-00');
    expect(html).not.toContain(server.root);
    await context.close();
  });

  test('lien expiré : refusé', async ({ browser }) => {
    const { url } = await server.cmd<{ url: string }>('linkWithTtl', { ttlMs: 1 });
    await new Promise((r) => setTimeout(r, 300));
    const context = await browser.newContext();
    const page = await context.newPage();
    const response = await page.goto(url);
    expect(response?.status()).toBe(403);
    await context.close();
  });

  test('Host étranger ou boucle locale nue : 403 (anti-DNS-rebinding), même pour la page', async () => {
    for (const host of [
      'evil.example',
      `evil.example:${server.port}`,
      `localhost:${server.port}`,
      `127.0.0.1:${server.port}`,
      `autre.localhost:${server.port}`,
    ]) {
      for (const route of ['/', '/events', '/auth?code=x', '/rpc']) {
        const res = await rawRequest(server.port, route, { Host: host });
        expect(res.status, `${host} ${route}`).toBe(403);
        expect(res.body).not.toContain('agent-00');
      }
    }
  });

  test('session perdue en cours de route : message clair, plus aucune action', async ({
    browser,
  }) => {
    const context = await server.signedInContext(browser);
    const page = await server.openPage(context);
    await context.clearCookies();
    await page.locator('#maint-btn').click();
    await page.locator('#doctor-btn').click();
    const alert = page.locator('#auth [role="alert"]');
    await expect(alert).toBeVisible();
    await expect(alert).toContainText('striart dashboard --link');
    await expect(page.locator('#live')).toContainText(/hors ligne/i);
    await context.close();
  });
});

test.describe('politique de sécurité du contenu et en-têtes', () => {
  test('en-têtes de la page : CSP stricte à empreintes, aucune source externe', async ({
    browser,
  }) => {
    const context = await server.signedInContext(browser);
    const page = await context.newPage();
    const response = await page.goto(`${server.baseUrl}/`);
    const headers = response!.headers();
    const csp = headers['content-security-policy'];
    expect(csp).toMatch(/default-src 'none'/);
    expect(csp).not.toMatch(/unsafe-inline|unsafe-eval|\*|https?:/);
    expect(csp).toMatch(/base-uri 'none'/);
    expect(csp).toMatch(/form-action 'none'/);
    expect(csp).toMatch(/frame-ancestors 'none'/);
    expect(csp).toMatch(/connect-src 'self'/);
    // Les empreintes de la CSP sont CELLES du script et du style réellement servis.
    const html = await response!.text();
    const script = html.match(/<script>([\s\S]*?)<\/script>/)![1];
    const style = html.match(/<style>([\s\S]*?)<\/style>/)![1];
    const hash = (text: string) =>
      `'sha256-${createHash('sha256').update(text, 'utf8').digest('base64')}'`;
    expect(csp).toContain(`script-src ${hash(script)}`);
    expect(csp).toContain(`style-src ${hash(style)}`);
    expect(headers['x-content-type-options']).toBe('nosniff');
    expect(headers['referrer-policy']).toBe('no-referrer');
    expect(headers['cache-control']).toBe('no-store');
    expect(headers['x-frame-options']).toBe('DENY');
    expect(headers['cross-origin-opener-policy']).toBe('same-origin');
    expect(headers['cross-origin-resource-policy']).toBe('same-origin');
    await context.close();
  });

  test('aucune ressource externe, aucun inline non maîtrisé, aucune violation CSP, console propre', async ({
    browser,
  }) => {
    const context = await server.signedInContext(browser);
    const page = await context.newPage();
    const consoleLines: string[] = [];
    const requests: Array<{ url: string; headers: Record<string, string> }> = [];
    page.on('console', (m) => consoleLines.push(`${m.type()}: ${m.text()}`));
    page.on('pageerror', (e) => consoleLines.push(`pageerror: ${e.message}`));
    page.on('request', (r) => requests.push({ url: r.url(), headers: r.headers() }));
    await page.addInitScript(() => {
      (window as unknown as { __csp: string[] }).__csp = [];
      document.addEventListener('securitypolicyviolation', (e) =>
        (window as unknown as { __csp: string[] }).__csp.push(
          `${e.violatedDirective} ${e.blockedURI}`,
        ),
      );
    });
    await page.goto(`${server.baseUrl}/`);
    await expect(page.locator('#tickets table')).toBeVisible();
    // Parcours : détail de ticket, diagnostic, armement d'un bouton.
    await page.locator('button.open-ticket').first().click();
    await page.locator('#ticket-detail .detail').waitFor();
    await page.locator('#maint-btn').click();
    await page.locator('#doctor-btn').click();
    await page.locator('#doctor-detail table').waitFor();
    await page.locator('#dlg-doctor [data-close-dlg]').first().click();
    await page.locator('[data-agent-menu]').first().click();
    await page.getByRole('menuitem', { name: /Arrêt forcé/ }).click();
    await page.locator('#dlg-confirm[open]').waitFor();

    const inventory = await page.evaluate(() => ({
      inlineScripts: document.querySelectorAll('script:not([src])').length,
      externalScripts: document.querySelectorAll(
        'script[src], link[rel="stylesheet"], iframe, object, embed, img[src], link[href^="http"]',
      ).length,
      styleBlocks: document.querySelectorAll('style').length,
      styleAttributes: document.querySelectorAll('[style]').length,
      handlers: [...document.querySelectorAll('*')].flatMap((el) =>
        el.getAttributeNames().filter((n) => n.startsWith('on')),
      ).length,
      jsUrls: document.querySelectorAll('[href^="javascript:" i], [src^="javascript:" i]').length,
      csp: (window as unknown as { __csp: string[] }).__csp,
    }));
    expect(inventory.inlineScripts).toBe(1);
    expect(inventory.styleBlocks).toBe(1);
    expect(inventory.externalScripts).toBe(0);
    expect(inventory.styleAttributes, 'attributs style (la CSP les bloque)').toBe(0);
    expect(inventory.handlers, 'gestionnaires on*').toBe(0);
    expect(inventory.jsUrls).toBe(0);
    expect(inventory.csp, 'violations CSP').toEqual([]);
    // Toutes les requêtes restent sur l'origine du dashboard.
    const origin = new URL(server.baseUrl).origin;
    const foreign = requests.filter((r) => !r.url.startsWith(origin) && !r.url.startsWith('data:'));
    expect(foreign.map((r) => r.url)).toEqual([]);
    // Aucun en-tête Referer (Referrer-Policy: no-referrer) et jamais de jeton dans une requête.
    for (const r of requests) {
      expect(r.headers['referer'] ?? '', `Referer sur ${r.url}`).toBe('');
      expect(r.url).not.toMatch(/[?&]code=/);
    }
    // Console : aucune erreur, aucun avertissement, aucun jeton.
    expect(consoleLines.filter((l) => /^(error|warning|pageerror)/.test(l))).toEqual([]);
    expect(consoleLines.join('\n')).not.toMatch(/v1\.[A-Za-z0-9_-]{10,}/);
    await context.close();
  });

  test('contenu non fiable inerte : balises d’un agent, d’un log ou d’une question jamais exécutées', async ({
    browser,
  }) => {
    const context = await server.signedInContext(browser);
    const page = await context.newPage();
    const dialogs: string[] = [];
    page.on('dialog', async (d) => {
      dialogs.push(d.message());
      await d.dismiss();
    });
    await page.goto(`${server.baseUrl}/`);
    await page.locator('button.open-ticket').first().click();
    await page.locator('#ticket-detail pre').first().waitFor();
    // Le log du ticket contient <script>window.__pwned = 1</script> : texte, pas code.
    await expect(page.locator('#ticket-detail')).toContainText(
      '<script>window.__pwned = 1</script>',
    );
    // La question d'agent contient <img src=x onerror=alert(1)> : affichée telle quelle.
    await expect(page.locator('#elicitations')).toContainText('<img src=x onerror=alert(1)>');
    expect(await page.locator('#elicitations img, #ticket-detail script').count()).toBe(0);
    expect(
      await page.evaluate(() => (window as unknown as { __pwned?: number }).__pwned),
    ).toBeUndefined();
    expect(dialogs).toEqual([]);
    await context.close();
  });

  test('un autre site ne peut rien déclencher : requête inter-origine refusée', async ({
    browser,
  }) => {
    // Une page « étrangère » (autre origine, boucle locale) tente d'appeler /rpc.
    const other: Server = createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<!doctype html><title>autre site</title>');
    });
    await new Promise<void>((resolve) => other.listen(0, '127.0.0.1', resolve));
    const otherPort = (other.address() as { port: number }).port;
    const context = await server.signedInContext(browser);
    try {
      const foreign = await context.newPage();
      await foreign.goto(`http://127.0.0.1:${otherPort}/`);
      const outcome = await foreign.evaluate(async (target) => {
        try {
          const r = await fetch(`${target}/rpc`, {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json', 'X-Striart': '1' },
            body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'mainSession.release' }),
          });
          return `status ${r.status}`;
        } catch (e) {
          return `blocked: ${(e as Error).name}`;
        }
      }, server.baseUrl);
      expect(outcome).toMatch(/^blocked/);
      // La session principale est toujours déclarée : rien n'a été exécuté.
      const page = await server.openPage(context);
      await expect(page.locator('#main-session .card')).toBeVisible();
    } finally {
      await context.close();
      await new Promise((resolve) => other.close(resolve));
    }
  });

  test('l’icône est servie sans donnée ni 401 bruyant', async () => {
    const res = await rawRequest(server.port, '/favicon.ico', {
      Host: new URL(server.baseUrl).host,
    });
    expect(res.status).toBe(204);
    expect(res.body).toBe('');
  });
});

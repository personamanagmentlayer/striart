import { expect, test, type Page } from '@playwright/test';
import { CutProxy } from './support/cut-proxy.ts';
import { DashboardServer } from './support/dashboard-server.ts';
import { stabilize } from './support/helpers.ts';

/**
 * Captures de référence (toHaveScreenshot) : largeurs 360 / 768 / 1280 / 1920,
 * thèmes clair et sombre (prefers-color-scheme), textes longs, français et
 * anglais, zoom 200 % et 400 %, états clés. Les références sont propres à la
 * plateforme (polices) : `__screenshots__/<plateforme>/`.
 * Mise à jour volontaire : `npm run test:e2e -- visual --update-snapshots`.
 */

const WIDTHS = [360, 768, 1280, 1920];
const SCHEMES = ['light', 'dark'] as const;

async function settle(page: Page): Promise<void> {
  await page.evaluate(() => document.fonts.ready);
  await stabilize(page);
  // Le curseur et la sélection ne doivent pas figurer dans une référence.
  await page.mouse.move(0, 0);
}

test.describe('page complète — matrice largeur × thème', () => {
  let server: DashboardServer;
  test.beforeAll(async () => {
    server = await DashboardServer.start({
      agents: 3,
      tickets: 3,
      queue: 3,
      permissions: 2,
      elicitation: true,
      mainSession: true,
      profiles: true,
    });
  });
  test.afterAll(async () => {
    await server.close();
  });

  for (const scheme of SCHEMES) {
    for (const width of WIDTHS) {
      test(`${scheme} ${width}px`, async ({ browser }) => {
        const context = await server.signedInContext(browser, {
          colorScheme: scheme,
          viewport: { width, height: 900 },
          locale: 'fr-FR',
          timezoneId: 'Europe/Paris',
        });
        const page = await server.openPage(context);
        await page.locator('#tickets table').waitFor();
        await settle(page);
        await expect(page).toHaveScreenshot(`page-${scheme}-${width}.png`, { fullPage: true });
        await context.close();
      });
    }
  }

  for (const scheme of SCHEMES) {
    test(`états : ticket ouvert — ${scheme}`, async ({ browser }) => {
      const context = await server.signedInContext(browser, {
        colorScheme: scheme,
        viewport: { width: 1280, height: 900 },
        timezoneId: 'Europe/Paris',
      });
      const page = await server.openPage(context);
      await page.locator('button.open-ticket').first().click();
      await page.locator('#ticket-detail .detail').waitFor();
      await settle(page);
      await expect(page.locator('#ticket-detail')).toHaveScreenshot(`ticket-open-${scheme}.png`);
      await context.close();
    });
  }
});

test.describe('zoom, texte long, langue, états vide et hors ligne', () => {
  test('zoom 200 % (≈ 640 px) et 400 % (≈ 320 px) : reflow lisible', async ({ browser }) => {
    const server = await DashboardServer.start({ agents: 2, tickets: 2, permissions: 1 });
    try {
      for (const [name, width] of [
        ['zoom200', 640],
        ['zoom400', 320],
      ] as const) {
        const context = await server.signedInContext(browser, {
          colorScheme: 'light',
          viewport: { width, height: 800 },
          deviceScaleFactor: 1,
          timezoneId: 'Europe/Paris',
        });
        const page = await server.openPage(context);
        await page.locator('#tickets table').waitFor();
        await settle(page);
        await expect(page).toHaveScreenshot(`${name}-light.png`, { fullPage: true });
        await context.close();
      }
    } finally {
      await server.close();
    }
  });

  test('textes longs (noms, chemins, prompts, questions) : aucun débordement', async ({
    browser,
  }) => {
    const server = await DashboardServer.start({
      agents: 2,
      tickets: 1,
      queue: 1,
      permissions: 1,
      long: true,
    });
    try {
      for (const width of [360, 1280]) {
        const context = await server.signedInContext(browser, {
          colorScheme: 'dark',
          viewport: { width, height: 900 },
          timezoneId: 'Europe/Paris',
        });
        const page = await server.openPage(context);
        await page.locator('#tickets table').waitFor();
        const overflow = await page.evaluate(() => ({
          doc: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        }));
        expect(overflow.doc, `débordement horizontal à ${width}px`).toBeLessThanOrEqual(0);
        await settle(page);
        await expect(page).toHaveScreenshot(`long-dark-${width}.png`, { fullPage: true });
        await context.close();
      }
    } finally {
      await server.close();
    }
  });

  test('anglais : même mise en page, libellés plus longs sans rognage', async ({ browser }) => {
    const server = await DashboardServer.start(
      { agents: 2, tickets: 2, queue: 1, permissions: 1, mainSession: true },
      { STRIART_LANG: 'en' },
    );
    try {
      for (const width of [360, 1280]) {
        const context = await server.signedInContext(browser, {
          colorScheme: 'light',
          viewport: { width, height: 900 },
          locale: 'en-US',
          timezoneId: 'Europe/Paris',
        });
        const page = await server.openPage(context);
        await page.locator('#tickets table').waitFor();
        await settle(page);
        await expect(page).toHaveScreenshot(`en-light-${width}.png`, { fullPage: true });
        await context.close();
      }
    } finally {
      await server.close();
    }
  });

  test('dépôt vide, clair et sombre', async ({ browser }) => {
    const server = await DashboardServer.start({});
    try {
      for (const scheme of SCHEMES) {
        const context = await server.signedInContext(browser, {
          colorScheme: scheme,
          // Hauteur fixe, hors pleine page : la hauteur du document varie d'un pixel
          // d'une exécution à l'autre (arrondis de mise en page), la capture non.
          viewport: { width: 1280, height: 1200 },
          timezoneId: 'Europe/Paris',
        });
        const page = await server.openPage(context);
        await page.locator('#history .quiet').waitFor();
        await settle(page);
        await expect(page).toHaveScreenshot(`empty-${scheme}.png`);
        await context.close();
      }
    } finally {
      await server.close();
    }
  });

  test('hors ligne : bandeau d’obsolescence', async ({ browser }) => {
    const server = await DashboardServer.start({ agents: 1 });
    const proxy = await CutProxy.start(server.port);
    try {
      const { context, base } = await server.signedInContextVia(browser, proxy.port, {
        colorScheme: 'light',
        viewport: { width: 1280, height: 700 },
        timezoneId: 'Europe/Paris',
      });
      const page = await context.newPage();
      await page.goto(`${base}/`);
      await expect(page.locator('#live')).toContainText(/en direct/i);
      proxy.cut();
      await expect(page.locator('#banner [role="status"]')).toBeVisible({ timeout: 20_000 });
      await settle(page);
      await expect(page.locator('#banner')).toHaveScreenshot('offline-banner-light.png');
      await context.close();
    } finally {
      await proxy.close();
      await server.close();
    }
  });

  test('pages sans script : connexion requise et lien refusé', async ({ browser }) => {
    const server = await DashboardServer.start({});
    try {
      for (const scheme of SCHEMES) {
        const context = await browser.newContext({
          colorScheme: scheme,
          viewport: { width: 768, height: 400 },
        });
        const page = await context.newPage();
        await page.goto(`${server.baseUrl}/`);
        await expect(page).toHaveScreenshot(`signin-required-${scheme}.png`);
        await page.goto(`${server.baseUrl}/auth?code=faux`);
        await expect(page).toHaveScreenshot(`signin-refused-${scheme}.png`);
        await context.close();
      }
    } finally {
      await server.close();
    }
  });
});

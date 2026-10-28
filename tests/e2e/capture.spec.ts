import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { test, type Page } from '@playwright/test';
import { CutProxy } from './support/cut-proxy.ts';
import { DashboardServer, type Scenario } from './support/dashboard-server.ts';

/**
 * Captures de revue de conception (hors CI) : un jeu d'écrans par état, en clair
 * et en sombre, à 1440 / 768 / 390 px. Sans `E2E_CAPTURE_DIR` la suite est ignorée ;
 * avec, elle écrit les PNG dans ce dossier pour une relecture humaine.
 * `E2E_CAPTURE_DIR=… npx playwright test capture`
 */
const OUT = process.env.E2E_CAPTURE_DIR;
const SIZES = [
  { name: '1440', width: 1440, height: 900 },
  { name: '768', width: 768, height: 1000 },
  { name: '390', width: 390, height: 844 },
];
const SCHEMES = ['light', 'dark'] as const;

test.skip(!OUT, 'E2E_CAPTURE_DIR non défini');

async function shoot(page: Page, name: string, fullPage = true): Promise<void> {
  await mkdir(OUT!, { recursive: true });
  await page.mouse.move(0, 0);
  await page.screenshot({ path: path.join(OUT!, `${name}.png`), fullPage });
}

async function each(
  scenario: Scenario,
  label: string,
  prepare: (page: Page) => Promise<void>,
  browser: Parameters<DashboardServer['signedInContext']>[0],
  options: { fullPage?: boolean; sizes?: typeof SIZES } = {},
): Promise<void> {
  const server = await DashboardServer.start(scenario);
  try {
    for (const scheme of SCHEMES) {
      for (const size of options.sizes ?? SIZES) {
        const context = await server.signedInContext(browser, {
          colorScheme: scheme,
          viewport: { width: size.width, height: size.height },
          locale: 'fr-FR',
          timezoneId: 'Europe/Paris',
        });
        const page = await server.openPage(context);
        await page.waitForTimeout(400);
        await prepare(page);
        await shoot(page, `${label}-${scheme}-${size.name}`, options.fullPage ?? true);
        await context.close();
      }
    }
  } finally {
    await server.close();
  }
}

const DEMO: Scenario = { agents: 4, tickets: 1, queue: 1, demo: true, profiles: true };

test.describe('captures', () => {
  test.setTimeout(600_000);

  test('démo : 4 agents + un conflit', async ({ browser }) => {
    await each(DEMO, 'demo', async () => {}, browser);
  });

  test('démo riche : permission, session principale, watcher, agent manquant', async ({
    browser,
  }) => {
    await each(
      { ...DEMO, tickets: 3, permissions: 1, mainSession: true, missing: 1 },
      'riche',
      async () => {},
      browser,
    );
  });

  test('dépôt vide', async ({ browser }) => {
    await each({}, 'vide', async () => {}, browser);
  });

  test('50 agents', async ({ browser }) => {
    await each({ agents: 50, tickets: 2, queue: 3 }, 'agents50', async () => {}, browser, {
      fullPage: false,
    });
  });

  test('dialogue nouvelle tâche', async ({ browser }) => {
    await each(
      DEMO,
      'dialogue-tache',
      async (page) => {
        await page.keyboard.press('n');
        await page.locator('#dlg-task[open]').waitFor();
        await page.locator('#task-prompt').fill('Corrige le bug du panier');
      },
      browser,
      { fullPage: false },
    );
  });

  test('menu d’un agent ouvert', async ({ browser }) => {
    await each(
      DEMO,
      'menu-agent',
      async (page) => {
        await page.locator('[data-agent-menu]').first().click();
        await page.locator('.menu-panel:not([hidden])').waitFor();
      },
      browser,
    );
  });

  test('menu maintenance ouvert', async ({ browser }) => {
    await each(
      DEMO,
      'menu-maintenance',
      async (page) => {
        await page.locator('#maint-btn').click();
        await page.locator('#maint-panel:not([hidden])').waitFor();
      },
      browser,
      { fullPage: false },
    );
  });

  test('confirmation saisie (arrêt forcé)', async ({ browser }) => {
    await each(
      DEMO,
      'confirmation',
      async (page) => {
        await page.locator('[data-agent-menu]').first().click();
        await page.getByRole('menuitem', { name: /Arrêt forcé/ }).click();
        await page.locator('#dlg-confirm[open]').waitFor();
      },
      browser,
      { fullPage: false },
    );
  });

  test('détail d’un agent', async ({ browser }) => {
    await each(
      DEMO,
      'detail-agent',
      async (page) => {
        await page.locator('[data-agent-menu]').first().click();
        await page.getByRole('menuitem', { name: /Détails/ }).click();
        await page.locator('#dlg-agent[open]').waitFor();
      },
      browser,
      { fullPage: false },
    );
  });

  test('carte d’alerte (zone À traiter)', async ({ browser }) => {
    const server = await DashboardServer.start({ ...DEMO, tickets: 2, permissions: 1 });
    try {
      for (const scheme of SCHEMES) {
        const context = await server.signedInContext(browser, {
          colorScheme: scheme,
          viewport: { width: 1000, height: 900 },
          timezoneId: 'Europe/Paris',
        });
        const page = await server.openPage(context);
        await page.locator('#sec-attention .card').first().waitFor();
        await mkdir(OUT!, { recursive: true });
        await page
          .locator('#sec-attention')
          .screenshot({ path: path.join(OUT!, `alertes-${scheme}.png`) });
        await context.close();
      }
    } finally {
      await server.close();
    }
  });

  test('hors ligne', async ({ browser }) => {
    const server = await DashboardServer.start(DEMO);
    const proxy = await CutProxy.start(server.port);
    try {
      for (const scheme of SCHEMES) {
        for (const size of SIZES) {
          const { context, base } = await server.signedInContextVia(browser, proxy.port, {
            colorScheme: scheme,
            viewport: { width: size.width, height: size.height },
            timezoneId: 'Europe/Paris',
          });
          const page = await context.newPage();
          await page.goto(`${base}/`);
          await page.locator('#live.is-live').waitFor();
          proxy.cut();
          await page.locator('#banner [role="status"]').waitFor({ timeout: 20_000 });
          await shoot(page, `hors-ligne-${scheme}-${size.name}`, false);
          proxy.resume();
          await context.close();
        }
      }
    } finally {
      await proxy.close();
      await server.close();
    }
  });
});

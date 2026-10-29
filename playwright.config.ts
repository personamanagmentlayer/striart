import { defineConfig, devices } from '@playwright/test';

/**
 * Suite de bout en bout du dashboard — HORS `npm test` (`npm run test:e2e`).
 * Chaque spec lance son propre dashboard (process séparé, repo temporaire,
 * nom d'hôte d'instance réel `<id>.localhost`) : voir tests/e2e/support/.
 *
 * Captures de référence : propres à une plateforme (polices) → rangées sous
 * `__screenshots__/<plateforme>/`. Régénérer : `npm run test:e2e -- --update-snapshots`.
 */
export default defineConfig({
  testDir: 'tests/e2e',
  testMatch: '**/*.spec.ts',
  outputDir: 'test-results/e2e',
  snapshotPathTemplate: '{testDir}/__screenshots__/{platform}/{testFileName}/{arg}{ext}',
  retries: 0,
  // Chaque spec démarre un serveur (clones Git réels) : parallélisme borné.
  workers: 2,
  fullyParallel: false,
  timeout: 120_000,
  expect: {
    timeout: 10_000,
    toHaveScreenshot: { maxDiffPixelRatio: 0.01, animations: 'disabled', caret: 'hide' },
  },
  reporter: [['list'], ['html', { outputFolder: 'playwright-report', open: 'never' }]],
  use: {
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
    // *.localhost se résout en boucle locale dans Chromium sans réseau.
    locale: 'fr-FR',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});

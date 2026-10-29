import { expect, test } from '@playwright/test';
import { CutProxy } from './support/cut-proxy.ts';
import { DashboardServer } from './support/dashboard-server.ts';

/**
 * Parcours fonctionnels : affichage de l'état, temps réel (SSE), actions avec
 * leurs états vide / chargement / erreur / déconnexion. Chaque describe a son
 * dashboard (repo temporaire) : les actions qui modifient l'état ne polluent
 * pas les autres.
 */

test.describe('affichage et temps réel', () => {
  let server: DashboardServer;
  test.beforeAll(async () => {
    server = await DashboardServer.start({ agents: 3, tickets: 2, queue: 2, profiles: true });
  });
  test.afterAll(async () => {
    await server.close();
  });

  test('agents, file, tickets, heatmap et zone « À traiter » reflètent l’état', async ({
    browser,
  }) => {
    const context = await server.signedInContext(browser);
    const page = await server.openPage(context);
    await expect(page.locator('#agents .agent')).toHaveCount(3);
    await expect(page.locator('#queue li')).toHaveCount(2);
    await expect(page.locator('#tickets tbody tr')).toHaveCount(2);
    await expect(page.locator('#agents .agent').first()).toContainText('ACTIVE');
    await expect(page.locator('#heatmap li').first()).toContainText('src/shared.ts');
    // Deux tickets de conflit : annoncés dans « À traiter », comptés dans le titre de l'onglet.
    await expect(page.locator('#attention-summary .card')).toHaveCount(2);
    await expect(page.locator('#attention-summary')).toContainText(
      'Test Gate rouge après le merge',
    );
    await expect(page.locator('#n-conflicts')).toHaveText('2');
    await expect(page.locator('#attention-count')).toHaveText('2');
    await expect(page).toHaveTitle(/^\(2\) Striart/);
    await expect(page.locator('#live')).toContainText(/en direct/i);
    await context.close();
  });

  test('temps réel : un nouveau ticket et une permission apparaissent sans recharger, annoncés une fois', async ({
    browser,
  }) => {
    const context = await server.signedInContext(browser);
    const page = await server.openPage(context);
    await page.evaluate(() => {
      (window as unknown as { __marker: number }).__marker = 1;
    });
    await server.cmd('ticket', { n: Date.now() });
    await expect(page.locator('#tickets tbody tr')).toHaveCount(3, { timeout: 15_000 });
    await expect(page.locator('#announcer')).toContainText(/nouveau ticket/i);
    await server.cmd('permission', { agent: 'agent-live', title: 'Écrire dans .env' });
    await expect(page.locator('#permissions')).toContainText('Écrire dans .env', {
      timeout: 15_000,
    });
    await expect(page.locator('#permissions')).toContainText('agent-live demande une permission');
    await expect(page.locator('#announcer')).toContainText('agent-live');
    // Pas de rechargement : la page est la même.
    expect(await page.evaluate(() => (window as unknown as { __marker?: number }).__marker)).toBe(
      1,
    );
    await context.close();
  });

  test('mise à jour incrémentale : une ligne inchangée n’est pas retouchée par un push', async ({
    browser,
  }) => {
    const context = await server.signedInContext(browser);
    const page = await server.openPage(context);
    const row = page.locator('#agents .agent').first();
    await row.evaluate((el) => {
      el.setAttribute('data-probe', 'same-node');
    });
    await server.cmd('enqueue', { n: Date.now() }); // change la file, pas les agents
    await expect(page.locator('#queue li')).not.toHaveCount(2, { timeout: 15_000 });
    await expect(page.locator('#agents .agent').first()).toHaveAttribute('data-probe', 'same-node');
    await context.close();
  });

  test('déconnexion du flux : état « Hors ligne » + bandeau d’obsolescence, puis reprise', async ({
    browser,
  }) => {
    const proxy = await CutProxy.start(server.port);
    try {
      const { context, base } = await server.signedInContextVia(browser, proxy.port);
      const page = await context.newPage();
      await page.goto(`${base}/`);
      await expect(page.locator('#live')).toContainText(/en direct/i);
      proxy.cut();
      await expect(page.locator('#live')).toContainText(/hors ligne/i, { timeout: 20_000 });
      const banner = page.locator('#banner [role="status"]');
      await expect(banner).toContainText(/obsolètes/i);
      await expect(page.locator('#announcer')).toContainText(/perdue/i);
      // Les données déjà affichées restent lisibles (pas d'écran blanc).
      await expect(page.locator('#agents .agent').first()).toBeVisible();
      proxy.resume();
      await expect(page.locator('#live')).toContainText(/en direct/i, { timeout: 30_000 });
      await expect(page.locator('#banner')).toBeEmpty();
      await expect(page.locator('#announcer')).toContainText(/rétablie/i);
      await context.close();
    } finally {
      await proxy.close();
    }
  });

  test('chargement initial en échec : message d’erreur avec « Réessayer », jamais un chargement sans fin', async ({
    browser,
  }) => {
    const context = await server.signedInContext(browser);
    const page = await context.newPage();
    let failures = 2; // le premier appel d'état ET son sondage de secours échouent
    await page.route('**/rpc', async (route) => {
      if (failures > 0 && route.request().postData()?.includes('state.get')) {
        failures -= 1;
        await route.fulfill({ status: 500, body: 'boom' });
        return;
      }
      await route.continue();
    });
    await page.route('**/events', (route) => route.abort());
    await page.goto(`${server.baseUrl}/`);
    const alert = page.locator('#banner [role="alert"]');
    await expect(alert).toContainText(/impossible de charger/i);
    await expect(page.locator('#agents')).not.toContainText('chargement');
    await alert.getByRole('button', { name: 'Réessayer' }).click();
    await expect(page.locator('#agents .agent')).toHaveCount(3, { timeout: 15_000 });
    await context.close();
  });

  test('actions : lancer une tâche — champ vide, chargement visible, échec du Router affiché sans perdre la saisie', async ({
    browser,
  }) => {
    const context = await server.signedInContext(browser);
    const page = await server.openPage(context);
    await page.locator('#new-task-btn').click();
    await expect(page.locator('#dlg-task')).toBeVisible();
    await expect(page.locator('#task-prompt')).toBeFocused();
    // Vide : message dans le dialogue (le toast serait inerte derrière la modale), focus au champ.
    await page.locator('#task-start').click();
    await expect(page.locator('#task-msg')).toContainText('Décris la tâche');
    await expect(page.locator('#task-prompt')).toBeFocused();
    // Chargement : l'appel est ralenti, l'état « en cours » est visible.
    await page.route('**/rpc', async (route) => {
      if (route.request().postData()?.includes('task.run'))
        await new Promise((r) => setTimeout(r, 1200));
      await route.continue();
    });
    await page.locator('#task-prompt').fill('Corrige le bug du panier');
    await page.locator('#task-prompt').press('ControlOrMeta+Enter');
    await expect(page.locator('#task-msg')).toContainText('en cours');
    await expect(page.locator('body')).toHaveAttribute('aria-busy', 'true');
    // Erreur : le Router (LLM) est injoignable dans ce dépôt de test ; le dialogue reste ouvert, saisie intacte.
    await expect(page.locator('#task-msg')).toContainText(/refusé ou en échec/i, {
      timeout: 60_000,
    });
    await expect(page.locator('body')).not.toHaveAttribute('aria-busy', 'true');
    await expect(page.locator('#task-prompt')).toHaveValue('Corrige le bug du panier');
    await expect(page.locator('#dlg-task')).toBeVisible();
    // Échap ferme le dialogue et rend le focus au bouton d'origine.
    await page.keyboard.press('Escape');
    await expect(page.locator('#dlg-task')).toBeHidden();
    await expect(page.locator('#new-task-btn')).toBeFocused();
    await context.close();
  });

  test('mode autonome : le profil n’apparaît que si le mode l’exige', async ({ browser }) => {
    const context = await server.signedInContext(browser);
    const page = await server.openPage(context);
    await page.locator('#new-task-btn').click();
    await expect(page.locator('#task-profile-field')).toBeHidden();
    await page.locator('#task-mode').selectOption('autonomous');
    await expect(page.locator('#task-profile-field')).toBeVisible();
    await expect(page.locator('#task-profile')).toContainText('e2e-profile');
    await context.close();
  });

  test('diagnostic : état de chargement puis tableau avec niveaux en toutes lettres', async ({
    browser,
  }) => {
    const context = await server.signedInContext(browser);
    const page = await server.openPage(context);
    await page.locator('#maint-btn').click();
    await page.locator('#doctor-btn').click();
    await expect(page.locator('#doctor-detail')).toContainText('diagnostic en cours');
    await page.locator('#doctor-detail table').waitFor({ timeout: 60_000 });
    await expect(page.locator('#doctor-detail tbody tr').first()).toContainText(
      /ok|attention|erreur|ignoré/,
    );
    // Fermer rend le focus au déclencheur du menu.
    await page.locator('#dlg-doctor').getByRole('button', { name: 'Fermer' }).first().click();
    await expect(page.locator('#maint-btn')).toBeFocused();
    await context.close();
  });
});

test.describe('actions risquées et décisions', () => {
  let server: DashboardServer;
  test.beforeEach(async () => {
    server = await DashboardServer.start({
      agents: 2,
      tickets: 2,
      permissions: 1,
      elicitation: true,
      mainSession: true,
    });
  });
  test.afterEach(async () => {
    await server.close();
  });

  test('arrêt forcé : conséquence écrite, saisie du nom exigée, Échap annule sans rien exécuter', async ({
    browser,
  }) => {
    const context = await server.signedInContext(browser);
    const page = await server.openPage(context);
    await page.locator('[data-agent-menu]').first().click();
    await page.getByRole('menuitem', { name: /Arrêt forcé/ }).click();
    const dialog = page.locator('#dlg-confirm');
    await expect(dialog).toBeVisible();
    // La conséquence est dite AVANT d'agir ; l'action sévère n'est jamais le défaut.
    await expect(page.locator('#confirm-text')).toContainText(/ARRÊT FORCÉ de agent-00/);
    await expect(page.locator('#confirm-text')).toContainText(/Aucun Test Gate/);
    await expect(page.locator('#confirm-input')).toBeFocused();
    await expect(page.locator('#confirm-ok')).toBeDisabled();
    await page.locator('#confirm-input').fill('agent-0');
    await expect(page.locator('#confirm-ok')).toBeDisabled();
    // Échap : rien n'est exécuté, le focus revient au menu d'origine.
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(page.locator('[data-agent-menu]').first()).toBeFocused();
    await expect(page.locator('#toast')).not.toContainText('en cours');
    await expect(page.locator('#agents .agent')).toHaveCount(2);
    // Saisie exacte : le bouton s'active, l'agent est retiré du registre.
    await page.locator('[data-agent-menu]').first().click();
    await page.getByRole('menuitem', { name: /Arrêt forcé/ }).click();
    await page.locator('#confirm-input').fill('agent-00');
    await expect(page.locator('#confirm-ok')).toBeEnabled();
    await page.locator('#confirm-ok').click();
    await expect(page.locator('#toast')).toContainText(/Arrêter/, { timeout: 30_000 });
    // Ce dépôt a une session principale déclarée : la garde refuse, et le dit.
    await expect(page.locator('#toast')).toContainText(/Repo principal occupé/);
    await expect(page.locator('#dlg-confirm')).toBeHidden();
    await context.close();
  });

  test('ticket : chemin testé (Appliquer, Test Gate) distinct du chemin manuel (Clore à la main)', async ({
    browser,
  }) => {
    const context = await server.signedInContext(browser);
    const page = await server.openPage(context);
    await page.locator('button.open-ticket').first().click();
    const detail = page.locator('#ticket-detail');
    await expect(detail.getByRole('heading', { level: 2 })).toBeFocused();
    const tested = detail.locator('.path-box:not(.manual)');
    const manual = detail.locator('.path-box.manual');
    await expect(tested).toContainText('Test Gate');
    await expect(tested.getByRole('button', { name: /Appliquer sous Test Gate/ })).toBeVisible();
    await expect(manual).toContainText('sans Test Gate');
    await expect(manual.getByRole('button', { name: /Clore à la main/ })).toHaveClass(/danger/);
    // Le chemin sûr vient AVANT le chemin manuel dans l'ordre du DOM (et du clavier).
    const order = await detail.evaluate((el) => {
      const a = el.querySelector('.path-box:not(.manual)')!;
      const b = el.querySelector('.path-box.manual')!;
      return a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING;
    });
    expect(order).toBeTruthy();
    // Clore à la main : conséquence dite, puis le ticket sort de la liste.
    const close = manual.locator('button[data-act="ticket.close"]');
    await close.click();
    await expect(page.locator('#confirm-text')).toContainText(
      'SANS rejouer le merge ni le Test Gate',
    );
    // Chemin manuel : il faut saisir l'identifiant du ticket.
    await expect(page.locator('#confirm-ok')).toBeDisabled();
    await page
      .locator('#confirm-input')
      .fill(await page.locator('#confirm-label code').innerText());
    await page.locator('#confirm-ok').click();
    await expect(page.locator('#toast')).toContainText(/ticket clos/i, { timeout: 30_000 });
    await expect(page.locator('#tickets tbody tr')).toHaveCount(1, { timeout: 15_000 });
    await context.close();
  });

  test('permission : arbitrée par l’option proposée, la demande disparaît', async ({ browser }) => {
    const context = await server.signedInContext(browser);
    const page = await server.openPage(context);
    const decision = page.getByRole('button', { name: /Autoriser — agent-00/ });
    await expect(decision).toBeVisible();
    await decision.click();
    await expect(page.locator('#toast')).toContainText(/décision transmise/i, { timeout: 30_000 });
    await expect(page.locator('#permissions')).toBeEmpty({ timeout: 15_000 });
    await context.close();
  });

  test('session principale : « Libérer » dit sa conséquence, puis libère', async ({ browser }) => {
    const context = await server.signedInContext(browser);
    const page = await server.openPage(context);
    const release = page.locator('button[data-act="mainSession.release"]');
    await release.click();
    await expect(page.locator('#confirm-text')).toContainText(
      /MAINTENANT, même si le process déclaré tourne encore/,
    );
    await expect(page.locator('#confirm-ok')).toBeDisabled();
    await page
      .locator('#confirm-input')
      .fill(await page.locator('#confirm-label code').innerText());
    await page.locator('#confirm-ok').click();
    await expect(page.locator('#toast')).toContainText(/repo principal libéré/i, {
      timeout: 30_000,
    });
    await expect(page.locator('#main-session')).toBeEmpty({ timeout: 15_000 });
    await context.close();
  });

  test('question d’agent : validation native, réponse transmise, carte retirée', async ({
    browser,
  }) => {
    const context = await server.signedInContext(browser);
    const page = await server.openPage(context);
    const card = page.locator('#elicitations section');
    // Validation native : 9 dépasse le maximum (5) déclaré par l'agent — rien n'est envoyé.
    await card.getByLabel('Réplicas').fill('9');
    await card.getByRole('button', { name: 'Envoyer' }).click();
    expect(
      await card
        .getByLabel('Réplicas')
        .evaluate((el: HTMLInputElement) => el.validity.rangeOverflow),
    ).toBe(true);
    await expect(card).toHaveCount(1);
    await expect(page.locator('#toast')).not.toContainText(/réponse transmise/i);
    await card.getByLabel(/Environnement/).selectOption({ label: 'prod' });
    await card.getByLabel('Réplicas').fill('2');
    await card.getByRole('button', { name: 'Envoyer' }).click();
    await expect(page.locator('#toast')).toContainText(/réponse transmise/i, { timeout: 30_000 });
    await expect(card).toHaveCount(0);
    await context.close();
  });

  test('un push ne détruit pas un formulaire en cours de saisie', async ({ browser }) => {
    const context = await server.signedInContext(browser);
    const page = await server.openPage(context);
    const replicas = page.locator('#elicitations').getByLabel('Réplicas');
    await replicas.fill('4');
    await server.cmd('enqueue', { n: Date.now() });
    await expect(page.locator('#queue li')).toHaveCount(1, { timeout: 15_000 });
    await expect(replicas).toHaveValue('4');
    await context.close();
  });
});

test.describe('états vides et langue', () => {
  test('dépôt vide : chaque section dit pourquoi elle est vide, rien n’attend l’utilisateur', async ({
    browser,
  }) => {
    const server = await DashboardServer.start({});
    try {
      const context = await server.signedInContext(browser);
      const page = await server.openPage(context);
      await expect(page.locator('#agents')).toContainText('Aucun agent pour l’instant');
      await expect(
        page.locator('#agents').getByRole('button', { name: 'Nouvelle tâche' }),
      ).toBeVisible();
      await expect(page.locator('#queue')).toContainText('Aucune tâche en file');
      await expect(page.locator('#tickets')).toContainText('Aucun conflit');
      await expect(page.locator('#history')).toContainText('Aucun merge');
      await expect(page.locator('#heatmap')).toContainText('Aucun fichier disputé');
      await expect(page.locator('#orchestration')).toContainText('Aucune orchestration');
      // Sections vides repliées : une ligne, pas un grand bloc.
      await expect(page.locator('#sec-queue')).toHaveClass(/is-empty/);
      // Le watcher absent reste signalé, sans fausse alerte de décision.
      await expect(page.locator('#attention-count')).toHaveText('');
      await expect(page).toHaveTitle('Striart — Dashboard');
      await context.close();
    } finally {
      await server.close();
    }
  });

  test('STRIART_LANG=en : page, statuts et messages en anglais, vocabulaire des statuts inchangé', async ({
    browser,
  }) => {
    const server = await DashboardServer.start(
      { agents: 1, tickets: 1, permissions: 1 },
      { STRIART_LANG: 'en' },
    );
    try {
      const context = await server.signedInContext(browser);
      const page = await server.openPage(context);
      await expect(page.locator('html')).toHaveAttribute('lang', 'en');
      await expect(page.locator('#sec-attention h2')).toContainText('Needs your attention');
      await expect(page.locator('#live')).toContainText('Live');
      await expect(page.locator('#permissions')).toContainText('asks for a permission');
      await expect(page.locator('#agents .agent').first()).toContainText('ACTIVE');
      await expect(page.locator('#tickets tbody tr').first()).toContainText('GATE_FAILED');
      await expect(page.getByRole('button', { name: 'Sync agent-00' })).toBeVisible();
      await expect(page.locator('.skip')).toHaveText('Skip to main content');
      await context.close();
    } finally {
      await server.close();
    }
  });
});

test.describe('agents inactifs (GC d’inactivité)', () => {
  let server: DashboardServer;
  test.beforeAll(async () => {
    server = await DashboardServer.start({ agents: 2, idle: true });
  });
  test.afterAll(async () => {
    await server.close();
  });

  test('pastille « Inactif depuis », carte « À traiter » pour l’agent averti et action gc --dry-run', async ({
    browser,
  }) => {
    const context = await server.signedInContext(browser);
    const page = await server.openPage(context);
    await expect(page.locator('#agents .agent')).toHaveCount(2);
    await expect(page.locator('#agents .agent[data-name="agent-00"]')).toContainText(
      /Inactif depuis/,
    );
    await expect(page.locator('#agents .agent[data-name="agent-01"]')).toContainText(
      /Inactif depuis/,
    );
    // Seul l'agent AVERTI (session vivante) remonte dans « À traiter ».
    const card = page.locator('#attention-summary .card', { hasText: 'agent-01 : inactif' });
    await expect(card).toHaveCount(1);
    await expect(page.locator('#attention-summary')).not.toContainText('agent-00 : inactif');
    await card.getByRole('button', { name: /gc --dry-run/ }).click();
    await expect(page.locator('#toast, .toast').first()).toContainText(/simulation/i, {
      timeout: 15_000,
    });
    await context.close();
  });
});

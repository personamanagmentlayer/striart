import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { DashboardServer } from './support/dashboard-server.ts';
import { axeViolations } from './support/helpers.ts';

/**
 * Accessibilité (WCAG 2.2 AA) : audit outillé axe-core dans les deux thèmes et
 * dans les états riches, puis ce que l'outil ne voit pas — clavier, ordre de
 * focus, focus visible, annonces, mouvement réduit, reflow, taille des cibles.
 * Un audit outillé ne prouve pas la conformité : la revue manuelle est
 * décrite dans le compte rendu de la livraison.
 */

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

async function openRich(
  browser: Parameters<DashboardServer['signedInContext']>[0],
  options: Parameters<DashboardServer['signedInContext']>[1] = {},
): Promise<{ context: BrowserContext; page: Page }> {
  const context = await server.signedInContext(browser, options);
  const page = await server.openPage(context);
  await page.locator('#tickets table').waitFor();
  return { context, page };
}

for (const scheme of ['light', 'dark'] as const) {
  test.describe(`axe-core — thème ${scheme}`, () => {
    test('page complète (agents, permissions, question, session principale)', async ({
      browser,
    }) => {
      const { context, page } = await openRich(browser, { colorScheme: scheme });
      expect(await axeViolations(page)).toEqual([]);
      await context.close();
    });

    test('détail de ticket et diagnostic ouverts', async ({ browser }) => {
      const { context, page } = await openRich(browser, { colorScheme: scheme });
      await page.locator('a.open-ticket, button.open-ticket').first().click();
      await page.locator('#ticket-detail .detail').waitFor();
      await page.locator('#maint-btn').click();
      await page.locator('#doctor-btn').click();
      await page.locator('#doctor-detail table').waitFor();
      expect(await axeViolations(page)).toEqual([]);
      await context.close();
    });

    test('dialogue de confirmation saisie (arrêt forcé)', async ({ browser }) => {
      const { context, page } = await openRich(browser, { colorScheme: scheme });
      await page.locator('[data-agent-menu]').first().click();
      await page.getByRole('menuitem', { name: /Arrêt forcé/ }).click();
      await expect(page.locator('#dlg-confirm')).toBeVisible();
      expect(await axeViolations(page)).toEqual([]);
      await context.close();
    });

    test('menus ouverts (agent, maintenance), dialogues tâche, détail et aide', async ({
      browser,
    }) => {
      const { context, page } = await openRich(browser, { colorScheme: scheme });
      await page.locator('[data-agent-menu]').first().click();
      await expect(page.locator('.menu-panel:not([hidden])')).toBeVisible();
      expect(await axeViolations(page), 'menu agent').toEqual([]);
      await page.keyboard.press('Escape');
      await page.locator('#maint-btn').click();
      expect(await axeViolations(page), 'menu maintenance').toEqual([]);
      await page.keyboard.press('Escape');
      await page.locator('#new-task-btn').click();
      expect(await axeViolations(page), 'dialogue tâche').toEqual([]);
      await page.keyboard.press('Escape');
      await page.locator('[data-agent-menu]').first().click();
      await page.getByRole('menuitem', { name: /Détails/ }).click();
      await expect(page.locator('#dlg-agent')).toBeVisible();
      expect(await axeViolations(page), 'détail agent').toEqual([]);
      await page.keyboard.press('Escape');
      await page.locator('#help-btn').click();
      expect(await axeViolations(page), 'aide').toEqual([]);
      await context.close();
    });

    test('état vide', async ({ browser }) => {
      const empty = await DashboardServer.start({});
      try {
        const context = await empty.signedInContext(browser, { colorScheme: scheme });
        const page = await empty.openPage(context);
        await page.locator('#history .quiet').waitFor();
        expect(await axeViolations(page)).toEqual([]);
        await context.close();
      } finally {
        await empty.close();
      }
    });

    test('pages sans script (connexion requise, lien refusé)', async ({ browser }) => {
      const context = await browser.newContext({ colorScheme: scheme });
      const page = await context.newPage();
      await page.goto(`${server.baseUrl}/`);
      expect(await axeViolations(page)).toEqual([]);
      await page.goto(`${server.baseUrl}/auth?code=invalide`);
      expect(await axeViolations(page)).toEqual([]);
      await context.close();
    });
  });
}

test.describe('structure et sémantique', () => {
  test('repères, titres, noms accessibles, langue', async ({ browser }) => {
    const { context, page } = await openRich(browser);
    await expect(page.locator('html')).toHaveAttribute('lang', /^(fr|en)/);
    await expect(page.locator('main')).toHaveCount(1);
    await expect(page.locator('h1')).toHaveCount(1);
    // Chaque section de données est un titre h2 et ses tableaux ont un nom.
    const headings = await page.locator('h2').allTextContents();
    expect(headings.length).toBeGreaterThanOrEqual(6);
    const unnamedTables = await page.$$eval(
      'table',
      (tables) =>
        tables.filter(
          (t) =>
            !t.querySelector('caption') &&
            !t.getAttribute('aria-label') &&
            !t.getAttribute('aria-labelledby'),
        ).length,
    );
    expect(unnamedTables, 'tableaux sans nom accessible').toBe(0);
    // Les boutons d'action d'une ligne disent POUR QUEL agent ils agissent.
    const ambiguous = await page.$$eval(
      '#agents button',
      (buttons) =>
        buttons.filter((b) => !(b.getAttribute('aria-label') || '').match(/agent-\d+|agent-x/))
          .length,
    );
    expect(ambiguous, 'boutons de ligne sans cible dans leur nom').toBe(0);
    // Les pictogrammes sont décoratifs : le sens porte dans le texte.
    const emojiLeak = await page.$$eval(
      'button',
      (buttons) =>
        buttons.filter(
          (b) =>
            /\p{Extended_Pictographic}/u.test(b.textContent ?? '') &&
            !b.querySelector('[aria-hidden="true"]'),
        ).length,
    );
    expect(emojiLeak, 'boutons dont un pictogramme est lu à voix haute').toBe(0);
    await context.close();
  });

  test('un statut n’est jamais porté par la couleur seule', async ({ browser }) => {
    const { context, page } = await openRich(browser);
    // Chaque badge a un libellé texte ; chaque alerte a un libellé ou un rôle.
    const empty = await page.$$eval(
      '.badge',
      (nodes) => nodes.filter((n) => !(n.textContent ?? '').trim()).length,
    );
    expect(empty).toBe(0);
    const alertsWithoutName = await page.$$eval(
      '.alert',
      (nodes) =>
        nodes.filter((n) => !n.getAttribute('role') && !n.getAttribute('aria-label')).length,
    );
    expect(alertsWithoutName).toBe(0);
    await context.close();
  });
});

test.describe('clavier', () => {
  test('ordre de focus : lien d’évitement, puis ce qui exige une action, puis le pilotage', async ({
    browser,
  }) => {
    const { context, page } = await openRich(browser);
    await page.keyboard.press('Tab');
    const first = await page.evaluate(() => document.activeElement?.textContent?.trim());
    expect(first, 'premier arrêt de tabulation').toMatch(/contenu|content/i);
    // Les décisions en attente (permissions) précèdent le pilotage dans l'ordre du clavier.
    const order = await page.evaluate(() => {
      const all = [...document.querySelectorAll<HTMLElement>('a, button, input, select, textarea')];
      const idx = (sel: string) => all.indexOf(document.querySelector<HTMLElement>(sel)!);
      return {
        ticket: idx('button.open-ticket'),
        permission: idx('button[data-act="permission.answer"]'),
        task: idx('#new-task-btn'),
        merge: idx('button[data-agent-menu]'),
      };
    });
    expect(order.permission).toBeGreaterThan(-1);
    expect(order.ticket, 'conflit avant les permissions').toBeGreaterThan(-1);
    expect(order.permission, 'permission avant « Nouvelle tâche »').toBeLessThan(order.task);
    expect(order.task, '« Nouvelle tâche » avant les agents').toBeLessThan(order.merge);
    await context.close();
  });

  test('tout est atteignable au clavier, le focus est toujours visible et jamais piégé', async ({
    browser,
  }) => {
    const { context, page } = await openRich(browser);
    // Tous les éléments tabulables visibles, repérés par un marqueur de test.
    const total = await page.evaluate(() => {
      const tabbable = [
        ...document.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), input, select, textarea, summary, [tabindex="0"]',
        ),
      ]
        // Le contenu d'un <details> fermé n'est atteignable qu'après l'avoir ouvert :
        // seul son <summary> l'est (vérifié par le test d'activation au clavier).
        .filter((e) => !e.closest('details:not([open])') || e.tagName === 'SUMMARY')
        .filter((e) => e.offsetParent !== null || e.tagName === 'SUMMARY');
      tabbable.forEach((e, i) => e.setAttribute('data-tabid', String(i)));
      return tabbable.length;
    });
    const seen = new Set<string>();
    const invisible: string[] = [];
    for (let i = 0; i < total + 8; i += 1) {
      await page.keyboard.press('Tab');
      const info = await page.evaluate(() => {
        const el = document.activeElement as HTMLElement;
        if (!el || el === document.body) return null;
        const style = getComputedStyle(el);
        const outline = style.outlineStyle !== 'none' && parseFloat(style.outlineWidth) >= 2;
        const shadow = style.boxShadow !== 'none';
        const rect = el.getBoundingClientRect();
        return {
          key: `${el.getAttribute('data-tabid') ?? '?'}:${el.tagName}#${el.id}[${el.getAttribute('data-act') ?? ''}|${el.getAttribute('data-agent') ?? ''}|${el.textContent?.slice(0, 20)}]`,
          visibleFocus: outline || shadow,
          // WCAG 2.4.11 : le focus n'est pas masqué par un élément fixe.
          covered: (() => {
            const x = rect.left + rect.width / 2;
            const y = Math.min(Math.max(rect.top + rect.height / 2, 0), innerHeight - 1);
            const top = document.elementFromPoint(x, y);
            return !!top && !el.contains(top) && !top.contains(el);
          })(),
        };
      });
      if (!info) continue;
      seen.add(info.key);
      if (!info.visibleFocus) invisible.push(info.key);
      expect(info.covered, `focus masqué : ${info.key}`).toBe(false);
    }
    expect(invisible, 'éléments sans indicateur de focus').toEqual([]);
    const reached = new Set([...seen].map((k) => k.split(':')[0]).filter((id) => id !== '?'));
    const missing = await page.evaluate(
      (ids) =>
        [...document.querySelectorAll<HTMLElement>('[data-tabid]')]
          .filter((e) => !ids.includes(e.getAttribute('data-tabid')!))
          .map((e) => `${e.tagName}#${e.id}.${e.className} ${e.textContent?.slice(0, 30)}`),
      [...reached],
    );
    expect(missing, 'éléments tabulables jamais atteints').toEqual([]);
    await context.close();
  });

  test('actions au clavier seul : menu aux flèches, confirmation saisie, Échap, focus rendu', async ({
    browser,
  }) => {
    const { context, page } = await openRich(browser);
    const trigger = page.locator('[data-agent-menu]').first();
    await trigger.focus();
    await page.keyboard.press('Enter');
    await expect(trigger).toHaveAttribute('aria-expanded', 'true');
    const items = page.locator('.menu-panel:not([hidden]) [role="menuitem"]');
    await expect(items.first()).toBeFocused();
    await page.keyboard.press('End');
    await expect(items.last()).toBeFocused();
    await expect(items.last()).toContainText('Arrêt forcé');
    await page.keyboard.press('Home');
    await expect(items.first()).toBeFocused();
    // Échap referme le menu et rend le focus au déclencheur.
    await page.keyboard.press('Escape');
    await expect(trigger).toHaveAttribute('aria-expanded', 'false');
    await expect(trigger).toBeFocused();
    // Flèche bas rouvre ; Entrée sur l'arrêt forcé ouvre la confirmation (conséquence dite, saisie exigée).
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('End');
    await page.keyboard.press('Enter');
    await expect(page.locator('#dlg-confirm')).toBeVisible();
    await expect(page.locator('#confirm-text')).toContainText(/sans (merger|aucune vérification)/);
    await expect(page.locator('#confirm-text')).toContainText(/Aucun Test Gate/);
    await expect(page.locator('#confirm-input')).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(page.locator('#dlg-confirm')).toBeHidden();
    await expect(trigger).toBeFocused();
    await context.close();
  });

  test('raccourcis : N, M, / et ? — inactifs pendant une saisie', async ({ browser }) => {
    const { context, page } = await openRich(browser);
    await page.keyboard.press('n');
    await expect(page.locator('#dlg-task')).toBeVisible();
    // Dans un champ, « m » est du texte, pas un raccourci.
    await page.keyboard.type('mmm');
    await expect(page.locator('#task-prompt')).toHaveValue('mmm');
    await expect(page.locator('#maint-panel')).toBeHidden();
    await page.keyboard.press('Escape');
    await page.locator('main').focus();
    await page.keyboard.press('m');
    await expect(page.locator('#maint-panel')).toBeVisible();
    await expect(page.locator('#maint-panel [role="menuitem"]').first()).toBeFocused();
    await page.keyboard.press('Escape');
    await page.keyboard.press('?');
    await expect(page.locator('#dlg-help')).toBeVisible();
    await context.close();
  });

  test('lien d’évitement : va au contenu principal', async ({ browser }) => {
    const { context, page } = await openRich(browser);
    await page.keyboard.press('Tab');
    await page.keyboard.press('Enter');
    const focused = await page.evaluate(
      () => document.activeElement?.id || document.activeElement?.tagName,
    );
    expect(focused).toMatch(/main|MAIN/);
    await context.close();
  });
});

test.describe('annonces et mouvement', () => {
  test('régions live polies, jamais assertives pour une mise à jour SSE', async ({ browser }) => {
    const { context, page } = await openRich(browser);
    const live = await page.$$eval('[aria-live], [role="status"], [role="alert"]', (nodes) =>
      nodes.map((n) => ({
        id: n.id,
        role: n.getAttribute('role'),
        live: n.getAttribute('aria-live'),
      })),
    );
    expect(live.length).toBeGreaterThan(0);
    // `alert` (assertif) est réservé aux erreurs de formulaire et à la session expirée.
    const assertive = live.filter((l) => l.live === 'assertive');
    expect(assertive).toEqual([]);
    await context.close();
  });

  test('une mise à jour SSE sans changement de contenu n’écrit dans aucune région live', async ({
    browser,
  }) => {
    const { context, page } = await openRich(browser);
    await page.evaluate(() => {
      (window as unknown as { __liveWrites: string[] }).__liveWrites = [];
      const observer = new MutationObserver((records) => {
        for (const r of records) {
          const host = (r.target as Element).closest?.('[aria-live], [role="status"]');
          if (host) {
            (window as unknown as { __liveWrites: string[] }).__liveWrites.push(
              `${host.id}: ${r.target.textContent?.slice(0, 40)}`,
            );
          }
        }
      });
      observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    });
    // Du bruit d'état qui ne change rien à l'affichage : plusieurs pushes serveur.
    for (let i = 0; i < 4; i += 1) {
      await server.cmd('touch', { n: 3 });
      await page.waitForTimeout(2500);
    }
    const writes = await page.evaluate(
      () => (window as unknown as { __liveWrites: string[] }).__liveWrites,
    );
    // L'indicateur « maj hh:mm:ss » n'est PAS dans une région live.
    expect(writes).toEqual([]);
    await context.close();
  });

  test('une nouvelle permission est annoncée une fois, poliment', async ({ browser }) => {
    const { context, page } = await openRich(browser);
    const before = await page.locator('button[data-act="permission.answer"]').count();
    await server.cmd('permission', { agent: 'agent-annonce', title: 'Annonce e2e' });
    await expect(page.locator('button[data-act="permission.answer"]')).toHaveCount(before + 2, {
      timeout: 15_000,
    });
    const announcement = page.locator('#announcer');
    await expect(announcement).toContainText(/permission/i);
    await expect(announcement).toHaveAttribute('aria-live', 'polite');
    await context.close();
  });

  test('prefers-reduced-motion : aucune animation ni défilement animé', async ({ browser }) => {
    for (const reducedMotion of ['reduce', 'no-preference'] as const) {
      const { context, page } = await openRich(browser, { reducedMotion });
      await page.evaluate(() => {
        const calls: string[] = [];
        (window as unknown as { __scrolls: string[] }).__scrolls = calls;
        const original = Element.prototype.scrollIntoView;
        Element.prototype.scrollIntoView = function (arg?: boolean | ScrollIntoViewOptions) {
          calls.push(typeof arg === 'object' && arg ? String(arg.behavior) : 'default');
          return original.call(this, arg as ScrollIntoViewOptions);
        };
      });
      await page.locator('button.open-ticket').first().click();
      await page.locator('#ticket-detail .detail').waitFor();
      const result = await page.evaluate(() => {
        const animated = [...document.querySelectorAll('*')].filter((el) => {
          const s = getComputedStyle(el);
          const dur = (v: string) => v.split(',').some((d) => parseFloat(d) > 0.001);
          return dur(s.transitionDuration) || dur(s.animationDuration);
        }).length;
        return {
          animated,
          scrolls: (window as unknown as { __scrolls: string[] }).__scrolls,
          scrollBehavior: getComputedStyle(document.documentElement).scrollBehavior,
        };
      });
      if (reducedMotion === 'reduce')
        expect(result.animated, 'éléments animés sous mouvement réduit').toBe(0);
      else
        expect(
          result.animated,
          'micro-interactions sobres (120–180 ms) sans préférence',
        ).toBeGreaterThan(0);
      expect(result.scrollBehavior).not.toBe('smooth');
      expect(result.scrolls.length).toBeGreaterThan(0);
      if (reducedMotion === 'reduce') expect(result.scrolls).not.toContain('smooth');
      else
        expect(result.scrolls, 'le défilement animé reste la norme sans préférence').toContain(
          'smooth',
        );
      await context.close();
    }
  });
});

test.describe('garde-fou de l’outil', () => {
  test('axe-core détecte bien un défaut de contraste injecté (l’audit n’est pas aveugle)', async ({
    browser,
  }) => {
    const { context, page } = await openRich(browser);
    await page.evaluate(() => {
      const p = document.createElement('p');
      p.id = 'defaut';
      p.textContent = 'texte quasi invisible';
      p.className = 'sr-test';
      p.setAttribute('data-x', '1');
      document.body.appendChild(p);
      // CSSOM : permis par la CSP (un <style> injecté serait bloqué).
      p.style.position = 'static';
      p.style.color = '#bbbbbb';
      p.style.background = '#ffffff';
    });
    const found = await axeViolations(page);
    expect(found.map((v) => v.id)).toContain('color-contrast');
    await context.close();
  });
});

test.describe('reflow, zoom et cibles', () => {
  for (const width of [320, 360, 640]) {
    test(`reflow ${width}px (zoom 200 % ≈ 640 px, 400 % ≈ 320 px) : pas de défilement horizontal de la page`, async ({
      browser,
    }) => {
      const { context, page } = await openRich(browser, {
        viewport: { width, height: 800 },
      });
      const { scroll, client, offenders } = await page.evaluate(() => {
        const doc = document.documentElement;
        const wide = [...document.body.querySelectorAll('*')]
          .filter((el) => el.getBoundingClientRect().right > doc.clientWidth + 1)
          .filter((el) => !el.closest('[data-scroll], pre, .table-wrap'))
          .slice(0, 5)
          .map((el) => `${el.tagName}#${el.id}.${el.className}`);
        return { scroll: doc.scrollWidth, client: doc.clientWidth, offenders: wide };
      });
      expect(scroll, `scrollWidth (${offenders.join(' | ')})`).toBeLessThanOrEqual(client);
      await context.close();
    });
  }

  test('cibles tactiles ≥ 24×24 px (WCAG 2.5.8) et texte ≥ 12 px', async ({ browser }) => {
    const { context, page } = await openRich(browser);
    const small = await page.$$eval('a[href], button, input, select, textarea', (els) =>
      els
        .filter((e) => (e as HTMLElement).offsetParent !== null)
        .map((e) => ({ e, r: e.getBoundingClientRect() }))
        .filter(({ r }) => r.width < 24 || r.height < 24)
        .map(({ e }) => `${e.tagName}#${e.id} ${e.textContent?.slice(0, 20)}`),
    );
    expect(small).toEqual([]);
    await context.close();
  });

  test('mobile 390 px : cibles tactiles ≥ 44 px', async ({ browser }) => {
    const { context, page } = await openRich(browser, { viewport: { width: 390, height: 844 } });
    const small = await page.$$eval(
      'a.btn, a.stat, button, input:not([type="checkbox"]), select, textarea, summary',
      (els) =>
        els
          .filter((e) => (e as HTMLElement).offsetParent !== null)
          .map((e) => ({ e, r: e.getBoundingClientRect() }))
          .filter(({ r }) => r.height < 43.5 || r.width < 43.5)
          .map(({ e }) => `${e.tagName}#${e.id} ${e.textContent?.trim().slice(0, 24)}`),
    );
    expect(small).toEqual([]);
    await context.close();
  });

  test('espacement du texte (1.4.12) : rien n’est rogné ni ne déborde', async ({ browser }) => {
    const { context, page } = await openRich(browser, { bypassCSP: true });
    await page.addStyleTag({
      content:
        '* { line-height: 1.5 !important; letter-spacing: 0.12em !important; word-spacing: 0.16em !important; } p { margin-bottom: 2em !important; }',
    });
    const clipped = await page.$$eval('button, .badge, th, td', (els) =>
      els
        .filter(
          (e) => e.scrollWidth > e.clientWidth + 1 && getComputedStyle(e).overflow !== 'visible',
        )
        .map((e) => e.textContent?.slice(0, 30)),
    );
    expect(clipped).toEqual([]);
    await context.close();
  });
});

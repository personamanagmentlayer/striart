import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, test, type CDPSession, type Page } from '@playwright/test';
import { DashboardServer } from './support/dashboard-server.ts';

/**
 * Performance du client : premier rendu, interactivité, poids, coût du flux
 * SSE sous charge (50 agents, 1 000 écritures d'état par minute), fuites sur
 * une durée longue (nœuds DOM, écouteurs, tas JS) et CPU du client.
 *
 * Les chiffres sont écrits dans test-results/e2e/perf-<nom>.json (comparaison
 * avant/après) ; les budgets ci-dessous sont des garde-fous, pas des cibles.
 */

const SOAK_MS = Number(process.env.E2E_SOAK_MS ?? 300_000);
const OUT_DIR = path.resolve('test-results', 'e2e');

async function record(name: string, data: unknown): Promise<void> {
  await mkdir(OUT_DIR, { recursive: true });
  await writeFile(path.join(OUT_DIR, `perf-${name}.json`), JSON.stringify(data, null, 2));
  console.log(`[perf:${name}] ${JSON.stringify(data)}`);
}

async function metrics(cdp: CDPSession): Promise<Record<string, number>> {
  const { metrics: list } = await cdp.send('Performance.getMetrics');
  return Object.fromEntries(list.map((m) => [m.name, m.value]));
}

async function gc(cdp: CDPSession): Promise<void> {
  await cdp.send('HeapProfiler.enable');
  await cdp.send('HeapProfiler.collectGarbage');
}

/** Installe, avant tout script de la page, la collecte des tâches longues. */
async function instrument(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const w = window as unknown as Record<string, unknown>;
    w.__longTasks = [] as number[];
    w.__renders = 0;
    try {
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) (w.__longTasks as number[]).push(entry.duration);
      }).observe({ type: 'longtask', buffered: true });
    } catch {
      // longtask indisponible : le total reste à zéro, ce qui est dit dans le rapport.
    }
    // Compte les rendus : chaque trame `state.changed` livrée au client en provoque un.
    const proto = EventSource.prototype;
    const original = proto.addEventListener;
    proto.addEventListener = function (type: string, listener: unknown, options?: unknown) {
      if (type === 'state.changed' && typeof listener === 'function') {
        const wrapped = (event: Event) => {
          w.__renders = (w.__renders as number) + 1;
          return (listener as (e: Event) => unknown)(event);
        };
        return original.call(this, type, wrapped as EventListener, options as boolean);
      }
      return original.call(this, type, listener as EventListener, options as boolean);
    } as typeof proto.addEventListener;
  });
}

test.describe('performance — page nominale', () => {
  let server: DashboardServer;
  test.beforeAll(async () => {
    server = await DashboardServer.start({ agents: 3, tickets: 3, queue: 3 });
  });
  test.afterAll(async () => {
    await server.close();
  });

  test('premier rendu, interactivité et poids', async ({ browser }) => {
    const context = await server.signedInContext(browser);
    const page = await context.newPage();
    await instrument(page);
    const sizes: Record<string, number> = {};
    page.on('response', async (response) => {
      const body = await response.body().catch(() => null);
      if (body) sizes[new URL(response.url()).pathname] = body.length;
    });
    await page.goto(`${server.baseUrl}/`);
    await page.locator('#agents .agent').first().waitFor();
    await page.waitForTimeout(1500);
    const result = await page.evaluate(() => {
      const nav = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming;
      const paints = Object.fromEntries(
        performance.getEntriesByType('paint').map((p) => [p.name, p.startTime]),
      );
      const longTasks = (window as unknown as { __longTasks: number[] }).__longTasks;
      return {
        domContentLoadedMs: nav.domContentLoadedEventEnd,
        loadMs: nav.loadEventEnd,
        responseEndMs: nav.responseEnd,
        firstPaintMs: paints['first-paint'] ?? null,
        firstContentfulPaintMs: paints['first-contentful-paint'] ?? null,
        longTasks: longTasks.length,
        totalBlockingMs: longTasks.reduce((n, d) => n + Math.max(0, d - 50), 0),
        domNodes: document.getElementsByTagName('*').length,
      };
    });
    // Interactivité : un clic sur « Doctor » doit produire sa réponse sans attente notable.
    const t0 = Date.now();
    await page.locator('#maint-btn').click();
    await page.locator('#doctor-btn').click();
    await page.locator('#doctor-detail table').waitFor();
    const doctorMs = Date.now() - t0;
    // Saisie : latence de frappe dans le champ de prompt (jamais bloquée par un rendu).
    const typing = await page.evaluate(async () => {
      const input = document.getElementById('task-prompt') as HTMLTextAreaElement;
      input.focus();
      const start = performance.now();
      for (const ch of 'corrige le bug du panier') {
        input.value += ch;
        input.dispatchEvent(new Event('input', { bubbles: true }));
      }
      await new Promise((r) => requestAnimationFrame(() => r(null)));
      return performance.now() - start;
    });
    const data = { ...result, htmlBytes: sizes['/'], doctorMs, typingMs: typing };
    await record('nominal', data);
    expect(sizes['/'], 'poids HTML (octets)').toBeLessThan(140_000);
    expect(result.firstContentfulPaintMs ?? 0, 'FCP').toBeLessThan(2000);
    expect(result.totalBlockingMs, 'blocage total').toBeLessThan(300);
    expect(typing, 'frappe').toBeLessThan(100);
    await context.close();
  });
});

test.describe('performance — charge SSE (50 agents, 1 000 évts/min)', () => {
  test.skip(process.env.E2E_SKIP_SLOW === '1', 'E2E_SKIP_SLOW=1');
  let server: DashboardServer;
  test.beforeAll(async () => {
    server = await DashboardServer.start({ agents: 50, tickets: 5, queue: 5 });
  });
  test.afterAll(async () => {
    await server.close();
  });

  test('coût du flux et de la page sous charge', async ({ browser }) => {
    test.setTimeout(240_000);
    const context = await server.signedInContext(browser);
    const page = await context.newPage();
    await instrument(page);
    const cdp = await context.newCDPSession(page);
    await cdp.send('Performance.enable');
    await page.goto(`${server.baseUrl}/`);
    await page.locator('#agents .agent').nth(49).waitFor();
    const firstRenderMs = await page.evaluate(() => performance.now());
    await gc(cdp);
    const before = await metrics(cdp);
    const rendersBefore = await page.evaluate(
      () => (window as unknown as { __renders: number }).__renders,
    );

    // 1 000 écritures d'état en 60 s (≈ 16,7 par seconde), dont des changements
    // visibles (file) : le serveur coalesce, le client ne doit rendre que l'utile.
    const DURATION_MS = 60_000;
    const start = Date.now();
    let writes = 0;
    let churnN = 0;
    while (Date.now() - start < DURATION_MS) {
      const tick = Date.now();
      await server.cmd('touch', { n: 16 });
      writes += 16;
      if (writes % 160 === 0) await server.cmd('churn', { n: ++churnN });
      const wait = 1000 - (Date.now() - tick);
      if (wait > 0) await page.waitForTimeout(wait);
    }
    const elapsedS = (Date.now() - start) / 1000;
    await page.waitForTimeout(3000);
    await gc(cdp);
    const after = await metrics(cdp);
    const renders =
      (await page.evaluate(() => (window as unknown as { __renders: number }).__renders)) -
      rendersBefore;
    const cpuS = after.TaskDuration - before.TaskDuration;
    const scriptS = after.ScriptDuration - before.ScriptDuration;
    const data = {
      agents: 50,
      writes,
      elapsedS,
      firstRenderMs,
      renders,
      rendersPerMin: (renders / elapsedS) * 60,
      cpuPercent: (cpuS / elapsedS) * 100,
      scriptPercent: (scriptS / elapsedS) * 100,
      layoutsPerMin: ((after.LayoutCount - before.LayoutCount) / elapsedS) * 60,
      styleRecalcsPerMin: ((after.RecalcStyleCount - before.RecalcStyleCount) / elapsedS) * 60,
      nodesBefore: before.Nodes,
      nodesAfter: after.Nodes,
      listenersBefore: before.JSEventListeners,
      listenersAfter: after.JSEventListeners,
      heapMBBefore: before.JSHeapUsedSize / 1e6,
      heapMBAfter: after.JSHeapUsedSize / 1e6,
    };
    await record('sse-load', data);
    expect(data.cpuPercent, 'CPU du client sous charge').toBeLessThan(15);
    expect(data.renders, 'au moins un rendu pendant la charge').toBeGreaterThan(0);
    expect(data.rendersPerMin, 'rendus/min (le serveur coalesce à ≤ 30/min)').toBeLessThan(40);
    await context.close();
  });
});

test.describe('performance — fuites (soak)', () => {
  test.skip(process.env.E2E_SKIP_SLOW === '1', 'E2E_SKIP_SLOW=1');
  let server: DashboardServer;
  test.beforeAll(async () => {
    server = await DashboardServer.start({ agents: 20, tickets: 3, queue: 3 });
  });
  test.afterAll(async () => {
    await server.close();
  });

  test(`pas de fuite de nœuds, d'écouteurs ni de tas sur ${SOAK_MS / 1000} s`, async ({
    browser,
  }) => {
    test.setTimeout(SOAK_MS + 180_000);
    const context = await server.signedInContext(browser);
    const page = await context.newPage();
    const cdp = await context.newCDPSession(page);
    await cdp.send('Performance.enable');
    await page.goto(`${server.baseUrl}/`);
    await page.locator('#agents .agent').first().waitFor();

    const samples: Array<Record<string, number>> = [];
    const sample = async (label: number) => {
      await gc(cdp);
      const m = await metrics(cdp);
      samples.push({
        tS: label,
        nodes: m.Nodes,
        listeners: m.JSEventListeners,
        heapMB: m.JSHeapUsedSize / 1e6,
        documents: m.Documents,
      });
    };
    await page.waitForTimeout(2000);
    await sample(0);
    const start = Date.now();
    let n = 0;
    let nextSample = 30_000;
    while (Date.now() - start < SOAK_MS) {
      n += 1;
      await server.cmd('churn', { n });
      // Une action utilisateur répétée : ouvrir un ticket, armer puis laisser expirer.
      if (n % 3 === 0) {
        await page.locator('button.open-ticket').first().click();
        await page.locator('#ticket-detail .detail').waitFor();
      }
      await page.waitForTimeout(1500);
      if (Date.now() - start >= nextSample) {
        await sample(Math.round((Date.now() - start) / 1000));
        nextSample += 30_000;
      }
    }
    await sample(Math.round((Date.now() - start) / 1000));
    await record('soak', { churns: n, samples });
    const first = samples[1] ?? samples[0];
    const last = samples[samples.length - 1];
    // Garde-fous : croissance bornée (pas de monotonie illimitée).
    expect(last.nodes, 'nœuds DOM').toBeLessThan(first.nodes * 1.15 + 50);
    expect(last.listeners, 'écouteurs').toBeLessThan(first.listeners * 1.15 + 50);
    expect(last.heapMB, 'tas JS (Mo)').toBeLessThan(first.heapMB * 1.5 + 5);
    await context.close();
  });
});

import { request as httpRequest } from 'node:http';
import { AxeBuilder } from '@axe-core/playwright';
import type { Page } from '@playwright/test';

/** Règles WCAG 2.2 AA (axe-core) : niveaux A et AA des versions 2.0, 2.1 et 2.2. */
export const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

export async function axeViolations(page: Page, include?: string) {
  let builder = new AxeBuilder({ page }).withTags(WCAG_TAGS);
  if (include) builder = builder.include(include);
  const { violations } = await builder.analyze();
  return violations.map((v) => ({
    id: v.id,
    impact: v.impact,
    help: v.help,
    nodes: v.nodes.slice(0, 5).map((n) => ({ target: n.target, summary: n.failureSummary })),
  }));
}

/**
 * Masque ce qui change à chaque exécution (heure, PID, identifiants, chemins
 * temporaires, tailles) pour que les captures soient comparables.
 */
export async function stabilize(page: Page): Promise<void> {
  await page.evaluate(() => {
    const re = [
      [/\b\d{1,2}:\d{2}:\d{2}\b/g, '12:00:00'],
      [/\d{2}\/\d{2}\/\d{4},? \d{2}:\d{2}:\d{2}/g, '01/01/2026 12:00:00'],
      [/\bpid \d+/gi, 'pid 4242'],
      [/PID \d+/g, 'PID 4242'],
      [/task-[0-9a-f]{8}\b/g, 'task-00000000'],
      [/(agent-\d+)-[0-9a-f]{8,}/g, '$1-00000000'],
      [/\d+([.,]\d)?[\s  ](ko|Mo|Go|o|kB|MB|GB|B|byte)\b/g, '32,0 ko'],
      [/striart-test-\w+/g, 'striart-test-XXXXXX'],
      [/\b(AM|PM)\b/g, 'PM'],
      [/task-[0-9a-f]{6,}/g, 'task-000000'],
    ] as Array<[RegExp, string]>;
    // Durées relatives (« il y a 4 min ») : instables d'une exécution à l'autre.
    const now = document.documentElement.lang === 'en' ? 'now' : 'maintenant';
    for (const el of document.querySelectorAll('time[data-rel]')) el.textContent = now;
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let node: Node | null;
    while ((node = walker.nextNode())) {
      let text = node.nodeValue ?? '';
      for (const [pattern, replacement] of re) text = text.replace(pattern, replacement);
      node.nodeValue = text;
    }
  });
}

/** Requête HTTP brute sur la boucle locale : permet de forger `Host` (un navigateur ne le peut pas). */
export function rawRequest(
  port: number,
  routePath: string,
  headers: Record<string, string>,
  method = 'GET',
): Promise<{
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: '127.0.0.1', port, path: routePath, method, headers },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          body += chunk;
        });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

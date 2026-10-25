import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { PAGE } from '../../src/dashboard.js';
import { METHOD_SPECS } from '../../src/control/schema.ts';

/**
 * Le JS client du dashboard vit dans une template string : ESLint ne le lit
 * pas, tsc non plus, et les tests d'intégration n'exécutent que le serveur.
 * Ces tests ferment le trou — sur la page TELLE QUE SERVIE.
 */
describe('dashboard — cohérence du client embarqué', () => {
  const script = PAGE.match(/<script>([\s\S]*?)<\/script>/)?.[1];

  it('la page embarque un script', () => {
    expect(script).toBeTruthy();
  });

  it('le script compile — aucune erreur de syntaxe', () => {
    expect(() => new Function(script)).not.toThrow();
  });

  it('tout id consommé par getElementById existe dans le HTML', () => {
    const used = [...script.matchAll(/getElementById\('([^']+)'\)/g)].map((m) => m[1]);
    expect(used.length).toBeGreaterThan(0);
    const missing = [...new Set(used)].filter((id) => !PAGE.includes(`id="${id}"`));
    expect(missing).toEqual([]);
  });

  it('toute action cliente (data-act, runAction, rpc) est une méthode du protocole servie en HTTP', () => {
    const served = METHOD_SPECS.filter((s) => s.transports.includes('http')).map((s) => s.name);
    const client = new Set([
      ...[...PAGE.matchAll(/data-act="([A-Za-z.-]+)"/g)].map((m) => m[1]),
      ...[...script.matchAll(/(?:rpc|runAction)\('([A-Za-z.-]+)'/g)].map((m) => m[1]),
    ]);
    expect(client.size).toBeGreaterThan(10);
    for (const method of client)
      expect(served, `méthode cliente "${method}" inconnue du protocole`).toContain(method);
  });

  it('le client ne parle plus aux routes historiques /api/* (rupture assumée)', () => {
    expect(script).not.toMatch(/['"]\/api\//);
    expect(script).toContain("fetch('/rpc'");
    expect(script).toContain("new EventSource('/events')");
  });

  it('aucun style ni gestionnaire en ligne : la CSP stricte (empreintes) suffit à la page', () => {
    expect(PAGE).not.toMatch(/\sstyle="/);
    expect(PAGE).not.toMatch(/\son[a-z]+="/);
    expect(script).not.toMatch(/style="/);
    // Une seule balise <script> et une seule <style> : celles dont l'empreinte est publiée.
    expect(PAGE.match(/<script/g)).toHaveLength(1);
    expect(PAGE.match(/<style/g)).toHaveLength(1);
    const digest = createHash('sha256').update(script).digest('base64');
    expect(digest).toMatch(/^[A-Za-z0-9+/]+=*$/);
  });
});

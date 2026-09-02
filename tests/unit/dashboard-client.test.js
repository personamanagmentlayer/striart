import { describe, expect, it } from 'vitest';
import { PAGE } from '../../src/dashboard.js';

/**
 * Le JS client du dashboard vit dans une template string : ESLint ne le lit
 * pas, tsc non plus, et les tests d'intégration n'exécutent que le serveur.
 * Ces tests ferment le trou — sur la page TELLE QUE SERVIE (échappements de
 * template déjà résolus), pas sur la source.
 */
describe('dashboard — cohérence du client embarqué', () => {
  const script = PAGE.match(/<script>\r?\n([\s\S]*?)<\/script>/)?.[1];

  it('la page embarque un script', () => {
    expect(script).toBeTruthy();
  });

  it('le script compile — aucune erreur de syntaxe', () => {
    // new Function compile sans exécuter : une erreur de syntaxe throw ici.
    expect(() => new Function(script)).not.toThrow();
  });

  it('tout id consommé par getElementById existe dans le HTML', () => {
    const used = [...script.matchAll(/getElementById\('([^']+)'\)/g)].map((m) => m[1]);
    expect(used.length).toBeGreaterThan(0);
    const missing = [...new Set(used)].filter((id) => !PAGE.includes(`id="${id}"`));
    // Un id manquant = TypeError silencieuse au premier rendu dans le
    // navigateur, invisible pour toute la CI côté Node.
    expect(missing).toEqual([]);
  });

  it('toute action cliente data-act correspond à une action serveur', async () => {
    const { default: fs } = await import('node:fs/promises');
    const src = await fs.readFile(new URL('../../src/dashboard.js', import.meta.url), 'utf8');
    const serverActions = [...src.matchAll(/^ {2}'?([a-z-]+)'?: \(root/gm)].map((m) => m[1]);
    const clientActions = [
      ...new Set([...PAGE.matchAll(/data-act="([a-z-]+)"/g)].map((m) => m[1])),
    ];
    expect(clientActions.length).toBeGreaterThan(0);
    // Un bouton dont l'action n'existe pas côté serveur = 404 au clic.
    for (const action of clientActions) {
      expect(serverActions, `action cliente "${action}" sans handler serveur`).toContain(action);
    }
  });
});

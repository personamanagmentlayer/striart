import { describe, expect, it } from 'vitest';
import { DASHBOARD_MESSAGES, en, fr } from '../../src/dashboard-messages.ts';
import { renderPage } from '../../src/dashboard-page.ts';
import { clientScript, compact } from '../../src/dashboard-client.ts';
import { STYLE } from '../../src/dashboard-style.ts';

/**
 * Le dashboard est rendu en deux langues par un squelette serveur et un client
 * embarqué : ces tests tiennent les deux catalogues alignés et la structure
 * d'accessibilité de la page (le détail visuel et le comportement sont couverts
 * par la suite de bout en bout `npm run test:e2e`).
 */
describe('dashboard — catalogues fr / en', () => {
  it('mêmes clés dans les deux langues, aucune valeur vide', () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(fr).sort());
    for (const lang of ['fr', 'en']) {
      for (const [key, value] of Object.entries(DASHBOARD_MESSAGES[lang]))
        expect(String(value).length, `${lang}:${key}`).toBeGreaterThan(0);
    }
  });

  it('mêmes paramètres {x} et même balisage ‹code› dans les deux langues', () => {
    const params = (s) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
    const code = (s) => (s.match(/‹/g) ?? []).length + ':' + (s.match(/›/g) ?? []).length;
    for (const key of Object.keys(fr)) {
      expect(params(en[key]), `paramètres de ${key}`).toEqual(params(fr[key]));
      expect(code(en[key]), `‹›  de ${key}`).toBe(code(fr[key]));
      const [open, close] = code(fr[key]).split(':');
      expect(open, `‹› équilibrés dans ${key}`).toBe(close);
    }
  });

  it('chaque pluriel a ses deux formes dans les deux langues', () => {
    for (const lang of ['fr', 'en']) {
      const keys = Object.keys(DASHBOARD_MESSAGES[lang]);
      for (const key of keys.filter((k) => k.endsWith('.one')))
        expect(keys, `${lang}:${key}`).toContain(key.replace(/\.one$/, '.other'));
    }
  });

  it('les noms de statuts (types.d.ts) ne sont jamais traduits', () => {
    for (const status of ['ACTIVE', 'WAITING', 'BROKEN', 'MISSING', 'GATE_FAILED'])
      expect(clientScript('fr')).not.toContain(`"${status}":`);
  });
});

describe('dashboard — structure de la page', () => {
  const pages = { fr: renderPage('fr'), en: renderPage('en') };

  for (const [lang, html] of Object.entries(pages)) {
    it(`${lang} : langue déclarée, lien d’évitement, repères et région live polie`, () => {
      expect(html).toContain(`<html lang="${lang}">`);
      expect(html).toMatch(/<a class="skip" href="#main">/);
      expect(html.match(/<main\b/g)).toHaveLength(1);
      expect(html.match(/<h1\b/g)).toHaveLength(1);
      expect(html).toMatch(/id="announcer"[^>]*aria-live="polite"/);
      expect(html).not.toMatch(/aria-live="assertive"/);
      expect(html).toContain('name="color-scheme" content="light dark"');
      // Chaque champ du formulaire a une étiquette visible.
      for (const id of ['task-prompt', 'task-agent', 'task-mode', 'agent-search'])
        expect(html).toMatch(new RegExp(`(<label for="${id}">|id="${id}"[^>]*aria-label=)`));
    });
  }

  it('l’ordre du DOM met ce qui exige une décision avant le pilotage et les données', () => {
    const html = pages.fr;
    const at = (id) => html.indexOf(`id="${id}"`);
    expect(at('n-agents')).toBeLessThan(at('main-session'));
    expect(at('main-session')).toBeLessThan(at('attention-summary'));
    expect(at('attention-summary')).toBeLessThan(at('permissions'));
    expect(at('permissions')).toBeLessThan(at('elicitations'));
    expect(at('elicitations')).toBeLessThan(at('new-task-btn'));
    expect(at('new-task-btn')).toBeLessThan(at('agents'));
    expect(at('agents')).toBeLessThan(at('tickets'));
  });

  it('les deux langues ont les mêmes identifiants (le client est unique)', () => {
    const ids = (html) => [...html.matchAll(/ id="([^"]+)"/g)].map((m) => m[1]).sort();
    expect(ids(pages.en)).toEqual(ids(pages.fr));
  });

  it('thème clair et sombre, mouvement réduit et reflow dans la feuille de style', () => {
    expect(STYLE).toContain('@media (prefers-color-scheme: dark)');
    expect(STYLE).toContain('@media (prefers-reduced-motion: reduce)');
    expect(STYLE).toMatch(/@media \(max-width: 760px\)/);
    expect(STYLE).toContain(':focus-visible');
    // Aucune ressource externe, aucun import.
    expect(STYLE).not.toMatch(/@import|url\(|https?:\/\//);
  });

  it('le client n’emploie aucune API d’évaluation de code ni d’écriture de document', () => {
    for (const forbidden of [
      'eval(',
      'document.write',
      'new Function',
      'insertAdjacentHTML',
      'outerHTML',
    ])
      expect(clientScript('fr'), forbidden).not.toContain(forbidden);
    expect(clientScript('fr')).not.toContain('</script');
  });
});

describe('dashboard — script embarqué (une langue, compacté)', () => {
  it('chaque langue embarque SON catalogue seulement, donc une empreinte CSP propre', () => {
    const fr = clientScript('fr');
    const en = clientScript('en');
    expect(fr).toContain('Aller au contenu principal');
    expect(fr).not.toContain('Skip to main content');
    expect(en).toContain('Skip to main content');
    expect(en).not.toContain('Aller au contenu principal');
    expect(fr).not.toBe(en);
    // Le `<` des catalogues est échappé en JSON : jamais de balise dans le catalogue embarqué.
    expect(fr.slice(0, fr.indexOf('(MSG)'))).not.toContain('</');
    // Les deux sont des programmes valides.
    expect(() => new Function(fr)).not.toThrow();
    expect(() => new Function(en)).not.toThrow();
  });

  it('compact : retire les commentaires seuls et l’indentation, garde le contenu des gabarits multilignes', () => {
    const source = [
      'function f() {',
      '  // commentaire seul',
      '  /** bloc',
      '   * suite */',
      '  const url = "https://exemple.invalid"; // fin de ligne conservée',
      '  const t = `a',
      '     b`;',
      '  return t;',
      '}',
    ].join('\n');
    const out = compact(source);
    expect(out).not.toContain('commentaire seul');
    expect(out).not.toContain('bloc');
    expect(out).toContain('https://exemple.invalid');
    expect(out).toContain('`a\n     b`;'); // l'espace d'un gabarit multiligne est intact
    const run = new Function(out + '; return f();');
    expect(run()).toBe('a\n     b');
  });

  it('le script compacté reste sous un budget de poids (non compressé)', () => {
    expect(clientScript('fr').length).toBeLessThan(95_000);
    expect(renderPage('fr').length).toBeLessThan(140_000);
  });
});

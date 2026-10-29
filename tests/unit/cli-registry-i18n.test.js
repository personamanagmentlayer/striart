import { describe, expect, it } from 'vitest';
import { publicCommands } from '../../src/cli/registry.ts';
import { en } from '../../src/cli/i18n/en.ts';
import { fr } from '../../src/cli/i18n/fr.ts';
import { computeSuggestions } from '../../src/watch-ui.ts';

/**
 * Cohérence registre ↔ catalogues i18n : chaque commande publique du registre unique a son texte
 * (`summary`, `examples`) en fr ET en. Le cockpit `watch --ui` (striartCommands) et l'aide les
 * lisent par nom ; une commande ajoutée au registre sans texte plantait le cockpit (`gc`).
 */
describe.each([
  ['fr', fr],
  ['en', en],
])('registre des commandes publiques ↔ catalogue %s', (_lang, m) => {
  it.each(publicCommands().map((c) => c.name))('%s a son entrée de catalogue', (name) => {
    const entry = m.commands[name];
    expect(entry, `m.commands.${name} manquant`).toBeTruthy();
    expect(typeof entry.summary).toBe('string');
    expect(entry.summary.trim()).not.toBe('');
    expect(Array.isArray(entry.examples)).toBe(true);
  });

  it("le catalogue ne garde pas d'entrée orpheline (commande absente du registre)", () => {
    const known = new Set(publicCommands().map((c) => c.name));
    const hidden = new Set(['__complete']);
    const orphans = Object.keys(m.commands).filter((k) => !known.has(k) && !hidden.has(k));
    expect(orphans).toEqual([]);
  });
});

describe('cockpit watch --ui : suggestions "/" robustes', () => {
  it('une commande sans entrée de catalogue donne un repli (son nom), jamais un crash', () => {
    const missing = { ...fr, commands: { ...fr.commands } };
    delete missing.commands.gc;
    const suggestions = computeSuggestions('/gc', [], missing);
    expect(suggestions).toEqual([{ kind: 'command', value: 'gc', description: 'gc' }]);
  });
});

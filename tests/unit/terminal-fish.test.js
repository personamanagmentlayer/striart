import { describe, expect, it } from 'vitest';
import { fishCommandLine, quoteFish, quoteForShell, quotePosix } from '../../src/terminal/quote.ts';
import { warpPaneCommand } from '../../src/terminal/warp.ts';

/**
 * S-M12 : dans les guillemets simples de fish, `\\` et `\'` sont des
 * échappements (pas en POSIX). `quotePosix` déformait une valeur contenant
 * `\` suivi d'une apostrophe.
 */
describe('citation fish (S-M12)', () => {
  // Interprète un littéral entre guillemets simples selon la grammaire de fish.
  const unquoteFish = (quoted) => {
    expect(quoted.startsWith("'") && quoted.endsWith("'")).toBe(true);
    let out = '';
    const body = quoted.slice(1, -1);
    for (let i = 0; i < body.length; i += 1) {
      if (body[i] === '\\' && (body[i + 1] === '\\' || body[i + 1] === "'")) {
        out += body[i + 1];
        i += 1;
      } else {
        expect(body[i], 'apostrophe nue dans un littéral fish').not.toBe("'");
        out += body[i];
      }
    }
    return out;
  };

  it.each([
    String.raw`C:\Users\o'brien\x`,
    String.raw`a\'b`,
    String.raw`fin\\`,
    "it's",
    'simple',
    '\\',
  ])('aller-retour fidèle pour %s', (value) => {
    expect(unquoteFish(quoteFish(value))).toBe(value);
  });

  it('quotePosix déformait ce cas (preuve du défaut corrigé)', () => {
    const value = String.raw`a\'b`;
    // En POSIX la barre oblique inverse est littérale ; lue par fish, `\'` ouvre un échappement.
    expect(quotePosix(value)).not.toBe(quoteFish(value));
  });

  it('quoteForShell et warpPaneCommand choisissent la grammaire fish', () => {
    expect(quoteForShell(String.raw`a\b`, { shell: 'fish' })).toBe(quoteFish(String.raw`a\b`));
    expect(warpPaneCommand(['striart', String.raw`a\'b`], 'fish', 'linux')).toBe(
      fishCommandLine(['striart', String.raw`a\'b`]),
    );
    expect(warpPaneCommand(['striart', 'x'], 'bash', 'linux')).toBe("'striart' 'x'");
  });
});

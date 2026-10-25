import { describe, expect, it } from 'vitest';
import { compactMemoryDiff, integrateMemoryEntry } from '../../src/memory.js';

const DIFF = [
  'diff --git a/src/auth.js b/src/auth.js',
  'index 111..222 100644',
  '--- a/src/auth.js',
  '+++ b/src/auth.js',
  '@@ -1,3 +1,4 @@',
  ' contexte inutile',
  '-export function login(a) {}',
  '+export function login(a, b) {}',
  'diff --git a/package-lock.json b/package-lock.json',
  '--- a/package-lock.json',
  '+++ b/package-lock.json',
  '@@ -1 +1 @@',
  '-"x"',
  '+"y"',
  'diff --git a/tests/auth.test.js b/tests/auth.test.js',
  '+++ b/tests/auth.test.js',
  '+it("x")',
  'diff --git a/logo.png b/logo.png',
  'Binary files a/logo.png and b/logo.png differ',
].join('\n');

describe('compactMemoryDiff', () => {
  it('garde en-têtes, hunks et lignes +/- ; retire contexte, lockfiles, tests, binaires', () => {
    const out = compactMemoryDiff(DIFF, 10_000);
    expect(out.truncated).toBe(false);
    expect(out.text).toContain('+export function login(a, b) {}');
    expect(out.text).toContain('-export function login(a) {}');
    expect(out.text).toContain('diff --git a/src/auth.js b/src/auth.js');
    expect(out.text).not.toContain('contexte inutile');
    expect(out.text).not.toContain('package-lock');
    expect(out.text).not.toContain('auth.test.js');
    expect(out.text).not.toContain('logo.png');
  });

  it('coupe à une frontière de ligne ET le déclare', () => {
    const big = `diff --git a/a.js b/a.js\n${Array.from({ length: 500 }, (_, i) => `+ligne ${i}`).join('\n')}`;
    const out = compactMemoryDiff(big, 400);
    expect(out.truncated).toBe(true);
    expect(out.omittedLines).toBeGreaterThan(0);
    expect(out.text).toMatch(/\[… \d+ lignes omises/);
    expect(out.text.length).toBeLessThan(600);
  });

  it('seulement lockfiles/tests : texte vide (l’appelant ne fait aucun appel)', () => {
    const out = compactMemoryDiff('diff --git a/yarn.lock b/yarn.lock\n+x', 1000);
    expect(out.text).toBe('');
  });

  it('texte qui n’est pas un diff git : transmis tel quel, seulement borné', () => {
    expect(compactMemoryDiff('export function foo() {}', 1000).text).toBe(
      'export function foo() {}',
    );
  });
});

describe('integrateMemoryEntry : remplacer, pas empiler', () => {
  const entry = (title, ...bullets) => `## ${title}\n\n${bullets.join('\n')}\n`;
  const LIMITS = { maxEntries: 30, maxTotalChars: 10_000, dedupe: true };

  it('une puce sur le même symbole remplace l’ancienne', () => {
    const old = entry('t1', '- `login(a)` ajoutée', '- `logout()` ajoutée');
    const fresh = entry('t2', '- `login(a, b)` : nouvelle signature');
    const out = integrateMemoryEntry([old], fresh, LIMITS);
    expect(out).toHaveLength(2);
    expect(out[0]).toBe(fresh);
    expect(out[1]).toContain('logout');
    expect(out[1]).not.toContain('login(a)');
  });

  it('une entrée dont toutes les puces sont remplacées disparaît', () => {
    const old = entry('t1', '- `login(a)` ajoutée');
    const out = integrateMemoryEntry([old], entry('t2', '- `login(a, b)`'), LIMITS);
    expect(out).toHaveLength(1);
  });

  it('dedupe: false → comportement d’empilement', () => {
    const old = entry('t1', '- `login(a)`');
    const out = integrateMemoryEntry([old], entry('t2', '- `login(a, b)`'), {
      ...LIMITS,
      dedupe: false,
    });
    expect(out).toHaveLength(2);
  });

  it('borné en nombre d’entrées et en taille (la plus récente est toujours gardée)', () => {
    const olds = Array.from({ length: 10 }, (_, i) =>
      entry(`o${i}`, `- \`f${i}()\` ${'x'.repeat(100)}`),
    );
    const fresh = entry('new', '- `g()`');
    expect(integrateMemoryEntry(olds, fresh, { ...LIMITS, maxEntries: 3 })).toHaveLength(3);
    const bounded = integrateMemoryEntry(olds, fresh, { ...LIMITS, maxTotalChars: 300 });
    expect(bounded[0]).toBe(fresh);
    expect(bounded.join('').length).toBeLessThanOrEqual(400);
    expect(bounded.length).toBeLessThan(11);
  });
});

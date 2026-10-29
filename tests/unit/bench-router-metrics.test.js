import { describe, expect, it } from 'vitest';
import { bootstrap, evaluate, rng } from '../../scripts/bench-router-metrics.ts';
import { DEFAULT_SHARED_PATTERNS, compileSharedMatcher } from '../../src/router-shared.ts';

const isShared = compileSharedMatcher(DEFAULT_SHARED_PATTERNS);
const task = (sha, truth, predicted, extra = {}) => ({
  sha,
  truth,
  predicted,
  error: null,
  ms: 100,
  tokensIn: 1000,
  tokensOut: 100,
  calls: 1,
  ...extra,
});

describe('métriques du banc du Router', () => {
  const outcomes = [
    // A : 2 fichiers de code + CHANGELOG ; prédit 1 bon + 1 faux.
    task('A', ['src/a.js', 'src/b.js', 'CHANGELOG.md'], ['src/a.js', 'src/x.js']),
    // B : partage src/a.js avec A ; prédit exactement.
    task('B', ['src/a.js'], ['src/a.js']),
    // C : ne partage que le CHANGELOG avec A ; prédit un fichier indépendant.
    task('C', ['src/c.js', 'CHANGELOG.md'], ['src/c.js']),
  ];

  it('précision et rappel, avec et sans tenue de livre', () => {
    const m = evaluate(outcomes, isShared);
    // Total : 3 vrais positifs (a, a, c) sur 4 prédits ; vérité 3 + 1 + 2 = 6.
    expect(m.precisionAll).toBeCloseTo(3 / 4);
    expect(m.recallAll).toBeCloseTo(3 / 6);
    // Code : vérité 2 + 1 + 1 = 4, 3 trouvés ; prédits (hors tenue de livre) = 4.
    expect(m.recallCode).toBeCloseTo(3 / 4);
    expect(m.precisionCode).toBeCloseTo(3 / 4);
    // Couverture complète du code : B et C oui, A non.
    expect(m.fullyCoveredCode).toBeCloseTo(2 / 3);
  });

  it('paires : chevauchement réel sur le code, alertes inutiles, vue stricte', () => {
    const { pairs } = evaluate(outcomes, isShared);
    // A-B partagent src/a.js (code) et sont vus ; A-C partagent seulement le CHANGELOG ;
    // B-C n'ont rien en commun.
    expect(pairs.realCode).toBe(1);
    expect(pairs.detectedCode).toBe(1);
    expect(pairs.noCodeOverlap).toBe(2);
    expect(pairs.needlessAlarms).toBe(0); // aucune collision prédite hors A-B
    expect(pairs.realAll).toBe(2); // A-B + A-C (CHANGELOG)
    expect(pairs.detectedAll).toBe(1);
    expect(pairs.noOverlapAll).toBe(1);
  });

  it('une tâche sérialisée (**) est couverte et collisionne avec tout, comptée à part', () => {
    const m = evaluate([...outcomes, task('D', ['src/z.js'], ['**'])], isShared);
    expect(m.serialized).toBe(1);
    expect(m.pairs.needlessAlarms).toBe(3); // D collisionne avec A, B et C sans chevauchement de code
    expect(m.fullyCoveredCode).toBeCloseTo(3 / 4);
  });

  it('une erreur est comptée, exclue des moyennes et des paires', () => {
    const m = evaluate(
      [...outcomes, task('E', ['src/e.js'], null, { error: 'ROUTER_FAILED' })],
      isShared,
    );
    expect(m.errors).toBe(1);
    expect(m.pairs.realCode + m.pairs.noCodeOverlap).toBe(3);
  });

  it('le bootstrap est déterministe, encadre la valeur ponctuelle et élargit l’intervalle sur un petit échantillon', () => {
    // Une tâche sur trois manque son second fichier : le rappel varie d'un tirage à l'autre.
    const many = Array.from({ length: 30 }, (_, i) =>
      task(
        `t${i}`,
        [`src/f${i % 7}.js`, `src/g${i % 5}.js`],
        i % 3 === 0 ? [`src/f${i % 7}.js`] : [`src/f${i % 7}.js`, `src/g${i % 5}.js`],
      ),
    );
    const a = bootstrap(many, isShared, { iterations: 400 });
    const b = bootstrap(many, isShared, { iterations: 400 });
    expect(a).toEqual(b);
    for (const key of ['precisionCode', 'recallCode', 'detectionCode']) {
      expect(a[key].lo).toBeLessThanOrEqual(a[key].value + 1e-9);
      expect(a[key].hi).toBeGreaterThanOrEqual(a[key].value - 1e-9);
    }
    const small = bootstrap(many.slice(0, 5), isShared, { iterations: 400 });
    expect(small.recallCode.hi - small.recallCode.lo).toBeGreaterThan(
      a.recallCode.hi - a.recallCode.lo,
    );
  });

  it('le générateur pseudo-aléatoire est reproductible', () => {
    const r1 = rng(42);
    const r2 = rng(42);
    expect([r1(), r1(), r1()]).toEqual([r2(), r2(), r2()]);
  });
});

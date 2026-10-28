/**
 * Filet à l'exécution (chevauchement OBSERVÉ) : logique pure, bornes, politiques
 * partagées avec le Router. Aucun git ici (tests/integration/overlap-watch.test.js).
 */
import { describe, expect, it } from 'vitest';
import {
  computeOverlaps,
  describeOverlap,
  isValidOverlapSettings,
  overlapRelaxations,
  resolveOverlapSettings,
  sanitizeTouched,
} from '../../src/overlap.ts';
import { compileSharedMatcher, DEFAULT_SHARED_PATTERNS } from '../../src/router-shared.ts';

const shared = compileSharedMatcher(DEFAULT_SHARED_PATTERNS);
const agent = (name, touched, predicted = [], mainAdvance = []) => ({
  agent: name,
  touched,
  predicted,
  mainAdvance,
});

describe('sanitizeTouched — mêmes politiques que le Router', () => {
  it('écarte les chemins non sûrs (absolu, .., contrôles) et les compte', () => {
    const r = sanitizeTouched(
      ['src/a.js', '../evil', '/etc/passwd', 'C:\\x', 'a\nb.js'],
      null,
      100,
    );
    expect(r.files).toEqual(['src/a.js']);
    expect(r.skippedUnsafe).toBe(4);
  });

  it('ignore la tenue de livre selon sharedFiles et la compte', () => {
    const r = sanitizeTouched(
      ['CHANGELOG.md', 'docs/fr/x.md', 'package.json', 'src/a.js'],
      shared,
      100,
    );
    expect(r.files).toEqual(['src/a.js']);
    expect(r.ignoredShared).toBe(3);
  });

  it("sharedFiles: 'keep' (matcher null) : rien d'ignoré", () => {
    expect(sanitizeTouched(['CHANGELOG.md'], null, 100).files).toEqual(['CHANGELOG.md']);
  });

  it('normalise les séparateurs, dédoublonne, trie et borne en le DÉCLARANT', () => {
    const r = sanitizeTouched(['src\\b.js', 'src/b.js', 'src/a.js', 'src/c.js'], null, 2);
    expect(r.files).toEqual(['src/a.js', 'src/b.js']);
    expect(r.truncated).toBe(true);
  });
});

describe('computeOverlaps', () => {
  it('deux agents ont touché le même fichier NON prédit → signal agents', () => {
    const out = computeOverlaps([agent('a', ['src/x.js']), agent('b', ['src/x.js', 'src/y.js'])]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      kind: 'agents',
      agents: ['a', 'b'],
      files: ['src/x.js'],
      fileCount: 1,
    });
  });

  it('fichier prédit par les DEUX : chevauchement déjà connu du Router, pas de signal', () => {
    const out = computeOverlaps([
      agent('a', ['src/x.js'], ['src/x.js']),
      agent('b', ['src/x.js'], ['src/x.js']),
    ]);
    expect(out).toEqual([]);
  });

  it("prédit par un seul des deux : c'est un angle mort du Router, signal", () => {
    const out = computeOverlaps([
      agent('a', ['src/x.js'], ['src/x.js']),
      agent('b', ['src/x.js'], []),
    ]);
    expect(out).toHaveLength(1);
  });

  it('la sentinelle ** vaut prédiction de tout le dépôt', () => {
    expect(
      computeOverlaps([agent('a', ['src/x.js'], ['**']), agent('b', ['src/x.js'], ['**'])]),
    ).toEqual([]);
  });

  it('agent ↔ cible : fichier touché par l’agent ET avancé par la cible', () => {
    const out = computeOverlaps([
      agent('a', ['src/x.js', 'src/z.js'], [], ['src/x.js', 'src/w.js']),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ kind: 'target', agents: ['a'], files: ['src/x.js'] });
  });

  it('aucune intersection : aucun bruit', () => {
    expect(
      computeOverlaps([agent('a', ['src/a.js'], [], ['src/m.js']), agent('b', ['src/b.js'])]),
    ).toEqual([]);
    expect(computeOverlaps([])).toEqual([]);
  });

  it('borne les fichiers listés mais garde le total', () => {
    const files = Array.from({ length: 80 }, (_, i) => `src/f${String(i).padStart(2, '0')}.js`);
    const [o] = computeOverlaps([agent('a', files), agent('b', files)], 10);
    expect(o.files).toHaveLength(10);
    expect(o.fileCount).toBe(80);
    expect(o.filesTruncated).toBe(true);
  });

  it('trois agents : une paire par chevauchement, ordre et clés déterministes', () => {
    const run = () =>
      computeOverlaps([agent('c', ['x.js']), agent('a', ['x.js', 'y.js']), agent('b', ['y.js'])]);
    const out = run();
    expect(out.map((o) => o.agents.join('+'))).toEqual(['a+b', 'a+c']);
    expect(run().map((o) => o.key)).toEqual(out.map((o) => o.key));
    expect(new Set(out.map((o) => o.key)).size).toBe(2);
  });

  it("la clé change quand l'ensemble de fichiers change (re-signalement)", () => {
    const k1 = computeOverlaps([agent('a', ['x.js']), agent('b', ['x.js'])])[0].key;
    const k2 = computeOverlaps([agent('a', ['x.js', 'y.js']), agent('b', ['x.js', 'y.js'])])[0].key;
    expect(k1).not.toBe(k2);
  });
});

describe('describeOverlap — texte humain', () => {
  it('caviarde un secret dans un nom de fichier et borne la liste à 5', () => {
    const files = [
      'src/a.js',
      'src/b.js',
      'src/c.js',
      'src/d.js',
      'src/e.js',
      'src/f.js',
      'conf/sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789.txt',
    ];
    const [o] = computeOverlaps([agent('a', files), agent('b', files)]);
    const text = describeOverlap(o, 'main');
    expect(text).not.toContain('abcdefghijklmnopqrstuvwxyz0123456789');
    expect(text).toMatch(/\(\+2\)/);
  });
});

describe('réglages overlap', () => {
  it('défauts sûrs : actif, rattrapage actif, coût borné', () => {
    expect(resolveOverlapSettings({})).toMatchObject({
      enabled: true,
      autoSync: true,
      maxGitCalls: 64,
    });
  });

  it('validation : clé inconnue et bornes refusées', () => {
    expect(isValidOverlapSettings({})).toBe(true);
    expect(isValidOverlapSettings({ enabled: false, maxGitCalls: 10 })).toBe(true);
    expect(isValidOverlapSettings({ enabeld: false })).toBe(false);
    expect(isValidOverlapSettings({ maxGitCalls: 1 })).toBe(false);
    expect(isValidOverlapSettings({ maxGitCalls: 100_000 })).toBe(false);
    expect(isValidOverlapSettings([])).toBe(false);
    expect(isValidOverlapSettings({ autoSync: 'yes' })).toBe(false);
  });

  it("couper l'observation est un relâchement affiché ; le défaut n'en est pas un", () => {
    expect(overlapRelaxations({})).toEqual([]);
    expect(overlapRelaxations({ overlap: { autoSync: false } })).toEqual([]);
    expect(overlapRelaxations({ overlap: { enabled: false } }).map((r) => r.key)).toEqual([
      'overlap.enabled',
    ]);
  });
});

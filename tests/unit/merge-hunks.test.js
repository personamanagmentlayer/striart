import { describe, expect, it } from 'vitest';
import {
  assemble,
  conflictRegions,
  diff3Merge,
  hasFinalNewline,
  myersMatches,
  splitLines,
} from '../../src/merge-hunks.ts';

const L = (s) => s.split('\n');

describe('myersMatches', () => {
  it('paires croissantes de lignes réellement égales', () => {
    const a = L('a\nb\nc\nd\ne');
    const b = L('a\nx\nc\ne\nf');
    const m = myersMatches(a, b);
    expect(m).toEqual([
      [0, 0],
      [2, 2],
      [4, 3],
    ]);
    for (const [i, j] of m) expect(a[i]).toBe(b[j]);
  });

  it('propriété : toujours une sous-séquence commune valide (fuzz déterministe)', () => {
    let seed = 7;
    const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    for (let t = 0; t < 200; t += 1) {
      const a = Array.from({ length: Math.floor(rnd() * 25) }, () => String(Math.floor(rnd() * 5)));
      const b = Array.from({ length: Math.floor(rnd() * 25) }, () => String(Math.floor(rnd() * 5)));
      const m = myersMatches(a, b);
      let pi = -1;
      let pj = -1;
      for (const [i, j] of m) {
        expect(i).toBeGreaterThan(pi);
        expect(j).toBeGreaterThan(pj);
        expect(a[i]).toBe(b[j]);
        pi = i;
        pj = j;
      }
    }
  });
});

describe('diff3Merge', () => {
  const base = L('a\nb\nc\nd\ne\nf\ng');

  it('changements disjoints des deux côtés : fusionnés sans conflit', () => {
    const ours = L('a\nB\nc\nd\ne\nf\ng');
    const theirs = L('a\nb\nc\nd\ne\nF\ng');
    const seg = diff3Merge(base, ours, theirs);
    expect(seg).toEqual([{ kind: 'stable', lines: L('a\nB\nc\nd\ne\nF\ng') }]);
  });

  it('même modification des deux côtés : stable', () => {
    const both = L('a\nB\nc\nd\ne\nf\ng');
    expect(diff3Merge(base, both, both)).toEqual([{ kind: 'stable', lines: both }]);
  });

  it('modifications différentes de la même ligne : un conflit, le reste stable', () => {
    const seg = diff3Merge(base, L('a\nB1\nc\nd\ne\nf\ng\nh'), L('a\nB2\nc\nd\ne\nF\ng'));
    expect(seg.filter((s) => s.kind === 'conflict')).toEqual([
      { kind: 'conflict', index: 1, base: ['b'], ours: ['B1'], theirs: ['B2'] },
    ]);
    expect(seg[0]).toEqual({ kind: 'stable', lines: ['a'] });
    expect(seg[2]).toEqual({ kind: 'stable', lines: L('c\nd\ne\nF\ng\nh') });
  });

  it('modifications ADJACENTES (qui se touchent) : conflit, comme git', () => {
    const seg = diff3Merge(base, L('a\nB\nc\nd\ne\nf\ng'), L('a\nb\nC\nd\ne\nf\ng'));
    const conflicts = seg.filter((s) => s.kind === 'conflict');
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].base).toEqual(['b', 'c']);
  });

  it('ajout d’un côté, suppression de l’autre sur la même zone : conflit', () => {
    const seg = diff3Merge(base, L('a\nc\nd\ne\nf\ng'), L('a\nb\nX\nc\nd\ne\nf\ng'));
    expect(seg.some((s) => s.kind === 'conflict')).toBe(true);
  });

  it('aucun changement : tout stable', () => {
    expect(diff3Merge(base, base, base)).toEqual([{ kind: 'stable', lines: base }]);
  });
});

describe('régions et réassemblage', () => {
  it('contexte de part et d’autre depuis le texte déjà fusionné', () => {
    const base = L('1\n2\n3\n4\n5\n6\n7\n8');
    const ours = L('1\n2\n3\nO\n5\n6\n7\n8');
    const theirs = L('1\n2\n3\nT\n5\n6\n7\n8');
    const seg = diff3Merge(base, ours, theirs);
    const [region] = conflictRegions(seg, 2);
    expect(region.before).toEqual(['2', '3']);
    expect(region.after).toEqual(['5', '6']);
    const text = assemble(seg, new Map([[1, ['M']]]), true);
    expect(text).toBe('1\n2\n3\nM\n5\n6\n7\n8\n');
  });

  it('assemble refuse une région sans résolution', () => {
    const seg = diff3Merge(L('a'), L('b'), L('c'));
    expect(() => assemble(seg, new Map(), false)).toThrow(/sans résolution/);
  });

  it('splitLines / hasFinalNewline conservent la fin de ligne finale', () => {
    expect(splitLines('a\nb\n')).toEqual(['a', 'b']);
    expect(hasFinalNewline('a\nb\n')).toBe(true);
    expect(hasFinalNewline('a\nb')).toBe(false);
    expect(splitLines('')).toEqual([]);
  });
});

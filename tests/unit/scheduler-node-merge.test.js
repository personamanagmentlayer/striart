/**
 * Un nœud `task` autonome MERGED doit porter son merge (K-I2) : le cycle rend
 * MERGED aussi quand le commit de l'agent était déjà dans la cible
 * (`merge.status === 'UP_TO_DATE'`), et le nœud rendait alors `merge: null` —
 * un statut MERGED sans commit à citer.
 */
import { describe, expect, it } from 'vitest';
import { nodeMergeOf } from '../../src/orchestration/scheduler.ts';

describe('nodeMergeOf — merge porté par un nœud task autonome', () => {
  it('MERGED : sha de l’agent et commit de merge', () => {
    expect(nodeMergeOf({ status: 'MERGED', sha: 'aaa', mergeSha: 'bbb' })).toEqual({
      sha: 'aaa',
      mergeSha: 'bbb',
    });
  });

  it('UP_TO_DATE alreadyMerged : le commit de la cible qui porte le travail, drapeau alreadyMerged', () => {
    expect(
      nodeMergeOf({ status: 'UP_TO_DATE', alreadyMerged: true, sha: 'aaa', mergeSha: 'ccc' }),
    ).toEqual({ sha: 'aaa', mergeSha: 'ccc', alreadyMerged: true });
  });

  it('UP_TO_DATE sans mergeSha connu : repli sur le sha de l’agent (le travail EST dans la cible)', () => {
    expect(nodeMergeOf({ status: 'UP_TO_DATE', alreadyMerged: true, sha: 'aaa' })).toEqual({
      sha: 'aaa',
      mergeSha: 'aaa',
      alreadyMerged: true,
    });
  });

  it('aucun merge, ou merge bloqué : null', () => {
    expect(nodeMergeOf(null)).toBeNull();
    expect(nodeMergeOf({ status: 'GATE_FAILED', sha: 'aaa' })).toBeNull();
    expect(nodeMergeOf({ status: 'CONFLICT', sha: 'aaa' })).toBeNull();
    // UP_TO_DATE « rien de neuf » (pas alreadyMerged) n'est pas un merge porté.
    expect(nodeMergeOf({ status: 'UP_TO_DATE', sha: 'aaa' })).toBeNull();
  });
});

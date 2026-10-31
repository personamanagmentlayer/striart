/**
 * Preuve d'un nœud de plan v2 (lot O, priorité 2 du Run Manager) : ce qui a
 * été produit et vérifié, construit depuis des données déjà mesurées par le
 * noyau (merge, Test Gate, verdicts, registre d'usage) — jamais recalculé.
 *
 * Deux étages :
 *  - `partialEvidenceFromMerge` : pure, synchrone, extrait commit/gate/
 *    sémantique/fichiers résolus d'un `MergeResult` complet (disponible aux
 *    deux seuls points qui mergent réellement — `finalizeClone` et
 *    `runAutonomousNode` — AVANT que `nodeMergeOf` le réduise à
 *    `{sha, mergeSha, alreadyMerged}` pour `OrchestrationNodeResult.merge`) ;
 *  - `buildEvidence` : assemble ce partiel avec la consigne du nœud, les
 *    verdicts déjà collectés et l'usage connu de l'agent (src/tokens/ledger.ts).
 */
import { currentTotals } from '../tokens/ledger.ts';
import type { EvidenceBundle, MergeResult, ReviewVerdictRecord } from '../types.js';

export type PartialEvidence = Pick<
  EvidenceBundle,
  'commit' | 'gate' | 'semantic' | 'resolvedFiles'
>;

const emptyPartial = (): PartialEvidence => ({
  commit: null,
  gate: null,
  semantic: false,
  resolvedFiles: [],
});

/** `merge` est le `MergeResult` COMPLET — jamais le `{sha, mergeSha}` déjà réduit pour le nœud. */
export function partialEvidenceFromMerge(merge: MergeResult | null): PartialEvidence {
  if (!merge) return emptyPartial();
  if (merge.status === 'MERGED') {
    return {
      commit: { sha: merge.sha, mergeSha: merge.mergeSha },
      gate: {
        success: merge.gate.success,
        exitCode: merge.gate.exitCode,
        timedOut: merge.gate.timedOut,
        log: merge.gate.log,
      },
      semantic: merge.semantic,
      resolvedFiles: merge.resolvedFiles,
    };
  }
  if (merge.status === 'UP_TO_DATE' && merge.alreadyMerged === true) {
    // Déjà intégré par un autre chemin : rien n'a été testé ni résolu ici.
    return {
      ...emptyPartial(),
      commit: { sha: merge.sha, mergeSha: merge.mergeSha ?? merge.sha, alreadyMerged: true },
    };
  }
  if (merge.status === 'GATE_FAILED') {
    // Rien n'a été mergé, mais le Test Gate A TOURNÉ : son journal est la
    // preuve la plus utile d'un échec — jamais tue derrière un commit null.
    return {
      ...emptyPartial(),
      gate: {
        success: merge.gate.success,
        exitCode: merge.gate.exitCode,
        timedOut: merge.gate.timedOut,
        log: merge.gate.log,
      },
      semantic: merge.semantic,
    };
  }
  return emptyPartial();
}

export async function buildEvidence(
  root: string,
  {
    objective,
    partial,
    verdicts,
    agent,
    kept,
  }: {
    objective: string | null;
    partial: PartialEvidence;
    verdicts: ReviewVerdictRecord[];
    agent: string | null;
    kept: boolean;
  },
): Promise<EvidenceBundle> {
  const usage = agent ? (await currentTotals(root, { agent })).perAgent : null;
  return {
    objective,
    ...partial,
    verdicts,
    kept,
    usage,
  };
}

/** Construction des résultats de nœud (lot O) — une seule forme pour tous les modes. */
import type { OrchestrationNodeResult, PlanNode } from '../types.js';

export function nodeResult(
  node: Pick<PlanNode, 'id' | 'kind'>,
  fields: Partial<OrchestrationNodeResult> & Pick<OrchestrationNodeResult, 'status'>,
): OrchestrationNodeResult {
  return {
    id: node.id,
    kind: node.kind,
    mode: 'autonomous',
    agent: null,
    agents: [],
    group: null,
    rounds: 0,
    detail: null,
    kept: false,
    merge: null,
    verdicts: [],
    ...fields,
  };
}

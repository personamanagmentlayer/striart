import type { StriartEvent } from '../types.js';

/**
 * Texte des `control.notice` pour les événements d'orchestration qui n'en
 * portent pas (le bus ne relaie à l'humain que les événements avec
 * `message`). Construit UNIQUEMENT à partir d'identifiants et d'énumérations
 * de l'événement — jamais d'un corps de message, d'un verdict ou d'un prompt
 * (contenu d'agent non fiable). `null` : pas une notice d'orchestration.
 */
export function describeOrchestrationEvent(event: { type: string }): string | null {
  const e = event as StriartEvent;
  switch (e.type) {
    case 'orchestration:node':
      return e.phase === 'started'
        ? `Orchestration ${e.runId}: node ${e.nodeId ?? '?'} (${e.kind}) started${e.agent ? ` on ${e.agent}` : ''}.`
        : `Orchestration ${e.runId}: node ${e.nodeId ?? '?'} (${e.kind}) finished${e.status ? ` — ${e.status}` : ''}.`;
    case 'collab:turn':
      return `Collaboration ${e.group}: round ${e.round}, ${e.role} ${e.phase === 'started' ? 'takes' : 'ends'} its turn on ${e.agent}${e.status ? ` — ${e.status}` : ''}.`;
    case 'collab:message':
      return `Collaboration ${e.group}: message #${e.seq} (${e.kind}) from ${e.from} to ${e.to}.`;
    case 'review:verdict':
      return `Review ${e.group}: ${e.reviewer} gave verdict ${e.verdict} on ${e.agent} (round ${e.round}).`;
    case 'review:human-pending':
      return `Human review ${e.reviewId} is waiting for ${e.agent} (${e.group}): answer it from the dashboard or with striart review.`;
    case 'race:winner':
      return e.agent
        ? `Race ${e.group}: ${e.agent} wins among ${e.candidates.length} candidate(s).`
        : `Race ${e.group}: no winner among ${e.candidates.length} candidate(s).`;
    default:
      return null;
  }
}

/**
 * Vue d'état complète de l'orchestrateur — source unique pour `striart
 * status` (CLI, humain et `--json`) et l'outil MCP `striart_status`. Avant
 * la 0.11, la CLI n'exposait que les agents tandis que le MCP composait sa
 * propre vue : deux réponses différentes à la même question.
 *
 * Lecture seule, aucun verrou : un instantané, pas une transaction.
 */
import { presentAgents } from './agent-view.ts';
import { listAgents } from './clone.js';
import { listConflictTickets } from './conflicts.js';
import { loadConfig } from './config.js';
import { watchDaemonStatus } from './daemon.js';
import { readMainSessionStatus } from './main-session.js';
import { getQueueDashboard } from './orchestrator.js';
import { readState } from './state.js';
import { listHumanReviews } from './orchestration/human-review.ts';
import { listOrchestrationState } from './orchestration/store.ts';
import { usageSummary } from './tokens/report.ts';

/**
 * Résumé des tokens (lot T), champ ADDITIF de la vue d'état : comptabilité
 * active, consommation du jour, plafonds et leur niveau, relâchements. Ne
 * throw jamais — une config ou un registre illisible se déclare
 * (`available: false`), il ne casse pas la vue d'état.
 */
async function tokensStatus(root: string) {
  try {
    return { available: true, ...(await usageSummary(root, await loadConfig(root))) };
  } catch (error) {
    return { available: false, reason: error.code ?? error.message };
  }
}

export async function collectStatus(root: string) {
  const [agents, queue, tickets, state, daemon, mainSession, orchestration, reviews, tokens] =
    await Promise.all([
      listAgents(root),
      getQueueDashboard({ root }),
      listConflictTickets(root),
      readState(root),
      watchDaemonStatus({ root }),
      readMainSessionStatus(root),
      // Lot O : plans v2 et groupes orchestrés (en cours et récents), et
      // relectures humaines — dont celles qui attendent un verdict.
      listOrchestrationState(root),
      listHumanReviews(root),
      tokensStatus(root),
    ]);
  return {
    // Clones en cours de suppression : état dédié REMOVING (agent-view.ts).
    agents: presentAgents(agents),
    queue,
    tickets,
    state,
    daemon,
    mainSession,
    orchestration: { ...orchestration, reviews },
    tokens,
  };
}

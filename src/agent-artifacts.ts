/**
 * Artefacts périphériques d'un agent qui quitte le registre (`striart stop`) ou
 * dont le clone est supprimé (`striart clean`) : hôte ACP persistant (sa session
 * tient le clone) et Tab Configs Warp. Un seul endroit pour les deux chemins.
 *
 * Contrat : best effort RAPPORTÉ — une erreur ne fait jamais échouer l'arrêt ou
 * le nettoyage qui a réussi par ailleurs, mais n'est jamais avalée non plus
 * (journal + liste `errors` rendue à l'appelant). Imports paresseux : ni
 * `acp/host.ts` (qui dépend de clone.js) ni `terminal.js` ne sont chargés au
 * démarrage de la CLI ni ne créent de cycle avec clone.js.
 */
import { loadConfig } from './config.ts';
import { logger } from './logger.ts';

export interface AgentArtifactsReport {
  /** Résultat de l'arrêt de l'hôte ACP (null si l'arrêt a échoué). */
  acpHost: {
    stopped: boolean;
    stopping: boolean;
    wasStale: boolean;
    untouched: string | null;
  } | null;
  /** Chemins des Tab Configs Warp supprimés. */
  terminalArtifacts: string[];
  /** Échecs rapportés (jamais bloquants). */
  errors: Array<{ what: 'acp-host' | 'terminal-artifacts'; message: string }>;
}

export async function releaseAgentArtifacts({
  root,
  agent,
}: {
  root: string;
  agent: string;
}): Promise<AgentArtifactsReport> {
  const report: AgentArtifactsReport = { acpHost: null, terminalArtifacts: [], errors: [] };

  try {
    const { stopAcpHost } = await import('./acp/host.ts');
    report.acpHost = await stopAcpHost(root, agent);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn({ agent, err: message }, "Arrêt de l'hôte ACP en échec (rapporté)");
    report.errors.push({ what: 'acp-host', message });
  }

  try {
    const { removeAgentTerminalArtifacts } = await import('./terminal.ts');
    const config = await loadConfig(root).catch(() => null);
    report.terminalArtifacts = await removeAgentTerminalArtifacts({
      root,
      agent,
      terminal: config?.terminal,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn({ agent, err: message }, 'Nettoyage des artefacts de terminal en échec (rapporté)');
    report.errors.push({ what: 'terminal-artifacts', message });
  }

  return report;
}

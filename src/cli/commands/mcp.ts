import { logMcpScope, resolveMcpCaller, startMcpServer } from '../../mcp.js';
import type { CommandModule } from '../context.ts';

export interface McpInput {
  /** `--root` : racine du dépôt principal, prioritaire sur le cwd. */
  root: string | null;
  /** `--agent` : borne les outils à cet agent. */
  agent: string | null;
  /** `--read-only` : aucun outil mutant. */
  readOnly: boolean;
  /** `--collab` : avec `--read-only` et un agent borné, accorde `striart_collab_post` seul. */
  collab: boolean;
}

/**
 * Serveur MCP sur stdio : stdout EST le canal du protocole JSON-RPC. Rien
 * d'autre n'y est jamais écrit (les logs vont sur stderr, la progression est
 * coupée). Se termine quand le client ferme stdin (ou sur Ctrl+C), après
 * les opérations en vol — un merge sous verrou n'est jamais interrompu.
 *
 * La racine et l'appelant sont résolus AVANT de servir (fail closed) :
 * `--root` invalide, `--agent` inconnu ou contradictoire avec le clone du
 * cwd → erreur d'usage, aucun octet écrit sur stdout.
 */
export const mcp: CommandModule<McpInput, { action: 'mcp' }> = {
  async execute(ctx, input) {
    const { root, caller, settings } = await resolveMcpCaller({
      cwd: ctx.cwd,
      rootOption: input.root,
      agentOption: input.agent,
      readOnly: input.readOnly,
      collab: input.collab,
    });
    logMcpScope(root, caller, process.env);
    await startMcpServer({ root, caller, settings, signal: ctx.signal });
    return { data: { action: 'mcp' }, outcome: 'ok' };
  },
};

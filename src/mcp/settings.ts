import { DEFAULT_CONFIG } from '../config.ts';
import type { McpSettings, StriartConfig } from '../types.js';

/**
 * Réglages MCP effectifs : `config.mcp` est un objet PARTIEL (loadConfig ne
 * fusionne qu'en surface — un `{ apps: false }` utilisateur remplacerait
 * sinon tout l'objet par défaut). Les valeurs ont déjà été validées au
 * chargement (VALIDATORS.mcp, src/config.js).
 */
/**
 * Relâchements de protection portés par `config.mcp`, pour `striart doctor`
 * (règle : relâcher une protection est explicite, journalisé, affiché).
 * Chaque entrée : la clé et une phrase lisible (anglais, comme les messages
 * d'erreur du domaine). Désactiver `apps` ou `tasks` resserre : non listé.
 */
export function mcpRelaxations(settings: McpSettings): Array<{ key: string; summary: string }> {
  const out: Array<{ key: string; summary: string }> = [];
  if (settings.scope === 'orchestrator') {
    out.push({
      key: 'mcp.scope',
      summary:
        "mcp.scope is 'orchestrator': an MCP server started outside any agent clone can run tasks, merge any agent and apply any ticket resolution (it still cannot close a ticket without the Test Gate nor arbitrate permissions).",
    });
  }
  return out;
}

export function resolveMcpSettings(config: Pick<StriartConfig, 'mcp'> | null = null): McpSettings {
  return { ...(DEFAULT_CONFIG.mcp as McpSettings), ...(config?.mcp ?? {}) };
}

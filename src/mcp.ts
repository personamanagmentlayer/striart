/**
 * Point d'entrée historique du serveur MCP. L'implémentation vit dans
 * src/mcp/ (double ère 2026-07-28 / legacy, outils bornés D6, ressources et
 * abonnements, extension Tasks, vue MCP Apps) — voir src/mcp/server.ts.
 */
export { McpConnection, handleMcpRequest, startMcpServer } from './mcp/server.ts';
export { resolveMcpCaller, describeMcpScope, logMcpScope } from './mcp/scope.ts';
export { mcpRelaxations, resolveMcpSettings } from './mcp/settings.ts';

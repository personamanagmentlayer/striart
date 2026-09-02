import readline from 'node:readline';
import { listAgents } from './clone.js';
import { getQueueDashboard, mergeAgentCommit, runTask } from './orchestrator.js';
import { closeConflictTicket, listConflictTickets } from './conflicts.js';
import { readState } from './state.js';
import { watchDaemonStatus } from './daemon.js';
import { StriartError } from './errors.js';
import { logger } from './logger.js';

/**
 * Serveur MCP (Model Context Protocol) — l'intégration IDE de Striart.
 *
 * Expose l'orchestrateur comme outillage à tout hôte MCP (Claude Code,
 * Cursor, …) : l'agent devient un CLIENT de l'orchestrateur au lieu de le
 * contourner. Chaque outil réutilise les fonctions de l'orchestrateur —
 * mêmes verrous, mêmes garde-fous que le CLI et le dashboard, aucune
 * logique métier ici.
 *
 * Transport stdio : JSON-RPC 2.0, un message par ligne. stdout est le canal
 * du protocole — les logs partent sur stderr (voir logger.js). Zéro
 * dépendance : le sous-ensemble du protocole utilisé (initialize,
 * tools/list, tools/call, ping) est assez petit pour ne pas justifier un SDK.
 *
 * GARDE DE PROFONDEUR : une session autonome porte STRIART_SESSION=1 dans
 * son environnement (session.js), hérité par tout MCP qu'elle lancerait.
 * Les outils MUTANTS sont alors refusés — un agent peut consulter l'état,
 * jamais engendrer d'autres agents ni merger : sans cette borne,
 * striart_run → agent → striart_run récurse sans limite, chaque niveau
 * consommant des tokens sans surveillance.
 */

const PROTOCOL_VERSION = '2025-06-18';

/** Vrai quand ce process descend d'une session autonome Striart. */
function isNestedSession(env = process.env) {
  return env.STRIART_SESSION === '1';
}

/**
 * Table des outils exposés. `mutating: true` → refusé dans une session
 * autonome (garde de profondeur). Les schémas sont volontairement plats :
 * un hôte MCP les présente tels quels au modèle.
 */
const TOOLS = {
  striart_status: {
    description:
      "État complet de l'orchestrateur : agents actifs (statut, mode, branche, commits en attente), file d'attente, tickets de conflit ouverts, mode manuel, état du watcher.",
    mutating: false,
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler: async (root) => {
      const [agents, queue, tickets, state, daemon] = await Promise.all([
        listAgents(root),
        getQueueDashboard({ root }),
        listConflictTickets(root),
        readState(root),
        watchDaemonStatus({ root }),
      ]);
      return { agents, queue, tickets, state, daemon };
    },
  },
  striart_run: {
    description:
      "Lance une tâche de coding : le Router prédit les fichiers touchés, crée un clone agent isolé si aucune collision, sinon met la tâche en file d'attente. Retourne l'agent créé (avec le chemin de son clone) ou la tâche enfilée.",
    mutating: true,
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'La tâche à confier à un agent.' },
        agent: {
          type: 'string',
          description: "Nom de l'agent (défaut : dérivé du prompt).",
        },
      },
      required: ['prompt'],
      additionalProperties: false,
    },
    handler: (root, { prompt, agent }) => runTask({ root, prompt, agent: agent ?? null }),
  },
  striart_merge: {
    description:
      "Merge le dernier commit d'un agent dans la branche cible : rebase préalable, fusion sémantique en cas de conflit, Test Gate bloquant. Retourne le statut détaillé (MERGED, CONFLICT, GATE_FAILED…).",
    mutating: true,
    inputSchema: {
      type: 'object',
      properties: { agent: { type: 'string', description: "Nom de l'agent à merger." } },
      required: ['agent'],
      additionalProperties: false,
    },
    handler: (root, { agent }) => mergeAgentCommit({ root, agent }),
  },
  striart_queue: {
    description:
      "File d'attente des tâches : RUNNING / WAITING, collisions qui bloquent chaque tâche en attente.",
    mutating: false,
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler: (root) => getQueueDashboard({ root }),
  },
  striart_resolve: {
    description:
      'Marque un ticket de conflit comme résolu (le dossier du ticket est conservé). À utiliser après avoir réglé le conflit à la main dans le repo.',
    mutating: true,
    inputSchema: {
      type: 'object',
      properties: { ticketId: { type: 'string', description: 'Id du ticket à clore.' } },
      required: ['ticketId'],
      additionalProperties: false,
    },
    handler: (root, { ticketId }) => closeConflictTicket(root, ticketId),
  },
};

/** Réponse JSON-RPC (erreur si `error` est fourni). */
function rpcResult(id, result) {
  return { jsonrpc: '2.0', id, result };
}
function rpcError(id, code, message) {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

/**
 * Traite UNE requête JSON-RPC MCP et retourne la réponse, ou null pour une
 * notification (sans id, jamais de réponse). Exporté pour les tests : le
 * dispatch est pur, le transport stdio n'est qu'une boucle autour.
 *
 * @param {{root: string, env?: NodeJS.ProcessEnv}} ctx
 * @param {any} request
 * @returns {Promise<object | null>}
 */
export async function handleMcpRequest({ root, env = process.env }, request) {
  const { id, method, params } = request ?? {};
  const isNotification = id === undefined || id === null;

  switch (method) {
    case 'initialize':
      return rpcResult(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: 'striart', version: 'striart-mcp' },
      });
    case 'ping':
      return rpcResult(id, {});
    case 'notifications/initialized':
    case 'notifications/cancelled':
      return null;
    case 'tools/list':
      return rpcResult(id, {
        tools: Object.entries(TOOLS).map(([name, tool]) => ({
          name,
          description: tool.description,
          inputSchema: tool.inputSchema,
        })),
      });
    case 'tools/call': {
      const tool = TOOLS[params?.name];
      if (!tool) return rpcError(id, -32602, `Outil inconnu : ${params?.name}`);
      if (tool.mutating && isNestedSession(env)) {
        // Garde de profondeur — refus OUTIL (isError), pas erreur protocole :
        // l'agent doit lire le motif et s'adapter, pas crasher.
        return rpcResult(id, {
          isError: true,
          content: [
            {
              type: 'text',
              text: `Refusé : ${params.name} est un outil mutant et ce process descend d'une session autonome Striart. Un agent peut consulter l'état (striart_status, striart_queue), jamais engendrer d'agents ni merger — la profondeur d'orchestration est bornée à 1.`,
            },
          ],
        });
      }
      try {
        const result = await tool.handler(root, params?.arguments ?? {});
        return rpcResult(id, {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        });
      } catch (error) {
        // Échec MÉTIER (StriartError ou opération git) : rapporté comme
        // résultat d'outil en erreur — le modèle appelant doit le voir.
        const code = error instanceof StriartError ? ` [${error.code}]` : '';
        return rpcResult(id, {
          isError: true,
          content: [{ type: 'text', text: `${error.message}${code}` }],
        });
      }
    }
    default:
      return isNotification ? null : rpcError(id, -32601, `Méthode inconnue : ${method}`);
  }
}

/**
 * Boucle stdio : une ligne = un message JSON-RPC. Ne termine que sur la fin
 * de stdin (l'hôte MCP ferme le canal). `input`/`output` sont injectables
 * pour tester la boucle EN PROCESS (la couverture v8 ne voit pas un serveur
 * lancé en process enfant) — mêmes valeurs par défaut au runtime.
 * @param {{root: string, input?: NodeJS.ReadableStream, output?: NodeJS.WritableStream, env?: NodeJS.ProcessEnv}} params
 * @returns {Promise<void>}
 */
export function startMcpServer({ root, input = process.stdin, output = process.stdout, env }) {
  // Borne de ligne : une requête JSON-RPC légitime est minuscule (un appel
  // d'outil = quelques centaines d'octets). readline bufferise une ligne
  // entière en mémoire — sans plafond, un stdin inondé sans « \n » ferait
  // gonfler le tampon jusqu'à l'OOM. 1 Mo est très large pour un prompt.
  const rl = readline.createInterface({ input, terminal: false });
  logger.info({ root }, 'Serveur MCP striart démarré (stdio)');

  return new Promise((resolve) => {
    rl.on('line', async (line) => {
      if (line.length > 1_000_000) {
        output.write(
          `${JSON.stringify(rpcError(null, -32700, 'Requête trop volumineuse (> 1 Mo)'))}\n`,
        );
        return;
      }
      const text = line.trim();
      if (!text) return;
      let request;
      try {
        request = JSON.parse(text);
      } catch {
        output.write(`${JSON.stringify(rpcError(null, -32700, 'JSON invalide'))}\n`);
        return;
      }
      const response = await handleMcpRequest({ root, ...(env ? { env } : {}) }, request);
      if (response) output.write(`${JSON.stringify(response)}\n`);
    });
    rl.on('close', () => {
      logger.info('Serveur MCP striart arrêté (stdin fermé)');
      resolve();
    });
  });
}

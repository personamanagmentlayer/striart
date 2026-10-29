import { open, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { isReadableTicket, listConflictTickets } from '../conflicts.ts';
import { striartDir } from '../paths.ts';
import { TICKET_ID_RE } from '../ticket-id.ts';
import { collectStatus } from '../status.ts';
import { StriartError } from '../errors.ts';
import { readTicketView } from './tools.ts';
import { TICKET_VIEW_HTML, TICKET_VIEW_URI } from './ticket-view.ts';
import { UI_MIME } from './protocol.ts';
import type { JsonObject } from './protocol.ts';
import type { McpGrants } from './scope.ts';

/**
 * Ressources MCP : l'état de Striart en lecture, adressé par URI.
 *
 *   striart://status               vue d'état complète (= striart_status)
 *   striart://tickets              tickets de conflit ouverts
 *   striart://tickets/{ticketId}   détail 3-way borné d'un ticket
 *   striart://logs/{name}          fin d'un journal de .striart/logs/
 *   ui://striart/ticket-view       vue MCP Apps (si activée ; hors listing,
 *                                  découverte par les métadonnées d'outil)
 *
 * Aucune URI ne devient un chemin : un id de ticket est cherché dans le
 * listing des tickets, un nom de journal dans le listing de .striart/logs/
 * (readdir) — jamais concaténé tel quel. Un appelant BORNÉ à un agent ne
 * voit que ses propres journaux (sessions et pty) : un journal d'agent peut
 * contenir ce qu'une autre session a affiché, secrets compris. L'état et
 * les tickets restent visibles de tous (déjà exposés par striart_status).
 */

export const STATUS_URI = 'striart://status';
export const TICKETS_URI = 'striart://tickets';
const TICKET_PREFIX = 'striart://tickets/';
const LOG_PREFIX = 'striart://logs/';
/** Fin de journal servie (même ordre de grandeur que le dashboard). */
export const LOG_TAIL_BYTES = 64_000;
const LOG_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,200}\.log$/;

const JSON_MIME = 'application/json';

function notFound(uri: string): StriartError {
  return new StriartError(`Unknown resource: ${uri}`, {
    code: 'MCP_RESOURCE_UNKNOWN',
    details: { uri },
  });
}

/**
 * Journal de session EXACT d'un agent : `session-<agent>-<taskId>.log`, avec un
 * taskId de 8 hexadécimaux (clone.js). Un simple préfixe `session-<agent>-`
 * laisserait l'agent `auth` lire les journaux de `auth-ui` (ou de
 * `auth-deadbeef`), contournant le bornage au périmètre de l'agent.
 */
function agentSessionLogRe(agent: string): RegExp {
  const escaped = agent.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^session-${escaped}-[0-9a-f]{8}\\.log$`);
}

/** Journaux lisibles par l'appelant (noms, issus de readdir). */
async function visibleLogs(root: string, grants: McpGrants): Promise<string[]> {
  const entries = await readdir(path.join(striartDir(root), 'logs')).catch((error) => {
    if (error.code === 'ENOENT') return [] as string[];
    throw error;
  });
  return entries
    .filter((name) => LOG_NAME_RE.test(name))
    .filter((name) => {
      const only = grants.onlyAgent;
      if (!only) return true;
      return name === `pty-${only}.log` || agentSessionLogRe(only).test(name);
    })
    .sort();
}

async function readTail(
  file: string,
  maxBytes: number,
): Promise<{ text: string; truncated: boolean }> {
  const handle = await open(file, 'r');
  try {
    const { size } = await handle.stat();
    const length = Math.min(size, maxBytes);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, size - length);
    let text = buffer.toString('utf8');
    // Début possiblement au milieu d'un caractère multi-octets : on retire
    // le caractère de remplacement initial plutôt que d'afficher du bruit.
    if (size > maxBytes) text = text.replace(/^�+/, '');
    return { text, truncated: size > maxBytes };
  } finally {
    await handle.close();
  }
}

export interface ResourceEntry {
  uri: string;
  name: string;
  title?: string;
  description?: string;
  mimeType: string;
  size?: number;
}

export async function listResources(root: string, grants: McpGrants): Promise<ResourceEntry[]> {
  const [tickets, logs] = await Promise.all([listConflictTickets(root), visibleLogs(root, grants)]);
  const logDir = path.join(striartDir(root), 'logs');
  const logEntries = await Promise.all(
    logs.map(async (name) => {
      const size = await stat(path.join(logDir, name)).then(
        (s) => s.size,
        () => undefined,
      );
      return {
        uri: `${LOG_PREFIX}${name}`,
        name: `log:${name}`,
        title: `Log ${name}`,
        mimeType: 'text/plain',
        ...(size === undefined ? {} : { size }),
      };
    }),
  );
  return [
    {
      uri: STATUS_URI,
      name: 'status',
      title: 'Striart status',
      description: 'Full orchestrator state (same view as striart_status).',
      mimeType: JSON_MIME,
    },
    {
      uri: TICKETS_URI,
      name: 'tickets',
      title: 'Open conflict tickets',
      mimeType: JSON_MIME,
    },
    ...tickets.map((t) => ({
      uri: `${TICKET_PREFIX}${t.id}`,
      name: `ticket:${t.id}`,
      title: isReadableTicket(t)
        ? `Conflict ticket ${t.id} (${t.agent}, ${t.reason})`
        : `Unreadable conflict ticket ${t.id} (${t.cause})`,
      mimeType: JSON_MIME,
    })),
    ...logEntries,
  ];
}

export const RESOURCE_TEMPLATES = [
  {
    uriTemplate: `${TICKET_PREFIX}{ticketId}`,
    name: 'ticket',
    title: 'Conflict ticket (3-way detail)',
    mimeType: JSON_MIME,
  },
  {
    uriTemplate: `${LOG_PREFIX}{name}`,
    name: 'log',
    title: 'Striart log tail',
    mimeType: 'text/plain',
  },
];

export type ResourceTarget =
  | { kind: 'status' }
  | { kind: 'tickets' }
  | { kind: 'ticket'; ticketId: string }
  | { kind: 'log'; name: string }
  | { kind: 'ui' };

/** Analyse syntaxique d'une URI (sans accès disque), null si hors du schéma servi. */
export function parseResourceUri(uri: unknown): ResourceTarget | null {
  if (typeof uri !== 'string' || uri.length > 512) return null;
  if (uri === STATUS_URI) return { kind: 'status' };
  if (uri === TICKETS_URI) return { kind: 'tickets' };
  if (uri === TICKET_VIEW_URI) return { kind: 'ui' };
  if (uri.startsWith(TICKET_PREFIX)) {
    const ticketId = uri.slice(TICKET_PREFIX.length);
    return TICKET_ID_RE.test(ticketId) ? { kind: 'ticket', ticketId } : null;
  }
  if (uri.startsWith(LOG_PREFIX)) {
    const name = uri.slice(LOG_PREFIX.length);
    return LOG_NAME_RE.test(name) ? { kind: 'log', name } : null;
  }
  return null;
}

/**
 * Lit une ressource. `uiEnabled` : la vue MCP Apps n'existe que si la config
 * l'active ET que le client déclare l'extension (sinon : ressource inconnue).
 */
export async function readResource(
  root: string,
  grants: McpGrants,
  uri: string,
  { uiEnabled }: { uiEnabled: boolean },
): Promise<JsonObject[]> {
  const target = parseResourceUri(uri);
  if (!target) throw notFound(uri);
  switch (target.kind) {
    case 'status':
      return [
        { uri, mimeType: JSON_MIME, text: JSON.stringify(await collectStatus(root), null, 2) },
      ];
    case 'tickets':
      return [
        {
          uri,
          mimeType: JSON_MIME,
          text: JSON.stringify(await listConflictTickets(root), null, 2),
        },
      ];
    case 'ticket': {
      const view = await readTicketView(root, target.ticketId).catch((error) => {
        if (error instanceof StriartError && error.code === 'TICKET_UNKNOWN') throw notFound(uri);
        throw error;
      });
      return [{ uri, mimeType: JSON_MIME, text: JSON.stringify(view, null, 2) }];
    }
    case 'log': {
      const logs = await visibleLogs(root, grants);
      const name = logs.find((n) => n === target.name);
      if (!name) throw notFound(uri);
      const tail = await readTail(path.join(striartDir(root), 'logs', name), LOG_TAIL_BYTES);
      return [
        {
          uri,
          mimeType: 'text/plain',
          text: tail.text,
          _meta: { 'striart/truncated': tail.truncated },
        },
      ];
    }
    case 'ui':
      if (!uiEnabled) throw notFound(uri);
      return [
        {
          uri,
          mimeType: UI_MIME,
          text: TICKET_VIEW_HTML,
          // Aucun domaine externe : l'hôte applique son défaut restrictif.
          _meta: { ui: { csp: {}, prefersBorder: true } },
        },
      ];
    default:
      throw notFound(uri);
  }
}

/** L'appelant peut-il s'abonner à cette URI ? (même règle que la lecture, sans E/S lourde.) */
export async function canSubscribe(root: string, grants: McpGrants, uri: string): Promise<boolean> {
  const target = parseResourceUri(uri);
  if (!target || target.kind === 'ui') return false;
  if (target.kind === 'log') return (await visibleLogs(root, grants)).includes(target.name);
  if (target.kind === 'ticket') {
    return (await listConflictTickets(root, { includeResolved: true })).some(
      (t) => t.id === target.ticketId,
    );
  }
  return true;
}

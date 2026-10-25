import { createRequire } from 'node:module';

/**
 * Socle protocolaire du serveur MCP : versions, ères, codes d'erreur et
 * forme des messages. Aucune logique métier.
 *
 * DOUBLE ÈRE (spec 2026-07-28, basic/versioning) :
 *  - ère MODERNE (2026-07-28) : sans état. Chaque requête porte sa version
 *    et les capacités du client dans `params._meta`
 *    (`io.modelcontextprotocol/protocolVersion`, `…/clientCapabilities`) ;
 *    chaque résultat porte `resultType` et `_meta[…/serverInfo]` ;
 *    `server/discover` remplace la poignée de main, `ping` n'existe plus.
 *  - ère LEGACY (≤ 2025-11-25) : poignée de main `initialize`, état porté
 *    par la connexion stdio.
 *
 * Règle de sélection, SANS ambiguïté : l'ère se décide PAR REQUÊTE, sur la
 * seule présence de la clé réservée `io.modelcontextprotocol/protocolVersion`
 * dans `params._meta`. Un client moderne la met sur CHAQUE requête (champ
 * requis) ; un client legacy ne peut pas l'émettre (préfixe réservé à MCP).
 * Un `tools/call` moderne sans aucune poignée de main est donc servi sous la
 * sémantique moderne — jamais sous la sémantique legacy par défaut (le
 * piège « era-ambiguous » décrit par la spec stdio). `initialize` choisit
 * l'ère legacy pour la connexion ; les deux ères peuvent coexister sur le
 * même process (autorisé : « MAY serve both eras concurrently »).
 */

export const MODERN_VERSIONS: readonly string[] = ['2026-07-28'];
/** Révisions à poignée de main servies, de la plus récente à la plus ancienne. */
export const LEGACY_VERSIONS: readonly string[] = [
  '2025-11-25',
  '2025-06-18',
  '2025-03-26',
  '2024-11-05',
];
export const LATEST_LEGACY_VERSION = LEGACY_VERSIONS[0];

export const META_PROTOCOL_VERSION = 'io.modelcontextprotocol/protocolVersion';
export const META_CLIENT_CAPABILITIES = 'io.modelcontextprotocol/clientCapabilities';
export const META_CLIENT_INFO = 'io.modelcontextprotocol/clientInfo';
export const META_SERVER_INFO = 'io.modelcontextprotocol/serverInfo';
export const META_SUBSCRIPTION_ID = 'io.modelcontextprotocol/subscriptionId';

export const EXT_TASKS = 'io.modelcontextprotocol/tasks';
export const EXT_UI = 'io.modelcontextprotocol/ui';
export const UI_MIME = 'text/html;profile=mcp-app';

/** Clé `_meta` (préfixe propre à Striart) portant le code d'erreur stable d'un refus d'outil. */
export const META_STRIART_ERROR = 'striart/error';

export const RPC = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
  MISSING_REQUIRED_CLIENT_CAPABILITY: -32021,
  UNSUPPORTED_PROTOCOL_VERSION: -32022,
} as const;

export const PACKAGE_VERSION: string = createRequire(import.meta.url)('../../package.json').version;
export const SERVER_INFO = { name: 'striart', version: PACKAGE_VERSION } as const;

export type RequestId = string | number;
export type JsonObject = Record<string, unknown>;

export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: RequestId | null;
  result?: JsonObject;
  error?: JsonRpcError;
}

export interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: JsonObject;
}

export type OutgoingMessage = JsonRpcResponse | JsonRpcNotification;

/**
 * Contexte protocolaire d'UNE requête : son ère, la révision qui la régit et
 * les capacités déclarées par le client pour CETTE requête (moderne) ou à
 * l'initialisation (legacy).
 */
export interface Era {
  kind: 'modern' | 'legacy';
  version: string;
  clientCapabilities: JsonObject;
}

export function rpcResult(id: RequestId, result: JsonObject): JsonRpcResponse {
  return { jsonrpc: '2.0', id, result };
}

export function rpcError(
  id: RequestId | null,
  code: number,
  message: string,
  data?: unknown,
): JsonRpcResponse {
  return {
    jsonrpc: '2.0',
    id,
    error: data === undefined ? { code, message } : { code, message, data },
  };
}

export function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Habille un résultat selon l'ère : en moderne, `resultType` (requis) et
 * l'identité du serveur dans `_meta` ; en legacy, le résultat tel quel.
 */
export function shapeResult(era: Era, payload: JsonObject, resultType = 'complete'): JsonObject {
  if (era.kind === 'legacy') return payload;
  const meta = isObject(payload._meta) ? payload._meta : {};
  return { ...payload, resultType, _meta: { ...meta, [META_SERVER_INFO]: SERVER_INFO } };
}

/** Champs `CacheableResult` (moderne uniquement). */
export function cacheable(era: Era, ttlMs: number): JsonObject {
  return era.kind === 'modern' ? { ttlMs, cacheScope: 'private' } : {};
}

/** Le client déclare-t-il l'extension `id` dans ses capacités ? */
export function clientHasExtension(era: Era, id: string): boolean {
  const extensions = era.clientCapabilities.extensions;
  return isObject(extensions) && isObject(extensions[id]);
}

/** Une révision legacy ≥ `minimum` (dates ISO : l'ordre lexical est l'ordre chronologique). */
export function legacyAtLeast(era: Era, minimum: string): boolean {
  return era.kind === 'modern' || era.version >= minimum;
}

export type EraDecision =
  { ok: true; era: Era } | { ok: false; error: { code: number; message: string; data?: unknown } };

/**
 * Décide l'ère d'une requête (voir l'en-tête du module). `legacyState` est
 * l'état de la connexion legacy (version négociée par `initialize`, ou
 * null tant qu'aucune poignée de main n'a eu lieu).
 */
export function decideEra(
  params: unknown,
  legacyState: { version: string; clientCapabilities: JsonObject } | null,
): EraDecision {
  const meta = isObject(params) && isObject(params._meta) ? params._meta : null;
  if (meta && Object.hasOwn(meta, META_PROTOCOL_VERSION)) {
    const requested = meta[META_PROTOCOL_VERSION];
    if (typeof requested !== 'string' || !MODERN_VERSIONS.includes(requested)) {
      return {
        ok: false,
        error: {
          code: RPC.UNSUPPORTED_PROTOCOL_VERSION,
          message: 'Unsupported protocol version',
          data: { supported: [...MODERN_VERSIONS], requested: String(requested) },
        },
      };
    }
    const capabilities = meta[META_CLIENT_CAPABILITIES];
    if (!isObject(capabilities)) {
      return {
        ok: false,
        error: {
          code: RPC.INVALID_PARAMS,
          message: `Missing required _meta field "${META_CLIENT_CAPABILITIES}" (object).`,
        },
      };
    }
    return {
      ok: true,
      era: { kind: 'modern', version: requested, clientCapabilities: capabilities },
    };
  }
  // Ère legacy. Sans poignée de main préalable (hôte laxiste, tests), la
  // requête est servie sous la révision legacy la plus récente — c'est une
  // tolérance déjà offerte avant la double ère, jamais une bascule moderne.
  return {
    ok: true,
    era: {
      kind: 'legacy',
      version: legacyState?.version ?? LATEST_LEGACY_VERSION,
      clientCapabilities: legacyState?.clientCapabilities ?? {},
    },
  };
}

/** Négociation legacy : la version demandée si servie, sinon la plus récente. */
export function negotiateLegacyVersion(requested: unknown): string {
  return typeof requested === 'string' && LEGACY_VERSIONS.includes(requested)
    ? requested
    : LATEST_LEGACY_VERSION;
}

/** Clé de Map stable pour un id JSON-RPC (1 et "1" sont deux requêtes distinctes). */
export function idKey(id: RequestId): string {
  return `${typeof id}:${String(id)}`;
}

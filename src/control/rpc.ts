/**
 * Répartiteur JSON-RPC 2.0 du Striart Control Protocol, commun aux deux
 * transports (stdio, HTTP). Il ne connaît ni socket ni flux : il reçoit un
 * message DÉJÀ décodé (ou une erreur de décodage) et rend la réponse à
 * écrire (ou null pour une notification).
 *
 * Chaîne de traitement d'une requête, fail closed à chaque étape :
 *  1. forme JSON-RPC (objet, `jsonrpc: "2.0"`, `method` chaîne, `id`
 *     chaîne/entier/null) — sinon -32600 ;
 *  2. méthode connue ET servie par ce transport — sinon -32601 / -32602 ;
 *  3. paramètres nommés validés contre leur schéma PUBLIÉ, objet fermé —
 *     sinon -32602 avec le code stable du schéma (INVALID_AGENT_NAME…) ;
 *  4. handler du domaine ; toute erreur devient le document d'erreur du
 *     contrat `--json` (code/kind/message/hint/details) dans `error.data`.
 * Une erreur inattendue n'expose jamais son message interne au pair : elle
 * est journalisée ici, le pair reçoit UNEXPECTED (A10).
 */
import { StriartError } from '../errors.js';
import { logger } from '../logger.js';
import { errorDocument, errorObject, successDocument } from './envelope.ts';
import type { ErrorObject } from './envelope.ts';
import { HANDLERS } from './methods.ts';
import type { MethodContext } from './methods.ts';
import {
  RPC_ERROR_CODES,
  SCHEMA_ROOT,
  methodSpec,
  paramsSchema,
  publishedSchemas,
} from './schema.ts';
import { assertSupportedSchema, createValidator } from './validate.ts';

/** Taille maximale d'un lot JSON-RPC (au-delà : requête invalide). */
export const MAX_BATCH = 32;

export type JsonRpcId = string | number | null;

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: JsonRpcId;
  result?: unknown;
  error?: { code: number; message: string; data: unknown };
}

const validate = createValidator(SCHEMA_ROOT);
// Fermeture vérifiée au chargement : un mot-clé non pris en charge dans un
// schéma publié serait une contrainte annoncée mais jamais appliquée.
assertSupportedSchema(SCHEMA_ROOT, publishedSchemas());

const PROTOCOL_CODES: Record<string, number> = {
  CONTROL_PARSE_ERROR: RPC_ERROR_CODES.PARSE_ERROR,
  CONTROL_INVALID_REQUEST: RPC_ERROR_CODES.INVALID_REQUEST,
  CONTROL_MESSAGE_TOO_LARGE: RPC_ERROR_CODES.INVALID_REQUEST,
  CONTROL_METHOD_UNKNOWN: RPC_ERROR_CODES.METHOD_NOT_FOUND,
  CONTROL_UNAUTHENTICATED: RPC_ERROR_CODES.UNAUTHENTICATED,
  UNEXPECTED: RPC_ERROR_CODES.INTERNAL_ERROR,
};

/** Code JSON-RPC numérique d'une erreur du contrat. */
export function rpcErrorCode(error: ErrorObject): number {
  const fixed = PROTOCOL_CODES[error.code];
  if (fixed !== undefined) return fixed;
  if (error.kind === 'usage') return RPC_ERROR_CODES.INVALID_PARAMS;
  if (error.kind === 'refusal') return RPC_ERROR_CODES.REFUSAL;
  return RPC_ERROR_CODES.FAILURE;
}

/** Réponse d'erreur JSON-RPC portant le document d'erreur du contrat. */
export function errorResponse(
  id: JsonRpcId,
  command: string | null,
  error: unknown,
  ctx: Pick<MethodContext, 'm'>,
): JsonRpcResponse {
  if (!(error instanceof StriartError)) {
    logger.error({ err: error, method: command }, 'Unexpected error in a control protocol call');
  }
  const object = errorObject(error, ctx.m, { exposeUnexpected: false });
  return {
    jsonrpc: '2.0',
    id,
    error: {
      code: rpcErrorCode(object),
      message: object.message,
      data: errorDocument(command, object),
    },
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validId(value: unknown): value is JsonRpcId {
  return (
    value === null ||
    typeof value === 'string' ||
    (typeof value === 'number' && Number.isSafeInteger(value))
  );
}

function invalidRequest(reason: string): StriartError {
  return new StriartError(`Invalid JSON-RPC 2.0 request: ${reason}.`, {
    code: 'CONTROL_INVALID_REQUEST',
    details: { reason },
    hint: 'Send {"jsonrpc":"2.0","id":1,"method":"control.initialize","params":{"protocolVersion":1}}.',
  });
}

/** Erreur de décodage (JSON illisible, message trop gros) déjà constatée par le transport. */
export function parseErrorResponse(error: unknown, ctx: Pick<MethodContext, 'm'>): JsonRpcResponse {
  return errorResponse(null, null, error, ctx);
}

export function parseError(): StriartError {
  return new StriartError('The message is not valid JSON.', {
    code: 'CONTROL_PARSE_ERROR',
    hint: 'Send one UTF-8 JSON-RPC 2.0 object (or a batch array) per message.',
  });
}

async function handleOne(message: unknown, ctx: MethodContext): Promise<JsonRpcResponse | null> {
  if (!isObject(message)) return errorResponse(null, null, invalidRequest('not an object'), ctx);
  const hasId = Object.hasOwn(message, 'id');
  const id = hasId && validId(message.id) ? message.id : null;
  if (hasId && !validId(message.id))
    return errorResponse(
      null,
      null,
      invalidRequest('"id" must be a string, a safe integer or null'),
      ctx,
    );
  if (message.jsonrpc !== '2.0')
    return errorResponse(id, null, invalidRequest('"jsonrpc" must be "2.0"'), ctx);
  if (
    typeof message.method !== 'string' ||
    message.method.length === 0 ||
    message.method.length > 100
  )
    return errorResponse(id, null, invalidRequest('"method" must be a non-empty string'), ctx);

  const method = message.method;
  const respond = (response: JsonRpcResponse): JsonRpcResponse | null => (hasId ? response : null);
  const spec = methodSpec(method);
  if (!spec) {
    return respond(
      errorResponse(
        id,
        method,
        new StriartError(`Unknown Striart Control Protocol method "${method}".`, {
          code: 'CONTROL_METHOD_UNKNOWN',
          details: { method },
          hint: 'Call rpc.discover for the list of methods.',
        }),
        ctx,
      ),
    );
  }
  if (!spec.transports.includes(ctx.transport)) {
    return respond(
      errorResponse(
        id,
        method,
        new StriartError(`Method "${method}" is not served over ${ctx.transport}.`, {
          code: 'CONTROL_METHOD_UNAVAILABLE',
          details: { method, transport: ctx.transport },
          hint:
            ctx.transport === 'http' ? 'Subscribe with GET /events (Server-Sent Events).' : null,
        }),
        ctx,
      ),
    );
  }

  const params = message.params === undefined ? {} : message.params;
  if (!isObject(params)) {
    return respond(
      errorResponse(
        id,
        method,
        new StriartError(`"params" of "${method}" must be an object (named parameters).`, {
          code: 'INVALID_ARGUMENT',
          details: { method, param: 'params' },
        }),
        ctx,
      ),
    );
  }
  const problem = validate(paramsSchema(spec), params, 'params');
  if (problem) {
    return respond(
      errorResponse(
        id,
        method,
        new StriartError(`Invalid parameter ${problem.path} for "${method}": ${problem.message}.`, {
          code: problem.errorCode ?? 'INVALID_ARGUMENT',
          // Jamais la valeur fautive (un prompt, un secret collé par erreur).
          details: { method, param: problem.path, keyword: problem.keyword },
          hint: 'Call rpc.discover for the parameter schemas.',
        }),
        ctx,
      ),
    );
  }

  try {
    const output = await HANDLERS[method](ctx, params);
    const response: JsonRpcResponse = {
      jsonrpc: '2.0',
      id,
      result: successDocument(method, output.data, {
        outcome: output.outcome ?? 'ok',
        warnings: output.warnings,
      }),
    };
    if (output.afterResponse) {
      // Une notification (sans id) n'a pas de réponse à écrire : l'action
      // différée (activation d'abonnement) s'exécute tout de suite, sinon
      // elle ne le serait jamais.
      if (hasId) pendingAfter.set(response, output.afterResponse);
      else output.afterResponse();
    }
    return respond(response);
  } catch (error) {
    return respond(errorResponse(id, method, error, ctx));
  }
}

/**
 * Actions à exécuter une fois la réponse écrite (activation d'abonnement) :
 * le transport appelle `afterWrite(response)` juste après l'écriture.
 */
const pendingAfter = new WeakMap<object, () => void>();

export function afterWrite(response: JsonRpcResponse | JsonRpcResponse[] | null): void {
  const all = response === null ? [] : Array.isArray(response) ? response : [response];
  for (const r of all) {
    const callback = pendingAfter.get(r);
    if (callback) {
      pendingAfter.delete(r);
      callback();
    }
  }
}

/**
 * Traite un message décodé : requête, notification ou lot. Les éléments
 * d'un lot s'exécutent DANS L'ORDRE (des actions mutantes successives ne se
 * doublent jamais).
 */
export async function handleMessage(
  message: unknown,
  ctx: MethodContext,
): Promise<JsonRpcResponse | JsonRpcResponse[] | null> {
  if (!Array.isArray(message)) return handleOne(message, ctx);
  if (message.length === 0) return errorResponse(null, null, invalidRequest('empty batch'), ctx);
  if (message.length > MAX_BATCH)
    return errorResponse(null, null, invalidRequest(`batch larger than ${MAX_BATCH} calls`), ctx);
  const responses: JsonRpcResponse[] = [];
  for (const item of message) {
    const response = await handleOne(item, ctx);
    if (response) responses.push(response);
  }
  return responses.length > 0 ? responses : null;
}

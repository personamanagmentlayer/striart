/** Erreurs typées de la couche protocole : jamais de chaîne nue, toujours un code stable. */

export class ProtocolError extends Error {
  readonly code: string;
  constructor(code: string, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'ProtocolError';
    this.code = code;
  }
}

/** Erreur renvoyée par le serveur Striart (document d'erreur du contrat `--json`). */
export class RpcError extends Error {
  readonly code: string;
  readonly kind: 'usage' | 'refusal' | 'failure';
  readonly hint: string | null;
  readonly details: Record<string, unknown>;
  readonly rpcCode: number;
  readonly method: string;
  constructor(init: {
    method: string;
    rpcCode: number;
    code: string;
    kind: 'usage' | 'refusal' | 'failure';
    message: string;
    hint: string | null;
    details: Record<string, unknown>;
  }) {
    super(init.message);
    this.name = 'RpcError';
    this.method = init.method;
    this.rpcCode = init.rpcCode;
    this.code = init.code;
    this.kind = init.kind;
    this.hint = init.hint;
    this.details = init.details;
  }
}

/** La connexion s'est coupée (ou n'existe pas) pendant/avant l'appel. */
export class ConnectionLostError extends Error {
  readonly code = 'CONNECTION_LOST';
  constructor(message: string) {
    super(message);
    this.name = 'ConnectionLostError';
  }
}

/** Délai local dépassé : l'opération peut TOUTEFOIS s'être exécutée côté serveur. */
export class RequestTimeoutError extends Error {
  readonly code = 'REQUEST_TIMEOUT';
  readonly method: string;
  readonly timeoutMs: number;
  constructor(method: string, timeoutMs: number) {
    super(`No answer to ${method} within ${Math.round(timeoutMs / 1000)} s`);
    this.name = 'RequestTimeoutError';
    this.method = method;
    this.timeoutMs = timeoutMs;
  }
}

/** Lancement du binaire impossible (introuvable, chemin refusé, shim non spawnable). */
export class BinaryError extends Error {
  readonly code: 'BINARY_NOT_FOUND' | 'BINARY_RELATIVE' | 'BINARY_UNSUPPORTED_SHIM' | 'BINARY_INVALID';
  constructor(code: BinaryError['code'], message: string) {
    super(message);
    this.name = 'BinaryError';
    this.code = code;
  }
}

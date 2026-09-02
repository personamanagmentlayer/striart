/**
 * Erreur métier Striart.
 * `code` est machine-readable (ex: NOT_A_GIT_REPO, AGENT_EXISTS),
 * `details` porte le contexte utile au debug.
 */
export class StriartError extends Error {
  constructor(message, { code = 'STRIART_ERROR', details = {} } = {}) {
    super(message);
    this.name = 'StriartError';
    this.code = code;
    this.details = details;
  }
}

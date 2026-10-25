import path from 'node:path';
import { striartDir } from './paths.js';
import { readJson, updateJsonLocked } from './json-file.js';

/** Règle d'or n°4 : 3 fusions sémantiques échouées d'affilée → mode manuel. */
export const MAX_SEMANTIC_FAILURES = 3;

const DEFAULT_STATE = { semanticFailureStreak: 0, manualMode: false };

function statePath(root) {
  return path.join(striartDir(root), 'state.json');
}

/** @param {string} root @returns {Promise<import('./types.js').StriartState>} */
export async function readState(root) {
  const stored = await readJson(statePath(root), { fallback: {}, code: 'STATE_CORRUPT' });
  return { ...DEFAULT_STATE, ...stored };
}

/**
 * Lecture-modification-écriture de state.json sous le verrou d'état : deux
 * échecs sémantiques concurrents comptent pour deux, et un `--unlock` humain
 * n'est jamais écrasé par un compteur lu avant lui.
 * @param {string} root
 * @param {(state: import('./types.js').StriartState) => import('./types.js').StriartState} mutator
 * @returns {Promise<import('./types.js').StriartState>}
 */
async function updateState(root, mutator) {
  /** @type {Partial<import('./types.js').StriartState>} */
  const fallback = {};
  const written = await updateJsonLocked(
    statePath(root),
    { fallback, code: 'STATE_CORRUPT' },
    (stored) => mutator({ ...DEFAULT_STATE, ...stored }),
  );
  return { ...DEFAULT_STATE, ...written };
}

/** @param {string} root @returns {Promise<import('./types.js').StriartState>} */
export async function recordSemanticFailure(root) {
  return updateState(root, (state) => {
    const semanticFailureStreak = state.semanticFailureStreak + 1;
    return {
      ...state,
      semanticFailureStreak,
      manualMode: state.manualMode || semanticFailureStreak >= MAX_SEMANTIC_FAILURES,
    };
  });
}

/** @param {string} root @returns {Promise<import('./types.js').StriartState>} */
export async function recordSemanticSuccess(root) {
  return updateState(root, (state) => ({ ...state, semanticFailureStreak: 0 }));
}

/** Réactivation humaine de la fusion sémantique (striart resolve --unlock). */
export async function resetManualMode(root) {
  return updateState(root, () => ({ ...DEFAULT_STATE }));
}

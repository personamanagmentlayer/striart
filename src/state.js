import path from 'node:path';
import { striartDir } from './clone.js';
import { readJson, writeJsonAtomic } from './json-file.js';

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

/** @param {string} root @returns {Promise<import('./types.js').StriartState>} */
export async function recordSemanticFailure(root) {
  const state = await readState(root);
  state.semanticFailureStreak += 1;
  if (state.semanticFailureStreak >= MAX_SEMANTIC_FAILURES) state.manualMode = true;
  await writeJsonAtomic(statePath(root), state);
  return state;
}

export async function recordSemanticSuccess(root) {
  const state = await readState(root);
  state.semanticFailureStreak = 0;
  await writeJsonAtomic(statePath(root), state);
  return state;
}

/** Réactivation humaine de la fusion sémantique (striart resolve --unlock). */
export async function resetManualMode(root) {
  const state = { ...DEFAULT_STATE };
  await writeJsonAtomic(statePath(root), state);
  return state;
}

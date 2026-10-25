/**
 * Setup du projet vitest `unit` : aucun test unitaire n'écrit sous le
 * `.striart/` du dépôt de développement (voir hermetic-striart.js).
 */
import { afterAll, beforeAll } from 'vitest';
import { fileURLToPath } from 'node:url';
import { diffSnapshots, snapshotUsageTree } from './hermetic-striart.js';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));

/** @type {Map<string, string>} */
let before = new Map();

beforeAll(async () => {
  before = await snapshotUsageTree(REPO_ROOT);
});

afterAll(async () => {
  const touched = diffSnapshots(before, await snapshotUsageTree(REPO_ROOT));
  if (touched.length > 0) {
    throw new Error(
      `Un test unitaire a écrit sous le .striart/usage du dépôt de développement (${touched.join(', ')}). ` +
        'Passe une racine temporaire explicite (root) à llmGenerate/predictFiles/semanticMerge ' +
        'ou range le test dans tests/integration/.',
    );
  }
});

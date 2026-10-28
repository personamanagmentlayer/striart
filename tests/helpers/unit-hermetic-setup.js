/**
 * Setup du projet vitest `unit` : aucun test unitaire n'écrit sous le
 * `.striart/` du dépôt de développement (voir hermetic-striart.js).
 */
import { afterAll, beforeAll } from 'vitest';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import { diffSnapshots, snapshotUsageTree } from './hermetic-striart.js';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));

// Hermétique aussi vis-à-vis de la config UTILISATEUR de la machine (réseau : proxy, hôtes
// autorisés, offline…) : un dossier inexistant = défauts. Un test qui en veut une la fournit.
process.env.STRIART_CONFIG_HOME = path.join(os.tmpdir(), 'striart-unit-no-user-config');

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

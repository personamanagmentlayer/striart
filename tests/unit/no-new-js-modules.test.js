/**
 * Règle AGENTS.md : « nouveau code en .ts ». Les modules JS+JSDoc historiques
 * sont listés ici ; tout NOUVEAU module `.js` dans `src/` fait échouer ce test
 * (revue du noyau K-M13 : sept modules neufs avaient été écrits en .js).
 * Migrer un module historique en .ts retire son entrée de la liste.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = fileURLToPath(new URL('../../src/', import.meta.url));

/** Modules JS historiques (JSDoc vérifié par tsc --checkJs), chemins relatifs à src/. */
const LEGACY_JS = new Set([
  'acp/host-entry.js',
  'cli.js',
  'clone.js',
  'config.js',
  'conflicts.js',
  'daemon.js',
  'dashboard.js',
  'doctor.js',
  'errors.js',
  'events.js',
  'gate.js',
  'history.js',
  'imports.js',
  'init.js',
  'json-file.js',
  'llm.js',
  'lock.js',
  'locks.js',
  'logger.js',
  'main-session.js',
  'mcp.js',
  'memory.js',
  'merger.js',
  'notify.js',
  'ollama.js',
  'orchestrator.js',
  'paths.js',
  'process-tree.js',
  'prune.js',
  'queue.js',
  'router.js',
  'session.js',
  'state.js',
  'sync.js',
  'terminal.js',
  'watcher.js',
  'workspaces.js',
]);

function jsFiles(dir, prefix = '') {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? jsFiles(path.join(dir, entry.name), `${prefix}${entry.name}/`)
      : entry.name.endsWith('.js')
        ? [`${prefix}${entry.name}`]
        : [],
  );
}

describe('nouveau code en TypeScript', () => {
  it('aucun module .js hors de la liste historique', () => {
    const unexpected = jsFiles(SRC).filter((file) => !LEGACY_JS.has(file));
    expect(unexpected).toEqual([]);
  });
});

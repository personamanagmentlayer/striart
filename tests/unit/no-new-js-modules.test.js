/**
 * Règle AGENTS.md : « nouveau code en .ts ». Les modules JS+JSDoc historiques
 * sont listés ici ; tout NOUVEAU module `.js` dans `src/` fait échouer ce test
 * (revue du noyau K-M13 : sept modules neufs avaient été écrits en .js).
 * Migrer un module historique en .ts retire son entrée de la liste — SAUF
 * `cli.js` et `acp/host-entry.js` : plusieurs modules (`acp.ts`,
 * `hooks/install.ts`, `pty-host.ts`, `watch-ui.ts`, `daemon.ts`, `acp/host.ts`,
 * et les tests d'intégration qui lancent la CLI en sous-process) retrouvent
 * ces deux fichiers par un chemin construit à l'exécution
 * (`new URL('./cli.js', import.meta.url)`), jamais réécrit par le pack
 * (scripts/pack.ts : « .ts construit à l'exécution », PACK_UNREWRITTEN_TS) ;
 * `package.json`’s `bin` cible aussi `cli.js` sans réécriture à la publication
 * (« bin inchangé »). Ces deux noms doivent donc rester `.js` à demeure,
 * identiques en dev et une fois publiés — vérifié par un essai réel de
 * `scripts/pack.ts --ephemeral-signing-key` avant d'écarter la migration.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = fileURLToPath(new URL('../../src/', import.meta.url));

/** Modules JS historiques (JSDoc vérifié par tsc --checkJs), chemins relatifs à src/. */
const LEGACY_JS = new Set(['acp/host-entry.js', 'cli.js']);

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

#!/usr/bin/env node
/**
 * Point d'entrée stable de la CLI : cible de `bin` dans package.json et des
 * lanceurs internes (daemon.js, pty-host.ts, watch-ui.ts, l'onglet --open),
 * qui visent tous ce chemin. Toute la CLI vit dans src/cli/ (voir
 * src/cli/main.ts) ; ce fichier n'a qu'un rôle : activer le cache de
 * compilation de Node avant de charger quoi que ce soit, puis déléguer.
 */
import module from 'node:module';

// Cache de compilation V8 sur disque (Node >= 22.1) : les lancements
// suivants évitent de recompiler les modules. Best-effort : sans cache
// disponible (dossier en lecture seule…), la CLI fonctionne à l'identique.
module.enableCompileCache?.();

const { main } = await import('./cli/main.ts');
await main();

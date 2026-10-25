// Chargé par `node --import` dans les tests du graphe d'imports de la CLI :
// enregistre chaque module résolu, puis écrit la liste dans le fichier
// désigné par STRIART_IMPORT_LOG à la sortie du process. Hook synchrone
// (module.registerHooks) : déterministe, indépendant de la vitesse de la
// machine — à préférer à un budget en millisecondes.
import { writeFileSync } from 'node:fs';
import module from 'node:module';

const loaded = new Set();
module.registerHooks({
  resolve(specifier, context, nextResolve) {
    const result = nextResolve(specifier, context);
    loaded.add(result.url);
    return result;
  },
});
process.on('exit', () => {
  if (process.env.STRIART_IMPORT_LOG) {
    writeFileSync(process.env.STRIART_IMPORT_LOG, JSON.stringify([...loaded]));
  }
});

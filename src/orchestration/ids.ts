/**
 * Formes des identifiants d'orchestration — sans aucune dépendance lourde
 * (ni git, ni pino, ni execa) : importé par `src/cli/parse.ts` pour valider
 * `--run <run-id>` avant que la commande elle-même ne soit chargée. Importer
 * `store.ts` depuis `parse.ts` pour ce seul regex chargerait process-tree.ts
 * et private-fs.ts (donc execa) au démarrage de la CLI, pour `--help` compris.
 */
export const RUN_ID_RE = /^run-[0-9a-f]{12}$/;

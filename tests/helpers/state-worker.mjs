/**
 * Écrivain / lecteur de fichiers d'état dans un AUTRE process, pour les tests
 * de concurrence inter-process (tests/integration/state-files.test.js).
 *
 *   node state-worker.mjs <mode> <cible> <id> <itérations>
 *
 * Modes :
 *  - `write`   : writeJsonAtomic(<cible>) d'un objet volumineux ;
 *  - `read`    : JSON.parse(readFile(<cible>)) — erreur de lecture OU de
 *                parse comptée (un lecteur ne doit jamais voir un JSON
 *                tronqué ni rater le fichier) ;
 *  - `readJson`: readJson(<cible>) (avec ses nouvelles tentatives) ;
 *  - `enqueue` : <cible> = racine du repo ; enqueueTask(<id>-<i>) ;
 *  - `meta`    : <cible> = racine ; updateAgentMeta(<id>, {counter: i}).
 * Écrit en fin `RESULT <json>` : `{errors: {code: n}, done: n}`.
 */
import { readFile } from 'node:fs/promises';
import { readJson, writeJsonAtomic } from '../../src/json-file.ts';
import { enqueueTask } from '../../src/queue.ts';
import { updateAgentMeta } from '../../src/clone.ts';

const [mode, target, id, iterationsArg] = process.argv.slice(2);
const iterations = Number(iterationsArg);
const pad = 'x'.repeat(Number(process.env.STATE_WORKER_PAD ?? 200_000));
/** @type {Record<string, number>} */
const errors = {};
let done = 0;

for (let i = 0; i < iterations; i += 1) {
  try {
    if (mode === 'write') await writeJsonAtomic(target, { id, i, pad });
    else if (mode === 'read') JSON.parse(await readFile(target, 'utf8'));
    else if (mode === 'readJson') await readJson(target, { fallback: null, code: 'X_CORRUPT' });
    else if (mode === 'enqueue') {
      await enqueueTask(target, {
        agent: `${id}-${i}`,
        prompt: 'p',
        predictedFiles: [],
        collisions: [],
      });
    } else if (mode === 'meta') await updateAgentMeta(target, id, { counter: i + 1 });
    else throw new Error(`mode inconnu : ${mode}`);
    done += 1;
  } catch (error) {
    const code = error?.code ?? (error instanceof SyntaxError ? 'PARSE' : 'OTHER');
    errors[code] = (errors[code] ?? 0) + 1;
  }
}
process.stdout.write(`RESULT ${JSON.stringify({ errors, done })}\n`);

#!/usr/bin/env node
/**
 * Point d'entrée du process HÔTE de session ACP (lancé détaché par
 * `launchAcpHost`, src/acp/host.ts — jamais par un humain). Fichier `.js`
 * à chemin stable : `host.ts` le vise par `new URL('./host-entry.js')`,
 * chemin que la publication n'a pas à réécrire (aucun `.ts` construit à
 * l'exécution, PACK_UNREWRITTEN_TS). Sa ligne de commande
 * (`host-entry.js acp-host --agent <agent> …`) est aussi l'identité vérifiée
 * par `acpHostStatus` avant toute décision destructive.
 *
 * La spécification de session arrive sur stdin (une ligne JSON) — jamais en
 * argv ni sur disque : `profile.env` peut porter des clés d'API, visibles
 * par tout compte local dans la liste des process si elles passaient en
 * argument.
 */
import module from 'node:module';

module.enableCompileCache?.();

const MAX_SPEC_BYTES = 8_000_000;

async function readSpec() {
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > MAX_SPEC_BYTES) throw new Error('session spec too large');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

const { logger } = await import('../logger.ts');
try {
  const agentIndex = process.argv.indexOf('--agent');
  const spec = await readSpec();
  if (process.argv[2] !== 'acp-host' || spec?.agent !== process.argv[agentIndex + 1]) {
    throw new Error('host spec does not match the command line');
  }
  const { runAcpHost } = await import('./host-run.ts');
  await runAcpHost(spec);
  process.exitCode = 0;
} catch (error) {
  logger.error({ err: error }, 'Hôte de session ACP : arrêt sur erreur');
  process.exitCode = 1;
}
// La session est close, l'agent mort, le canal fermé : rien ne doit garder
// ce process en vie (handles résiduels d'un adaptateur, timers).
setTimeout(() => process.exit(process.exitCode ?? 0), 200).unref();

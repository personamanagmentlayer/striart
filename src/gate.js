import { execa } from 'execa';
import { killProcessTree, normalizeExitCode } from './process-tree.js';

/**
 * Test Gate : exécute la commande de test du projet dans `cwd`.
 * Retourne { success, exitCode, log, timedOut } — ne throw jamais pour un
 * échec de tests, seul l'orchestrateur décide de la suite.
 * Règle d'or n°2 : jamais de commit si success === false.
 *
 * `timeoutMs` : un test qui bloque indéfiniment gèlerait toute la chaîne
 * de merges — au-delà du délai, l'arbre de process est tué et le gate est rouge.
 */
/** @param {{cwd: string, testCommand: string, timeoutMs?: number}} p @returns {Promise<import('./types.js').GateResult>} */
export async function runTestGate({ cwd, testCommand, timeoutMs = 600_000 }) {
  const subprocess = execa(testCommand, {
    cwd,
    shell: true, // 'npm test' est npm.cmd sous Windows : le shell gère la résolution
    all: true,
    reject: false,
    detached: process.platform !== 'win32', // POSIX : groupe de process tuable d'un bloc
  });

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    void killProcessTree(subprocess);
  }, timeoutMs);

  const result = await subprocess;
  clearTimeout(timer);

  return {
    success: result.exitCode === 0 && !timedOut,
    // Windows rend les codes en uint32 : « exit 4294963238 » dans un ticket
    // est le même fait que « exit -4058 », en illisible.
    exitCode: normalizeExitCode(result.exitCode),
    timedOut,
    log: timedOut
      ? `${result.all ?? ''}\n[Striart] Test Gate interrompu : délai de ${timeoutMs}ms dépassé.`
      : (result.all ?? ''),
  };
}

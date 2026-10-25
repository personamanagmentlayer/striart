import { execa } from 'execa';
import { StriartError } from './errors.js';
import { killProcessTree, normalizeExitCode } from './process-tree.js';
import { assertJobComplete, startNativeJob } from './native.ts';

/** Rouge « l'exécution elle-même est en cause » (voir `GateFailureCode`). */
const GATE_NATIVE_UNAVAILABLE = /** @type {import('./types.js').GateFailureCode} */ (
  'GATE_NATIVE_UNAVAILABLE'
);

/** Délai de grâce par défaut des descendants du test (voir `gateOrphanGraceMs`). */
export const DEFAULT_GATE_ORPHAN_GRACE_MS = 2_000;
/** Plafond par défaut du journal conservé : 100 Mio (voir `gateMaxOutputBytes`). */
export const DEFAULT_GATE_MAX_OUTPUT_BYTES = 100 * 1024 * 1024;

/**
 * Conserve la FIN d'un flux d'octets dans une mémoire bornée : les derniers
 * `maxBytes` octets reçus (l'échec d'un test se lit en fin de sortie). Le
 * reste est écarté au fil de l'eau — la sortie d'un test qui boucle ne peut
 * pas faire grossir le process Striart sans borne.
 */
export class TailBuffer {
  /** @param {number} maxBytes */
  constructor(maxBytes) {
    this.maxBytes = maxBytes;
    /** @type {Buffer[]} */
    this.chunks = [];
    this.bytes = 0;
    this.dropped = 0;
  }

  /** @param {Buffer|string} chunk */
  push(chunk) {
    const data = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
    this.chunks.push(data);
    this.bytes += data.length;
    while (this.bytes > this.maxBytes && this.chunks.length > 0) {
      const excess = this.bytes - this.maxBytes;
      const head = /** @type {Buffer} */ (this.chunks[0]);
      if (head.length <= excess) {
        this.chunks.shift();
        this.bytes -= head.length;
        this.dropped += head.length;
      } else {
        this.chunks[0] = head.subarray(excess);
        this.bytes -= excess;
        this.dropped += excess;
      }
    }
  }

  get truncated() {
    return this.dropped > 0;
  }

  toString() {
    return Buffer.concat(this.chunks).toString('utf8');
  }
}

/**
 * Commande de shell du gate, sous la forme d'un argv (`shell: false` côté
 * natif) : `npm test` est `npm.cmd` sous Windows, le shell en gère la
 * résolution. Mêmes conventions qu'`execa({shell: true})`.
 * @param {string} testCommand
 * @param {NodeJS.Platform} [platform]
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{argv: string[], windowsVerbatimArguments: boolean}}
 */
export function gateShellArgv(testCommand, platform = process.platform, env = process.env) {
  if (platform === 'win32') {
    return {
      argv: [env.ComSpec || 'cmd.exe', '/d', '/s', '/c', `"${testCommand}"`],
      windowsVerbatimArguments: true,
    };
  }
  return { argv: ['/bin/sh', '-c', testCommand], windowsVerbatimArguments: false };
}

/**
 * Test Gate : exécute la commande de test du projet dans `cwd`.
 * Retourne { success, exitCode, log, timedOut } — ne throw jamais pour un
 * échec de tests, seul l'orchestrateur décide de la suite.
 * Règle d'or n°2 : jamais de commit si success === false.
 *
 * `timeoutMs` : un test qui bloque indéfiniment gèlerait toute la chaîne
 * de merges — au-delà du délai, l'arbre de process est tué et le gate est rouge.
 *
 * Conteneur natif (défaut, `container: 'native'`) : la commande tourne dans
 * un Job Object / groupe de process (`striart-native job run`). Après sa
 * sortie, ses descendants ont `orphanGraceMs` pour finir seuls ; ceux qui
 * vivent encore sont tués ET le gate est ROUGE (`GATE_ORPHAN_PROCESS`), même
 * si la commande a rendu 0 : un orphelin qui tient la sortie est un test qui
 * fuit, pas un succès. Tout ce qui empêche d'établir « plus rien ne vit »
 * (nettoyage incomplet, interruption, binaire natif indisponible) est un
 * rouge nommé — fail closed, jamais un vert par défaut.
 *
 * `container: 'process'` : relâchement explicite et opt-in (config
 * `gateContainer`) — pas de détection d'orphelins.
 *
 * @param {{
 *   cwd: string,
 *   testCommand: string,
 *   timeoutMs?: number,
 *   orphanGraceMs?: number,
 *   maxOutputBytes?: number,
 *   container?: 'native'|'process',
 * }} p
 * @returns {Promise<import('./types.js').GateResult>}
 */
export async function runTestGate({
  cwd,
  testCommand,
  timeoutMs = 600_000,
  orphanGraceMs = DEFAULT_GATE_ORPHAN_GRACE_MS,
  maxOutputBytes = DEFAULT_GATE_MAX_OUTPUT_BYTES,
  container = 'native',
}) {
  if (container === 'process') {
    return runInPlainProcess({ cwd, testCommand, timeoutMs, maxOutputBytes });
  }
  return runInNativeContainer({ cwd, testCommand, timeoutMs, orphanGraceMs, maxOutputBytes });
}

/** Le journal à rendre : la fin de la sortie, annoncée comme telle si coupée. */
function composeLog(tail, extra = []) {
  const head = tail.truncated
    ? `[Striart] Sortie tronquée : seuls les ${tail.bytes} derniers octets sont conservés (${tail.dropped} écartés).\n`
    : '';
  return [head + tail.toString(), ...extra].join('\n');
}

/**
 * Consomme un flux jusqu'à sa fin dans un TailBuffer. Ne lève pas : une
 * erreur de flux (tube cassé à la mort du process) termine simplement la
 * collecte.
 * @param {AsyncIterable<Buffer|string>|undefined|null} stream
 * @param {TailBuffer} tail
 */
async function collect(stream, tail) {
  if (!stream) return;
  try {
    for await (const chunk of stream) tail.push(chunk);
  } catch {
    // Flux fermé brutalement : ce qui a été reçu est conservé.
  }
}

async function runInNativeContainer({
  cwd,
  testCommand,
  timeoutMs,
  orphanGraceMs,
  maxOutputBytes,
}) {
  const { argv, windowsVerbatimArguments } = gateShellArgv(testCommand);
  let job;
  try {
    job = await startNativeJob({
      argv,
      cwd,
      graceMs: orphanGraceMs,
      timeoutMs,
      windowsVerbatimArguments,
      all: true,
      buffer: false,
    });
  } catch (error) {
    // Binaire natif indisponible ou non vérifié : pas de Test Gate sans
    // conteneur (fail closed). `gateContainer: 'process'` est l'échappatoire
    // explicite.
    const code = error instanceof StriartError ? error.code : 'NATIVE_UNAVAILABLE';
    return {
      success: false,
      exitCode: undefined,
      timedOut: false,
      code: GATE_NATIVE_UNAVAILABLE,
      log: `[Striart] Test Gate non exécuté : le conteneur de process natif est indisponible (${code}) — ${error?.message ?? String(error)}\n${
        error?.hint ? `Piste : ${error.hint}\n` : ''
      }Relâchement explicite possible : gateContainer: 'process' dans la config.`,
    };
  }

  const tail = new TailBuffer(maxOutputBytes);
  const collected = collect(job.subprocess.all, tail);
  const subprocessResult = await job.subprocess;
  // Le rapport est lu une fois le process natif sorti ; les flux sont vidés
  // avant de composer le journal (aucune sortie perdue).
  await collected;
  let report;
  try {
    report = await job.report;
  } catch (error) {
    return {
      success: false,
      exitCode: undefined,
      timedOut: false,
      code: GATE_NATIVE_UNAVAILABLE,
      truncated: tail.truncated || undefined,
      log: composeLog(tail, [
        `[Striart] Test Gate : rapport du conteneur natif inexploitable — ${error?.message ?? String(error)}`,
      ]),
    };
  }

  const exitCode = normalizeExitCode(report.exitCode ?? undefined);
  const timedOut = report.timedOut;
  /** @type {string[]} */
  const notes = [];
  /** @type {import('./types.js').GateFailureCode|undefined} */
  let code;
  if (timedOut) {
    notes.push(`[Striart] Test Gate interrompu : délai de ${timeoutMs}ms dépassé.`);
  }
  if (report.signal) {
    notes.push(`[Striart] La commande de test a été tuée par le signal ${report.signal}.`);
  }
  if (report.interrupted) {
    code = 'GATE_INTERRUPTED';
    notes.push(`[Striart] Test Gate interrompu (${report.interrupted}) : exécution abandonnée.`);
  }
  if (!report.complete) {
    try {
      assertJobComplete(report);
    } catch (error) {
      code = 'JOB_TERMINATE_INCOMPLETE';
      notes.push(`[Striart] ${error.message}`);
    }
  }
  const orphanPids = report.orphanPids;
  if (!timedOut && !report.interrupted && orphanPids.length > 0) {
    code ??= 'GATE_ORPHAN_PROCESS';
    notes.push(
      `[Striart] GATE_ORPHAN_PROCESS : ${orphanPids.length} process descendant(s) du test vivai(en)t encore ${orphanGraceMs}ms après sa sortie (PID ${orphanPids.slice(0, 8).join(', ')}) — tués. ` +
        `Un test qui laisse un process derrière lui fuit : le gate est rouge même si la commande a rendu ${exitCode ?? '?'}.`,
    );
  }
  const success =
    exitCode === 0 &&
    !timedOut &&
    !report.interrupted &&
    report.complete &&
    orphanPids.length === 0;
  // Sortie 0 mais flux de sortie du process natif en échec : jamais vert sur un
  // process natif qui lui-même a mal fini.
  if (success && subprocessResult.exitCode !== 0) {
    return {
      success: false,
      exitCode,
      timedOut,
      code: GATE_NATIVE_UNAVAILABLE,
      truncated: tail.truncated || undefined,
      log: composeLog(tail, [
        `[Striart] Test Gate : le conteneur natif s'est terminé en échec (sortie ${subprocessResult.exitCode}).`,
      ]),
    };
  }
  return {
    success,
    exitCode,
    timedOut,
    ...(code ? { code } : {}),
    ...(orphanPids.length > 0 ? { orphanPids } : {}),
    ...(tail.truncated ? { truncated: true } : {}),
    log: composeLog(tail, notes),
  };
}

async function runInPlainProcess({ cwd, testCommand, timeoutMs, maxOutputBytes }) {
  const subprocess = execa(testCommand, {
    cwd,
    shell: true, // 'npm test' est npm.cmd sous Windows : le shell gère la résolution
    all: true,
    buffer: false,
    reject: false,
    detached: process.platform !== 'win32', // POSIX : groupe de process tuable d'un bloc
  });
  const tail = new TailBuffer(maxOutputBytes);
  const collected = collect(subprocess.all, tail);

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    void killProcessTree(subprocess);
  }, timeoutMs);

  const result = await subprocess;
  clearTimeout(timer);
  await collected;

  return {
    success: result.exitCode === 0 && !timedOut,
    // Windows rend les codes en uint32 : « exit 4294963238 » dans un ticket
    // est le même fait que « exit -4058 », en illisible.
    exitCode: normalizeExitCode(result.exitCode),
    timedOut,
    ...(tail.truncated ? { truncated: true } : {}),
    log: composeLog(
      tail,
      timedOut ? [`[Striart] Test Gate interrompu : délai de ${timeoutMs}ms dépassé.`] : [],
    ),
  };
}

import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import {
  DEFAULT_LOG_GENERATIONS,
  DEFAULT_LOG_MAX_BYTES,
  createRotatingFileSink,
  isValidRotation,
} from './log-rotation.ts';

/**
 * Journal de diagnostic de Striart (pino).
 *
 * Contrat de flux : les logs ne vont JAMAIS sur stdout. stdout porte les
 * données d'une commande (résultat humain, document `--json`, protocole MCP)
 * et la moindre ligne de log le corromprait — c'était le cas avant la 0.11
 * hors terminal (pino écrivait sur stdout dès que ce n'était pas un TTY).
 * Destination : stderr (fd 2) par défaut, ou un fichier quand l'écran est
 * occupé par une interface (`watch --ui`, voir configureLogger).
 *
 * Chargement paresseux : pino (et pino-pretty) ne sont chargés qu'au premier
 * log émis. `striart --help`, `--version` ou une erreur d'usage ne les paient
 * jamais.
 *
 * Variables d'environnement :
 *  - STRIART_LOG_LEVEL : trace|debug|info|warn|error|fatal|silent (défaut info).
 *  - STRIART_LOG_STDERR : historique (<= 0.10, forçait stderr) — sans effet,
 *    stderr est désormais la destination par défaut.
 *  - STRIART_LOG_FILE (+ STRIART_LOG_MAX_BYTES, STRIART_LOG_GENERATIONS) :
 *    posées par daemon.js pour le process DÉTACHÉ qu'il lance (watch,
 *    dashboard). Le journal du daemon devient un fichier à ROTATION par
 *    taille (log-rotation.js), qui reçoit les logs ET tout ce que le process
 *    écrit sur stdout/stderr. Lues puis RETIRÉES de l'environnement à
 *    l'import : un process lancé par le daemon (session d'agent, serveur MCP
 *    dont stdout est le protocole) n'en hérite jamais.
 */

const requireCjs = createRequire(import.meta.url);

export const DAEMON_LOG_ENV = Object.freeze({
  file: 'STRIART_LOG_FILE',
  maxBytes: 'STRIART_LOG_MAX_BYTES',
  generations: 'STRIART_LOG_GENERATIONS',
});

/**
 * @typedef {{maxBytes: number, generations: number}} LogRotation
 * @typedef {{write: (chunk: string | Uint8Array) => void, close: () => void}} LogSink
 */

/** @type {{destination: 'stderr' | {file: string}, pretty: boolean | null, rotation: LogRotation, sink: LogSink | null}} */
const settings = {
  destination: 'stderr',
  pretty: null,
  rotation: { maxBytes: DEFAULT_LOG_MAX_BYTES, generations: DEFAULT_LOG_GENERATIONS },
  sink: null,
};

/** @type {import('pino').Logger | null} */
let instance = null;

/**
 * Règle la destination AVANT le premier log. Sans effet après : un logger
 * déjà créé garde sa destination (pas de bascule en cours de route qui
 * perdrait ou dupliquerait des lignes).
 * @param {{file?: string, pretty?: boolean, rotation?: LogRotation}} options
 *   `file` : chemin d'un fichier journal (ajout, rotation par taille) ;
 *   `pretty` : force (ou interdit) la mise en forme humaine, sinon décidée
 *   par `stderr.isTTY` ; `rotation` : `logMaxBytes`/`logGenerations` de la
 *   config (défauts sinon). Une rotation invalide est refusée (TypeError) :
 *   la config l'a déjà validée, une valeur fausse ici est un bug d'appelant.
 */
export function configureLogger({ file, pretty, rotation } = {}) {
  if (instance) return;
  if (rotation !== undefined) {
    if (!isValidRotation(rotation.maxBytes, rotation.generations)) {
      throw new TypeError('configureLogger: rotation invalide (logMaxBytes / logGenerations)');
    }
    settings.rotation = { maxBytes: rotation.maxBytes, generations: rotation.generations };
  }
  if (file) settings.destination = { file };
  if (pretty !== undefined) settings.pretty = pretty;
}

/**
 * Puits du fichier journal, créé une seule fois (dossier compris).
 * @param {string} file
 */
function fileSink(file) {
  if (!settings.sink) {
    mkdirSync(path.dirname(file), { recursive: true });
    settings.sink = createRotatingFileSink(file, settings.rotation);
  }
  return settings.sink;
}

/**
 * Mode daemon (voir l'en-tête) : variables lues puis retirées, puits ouvert,
 * stdout/stderr redirigés vers lui. Une écriture que Node fait sans passer
 * par `process.stdout`/`process.stderr` (erreur fatale du moteur) va encore
 * sur le descripteur hérité — le fichier ouvert au départ du daemon.
 */
function adoptDaemonLog() {
  const file = process.env[DAEMON_LOG_ENV.file];
  const maxBytes = Number(process.env[DAEMON_LOG_ENV.maxBytes]);
  const generations = Number(process.env[DAEMON_LOG_ENV.generations]);
  for (const name of Object.values(DAEMON_LOG_ENV)) delete process.env[name];
  if (!file || !path.isAbsolute(file)) return;
  if (isValidRotation(maxBytes, generations)) settings.rotation = { maxBytes, generations };
  settings.destination = { file };
  settings.pretty = false;
  const sink = fileSink(file);
  for (const stream of [process.stdout, process.stderr]) {
    /** @type {any} */ (stream).write = (
      /** @type {string | Uint8Array} */ chunk,
      /** @type {any} */ encoding,
      /** @type {any} */ callback,
    ) => {
      const done = typeof encoding === 'function' ? encoding : callback;
      try {
        sink.write(
          typeof chunk === 'string' && typeof encoding === 'string' && encoding !== 'utf8'
            ? Buffer.from(chunk, /** @type {BufferEncoding} */ (encoding))
            : chunk,
        );
      } catch (error) {
        if (typeof done === 'function') process.nextTick(done, error);
        return false;
      }
      if (typeof done === 'function') process.nextTick(done);
      return true;
    };
  }
}

if (process.env[DAEMON_LOG_ENV.file] !== undefined) adoptDaemonLog();

function create() {
  /** @type {typeof import('pino')} */
  const pino = requireCjs('pino');
  const level = process.env.STRIART_LOG_LEVEL ?? 'info';
  const toFile = typeof settings.destination === 'object';
  const pretty = settings.pretty ?? (!toFile && Boolean(process.stderr.isTTY));
  if (pretty) {
    // Mise en forme DANS le process (pas un worker de transport) : chaque
    // ligne passe par `writeToStderr`, qui laisse la CLI effacer une ligne
    // animée (spinner) avant qu'un log ne s'y colle.
    /** @type {typeof import('pino-pretty')} */
    const pinoPretty = requireCjs('pino-pretty');
    const stream = pinoPretty({
      colorize: Boolean(process.stderr.isTTY) && !process.env.NO_COLOR,
      translateTime: 'HH:MM:ss',
      ignore: 'pid,hostname',
      sync: true,
      destination: { write: writeToStderr },
    });
    return pino({ level, base: undefined }, stream);
  }
  if (!toFile) {
    return pino({ level, base: undefined }, { write: writeToStderr });
  }
  // Fichier à rotation par taille (log-rotation.js), écrit de façon
  // synchrone comme le ferait pino.destination.
  const sink = fileSink(/** @type {{file: string}} */ (settings.destination).file);
  // `base: undefined` : pas de pid/hostname dans chaque ligne — le nom
  // d'hôte n'a rien à faire dans un log qu'on colle dans un ticket.
  return pino({ level, base: undefined }, { write: (chunk) => sink.write(chunk) });
}

/** @type {(() => void) | null} */
let beforeStderrWrite = null;

/**
 * Appelé juste avant chaque ligne de log écrite sur stderr — la CLI s'en
 * sert pour effacer son spinner (sinon le log s'écrirait à sa suite, sur la
 * même ligne). Un seul abonné : la couche de sortie de la CLI.
 * @param {(() => void) | null} hook
 */
export function onBeforeLogWrite(hook) {
  beforeStderrWrite = hook;
}

/** @param {string} chunk */
function writeToStderr(chunk) {
  beforeStderrWrite?.();
  process.stderr.write(chunk);
}

function get() {
  instance ??= create();
  return instance;
}

/** @param {'trace'|'debug'|'info'|'warn'|'error'|'fatal'} level @returns {any} */
function forward(level) {
  return (/** @type {any[]} */ ...args) => /** @type {any} */ (get())[level](...args);
}

/**
 * Façade stable : les modules importent `logger` à l'évaluation, mais pino
 * n'est créé qu'au premier appel.
 * @type {Pick<import('pino').Logger, 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal'>}
 */
export const logger = {
  trace: forward('trace'),
  debug: forward('debug'),
  info: forward('info'),
  warn: forward('warn'),
  error: forward('error'),
  fatal: forward('fatal'),
};

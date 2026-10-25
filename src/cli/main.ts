/**
 * Noyau d'exécution de la CLI (couche L4) : environnement, sonde du
 * terminal, langue, signaux, analyse de la ligne de commande, rendu des
 * résultats et des erreurs, code de sortie. Les commandes ne font jamais
 * rien de tout cela elles-mêmes.
 *
 * Imports volontairement légers : rien ici ne charge git, pino, execa ni
 * cosmiconfig. Ils arrivent avec le module de la commande exécutée.
 */
import { access, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { CommanderError } from 'commander';
import type { Command } from 'commander';
import { StriartError, errorKindOf } from '../errors.js';
import type { ErrorKind } from '../errors.js';
import { logger, onBeforeLogWrite } from '../logger.js';
import { SCHEMA_VERSION, errorObject } from '../control/envelope.ts';
import { detectCapabilities } from './caps.ts';
import { assertHumanPlane } from '../control/guard.ts';
import { filterEnvFile, isAgentCloneRoot } from './env-file.ts';
import type { CommandModule, CommandResult, Ctx } from './context.ts';
import { EXIT, exitCodeForErrorKind, exitCodeForOutcome } from './exit.ts';
import { detectLocale, loadMessages } from './i18n/index.ts';
import type { Messages } from './i18n/index.ts';
import { Output } from './output.ts';
import { buildProgram } from './program.ts';
import { commandSpec } from './registry.ts';

/** Commandes longues : à l'arrêt demandé, elles se terminent proprement au lieu d'être coupées. */
// `mcp` : un merge lancé par un outil MCP tourne sous le verrou principal,
// Test Gate compris — le couper net laisserait le dépôt en état « merging ».
// Le serveur cesse de lire et attend la fin des opérations en vol.
// `acp` : une fin de session IDE merge sous Test Gate — même raison que `mcp` ;
// à l'arrêt, chaque session est close proprement (clone conservé, sans merge).
const GRACEFUL = new Set(['watch', 'dashboard', 'api', 'mcp', 'acp']);

/**
 * `run` supervise une session d'agent en mode autonome ou sur le principal :
 * couper la CLI laisserait l'agent vivre (groupe de process propre sous
 * POSIX) alors que sa session est dépubliée — les gardes SESSION_LIVE /
 * MAIN_SESSION_LIVE seraient désarmées sur un worktree encore en écriture.
 * Elle s'arrête donc proprement : signal → arbre de l'agent tué → dépublication.
 * `plan` (hors --dry-run) peut lancer les mêmes sessions autonomes : même
 * traitement — le mode de ses tâches n'est connu qu'à la lecture du fichier.
 */
export function isGraceful(name: string, input: unknown): boolean {
  if (GRACEFUL.has(name)) return true;
  // `orchestrate` (lot O) lance les mêmes sessions qu'un plan v2.
  if (name === 'plan' || name === 'orchestrate') {
    return (
      typeof input === 'object' && input !== null && (input as { dryRun?: unknown }).dryRun !== true
    );
  }
  if (name !== 'run' || typeof input !== 'object' || input === null) return false;
  const run = input as { onMain?: unknown; autonomous?: unknown };
  return run.onMain === true || run.autonomous === true;
}

/** Codes stables des erreurs d'usage détectées par commander (contrat `--json`). */
const COMMANDER_CODES: Record<string, string> = {
  'commander.unknownOption': 'UNKNOWN_OPTION',
  'commander.unknownCommand': 'UNKNOWN_COMMAND',
  'commander.missingArgument': 'MISSING_ARGUMENT',
  'commander.optionMissingArgument': 'MISSING_OPTION_VALUE',
  'commander.missingMandatoryOptionValue': 'MISSING_OPTION',
  'commander.excessArguments': 'EXCESS_ARGUMENTS',
  'commander.conflictingOption': 'OPTION_CONFLICT',
  'commander.invalidArgument': 'INVALID_ARGUMENT',
  'commander.help': 'MISSING_COMMAND',
};

/**
 * Options globales PRÉSUMÉES avant l'analyse, pour ce qui se rend avant
 * qu'une commande soit choisie (aide, erreur d'usage). Arguments avant `--`
 * seulement : au-delà, c'est de la donnée (un prompt peut contenir
 * « --json »). Ne voit pas qu'un argument est la VALEUR d'une option
 * (`--start --json`) : la décision pour la commande exécutée vient de
 * l'analyse de commander (voir `parsedGlobals`).
 */
function flagsOf(args: string[]): Set<string> {
  const end = args.indexOf('--');
  return new Set(end === -1 ? args : args.slice(0, end));
}

interface GlobalFlags {
  json: boolean;
  plain: boolean;
  noColor: boolean;
  quiet: boolean;
}

function presumedGlobals(flags: Set<string>): GlobalFlags {
  return {
    json: flags.has('--json'),
    plain: flags.has('--plain'),
    noColor: flags.has('--no-color'),
    quiet: flags.has('--quiet') || flags.has('-q'),
  };
}

/** Options globales telles que commander les a réellement reconnues. */
function parsedGlobals(program: Command): GlobalFlags {
  const o = program.opts<{ json?: boolean; plain?: boolean; color?: boolean; quiet?: boolean }>();
  return {
    json: o.json === true,
    plain: o.plain === true,
    noColor: o.color === false,
    quiet: o.quiet === true,
  };
}

/**
 * `-V` (alias historique de `--version`) n'est réécrit qu'en tête de
 * ligne, parmi les options qui précèdent la commande : ailleurs, c'est une
 * valeur (`--start -V`) ou de la donnée (`run -- -V`).
 */
function rewriteLeadingVersionAlias(args: string[]): string[] {
  const out = [...args];
  for (let i = 0; i < out.length; i += 1) {
    if (out[i] === '--' || !out[i].startsWith('-')) break;
    if (out[i] === '-V') out[i] = '--version';
  }
  return out;
}

/**
 * `.env` de la RACINE du dépôt (et non du répertoire courant : lancée depuis
 * un sous-dossier, la CLI ne le trouvait pas). Recherche par le système de
 * fichiers seul (`.git` dossier ou fichier) : aucun appel à git pour une
 * simple lecture.
 *
 * Le `.env` est une donnée NON FIABLE (un dépôt cloné peut en fournir un) :
 * il est parsé (`util.parseEnv`, jamais `process.loadEnvFile`) et seule une
 * liste blanche est appliquée (`env-file.ts`) — NODE_OPTIONS, LD_PRELOAD,
 * STRIART_NATIVE_BIN… sont refusés. Une variable déjà définie dans le shell
 * l'emporte. Rien n'est chargé dans un clone d'agent ni dans une session
 * lancée par Striart (STRIART_SESSION). Les noms ignorés sont signalés sur
 * stderr (jamais les valeurs). L'extension de la liste blanche appartient à
 * la config UTILISATEUR (`env.allow`), pas à celle du dépôt.
 */
async function loadEnvFromRepoRoot(cwd: string): Promise<void> {
  let dir = path.resolve(cwd);
  for (;;) {
    if (await exists(path.join(dir, '.git'))) break;
    const parent = path.dirname(dir);
    if (parent === dir) {
      dir = path.resolve(cwd);
      break;
    }
    dir = parent;
  }
  if (isAgentCloneRoot(dir) || process.env.STRIART_SESSION) return;
  const file = path.join(dir, '.env');
  let content: string;
  try {
    content = await readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    // Un .env illisible ne doit pas empêcher `--help` ni `doctor` : signalé, pas fatal.
    process.stderr.write(`striart: .env ignoré (${(error as Error).message})\n`);
    return;
  }
  let extraAllow: string[] = [];
  try {
    const { readUserConfig } = await import('../user-config.ts');
    extraAllow = (await readUserConfig()).env.allow;
  } catch (error) {
    // Config utilisateur invalide/non sûre : liste blanche intégrée seule (fail closed).
    process.stderr.write(`striart: env.allow ignoré (${(error as Error).message})\n`);
  }
  const { applied, ignored } = filterEnvFile(content, { env: process.env, extraAllow });
  for (const [name, value] of Object.entries(applied)) process.env[name] = value;
  if (ignored.length > 0) {
    process.stderr.write(
      `striart: .env : variable(s) non autorisée(s), ignorée(s) : ${ignored.join(', ')} (voir env.allow dans la config utilisateur)\n`,
    );
  }
}

async function exists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch {
    // Absent ou illisible : pour une simple recherche de fichier, les deux
    // valent « pas ici » (la lecture du .env signale, elle, ses échecs).
    return false;
  }
}

/** Commandes du plan humain : décisions que la garde de session d'agent réserve à l'humain. */
const HUMAN_PLANE_COMMANDS: ReadonlySet<string> = new Set([
  'resolve',
  'merge',
  'stop',
  'lock',
  'rollback',
  'promote',
]);

interface ErrorReport {
  code: string;
  kind: ErrorKind;
  message: string;
  hint: string | null;
  details: Record<string, unknown>;
}

/** Erreur d'usage commander → message localisé (le texte anglais de commander est analysé). */
function commanderReport(error: CommanderError, m: Messages, command: string | null): ErrorReport {
  const code = COMMANDER_CODES[error.code] ?? 'INVALID_ARGUMENT';
  const raw = error.message.replace(/^error:\s*/i, '');
  const quoted = [...raw.matchAll(/'([^']+)'/g)].map((match) => match[1]);
  const suggestion = /Did you mean ([^?]+)\?/.exec(raw)?.[1]?.trim() ?? null;
  const u = m.usageErrors;
  let message: string;
  switch (error.code) {
    case 'commander.unknownOption':
      message = u.unknownOption(quoted[0] ?? raw);
      break;
    case 'commander.unknownCommand':
      message = u.unknownCommand(quoted[0] ?? raw);
      break;
    case 'commander.missingArgument':
      message = u.missingArgument(quoted[0] ?? '?');
      break;
    case 'commander.optionMissingArgument':
    case 'commander.missingMandatoryOptionValue':
      message = u.optionMissingArgument(quoted[0] ?? raw);
      break;
    case 'commander.excessArguments': {
      const counts = /Expected (\d+) arguments? but got (\d+)/.exec(raw);
      message = counts ? u.excessArguments(Number(counts[1]), Number(counts[2])) : u.generic(raw);
      break;
    }
    case 'commander.conflictingOption':
      message = u.conflictingOption(quoted[0] ?? '?', quoted[1] ?? '?');
      break;
    case 'commander.invalidArgument':
      message = u.invalidArgument(raw.split(/\.\s+/).slice(1).join('. ') || raw);
      break;
    case 'commander.help':
      message = u.missingCommand;
      break;
    default:
      message = u.generic(raw);
  }
  if (suggestion) message = `${message} ${u.didYouMean(suggestion)}`;
  return {
    code,
    kind: 'usage',
    message,
    hint: command ? u.seeHelp(command) : 'striart --help',
    details: suggestion ? { suggestion } : {},
  };
}

/**
 * Objet `error` du document `--json` — le MÊME que celui du Striart Control
 * Protocol (control/envelope.ts) : la CLI montre la cause d'une erreur
 * inattendue (terminal local), le protocole la garde pour le journal.
 */
function errorReport(error: unknown, m: Messages): ErrorReport {
  return errorObject(error, m, { exposeUnexpected: true });
}

export async function main(argv: string[] = process.argv): Promise<void> {
  const args = rewriteLeadingVersionAlias(argv.slice(2));
  const cwd = process.cwd();
  await loadEnvFromRepoRoot(cwd);

  const locale = detectLocale(process.env);
  const m = await loadMessages(locale);
  let globals = presumedGlobals(flagsOf(args));
  const configure = (g: GlobalFlags) => {
    const capabilities = detectCapabilities({
      env: process.env,
      platform: process.platform,
      stdout: process.stdout,
      stderr: process.stderr,
      stdin: process.stdin,
      plain: g.plain,
      color: g.noColor ? false : null,
    });
    const output = new Output({
      caps: capabilities,
      messages: m,
      stdout: process.stdout,
      stderr: process.stderr,
      quiet: g.quiet,
      json: g.json,
    });
    return { caps: capabilities, out: output };
  };
  let { caps, out } = configure(globals);
  let json = globals.json;
  onBeforeLogWrite(() => out.clearSpinnerLine());

  // Lecteur fermé (`striart status | head -1`) : sortie silencieuse, pas de trace.
  process.stdout.on('error', (error: NodeJS.ErrnoException) => {
    if (error.code === 'EPIPE') process.exit(process.exitCode ?? EXIT.OK);
    throw error;
  });

  // Signaux : crash-only pour les commandes courtes (la récupération après
  // coupure est déjà prouvée : verrou orphelin cassé, merge orphelin annulé,
  // sessions mortes neutralisées) ; arrêt propre des commandes longues.
  const abort = new AbortController();
  let current: string | null = null;
  let currentGraceful = false;
  let interruptedCode: number | null = null;
  const onSignal = (code: number) => () => {
    if (interruptedCode !== null || !current || !currentGraceful) {
      out.dispose();
      process.exit(code);
    }
    interruptedCode = code;
    abort.abort();
  };
  process.on('SIGINT', onSignal(EXIT.SIGINT));
  process.on('SIGTERM', onSignal(EXIT.SIGTERM));

  const { version } = createRequire(import.meta.url)('../../package.json') as { version: string };
  let rootPromise: Promise<string> | null = null;

  const dispatch = async <Input>(
    name: string,
    load: () => Promise<CommandModule<Input, unknown>>,
    input: Input,
  ): Promise<void> => {
    current = name;
    currentGraceful = isGraceful(name, input);
    // La commande est choisie : les options globales sont désormais celles
    // que commander a reconnues, plus les présomptions du balayage.
    const actual = parsedGlobals(program!);
    if (
      actual.json !== globals.json ||
      actual.plain !== globals.plain ||
      actual.noColor !== globals.noColor ||
      actual.quiet !== globals.quiet
    ) {
      out.dispose();
      globals = actual;
      ({ caps, out } = configure(globals));
      json = globals.json;
    }
    const spec = commandSpec(name);
    if (json && spec?.json === 'none') {
      throw new StriartError(m.main.jsonUnsupported(name), {
        code: 'UNSUPPORTED_OUTPUT_FORMAT',
        details: { command: name },
      });
    }
    const ctx: Ctx = {
      command: name,
      json,
      out,
      m,
      locale,
      caps,
      cwd,
      signal: abort.signal,
      repoRoot() {
        rootPromise ??= import('../clone.js').then(async ({ findRepoRoot }) => {
          const root = await findRepoRoot(cwd);
          out.root = root;
          return root;
        });
        return rootPromise;
      },
    };
    // Commandes qui tranchent à la place de l'humain (approuver un ticket,
    // fusionner, lever un verrou, annuler…) : refusées dans une session
    // d'agent Striart (S-I2). Advisory, comme assertHumanPlane partout.
    if (HUMAN_PLANE_COMMANDS.has(name)) assertHumanPlane(process.env, `striart ${name}`);
    const module = await load();
    const result: CommandResult = await module.execute(ctx, input);
    const warnings = result.warnings ?? [];
    if (json) {
      if (result.streamed) {
        out.event({
          schemaVersion: SCHEMA_VERSION,
          command: name,
          type: 'end',
          at: new Date().toISOString(),
          data: {
            ok: result.outcome === 'ok',
            outcome: result.outcome,
            interrupted: interruptedCode !== null,
          },
        });
      } else {
        out.document({
          schemaVersion: SCHEMA_VERSION,
          command: name,
          ok: result.outcome === 'ok',
          data: result.data,
          ...(warnings.length > 0 ? { warnings } : {}),
        });
      }
    } else {
      module.render?.(ctx, result);
      for (const warning of warnings) out.warn(warning.message);
    }
    process.exitCode = interruptedCode ?? exitCodeForOutcome(result.outcome);
  };

  let program: Command | null = null;
  let parsing: string | null = null;
  try {
    program = buildProgram({ m, caps, version, dispatch });
    program.hook('preSubcommand', (_thisCommand, sub) => {
      parsing = sub.name();
    });
    await program.parseAsync(args, { from: 'user' });
  } catch (error) {
    if (error instanceof CommanderError) {
      // Aide ou version affichées : succès (commander a déjà écrit sur stdout).
      if (error.code === 'commander.helpDisplayed' || error.code === 'commander.version') {
        process.exitCode = EXIT.OK;
        return;
      }
      reportError(commanderReport(error, m, parsing), parsing);
      process.exitCode = EXIT.USAGE;
      return;
    }
    if (!(error instanceof StriartError)) {
      logger.debug({ err: error }, 'Erreur inattendue — pile complète');
    }
    const report = errorReport(error, m);
    reportError(report, current ?? parsing);
    process.exitCode = interruptedCode ?? exitCodeForErrorKind(report.kind);
    // Une commande interrompue par une erreur peut laisser des handles
    // ouverts (watchers, serveur) : la sortie est garantie, sans couper
    // l'écriture des données déjà émises.
    setTimeout(() => process.exit(process.exitCode), 2000).unref();
  }

  function reportError(report: ErrorReport, command: string | null): void {
    out.dispose();
    if (json) {
      out.document({
        schemaVersion: SCHEMA_VERSION,
        command,
        ok: false,
        error: {
          code: report.code,
          kind: report.kind,
          message: report.message,
          hint: report.hint,
          details: report.details,
        },
      });
      return;
    }
    out.error(report.message, report.hint, report.code);
  }
}

/** Classification exposée pour les tests : nature d'un code d'erreur. */
export { errorKindOf };

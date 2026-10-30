/**
 * Déclaration de la CLI (couche L3) : commandes, arguments, options,
 * validation et incompatibilités — et RIEN d'autre. Aucun module métier
 * n'est importé ici : chaque commande est chargée à la demande, au moment
 * de son exécution. `striart --help` ou une erreur d'usage ne chargent ni
 * git, ni pino, ni execa.
 */
import { Argument, Command, Help, InvalidArgumentError, Option } from 'commander';
import type { Capabilities } from './caps.ts';
import type { CommandModule } from './context.ts';
import { asciiGlyphs } from './text.ts';
import type { Messages } from './i18n/index.ts';
import {
  agentNameParser,
  integerParser,
  nonEmptyParser,
  outPathParser,
  projectPathParser,
  runIdParser,
  ticketIdParser,
} from './parse.ts';
import { GROUP_ORDER, SHELLS, publicCommands } from './registry.ts';
import type { CommandGroup, Shell } from './registry.ts';

/** Exécute une commande chargée à la demande (fourni par main.ts). */
export type Dispatch = <Input>(
  name: string,
  load: () => Promise<CommandModule<Input, unknown>>,
  input: Input,
) => Promise<void>;

const MS_MAX = 7 * 24 * 60 * 60 * 1000; // une semaine : au-delà, une faute de frappe

/** Identifiant d'agent du registre ACP : validation positive avant tout réseau. */
function acpAgentIdParser(value: string): string {
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(value)) throw new InvalidArgumentError(value);
  return value;
}

/** Aide localisée : titres traduits, couleur décidée par la sonde. */
function localizedHelp(m: Messages, caps: Capabilities) {
  const titles: Record<string, string> = {
    'Usage:': m.help.usage,
    'Arguments:': m.help.arguments,
    'Options:': m.help.options,
    'Commands:': m.help.commands,
    'Global Options:': m.help.globalOptions,
  };
  return {
    showGlobalOptions: true,
    helpWidth: caps.columns ?? 80,
    styleTitle(this: Help, title: string) {
      const translated = titles[title] ?? title;
      return caps.colorStdout ? `\u001B[1m${translated}\u001B[22m` : translated;
    },
  };
}

function examples(m: Messages, name: keyof Messages['commands']): string {
  const list = m.commands[name].examples;
  if (list.length === 0) return '';
  return `\n${m.help.examples}\n${list.map((e) => `  $ ${e}`).join('\n')}\n`;
}

export function buildProgram({
  m,
  caps,
  version,
  dispatch,
}: {
  m: Messages;
  caps: Capabilities;
  version: string;
  dispatch: Dispatch;
}): Command {
  const program = new Command('striart');
  const c = m.commands;
  // Le chargeur reçoit un import() à LITTÉRAL : tsc le réécrit en .js à la
  // publication et le pack vérifie que la cible est dans l'archive. Un chemin
  // passé en variable survivrait en .ts dans le JS émis (PACK_UNREWRITTEN_TS).
  const lazy =
    <Input>(load: () => Promise<Record<string, unknown>>, exportName: string) =>
    async () =>
      (await load())[exportName] as CommandModule<Input, unknown>;

  program
    .description(m.help.description)
    .usage(m.help.rootUsage)
    .version(version, '-v, --version', m.help.versionOption)
    .helpOption('-h, --help', m.help.helpOption)
    .helpCommand('help [command]', m.help.helpCommand)
    .configureHelp(localizedHelp(m, caps))
    .configureOutput({
      // Les erreurs d'usage sont rendues par main.ts (localisées, au bon format).
      outputError: () => {},
      // Aide en ASCII quand les glyphes Unicode sont coupés (STRIART_ASCII, --plain, TERM=dumb).
      writeOut: (text) => process.stdout.write(caps.unicode ? text : asciiGlyphs(text)),
      writeErr: (text) => process.stderr.write(caps.unicode ? text : asciiGlyphs(text)),
      getOutHasColors: () => caps.colorStdout,
      getErrHasColors: () => caps.colorStderr,
      getOutHelpWidth: () => caps.columns ?? 80,
      getErrHelpWidth: () => caps.columns ?? 80,
    })
    .exitOverride()
    .showSuggestionAfterError(true)
    .addOption(new Option('--json', m.help.global.json))
    .addOption(new Option('--plain', m.help.global.plain))
    .addOption(new Option('--no-color', m.help.global.noColor))
    .addOption(new Option('-q, --quiet', m.help.global.quiet))
    .addHelpText('afterAll', ({ command }) =>
      command === program ? `\n${m.help.rootEpilog}\n` : '',
    );

  const integer = (min: number, max: number) => integerParser(m, { min, max });
  const agentName = agentNameParser(m);
  const ticketId = ticketIdParser(m);
  const projectPath = projectPathParser(m);
  const nonEmpty = nonEmptyParser(m);
  const runId = runIdParser(m);
  const outPath = outPathParser(m);

  const groupTitle = (group: CommandGroup) => m.help.groups[group];
  const declared = new Set<string>();
  const define = (name: keyof Messages['commands'], build: (cmd: Command) => void) => {
    const cmd = program.command(name).summary(c[name].summary).description(c[name].description);
    build(cmd);
    cmd.addHelpText('after', examples(m, name));
    declared.add(name);
  };

  for (const group of GROUP_ORDER) {
    program.commandsGroup(groupTitle(group));
    for (const spec of publicCommands().filter((s) => s.group === group)) {
      defineCommand(spec.name);
    }
  }

  function defineCommand(name: string): void {
    switch (name) {
      case 'init':
        define('init', (cmd) =>
          cmd.action(() =>
            dispatch(
              'init',
              lazy(() => import('./commands/init.ts'), 'init'),
              {},
            ),
          ),
        );
        return;
      case 'doctor':
        define('doctor', (cmd) =>
          cmd.action(() =>
            dispatch(
              'doctor',
              lazy(() => import('./commands/doctor.ts'), 'doctor'),
              {},
            ),
          ),
        );
        return;
      case 'completion':
        define('completion', (cmd) =>
          cmd
            .argument('<shell>', c.completion.shell, (value: string) => {
              if (!(SHELLS as readonly string[]).includes(value)) {
                throw new InvalidArgumentError(`${value} (${SHELLS.join(', ')})`);
              }
              return value as Shell;
            })
            .action((shell: Shell) =>
              dispatch(
                'completion',
                lazy(() => import('./commands/completion.ts'), 'completion'),
                {
                  shell,
                  program,
                },
              ),
            ),
        );
        return;
      case 'start':
        define('start', (cmd) =>
          cmd
            .argument('<agent>', c.start.agent, agentName)
            .option('--command <cmd>', c.start.command, nonEmpty)
            .option('--open', c.start.open)
            .option('--reuse', c.start.reuse)
            .option('--force', c.start.force)
            .option('--allow-historical-secrets', c.start.allowHistoricalSecrets)
            .action((agent: string, o) =>
              dispatch(
                'start',
                lazy(() => import('./commands/start.ts'), 'start'),
                {
                  agent,
                  command: o.command ?? null,
                  open: Boolean(o.open),
                  reuse: Boolean(o.reuse),
                  force: Boolean(o.force),
                  allowHistoricalSecrets: Boolean(o.allowHistoricalSecrets),
                },
              ),
            ),
        );
        return;
      case 'run':
        define('run', (cmd) =>
          cmd
            .argument('[prompt]', c.run.prompt)
            .option('--prompt <prompt>', c.run.promptOption)
            .option('--agent <name>', c.run.agent, agentName)
            .addOption(
              new Option('--command <cmd>', c.run.command)
                .argParser(nonEmpty)
                .conflicts(['onMain', 'autonomous']),
            )
            .addOption(new Option('--open', c.run.open).conflicts(['onMain', 'autonomous']))
            .addOption(new Option('--autonomous', c.run.autonomous).conflicts(['onMain']))
            .addOption(
              new Option('--on-main', c.run.onMain).conflicts([
                'agent',
                'after',
                'reuse',
                'force',
                'allowHistoricalSecrets',
              ]),
            )
            .option('--profile <name>', c.run.profile, nonEmpty)
            .option('--timeout <ms>', c.run.timeout, integer(1000, MS_MAX))
            .option('--after <task|agent>', c.run.after, nonEmpty)
            .option('--reuse', c.run.reuse)
            .option('--force', c.run.force)
            .option('--allow-historical-secrets', c.run.allowHistoricalSecrets)
            .action((prompt: string | undefined, o) =>
              dispatch(
                'run',
                lazy(() => import('./commands/run.ts'), 'run'),
                {
                  prompt: prompt ?? null,
                  promptOption: o.prompt ?? null,
                  agent: o.agent ?? null,
                  command: o.command ?? null,
                  open: Boolean(o.open),
                  autonomous: Boolean(o.autonomous),
                  onMain: Boolean(o.onMain),
                  profile: o.profile ?? null,
                  timeoutMs: o.timeout ?? null,
                  after: o.after ?? null,
                  reuse: Boolean(o.reuse),
                  force: Boolean(o.force),
                  allowHistoricalSecrets: Boolean(o.allowHistoricalSecrets),
                },
              ),
            ),
        );
        return;
      case 'attach':
        define('attach', (cmd) =>
          cmd.argument('<agent>', c.attach.agent, agentName).action((agent: string) =>
            dispatch(
              'attach',
              lazy(() => import('./commands/attach.ts'), 'attach'),
              { agent },
            ),
          ),
        );
        return;
      case 'plan':
        define('plan', (cmd) =>
          cmd
            .argument('<file>', c.plan.file)
            .option('--dry-run', c.plan.dryRun)
            .addOption(new Option('--mode <mode>', c.plan.mode).choices(['sequential', 'parallel']))
            .option('--concurrency <n>', c.plan.concurrency, integer(1, 64))
            .addOption(
              new Option('--on-failure <policy>', c.plan.onFailure).choices([
                'stop',
                'skip-dependents',
              ]),
            )
            .option('--resume <run-id>', c.plan.resume, runId)
            .action((file: string, o) =>
              dispatch(
                'plan',
                lazy(() => import('./commands/plan.ts'), 'plan'),
                {
                  file,
                  dryRun: Boolean(o.dryRun),
                  mode: o.mode ?? null,
                  concurrency: o.concurrency ?? null,
                  onFailure: o.onFailure ?? null,
                  resume: o.resume ?? null,
                },
              ),
            ),
        );
        return;
      case 'draft':
        define('draft', (cmd) =>
          cmd
            .argument('<objective>', c.draft.objective, nonEmpty)
            .option('--out <file>', c.draft.out, outPath)
            .action((objective: string, o) =>
              dispatch(
                'draft',
                lazy(() => import('./commands/draft.ts'), 'draft'),
                { objective, out: o.out ?? null },
              ),
            ),
        );
        return;
      case 'orchestrate': {
        const repeat = (value: string, previous: string[]) => [...previous, nonEmpty(value)];
        define('orchestrate', (cmd) =>
          cmd
            .addArgument(
              new Argument('<mode>', c.orchestrate.mode).choices([
                'review',
                'race',
                'team',
                'pipeline',
              ]),
            )
            .argument('<prompts...>', c.orchestrate.prompts)
            .option('--agent <name>', c.orchestrate.agent, agentName)
            .option('--author <profile>', c.orchestrate.author, nonEmpty)
            .option('--reviewer <profile>', c.orchestrate.reviewer, repeat, [] as string[])
            .option('--human-reviewer', c.orchestrate.humanReviewer)
            .addOption(
              new Option('--quorum <quorum>', c.orchestrate.quorum).choices([
                'all',
                'any',
                'majority',
              ]),
            )
            .option('--max-rounds <n>', c.orchestrate.maxRounds, integer(1, 10))
            .option('--candidate <profile>', c.orchestrate.candidate, repeat, [] as string[])
            .addOption(
              new Option('--pick <pick>', c.orchestrate.pick).choices([
                'first-green',
                'smallest-diff',
                'judge',
              ]),
            )
            .addOption(
              new Option('--losers <policy>', c.orchestrate.losers).choices([
                'keep',
                'archive',
                'clean',
              ]),
            )
            .option('--role <spec>', c.orchestrate.role, repeat, [] as string[])
            .addOption(
              new Option('--cadence <cadence>', c.orchestrate.cadence).choices([
                'turns',
                'parallel',
              ]),
            )
            .option('--rounds <n>', c.orchestrate.rounds, integer(1, 10))
            .option('--step-profile <profile>', c.orchestrate.stepProfile, repeat, [] as string[])
            .addOption(
              new Option('--handoff <handoff>', c.orchestrate.handoff).choices(['merge', 'clone']),
            )
            .option('--timeout <ms>', c.orchestrate.timeout, integer(1000, MS_MAX))
            .option('--dry-run', c.orchestrate.dryRun)
            .action((mode: string, prompts: string[], o) =>
              dispatch(
                'orchestrate',
                lazy(() => import('./commands/orchestrate.ts'), 'orchestrate'),
                {
                  mode,
                  prompts,
                  agent: o.agent ?? null,
                  author: o.author ?? null,
                  reviewers: o.reviewer,
                  humanReviewer: Boolean(o.humanReviewer),
                  quorum: o.quorum ?? null,
                  maxRounds: o.maxRounds ?? null,
                  candidates: o.candidate,
                  pick: o.pick ?? null,
                  losers: o.losers ?? null,
                  roles: o.role,
                  cadence: o.cadence ?? null,
                  rounds: o.rounds ?? null,
                  stepProfiles: o.stepProfile,
                  handoff: o.handoff ?? null,
                  timeout: o.timeout ?? null,
                  dryRun: Boolean(o.dryRun),
                },
              ),
            ),
        );
        return;
      }
      case 'review':
        define('review', (cmd) =>
          cmd
            .argument('[id]', c.review.id, (value: string) => {
              if (!/^rev-[0-9a-f]{12}$/.test(value)) throw new InvalidArgumentError(value);
              return value;
            })
            .addOption(
              new Option('--approve', c.review.approve).conflicts(['requestChanges', 'reject']),
            )
            .addOption(
              new Option('--request-changes', c.review.requestChanges).conflicts(['reject']),
            )
            .option('--reject', c.review.reject)
            .option('--comment <text>', c.review.comment, nonEmpty)
            .action((id: string | undefined, o) =>
              dispatch(
                'review',
                lazy(() => import('./commands/review.ts'), 'review'),
                {
                  id: id ?? null,
                  verdict: o.approve
                    ? 'approve'
                    : o.requestChanges
                      ? 'request-changes'
                      : o.reject
                        ? 'reject'
                        : null,
                  comment: o.comment ?? null,
                },
              ),
            ),
        );
        return;
      case 'profiles':
        define('profiles', (cmd) =>
          cmd
            .addOption(
              new Option('--detect', c.profiles.detect).conflicts(['catalog', 'importAcp']),
            )
            .addOption(new Option('--catalog', c.profiles.catalog).conflicts(['importAcp']))
            .addOption(
              new Option('--import-acp <id>', c.profiles.importAcp).argParser(acpAgentIdParser),
            )
            .action((o) =>
              dispatch(
                'profiles',
                lazy(() => import('./commands/profiles.ts'), 'profiles'),
                {
                  detect: Boolean(o.detect),
                  catalog: Boolean(o.catalog),
                  importAcp: typeof o.importAcp === 'string' ? o.importAcp : null,
                },
              ),
            ),
        );
        return;
      case 'watch':
        define('watch', (cmd) =>
          cmd
            .addOption(new Option('--no-merge', c.watch.noMerge).conflicts(['stop', 'status']))
            .addOption(new Option('--daemon', c.watch.daemon).conflicts(['stop', 'status', 'ui']))
            .addOption(new Option('--stop', c.watch.stop).conflicts(['status', 'ui']))
            .addOption(new Option('--status', c.watch.status).conflicts(['ui']))
            .option('--ui', c.watch.ui)
            .action((o) =>
              dispatch(
                'watch',
                lazy(() => import('./commands/watch.ts'), 'watch'),
                {
                  merge: o.merge !== false,
                  daemon: Boolean(o.daemon),
                  stop: Boolean(o.stop),
                  status: Boolean(o.status),
                  ui: Boolean(o.ui),
                },
              ),
            ),
        );
        return;
      case 'merge':
        define('merge', (cmd) =>
          cmd.argument('<agent>', c.merge.agent, agentName).action((agent: string) =>
            dispatch(
              'merge',
              lazy(() => import('./commands/merge.ts'), 'merge'),
              { agent },
            ),
          ),
        );
        return;
      case 'sync':
        define('sync', (cmd) =>
          cmd.argument('[agent]', c.sync.agent, agentName).action((agent: string | undefined) =>
            dispatch(
              'sync',
              lazy(() => import('./commands/sync.ts'), 'sync'),
              { agent: agent ?? null },
            ),
          ),
        );
        return;
      case 'stop':
        define('stop', (cmd) =>
          cmd
            .argument('<agent>', c.stop.agent, agentName)
            .option('--force', c.stop.force)
            .action((agent: string, o) =>
              dispatch(
                'stop',
                lazy(() => import('./commands/stop.ts'), 'stop'),
                {
                  agent,
                  force: Boolean(o.force),
                },
              ),
            ),
        );
        return;
      case 'status':
        define('status', (cmd) =>
          cmd.action(() =>
            dispatch(
              'status',
              lazy(() => import('./commands/status.ts'), 'status'),
              {},
            ),
          ),
        );
        return;
      case 'queue':
        define('queue', (cmd) =>
          cmd.option('--retry', c.queue.retry).action((o) =>
            dispatch(
              'queue',
              lazy(() => import('./commands/queue.ts'), 'queue'),
              { retry: Boolean(o.retry) },
            ),
          ),
        );
        return;
      case 'history':
        define('history', (cmd) =>
          cmd.option('--limit <n>', c.history.limit, integer(1, 10_000)).action((o) =>
            dispatch(
              'history',
              lazy(() => import('./commands/history.ts'), 'history'),
              {
                limit: o.limit ?? 30,
              },
            ),
          ),
        );
        return;
      case 'usage':
        define('usage', (cmd) =>
          cmd
            .option('--since <period>', c.usage.since)
            .option('--until <period>', c.usage.until)
            .option('--role <role>', c.usage.role)
            .option('--agent <name>', c.usage.agent)
            .option('--task <id>', c.usage.task)
            .action((o) =>
              dispatch(
                'usage',
                lazy(() => import('./commands/usage.ts'), 'usage'),
                {
                  since: o.since ?? null,
                  until: o.until ?? null,
                  role: o.role ?? null,
                  agent: o.agent ?? null,
                  task: o.task ?? null,
                },
              ),
            ),
        );
        return;
      case 'trace':
        define('trace', (cmd) =>
          cmd.argument('[run-id]', c.trace.runId, runId).action((runIdArg: string | undefined) =>
            dispatch(
              'trace',
              lazy(() => import('./commands/trace.ts'), 'trace'),
              { runId: runIdArg ?? null },
            ),
          ),
        );
        return;
      case 'dashboard':
        define('dashboard', (cmd) =>
          cmd
            .addOption(
              new Option('--port <port>', c.dashboard.port)
                .argParser(integer(0, 65_535))
                .conflicts(['stop', 'status']),
            )
            .addOption(new Option('--daemon', c.dashboard.daemon).conflicts(['stop', 'status']))
            .addOption(new Option('--stop', c.dashboard.stop).conflicts(['status']))
            .option('--status', c.dashboard.status)
            .addOption(
              new Option('--link', c.dashboard.link).conflicts(['daemon', 'stop', 'status']),
            )
            .action((o) =>
              dispatch(
                'dashboard',
                lazy(() => import('./commands/dashboard.ts'), 'dashboard'),
                {
                  port: o.port ?? null,
                  daemon: Boolean(o.daemon),
                  stop: Boolean(o.stop),
                  status: Boolean(o.status),
                  link: Boolean(o.link),
                },
              ),
            ),
        );
        return;
      case 'rollback':
        define('rollback', (cmd) =>
          cmd.action(() =>
            dispatch(
              'rollback',
              lazy(() => import('./commands/rollback.ts'), 'rollback'),
              {},
            ),
          ),
        );
        return;
      case 'resolve':
        define('resolve', (cmd) =>
          cmd
            .addOption(
              new Option('--unlock', c.resolve.unlock).conflicts([
                'close',
                'prepare',
                'apply',
                'all',
                'acceptTheirs',
              ]),
            )
            .addOption(
              new Option('--close <id>', c.resolve.close)
                .argParser(ticketId)
                .conflicts(['prepare', 'apply', 'all', 'acceptTheirs']),
            )
            .addOption(
              new Option('--prepare <id>', c.resolve.prepare)
                .argParser(ticketId)
                .conflicts(['apply', 'all']),
            )
            .addOption(
              new Option('--accept-theirs <path>', c.resolve.acceptTheirs)
                .argParser(projectPath)
                .default([] as string[])
                .conflicts(['apply', 'all']),
            )
            .addOption(
              new Option('--apply <id>', c.resolve.apply)
                .argParser(ticketId)
                .conflicts(['all', 'acceptTheirs']),
            )
            .option('--all', c.resolve.all)
            .action((o) =>
              dispatch(
                'resolve',
                lazy(() => import('./commands/resolve.ts'), 'resolve'),
                {
                  unlock: Boolean(o.unlock),
                  close: o.close ?? null,
                  prepare: o.prepare ?? null,
                  apply: o.apply ?? null,
                  all: Boolean(o.all),
                  acceptTheirs: (o.acceptTheirs ?? []) as string[],
                },
              ),
            ),
        );
        return;
      case 'lock':
        define('lock', (cmd) =>
          cmd
            .addOption(
              new Option('--start <reason>', c.lock.start).argParser(nonEmpty).conflicts(['stop']),
            )
            .addOption(new Option('--stop', c.lock.stop).conflicts(['pid']))
            .addOption(new Option('--pid <n>', c.lock.pid).argParser(integer(1, 2 ** 31 - 1)))
            .action((o) =>
              dispatch(
                'lock',
                lazy(() => import('./commands/lock.ts'), 'lock'),
                {
                  start: o.start ?? null,
                  stop: Boolean(o.stop),
                  pid: o.pid ?? null,
                },
              ),
            ),
        );
        return;
      case 'clean':
        define('clean', (cmd) =>
          cmd
            .argument('[agent]', c.clean.agent, agentName)
            .addOption(new Option('--stopped', c.clean.stopped).conflicts(['all']))
            .option('--all', c.clean.all)
            .option('--force', c.clean.force)
            .action((agent: string | undefined, o) =>
              dispatch(
                'clean',
                lazy(() => import('./commands/clean.ts'), 'clean'),
                {
                  agent: agent ?? null,
                  all: Boolean(o.all),
                  force: Boolean(o.force),
                },
              ),
            ),
        );
        return;
      case 'reconcile':
        define('reconcile', (cmd) =>
          cmd.action(() =>
            dispatch(
              'reconcile',
              lazy(() => import('./commands/reconcile.ts'), 'reconcile'),
              {},
            ),
          ),
        );
        return;
      case 'prune':
        define('prune', (cmd) =>
          cmd
            .option('--days <n>', c.prune.days, integer(0, 36_500))
            .option('--dry-run', c.prune.dryRun)
            .action((o) =>
              dispatch(
                'prune',
                lazy(() => import('./commands/prune.ts'), 'prune'),
                {
                  days: o.days ?? null,
                  dryRun: Boolean(o.dryRun),
                },
              ),
            ),
        );
        return;
      case 'gc':
        define('gc', (cmd) =>
          cmd
            .argument('[agent]', c.gc.agent, agentName)
            .option('--close', c.gc.close)
            .option('--dry-run', c.gc.dryRun)
            .action((agent: string | undefined, o) =>
              dispatch(
                'gc',
                lazy(() => import('./commands/gc.ts'), 'gc'),
                {
                  agent: agent ?? null,
                  close: Boolean(o.close),
                  dryRun: Boolean(o.dryRun),
                },
              ),
            ),
        );
        return;
      case 'promote':
        define('promote', (cmd) =>
          cmd.option('--rollback', c.promote.rollback).action((o) =>
            dispatch(
              'promote',
              lazy(() => import('./commands/promote.ts'), 'promote'),
              {
                rollback: Boolean(o.rollback),
              },
            ),
          ),
        );
        return;
      case 'hook':
        // Exécuté par les outils de coding : déclaration PERMISSIVE (options et
        // arguments en trop tolérés, aucune valeur validée ici) — une erreur
        // d'usage sortirait en 2, ce qui BLOQUERAIT l'action de l'outil.
        // `--agent` n'est validé que pour install/uninstall (commande humaine).
        define('hook', (cmd) =>
          cmd
            .argument('[words...]', c.hook.words)
            .option('--user', c.hook.user)
            .option('--agent <name>', c.hook.agent)
            .option('--dry-run', c.hook.dryRun)
            .option('--root [path]', c.hook.root)
            .allowUnknownOption(true)
            .allowExcessArguments(true)
            .action((words: string[], o) => {
              const managing = words[0] === 'install' || words[0] === 'uninstall';
              if (managing && o.agent !== undefined) agentName(o.agent);
              return dispatch(
                'hook',
                lazy(() => import('./commands/hook.ts'), 'hook'),
                {
                  words,
                  user: Boolean(o.user),
                  agent: typeof o.agent === 'string' ? o.agent : null,
                  dryRun: Boolean(o.dryRun),
                  root: typeof o.root === 'string' ? o.root : null,
                },
              );
            }),
        );
        return;
      case 'mcp':
        define('mcp', (cmd) =>
          cmd
            .option('--root <path>', c.mcp.root, nonEmpty)
            .option('--agent <name>', c.mcp.agent, agentName)
            .option('--read-only', c.mcp.readOnly)
            .option('--collab', c.mcp.collab)
            .action((o) =>
              dispatch(
                'mcp',
                lazy(() => import('./commands/mcp.ts'), 'mcp'),
                {
                  root: o.root ?? null,
                  agent: o.agent ?? null,
                  readOnly: Boolean(o.readOnly),
                  collab: Boolean(o.collab),
                },
              ),
            ),
        );
        return;
      case 'acp':
        define('acp', (cmd) =>
          cmd
            .option('--root <path>', c.acp.root, nonEmpty)
            .option('--profile <name>', c.acp.profile, nonEmpty)
            .action((o) =>
              dispatch(
                'acp',
                lazy(() => import('./commands/acp.ts'), 'acp'),
                {
                  root: o.root ?? null,
                  profile: o.profile ?? null,
                },
              ),
            ),
        );
        return;
      case 'api':
        define('api', (cmd) =>
          cmd
            .addOption(new Option('--stdio', c.api.stdio).conflicts(['schema']))
            .addOption(
              new Option('--framing <framing>', c.api.framing)
                .choices(['ndjson', 'content-length'])
                .conflicts(['schema']),
            )
            .addOption(
              new Option('--schema [kind]', c.api.schema)
                .choices(['openrpc', 'json-schema'])
                .preset('openrpc'),
            )
            .action((o) =>
              dispatch(
                'api',
                lazy(() => import('./commands/api.ts'), 'api'),
                {
                  stdio: Boolean(o.stdio),
                  framing: o.framing ?? null,
                  schema: o.schema ?? null,
                },
              ),
            ),
        );
        return;
      default:
        throw new Error(`Commande déclarée au registre mais non câblée : ${name}`);
    }
  }

  // Commandes internes : hors aide, hors complétion.
  program
    .command('__complete', { hidden: true })
    .argument('<kind>', '', (value: string) => {
      if (!['agents', 'tickets', 'profiles'].includes(value)) throw new InvalidArgumentError(value);
      return value;
    })
    .action((kind: 'agents' | 'tickets' | 'profiles') =>
      dispatch(
        '__complete',
        lazy(() => import('./commands/complete.ts'), 'complete'),
        { kind },
      ),
    );

  for (const spec of publicCommands()) {
    if (!declared.has(spec.name))
      throw new Error(`Commande du registre non déclarée : ${spec.name}`);
  }
  return program;
}

#!/usr/bin/env node
/**
 * Banc du CYCLE DE MERGE sous charge — `npm run bench:merge` (L8, mesure AVANT L9).
 *
 * Question posée : combien de temps le verrou principal est-il TENU, et que paie chaque merge qui
 * attend derrière ? Tant que le merge, la fusion LLM et le Test Gate tournent sous le verrou (état
 * d'avant L9), `lockHeld` croît avec la durée du gate et le débit est plafonné à 1 / durée du gate.
 * Ce banc rend ces chiffres de façon REPRODUCTIBLE, pour que le gain de L9 soit prouvé et non
 * affirmé : on rejoue le même scénario avant et après.
 *
 * Scénario : un dépôt temporaire, N agents (clones réels), chacun reçoit R commits produits par le
 * faux agent `tests/helpers/fake-agent-files.cjs` (fichiers distincts : pas de conflit, le coût
 * mesuré est celui du cycle, pas de la fusion sémantique), puis les merges partent avec au plus M
 * en vol — ils se sérialisent sur le verrou principal, c'est la contention mesurée. Le Test Gate
 * dort `--gate-ms` (le scénario « gate lent » qui prouvera L9).
 *
 * Usage : node scripts/bench-merge.ts [--agents 4] [--rounds 1] [--concurrency N] [--gate-ms 0]
 *         [--gate-container process|native] [--repeat 1] [--json] [--out fichier.json]
 *
 * Sortie : tableau sur stdout (ou un document JSON avec --json). Avec --repeat K > 1, la médiane
 * des K exécutions est rendue en plus de chaque exécution (une machine chargée bruite une mesure
 * isolée). Codes de sortie : 0 mesure faite, 1 échec d'un merge, 2 usage invalide.
 */
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, promisify } from 'node:util';
import { PHASES } from '../src/timings.ts';
import type { PhaseName, Timings } from '../src/timings.ts';

const execFileAsync = promisify(execFile);
const FAKE_AGENT = fileURLToPath(new URL('../tests/helpers/fake-agent-files.cjs', import.meta.url));

// --- Statistiques (pures, testées) ------------------------------------------------------------

/** Centile par rang le plus proche d'un échantillon TRIÉ (0 pour un échantillon vide). */
export function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index];
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

export interface PhaseStats {
  p50: number;
  p95: number;
  p99: number;
  max: number;
}

export interface RunSummary {
  merges: number;
  wallMs: number;
  throughputPerSec: number;
  /** Somme des durées de verrou TENU de tous les merges. */
  lockHeldTotalMs: number;
  /** `lockHeldTotalMs / wallMs` : part de la durée murale pendant laquelle le verrou est tenu (≈ 1 = goulot). */
  lockHeldRatio: number;
  phases: Record<PhaseName, PhaseStats>;
}

export function summarizeRun(
  merges: readonly Timings[],
  { wallMs }: { wallMs: number },
): RunSummary {
  const phases = {} as Record<PhaseName, PhaseStats>;
  for (const phase of PHASES) {
    const sorted = merges.map((m) => m[phase]).sort((a, b) => a - b);
    phases[phase] = {
      p50: round2(percentile(sorted, 50)),
      p95: round2(percentile(sorted, 95)),
      p99: round2(percentile(sorted, 99)),
      max: round2(sorted.length > 0 ? sorted[sorted.length - 1] : 0),
    };
  }
  const lockHeldTotalMs = round2(merges.reduce((sum, m) => sum + m.lockHeld, 0));
  return {
    merges: merges.length,
    wallMs: round2(wallMs),
    throughputPerSec: wallMs > 0 ? round2(merges.length / (wallMs / 1000)) : 0,
    lockHeldTotalMs,
    lockHeldRatio: wallMs > 0 ? round2(lockHeldTotalMs / wallMs) : 0,
    phases,
  };
}

function medianOf(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export interface MedianSummary extends RunSummary {
  /** Nombre d'exécutions dont la médiane est rendue. */
  runs: number;
}

/** Médiane, statistique par statistique, de plusieurs exécutions du même scénario. */
export function medianOfRuns(runs: readonly RunSummary[]): MedianSummary {
  const phases = {} as Record<PhaseName, PhaseStats>;
  for (const phase of PHASES) {
    const of = (key: keyof PhaseStats) => round2(medianOf(runs.map((r) => r.phases[phase][key])));
    phases[phase] = { p50: of('p50'), p95: of('p95'), p99: of('p99'), max: of('max') };
  }
  return {
    runs: runs.length,
    merges: Math.round(medianOf(runs.map((r) => r.merges))),
    wallMs: round2(medianOf(runs.map((r) => r.wallMs))),
    throughputPerSec: round2(medianOf(runs.map((r) => r.throughputPerSec))),
    lockHeldTotalMs: round2(medianOf(runs.map((r) => r.lockHeldTotalMs))),
    lockHeldRatio: round2(medianOf(runs.map((r) => r.lockHeldRatio))),
    phases,
  };
}

export function renderTable(
  run: RunSummary,
  meta: { gateMs: number; agents: number; label?: string },
): string {
  const lines = [
    `${meta.label ?? 'Exécution'} : ${run.merges} merge(s), ${meta.agents} agent(s), gate ${meta.gateMs} ms — durée murale ${run.wallMs} ms, débit ${run.throughputPerSec} merge/s`,
    `verrou tenu : ${run.lockHeldTotalMs} ms cumulés = ${(run.lockHeldRatio * 100).toFixed(0)} % de la durée murale`,
    '',
    `${'PHASE'.padEnd(10)}  ${'P50'.padStart(9)}  ${'P95'.padStart(9)}  ${'P99'.padStart(9)}  ${'MAX'.padStart(9)}`,
  ];
  for (const phase of PHASES) {
    const s = run.phases[phase];
    lines.push(
      `${phase.padEnd(10)}  ${`${s.p50} ms`.padStart(9)}  ${`${s.p95} ms`.padStart(9)}  ${`${s.p99} ms`.padStart(9)}  ${`${s.max} ms`.padStart(9)}`,
    );
  }
  return lines.join('\n');
}

// --- Arguments --------------------------------------------------------------------------------

export interface BenchArgs {
  agents: number;
  rounds: number;
  concurrency: number;
  gateMs: number;
  repeat: number;
  json: boolean;
  gateContainer: 'process' | 'native';
  out: string | null;
}

function intOption(raw: string, name: string, min: number, max: number): number {
  if (!/^\d+$/.test(raw)) throw new Error(`--${name} attend un entier entre ${min} et ${max}`);
  const value = Number(raw);
  if (value < min || value > max)
    throw new Error(`--${name} attend un entier entre ${min} et ${max}`);
  return value;
}

/** Valide les arguments (jamais ignorés en silence) ; lève `Error` sur toute valeur invalide. */
export function parseBenchArgs(argv: readonly string[]): BenchArgs {
  const { values } = parseArgs({
    args: [...argv],
    strict: true,
    options: {
      agents: { type: 'string', default: '4' },
      rounds: { type: 'string', default: '1' },
      concurrency: { type: 'string' },
      'gate-ms': { type: 'string', default: '0' },
      'gate-container': { type: 'string', default: 'process' },
      repeat: { type: 'string', default: '1' },
      json: { type: 'boolean', default: false },
      out: { type: 'string' },
    },
  });
  const agents = intOption(values.agents as string, 'agents', 1, 32);
  const gateContainer = values['gate-container'] as string;
  if (gateContainer !== 'process' && gateContainer !== 'native') {
    throw new Error('--gate-container attend process ou native');
  }
  return {
    agents,
    rounds: intOption(values.rounds as string, 'rounds', 1, 50),
    concurrency:
      values.concurrency === undefined
        ? agents
        : intOption(values.concurrency, 'concurrency', 1, 64),
    gateMs: intOption(values['gate-ms'] as string, 'gate-ms', 0, 600_000),
    repeat: intOption(values.repeat as string, 'repeat', 1, 20),
    json: values.json === true,
    gateContainer,
    out: values.out ?? null,
  };
}

// --- Scénario ---------------------------------------------------------------------------------

async function git(cwd: string, ...args: string[]): Promise<void> {
  await execFileAsync('git', ['-C', cwd, ...args]);
}

interface ScenarioResult {
  summary: RunSummary;
  statuses: Record<string, number>;
}

async function runScenario(args: BenchArgs): Promise<ScenarioResult> {
  // Chargement tardif : l'environnement du banc est posé avant le premier import du noyau.
  const { initStriart } = await import('../src/init.ts');
  const { createAgent } = await import('../src/clone.ts');
  const { mergeAgentCommit } = await import('../src/orchestrator.ts');

  const root = await mkdtemp(path.join(os.tmpdir(), 'striart-bench-merge-'));
  try {
    await git(root, 'init', '-q', '-b', 'main');
    await git(root, 'config', 'user.name', 'bench');
    await git(root, 'config', 'user.email', 'bench@example.com');
    await git(root, 'config', 'gc.auto', '0');
    await writeFile(path.join(root, 'README.md'), '# bench\n');
    await git(root, 'add', 'README.md');
    await git(root, 'commit', '-q', '-m', 'init');
    await initStriart(root);
    const testCommand =
      args.gateMs > 0
        ? `node -e "setTimeout(()=>process.exit(0),${args.gateMs})"`
        : 'node -e "process.exit(0)"';
    await writeFile(
      path.join(root, '.striartrc.json'),
      JSON.stringify({
        testCommand,
        testTimeoutMs: args.gateMs + 120_000,
        gateContainer: args.gateContainer,
        semanticMerge: false,
        memoryLayer: false,
        autoPush: false,
      }),
    );

    const names = Array.from({ length: args.agents }, (_, i) => `bench-${i + 1}`);
    const clones = new Map<string, string>();
    for (const name of names) {
      const info = await createAgent({ root, name });
      clones.set(name, info.path);
    }

    const timings: Timings[] = [];
    const statuses: Record<string, number> = {};
    let wallMs = 0;
    for (let round = 1; round <= args.rounds; round += 1) {
      // Travail des agents : un fichier distinct par agent et par tour (faux agent existant).
      await Promise.all(
        names.map((name) =>
          execFileAsync(process.execPath, [FAKE_AGENT], {
            cwd: clones.get(name),
            env: {
              ...process.env,
              FAKE_AGENT_SPEC: JSON.stringify({
                write: { [`work/${name}-r${round}.txt`]: `tour ${round} de ${name}\n` },
                commit: true,
              }),
            },
          }),
        ),
      );
      // Merges : au plus `concurrency` en vol, sérialisés par le verrou principal.
      const queue = [...names];
      const started = performance.now();
      await Promise.all(
        Array.from({ length: Math.min(args.concurrency, names.length) }, async () => {
          for (let name = queue.shift(); name !== undefined; name = queue.shift()) {
            try {
              const result = await mergeAgentCommit({ root, agent: name });
              statuses[result.status] = (statuses[result.status] ?? 0) + 1;
              if (result.timings) timings.push(result.timings);
            } catch (error) {
              // Un merge qui echoue (LOCK_TIMEOUT sous forte contention) est une DONNEE du banc,
              // pas une raison de perdre toute la mesure : compte sous son code, exit 1 en fin de course.
              const code = (error as { code?: string }).code ?? 'ERROR';
              statuses[`ERROR:${code}`] = (statuses[`ERROR:${code}`] ?? 0) + 1;
            }
          }
        }),
      );
      wallMs += performance.now() - started;
    }
    return { summary: summarizeRun(timings, { wallMs }), statuses };
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 5 }).catch(() => {
      // Windows : un handle traînant (antivirus, git) peut tenir le dossier — un reliquat dans %TEMP% est sans conséquence.
    });
  }
}

async function main(): Promise<void> {
  let args: BenchArgs;
  try {
    args = parseBenchArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(
      `bench-merge: ${(error as Error).message}\nUsage : node scripts/bench-merge.ts [--agents N] [--rounds R] [--concurrency M] [--gate-ms MS] [--gate-container process|native] [--repeat K] [--json] [--out fichier.json]\n`,
    );
    process.exit(2);
  }
  process.env.STRIART_TOKENS_NO_DISCOVERY = '1';
  process.env.STRIART_LOG_LEVEL ??= 'warn';

  const runs: RunSummary[] = [];
  const statusesPerRun: Array<Record<string, number>> = [];
  let failed = false;
  for (let i = 0; i < args.repeat; i += 1) {
    const { summary, statuses } = await runScenario(args);
    runs.push(summary);
    const expected = args.agents * args.rounds;
    if ((statuses.MERGED ?? 0) !== expected) {
      failed = true;
      process.stderr.write(
        `bench-merge: run ${i + 1}: ${statuses.MERGED ?? 0}/${expected} merge(s) succeeded (${JSON.stringify(statuses)})
`,
      );
    }
    statusesPerRun.push(statuses);
    if (!args.json) {
      process.stdout.write(
        `${renderTable(summary, { gateMs: args.gateMs, agents: args.agents, label: `Exécution ${i + 1}/${args.repeat}` })}\n\n`,
      );
    }
  }
  const median = args.repeat > 1 ? medianOfRuns(runs) : null;
  const document = {
    node: process.version,
    platform: process.platform,
    cpus: os.cpus().length,
    generatedAt: new Date().toISOString(),
    params: args,
    runs,
    statuses: statusesPerRun,
    median,
  };
  if (args.out) await writeFile(args.out, `${JSON.stringify(document, null, 2)}\n`);
  if (args.json) process.stdout.write(`${JSON.stringify(document)}\n`);
  else if (median) {
    process.stdout.write(
      `${renderTable(median, { gateMs: args.gateMs, agents: args.agents, label: `MÉDIANE de ${median.runs} exécutions` })}\n`,
    );
  }
  if (failed) process.exit(1);
}

// Garde : importé par les tests, le module ne lance rien.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}

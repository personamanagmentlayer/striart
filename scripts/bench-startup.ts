#!/usr/bin/env node
/**
 * Mesure du temps de démarrage de la CLI — `npm run bench:startup`.
 *
 * Lance N fois chaque scénario (process neuf à chaque fois, comme un
 * utilisateur ou un script) et rapporte la médiane et le 90e centile, à côté
 * d'un `node -e 0` nu : la part imputable à Striart est l'écart entre les
 * deux. Les scénarios « --version », « --help » et l'erreur d'usage ne
 * doivent charger ni git, ni pino, ni execa (vérifié de façon déterministe
 * par tests/integration/cli.test.js) ; ce script en donne le coût réel sur
 * la machine courante.
 *
 * Usage : node scripts/bench-startup.ts [--runs 15] [--json]
 *
 * Sortie : tableau sur stdout (ou un document JSON avec --json). Codes de
 * sortie : 0 mesure faite, 1 échec d'un scénario, 2 usage invalide.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const CLI = fileURLToPath(new URL('../src/cli.js', import.meta.url));

interface Scenario {
  name: string;
  args: string[];
  /** Code de sortie attendu (une erreur d'usage sort en 2). */
  expectedCode: number;
  baseline?: boolean;
}

const SCENARIOS: Scenario[] = [
  { name: 'node -e 0 (référence)', args: ['-e', '0'], expectedCode: 0, baseline: true },
  { name: 'striart --version', args: [CLI, '--version'], expectedCode: 0 },
  { name: 'striart --help', args: [CLI, '--help'], expectedCode: 0 },
  { name: 'striart stauts (usage)', args: [CLI, 'stauts'], expectedCode: 2 },
  { name: 'striart status', args: [CLI, 'status'], expectedCode: 0 },
];

function percentile(sorted: number[], p: number): number {
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index];
}

function usage(message: string): never {
  process.stderr.write(
    `bench-startup: ${message}\nUsage : node scripts/bench-startup.ts [--runs N] [--json]\n`,
  );
  process.exit(2);
}

function main(): void {
  let values;
  try {
    ({ values } = parseArgs({
      options: {
        runs: { type: 'string', default: '15' },
        json: { type: 'boolean', default: false },
      },
    }));
  } catch (error) {
    usage((error as Error).message);
  }
  const runs = Number(values.runs);
  if (!Number.isInteger(runs) || runs < 3 || runs > 500)
    usage('--runs attend un entier entre 3 et 500');

  // Dépôt jetable initialisé : `status` mesure un vrai chemin métier.
  const repo = mkdtempSync(path.join(os.tmpdir(), 'striart-bench-'));
  try {
    const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, stdio: 'ignore' });
    git('init', '-q', '-b', 'main');
    writeFileSync(path.join(repo, 'README.md'), '# bench\n');
    git('add', 'README.md');
    git(
      '-c',
      'user.name=bench',
      '-c',
      'user.email=bench@example.com',
      'commit',
      '-q',
      '-m',
      'init',
    );
    const env = { ...process.env, STRIART_LANG: 'fr', NO_COLOR: '1' };
    spawnSync(process.execPath, [CLI, 'init'], { cwd: repo, env, stdio: 'ignore' });

    const results = SCENARIOS.map((scenario) => {
      // Un lancement de chauffe (cache de compilation, cache disque de l'OS).
      spawnSync(process.execPath, scenario.args, { cwd: repo, env, stdio: 'ignore' });
      const samples: number[] = [];
      for (let i = 0; i < runs; i += 1) {
        const started = process.hrtime.bigint();
        const run = spawnSync(process.execPath, scenario.args, { cwd: repo, env, stdio: 'ignore' });
        samples.push(Number(process.hrtime.bigint() - started) / 1e6);
        if (run.status !== scenario.expectedCode) {
          process.stderr.write(
            `bench-startup: « ${scenario.name} » a rendu ${run.status} (attendu ${scenario.expectedCode})\n`,
          );
          process.exit(1);
        }
      }
      samples.sort((a, b) => a - b);
      return {
        scenario: scenario.name,
        medianMs: Math.round(percentile(samples, 50)),
        p90Ms: Math.round(percentile(samples, 90)),
        baseline: Boolean(scenario.baseline),
      };
    });
    const baseline = results.find((r) => r.baseline)?.medianMs ?? 0;
    const rows = results.map((r) => ({ ...r, overheadMs: r.baseline ? 0 : r.medianMs - baseline }));

    if (values.json) {
      process.stdout.write(
        `${JSON.stringify({ node: process.version, platform: process.platform, runs, results: rows })}\n`,
      );
      return;
    }
    const width = Math.max(...rows.map((r) => r.scenario.length));
    process.stdout.write(
      `Node ${process.version} (${process.platform}), ${runs} lancements par scénario\n\n`,
    );
    process.stdout.write(`${'SCÉNARIO'.padEnd(width)}  MÉDIANE  P90     SURCOÛT\n`);
    for (const r of rows) {
      process.stdout.write(
        `${r.scenario.padEnd(width)}  ${`${r.medianMs} ms`.padEnd(7)}  ${`${r.p90Ms} ms`.padEnd(6)}  ${r.baseline ? '—' : `+${r.overheadMs} ms`}\n`,
      );
    }
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
}

main();

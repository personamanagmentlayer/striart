import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { simpleGit } from 'simple-git';
import { createTempRepo } from '../helpers/temp-repo.js';
import { initStriart } from '../../src/init.js';
import { createAgent } from '../../src/clone.js';
import { DEFAULT_CONFIG } from '../../src/config.js';

/**
 * Profils proposés par la complétion : ceux par défaut (catalogue de presets
 * prêts, qui évolue) + ceux que la config déclare en données. Dérivé de la
 * config par défaut, jamais figé : ajouter un preset ne casse pas ce test.
 */
const expectedProfileNames = (declared = []) =>
  [...new Set([...Object.keys(DEFAULT_CONFIG.agentProfiles), ...declared])].sort();

const CLI = fileURLToPath(new URL('../../src/cli.js', import.meta.url));
const RECORD_IMPORTS = pathToFileURL(
  fileURLToPath(new URL('../helpers/record-imports.mjs', import.meta.url)),
).href;
const GATE_OK = 'node -e "process.exit(0)"';
const GATE_KO = 'node -e "console.error(\'tests cassés\'); process.exit(4)"';
const { version } = JSON.parse(
  await readFile(fileURLToPath(new URL('../../package.json', import.meta.url)), 'utf8'),
);

/**
 * Lance la VRAIE CLI (node src/cli.js) comme un script ou une CI le ferait :
 * stdout et stderr séparés, code de sortie réel. Environnement maîtrisé :
 * langue fixée, pas de couleur forcée héritée.
 */
function run(args, { cwd, env = {}, nodeArgs = [] } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [...nodeArgs, CLI, ...args], {
      cwd,
      env: {
        ...process.env,
        STRIART_LANG: 'fr',
        FORCE_COLOR: undefined,
        NO_COLOR: undefined,
        ...env,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

async function setConfig(root, config) {
  await writeFile(path.join(root, '.striartrc.json'), JSON.stringify(config));
}

async function commitInAgent(info, fileName, content, message) {
  const git = simpleGit(info.path);
  await git.addConfig('user.name', 'Agent');
  await git.addConfig('user.email', 'agent@example.com');
  await writeFile(path.join(info.path, fileName), content);
  await git.add([fileName]);
  await git.commit(message);
}

describe('CLI — sans dépôt initialisé', () => {
  let repo;

  beforeEach(async () => {
    repo = await createTempRepo();
  });

  afterEach(async () => {
    await repo.cleanup();
  });

  it('--version : la version du package sur stdout, sortie 0 ; -V reste accepté', async () => {
    for (const flag of ['--version', '-v', '-V']) {
      const r = await run([flag], { cwd: repo.root });
      expect(r.code).toBe(0);
      expect(r.stdout.trim()).toBe(version);
    }
  });

  // Une valeur d'option n'est pas une option globale. `-V` n'est la version
  // qu'en tête de ligne : avant, il était réécrit en `--version` partout —
  // `lock --start -V` affichait la version, `run -- -V` envoyait le prompt
  // « --version ». Les options globales de la commande exécutée viennent de
  // l'analyse de commander, plus du balayage d'argv.
  it('les options globales viennent de l’analyse, pas d’une valeur d’option', async () => {
    const versionAsValue = await run(['lock', '--start', '-V'], { cwd: repo.root });
    expect(versionAsValue.stdout).not.toContain(version);
    expect(versionAsValue.stderr).toContain('NOT_INITIALIZED');

    const jsonAsValue = await run(['lock', '--start=--json'], { cwd: repo.root });
    expect(jsonAsValue.stdout).toBe('');
    expect(jsonAsValue.stderr).toContain('NOT_INITIALIZED');

    const realJson = await run(['status', '--json'], { cwd: repo.root });
    expect(JSON.parse(realJson.stdout)).toMatchObject({ ok: false, command: 'status' });
    const leading = await run(['--plain', '-V'], { cwd: repo.root });
    expect(leading.stdout.trim()).toBe(version);
  });

  it('--help : aide groupée, localisée, codes de sortie documentés, sortie 0', async () => {
    const r = await run(['--help'], { cwd: repo.root });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('Utilisation :');
    expect(r.stdout).toContain('Initialisation et diagnostic :');
    expect(r.stdout).toContain('Réparer et nettoyer :');
    expect(r.stdout).toContain('Codes de sortie :');
    expect(r.stdout).not.toContain('pty-host-run');
    expect(r.stdout).not.toContain('__complete');
  });

  it('aide d’une commande : exemples, sortie 0', async () => {
    const r = await run(['merge', '--help'], { cwd: repo.root });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('Exemples :');
    expect(r.stdout).toContain('striart merge agent-a');
  });

  it('erreur d’usage : sortie 2, message localisé et suggestion sur stderr, stdout vide', async () => {
    const r = await run(['stauts'], { cwd: repo.root });
    expect(r.code).toBe(2);
    expect(r.stdout).toBe('');
    expect(r.stderr).toContain('commande inconnue « stauts »');
    expect(r.stderr).toContain('« status »');
    expect(r.stderr).toContain('UNKNOWN_COMMAND');
  });

  it.each([
    [['prune', '--days', 'abc'], 'INVALID_ARGUMENT'],
    [['history', '--limit', '0'], 'INVALID_ARGUMENT'],
    [['status', 'extra'], 'EXCESS_ARGUMENTS'],
    [['resolve', '--apply', 'a', '--close', 'b'], 'OPTION_CONFLICT'],
    [['lock', '--start', 'x', '--stop'], 'OPTION_CONFLICT'],
    [['run', '--on-main', '--autonomous', 'x'], 'OPTION_CONFLICT'],
    [['run', '--profile', 'codex', 'x'], 'OPTION_CONFLICT'],
    [['start', 'bad name!'], 'INVALID_ARGUMENT'],
    [['attach', 'a', '--json'], 'UNSUPPORTED_OUTPUT_FORMAT'],
  ])('%j → sortie 2 (%s)', async (args, code) => {
    const r = await run(args, { cwd: repo.root });
    expect(r.code).toBe(2);
    // En --json, l'erreur est le document sur stdout ; sinon une ligne sur stderr.
    expect(r.stdout + r.stderr).toContain(code);
  });

  it('--json : une erreur est un document unique sur stdout', async () => {
    const r = await run(['stauts', '--json'], { cwd: repo.root });
    expect(r.code).toBe(2);
    const doc = JSON.parse(r.stdout);
    expect(doc).toMatchObject({
      schemaVersion: 1,
      ok: false,
      error: { code: 'UNKNOWN_COMMAND', kind: 'usage', details: { suggestion: 'status' } },
    });
  });

  it('dépôt non initialisé : échec d’environnement (1) avec la piste « striart init »', async () => {
    const r = await run(['status'], { cwd: repo.root });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('NOT_INITIALIZED');
    expect(r.stderr).toContain('striart init');
  });

  it('doctor sur un dépôt non initialisé : sortie 1', async () => {
    const r = await run(['doctor', '--json'], { cwd: repo.root });
    expect(r.code).toBe(1);
    const doc = JSON.parse(r.stdout);
    expect(doc).toMatchObject({ command: 'doctor', ok: false, data: { healthy: false } });
  });

  it('--help et --version ne chargent ni git, ni pino, ni execa (démarrage minimal)', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'striart-imports-'));
    try {
      for (const args of [['--help'], ['--version'], ['stauts']]) {
        const log = path.join(dir, `${args[0]}.json`);
        await run(args, {
          cwd: repo.root,
          env: { STRIART_IMPORT_LOG: log },
          nodeArgs: ['--import', RECORD_IMPORTS],
        });
        const loaded = JSON.parse(await readFile(log, 'utf8')).join('\n');
        for (const heavy of [
          'simple-git',
          '/pino/',
          'execa',
          'cosmiconfig',
          'chokidar',
          '/ink/',
          'node-pty',
        ]) {
          expect(loaded, `${args[0]} charge ${heavy}`).not.toContain(heavy);
        }
        expect(loaded).not.toMatch(/src\/(clone|orchestrator|lock)\.js/);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('CLI — dépôt initialisé', () => {
  let repo;
  let agent;

  beforeEach(async () => {
    repo = await createTempRepo();
    await initStriart(repo.root);
    await setConfig(repo.root, { testCommand: GATE_OK, semanticMerge: false });
    agent = await createAgent({ root: repo.root, name: 'agent-a' });
  });

  afterEach(async () => {
    await repo.cleanup();
  });

  it('status --json : enveloppe v1, même vue que le MCP, stdout = un seul document', async () => {
    const r = await run(['status', '--json'], {
      cwd: repo.root,
      env: { STRIART_LOG_LEVEL: 'debug' },
    });
    expect(r.code).toBe(0);
    expect(r.stdout.trim().split('\n')).toHaveLength(1);
    const doc = JSON.parse(r.stdout);
    expect(doc).toMatchObject({
      schemaVersion: 1,
      command: 'status',
      ok: true,
      data: { agents: [{ name: 'agent-a', status: 'ACTIVE' }], queue: expect.any(Array) },
    });
    expect(doc.data.agents[0].session).toEqual({ state: expect.any(String), via: null, pid: null });
  });

  it('merge réussi : sortie 0, document avec mergeSha distinct du commit de l’agent', async () => {
    await commitInAgent(agent, 'f.js', 'export const f = 1;\n', 'feat: f');
    const r = await run(['merge', 'agent-a', '--json'], {
      cwd: repo.root,
      env: { STRIART_LOG_LEVEL: 'debug' },
    });
    expect(r.code).toBe(0);
    const doc = JSON.parse(r.stdout); // stdout propre malgré les logs debug (sur stderr)
    expect(doc).toMatchObject({ command: 'merge', ok: true, data: { status: 'MERGED' } });
    expect(doc.data.mergeSha).not.toBe(doc.data.sha);
  });

  // Régression (audit 2026-10-18) : un Test Gate rouge sortait en 0 —
  // `striart merge a && deploy` déployait.
  it('Test Gate rouge : sortie 3 (refus), ok:false, ticket dans les données', async () => {
    await setConfig(repo.root, { testCommand: GATE_KO, semanticMerge: false });
    await commitInAgent(agent, 'g.js', 'export const g = 1;\n', 'feat: g');
    const human = await run(['merge', 'agent-a'], { cwd: repo.root });
    expect(human.code).toBe(3);
    expect(human.stdout).toContain('Test Gate rouge');
    expect(human.stdout).toContain('striart resolve --prepare');

    const r = await run(['merge', 'agent-a', '--json'], { cwd: repo.root });
    expect(r.code).toBe(3);
    const doc = JSON.parse(r.stdout);
    expect(doc).toMatchObject({
      ok: false,
      data: { status: 'GATE_FAILED', ticket: { agent: 'agent-a' } },
    });
  });

  it('clean d’un agent actif nommé sans --all : sortie 3 (une garde l’a protégé)', async () => {
    const r = await run(['clean', 'agent-a'], { cwd: repo.root });
    expect(r.code).toBe(3);
    expect(r.stdout).toContain('agent-a conservé');
    expect(r.stdout).toContain('striart clean agent-a --all');
  });

  it('--plain : ni couleur, ni glyphe, ni séquence de terminal', async () => {
    const r = await run(['status', '--plain'], { cwd: repo.root, env: { FORCE_COLOR: '1' } });
    expect(r.code).toBe(0);
    // eslint-disable-next-line no-control-regex -- vérifie l'absence de séquences de terminal
    expect(r.stdout).not.toMatch(/\u001B/);
    expect(r.stdout).not.toMatch(/[✓✗→]/);
  });

  it('anglais (STRIART_LANG=en) : textes, aide et erreurs du domaine traduits', async () => {
    const help = await run(['--help'], { cwd: repo.root, env: { STRIART_LANG: 'en' } });
    expect(help.stdout).toContain('Setup and diagnosis:');
    const err = await run(['merge', 'ghost'], { cwd: repo.root, env: { STRIART_LANG: 'en' } });
    expect(err.code).toBe(1);
    expect(err.stderr).toContain('unknown agent: "ghost"');
  });

  it('completion : scripts générés depuis l’arbre réel des commandes', async () => {
    for (const shell of ['bash', 'zsh', 'fish', 'powershell']) {
      const r = await run(['completion', shell], { cwd: repo.root });
      expect(r.code, shell).toBe(0);
      expect(r.stdout).toContain('merge');
      expect(r.stdout).toContain('striart __complete');
    }
    const values = await run(['__complete', 'agents'], { cwd: repo.root });
    expect(values.stdout.trim()).toBe('agent-a');
  });

  it('les scripts de complétion sont syntaxiquement valides pour les shells présents', async () => {
    const { spawnSync } = await import('node:child_process');
    const available = (cmd, args) => spawnSync(cmd, args, { stdio: 'ignore' }).status === 0;
    const dir = await mkdtemp(path.join(os.tmpdir(), 'striart-completion-'));
    try {
      const checks = [
        ['bash', ['--version'], (file) => ['bash', ['-n', file]]],
        ['zsh', ['--version'], (file) => ['zsh', ['-n', file]]],
        ['fish', ['--version'], (file) => ['fish', ['--no-execute', file]]],
        [
          'powershell',
          ['-NoProfile', '-Command', 'exit 0'],
          (file) => [
            'powershell',
            [
              '-NoProfile',
              '-NonInteractive',
              '-Command',
              `$e = $null; [void][System.Management.Automation.Language.Parser]::ParseFile('${file.replace(/'/g, "''")}', [ref]$null, [ref]$e); if ($e.Count) { $e | ForEach-Object { $_.Message }; exit 1 }`,
            ],
          ],
        ],
      ];
      let checked = 0;
      for (const [shell, probe, command] of checks) {
        if (!available(shell, probe)) continue;
        const { stdout } = await run(['completion', shell], { cwd: repo.root });
        const file = path.join(dir, `striart.${shell}`);
        await writeFile(file, stdout);
        const [cmd, args] = command(file);
        const result = spawnSync(cmd, args, { encoding: 'utf8' });
        expect(result.status, `${shell} : ${result.stdout}${result.stderr}`).toBe(0);
        checked += 1;
      }
      expect(checked).toBeGreaterThan(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('__complete : une valeur hors motif (substitution shell…) n’est jamais proposée', async () => {
    const registryPath = path.join(repo.root, '.striart', 'agents.json');
    const registry = JSON.parse(await readFile(registryPath, 'utf8'));
    registry['$(touch PWNED-AGENTS)'] = registry['agent-a'];
    await writeFile(registryPath, JSON.stringify(registry));
    await mkdir(path.join(repo.root, '.striart', 'conflicts', 'agent-a-1234abcd'), {
      recursive: true,
    });
    await mkdir(path.join(repo.root, '.striart', 'conflicts', '$(touch PWNED-TICKET)'), {
      recursive: true,
    });
    const agents = await run(['__complete', 'agents'], { cwd: repo.root });
    expect(agents.stdout.trim().split(/\r?\n/)).toEqual(['agent-a']);
    const tickets = await run(['__complete', 'tickets'], { cwd: repo.root });
    expect(tickets.stdout.trim().split(/\r?\n/)).toEqual(['agent-a-1234abcd']);
  });

  // Config-as-code d'un dépôt cloné : un appui sur Tab n'est pas un
  // déclencheur d'exécution évident. Avant : `__complete profiles` importait
  // striart.config.mjs à chaque Tab.
  it('__complete profiles : n’exécute jamais une config en code ; lit le cache de « striart profiles »', async () => {
    const marker = path.join(repo.root, 'CONFIG-EXECUTED');
    // La config en données posée par beforeEach passerait avant le .mjs
    // dans l'ordre de recherche de cosmiconfig : on la retire.
    await rm(path.join(repo.root, '.striartrc.json'), { force: true });
    await writeFile(
      path.join(repo.root, 'striart.config.mjs'),
      `import { writeFileSync } from 'node:fs';\n` +
        `writeFileSync(${JSON.stringify(marker)}, 'x');\n` +
        `export default { agentProfiles: { kimi: { command: 'kimi', args: ['{{prompt}}'] } } };\n`,
    );
    const before = await run(['__complete', 'profiles'], { cwd: repo.root });
    expect(before.code).toBe(0);
    await expect(readFile(marker, 'utf8')).rejects.toThrow(); // jamais exécutée
    expect(before.stdout.trim().split(/\r?\n/)).toEqual(expectedProfileNames());

    // `striart profiles` exécute la config (commande explicite) et publie les
    // noms pour la complétion ; Tab les lit ensuite comme de la donnée.
    expect((await run(['profiles'], { cwd: repo.root })).code).toBe(0);
    await rm(marker, { force: true });
    const after = await run(['__complete', 'profiles'], { cwd: repo.root });
    expect(after.stdout.trim().split(/\r?\n/)).toEqual(expectedProfileNames(['kimi']));
    await expect(readFile(marker, 'utf8')).rejects.toThrow();
  });

  it('__complete profiles : une config en données (JSON) est lue directement', async () => {
    await writeFile(
      path.join(repo.root, '.striartrc.json'),
      JSON.stringify({ agentProfiles: { mistral: { command: 'vibe', args: ['{{prompt}}'] } } }),
    );
    const r = await run(['__complete', 'profiles'], { cwd: repo.root });
    expect(r.stdout.trim().split(/\r?\n/)).toEqual(expectedProfileNames(['mistral']));
  });

  // Une config en données peut tirer du code par `$import` (cosmiconfig) :
  // le chargeur neutralisé s'applique aussi au fichier importé.
  it('__complete profiles : un $import vers du code n’est pas exécuté non plus', async () => {
    const marker = path.join(repo.root, 'IMPORT-EXECUTED');
    await writeFile(
      path.join(repo.root, 'evil.mjs'),
      `import { writeFileSync } from 'node:fs';\n` +
        `writeFileSync(${JSON.stringify(marker)}, 'x');\n` +
        `export default { agentProfiles: { evil: { command: 'x', args: ['{{prompt}}'] } } };\n`,
    );
    await writeFile(
      path.join(repo.root, '.striartrc.json'),
      JSON.stringify({ $import: './evil.mjs', testCommand: GATE_OK }),
    );
    const r = await run(['__complete', 'profiles'], { cwd: repo.root });
    expect(r.code).toBe(0);
    await expect(readFile(marker, 'utf8')).rejects.toThrow();
    expect(r.stdout.trim().split(/\r?\n/)).toEqual(expectedProfileNames());
  });

  it('__complete : borné au dépôt git — un .striart d’un dossier parent étranger est ignoré', async () => {
    const outer = await mkdtemp(path.join(os.tmpdir(), 'striart-outer-'));
    try {
      await mkdir(path.join(outer, '.striart'), { recursive: true });
      await writeFile(path.join(outer, '.striart', 'agents.json'), JSON.stringify({ intrus: {} }));
      await mkdir(path.join(outer, 'nested'), { recursive: true });
      const r = await run(['__complete', 'agents'], { cwd: path.join(outer, 'nested') });
      expect(r.code).toBe(0);
      expect(r.stdout.trim()).toBe('');
      // Depuis un sous-dossier du dépôt, la racine du dépôt reste trouvée.
      await mkdir(path.join(repo.root, 'src', 'deep'), { recursive: true });
      const inside = await run(['__complete', 'agents'], {
        cwd: path.join(repo.root, 'src', 'deep'),
      });
      expect(inside.stdout.trim()).toBe('agent-a');
    } finally {
      await rm(outer, { recursive: true, force: true });
    }
  });

  it('complétion bash : une valeur dynamique n’est jamais réévaluée par le shell', async () => {
    const { spawnSync } = await import('node:child_process');
    if (spawnSync('bash', ['--version'], { stdio: 'ignore' }).status !== 0) return;
    const dir = await mkdtemp(path.join(os.tmpdir(), 'striart-bashcomp-'));
    try {
      const { stdout } = await run(['completion', 'bash'], { cwd: repo.root });
      await writeFile(path.join(dir, 'completion.bash'), stdout);
      // Faux `striart` : renvoie une valeur piégée, comme le ferait une
      // version antérieure ou un registre falsifié — le script seul doit tenir.
      await mkdir(path.join(dir, 'bin'));
      await writeFile(
        path.join(dir, 'bin', 'striart'),
        "#!/usr/bin/env bash\nprintf '%s\n' 'agent-a' '$(touch PWNED)' 'agent-b'\n",
        { mode: 0o755 },
      );
      const script = [
        'cd "$1" || exit 9',
        'PATH="$1/bin:$PATH"',
        'source ./completion.bash',
        'COMP_WORDS=(striart stop "agent"); COMP_CWORD=2; _striart',
        'printf "%s\n" "${COMPREPLY[@]}"',
        'COMP_WORDS=(striart stop ""); COMP_CWORD=2; _striart',
        'printf "ALL:%s\n" "${COMPREPLY[@]}"',
      ].join('\n');
      // Chemin Windows → forme Git Bash (C:\x → /c/x) ; inchangé sous POSIX.
      const toBash = (p) =>
        p
          .split(path.sep)
          .join('/')
          .replace(/^([A-Za-z]):/, (_, d) => `/${d.toLowerCase()}`);
      const result = spawnSync('bash', ['-c', script, 'bash', toBash(dir)], { encoding: 'utf8' });
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout.split('\n').filter((l) => l && !l.startsWith('ALL:'))).toEqual([
        'agent-a',
        'agent-b',
      ]);
      expect(result.stdout).toContain('ALL:$(touch PWNED)');
      const pwned = await readFile(path.join(dir, 'PWNED')).then(
        () => true,
        () => false,
      );
      expect(pwned).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it.runIf(process.platform !== 'win32')(
    'watch au premier plan : Ctrl+C arrête proprement, sortie 130',
    async () => {
      const child = spawn(process.execPath, [CLI, 'watch', '--no-merge'], {
        cwd: repo.root,
        env: { ...process.env, STRIART_LANG: 'fr' },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      // La bannière de démarrage est une ligne de statut, pas une donnée : stderr (Output.notice).
      let stderr = '';
      child.stderr.on('data', (d) => (stderr += d));
      await new Promise((resolve) => {
        const timer = setInterval(() => {
          if (stderr.includes('watcher actif')) {
            clearInterval(timer);
            resolve();
          }
        }, 50);
      });
      child.kill('SIGINT');
      const code = await new Promise((resolve) => child.on('close', resolve));
      expect(code).toBe(130);
    },
  );

  it.runIf(process.platform !== 'win32')(
    'run --on-main + SIGTERM : l’agent est tué et la session principale dépubliée, sortie 143',
    async () => {
      const fakeAgent = fileURLToPath(new URL('../helpers/fake-agent.cjs', import.meta.url));
      await setConfig(repo.root, {
        testCommand: GATE_OK,
        semanticMerge: false,
        agentProfiles: { fake: { command: process.execPath, args: [fakeAgent, '{{prompt}}'] } },
      });
      const sessionFile = path.join(repo.root, '.striart', 'main-session.json');
      const child = spawn(process.execPath, [CLI, 'run', '--on-main', '--profile', 'fake', 'x'], {
        cwd: repo.root,
        env: { ...process.env, STRIART_LANG: 'fr', FAKE_AGENT_MODE: 'hang' },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      await vi.waitFor(() => readFile(sessionFile, 'utf8'), { timeout: 20_000, interval: 100 });
      child.kill('SIGTERM');
      const code = await new Promise((resolve) => child.on('close', resolve));
      expect(code).toBe(143);
      // Dépubliée APRÈS la mort de l'agent : la garde ne tombe jamais sur un
      // principal encore en écriture.
      await expect(readFile(sessionFile, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    },
  );
});

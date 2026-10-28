import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTempRepo } from '../helpers/temp-repo.js';
import { initStriart } from '../../src/init.js';
import { createConflictTicket } from '../../src/conflicts.js';
import { answerHumanReview } from '../../src/orchestration/human-review.ts';
import { updateJsonLocked, UNCHANGED } from '../../src/json-file.js';

/**
 * Anomalies de la campagne de recette : vraie CLI, vrais flux (stdout/stderr séparés) et vrais
 * codes de sortie. Écrits avant les correctifs.
 */

const CLI = fileURLToPath(new URL('../../src/cli.js', import.meta.url));
const { version } = JSON.parse(
  await readFile(fileURLToPath(new URL('../../package.json', import.meta.url)), 'utf8'),
);

function run(args, { cwd, env = {}, killOnStderr = null } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd,
      env: {
        ...process.env,
        STRIART_LANG: 'en',
        FORCE_COLOR: undefined,
        NO_COLOR: undefined,
        ...env,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => {
      stderr += d;
      if (killOnStderr && killOnStderr.test(stderr)) child.kill();
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

describe('CLI — aide (A1)', () => {
  it('`help` et `help <commande>` : aide sur stdout, sortie 0, stderr vide', async () => {
    for (const args of [['help'], ['help', 'status']]) {
      const r = await run(args);
      expect(r.code, args.join(' ')).toBe(0);
      expect(r.stdout).toMatch(/^Usage: striart/);
      expect(r.stderr).toBe('');
    }
  });

  it('`help <inconnue>` reste une erreur d’usage nommant la commande', async () => {
    const r = await run(['help', 'zzz']);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('UNKNOWN_COMMAND');
    expect(r.stderr).toContain('"zzz"');
    expect(r.stderr).not.toContain('MISSING_COMMAND');
  });

  it('aucune commande : toujours une erreur d’usage (2)', async () => {
    const r = await run([]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('MISSING_COMMAND');
  });
});

describe('CLI — hors terminal et formats', () => {
  it('--version --json : un document du contrat (schemaVersion, command, ok, data)', async () => {
    const r = await run(['--version', '--json']);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({
      schemaVersion: 1,
      command: 'version',
      ok: true,
      data: { version },
    });
    expect((await run(['--version'])).stdout.trim()).toBe(version);
  });

  it('STRIART_ASCII=1 : l’aide racine n’a ni flèche, ni points de suspension, ni tiret long', async () => {
    const r = await run(['--help'], { env: { STRIART_ASCII: '1' } });
    expect(r.code).toBe(0);
    expect(r.stdout).not.toMatch(/[→…—’]/);
  });

  it('completion : en-tête dans la langue choisie, énumérations proposées depuis les .choices()', async () => {
    const en = await run(['completion', 'bash']);
    expect(en.stdout.split('\n')[0]).toBe(
      '# striart — bash completion. Install: striart completion bash >> ~/.bashrc',
    );
    expect(en.stdout).toContain('--on-failure) COMPREPLY=( $(compgen -W "stop skip-dependents"');
    expect(en.stdout).toContain('--quorum) COMPREPLY=( $(compgen -W "all any majority"');
    const fr = await run(['completion', 'bash'], { env: { STRIART_LANG: 'fr' } });
    expect(fr.stdout.split('\n')[0]).toContain('complétion bash');
    for (const shell of ['zsh', 'fish', 'powershell']) {
      const r = await run(['completion', shell]);
      expect(r.stdout, shell).toContain('skip-dependents');
      expect(r.stdout, shell).toContain('first-green');
    }
    // Le script PowerShell reste ASCII (page de code ANSI de Windows PowerShell 5.1).
    const script = (await run(['completion', 'powershell'])).stdout;
    expect([...script].filter((c) => c.charCodeAt(0) > 127)).toEqual([]);
  });

  it('hook install <outil inconnu> : erreur d’usage (2), comme les autres valeurs invalides', async () => {
    const r = await run(['hook', 'install', 'zzz', '--user']);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('HOOK_TOOL_UNKNOWN');
  });
});

describe('CLI — dépôt initialisé', () => {
  let repo;

  beforeEach(async () => {
    repo = await createTempRepo();
    await initStriart(repo.root);
  });

  afterEach(async () => {
    await repo.cleanup();
  });

  it('A3 — review d’une demande inexistante dans un dépôt fraîchement initialisé : relecture inconnue, pas NOT_INITIALIZED', async () => {
    const r = await run(['review', 'rev-0123456789ab', '--approve'], { cwd: repo.root });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('REVIEW_UNKNOWN');
    expect(r.stderr).not.toContain('NOT_INITIALIZED');
    expect(r.stderr).not.toContain('striart init');
  });

  it('A3 — le domaine : answerHumanReview sans dossier reviews/ → REVIEW_UNKNOWN', async () => {
    await expect(
      answerHumanReview(repo.root, 'rev-0123456789ab', { verdict: 'approve' }),
    ).rejects.toMatchObject({ code: 'REVIEW_UNKNOWN' });
  });

  it('A3 — updateJsonLocked sur un enregistrement absent d’un dossier absent : le mutateur juge, pas le verrou', async () => {
    const file = path.join(repo.root, '.striart', 'nope', 'x.json');
    await expect(
      updateJsonLocked(file, { fallback: null }, (current) => {
        expect(current).toBeNull();
        return UNCHANGED;
      }),
    ).resolves.toBeNull();
    // Écrire dans un dossier absent : erreur de verrou EXACTE (pas « lance striart init »).
    const error = await updateJsonLocked(file, { fallback: null }, () => ({ a: 1 })).catch(
      (e) => e,
    );
    expect(error.code).toBe('STATE_LOCK_FAILED');
    expect(error.details.cause).toBe('ENOENT');
  });

  it('A3 — le dossier d’état RACINE absent reste NOT_INITIALIZED, avec la racine du dépôt', async () => {
    const bare = path.join(repo.root, 'ailleurs');
    await mkdir(bare, { recursive: true });
    const error = await updateJsonLocked(
      path.join(bare, '.striart', 'queue.json'),
      { fallback: [] },
      () => [1],
    ).catch((e) => e);
    expect(error.code).toBe('NOT_INITIALIZED');
    expect(error.details.root).toBe(bare);
  });

  it('A5 — watch --no-merge : la bannière va sur stderr, stdout reste vide', async () => {
    const r = await run(['watch', '--no-merge'], {
      cwd: repo.root,
      killOnStderr: /watcher running/,
    });
    expect(r.stderr).toContain('watcher running');
    expect(r.stdout).toBe('');
  });

  it('(iv) mcp dans un dépôt non initialisé : refus net comme `api`, pas un serveur muet', async () => {
    const bare = await createTempRepo();
    try {
      const mcp = await run(['mcp'], { cwd: bare.root });
      expect(mcp.code).toBe(1);
      expect(mcp.stderr).toContain('NOT_INITIALIZED');
      expect(mcp.stdout).toBe('');
      const api = await run(['api', '--stdio'], { cwd: bare.root });
      expect(api.code).toBe(1);
      expect(api.stderr).toContain('NOT_INITIALIZED');
    } finally {
      await bare.cleanup();
    }
  });

  it('(v) resolve --close sur un ticket déjà résolu : refus (3), comme --apply', async () => {
    const ticket = await createConflictTicket(repo.root, {
      agent: 'agent-a',
      branch: 'striart/agent-a/task-x',
      sha: 'b'.repeat(40),
      reason: 'MERGE_CONFLICT',
      conflictedFiles: ['src/a.ts'],
      resolutions: [{ path: 'src/a.ts', base: 'b', ours: 'o', theirs: 't', llmAttempt: null }],
    });
    const first = await run(['resolve', '--close', ticket.id], { cwd: repo.root });
    expect(first.code).toBe(0);
    const second = await run(['resolve', '--close', ticket.id], { cwd: repo.root });
    expect(second.code).toBe(3);
    expect(second.stderr).toContain('TICKET_ALREADY_RESOLVED');
  });

  it('couleur — FORCE_COLOR=1 TERM=dumb : status, queue, lock et resolve colorent de la même façon', async () => {
    const env = { FORCE_COLOR: '1', TERM: 'dumb' };
    const results = {};
    for (const cmd of ['status', 'queue', 'lock', 'resolve']) {
      const r = await run([cmd], { cwd: repo.root, env });
      // eslint-disable-next-line no-control-regex -- séquence ANSI
      results[cmd] = /\u001B\[/.test(r.stdout);
    }
    expect(results).toEqual({ status: true, queue: true, lock: true, resolve: true });
    const none = { ...env, NO_COLOR: '1' };
    for (const cmd of ['status', 'lock']) {
      const r = await run([cmd], { cwd: repo.root, env: none });
      // eslint-disable-next-line no-control-regex
      expect(/\u001B\[/.test(r.stdout), cmd).toBe(false);
    }
  });
});

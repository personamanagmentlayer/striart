import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CLI = fileURLToPath(new URL('../../src/cli.js', import.meta.url));

function run(args, { cwd, env = {} }) {
  return new Promise((resolve, reject) => {
    const base = { ...process.env, STRIART_LANG: 'fr' };
    for (const k of ['NODE_OPTIONS', 'MYCO_TOKEN', 'STRIART_CONFIG_HOME']) delete base[k];
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd,
      env: { ...base, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    let stdout = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stderr, stdout }));
  });
}

describe('.env de la racine du dépôt : liste blanche (S-I1)', () => {
  let root;
  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'striart-env-'));
    await mkdir(path.join(root, '.git'));
    await writeFile(
      path.join(root, '.env'),
      'NODE_OPTIONS=--require ./evil.js\nSTRIART_NATIVE_BIN=/proc/self/cwd/x\nOPENAI_API_KEY=sk-secret-value\n',
    );
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('signale les noms refusés, jamais les valeurs', async () => {
    const r = await run(['--version'], { cwd: root });
    expect(r.code).toBe(0);
    expect(r.stderr).toContain('NODE_OPTIONS');
    expect(r.stderr).toContain('STRIART_NATIVE_BIN');
    expect(r.stderr).not.toContain('OPENAI_API_KEY');
    expect(r.stderr).not.toContain('evil.js');
    expect(r.stderr).not.toContain('sk-secret-value');
  });

  it('une config utilisateur étend la liste blanche, la liste noire reste refusée', async () => {
    const home = path.join(root, 'cfg');
    await mkdir(home);
    await writeFile(
      path.join(home, 'config.json'),
      JSON.stringify({ env: { allow: ['MYCO_*'] } }),
      { mode: 0o600 },
    );
    await writeFile(path.join(root, '.env'), 'MYCO_TOKEN=a\nNODE_OPTIONS=--x\n');
    const r = await run(['--version'], { cwd: root, env: { STRIART_CONFIG_HOME: home } });
    expect(r.stderr).toContain('NODE_OPTIONS');
    expect(r.stderr).not.toContain('MYCO_TOKEN');
  });

  it('ne charge pas le .env dans un clone d agent', async () => {
    const clone = path.join(root, '.striart', 'agents', 'agent-a');
    await mkdir(path.join(clone, '.git'), { recursive: true });
    await writeFile(path.join(clone, '.env'), 'NODE_OPTIONS=--x\n');
    const r = await run(['--version'], { cwd: clone });
    expect(r.stderr).not.toContain('NODE_OPTIONS');
  });
});

describe('plan humain : commandes décisionnelles refusées en session d agent (S-I2)', () => {
  it.each(['resolve', 'merge', 'stop', 'lock', 'rollback', 'promote', 'gc'])(
    '%s refusé sous STRIART_SESSION=1 (CONTROL_NESTED_SESSION, sortie 3)',
    async (name) => {
      const cwd = await mkdtemp(path.join(os.tmpdir(), 'striart-hp-'));
      try {
        const needsAgent = name === 'merge' || name === 'stop';
        const r = await run([name, ...(needsAgent ? ['agent-a'] : []), '--json'], {
          cwd,
          env: { STRIART_SESSION: '1' },
        });
        expect(r.code).toBe(3);
        expect(r.stdout).toContain('CONTROL_NESTED_SESSION');
      } finally {
        await rm(cwd, { recursive: true, force: true });
      }
    },
  );
});

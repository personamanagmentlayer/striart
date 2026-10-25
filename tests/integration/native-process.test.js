// Primitives natives contre de vrais process de l'OS : identité groupée
// (heure de création, recyclage), kill d'arbre (petit-fils orphelin compris),
// conteneur de process `job run` (orphelins, flux, délai).
// Binaire construit par tests/helpers/native-setup.js (globalSetup).
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { nativeProcessInfo, nativeTreeKill, startNativeJob } from '../../src/native.ts';
import { checkProcessInstance, readProcessChain } from '../../src/process-info.ts';
import { isProcessAlive, killProcessTree } from '../../src/process-tree.js';
import { requireNativeBuild } from '../helpers/native-build.js';
import { REPO_ROOT } from '../helpers/native.js';

// Échec explicite (sortie cargo) si le binaire natif ne compile pas.
beforeAll(() => requireNativeBuild(REPO_ROOT));

const node = process.execPath;
const cleanups = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()();
});

async function tempDir() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'striart-native-proc-'));
  cleanups.push(() => rm(dir, { recursive: true, force: true, maxRetries: 3 }));
  return dir;
}

async function waitFor(predicate, ms = 10_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await predicate()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return predicate();
}

const dead = (pid) => waitFor(() => !isProcessAlive(pid));

/**
 * Script node qui lance un petit-fils dormeur, écrit son PID, puis dort ou sort.
 * Sous Windows, le petit-fils est lancé `detached` : sinon libuv le place
 * dans son propre Job Object (KILL_ON_JOB_CLOSE) et il meurt avec son parent —
 * il ne deviendrait jamais orphelin. Sous POSIX il reste dans le groupe de
 * son parent, comme un processus de test ordinaire.
 */
async function spawnerScript(dir, { exitAfterSpawn }) {
  const file = path.join(dir, 'spawner.mjs');
  await writeFile(
    file,
    `import { spawn } from 'node:child_process';
const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1e9)'], {
  stdio: 'ignore',
  detached: ${process.platform === 'win32'},
});
child.unref();
process.stdout.write(String(child.pid) + '\\n');
${exitAfterSpawn ? 'setTimeout(() => process.exit(0), 50);' : 'setInterval(() => {}, 1e9);'}
`,
  );
  return file;
}

function firstLine(stream) {
  return new Promise((resolve, reject) => {
    let buffer = '';
    stream.on('data', (chunk) => {
      buffer += chunk;
      const nl = buffer.indexOf('\n');
      if (nl !== -1) resolve(buffer.slice(0, nl).trim());
    });
    stream.on('error', reject);
    stream.on('end', () =>
      reject(new Error(`flux fermé avant une ligne complète : ${JSON.stringify(buffer)}`)),
    );
  });
}

function killLater(pid) {
  cleanups.push(async () => {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // Déjà mort : c'est l'issue attendue du test.
    }
  });
}

describe('proc info (lecture groupée)', () => {
  it('plusieurs PID en un appel, heure de création cohérente, absents omis', async () => {
    const before = Date.now();
    const child = spawn(node, ['-e', 'setInterval(() => {}, 1e9)'], { stdio: 'ignore' });
    killLater(child.pid);
    await waitFor(() => isProcessAlive(child.pid));
    const records = await nativeProcessInfo([process.pid, child.pid, 4294967294]);
    const mine = records.find((r) => r.pid === child.pid);
    expect(records.find((r) => r.pid === process.pid)?.name.toLowerCase()).toMatch(/node/);
    expect(mine.commandLine).toContain('setInterval');
    expect(mine.ppid).toBe(process.pid);
    // Création entre le lancement et maintenant (tolérance d'horloge 1 s).
    expect(mine.startTimeMs).toBeGreaterThanOrEqual(before - 1_000);
    expect(mine.startTimeMs).toBeLessThanOrEqual(Date.now() + 1_000);
    expect(records.some((r) => r.pid === 4294967294)).toBe(false);
  });

  it('chaîne d’ancêtres : le process courant puis son parent', async () => {
    const chain = await readProcessChain(process.pid, 2);
    expect(chain[0].pid).toBe(process.pid);
    expect(chain[0].startTimeMs).not.toBeNull();
    if (chain[1]) expect(chain[1].pid).toBe(process.ppid);
  });
});

describe('checkProcessInstance — recyclage de PID démasqué par l’heure de création', () => {
  it('même ligne de commande, mais créé après la publication → foreign ; sinon alive', async () => {
    const dir = await tempDir();
    const cli = path.join(dir, 'cli.js');
    await writeFile(cli, 'setInterval(() => {}, 1e9);\n');
    const child = spawn(node, [cli, 'watch'], { stdio: 'ignore' });
    killLater(child.pid);
    await waitFor(() => isProcessAlive(child.pid));
    const expected = { scriptName: 'cli.js', args: ['watch'] };
    // PID file « publié » une heure avant la naissance du process : celui qui
    // porte ce numéro aujourd'hui ne peut pas être le publié.
    const longAgo = new Date(Date.now() - 3_600_000).toISOString();
    expect(
      await checkProcessInstance(child.pid, { ...expected, startedAt: longAgo }, { cache: false }),
    ).toBe('foreign');
    const now = new Date().toISOString();
    expect(
      await checkProcessInstance(child.pid, { ...expected, startedAt: now }, { cache: false }),
    ).toBe('alive');
  });
});

describe('proc tree-kill', () => {
  it('arbre vivant : racine et petit-fils tués', async () => {
    const dir = await tempDir();
    const script = await spawnerScript(dir, { exitAfterSpawn: false });
    const root = spawn(node, [script], { stdio: ['ignore', 'pipe', 'ignore'] });
    killLater(root.pid);
    const grandchild = Number(await firstLine(root.stdout));
    killLater(grandchild);
    await killProcessTree(root);
    expect(await dead(root.pid)).toBe(true);
    expect(await dead(grandchild)).toBe(true);
  });

  it('racine déjà morte : son petit-fils orphelin est tué grâce à son heure de création', async () => {
    const dir = await tempDir();
    const script = await spawnerScript(dir, { exitAfterSpawn: true });
    // POSIX : groupe propre, comme les subprocess `detached` de Striart.
    const root = spawn(node, [script], {
      stdio: ['ignore', 'pipe', 'ignore'],
      detached: process.platform !== 'win32',
    });
    const [record] = await nativeProcessInfo([root.pid]);
    const grandchild = Number(await firstLine(root.stdout));
    killLater(grandchild);
    await new Promise((resolve) => root.on('exit', resolve));
    expect(await dead(root.pid)).toBe(true);
    expect(isProcessAlive(grandchild)).toBe(true);
    const result = await nativeTreeKill(root.pid, { rootStartedMs: record.startTimeMs });
    expect(result.rootState).toBe('dead');
    expect(result.killed.map((k) => k.pid)).toContain(grandchild);
    expect(await dead(grandchild)).toBe(true);
  });
});

describe('job run (conteneur de process)', () => {
  it('orphelin vivant après le délai de grâce : compté, tué, rapporté', async () => {
    const dir = await tempDir();
    const script = await spawnerScript(dir, { exitAfterSpawn: true });
    const job = await startNativeJob({ argv: [node, script], cwd: dir, graceMs: 300 });
    const orphan = Number(await firstLine(job.subprocess.stdout));
    killLater(orphan);
    const report = await job.report;
    expect(report.exitCode).toBe(0);
    expect(report.timedOut).toBe(false);
    expect(report.orphansKilled).toBe(1);
    expect(report.orphanPids).toEqual([orphan]);
    expect(await dead(orphan)).toBe(true);
  });

  it('descendant qui finit seul dans le délai de grâce : pas un orphelin', async () => {
    const dir = await tempDir();
    const file = path.join(dir, 'short.mjs');
    await writeFile(
      file,
      `import { spawn } from 'node:child_process';
spawn(process.execPath, ['-e', 'setTimeout(() => {}, 300)'], { stdio: 'ignore' }).unref();
`,
    );
    const job = await startNativeJob({ argv: [node, file], cwd: dir, graceMs: 5_000 });
    const report = await job.report;
    expect(report.orphansKilled).toBe(0);
  });

  it('flux relayés au fil de l’eau, sans attendre la fin du programme', async () => {
    const dir = await tempDir();
    const file = path.join(dir, 'stream.mjs');
    await writeFile(
      file,
      `process.stdout.write('ready\\n');
setTimeout(() => { process.stdout.write('done\\n'); }, 2000);
`,
    );
    const job = await startNativeJob({ argv: [node, file], cwd: dir, graceMs: 0 });
    let settled = false;
    void job.report.then(() => {
      settled = true;
    });
    expect(await firstLine(job.subprocess.stdout)).toBe('ready');
    // « ready » est arrivé alors que le programme tourne encore.
    expect(settled).toBe(false);
    const result = await job.subprocess;
    expect(result.stdout).toContain('done');
    expect((await job.report).exitCode).toBe(0);
  });

  it('délai dépassé : tout le conteneur est tué, timedOut', async () => {
    const dir = await tempDir();
    const script = await spawnerScript(dir, { exitAfterSpawn: false });
    const started = Date.now();
    const job = await startNativeJob({
      argv: [node, script],
      cwd: dir,
      graceMs: 0,
      // Assez long pour que node démarre et lance le petit-fils sur une
      // machine chargée ; le délai, lui, est vérifié par timedOut.
      timeoutMs: 6_000,
    });
    const grandchild = Number(await firstLine(job.subprocess.stdout));
    killLater(grandchild);
    const report = await job.report;
    expect(report.timedOut).toBe(true);
    expect(report.killedOnTimeout).toBeGreaterThanOrEqual(2);
    expect(Date.now() - started).toBeLessThan(30_000);
    expect(await dead(grandchild)).toBe(true);
  });

  it('commande shell (Test Gate) : cmd.exe verbatim sous Windows, sh -c ailleurs', async () => {
    const dir = await tempDir();
    const command = `"${node}" -e "process.stdout.write('via-shell'); process.exit(3)"`;
    const argv =
      process.platform === 'win32'
        ? [process.env.ComSpec ?? 'cmd.exe', '/d', '/s', '/c', `"${command}"`]
        : ['/bin/sh', '-c', command];
    const job = await startNativeJob({
      argv,
      cwd: dir,
      graceMs: 0,
      windowsVerbatimArguments: process.platform === 'win32',
    });
    const result = await job.subprocess;
    expect(result.stdout).toContain('via-shell');
    expect((await job.report).exitCode).toBe(3);
  });

  it('programme introuvable : NATIVE_COMMAND_FAILED avec le code natif SPAWN_FAILED', async () => {
    const dir = await tempDir();
    const job = await startNativeJob({
      argv: ['striart-no-such-program-xyz'],
      cwd: dir,
      graceMs: 0,
    });
    const error = await job.report.then(
      () => null,
      (e) => e,
    );
    expect(error?.code).toBe('NATIVE_COMMAND_FAILED');
    expect(error.details.nativeCode).toBe('SPAWN_FAILED');
  });
});

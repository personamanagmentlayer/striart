import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execa } from 'execa';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readJson, sweepOrphanTempFiles, updateJsonLocked } from '../../src/json-file.js';
import { readStateLockStatus } from '../../src/state-lock.ts';
import { readQueue } from '../../src/queue.js';
import { readMainSession, startMainSession, stopMainSession } from '../../src/main-session.js';
import {
  closeConflictTicket,
  listConflictTickets,
  prepareResolutionScaffold,
  readResolutionInputs,
  readTicketDetail,
} from '../../src/conflicts.js';
import { createRotatingFileSink, rotateLogFileIfNeeded } from '../../src/log-rotation.ts';

const WORKER = fileURLToPath(new URL('../helpers/state-worker.mjs', import.meta.url));
const DEAD_PID = 0x7fffffff;

/** @returns {Promise<{errors: Record<string, number>, done: number}>} */
async function runWorker(mode, target, id, iterations, env = {}) {
  const { stdout } = await execa(process.execPath, [WORKER, mode, target, id, String(iterations)], {
    env,
  });
  const line = stdout.split('\n').find((l) => l.startsWith('RESULT '));
  return JSON.parse(line.slice('RESULT '.length));
}

describe('fichiers d’état — concurrence entre process', () => {
  let root;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'striart-state-'));
    await mkdir(path.join(root, '.striart'), { recursive: true });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true, maxRetries: 5 }).catch(() => {});
  });

  it.runIf(process.platform === 'win32')(
    'Windows : un écrivain et un lecteur en boucle — 0 échec de part et d’autre',
    async () => {
      const file = path.join(root, '.striart', 'agents.json');
      await writeFile(file, '{}\n');
      const [writer, reader] = await Promise.all([
        runWorker('write', file, 'w', 150),
        runWorker('readJson', file, 'r', 1500),
      ]);
      expect(writer).toEqual({ errors: {}, done: 150 });
      expect(reader).toEqual({ errors: {}, done: 1500 });
    },
    120_000,
  );

  it('deux process écrivains sur le même fichier : 0 erreur, JSON final valide', async () => {
    const file = path.join(root, '.striart', 'queue.json');
    const [a, b] = await Promise.all([
      runWorker('write', file, 'a', 100),
      runWorker('write', file, 'b', 100),
    ]);
    expect(a.errors).toEqual({});
    expect(b.errors).toEqual({});
    const final = JSON.parse(await readFile(file, 'utf8'));
    expect(['a', 'b']).toContain(final.id);
    // Aucun temporaire ne survit à une écriture réussie.
    expect((await readdir(path.join(root, '.striart'))).filter((n) => n.endsWith('.tmp'))).toEqual(
      [],
    );
  }, 120_000);

  it('aucune mise à jour perdue : deux process enfilent en même temps', async () => {
    const [a, b] = await Promise.all([
      runWorker('enqueue', root, 'a', 40, { STATE_WORKER_PAD: '0' }),
      runWorker('enqueue', root, 'b', 40, { STATE_WORKER_PAD: '0' }),
    ]);
    expect(a.errors).toEqual({});
    expect(b.errors).toEqual({});
    const agents = (await readQueue(root)).map((t) => t.agent);
    expect(agents).toHaveLength(80);
    expect(new Set(agents).size).toBe(80);
  }, 120_000);

  it('aucune mise à jour perdue : deux process modifient deux agents du registre', async () => {
    const registry = {
      a: { branch: 'x', taskId: 't', path: 'p', baseCommit: 'c', predictedFiles: [] },
      b: { branch: 'y', taskId: 't', path: 'p', baseCommit: 'c', predictedFiles: [] },
    };
    await writeFile(path.join(root, '.striart', 'agents.json'), JSON.stringify(registry));
    await Promise.all([
      runWorker('meta', root, 'a', 40, { STATE_WORKER_PAD: '0' }),
      runWorker('meta', root, 'b', 40, { STATE_WORKER_PAD: '0' }),
    ]);
    const final = JSON.parse(await readFile(path.join(root, '.striart', 'agents.json'), 'utf8'));
    expect(final.a.counter).toBe(40);
    expect(final.b.counter).toBe(40);
  }, 120_000);

  it('verrou d’état laissé par un process mort : cassé, la mise à jour passe', async () => {
    const lock = path.join(root, '.striart', 'state.lock');
    await writeFile(lock, `${JSON.stringify({ pid: DEAD_PID, token: 'x', createdAt: 'y' })}\n`);
    expect(await readStateLockStatus(path.join(root, '.striart'))).toMatchObject({
      present: true,
      alive: false,
    });
    const file = path.join(root, '.striart', 'state.json');
    await updateJsonLocked(file, { fallback: {} }, () => ({ ok: true }));
    expect(await readJson(file, { fallback: null })).toEqual({ ok: true });
    await expect(stat(lock)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('verrou d’état tenu par un process VIVANT : jamais cassé, STATE_LOCK_TIMEOUT', async () => {
    const holder = execa(process.execPath, ['-e', 'setTimeout(() => {}, 30000)']);
    try {
      const lock = path.join(root, '.striart', 'state.lock');
      await writeFile(
        lock,
        `${JSON.stringify({ pid: holder.pid, token: 'x', createdAt: new Date().toISOString() })}\n`,
      );
      const { withStateLock } = await import('../../src/state-lock.ts');
      await expect(
        withStateLock(path.join(root, '.striart'), async () => {}, { timeoutMs: 300 }),
      ).rejects.toMatchObject({ code: 'STATE_LOCK_TIMEOUT', details: { pid: holder.pid } });
      expect(JSON.parse(await readFile(lock, 'utf8')).pid).toBe(holder.pid);
    } finally {
      holder.kill();
      await holder.catch(() => {});
    }
  });
});

describe('session principale : retrait conditionnel', () => {
  let root;
  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'striart-ms-'));
    await mkdir(path.join(root, '.striart'), { recursive: true });
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true }).catch(() => {});
  });

  it('expectPid différent : la réservation d’un autre reste en place', async () => {
    await startMainSession(root, { pid: process.pid, reason: 'humain' });
    await stopMainSession(root, { expectPid: process.pid + 1 });
    expect((await readMainSession(root))?.reason).toBe('humain');
    await stopMainSession(root, { expectPid: process.pid });
    expect(await readMainSession(root)).toBeNull();
  });
});

describe('tickets illisibles : listés CORRUPT, jamais ignorés', () => {
  let root;
  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'striart-tk-'));
    await mkdir(path.join(root, '.striart', 'conflicts', 'a-1'), { recursive: true });
    await writeFile(path.join(root, '.striart', 'conflicts', 'a-1', 'ticket.json'), '{ "agent": ');
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true }).catch(() => {});
  });

  it('visible avec sa cause, refusé à la préparation/application, fermable', async () => {
    const [ticket] = await listConflictTickets(root);
    expect(ticket).toMatchObject({
      id: 'a-1',
      status: 'CORRUPT',
      cause: 'INVALID_JSON',
      agent: null,
      sha: null,
      conflictedFiles: [],
      resolved: false,
    });
    for (const call of [readResolutionInputs, prepareResolutionScaffold, readTicketDetail]) {
      await expect(call(root, 'a-1')).rejects.toMatchObject({ code: 'TICKET_CORRUPT' });
    }
    await closeConflictTicket(root, 'a-1');
    expect(await listConflictTickets(root)).toEqual([]);
    expect(await listConflictTickets(root, { includeResolved: true })).toMatchObject([
      { id: 'a-1', status: 'CORRUPT', resolved: true },
    ]);
  });

  it('dossier sans ticket.json : ignoré tant qu’il est récent (création), CORRUPT ensuite', async () => {
    const dir = path.join(root, '.striart', 'conflicts', 'b-2');
    await mkdir(dir);
    expect((await listConflictTickets(root)).map((t) => t.id)).toEqual(['a-1']);
    const old = new Date(Date.now() - 5 * 60_000);
    await utimes(dir, old, old);
    expect(await listConflictTickets(root)).toMatchObject([
      { id: 'b-2', status: 'CORRUPT', cause: 'MISSING' },
      { id: 'a-1', status: 'CORRUPT' },
    ]);
  });
});

describe('temporaires orphelins', () => {
  it('retire ceux d’un PID mort et l’ancien format vieux ; garde ceux d’un écrivain vivant', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'striart-tmp-'));
    try {
      const dead = path.join(dir, `agents.json.${DEAD_PID}.0123456789ab.tmp`);
      const mine = path.join(dir, `queue.json.${process.pid}.0123456789ab.tmp`);
      const legacy = path.join(dir, 'state.json.tmp');
      const agentFile = path.join(dir, 'agents', 'x', `f.${DEAD_PID}.0123456789ab.tmp`);
      await mkdir(path.dirname(agentFile), { recursive: true });
      for (const f of [dead, mine, legacy, agentFile]) await writeFile(f, '{}');
      const old = new Date(Date.now() - 2 * 60_000);
      for (const f of [dead, legacy, agentFile]) await utimes(f, old, old);

      const removed = await sweepOrphanTempFiles(dir, { skip: ['agents'] });
      expect(removed.sort()).toEqual([dead, legacy].sort());
      await expect(stat(mine)).resolves.toBeTruthy();
      await expect(stat(agentFile)).resolves.toBeTruthy(); // worktree d'agent : jamais touché
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('rotation des journaux', () => {
  let dir;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'striart-log-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  });

  it('écrivain : tourne au seuil, garde N générations, la plus ancienne supprimée', async () => {
    const file = path.join(dir, 'watch.log');
    const sink = createRotatingFileSink(file, { maxBytes: 1000, generations: 2 });
    const line = `${'y'.repeat(99)}\n`; // 100 octets
    for (let i = 0; i < 45; i += 1) sink.write(line);
    sink.close();
    const names = (await readdir(dir)).sort();
    expect(names).toEqual(['watch.log', 'watch.log.1', 'watch.log.2']);
    for (const name of names)
      expect((await stat(path.join(dir, name))).size).toBeLessThanOrEqual(1000);
    expect((await stat(file)).size).toBe(500);
  });

  it('au départ : un journal hérité trop gros est tourné, un petit est laissé', async () => {
    const file = path.join(dir, 'dashboard.log');
    await writeFile(file, 'z'.repeat(2000));
    await writeFile(`${file}.1`, 'old');
    expect(await rotateLogFileIfNeeded(file, { maxBytes: 1000, generations: 3 })).toBe(true);
    expect(await readFile(`${file}.2`, 'utf8')).toBe('old');
    expect((await stat(`${file}.1`)).size).toBe(2000);
    await writeFile(file, 'small');
    expect(await rotateLogFileIfNeeded(file, { maxBytes: 1000, generations: 3 })).toBe(false);
  });
});

/**
 * Robustesse du verrou principal (revue L1) — vrais process, vrai disque :
 *  - B1 : un détenteur FIGÉ (vivant, battement arrêté) n'est jamais cassé par
 *    défaut (LOCK_TIMEOUT HOLDER_FROZEN, fichier intact) ; l'option explicite
 *    `lock.breakFrozenHolderAfterMs` l'autorise, cassure journalisée ;
 *  - I1 : les casseurs sont sérialisés (main.lock.break) — jamais deux
 *    process dans la section critique ;
 *  - m1/m3 : contenu invalide ≠ illisible ; erreurs d'E/S de la file nommées ;
 *  - réinscription après perte du ticket ;
 *  - le dashboard ne pousse pas d'état pour l'activité du verrou.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, readFile, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { execa } from 'execa';
import { createTempRepo } from '../helpers/temp-repo.js';
import { initStriart } from '../../src/init.js';
import { withMainLock } from '../../src/lock.js';
import { logger } from '../../src/logger.js';
import { en } from '../../src/cli/i18n/en.ts';
import { startDashboard } from '../../src/dashboard.js';
import { baseUrl, signIn, useLoopbackDashboard } from '../helpers/control-client.js';

const HOLDER = fileURLToPath(new URL('../helpers/lock-holder.mjs', import.meta.url));

function spawnHolder(root, holdMs, label, mode = 'hold', modeArg = '') {
  return execa('node', [HOLDER, root, String(holdMs), label, mode, modeArg], { reject: false });
}

/** Attend que le process enfant soit DANS sa section critique. */
async function untilReady(child) {
  let out = '';
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`jamais prêt : ${out}`)), 30_000);
    child.stdout.on('data', (chunk) => {
      out += chunk;
      if (out.includes('READY')) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.on('exit', () => {
      clearTimeout(timer);
      reject(new Error(`sorti avant READY : ${out}`));
    });
  });
}

async function deadPid() {
  return (await execa('node', ['-e', 'process.exit(0)'])).pid;
}

async function waitFor(predicate, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await predicate();
    if (value) return value;
    if (Date.now() > deadline) throw new Error('condition jamais atteinte');
    await sleep(50);
  }
}

describe('verrou principal — robustesse (intégration)', () => {
  let repo;
  let lockFile;
  let queueDir;
  let breakFile;

  beforeEach(async () => {
    repo = await createTempRepo();
    await initStriart(repo.root);
    await useLoopbackDashboard(repo.root);
    lockFile = path.join(repo.root, '.striart', 'main.lock');
    queueDir = path.join(repo.root, '.striart', 'lock-queue');
    // Verrou de cassure DANS lock-queue/ : déjà ignoré par le watcher du dashboard.
    breakFile = path.join(queueDir, 'break.lock');
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await repo.cleanup();
  });

  /** Détenteur figé (Atomics.wait) dont le battement paraît expiré depuis 5 min. */
  async function frozenHolder(freezeMs) {
    const child = spawnHolder(repo.root, freezeMs, 'merge:fige', 'freeze');
    await untilReady(child);
    await sleep(300); // le détenteur est figé : il ne bat plus
    const info = JSON.parse(await readFile(lockFile, 'utf8'));
    const old = new Date(Date.now() - 5 * 60_000);
    await writeFile(lockFile, `${JSON.stringify({ ...info, heartbeatAt: old.toISOString() })}\n`);
    await utimes(lockFile, old, old);
    return { child, token: info.token };
  }

  it('B1 : détenteur vivant mais figé → JAMAIS cassé par défaut, LOCK_TIMEOUT HOLDER_FROZEN, fichier intact', async () => {
    const { child, token } = await frozenHolder(40_000);
    try {
      const error = await withMainLock(repo.root, 'second', async () => 'jamais', {
        timeoutMs: 20_000,
      }).catch((e) => e);
      expect(error).toMatchObject({
        code: 'LOCK_TIMEOUT',
        details: { reason: 'HOLDER_FROZEN', pid: child.pid, holder: 'merge:fige' },
      });
      expect(error.details.heartbeatAgeMs).toBeGreaterThan(60_000);
      expect(error.hint).toContain(String(child.pid));
      expect(en.errors('LOCK_TIMEOUT', error.details)).toMatch(/frozen/i);
      expect(JSON.parse(await readFile(lockFile, 'utf8')).token).toBe(token);
    } finally {
      child.kill();
      await child;
    }
  });

  it('B1 : option lock.breakFrozenHolderAfterMs → cassure du détenteur figé, journalisée', async () => {
    await writeFile(
      path.join(repo.root, '.striartrc.json'),
      JSON.stringify({ lock: { breakFrozenHolderAfterMs: 60_000 } }),
    );
    const warn = vi.spyOn(logger, 'warn');
    const { child } = await frozenHolder(40_000);
    try {
      const result = await withMainLock(repo.root, 'second', async () => 'acquis', {
        timeoutMs: 30_000,
      });
      expect(result).toBe('acquis');
      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({
          reason: 'FROZEN_HOLDER_BROKEN',
          pid: child.pid,
          breakFrozenHolderAfterMs: 60_000,
        }),
        expect.any(String),
      );
    } finally {
      child.kill();
      await child;
    }
  });

  it('I1 : un casseur en cours (verrou de cassure tenu par un vivant) → personne d’autre ne casse', async () => {
    await mkdir(queueDir, { recursive: true });
    await writeFile(
      lockFile,
      JSON.stringify({ pid: await deadPid(), startedAt: new Date().toISOString(), label: 'crash' }),
    );
    await writeFile(
      breakFile,
      JSON.stringify({ pid: process.pid, token: 'casseur', startedAt: new Date().toISOString() }),
    );
    const error = await withMainLock(repo.root, 'x', async () => 'jamais', {
      timeoutMs: 2000,
    }).catch((e) => e);
    expect(error).toMatchObject({ code: 'LOCK_TIMEOUT', details: { reason: 'BREAK_IN_PROGRESS' } });
    expect(JSON.parse(await readFile(lockFile, 'utf8')).label).toBe('crash');

    // Casseur mort : son verrou de cassure est un débris, la cassure reprend.
    await writeFile(
      breakFile,
      JSON.stringify({ pid: await deadPid(), token: 'mort', startedAt: new Date().toISOString() }),
    );
    expect(await withMainLock(repo.root, 'x', async () => 'acquis', { timeoutMs: 5000 })).toBe(
      'acquis',
    );
    await expect(stat(breakFile)).rejects.toThrow();
  });

  it('I1 : casseurs parallèles sur un détenteur mort → un seul process à la fois dans la section', async () => {
    await writeFile(
      lockFile,
      JSON.stringify({ pid: await deadPid(), startedAt: new Date().toISOString(), label: 'crash' }),
    );
    const witness = path.join(repo.root, '.striart', 'witness');
    const children = [1, 2, 3, 4].map((n) =>
      spawnHolder(repo.root, 300, `probe-${n}`, 'probe', witness),
    );
    const results = await Promise.all(children);
    for (const r of results) {
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain('ACQUIRED');
      expect(r.stdout).not.toContain('OVERLAP');
    }
  });

  it('m1 : contenu invalide récent → tenu (jamais cassé) ; ancien → débris cassé', async () => {
    await writeFile(lockFile, '{"pid": 12');
    await expect(
      withMainLock(repo.root, 'x', async () => 'jamais', { timeoutMs: 1500 }),
    ).rejects.toMatchObject({ code: 'LOCK_TIMEOUT' });
    expect(await readFile(lockFile, 'utf8')).toBe('{"pid": 12');
    const old = new Date(Date.now() - 60_000);
    await utimes(lockFile, old, old);
    expect(await withMainLock(repo.root, 'x', async () => 'acquis', { timeoutMs: 3000 })).toBe(
      'acquis',
    );
  });

  it('m3 : file illisible (lock-queue n’est pas un dossier) → LOCK_IO_FAILED nommée, jamais « personne devant »', async () => {
    await writeFile(queueDir, 'pas un dossier');
    const error = await withMainLock(repo.root, 'x', async () => 'jamais', {
      timeoutMs: 3000,
    }).catch((e) => e);
    expect(error).toMatchObject({ code: 'LOCK_IO_FAILED', details: { operation: 'readdir' } });
    expect(en.errors('LOCK_IO_FAILED', error.details)).toMatch(/lock-queue/);
  });

  it('ticket perdu pendant l’attente (retiré comme orphelin) → réinscription, puis servi', async () => {
    const holder = spawnHolder(repo.root, 15_000, 'occupant');
    await untilReady(holder);
    const waiting = withMainLock(repo.root, 'attente', async () => 'servi', { timeoutMs: 30_000 });
    const [first] = await waitFor(async () => {
      const names = await readdir(queueDir).catch(() => []);
      return names.length > 0 ? names : null;
    });
    const firstToken = JSON.parse(await readFile(path.join(queueDir, first), 'utf8')).token;
    await rm(path.join(queueDir, first));
    // Réinscription : un NOUVEAU ticket (autre jeton ; le numéro peut être
    // réutilisé puisque la file s'est vidée).
    await waitFor(async () => {
      for (const name of await readdir(queueDir).catch(() => [])) {
        const info = await readFile(path.join(queueDir, name), 'utf8')
          .then(JSON.parse)
          .catch(() => null);
        if (info?.token && info.token !== firstToken) return true;
      }
      return false;
    });
    expect(await waiting).toBe('servi');
    await holder;
    expect(await readdir(queueDir)).toEqual([]);
  });

  it('M2 : verrou de cassure d’un PID recyclé (vivant, étranger) ou trop ancien → débris, la cassure reprend', async () => {
    await mkdir(queueDir, { recursive: true });
    const forge = async (record) => {
      await writeFile(
        lockFile,
        JSON.stringify({
          pid: await deadPid(),
          startedAt: new Date().toISOString(),
          label: 'crash',
        }),
      );
      await writeFile(breakFile, JSON.stringify(record));
      const old = new Date(Date.now() - 2 * 60_000);
      await utimes(breakFile, old, old);
    };
    // Sans identité enregistrée : l'âge seul tranche (un verrou de cassure se tient des ms).
    await forge({ pid: process.pid, token: 'ancien', startedAt: new Date().toISOString() });
    expect(await withMainLock(repo.root, 'x', async () => 'acquis', { timeoutMs: 8000 })).toBe(
      'acquis',
    );
    // Identité enregistrée et FOREIGN : un autre programme porte ce PID.
    const foreign = execa('node', ['-e', 'setTimeout(() => {}, 60000)'], { reject: false });
    try {
      await forge({
        pid: foreign.pid,
        token: 'recycle',
        startedAt: new Date().toISOString(),
        script: 'cli.js',
      });
      expect(await withMainLock(repo.root, 'x', async () => 'acquis', { timeoutMs: 8000 })).toBe(
        'acquis',
      );
    } finally {
      foreign.kill();
      await foreign;
    }
  });

  it('M5 : ticket repris au MÊME numéro par un autre process → détecté par le jeton, réinscription, jamais rafraîchi par le timer du premier', async () => {
    const holder = spawnHolder(repo.root, 20_000, 'occupant');
    await untilReady(holder);
    const controller = new AbortController();
    const waiting = withMainLock(repo.root, 'attente', async () => 'jamais', {
      timeoutMs: 60_000,
      signal: controller.signal,
    }).catch((e) => e);
    try {
      const [first] = await waitFor(async () => {
        const names = (await readdir(queueDir).catch(() => [])).filter((n) => n.endsWith('.json'));
        return names.length > 0 ? names : null;
      });
      const ticketFile = path.join(queueDir, first);
      const firstToken = JSON.parse(await readFile(ticketFile, 'utf8')).token;
      // Un autre process (vivant) reprend le MÊME numéro avec son propre jeton.
      await writeFile(
        ticketFile,
        JSON.stringify({ pid: holder.pid, token: 'autre-process', label: 'intrus' }),
      );
      // Le waiter le détecte (jeton) et se réinscrit sous un nouveau jeton.
      await waitFor(async () => {
        for (const name of await readdir(queueDir).catch(() => [])) {
          const info = await readFile(path.join(queueDir, name), 'utf8')
            .then(JSON.parse)
            .catch(() => null);
          if (info?.token && info.token !== firstToken && info.token !== 'autre-process')
            return true;
        }
        return false;
      }, 5_000);
      // Le fichier de l'autre process n'a pas été retouché.
      expect(JSON.parse(await readFile(ticketFile, 'utf8')).token).toBe('autre-process');
    } finally {
      controller.abort();
      expect(await waiting).toMatchObject({ code: 'LOCK_WAIT_CANCELLED' });
      holder.kill();
      await holder;
    }
  });

  it('dashboard : l’activité du verrou (battement, tickets) ne déclenche aucun push d’état', async () => {
    const server = await startDashboard({ root: repo.root, port: 0 });
    try {
      const { cookie } = await signIn(server);
      const res = await fetch(`${baseUrl(server)}/events`, { headers: { Cookie: cookie } });
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      const nextState = async (timeoutMs) => {
        const deadline = Date.now() + timeoutMs;
        for (;;) {
          const end = buffer.indexOf('\n\n');
          if (end !== -1) {
            const frame = buffer.slice(0, end);
            buffer = buffer.slice(end + 2);
            if (/^event: state.changed$/m.test(frame)) return frame;
            continue;
          }
          const left = deadline - Date.now();
          if (left <= 0) return null;
          const chunk = await Promise.race([reader.read(), sleep(left).then(() => null)]);
          if (chunk === null) return null;
          if (chunk.done) return null;
          buffer += decoder.decode(chunk.value, { stream: true });
        }
      };
      expect(await nextState(15_000)).not.toBeNull(); // état initial
      await sleep(1500); // laisse passer les pushes de démarrage
      while ((await nextState(500)) !== null) {
        // vide la file des pushes de démarrage
      }
      await mkdir(queueDir, { recursive: true });
      for (let i = 1; i <= 5; i += 1) {
        await writeFile(path.join(queueDir, `00000000000${i}.json`), '{}');
        await writeFile(lockFile, JSON.stringify({ pid: process.pid, i }));
        await sleep(100);
      }
      await rm(queueDir, { recursive: true, force: true });
      await rm(lockFile, { force: true });
      expect(await nextState(2500)).toBeNull();
      await reader.cancel().catch(() => {});
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});

describe('verrou principal — annulation de l’attente (AbortSignal)', () => {
  let repo;
  let lockFile;
  let queueDir;

  beforeEach(async () => {
    repo = await createTempRepo();
    await initStriart(repo.root);
    await useLoopbackDashboard(repo.root);
    lockFile = path.join(repo.root, '.striart', 'main.lock');
    queueDir = path.join(repo.root, '.striart', 'lock-queue');
  });

  afterEach(async () => {
    await repo.cleanup();
  });

  it('signal déjà annulé → rejet immédiat, rien n’est créé', async () => {
    const fn = vi.fn();
    await expect(
      withMainLock(repo.root, 'x', fn, { signal: AbortSignal.abort() }),
    ).rejects.toMatchObject({ code: 'LOCK_WAIT_CANCELLED', details: { operation: 'x' } });
    expect(fn).not.toHaveBeenCalled();
    await expect(stat(lockFile)).rejects.toThrow();
  });

  it('attente dans ce process annulée → rejet rapide, section du détenteur intacte', async () => {
    let holderDone = false;
    const holder = withMainLock(repo.root, 'occupant', async () => {
      await sleep(1500);
      holderDone = true;
      return 'fini';
    });
    await sleep(100);
    const controller = new AbortController();
    const fn = vi.fn();
    const waiting = withMainLock(repo.root, 'attente', fn, { signal: controller.signal });
    await sleep(200);
    const t0 = Date.now();
    controller.abort();
    await expect(waiting).rejects.toMatchObject({ code: 'LOCK_WAIT_CANCELLED' });
    expect(Date.now() - t0).toBeLessThan(500);
    expect(fn).not.toHaveBeenCalled();
    expect(holderDone).toBe(false);
    expect(await holder).toBe('fini');
    // La file en mémoire n'a gardé aucune trace : un suivant est servi.
    expect(await withMainLock(repo.root, 'suivant', async () => 'ok')).toBe('ok');
  });

  it('attente inter-process annulée → rejet rapide, aucun ticket laissé, verrou de l’autre intact', async () => {
    const holder = spawnHolder(repo.root, 15_000, 'occupant');
    await untilReady(holder);
    try {
      const token = JSON.parse(await readFile(lockFile, 'utf8')).token;
      const controller = new AbortController();
      const waiting = withMainLock(repo.root, 'attente', async () => 'jamais', {
        signal: controller.signal,
        timeoutMs: 30_000,
      });
      await waitFor(async () => (await readdir(queueDir).catch(() => [])).length > 0);
      const t0 = Date.now();
      controller.abort();
      await expect(waiting).rejects.toMatchObject({ code: 'LOCK_WAIT_CANCELLED' });
      expect(Date.now() - t0).toBeLessThan(1000);
      expect((await readdir(queueDir)).filter((n) => n.endsWith('.json'))).toEqual([]);
      expect(JSON.parse(await readFile(lockFile, 'utf8')).token).toBe(token);
      expect(en.errors('LOCK_WAIT_CANCELLED', { operation: 'attente' })).toMatch(/cancelled/);
    } finally {
      holder.kill();
      await holder;
    }
  });

  it('une fois acquis, le signal n’interrompt jamais la section critique', async () => {
    const controller = new AbortController();
    const result = await withMainLock(
      repo.root,
      'section',
      async () => {
        controller.abort();
        await sleep(200);
        return 'section menée à terme';
      },
      { signal: controller.signal },
    );
    expect(result).toBe('section menée à terme');
    await expect(stat(lockFile)).rejects.toThrow();
  });

  it('propagé (suite M7) : start, reuse, clean, run, stop, queue retry, reconcile, rollback, prune, sync-all et run --on-main annulent leur attente du verrou', async () => {
    const { createAgent, reuseAgent, cleanClones } = await import('../../src/clone.js');
    const { runTask, stopAgent, retryQueue, reconcile, rollbackLastMerge, runMainSession } =
      await import('../../src/orchestrator.js');
    const { pruneWorkspace } = await import('../../src/prune.js');
    const { syncAllAgents } = await import('../../src/sync.js');
    // runTask prédit les fichiers (Router, appel LLM) AVANT de prendre le verrou : sans
    // Ollama joignable il échouerait (ROUTER_FAILED) avant d'attendre le verrou.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, json: async () => ({ response: '{"files":["x.js"]}' }) })),
    );
    let release;
    const holder = withMainLock(
      repo.root,
      'occupant',
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    await sleep(100);
    const calls = {
      createAgent: (signal) => createAgent({ root: repo.root, name: 'agent-z', signal }),
      reuseAgent: (signal) => reuseAgent({ root: repo.root, name: 'agent-z', signal }),
      cleanClones: (signal) => cleanClones({ root: repo.root, all: true, signal }),
      runTask: (signal) => runTask({ root: repo.root, prompt: 'x', signal }),
      stopAgent: (signal) => stopAgent({ root: repo.root, agent: 'agent-z', signal }),
      retryQueue: (signal) => retryQueue({ root: repo.root, signal }),
      reconcile: (signal) => reconcile({ root: repo.root, signal }),
      rollbackLastMerge: (signal) => rollbackLastMerge({ root: repo.root, signal }),
      pruneWorkspace: (signal) => pruneWorkspace({ root: repo.root, signal }),
      syncAllAgents: (signal) => syncAllAgents({ root: repo.root, signal }),
      runMainSession: (signal) => runMainSession({ root: repo.root, prompt: 'x', signal }),
    };
    const failures = [];
    try {
      for (const [name, call] of Object.entries(calls)) {
        const controller = new AbortController();
        const pending = call(controller.signal).then(
          () => 'RESOLVED',
          (error) => error,
        );
        await sleep(100);
        controller.abort();
        const outcome = await Promise.race([pending, sleep(3_000).then(() => 'HUNG')]);
        if (outcome?.code !== 'LOCK_WAIT_CANCELLED') {
          failures.push(`${name}: ${outcome?.code ?? outcome}`);
        }
      }
    } finally {
      vi.unstubAllGlobals();
      release();
      await holder;
    }
    expect(failures).toEqual([]);
  });

  it('propagé : merge, resolve --apply, sync et promote annulent leur attente du verrou', async () => {
    const { createAgent } = await import('../../src/clone.js');
    const { applyTicketResolution, mergeAgentCommit, promoteStaging, syncAgentWithMain } =
      await import('../../src/orchestrator.js');
    await createAgent({ root: repo.root, name: 'agent-a' });
    let release;
    const holder = withMainLock(
      repo.root,
      'occupant',
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    await sleep(100);
    try {
      for (const call of [
        (signal) => mergeAgentCommit({ root: repo.root, agent: 'agent-a', signal }),
        (signal) => applyTicketResolution({ root: repo.root, ticketId: 'agent-a-0000', signal }),
        (signal) => syncAgentWithMain({ root: repo.root, agent: 'agent-a', signal }),
        (signal) => promoteStaging({ root: repo.root, signal }),
      ]) {
        const controller = new AbortController();
        const pending = call(controller.signal);
        await sleep(100);
        controller.abort();
        await expect(pending).rejects.toMatchObject({ code: 'LOCK_WAIT_CANCELLED' });
      }
    } finally {
      release();
      await holder;
    }
  });
});

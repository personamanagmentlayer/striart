/**
 * L8 — mesure : `timings` par phase dans le résultat de merge / resolve --apply /
 * promote (ajout additif), `lock:contention` sur le bus, `errorCode` stable d'un
 * conflit sémantique. C'est la mesure AVANT L9 : sans elle, le gain du gate hors
 * verrou ne peut pas être prouvé.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { simpleGit } from 'simple-git';
import { createTempRepo } from '../helpers/temp-repo.js';
import { initStriart } from '../../src/init.ts';
import { createAgent } from '../../src/clone.ts';
import { applyTicketResolution, mergeAgentCommit, promoteStaging } from '../../src/orchestrator.ts';
import { safeFileName } from '../../src/conflicts.ts';
import { onStriartEvent } from '../../src/events.ts';
import { withMainLock } from '../../src/lock.ts';
import { PHASES } from '../../src/timings.ts';

const GATE_OK = 'node -e "process.exit(0)"';
const GATE_SLOW = 'node -e "setTimeout(()=>process.exit(0),400)"';

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

function expectWellFormed(timings) {
  expect(timings.unit).toBe('ms');
  for (const phase of PHASES) {
    expect(typeof timings[phase], phase).toBe('number');
    expect(Number.isFinite(timings[phase]), phase).toBe(true);
    expect(timings[phase], phase).toBeGreaterThanOrEqual(0);
  }
  expect(timings.total).toBeGreaterThan(0);
}

describe('timings par phase (intégration)', () => {
  let repo;
  let agent;

  beforeEach(async () => {
    repo = await createTempRepo();
    await initStriart(repo.root);
    await setConfig(repo.root, { testCommand: GATE_OK, gateContainer: 'process' });
    agent = await createAgent({ root: repo.root, name: 'agent-a' });
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await repo.cleanup();
  });

  it('merge propre : toutes les phases mesurées, gate compris dans le temps de verrou tenu', async () => {
    await setConfig(repo.root, { testCommand: GATE_SLOW, gateContainer: 'process' });
    await commitInAgent(agent, 'feature.js', 'export const x = 1;\n', 'feat: x');

    const result = await mergeAgentCommit({ root: repo.root, agent: 'agent-a' });
    expect(result.status).toBe('MERGED');
    expectWellFormed(result.timings);
    // Le gate dort 400 ms : il est mesuré, et il est TENU sous le verrou (c'est ce que L9 supprimera).
    expect(result.timings.gate).toBeGreaterThanOrEqual(350);
    expect(result.timings.lockHeld).toBeGreaterThanOrEqual(result.timings.gate);
    expect(result.timings.total).toBeGreaterThanOrEqual(result.timings.lockHeld);
    expect(result.timings.merge).toBeGreaterThan(0);
    expect(result.timings.commit).toBeGreaterThan(0);
    // Pas de conflit : aucune fusion sémantique.
    expect(result.timings.semantic).toBe(0);
  });

  it('UP_TO_DATE : timings présents aussi (la mesure ne dépend pas du statut)', async () => {
    const result = await mergeAgentCommit({ root: repo.root, agent: 'agent-a' });
    expect(result.status).toBe('UP_TO_DATE');
    expectWellFormed(result.timings);
    expect(result.timings.gate).toBe(0);
  });

  it('gate rouge : timings présents, gate > 0', async () => {
    await setConfig(repo.root, {
      testCommand: 'node -e "process.exit(1)"',
      gateContainer: 'process',
    });
    await commitInAgent(agent, 'broken.js', 'export const y = 2;\n', 'feat: y');
    const result = await mergeAgentCommit({ root: repo.root, agent: 'agent-a' });
    expect(result.status).toBe('GATE_FAILED');
    expectWellFormed(result.timings);
    expect(result.timings.gate).toBeGreaterThan(0);
  });

  it('attente du verrou : mesurée quand un autre détenteur occupe le principal', async () => {
    await commitInAgent(agent, 'feature.js', 'export const x = 1;\n', 'feat: x');
    let release;
    const hold = new Promise((resolve) => (release = resolve));
    let entered;
    const inside = new Promise((resolve) => (entered = resolve));
    const holder = withMainLock(repo.root, 'autre-operation', async () => {
      entered();
      await hold;
    });
    await inside;
    const pending = mergeAgentCommit({ root: repo.root, agent: 'agent-a' });
    await new Promise((r) => setTimeout(r, 300));
    release();
    await holder;
    const result = await pending;
    expect(result.status).toBe('MERGED');
    expect(result.timings.lockWait).toBeGreaterThanOrEqual(250);
  });

  it('resolve --apply : timings dans le résultat MERGED', async () => {
    await writeFile(path.join(repo.root, 'app.js'), 'const version = "main";\n');
    await repo.git.add(['app.js']);
    await repo.git.commit('feat: version main');
    await commitInAgent(agent, 'app.js', 'const version = "agent";\n', 'feat: version agent');
    await setConfig(repo.root, {
      testCommand: GATE_OK,
      gateContainer: 'process',
      semanticMerge: false,
    });
    const conflict = await mergeAgentCommit({ root: repo.root, agent: 'agent-a' });
    expect(conflict.status).toBe('CONFLICT');
    expectWellFormed(conflict.timings);

    await writeFile(
      path.join(conflict.ticket.dir, `${safeFileName('app.js')}.resolved`),
      'const version = "fusion";\n',
    );
    const applied = await applyTicketResolution({ root: repo.root, ticketId: conflict.ticket.id });
    expect(applied.status).toBe('MERGED');
    expectWellFormed(applied.timings);
  });

  it('promote : timings dans le résultat PROMOTED', async () => {
    const staging = 'striart/staging';
    await repo.git.checkoutLocalBranch(staging);
    await setConfig(repo.root, {
      testCommand: GATE_OK,
      gateContainer: 'process',
      targetBranch: staging,
      mainBranch: 'main',
    });
    const a = await createAgent({ root: repo.root, name: 'agent-p' });
    await commitInAgent(a, 'p.js', 'export const p = 1;\n', 'feat: p');
    expect((await mergeAgentCommit({ root: repo.root, agent: 'agent-p' })).status).toBe('MERGED');
    const promoted = await promoteStaging({ root: repo.root });
    expect(promoted.status).toBe('PROMOTED');
    expectWellFormed(promoted.timings);
    expect(promoted.timings.gate).toBeGreaterThan(0);
  });
});

describe('lock:contention (intégration)', () => {
  let repo;
  beforeEach(async () => {
    repo = await createTempRepo();
    await initStriart(repo.root);
  });
  afterEach(async () => {
    await repo.cleanup();
  });

  it('émet durée, opération en attente, détentrice (nom seulement), file ; jamais d’identifiant d’agent', async () => {
    const seen = [];
    const off = onStriartEvent((_config, event) => {
      if (event.type === 'lock:contention') seen.push(event);
    });
    let release;
    const hold = new Promise((resolve) => (release = resolve));
    let entered;
    const inside = new Promise((resolve) => (entered = resolve));
    const holder = withMainLock(repo.root, 'merge:agent-secret-prompt-slug', async () => {
      entered();
      await hold;
    });
    await inside;
    const waiter = withMainLock(repo.root, 'resolve-apply:ticket-confidentiel', async () => 'ok');
    await new Promise((r) => setTimeout(r, 200));
    release();
    await holder;
    expect(await waiter).toBe('ok');
    // L'émission est asynchrone et hors chemin de décision.
    await vi.waitFor(() => expect(seen.length).toBeGreaterThanOrEqual(1));
    off();

    const event = seen[0];
    expect(event.operation).toBe('resolve-apply');
    expect(event.waitedMs).toBeGreaterThanOrEqual(150);
    expect(event.holder.operation).toBe('merge');
    expect(event.holder.ageMs).toBeGreaterThanOrEqual(150);
    expect(event.queued).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(event)).not.toMatch(/secret-prompt-slug|ticket-confidentiel/);
  });

  it('aucune contention, aucun événement', async () => {
    const seen = [];
    const off = onStriartEvent((_config, event) => {
      if (event.type === 'lock:contention') seen.push(event);
    });
    await withMainLock(repo.root, 'merge:a', async () => 1);
    await withMainLock(repo.root, 'merge:b', async () => 2);
    await new Promise((r) => setTimeout(r, 50));
    off();
    expect(seen).toEqual([]);
  });

  it('un abonné qui throw ne change ni le résultat ni l’acquisition du verrou', async () => {
    const off = onStriartEvent((_config, event) => {
      if (event.type === 'lock:contention') throw new Error('abonné cassé');
    });
    let release;
    const hold = new Promise((resolve) => (release = resolve));
    let entered;
    const inside = new Promise((resolve) => (entered = resolve));
    const holder = withMainLock(repo.root, 'merge:a', async () => {
      entered();
      await hold;
    });
    await inside;
    const waiter = withMainLock(repo.root, 'merge:b', async () => 'ok');
    await new Promise((r) => setTimeout(r, 100));
    release();
    await holder;
    expect(await waiter).toBe('ok');
    off();
  });
});

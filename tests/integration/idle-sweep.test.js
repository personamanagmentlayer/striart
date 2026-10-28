import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTempRepo } from '../helpers/temp-repo.js';
import { initStriart } from '../../src/init.js';
import { createAgent, readRegistry, updateAgentMeta } from '../../src/clone.js';
import { runAutonomousTask } from '../../src/orchestrator.js';
import { onStriartEvent } from '../../src/events.js';
import { isProcessAlive } from '../../src/process-tree.js';
import { createPermissionRequest } from '../../src/permissions.ts';
import { startMainSession, readMainSession } from '../../src/main-session.js';
import { withMainLock } from '../../src/lock.js';
import { sweepIdle } from '../../src/idle/sweep.ts';
import { readIdleState } from '../../src/idle/state.ts';
import { outputBeatPath } from '../../src/idle/paths.ts';

/**
 * GC d'inactivité — vrais clones, vrais process, faux agents. L'horloge du
 * balayage est VIRTUELLE (`now` = maintenant + 3 h) : tous les fichiers réels
 * paraissent vieux de 3 h, sans attendre ni antidater un worktree.
 */
const FAKE_AGENT = fileURLToPath(new URL('../helpers/fake-agent.cjs', import.meta.url));
const GATE_OK = 'node -e "process.exit(0)"';
const HOUR = 3_600_000;
const MIN = 60_000;
/** Délais de fermeture écourtés : le superviseur du faux agent répond en quelques centaines de ms. */
const FAST = { ackWaitMs: 4_000, exitWaitMs: 10_000, termGraceMs: 2_000 };

async function waitFor(fn, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > deadline) throw new Error('condition non atteinte à temps');
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

const exists = async (p) => Boolean(await stat(p).catch(() => null));

describe('GC d’inactivité — balayage (intégration)', () => {
  let repo;
  let userHome;
  const aborts = [];
  const sessions = [];
  const children = [];
  let events;
  let unsubscribe;

  async function setConfig(idle = { action: 'close' }) {
    await writeFile(
      path.join(repo.root, '.striartrc.json'),
      JSON.stringify({
        agentProfiles: { fake: { command: process.execPath, args: [FAKE_AGENT, '{{prompt}}'] } },
        testCommand: GATE_OK,
        idle,
      }),
    );
  }

  async function authorize(roots = [repo.root]) {
    await writeFile(
      path.join(userHome, 'config.json'),
      JSON.stringify({ idle: { closeRoots: roots } }),
    );
  }

  /** Session autonome argv qui ne finit jamais (FAKE_AGENT_MODE=hang), supervisée pour de vrai. */
  async function startHangingSession(agent = 'agent-a') {
    process.env.FAKE_AGENT_MODE = 'hang';
    const ac = new AbortController();
    aborts.push(ac);
    const promise = runAutonomousTask({
      root: repo.root,
      agent,
      prompt: 'tâche qui traîne',
      profile: 'fake',
      signal: ac.signal,
    });
    sessions.push(promise);
    const meta = await waitFor(async () => {
      const m = (await readRegistry(repo.root))[agent];
      return m?.sessionPid && m.sessionOwnerPid && (await exists(outputBeatPath(repo.root, agent)))
        ? m
        : null;
    });
    return { meta, promise };
  }

  function spawnIdleProcess() {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      stdio: 'ignore',
    });
    children.push(child);
    return child;
  }

  const future = (ms = 3 * HOUR) => Date.now() + ms;

  beforeEach(async () => {
    repo = await createTempRepo();
    await initStriart(repo.root);
    userHome = await mkdtemp(path.join(os.tmpdir(), 'striart-userhome-'));
    process.env.STRIART_CONFIG_HOME = userHome;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ response: JSON.stringify({ files: [] }) }),
      })),
    );
    await setConfig();
    await authorize();
    events = [];
    unsubscribe = onStriartEvent((_config, event) => {
      if (event.type.startsWith('idle:')) events.push(event);
    });
  });

  afterEach(async () => {
    unsubscribe();
    for (const ac of aborts.splice(0)) ac.abort();
    await Promise.allSettled(sessions.splice(0));
    for (const child of children.splice(0)) {
      try {
        child.kill('SIGKILL');
      } catch {
        // déjà mort
      }
    }
    delete process.env.FAKE_AGENT_MODE;
    delete process.env.STRIART_CONFIG_HOME;
    vi.unstubAllGlobals();
    await rm(userHome, { recursive: true, force: true }).catch(() => undefined);
    await repo.cleanup();
  });

  it('session vivante inactive : avertie, puis fermée proprement APRÈS la grâce ; clone et travail conservés', async () => {
    const { meta, promise } = await startHangingSession();
    await writeFile(path.join(meta.path, 'travail-en-cours.txt'), 'pas commité\n');
    const t0 = future();

    // 1. Détection + avertissement, aucune fermeture.
    const first = await sweepIdle({ root: repo.root, now: t0, timings: FAST });
    expect(first.agents).toHaveLength(1);
    expect(first.agents[0]).toMatchObject({
      agent: 'agent-a',
      state: 'idle',
      session: 'live',
      host: 'process',
    });
    expect(first.warned).toEqual(['agent-a']);
    expect(first.closed).toEqual([]);
    expect(isProcessAlive(meta.sessionPid)).toBe(true);
    expect((await readIdleState(repo.root)).agents['agent-a'].warnedAt).toBeTruthy();
    expect(events.map((e) => e.type)).toEqual(['idle:detected', 'idle:warned']);

    // 2. Pendant la grâce : toujours rien, et pas de second avertissement.
    const during = await sweepIdle({ root: repo.root, now: t0 + MIN, timings: FAST });
    expect(during.warned).toEqual([]);
    expect(during.closed).toEqual([]);
    expect(during.agents[0].stage).toBe('warned');
    expect(isProcessAlive(meta.sessionPid)).toBe(true);

    // 3. Grâce écoulée : fermeture propre par le superviseur de la session.
    const after = await sweepIdle({ root: repo.root, now: t0 + 6 * MIN, timings: FAST });
    expect(after.closed).toEqual([{ agent: 'agent-a', host: 'process', code: 'CLOSED' }]);
    expect(after.refused).toEqual([]);
    expect(events.map((e) => e.type)).toEqual(['idle:detected', 'idle:warned', 'idle:closed']);
    await waitFor(() => !isProcessAlive(meta.sessionPid));

    // 4. Le cycle autonome voit une session annulée et GARDE le clone.
    const result = await promise;
    expect(result.session.status).toBe('CANCELLED');
    expect(result.cleaned).toBe(false);
    expect(await readFile(path.join(meta.path, 'travail-en-cours.txt'), 'utf8')).toBe(
      'pas commité\n',
    );
    expect((await readRegistry(repo.root))['agent-a']).toBeTruthy();
    expect(await readFile(result.session.logPath, 'utf8')).toContain(
      "fermée par le GC d'inactivité",
    );
    // Aucun merge automatique : rien n'est arrivé dans main.
    expect(await exists(path.join(repo.root, 'travail-en-cours.txt'))).toBe(false);
  });

  it('--dry-run ne change rien : ni état, ni événement, ni process', async () => {
    const { meta } = await startHangingSession();
    const report = await sweepIdle({ root: repo.root, now: future(), dryRun: true });
    expect(report.dryRun).toBe(true);
    expect(report.agents[0]).toMatchObject({ state: 'idle', plan: 'warn' });
    expect(report.warned).toEqual([]);
    expect(await exists(path.join(repo.root, '.striart', 'idle', 'state.json'))).toBe(false);
    expect(events).toEqual([]);
    expect(isProcessAlive(meta.sessionPid)).toBe(true);
  });

  it.each([
    ['sortie de l’agent', (meta, at) => utimes(outputBeatPath(repo.root, 'agent-a'), at, at)],
    [
      'écriture du worktree',
      async (meta, at) => {
        const file = path.join(meta.path, 'edition.txt');
        await writeFile(file, 'x');
        await utimes(file, at, at);
      },
    ],
    ['commits/refs', (meta, at) => utimes(path.join(meta.path, '.git', 'logs', 'HEAD'), at, at)],
    [
      'message entrant',
      async (meta, at) => {
        const file = path.join(meta.path, '.striart-inbox.md');
        await writeFile(file, 'bonjour');
        await utimes(file, at, at);
      },
    ],
  ])(
    'un SEUL signal frais (%s) garde l’agent actif : ni avertissement ni fermeture',
    async (_label, touch) => {
      const { meta } = await startHangingSession();
      const now = future();
      const recent = new Date(now - 2 * MIN);
      await touch(meta, recent);
      const report = await sweepIdle({ root: repo.root, now, timings: FAST });
      expect(report.agents[0].state).toBe('active');
      expect(report.agents[0].plan).toBe('none');
      expect(report.warned).toEqual([]);
      expect(report.closed).toEqual([]);
      expect(isProcessAlive(meta.sessionPid)).toBe(true);
    },
  );

  it('signal illisible ou manquant (battement de sortie absent) : actif, jamais fermé (fail closed)', async () => {
    const { meta } = await startHangingSession();
    await rm(outputBeatPath(repo.root, 'agent-a'), { force: true });
    const t0 = future();
    for (const at of [t0, t0 + 6 * MIN, t0 + 12 * MIN]) {
      const report = await sweepIdle({ root: repo.root, now: at, timings: FAST });
      expect(report.agents[0].state).toBe('active');
      expect(report.agents[0].reasons).toContain('SIGNAL_UNKNOWN:sessionOutput');
      expect(report.closed).toEqual([]);
    }
    expect(isProcessAlive(meta.sessionPid)).toBe(true);
  });

  it('demande de permission en attente : agent protégé, jamais averti ni fermé', async () => {
    const { meta } = await startHangingSession();
    await createPermissionRequest(repo.root, {
      agent: 'agent-a',
      taskId: meta.taskId,
      title: 'Run npm test',
      options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }],
      timeoutMs: 10 * HOUR,
    });
    const t0 = future();
    for (const at of [t0, t0 + 6 * MIN]) {
      const report = await sweepIdle({ root: repo.root, now: at, timings: FAST });
      expect(report.agents[0].state).toBe('protected');
      expect(report.agents[0].blockers).toContain('HUMAN_REQUEST');
      expect(report.warned).toEqual([]);
      expect(report.closed).toEqual([]);
    }
    expect(isProcessAlive(meta.sessionPid)).toBe(true);
  });

  it('merge en cours sur l’agent (verrou principal) : protégé', async () => {
    const { meta } = await startHangingSession();
    const report = await withMainLock(repo.root, 'merge:agent-a', () =>
      sweepIdle({ root: repo.root, now: future(), timings: FAST }),
    );
    expect(report.agents[0].state).toBe('protected');
    expect(report.agents[0].blockers).toContain('MERGE_IN_PROGRESS');
    expect(isProcessAlive(meta.sessionPid)).toBe(true);
  });

  it('agent d’un plan d’orchestration (collab) : protégé', async () => {
    await createAgent({ root: repo.root, name: 'team-a', mode: 'autonomous', profile: 'fake' });
    const child = spawnIdleProcess();
    await updateAgentMeta(repo.root, 'team-a', {
      sessionPid: child.pid,
      sessionStartedAt: new Date().toISOString(),
      collab: { group: 'team-0123456789ab', role: 'dev' },
    });
    const report = await sweepIdle({ root: repo.root, now: future(), timings: FAST });
    const entry = report.agents.find((a) => a.agent === 'team-a');
    expect(entry.blockers).toContain('ORCHESTRATED');
    expect(entry.plan).toBe('none');
    expect(isProcessAlive(child.pid)).toBe(true);
  });

  it('session du repo principal : jamais fermée, même si un agent en partage le PID', async () => {
    await createAgent({ root: repo.root, name: 'agent-m', mode: 'autonomous', profile: 'fake' });
    const child = spawnIdleProcess();
    await startMainSession(repo.root, { pid: child.pid, reason: 'édition humaine' });
    await updateAgentMeta(repo.root, 'agent-m', {
      sessionPid: child.pid,
      sessionOwnerPid: 0x7ffffff0,
      sessionStartedAt: new Date().toISOString(),
    });
    const t0 = future();
    await sweepIdle({ root: repo.root, now: t0, timings: FAST });
    const report = await sweepIdle({ root: repo.root, now: t0 + 6 * MIN, timings: FAST });
    expect(report.agents[0].blockers).toContain('MAIN_SESSION');
    expect(report.closed).toEqual([]);
    expect(isProcessAlive(child.pid)).toBe(true);
    expect((await readMainSession(repo.root)).pid).toBe(child.pid);
  });

  it('PID non identifiable (aucun superviseur enregistré) : AUCUN kill, refus IDLE_CLOSE_UNVERIFIED', async () => {
    await createAgent({ root: repo.root, name: 'agent-p', mode: 'autonomous', profile: 'fake' });
    const child = spawnIdleProcess();
    await mkdir(path.dirname(outputBeatPath(repo.root, 'agent-p')), { recursive: true });
    await writeFile(outputBeatPath(repo.root, 'agent-p'), '');
    await updateAgentMeta(repo.root, 'agent-p', {
      sessionPid: child.pid,
      sessionStartedAt: new Date().toISOString(),
    });
    const t0 = future();
    await sweepIdle({ root: repo.root, now: t0, timings: FAST });
    const report = await sweepIdle({ root: repo.root, now: t0 + 6 * MIN, timings: FAST });
    expect(report.closed).toEqual([]);
    expect(report.refused).toEqual([
      {
        agent: 'agent-p',
        host: 'process',
        code: 'IDLE_CLOSE_UNVERIFIED',
        detail: 'NO_SUPERVISOR_RECORD',
      },
    ]);
    expect(isProcessAlive(child.pid)).toBe(true);
    expect(events.map((e) => e.type)).toContain('idle:close-refused');
  });

  it('PID recyclé (superviseur mort, process créé APRÈS la publication) : AUCUN kill', async () => {
    await createAgent({ root: repo.root, name: 'agent-r', mode: 'autonomous', profile: 'fake' });
    const child = spawnIdleProcess();
    await mkdir(path.dirname(outputBeatPath(repo.root, 'agent-r')), { recursive: true });
    await writeFile(outputBeatPath(repo.root, 'agent-r'), '');
    // La session « publiée » date d'une heure : le process vivant qui porte ce numéro est plus récent.
    await updateAgentMeta(repo.root, 'agent-r', {
      sessionPid: child.pid,
      sessionOwnerPid: 0x7ffffff0,
      sessionStartedAt: new Date(Date.now() - HOUR).toISOString(),
    });
    const t0 = future();
    await sweepIdle({ root: repo.root, now: t0, timings: FAST });
    const report = await sweepIdle({ root: repo.root, now: t0 + 6 * MIN, timings: FAST });
    expect(report.closed).toEqual([]);
    expect(report.refused[0]).toMatchObject({
      agent: 'agent-r',
      code: 'IDLE_CLOSE_UNVERIFIED',
      detail: 'IDENTITY',
    });
    expect(isProcessAlive(child.pid)).toBe(true);
  });

  it('agent ORPHELIN (superviseur mort) identifié par son heure de création : arrêté, clone conservé', async () => {
    const created = await createAgent({
      root: repo.root,
      name: 'agent-o',
      mode: 'autonomous',
      profile: 'fake',
    });
    const child = spawnIdleProcess();
    await mkdir(path.dirname(outputBeatPath(repo.root, 'agent-o')), { recursive: true });
    await writeFile(outputBeatPath(repo.root, 'agent-o'), '');
    await updateAgentMeta(repo.root, 'agent-o', {
      sessionPid: child.pid,
      sessionOwnerPid: 0x7ffffff0,
      sessionStartedAt: new Date().toISOString(),
    });
    const t0 = future();
    await sweepIdle({ root: repo.root, now: t0, timings: FAST });
    const report = await sweepIdle({ root: repo.root, now: t0 + 6 * MIN, timings: FAST });
    expect(report.closed).toEqual([{ agent: 'agent-o', host: 'process', code: 'CLOSED' }]);
    await waitFor(() => !isProcessAlive(child.pid));
    expect(await exists(created.path)).toBe(true);
    expect((await readRegistry(repo.root))['agent-o']).toBeTruthy();
  });

  it('non autorisé par la config utilisateur : avertit, ne ferme JAMAIS', async () => {
    await rm(path.join(userHome, 'config.json'));
    const { meta } = await startHangingSession();
    const t0 = future();
    const first = await sweepIdle({ root: repo.root, now: t0, timings: FAST });
    expect(first.closeAuthorized).toBe(false);
    expect(first.warned).toEqual(['agent-a']);
    expect(events.find((e) => e.type === 'idle:warned').willClose).toBe(false);
    const later = await sweepIdle({ root: repo.root, now: t0 + 3 * HOUR, timings: FAST });
    expect(later.closed).toEqual([]);
    expect(later.agents[0].closeBlockedBy).toContain('NOT_AUTHORIZED');
    expect(isProcessAlive(meta.sessionPid)).toBe(true);
  });

  it('config utilisateur illisible : fermeture refusée (fail closed), cause nommée', async () => {
    await writeFile(path.join(userHome, 'config.json'), '{ pas du json');
    await startHangingSession();
    const report = await sweepIdle({ root: repo.root, now: future(), timings: FAST });
    expect(report.closeAuthorized).toBe(false);
    expect(report.authorizationError).toBe('USER_CONFIG_INVALID');
  });

  it("action 'report' (défaut) : détecte et rapporte, n'avertit pas, ne ferme pas", async () => {
    await setConfig({});
    const { meta } = await startHangingSession();
    const t0 = future();
    const report = await sweepIdle({ root: repo.root, now: t0, timings: FAST });
    expect(report.action).toBe('report');
    expect(report.agents[0].state).toBe('idle');
    expect(report.warned).toEqual([]);
    expect(events.map((e) => e.type)).toEqual(['idle:detected']);
    // Un second balayage ne répète pas la détection (une fois par période d'inactivité).
    await sweepIdle({ root: repo.root, now: t0 + MIN, timings: FAST });
    expect(events.map((e) => e.type)).toEqual(['idle:detected']);
    expect(isProcessAlive(meta.sessionPid)).toBe(true);
  });

  it('demande humaine (close: true) : remplace action et autorisation, mais PAS la grâce', async () => {
    await setConfig({});
    await rm(path.join(userHome, 'config.json'));
    const { meta, promise } = await startHangingSession();
    const t0 = future();
    const first = await sweepIdle({ root: repo.root, now: t0, close: true, timings: FAST });
    expect(first.warned).toEqual(['agent-a']);
    expect(first.closed).toEqual([]);
    const second = await sweepIdle({
      root: repo.root,
      now: t0 + 6 * MIN,
      close: true,
      timings: FAST,
    });
    expect(second.closed).toEqual([{ agent: 'agent-a', host: 'process', code: 'CLOSED' }]);
    await waitFor(() => !isProcessAlive(meta.sessionPid));
    expect((await promise).cleaned).toBe(false);
  });

  it('reprise de veille (suspended) : aucune décision, aucune écriture', async () => {
    const { meta } = await startHangingSession();
    const report = await sweepIdle({ root: repo.root, now: future(), suspended: true });
    expect(report.suspended).toBe(true);
    expect(report.warned).toEqual([]);
    expect(events).toEqual([]);
    expect(isProcessAlive(meta.sessionPid)).toBe(true);
  });

  it('reprise de veille : avertissements effacés, la grâce repart de zéro (aucune fermeture au réveil)', async () => {
    const { meta } = await startHangingSession();
    const t0 = future();
    await sweepIdle({ root: repo.root, now: t0, timings: FAST });
    expect((await readIdleState(repo.root)).agents['agent-a'].warnedAt).toBeTruthy();

    await sweepIdle({ root: repo.root, now: t0 + 4 * HOUR, suspended: true });
    expect((await readIdleState(repo.root)).agents['agent-a']?.warnedAt).toBeUndefined();

    // Le balayage suivant ré-avertit au lieu de fermer, même si l'ancien avertissement est vieux.
    const after = await sweepIdle({ root: repo.root, now: t0 + 4 * HOUR + MIN, timings: FAST });
    expect(after.closed).toEqual([]);
    expect(after.warned).toEqual(['agent-a']);
    expect(isProcessAlive(meta.sessionPid)).toBe(true);
  });

  it('activité reprise après l’avertissement : la grâce repart de zéro, pas de fermeture', async () => {
    const { meta } = await startHangingSession();
    const t0 = future();
    await sweepIdle({ root: repo.root, now: t0, timings: FAST });
    // L'agent se remet à produire juste avant la fin de la grâce.
    const at = new Date(t0 + 4 * MIN);
    await utimes(outputBeatPath(repo.root, 'agent-a'), at, at);
    const report = await sweepIdle({ root: repo.root, now: t0 + 6 * MIN, timings: FAST });
    expect(report.closed).toEqual([]);
    expect(isProcessAlive(meta.sessionPid)).toBe(true);
  });

  it('clone sans session et session morte : rapportés idle, rien à fermer', async () => {
    await createAgent({ root: repo.root, name: 'jamais-lance', mode: 'attended', profile: null });
    await createAgent({
      root: repo.root,
      name: 'session-finie',
      mode: 'autonomous',
      profile: 'fake',
    });
    await updateAgentMeta(repo.root, 'session-finie', {
      sessionPid: 0x7ffffff0,
      sessionStartedAt: new Date(Date.now() - 2 * HOUR).toISOString(),
    });
    const report = await sweepIdle({ root: repo.root, now: future(), timings: FAST });
    const byName = Object.fromEntries(report.agents.map((a) => [a.agent, a]));
    expect(byName['jamais-lance']).toMatchObject({ state: 'idle', session: 'none', plan: 'none' });
    expect(byName['session-finie']).toMatchObject({
      state: 'idle',
      session: 'ended',
      plan: 'none',
    });
    expect(report.warned).toEqual([]);
    expect(report.closed).toEqual([]);
  });

  it('exclusion par nom ou par profil : jamais touché', async () => {
    await setConfig({ action: 'close', excludeAgents: ['agent-*'] });
    const { meta } = await startHangingSession();
    const report = await sweepIdle({ root: repo.root, now: future(), timings: FAST });
    expect(report.agents[0].blockers).toContain('EXCLUDED');
    expect(report.warned).toEqual([]);
    await setConfig({ action: 'close', excludeProfiles: ['fake'] });
    const again = await sweepIdle({ root: repo.root, now: future(), timings: FAST });
    expect(again.agents[0].blockers).toContain('EXCLUDED');
    expect(isProcessAlive(meta.sessionPid)).toBe(true);
  });

  it('plafond de fermetures par balayage (maxClosuresPerSweep) : le reste est reporté', async () => {
    await setConfig({ action: 'close', maxClosuresPerSweep: 1 });
    const kids = [];
    for (const name of ['o-1', 'o-2']) {
      await createAgent({ root: repo.root, name, mode: 'autonomous', profile: 'fake' });
      const child = spawnIdleProcess();
      kids.push(child);
      await mkdir(path.dirname(outputBeatPath(repo.root, name)), { recursive: true });
      await writeFile(outputBeatPath(repo.root, name), '');
      await updateAgentMeta(repo.root, name, {
        sessionPid: child.pid,
        sessionOwnerPid: 0x7ffffff0,
        sessionStartedAt: new Date().toISOString(),
      });
    }
    const t0 = future();
    await sweepIdle({ root: repo.root, now: t0, timings: FAST });
    const report = await sweepIdle({ root: repo.root, now: t0 + 6 * MIN, timings: FAST });
    expect(report.closed).toHaveLength(1);
    const alive = kids.filter((k) => isProcessAlive(k.pid));
    expect(alive).toHaveLength(1);
  });
});

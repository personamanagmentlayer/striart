import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runAcpSession, resolveAcpOptions } from '../../src/acp.ts';
import {
  acpHostStatus,
  connectAcpHostOwner,
  launchAcpHost,
  sendHumanPrompt,
  stopAcpHost,
} from '../../src/acp/host.ts';
import { routeAgentMessage } from '../../src/watch-ui.ts';
import { isProcessAlive } from '../../src/process-tree.js';

/**
 * Hôte de session ACP persistant (lot I6) et Phase E du bus `@agent` : une
 * session autonome ACP vit dans un process détaché, adressable depuis un
 * autre process (`watch --ui`) ; un message humain y devient un
 * session/prompt supplémentaire. Vrais process : intégration.
 */
const FAKE_ACP = fileURLToPath(new URL('../helpers/fake-acp-agent.cjs', import.meta.url));
const AGENT = 'agent-host';

async function waitFor(fn, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > deadline) throw new Error('condition non atteinte à temps');
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

describe('hôte de session ACP persistant + Phase E', () => {
  let root;
  let clone;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'striart-acphost-'));
    clone = path.join(root, 'clone');
    await mkdir(clone, { recursive: true });
  });

  afterEach(async () => {
    delete process.env.FAKE_ACP_MODE;
    delete process.env.FAKE_ACP_DELAY_MS;
    await stopAcpHost(root, AGENT).catch(() => {});
    await rm(root, { recursive: true, force: true, maxRetries: 5 }).catch(() => {});
  });

  const profile = (acp = true) => ({ command: process.execPath, args: [FAKE_ACP], acp });
  const meta = () => ({ mode: 'autonomous', path: clone, command: null, profile: 'fake-acp' });

  const run = (p = profile(), extra = {}) =>
    runAcpSession({
      root,
      agent: AGENT,
      taskId: 'task-host',
      cwd: clone,
      profile: p,
      profileKey: 'fake-acp',
      prompt: 'première consigne',
      timeoutMs: 30_000,
      ...extra,
    });

  it('la session vit dans un hôte détaché (PID publié = hôte), reçoit un 2e prompt via @agent', async () => {
    process.env.FAKE_ACP_MODE = 'slow';
    process.env.FAKE_ACP_DELAY_MS = '2500';
    let publishedPid = null;
    const session = run(profile(), { onSpawn: (pid) => (publishedPid = pid) });

    const status = await waitFor(async () => {
      const s = await acpHostStatus(root, AGENT, { fresh: true });
      return s.running && s.listening ? s : null;
    });
    // SESSION_LIVE : le PID publié au registre est celui de l'hôte, qui vit
    // tant que la session vit.
    expect(publishedPid).toBe(status.pid);
    expect(status.pid).not.toBe(process.pid);

    const routed = await routeAgentMessage(root, AGENT, 'deuxième consigne humaine', meta());
    expect(routed).toEqual({ ok: true });

    const result = await session;
    expect(result.status).toBe('COMPLETED');
    expect(result.turns).toBe(2);
    const log = await readFile(result.logPath, 'utf8');
    expect(log).toContain('[prompt #1]');
    expect(log).toContain('[prompt #2] deuxième consigne humaine');
    expect(log).toContain('[bus]');
    // Consignes Striart au premier prompt seulement.
    const second = log.slice(log.indexOf('[prompt #2]'));
    expect(second).not.toContain('Striart — consignes');

    // Fin de session : hôte sorti, fichiers d'état retirés, plus adressable.
    await waitFor(async () => !(await acpHostStatus(root, AGENT, { fresh: true })).running);
    expect(isProcessAlive(status.pid)).toBe(false);
    const late = await routeAgentMessage(root, AGENT, 'trop tard', meta());
    expect(late.ok).toBe(false);
  });

  it('un @agent sans session ACP vivante est refusé explicitement (argv one-shot ou session finie)', async () => {
    const result = await routeAgentMessage(root, AGENT, 'salut', meta());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain(AGENT);
      expect(result.reason).toMatch(/ACP/);
    }
  });

  it('acp.bus: false → le message humain est refusé par l’hôte, la session continue', async () => {
    process.env.FAKE_ACP_MODE = 'slow';
    process.env.FAKE_ACP_DELAY_MS = '2000';
    const session = run(profile({ bus: false }));
    await waitFor(async () => (await acpHostStatus(root, AGENT, { fresh: true })).listening);
    const refused = await sendHumanPrompt(root, AGENT, 'ignoré');
    expect(refused).toMatchObject({ ok: false, code: 'ACP_BUS_DISABLED' });
    const result = await session;
    expect(result.status).toBe('COMPLETED');
    expect(result.turns).toBe(1);
  });

  it('texte vide ou caractère NUL → refusé (ACP_PROMPT_INVALID)', async () => {
    process.env.FAKE_ACP_MODE = 'slow';
    process.env.FAKE_ACP_DELAY_MS = '2000';
    const session = run();
    await waitFor(async () => (await acpHostStatus(root, AGENT, { fresh: true })).listening);
    expect(await sendHumanPrompt(root, AGENT, '   ')).toMatchObject({
      ok: false,
      code: 'ACP_PROMPT_INVALID',
    });
    expect(await sendHumanPrompt(root, AGENT, 'a\u0000b')).toMatchObject({
      ok: false,
      code: 'ACP_PROMPT_INVALID',
    });
    expect((await session).turns).toBe(1);
  });

  it('arrêt demandé (signal) → cancel relayé à l’hôte, CANCELLED, hôte sorti', async () => {
    process.env.FAKE_ACP_MODE = 'hang';
    const controller = new AbortController();
    const session = run(profile(), { signal: controller.signal });
    await waitFor(async () => (await acpHostStatus(root, AGENT, { fresh: true })).listening);
    controller.abort();
    const result = await session;
    expect(result.status).toBe('CANCELLED');
    await waitFor(async () => !(await acpHostStatus(root, AGENT, { fresh: true })).running);
  });

  it('propriétaire disparu → l’hôte annule la session et sort seul (fail closed)', async () => {
    process.env.FAKE_ACP_MODE = 'hang';
    const owner = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 1500)'], {
      stdio: 'ignore',
    });
    const p = profile();
    const launched = await launchAcpHost(root, {
      agent: AGENT,
      taskId: 'task-orphan',
      cwd: clone,
      profile: p,
      options: resolveAcpOptions(p),
      initialPrompt: [{ type: 'text', text: 'orpheline' }],
      timeoutMs: 60_000,
      closeWhenIdle: true,
      ownerPid: owner.pid,
      mcpServers: [],
    });
    expect(isProcessAlive(launched.pid)).toBe(true);
    await waitFor(async () => !isProcessAlive(launched.pid), 20_000);
    const log = await readFile(launched.logPath, 'utf8');
    expect(log).toContain('propriétaire');
    expect((await acpHostStatus(root, AGENT, { fresh: true })).running).toBe(false);
  });

  it('stopAcpHost : demande d’arrêt propre, hôte et agent arrêtés', async () => {
    process.env.FAKE_ACP_MODE = 'hang';
    const p = profile();
    const launched = await launchAcpHost(root, {
      agent: AGENT,
      taskId: 'task-stop',
      cwd: clone,
      profile: p,
      options: resolveAcpOptions(p),
      initialPrompt: [{ type: 'text', text: 'à arrêter' }],
      timeoutMs: 60_000,
      closeWhenIdle: true,
      ownerPid: process.pid,
      mcpServers: [],
    });
    await waitFor(async () => (await acpHostStatus(root, AGENT, { fresh: true })).listening);
    const stopped = await stopAcpHost(root, AGENT);
    expect(stopped).toMatchObject({ stopped: true });
    expect(isProcessAlive(launched.pid)).toBe(false);
  });

  it('un second lancement pendant qu’une session vit est refusé (ACP_HOST_BUSY)', async () => {
    process.env.FAKE_ACP_MODE = 'slow';
    process.env.FAKE_ACP_DELAY_MS = '2000';
    const session = run();
    await waitFor(async () => (await acpHostStatus(root, AGENT, { fresh: true })).running);
    await expect(run()).rejects.toMatchObject({ code: 'ACP_HOST_BUSY' });
    expect((await session).status).toBe('COMPLETED');
  });

  it('session finie AVANT la connexion du propriétaire : le résultat n’est pas perdu', async () => {
    // Binaire introuvable : la session échoue en quelques ms. Si l'hôte démontait
    // son socket aussitôt, le propriétaire arrivant plus tard n'aurait plus que
    // « hôte injoignable » (course constatée en CI sous charge).
    const launched = await launchAcpHost(root, {
      agent: AGENT,
      taskId: 'task-late-owner',
      cwd: clone,
      profile: { command: 'striart-acp-absent-xyz', args: [], acp: true },
      profileKey: 'fake-acp',
      options: resolveAcpOptions({ command: 'x', args: [], acp: true }),
      initialPrompt: [{ type: 'text', text: 'x' }],
      timeoutMs: 20_000,
      closeWhenIdle: true,
      ownerPid: process.pid,
      mcpServers: [],
      env: process.env,
    });
    // On ne se connecte qu'APRÈS la fin de la session (le journal en porte la
    // trace) : c'est précisément la fenêtre où l'hôte perdait le résultat.
    await waitFor(async () =>
      (await readFile(launched.logPath, 'utf8').catch(() => '')).includes('[acp] erreur'),
    );
    await new Promise((resolve) => setTimeout(resolve, 500));
    const owner = await connectAcpHostOwner(root, AGENT, {
      pid: launched.pid,
      ownerToken: launched.ownerToken,
    });
    try {
      const result = await owner.result;
      expect(result.status).toBe('FAILED');
      expect(result.error).toContain('striart-acp-absent-xyz');
    } finally {
      owner.close();
    }
  });

  it('persistentHost: false → session en process, même contrat, non adressable', async () => {
    process.env.FAKE_ACP_MODE = 'slow';
    process.env.FAKE_ACP_DELAY_MS = '1500';
    let publishedPid = null;
    const session = run(profile({ persistentHost: false }), {
      onSpawn: (pid) => (publishedPid = pid),
    });
    await waitFor(() => publishedPid !== null);
    const routed = await routeAgentMessage(root, AGENT, 'non adressable', meta());
    expect(routed.ok).toBe(false);
    const result = await session;
    expect(result.status).toBe('COMPLETED');
    expect(result.turns).toBe(1);
  });
});

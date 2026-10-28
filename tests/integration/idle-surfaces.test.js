import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execa } from 'execa';
import { createTempRepo } from '../helpers/temp-repo.js';
import { initStriart } from '../../src/init.js';
import { createAgent } from '../../src/clone.js';
import { collectStatus } from '../../src/status.ts';
import { startDashboard } from '../../src/dashboard.js';
import { TOOLS } from '../../src/mcp/tools.ts';
import { call, signIn, useLoopbackDashboard } from '../helpers/control-client.js';

/**
 * Surfaces du GC d'inactivité : `striart status`, Control Protocol (plan humain),
 * MCP (plan agent, lecture seule), CLI `striart gc` (codes de sortie, --json).
 */
const CLI = fileURLToPath(new URL('../../src/cli.js', import.meta.url));

describe('GC d’inactivité — surfaces (intégration)', () => {
  let repo;
  let userHome;

  beforeEach(async () => {
    repo = await createTempRepo();
    await initStriart(repo.root);
    userHome = await mkdtemp(path.join(os.tmpdir(), 'striart-userhome-'));
    process.env.STRIART_CONFIG_HOME = userHome;
    await createAgent({ root: repo.root, name: 'agent-a', mode: 'attended' });
  });

  afterEach(async () => {
    delete process.env.STRIART_CONFIG_HOME;
    await rm(userHome, { recursive: true, force: true }).catch(() => undefined);
    await repo.cleanup();
  });

  it('striart status : champ additif `idle`, lecture seule (aucun état écrit)', async () => {
    const status = await collectStatus(repo.root);
    expect(status.idle).toMatchObject({
      available: true,
      enabled: true,
      action: 'report',
      closeAuthorized: false,
    });
    expect(status.idle.agents).toHaveLength(1);
    expect(status.idle.agents[0]).toMatchObject({
      agent: 'agent-a',
      session: 'none',
      state: 'active',
    });
    // Un agent qu'on vient de créer n'est PAS inactif : sa création est un signal.
    expect(status.idle.agents[0].reasons.some((r) => r.startsWith('SIGNAL_FRESH'))).toBe(true);
    const { stat } = await import('node:fs/promises');
    await expect(
      stat(path.join(repo.root, '.striart', 'idle', 'state.json')),
    ).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('MCP (plan agent) : aucun outil ne ferme, ne balaie ni ne touche au GC — le statut seul est lu', () => {
    for (const name of TOOLS.keys()) {
      expect(name, name).not.toMatch(/gc|idle|close|sweep/i);
    }
    expect(TOOLS.has('striart_status')).toBe(true);
  });

  describe('Control Protocol (plan humain)', () => {
    let server;
    let cookie;

    beforeEach(async () => {
      await useLoopbackDashboard(repo.root);
      server = await startDashboard({ root: repo.root, port: 0 });
      ({ cookie } = await signIn(server));
    });

    afterEach(async () => {
      if (server) await new Promise((resolve) => server.close(resolve));
      server = null;
    });

    it('state.get expose `idle` ; workspace.gc (dryRun) rend le rapport sans rien écrire', async () => {
      const state = await call(server, cookie, 'state.get');
      expect(state.data.idle).toMatchObject({ available: true, enabled: true });
      const result = await call(server, cookie, 'workspace.gc', { dryRun: true });
      expect(result.data).toMatchObject({ dryRun: true, enabled: true, warned: [], closed: [] });
      expect(result.data.agents.map((a) => a.agent)).toEqual(['agent-a']);
    });

    it('paramètres fermés : une faute de frappe est refusée, jamais ignorée', async () => {
      await expect(call(server, cookie, 'workspace.gc', { force: true })).rejects.toThrow();
    });
  });

  describe('CLI striart gc', () => {
    const run = (args, env = {}) =>
      execa(process.execPath, [CLI, ...args], {
        cwd: repo.root,
        reject: false,
        env: { ...process.env, STRIART_CONFIG_HOME: userHome, STRIART_LANG: 'en', ...env },
      });

    it('--dry-run --json : document enveloppé, sortie 0, aucun état écrit', async () => {
      const result = await run(['gc', '--dry-run', '--json']);
      expect(result.exitCode).toBe(0);
      const doc = JSON.parse(result.stdout);
      expect(doc).toMatchObject({ ok: true, command: 'gc' });
      expect(doc.data).toMatchObject({ dryRun: true, enabled: true });
      expect(doc.data.agents[0]).toMatchObject({ agent: 'agent-a' });
    });

    it('rendu humain en anglais et en français, détection sans fermeture par défaut', async () => {
      const en = await run(['gc']);
      expect(en.exitCode).toBe(0);
      expect(en.stdout).toContain('agent-a');
      expect(en.stdout).toMatch(/idle agents?, 0 warned, 0 sessions closed/);
      const fr = await run(['gc'], { STRIART_LANG: 'fr' });
      expect(fr.stdout).toMatch(/agent inactif|agents inactifs/);
    });

    it('agent inconnu : échec explicite, pas un succès vide', async () => {
      const result = await run(['gc', 'nope', '--json']);
      expect(result.exitCode).not.toBe(0);
    });

    it('idle.enabled: false : le dit, ne détecte rien', async () => {
      await writeFile(
        path.join(repo.root, '.striartrc.json'),
        JSON.stringify({ testCommand: 'node -e "process.exit(0)"', idle: { enabled: false } }),
      );
      const result = await run(['gc']);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('disabled');
    });

    it('config idle invalide : refusée au chargement (clé inconnue)', async () => {
      await writeFile(
        path.join(repo.root, '.striartrc.json'),
        JSON.stringify({ testCommand: 'node -e "process.exit(0)"', idle: { closeAfterMS: 5 } }),
      );
      const result = await run(['gc']);
      expect(result.exitCode).not.toBe(0);
    });
  });
});

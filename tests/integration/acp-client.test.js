import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runAcpSession } from '../../src/acp.ts';
import { buildAgentInstructions } from '../../src/agents/instructions.ts';
import {
  answerElicitationRequest,
  answerPermissionRequest,
  listPendingElicitations,
  listPendingHumanRequests,
  listPendingPermissions,
} from '../../src/permissions.ts';

/**
 * Client ACP v1 complet (lot I6) contre le faux agent : authentification
 * (auth_required), elicitation routée vers l'humain, terminal borné au
 * clone, serveur MCP Striart transmis, session/close, consignes Striart en
 * tête du premier prompt. Rangé en intégration : chaque cas lance de vrais
 * process (hôte de session détaché + agent) et écrit sur disque.
 */
const FAKE_ACP = fileURLToPath(new URL('../helpers/fake-acp-agent.cjs', import.meta.url));

describe('client ACP v1 complet (faux agent ACP)', () => {
  let root;
  let clone;
  let markers;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'striart-acpv1-'));
    clone = path.join(root, 'clone');
    markers = path.join(root, 'markers');
    await mkdir(clone, { recursive: true });
    await mkdir(markers, { recursive: true });
    process.env.FAKE_ACP_MARKER_DIR = markers;
  });

  afterEach(async () => {
    delete process.env.FAKE_ACP_MODE;
    delete process.env.FAKE_ACP_MARKER_DIR;
    await rm(root, { recursive: true, force: true, maxRetries: 5 }).catch(() => {});
  });

  const profile = (acp = true) => ({ command: process.execPath, args: [FAKE_ACP], acp });

  const run = (p = profile(), extra = {}) =>
    runAcpSession({
      root,
      agent: 'agent-acp',
      taskId: 'task-1',
      cwd: clone,
      profile: p,
      profileKey: 'fake-acp',
      prompt: 'fais le travail',
      timeoutMs: 20_000,
      ...extra,
    });

  async function waitFor(fn, timeoutMs = 10_000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const value = await fn();
      if (value) return value;
      if (Date.now() > deadline) throw new Error('condition non atteinte à temps');
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  describe('authentification', () => {
    it('auth_required sans décision explicite → FAILED nommé ACP_AUTH_REQUIRED, méthodes citées', async () => {
      process.env.FAKE_ACP_MODE = 'auth';
      const result = await run();
      expect(result.status).toBe('FAILED');
      expect(result.errorCode).toBe('ACP_AUTH_REQUIRED');
      expect(result.error).toMatch(/requires authentication/);
      expect(result.error).toContain('agent-login');
      expect(result.error).toContain('agentProfiles.fake-acp.acp.auth.methodId');
      // Jamais d'authentification automatique : aucune trace d'appel au log.
      const log = await readFile(result.logPath, 'utf8');
      expect(log).not.toContain('authenticate →');
    });

    it('acp.auth.methodId explicite → authenticate appelé, session ouverte, COMPLETED', async () => {
      process.env.FAKE_ACP_MODE = 'auth';
      const result = await run(profile({ auth: { methodId: 'agent-login' } }));
      expect(result.status).toBe('COMPLETED');
      await expect(readFile(result.logPath, 'utf8')).resolves.toContain(
        'authenticate → agent-login',
      );
    });

    it('méthode terminal ou non proposée → jamais passée à authenticate (ACP_AUTH_METHOD_UNAVAILABLE)', async () => {
      process.env.FAKE_ACP_MODE = 'auth';
      for (const methodId of ['terminal-login', 'inventee']) {
        const result = await run(profile({ auth: { methodId } }));
        expect(result.status).toBe('FAILED');
        expect(result.errorCode).toBe('ACP_AUTH_METHOD_UNAVAILABLE');
      }
    });
  });

  describe('elicitation (semi-autonome)', () => {
    const askProfile = (askTimeoutMs) => profile({ permissions: 'ask', askTimeoutMs });

    it('question routée vers la boîte aux lettres humaine, réponse validée puis transmise', async () => {
      process.env.FAKE_ACP_MODE = 'elicitation';
      const session = run(askProfile(15_000));
      const request = await waitFor(async () => (await listPendingElicitations(root))[0]);
      expect(request).toMatchObject({
        kind: 'elicitation',
        agent: 'agent-acp',
        mode: 'form',
        message: 'Quelle stratégie de fusion ?',
      });
      // Les demandes de permission restent séparées (contrat du dashboard existant).
      expect(await listPendingPermissions(root)).toEqual([]);
      expect((await listPendingHumanRequests(root)).map((r) => r.id)).toEqual([request.id]);

      // Réponse non conforme au schéma demandé : refusée, la demande reste ouverte.
      await expect(
        answerElicitationRequest(root, request.id, {
          action: 'accept',
          content: { strategy: 'squash' },
        }),
      ).rejects.toMatchObject({ code: 'ELICITATION_CONTENT_INVALID' });
      // Une elicitation ne se tranche pas comme une permission (et inversement).
      await expect(answerPermissionRequest(root, request.id, 'ok')).rejects.toMatchObject({
        code: 'PERMISSION_NOT_PENDING',
      });

      await answerElicitationRequest(root, request.id, {
        action: 'accept',
        content: { strategy: 'rebase' },
      });
      const result = await session;
      expect(result.status).toBe('COMPLETED');
      const log = await readFile(result.logPath, 'utf8');
      expect(log).toContain('stratégie choisie : rebase');
      expect(log).toContain('[elicitation]');
      expect(await listPendingHumanRequests(root)).toEqual([]);
    });

    it('personne ne répond → FAIL CLOSED (cancel), tracé, boîte aux lettres nettoyée', async () => {
      process.env.FAKE_ACP_MODE = 'elicitation';
      const result = await run(askProfile(1_200));
      expect(result.status).toBe('FAILED');
      expect(result.stopReason).toBe('refusal');
      const log = await readFile(result.logPath, 'utf8');
      expect(log).toContain('elicitation : cancel');
      expect(log).toContain('fail closed');
      expect(await listPendingHumanRequests(root)).toEqual([]);
    });

    it("politique allow : la capacité n'est pas annoncée (aucun humain pour répondre)", async () => {
      process.env.FAKE_ACP_MODE = 'elicitation';
      const result = await run();
      expect(result.status).toBe('COMPLETED');
      await expect(readFile(result.logPath, 'utf8')).resolves.toContain(
        'elicitation non annoncée par le client',
      );
    });
  });

  describe('terminal borné au clone', () => {
    it('terminal/create → wait_for_exit → output → release ; cwd = clone, STRIART_SESSION non surchargeable', async () => {
      process.env.FAKE_ACP_MODE = 'terminal';
      const result = await run();
      expect(result.status).toBe('COMPLETED');
      const log = await readFile(result.logPath, 'utf8');
      expect(log).toContain('TERM-OK é');
      // process.cwd() de la commande rend le chemin réel (macOS : /var → /private/var).
      const cloneRealPath = await realpath(clone);
      expect([path.resolve(clone), cloneRealPath].some((p) => log.includes(p))).toBe(true);
      // STRIART_SESSION=0 demandé par l'agent : ignoré (garde de profondeur MCP).
      expect(log).toMatch(/TERM-OK é \S.* 1 from-agent/);
      expect(log).toContain('"exitCode":0');
      expect(log).toContain('[terminal]');
    });

    it('cwd hors du clone → erreur JSON-RPC, rien n’est lancé', async () => {
      process.env.FAKE_ACP_MODE = 'terminal-escape';
      const result = await run();
      expect(result.status).toBe('COMPLETED');
      await expect(readFile(result.logPath, 'utf8')).resolves.toContain('terminal refusé');
    });

    it('commande sans fin → tuée au délai du terminal, wait_for_exit revient', async () => {
      process.env.FAKE_ACP_MODE = 'terminal-hang';
      const result = await run(profile({ terminal: { timeoutMs: 1_500 } }));
      expect(result.status).toBe('COMPLETED');
      const log = await readFile(result.logPath, 'utf8');
      expect(log).toMatch(/terminal sortie=\[\] truncated=false exit=/);
      expect(log).toContain('délai');
    });

    it('terminal: false → capacité non annoncée', async () => {
      process.env.FAKE_ACP_MODE = 'terminal';
      const result = await run(profile({ terminal: false }));
      expect(result.status).toBe('FAILED');
      await expect(readFile(result.logPath, 'utf8')).resolves.toContain(
        'terminal non annoncé par le client',
      );
    });
  });

  describe('session : MCP Striart, consignes, fermeture', () => {
    it('mcpServers = serveur MCP Striart en lecture seule, borné au clone de l’agent', async () => {
      process.env.FAKE_ACP_MODE = 'mcp';
      const result = await run();
      expect(result.status).toBe('COMPLETED');
      const log = await readFile(result.logPath, 'utf8');
      const servers = JSON.parse(/mcpServers=(.*)/.exec(log)[1]);
      expect(servers).toHaveLength(1);
      expect(servers[0]).toMatchObject({ name: 'striart', command: process.execPath });
      expect(servers[0].args).toEqual(
        expect.arrayContaining(['mcp', '--root', root, '--agent', 'agent-acp', '--read-only']),
      );
      expect(path.isAbsolute(servers[0].args[0])).toBe(true);
      expect(servers[0].env).toEqual([{ name: 'STRIART_SESSION', value: '1' }]);
    });

    it("acp.mcp: 'none' → aucune liste transmise", async () => {
      process.env.FAKE_ACP_MODE = 'mcp';
      const result = await run(profile({ mcp: 'none' }));
      await expect(readFile(result.logPath, 'utf8')).resolves.toContain('mcpServers=[]');
    });

    it('consignes Striart en TÊTE du premier prompt (séparées par une ligne vide)', async () => {
      process.env.FAKE_ACP_MODE = 'message';
      const config = { testCommand: 'npm test', agentProfiles: {} };
      const p = profile();
      const result = await run(p, { config });
      expect(result.status).toBe('COMPLETED');
      const expected = await buildAgentInstructions({
        root,
        agent: 'agent-acp',
        profileKey: 'fake-acp',
        profile: p,
        config,
        mode: 'autonomous',
      });
      const log = await readFile(result.logPath, 'utf8');
      if (expected) {
        const firstLine = expected.split('\n')[0];
        expect(log).toContain(`travail sur : ${firstLine}`);
        expect(log.indexOf(firstLine)).toBeLessThan(log.indexOf('fais le travail'));
      } else {
        expect(log).toContain('travail sur : fais le travail');
      }
    });

    it('session/close envoyé quand l’agent l’annonce', async () => {
      process.env.FAKE_ACP_MODE = 'message';
      const result = await run();
      expect(result.status).toBe('COMPLETED');
      expect(await readdir(markers)).toEqual(['closed-sess-fake-1']);
    });
  });
});

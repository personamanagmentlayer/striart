import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  formatSessionUpdate,
  isPathInsideClone,
  resolveAcpOptions,
  runAcpSession,
  selectPermissionOption,
} from '../../src/acp.ts';
import { runAgentSession } from '../../src/session.js';
import {
  answerPermissionRequest,
  createPermissionRequest,
  listPendingPermissions,
} from '../../src/permissions.ts';

const FAKE_ACP = fileURLToPath(new URL('../helpers/fake-acp-agent.cjs', import.meta.url));
const exists = async (p) => Boolean(await stat(p).catch(() => null));

describe('acp — options de profil', () => {
  it('acp: true → politique allow (le niveau de confiance des profils headless)', () => {
    expect(resolveAcpOptions({ command: 'x', args: [], acp: true })).toEqual({
      permissions: 'allow',
      askTimeoutMs: 120_000,
    });
  });

  it('acp: { permissions } est respecté', () => {
    expect(resolveAcpOptions({ command: 'x', args: [], acp: { permissions: 'reject' } })).toEqual({
      permissions: 'reject',
      askTimeoutMs: 120_000,
    });
  });

  it("acp: { permissions: 'ask' } — semi-autonome, délai d'arbitrage surchargeable", () => {
    expect(
      resolveAcpOptions({
        command: 'x',
        args: [],
        acp: { permissions: 'ask', askTimeoutMs: 30_000 },
      }),
    ).toEqual({ permissions: 'ask', askTimeoutMs: 30_000 });
  });
});

describe('acp — chemins bornés au clone', () => {
  const clone = path.join(os.tmpdir(), 'striart-clone');

  it('accepte un chemin relatif ou absolu DANS le clone', () => {
    expect(isPathInsideClone(clone, 'src/feature.js')).toBe(true);
    expect(isPathInsideClone(clone, path.join(clone, 'a', 'b.txt'))).toBe(true);
    expect(isPathInsideClone(clone, '.')).toBe(true);
  });

  it('refuse toute sortie du clone : .., absolu tiers, vide', () => {
    expect(isPathInsideClone(clone, '../evasion.txt')).toBe(false);
    expect(isPathInsideClone(clone, path.join(clone, '..', 'evasion.txt'))).toBe(false);
    expect(isPathInsideClone(clone, path.join(os.tmpdir(), 'ailleurs.txt'))).toBe(false);
    expect(isPathInsideClone(clone, '')).toBe(false);
  });
});

describe('acp — sélection de permission par politique', () => {
  const options = [
    { optionId: 'ok', kind: 'allow_once' },
    { optionId: 'ok-toujours', kind: 'allow_always' },
    { optionId: 'no', kind: 'reject_once' },
  ];

  it("allow privilégie l'accord PONCTUEL — jamais de blanc-seing permanent", () => {
    expect(selectPermissionOption(options, 'allow')?.optionId).toBe('ok');
  });

  it('reject choisit le refus ; null (→ cancelled) si aucune option applicable', () => {
    expect(selectPermissionOption(options, 'reject')?.optionId).toBe('no');
    expect(selectPermissionOption([{ optionId: 'ok', kind: 'allow_once' }], 'reject')).toBeNull();
    expect(selectPermissionOption([], 'allow')).toBeNull();
  });
});

describe('acp — transcription des updates de session', () => {
  it('transcrit messages, outils et plan ; tait le raisonnement interne', () => {
    expect(
      formatSessionUpdate({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'bonjour' },
      }),
    ).toBe('bonjour');
    expect(
      formatSessionUpdate({ sessionUpdate: 'tool_call', title: 'git commit', status: 'pending' }),
    ).toContain('git commit');
    expect(
      formatSessionUpdate({
        sessionUpdate: 'plan',
        entries: [{ content: { type: 'text', text: 'étape 1' }, status: 'pending' }],
      }),
    ).toContain('étape 1');
    expect(formatSessionUpdate({ sessionUpdate: 'agent_thought_chunk', content: 'x' })).toBeNull();
  });
});

describe('acp — session supervisée (faux agent ACP)', () => {
  let root;
  let clone;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'striart-acp-'));
    clone = path.join(root, 'clone');
    await mkdir(clone, { recursive: true });
  });

  afterEach(async () => {
    delete process.env.FAKE_ACP_MODE;
    await rm(root, { recursive: true, force: true, maxRetries: 5 }).catch(() => {});
  });

  const profile = (extra = {}) => ({
    command: process.execPath,
    args: [FAKE_ACP],
    acp: true,
    ...extra,
  });

  const run = (p = profile(), extra = {}) =>
    runAcpSession({
      root,
      agent: 'agent-acp',
      taskId: 'task-1',
      cwd: clone,
      profile: p,
      prompt: 'fais le travail',
      timeoutMs: 15_000,
      ...extra,
    });

  it('end_turn → COMPLETED, et le log raconte le déroulé (handshake, plan, messages)', async () => {
    process.env.FAKE_ACP_MODE = 'message';
    const result = await run();
    expect(result.status).toBe('COMPLETED');
    expect(result.stopReason).toBe('end_turn');
    expect(result.error).toBeNull();

    const log = await readFile(result.logPath, 'utf8');
    expect(log).toContain('handshake ok');
    expect(log).toContain('[plan]');
    expect(log).toContain('travail sur : fais le travail');
  });

  it('refusal → FAILED : un stopReason non vert ne devient jamais un succès', async () => {
    process.env.FAKE_ACP_MODE = 'refusal';
    const result = await run();
    expect(result.status).toBe('FAILED');
    expect(result.stopReason).toBe('refusal');
    expect(result.error).toContain('refusal');
  });

  it('version de protocole incompatible → FAILED explicite au handshake', async () => {
    process.env.FAKE_ACP_MODE = 'badversion';
    const result = await run();
    expect(result.status).toBe('FAILED');
    expect(result.error).toMatch(/protocole/i);
  });

  it('délai dépassé → session/cancel PUIS kill, statut TIMEOUT', async () => {
    process.env.FAKE_ACP_MODE = 'hang';
    const result = await run(profile(), { timeoutMs: 1_500 });
    expect(result.status).toBe('TIMEOUT');
    expect(result.timedOut).toBe(true);
    await expect(readFile(result.logPath, 'utf8')).resolves.toContain('délai');
  });

  it('binaire introuvable → FAILED sans throw, la commande citée dans error', async () => {
    const result = await run(profile({ command: 'striart-acp-absent-xyz', args: [] }));
    expect(result.status).toBe('FAILED');
    expect(result.error).toContain('striart-acp-absent-xyz');
  });

  it('fs via le client : lecture/écriture servies DANS le clone', async () => {
    process.env.FAKE_ACP_MODE = 'fs';
    const result = await run();
    expect(result.status).toBe('COMPLETED');
    await expect(readFile(path.join(clone, 'via-client.txt'), 'utf8')).resolves.toContain(
      'écrit via le client ACP',
    );
    // La relecture par fs/read_text_file est passée par le client et streamée au log.
    await expect(readFile(result.logPath, 'utf8')).resolves.toContain('relu :');
  });

  it("fs hors du clone → erreur JSON-RPC, RIEN n'est écrit dehors", async () => {
    process.env.FAKE_ACP_MODE = 'fs-escape';
    const result = await run();
    // end_turn seulement si le faux agent a bien REÇU le refus (voir helper).
    expect(result.status).toBe('COMPLETED');
    expect(await exists(path.join(root, '..', 'evasion.txt'))).toBe(false);
    await expect(readFile(result.logPath, 'utf8')).resolves.toContain('REFUSÉE');
  });

  it('permission accordée par la politique allow, tracée au log', async () => {
    process.env.FAKE_ACP_MODE = 'permission';
    const result = await run();
    expect(result.status).toBe('COMPLETED');
    await expect(readFile(result.logPath, 'utf8')).resolves.toContain('[permission]');
  });

  it('politique reject → le faux agent, refusé, répond refusal → FAILED', async () => {
    process.env.FAKE_ACP_MODE = 'permission';
    const result = await run(profile({ acp: { permissions: 'reject' } }));
    expect(result.status).toBe('FAILED');
    expect(result.stopReason).toBe('refusal');
  });

  it('refuse un profil ACP dont les args contiennent {{prompt}} (un seul canal)', async () => {
    await expect(run(profile({ args: [FAKE_ACP, '{{prompt}}'] }))).rejects.toThrowError(/interdit/);
  });

  it('runAgentSession aiguille vers ACP sur profile.acp — même contrat de retour', async () => {
    process.env.FAKE_ACP_MODE = 'message';
    const result = await runAgentSession({
      root,
      agent: 'agent-acp',
      taskId: 'task-2',
      cwd: clone,
      profile: profile(),
      prompt: 'fais le travail',
      timeoutMs: 15_000,
    });
    expect(result.status).toBe('COMPLETED');
    expect(result.stopReason).toBe('end_turn');
  });
});

describe('acp — publication du PID (registre)', () => {
  it('onSpawn reçoit le PID au plus tôt, comme en transport argv', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'striart-acp-pid-'));
    const clone = path.join(root, 'clone');
    await mkdir(clone, { recursive: true });
    process.env.FAKE_ACP_MODE = 'message';
    let seenPid = null;
    try {
      await runAcpSession({
        root,
        agent: 'agent-acp',
        taskId: 'task-3',
        cwd: clone,
        profile: { command: process.execPath, args: [FAKE_ACP], acp: true },
        prompt: 'x',
        timeoutMs: 15_000,
        onSpawn: (pid) => {
          seenPid = pid;
        },
      });
      expect(typeof seenPid).toBe('number');
    } finally {
      delete process.env.FAKE_ACP_MODE;
      await rm(root, { recursive: true, force: true, maxRetries: 5 }).catch(() => {});
    }
  });
});

describe('acp — semi-autonome (politique ask, Phase F)', () => {
  let root;
  let clone;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'striart-acp-ask-'));
    clone = path.join(root, 'clone');
    await mkdir(clone, { recursive: true });
    process.env.FAKE_ACP_MODE = 'permission';
  });

  afterEach(async () => {
    delete process.env.FAKE_ACP_MODE;
    await rm(root, { recursive: true, force: true, maxRetries: 5 }).catch(() => {});
  });

  const askProfile = (askTimeoutMs) => ({
    command: process.execPath,
    args: [FAKE_ACP],
    acp: { permissions: 'ask', askTimeoutMs },
  });

  const run = (askTimeoutMs) =>
    runAcpSession({
      root,
      agent: 'agent-ask',
      taskId: 'task-ask',
      cwd: clone,
      profile: askProfile(askTimeoutMs),
      prompt: 'fais le travail',
      timeoutMs: 20_000,
    });

  /** Poll la boîte aux lettres jusqu'à voir une demande PENDING. */
  async function waitForRequest(timeoutMs = 8_000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const pending = await listPendingPermissions(root);
      if (pending.length > 0) return pending[0];
      if (Date.now() > deadline) throw new Error('aucune demande déposée à temps');
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  it("la demande est déposée, l'humain autorise via la boîte aux lettres → session verte", async () => {
    const session = run(10_000);
    const request = await waitForRequest();
    expect(request).toMatchObject({ agent: 'agent-ask', title: 'Modifier feature.js' });
    expect(request.options.map((o) => o.optionId).sort()).toEqual(['no', 'ok']);

    await answerPermissionRequest(root, request.id, 'ok');
    const result = await session;
    expect(result.status).toBe('COMPLETED');
    const log = await readFile(result.logPath, 'utf8');
    expect(log).toContain("en attente d'arbitrage humain");
    expect(log).toContain('(humain)');
    // La boîte aux lettres est nettoyée : pas de bouton mort au dashboard.
    expect(await listPendingPermissions(root)).toEqual([]);
  });

  it("l'humain refuse → l'agent reçoit le refus (session refusal)", async () => {
    const session = run(10_000);
    const request = await waitForRequest();
    await answerPermissionRequest(root, request.id, 'no');
    const result = await session;
    expect(result.status).toBe('FAILED');
    expect(result.stopReason).toBe('refusal');
  });

  it('personne ne répond → FAIL CLOSED : reject appliqué au délai, tracé au log', async () => {
    const result = await run(1_200);
    expect(result.status).toBe('FAILED');
    expect(result.stopReason).toBe('refusal');
    const log = await readFile(result.logPath, 'utf8');
    expect(log).toContain('fail closed');
    expect(await listPendingPermissions(root)).toEqual([]);
  });

  it('answerPermissionRequest : id invalide, demande inconnue, option non proposée → refus typés', async () => {
    await expect(answerPermissionRequest(root, '../evasion', 'ok')).rejects.toMatchObject({
      code: 'PERMISSION_ID_INVALID',
    });
    await expect(
      answerPermissionRequest(root, 'perm-00000000-0000-0000-0000-000000000000', 'ok'),
    ).rejects.toMatchObject({ code: 'PERMISSION_NOT_PENDING' });

    const created = await createPermissionRequest(root, {
      agent: 'a',
      taskId: 't',
      title: 'Test',
      options: [{ optionId: 'ok', kind: 'allow_once' }],
      timeoutMs: 60_000,
    });
    await expect(answerPermissionRequest(root, created.id, 'inventée')).rejects.toMatchObject({
      code: 'PERMISSION_OPTION_UNKNOWN',
    });
  });
});

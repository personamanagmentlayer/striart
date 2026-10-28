/**
 * Tests d'intégration contre le VRAI `striart api --stdio` d'un dépôt Git
 * temporaire : le client de protocole, la résolution du binaire et le
 * transport spawn sont exercés tels qu'en production (sans VS Code).
 *
 * Le CLI testé est celui du dépôt Striart parent (`STRIART_CLI` pour en viser
 * un autre). Si aucun n'est trouvé, la suite échoue explicitement (jamais
 * « verte parce que sautée »).
 */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { resolveStriartLaunch } from '../../src/core/binary.ts';
import { ControlClient, type ConnectionStatus, type StatusInfo } from '../../src/core/client.ts';
import { spawnTransport } from '../../src/core/transport.ts';
import type { ControlState } from '../../src/core/types.ts';

const run = promisify(execFile);
const CLI = process.env.STRIART_CLI ?? fileURLToPath(new URL('../../../../src/cli.js', import.meta.url));
const tmpDirs: string[] = [];

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await run('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=Test', ...args], { cwd });
  return stdout;
}

async function cli(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await run(process.execPath, [CLI, ...args], { cwd, env: { ...process.env, STRIART_LANG: 'en' } });
  return stdout;
}

async function makeRepo(initialize: boolean): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'striart-vsc-'));
  tmpDirs.push(dir);
  await git(dir, 'init', '-q', '-b', 'main');
  await writeFile(path.join(dir, 'README.md'), 'hello\n');
  await git(dir, 'add', '.');
  await git(dir, 'commit', '-qm', 'init');
  if (initialize) {
    await cli(dir, 'init');
    await writeFile(path.join(dir, '.striartrc.json'), JSON.stringify({ testCommand: 'node -e "process.exit(0)"' }));
    await git(dir, 'add', '.');
    await git(dir, 'commit', '-qm', 'striart config');
  }
  return dir;
}

function makeClient(cwd: string, env: NodeJS.ProcessEnv = {}, overrides: { maxAttempts?: number } = {}) {
  const client = new ControlClient({
    clientName: 'striart-vscode-test',
    clientVersion: '0.0.0',
    requestTimeoutMs: 120_000,
    actionTimeoutMs: 360_000,
    reconnect: { initialMs: 100, maxMs: 500, maxAttempts: overrides.maxAttempts ?? 5 },
    requiredMethods: ['state.subscribe', 'state.get'],
    connect: async () => {
      const launch = await resolveStriartLaunch(CLI, process.execPath, {});
      return spawnTransport({
        file: launch.file,
        args: [...launch.prefixArgs, 'api', '--stdio', '--framing', 'ndjson'],
        cwd,
        env: { ...process.env, STRIART_LANG: 'en', ...env },
      });
    },
  });
  const statuses: StatusInfo[] = [];
  client.on('status', (s) => statuses.push(s));
  return { client, statuses };
}

function waitFor<T>(
  client: ControlClient,
  event: 'status' | 'state',
  predicate: (v: T) => boolean,
  timeoutMs = 120_000,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      client.off(event, handler as never);
      reject(new Error(`timeout waiting for ${event}`));
    }, timeoutMs);
    const handler = (value: T) => {
      if (!predicate(value)) return;
      clearTimeout(timer);
      client.off(event, handler as never);
      resolve(value);
    };
    client.on(event, handler as never);
  });
}

const isStatus = (s: ConnectionStatus) => (info: StatusInfo) => info.status === s;

before(() => {
  assert.ok(existsSync(CLI), `Striart CLI not found at ${CLI} (set STRIART_CLI)`);
});
after(async () => {
  for (const dir of tmpDirs) await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

describe('striart api réel', () => {
  it('se connecte, négocie et valide l’état réel d’un dépôt vide', async () => {
    const repo = await makeRepo(true);
    const { client } = makeClient(repo);
    try {
      client.start();
      await waitFor<StatusInfo>(client, 'status', isStatus('connected'));
      assert.ok(client.state);
      assert.equal(client.state.agents.length, 0);
      assert.equal(client.state.config.targetBranch, 'main');
      assert.equal(client.invalidMessages, 0);
      const again = await client.call<{ revision?: number; agents: unknown[] }>('state.get');
      assert.ok(Array.isArray(again.data.agents));
    } finally {
      await client.stop();
    }
  });

  it('pousse l’état quand un agent apparaît, puis merge sous Test Gate (agent.merge)', async () => {
    const repo = await makeRepo(true);
    const { client } = makeClient(repo);
    try {
      client.start();
      await waitFor<StatusInfo>(client, 'status', isStatus('connected'));
      const appeared = waitFor<ControlState>(client, 'state', (s) => s.agents.some((a) => a.name === 'agent-a'));
      const started = JSON.parse(await cli(repo, 'start', 'agent-a', '--json')) as {
        data: { agent: { path: string } };
      };
      const state = await appeared;
      assert.equal(state.agents.find((a) => a.name === 'agent-a')?.pendingCommits, 0);

      const clone = started.data.agent.path;
      await writeFile(path.join(clone, 'feature.txt'), 'new feature\n');
      await git(clone, 'add', '.');
      await git(clone, 'commit', '-qm', 'feat: feature');

      const merged = await client.call<{ status: string }>('agent.merge', { agent: 'agent-a' }, 'action');
      assert.equal(merged.data.status, 'MERGED', JSON.stringify(merged.data).slice(0, 1500));
      assert.equal(merged.outcome, 'ok');
      assert.match(await git(repo, 'log', '--oneline', '-5'), /feat: feature/);
    } finally {
      await client.stop();
    }
  });

  it('une erreur du domaine devient une RpcError au code stable', async () => {
    const repo = await makeRepo(true);
    const { client } = makeClient(repo);
    try {
      client.start();
      await waitFor<StatusInfo>(client, 'status', isStatus('connected'));
      await assert.rejects(client.call('agent.merge', { agent: 'inconnu' }, 'action'), (e: unknown) => {
        const err = e as { name: string; code: string; kind: string };
        assert.equal(err.name, 'RpcError');
        assert.match(err.code, /^[A-Z][A-Z0-9_]+$/);
        return true;
      });
      // Paramètre invalide : refusé par le schéma publié (usage), connexion intacte.
      await assert.rejects(
        client.call('agent.merge', { agent: '../etc' }, 'action'),
        (e: unknown) => (e as { kind: string }).kind === 'usage',
      );
      assert.equal(client.status.status, 'connected');
    } finally {
      await client.stop();
    }
  });

  it('dépôt non initialisé : état explicite, pas de reprise', async () => {
    const repo = await makeRepo(false);
    const { client, statuses } = makeClient(repo);
    try {
      client.start();
      const info = await waitFor<StatusInfo>(client, 'status', isStatus('not-initialized'));
      assert.equal(info.code, 'NOT_INITIALIZED');
      await new Promise((r) => setTimeout(r, 1200));
      assert.equal(statuses.filter((s) => s.status === 'connecting').length, 1, 'aucune relance');
    } finally {
      await client.stop();
    }
  });

  it('session d’agent (STRIART_SESSION=1) : refus explicite (plan humain)', async () => {
    const repo = await makeRepo(true);
    const { client } = makeClient(repo, { STRIART_SESSION: '1' });
    try {
      client.start();
      const info = await waitFor<StatusInfo>(client, 'status', isStatus('blocked'));
      assert.equal(info.code, 'CONTROL_NESTED_SESSION');
    } finally {
      await client.stop();
    }
  });

  it('mort du sous-process : hors ligne puis reprise automatique avec un état frais', async () => {
    const repo = await makeRepo(true);
    const { client, statuses } = makeClient(repo);
    try {
      client.start();
      await waitFor<StatusInfo>(client, 'status', isStatus('connected'));
      const before = statuses.length;
      // Coupe brutale : on tue le process serveur via son PID n'est pas exposé → on ferme son stdin par le transport.
      (client as unknown as { transport: { kill(): void } }).transport.kill();
      await waitFor<StatusInfo>(client, 'status', isStatus('offline'));
      await waitFor<StatusInfo>(client, 'status', (s) => s.status === 'connected' && statuses.length > before);
      assert.equal(client.status.attempt, 0);
      const state = await client.call<{ agents: unknown[] }>('state.get');
      assert.ok(Array.isArray(state.data.agents));
    } finally {
      await client.stop();
    }
  });

  it('stop() termine le sous-process proprement (stdin fermé)', async () => {
    const repo = await makeRepo(true);
    const { client } = makeClient(repo);
    client.start();
    await waitFor<StatusInfo>(client, 'status', isStatus('connected'));
    const started = Date.now();
    await client.stop();
    assert.ok(Date.now() - started < 5000);
    assert.equal(client.status.status, 'stopped');
  });
});

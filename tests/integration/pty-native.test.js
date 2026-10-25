import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { isProcessAlive } from '../../src/process-tree.js';
import { attachSocketPath, connectAttachClient } from '../../src/pty-attach.ts';
import { resetNativeBinaryCache } from '../../src/native.ts';
import {
  ptyHostPidFilePath,
  ptyHostStatus,
  ptyHostStopFilePath,
} from '../../src/pty-host-state.ts';
import {
  REAL_PTY_WAIT_MS,
  seedAgentRegistry,
  waitFor,
  withRealPtySlot,
} from '../helpers/pty-test-utils.js';
import { REPO_ROOT, nativeFixturePath } from '../helpers/native.js';

// Lot R2 : hôte de pty natif. Ces tests portent sur ce que l'hôte Node ne
// faisait pas (contre-pression, rejeu sans coupure, arrêt propre mesuré,
// identité du binaire natif, sélection explicite) — l'équivalence de
// protocole est prouvée par pty-attach/pty-host/watch-ui-* inchangés.

const openedTerminals = [];
vi.mock('../../src/terminal.js', () => ({
  openAgentTerminal: async (params) => {
    openedTerminals.push(params);
    return { launched: true };
  },
}));

const { ensurePtyHost, openAttendedSession, stopPtyHost } = await import('../../src/pty-host.ts');

const FIXTURE = nativeFixturePath('pty-fixture');

/** Client brut : frames décodées, lecture suspendable (client lent). */
function rawClient(root, agent) {
  const socket = net.createConnection(attachSocketPath(root, agent));
  const frames = [];
  let pending = '';
  let closed = false;
  socket.setEncoding('utf8');
  socket.on('data', (chunk) => {
    pending += chunk;
    let i;
    while ((i = pending.indexOf('\n')) >= 0) {
      frames.push(JSON.parse(pending.slice(0, i)));
      pending = pending.slice(i + 1);
    }
  });
  socket.on('error', () => {});
  socket.on('close', () => (closed = true));
  return { socket, frames, isClosed: () => closed };
}

describe('hôte de pty natif', () => {
  let root;
  const agent = 'agent-native';

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'striart-pty-native-'));
    await seedAgentRegistry(root, agent);
    openedTerminals.length = 0;
  });

  afterEach(async () => {
    await stopPtyHost(root, agent).catch(() => {});
    await rm(root, { recursive: true, force: true }).catch(() => {});
  });

  // POSIX : le pty transmet les octets du programme tels quels. Sous
  // Windows, ConPTY re-rend la sortie à un débit qui dépend de la charge de
  // la machine ; la même logique y est couverte sur le vrai named pipe par
  // native/striart-native/tests/pty_hub.rs (cargo test).
  it.runIf(process.platform !== 'win32')(
    'client lent évincé explicitement ; le rejeu d’une reconnexion est borné et commence à une frontière sûre',
    () =>
      withRealPtySlot(async () => {
        await ensurePtyHost(root, agent, {
          shell: FIXTURE,
          args: ['flood-on-go', '4000000'],
          cwd: root,
          replayBytes: 4_096,
          clientQueueBytes: 1_048_576, // 1 Mio : le lecteur ne doit pas être évincé par un simple retard de CI (flot : 4 Mo)
        });
        const slow = rawClient(root, agent);
        await waitFor(() => slow.frames.some((f) => f.type === 'hello'), REAL_PTY_WAIT_MS);
        slow.socket.pause();

        let driverText = '';
        let driverEvicted = 0;
        const driver = connectAttachClient(root, agent, {
          onData: (t) => (driverText += t),
          onEvicted: () => (driverEvicted += 1),
        });
        await waitFor(() => driverText.includes('READY-FOR-GO'), REAL_PTY_WAIT_MS);
        driver.sendMessage('go');
        // L'hôte journalise l'éviction : on reprend la lecture dès qu'elle a
        // eu lieu (indépendant du débit de la machine, et bien sous le délai
        // de coupure forcée d'un client évincé qui ne lit plus, 30 s).
        const log = path.join(root, '.striart', 'logs', `pty-${agent}.log`);
        let logText = '';
        const deadline = Date.now() + 90_000;
        while (!logText.includes('"event":"client-evicted"')) {
          if (Date.now() > deadline) throw new Error('no eviction logged by the pty host');
          await new Promise((resolve) => setTimeout(resolve, 100));
          logText = await readFile(log, 'utf8').catch(() => '');
        }

        slow.socket.resume();
        await waitFor(() => slow.isClosed(), REAL_PTY_WAIT_MS);
        expect(slow.frames.at(-1)).toEqual({ type: 'evicted', reason: 'slow-client' });
        // Le client qui lisait n'a jamais été évincé ni n'a perdu de caractère.
        expect(driverEvicted).toBe(0);
        expect(driverText).not.toContain('�');

        const again = rawClient(root, agent);
        await waitFor(() => again.frames.some((f) => f.type === 'data'), REAL_PTY_WAIT_MS);
        const replay = Buffer.from(again.frames.find((f) => f.type === 'data').chunk, 'base64');
        expect(replay.length).toBeLessThanOrEqual(4_096);
        // Décodage strict : aucun caractère coupé au début.
        const text = new TextDecoder('utf-8', { fatal: true }).decode(replay);
        expect(text).not.toMatch(/^[0-9;[?]/);
        again.socket.end();
        driver.close();
      }),
  );

  it('un client évincé se reconnecte seul et reçoit le rejeu (connectAttachClient)', async () => {
    // Faux hôte : première connexion évincée, seconde servie avec un rejeu.
    const endpoint = attachSocketPath(root, agent);
    await rm(endpoint, { force: true }).catch(() => {});
    if (process.platform !== 'win32') {
      const { mkdir } = await import('node:fs/promises');
      await mkdir(path.dirname(endpoint), { recursive: true });
    }
    let connections = 0;
    const server = net.createServer((socket) => {
      connections += 1;
      socket.write('{"type":"hello","agent":"agent-native","cols":80,"rows":24}\n');
      if (connections === 1) {
        socket.end('{"type":"evicted","reason":"slow-client"}\n');
      } else {
        // « é » coupé en deux frames : le décodage en flux le recompose.
        socket.write(`{"type":"data","chunk":"${Buffer.from([0x52, 0xc3]).toString('base64')}"}\n`);
        socket.write(`{"type":"data","chunk":"${Buffer.from([0xa9]).toString('base64')}"}\n`);
      }
    });
    await new Promise((resolve) => server.listen(endpoint, resolve));
    try {
      let text = '';
      let connects = 0;
      let evictions = 0;
      const conn = connectAttachClient(root, agent, {
        onData: (t) => (text += t),
        onConnect: () => (connects += 1),
        onEvicted: () => (evictions += 1),
      });
      await waitFor(() => text === 'Ré');
      expect(evictions).toBe(1);
      expect(connects).toBe(2);
      conn.close();
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it.runIf(process.platform !== 'win32')('socket d’attache en 0600 (POSIX)', () =>
    withRealPtySlot(async () => {
      await ensurePtyHost(root, agent, { shell: FIXTURE, args: ['echo-lines'], cwd: root });
      const info = await stat(attachSocketPath(root, agent));
      expect(info.mode & 0o777).toBe(0o600);
    }),
  );

  it('arrêt propre par host.stop : frame exit reçue, arrêt rapide, fichiers d’état retirés', () =>
    withRealPtySlot(async () => {
      const { pid } = await ensurePtyHost(root, agent, {
        shell: FIXTURE,
        args: ['echo-lines'],
        cwd: root,
      });
      let exit = null;
      let text = '';
      const conn = connectAttachClient(root, agent, {
        onData: (t) => (text += t),
        onExit: (exitCode, signal) => (exit = { exitCode, signal }),
      });
      await waitFor(() => text.includes('ECHO-READY'), REAL_PTY_WAIT_MS);
      const started = Date.now();
      const result = await stopPtyHost(root, agent);
      const elapsed = Date.now() - started;
      expect(result).toMatchObject({ stopped: true, stopping: false, untouched: null });
      // Arrêt propre (accusé, frame exit) et non TerminateProcess de repli.
      await waitFor(() => exit !== null);
      expect(exit).toEqual({ exitCode: null, signal: null });
      expect(isProcessAlive(pid)).toBe(false);
      expect(elapsed).toBeLessThan(5_000);
      await expect(stat(ptyHostPidFilePath(root, agent))).rejects.toThrow();
      await expect(stat(ptyHostStopFilePath(root, agent))).rejects.toThrow();
      conn.close();
    }));

  it('identité : un PID file antidaté (PID repris) ou visant l’hôte d’un autre agent est stale, jamais tué', () =>
    withRealPtySlot(async () => {
      const { pid } = await ensurePtyHost(root, agent, {
        shell: FIXTURE,
        args: ['echo-lines'],
        cwd: root,
      });
      const live = await ptyHostStatus(root, agent, { fresh: true });
      expect(live).toMatchObject({ running: true, verified: true, implementation: 'native', pid });

      // Même PID, mais publié bien avant la création du process : c'est un
      // repreneur du numéro, pas l'hôte publié.
      const pidFile = ptyHostPidFilePath(root, agent);
      const original = await readFile(pidFile, 'utf8');
      const doc = JSON.parse(original);
      await writeFile(
        pidFile,
        JSON.stringify({ ...doc, startedAt: new Date(Date.now() - 3_600_000).toISOString() }),
      );
      expect(await ptyHostStatus(root, agent, { fresh: true })).toMatchObject({
        running: false,
        stale: true,
      });

      // L'hôte d'un AUTRE agent ne passe pas pour celui-ci.
      const other = 'agent-other';
      await seedAgentRegistry(root, other);
      const otherPidFile = ptyHostPidFilePath(root, other);
      const { mkdir } = await import('node:fs/promises');
      await mkdir(path.dirname(otherPidFile), { recursive: true });
      await writeFile(otherPidFile, original);
      expect(await ptyHostStatus(root, other, { fresh: true })).toMatchObject({ stale: true });
      expect(await stopPtyHost(root, other)).toMatchObject({ stopped: false, wasStale: true });
      expect(isProcessAlive(pid)).toBe(true);

      await writeFile(pidFile, original);
    }));

  it('deux démarrages concurrents convergent sur un seul hôte', () =>
    withRealPtySlot(async () => {
      const options = { shell: FIXTURE, args: ['echo-lines'], cwd: root };
      const [a, b] = await Promise.all([
        ensurePtyHost(root, agent, options),
        ensurePtyHost(root, agent, options),
      ]);
      expect(a.pid).toBe(b.pid);
      expect([a.started, b.started].filter(Boolean)).toHaveLength(1);
    }));

  describe('shell de l’hôte configurable (pty.shell / pty.shellArgs)', () => {
    const writePtyConfig = (pty) =>
      writeFile(path.join(root, '.striartrc.json'), JSON.stringify({ pty }), 'utf8');

    async function readEcho() {
      let text = '';
      const conn = connectAttachClient(root, agent, { onData: (t) => (text += t) });
      try {
        await waitFor(() => text.includes('ECHO-READY'), REAL_PTY_WAIT_MS);
      } finally {
        conn.close();
      }
    }

    it('sans shell explicite : pty.shell et pty.shellArgs de la config lancent l’hôte', () =>
      withRealPtySlot(async () => {
        await writePtyConfig({ shell: FIXTURE, shellArgs: ['echo-lines'] });
        await ensurePtyHost(root, agent, { cwd: root });
        await readEcho();
      }));

    it('shell explicite de l’appelant > pty.shell : la config n’est même pas résolue', () =>
      withRealPtySlot(async () => {
        // Un nom valide mais introuvable : si la config était consultée, le
        // démarrage échouerait avec PTY_SHELL_INVALID.
        await writePtyConfig({ shell: 'shell-introuvable-xyz', shellArgs: ['ignore-moi'] });
        await ensurePtyHost(root, agent, { shell: FIXTURE, args: ['echo-lines'], cwd: root });
        await readEcho();
      }));

    it('pty.shell introuvable : PTY_SHELL_INVALID, aucun hôte, aucun repli sur auto', async () => {
      await writePtyConfig({ shell: 'shell-introuvable-xyz' });
      await expect(ensurePtyHost(root, agent, { cwd: root })).rejects.toMatchObject({
        code: 'PTY_SHELL_INVALID',
        details: { reason: 'NOT_FOUND' },
      });
      expect((await ptyHostStatus(root, agent)).running).toBe(false);
    });
  });

  it('programme introuvable : PTY_HOST_SPAWN_FAILED nommé, avec le code natif', async () => {
    await expect(
      ensurePtyHost(root, agent, { shell: 'definitely-not-a-program-xyz', cwd: root }),
    ).rejects.toMatchObject({
      code: 'PTY_HOST_SPAWN_FAILED',
      details: { reason: 'EXITED', nativeCode: 'PTY_PROGRAM_NOT_FOUND' },
    });
    expect((await ptyHostStatus(root, agent)).running).toBe(false);
  });

  it('binaire natif absent : NATIVE_UNAVAILABLE, jamais de repli silencieux', async () => {
    const previous = process.env.STRIART_NATIVE_BIN;
    process.env.STRIART_NATIVE_BIN = path.join(root, 'absent', 'striart-native');
    resetNativeBinaryCache();
    try {
      await expect(
        ensurePtyHost(root, agent, { shell: FIXTURE, args: ['echo-lines'], cwd: root }),
      ).rejects.toMatchObject({ code: 'NATIVE_UNAVAILABLE' });
      expect((await ptyHostStatus(root, agent)).pid).toBeNull();
    } finally {
      if (previous === undefined) delete process.env.STRIART_NATIVE_BIN;
      else process.env.STRIART_NATIVE_BIN = previous;
      resetNativeBinaryCache();
    }
  });

  it('--open : réglages terminal, root et agent passés explicitement à openAgentTerminal', () =>
    withRealPtySlot(async () => {
      const session = await openAttendedSession(
        root,
        { name: agent, path: root, command: FIXTURE },
        { open: true },
      );
      expect(session.terminal).toMatchObject({ launched: true });
      expect(openedTerminals).toHaveLength(1);
      expect(openedTerminals[0]).toMatchObject({ root, agent, cwd: root });
      expect(openedTerminals[0]).toHaveProperty('terminal');
      expect(openedTerminals[0].argv.slice(-2)).toEqual(['attach', agent]);
    }));

  it('node-pty n’est plus une dépendance ni importé par le code', async () => {
    const pkg = JSON.parse(await readFile(path.join(REPO_ROOT, 'package.json'), 'utf8'));
    expect(pkg.dependencies).not.toHaveProperty('node-pty');
    expect(JSON.stringify(pkg.allowScripts ?? {})).not.toContain('node-pty');
    const { readdir } = await import('node:fs/promises');
    const files = await readdir(path.join(REPO_ROOT, 'src'), { recursive: true });
    for (const file of files.filter((f) => /\.(ts|js)$/.test(f))) {
      const source = await readFile(path.join(REPO_ROOT, 'src', file), 'utf8');
      expect(source, file).not.toMatch(/from ['"]node-pty['"]|import\(['"]node-pty['"]\)/);
    }
  });
});

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { StriartError } from '../../src/errors.js';
import {
  attachSocketPath,
  connectAttachClient,
  hasOwnedSession,
  startOwnedSession,
  stopOwnedSession,
  writeToOwnedSession,
} from '../../src/pty-attach.ts';
import {
  REAL_PTY_WAIT_MS,
  quietShell,
  waitFor as waitForHelper,
  withRealPtySlot,
  ECHO_EOL,
} from '../helpers/pty-test-utils.js';

// Un vrai shell interactif — pas `node -e` : node-pty (ConPTY) plante
// (« AttachConsole failed », interne à node-pty) quand le process hébergé
// est lui-même un node.exe, spécifique à cette combinaison. Le cas d'usage
// réel de ce module EST un shell/outil interactif, donc c'est aussi le cas
// le plus représentatif à tester.
// Sans profil (cf. quietShell) : ce fichier teste le pty possédé, pas le profil.
const { shell: SHELL, args: SHELL_ARGS } = quietShell();

const waitFor = (predicate) => waitForHelper(predicate, REAL_PTY_WAIT_MS);

const exists = async (p) => Boolean(await stat(p).catch(() => null));

describe('pty-attach', () => {
  let root;
  const agent = 'agent-a';

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'striart-pty-'));
  });

  afterEach(async () => {
    await stopOwnedSession(agent).catch(() => {});
    await rm(root, { recursive: true, force: true }).catch(() => {});
    // Laisse le temps à l'agent interne de node-pty (bug connu ConPTY sous
    // Windows, cf. openai/codex#25272 — AttachConsole non essayé/catché,
    // process interne parfois lent à sortir sous console imbriquée) de se
    // dissiper avant le prochain pty.spawn() du test suivant.
    await new Promise((resolve) => setTimeout(resolve, 400));
  });

  async function start() {
    await startOwnedSession(root, agent, { shell: SHELL, args: SHELL_ARGS, cwd: root });
  }

  it('démarre un pty possédé et est idempotent sur un second démarrage', () =>
    withRealPtySlot(async () => {
      expect(hasOwnedSession(agent)).toBe(false);
      await start();
      expect(hasOwnedSession(agent)).toBe(true);

      // Deuxième démarrage sur le même agent : ne respawn pas, ne lève pas —
      // c'est ce qui permet à plusieurs `--open` de partager le même pty.
      await start();
      expect(hasOwnedSession(agent)).toBe(true);
    }));

  it('writeToOwnedSession (écriture directe du process propriétaire) atteint un client attaché', () =>
    withRealPtySlot(async () => {
      await start();

      let buffer = '';
      let connected = false;
      const conn = connectAttachClient(root, agent, {
        onData: (text) => (buffer += text),
        onConnect: () => (connected = true),
      });
      await waitFor(() => connected);

      writeToOwnedSession(agent, 'echo MARQUEUR-PROPRIETAIRE');
      await waitFor(() => buffer.includes(`MARQUEUR-PROPRIETAIRE${ECHO_EOL}`));

      conn.close();
    }));

  it("un second client peut injecter un message alors qu'un premier est déjà attaché", () =>
    withRealPtySlot(async () => {
      await start();

      let bufferA = '';
      let bufferB = '';
      let connectedA = false;
      const clientA = connectAttachClient(root, agent, {
        onData: (t) => (bufferA += t),
        onConnect: () => (connectedA = true),
      });
      await waitFor(() => connectedA); // premier client réellement attaché avant l'injection du second

      // clientB arrive APRÈS clientA — comme la zone de saisie `@agent` du bus
      // qui écrit alors qu'une fenêtre --open est déjà attachée.
      let connectedB = false;
      const clientB = connectAttachClient(root, agent, {
        onData: (t) => (bufferB += t),
        onConnect: () => (connectedB = true),
      });
      await waitFor(() => connectedB);
      clientB.sendMessage('echo MARQUEUR-CLIENT-B');

      // clientA (déjà attaché avant) voit AUSSI la sortie produite par
      // l'injection de clientB — c'est tout le point du multiplexage.
      await waitFor(() => bufferA.includes(`MARQUEUR-CLIENT-B${ECHO_EOL}`));
      await waitFor(() => bufferB.includes(`MARQUEUR-CLIENT-B${ECHO_EOL}`));

      clientA.close();
      clientB.close();
    }));

  it('un client déjà attaché est notifié (onResize) quand un AUTRE client redimensionne le pty', () =>
    withRealPtySlot(async () => {
      await start();

      let connectedA = false;
      let resizeSeenByA = null;
      const clientA = connectAttachClient(root, agent, {
        onData: () => {},
        onConnect: () => (connectedA = true),
        onResize: (info) => (resizeSeenByA = info),
      });
      await waitFor(() => connectedA); // A déjà attaché AVANT que B ne redimensionne

      // clientB se connecte en demandant une taille précise — déclenche la
      // frame `resize` côté serveur (cf. `onConnect` de `connectAttachClient`),
      // qui doit désormais être DIFFUSÉE à clientA aussi, pas seulement
      // appliquée au pty en silence.
      const clientB = connectAttachClient(root, agent, {
        onData: () => {},
        cols: 111,
        rows: 41,
      });

      await waitFor(() => resizeSeenByA !== null);
      expect(resizeSeenByA).toEqual({ cols: 111, rows: 41 });

      clientA.close();
      clientB.close();
    }));

  it('writeToOwnedSession sur un agent sans pty possédé lève PTY_SESSION_NOT_FOUND', () => {
    expect(() => writeToOwnedSession('agent-fantome', 'x')).toThrow(StriartError);
    try {
      writeToOwnedSession('agent-fantome', 'x');
    } catch (error) {
      expect(error.code).toBe('PTY_SESSION_NOT_FOUND');
    }
  });

  it('connectAttachClient sur un agent jamais démarré signale onError, ne plante jamais le process', async () => {
    let capturedError = null;
    const conn = connectAttachClient(root, 'jamais-demarre', {
      onData: () => {},
      onError: (error) => (capturedError = error),
    });
    await waitFor(() => capturedError !== null);
    expect(capturedError).toBeInstanceOf(Error);
    conn.close();
  });

  it('stopOwnedSession tue le pty, ferme les clients attachés et libère le canal', () =>
    withRealPtySlot(async () => {
      await start();
      const socketPath = attachSocketPath(root, agent);
      if (process.platform !== 'win32') {
        expect(await exists(socketPath)).toBe(true);
      }

      let exitFrame = null;
      let connected = false;
      const conn = connectAttachClient(root, agent, {
        onData: () => {},
        onExit: (exitCode, signal) => (exitFrame = { exitCode, signal }),
        onConnect: () => (connected = true),
      });
      await waitFor(() => connected);

      await stopOwnedSession(agent);
      expect(hasOwnedSession(agent)).toBe(false);
      await waitFor(() => exitFrame !== null);

      if (process.platform !== 'win32') {
        expect(await exists(socketPath)).toBe(false);
      }
      conn.close();
    }));
});

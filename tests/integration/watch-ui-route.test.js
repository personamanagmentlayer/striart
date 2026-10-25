import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { stopPtyHost } from '../../src/pty-host.ts';
import { routeAgentMessage } from '../../src/watch-ui.ts';
import {
  REAL_PTY_WAIT_MS,
  connectWithRetry,
  seedAgentRegistry,
  waitFor,
  withRealPtySlot,
  writeQuietPtyConfig,
} from '../helpers/pty-test-utils.js';

// Rangé en intégration (et non avec le reste de watch-ui) : ce bloc démarre un
// VRAI hôte de pty et un shell — process, disque, temps réel. Dans la suite
// unitaire, il dépassait le budget de la boucle courte et y échouait par
// intermittence sous charge.
const ECHO_EOL = process.platform === 'win32' ? '\r\n' : '\n';

describe('routeAgentMessage', () => {
  let root;
  const agent = 'agent-route';

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'striart-watch-ui-'));
  });

  afterEach(async () => {
    await stopPtyHost(root, agent).catch(() => {});
    await rm(root, { recursive: true, force: true }).catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 400)); // cf. tests/integration/pty-attach.test.js
  });

  it('refuse un agent inconnu (meta absente)', async () => {
    const result = await routeAgentMessage(root, 'fantome', 'salut', undefined);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('inconnu');
  });

  it('refuse explicitement un agent autonome SANS session ACP vivante (Phase E : seule une session ACP hébergée est adressable)', async () => {
    const result = await routeAgentMessage(root, agent, 'salut', {
      mode: 'autonomous',
      path: root,
      command: null,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain('autonome');
      expect(result.reason).toContain('ACP');
      expect(result.reason).toContain('one-shot');
    }
  });

  it("démarre l'hôte au besoin et livre le message à un agent supervisé (vérifié via un attach client)", () =>
    withRealPtySlot(async () => {
      // ensurePtyHost (appelé par routeAgentMessage) exige désormais un agent
      // réellement inscrit au registre (défense en profondeur) — seedé ici,
      // séparément du 4e argument (agentMeta) passé directement à la fonction.
      await seedAgentRegistry(root, agent);
      // Shell sans profil via la config `pty.shellArgs` du dépôt (routeAgentMessage
      // laisse l'hôte choisir son shell) : ce test ne porte pas sur le profil.
      await writeQuietPtyConfig(root);
      // `command` est l'OUTIL de l'agent (résolu par resolveAttendedCommand),
      // pas le shell hébergeant le pty (celui-là vient de pty.shell/auto —
      // choisi par ensurePtyHost) : lui passer SHELL relancerait un second
      // shell imbriqué comme "commande initiale", pas ce que ce test vérifie.
      const result = await routeAgentMessage(root, agent, 'echo ROUTE-MARQUEUR', {
        mode: 'attended',
        path: root,
        command: 'echo COMMANDE-INITIALE-IGNOREE',
      });
      expect(result.ok).toBe(true);

      // Grâce au tampon de rejeu (pty-attach.ts), un client qui se connecte
      // APRÈS l'envoi voit quand même la sortie déjà produite.
      let buffer = '';
      const conn = await connectWithRetry(root, agent, { onData: (t) => (buffer += t) });
      await waitFor(() => buffer.includes(`ROUTE-MARQUEUR${ECHO_EOL}`), REAL_PTY_WAIT_MS);
      conn.close();
    }));
});

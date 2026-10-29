import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTempRepo } from '../helpers/temp-repo.js';
import { seedAgentRegistry } from '../helpers/pty-test-utils.js';
import { initStriart } from '../../src/init.ts';
import { stopDashboardDaemon } from '../../src/daemon.ts';
import { resolveAgentMeta, runShellCommand, runStriartCommand } from '../../src/watch-ui.ts';

/**
 * `runStriartCommand` exécute le VRAI `cli.js` en subprocess (même binaire
 * qu'un humain taperait) — touche un vrai repo git, donc intégration plutôt
 * qu'unitaire (convention du projet : ce qui touche disque/git va ici).
 */
describe('runStriartCommand (intégration)', () => {
  let repo;

  beforeEach(async () => {
    repo = await createTempRepo();
    await initStriart(repo.root);
  });

  afterEach(async () => {
    await stopDashboardDaemon({ root: repo.root }).catch(() => {});
    await repo.cleanup();
  });

  it('exécute une vraie commande striart et renvoie sa sortie (status --json)', async () => {
    const result = await runStriartCommand(repo.root, ['status', '--json']);
    expect(result.ok).toBe(true);
    // Contrat machine v1 : enveloppe stable, même vue que l'outil MCP striart_status.
    const parsed = JSON.parse(result.output);
    expect(parsed).toMatchObject({
      schemaVersion: 1,
      command: 'status',
      ok: true,
      data: { agents: [], queue: [], tickets: [], mainSession: null },
    });
  });

  it('refuse explicitement une commande au premier plan (watch)', async () => {
    const result = await runStriartCommand(repo.root, ['watch']);
    expect(result.ok).toBe(false);
    expect(result.output).toContain('second watcher');
  });

  it(
    'refuse explicitement mcp — resterait bloqué à lire son stdin (une pipe ' +
      "execa vide, jamais le terminal) jusqu'au timeout, pour rien",
    async () => {
      const result = await runStriartCommand(repo.root, ['mcp']);
      expect(result.ok).toBe(false);
      expect(result.output).toContain('stdin');
    },
  );

  it('refuse "dashboard" seul (serveur HTTP en premier plan), mais suggère --daemon', async () => {
    const result = await runStriartCommand(repo.root, ['dashboard']);
    expect(result.ok).toBe(false);
    expect(result.output).toContain('--daemon');
  });

  it(
    '"dashboard --daemon" est en revanche autorisé — il rend la main immédiatement ' +
      '(même mécanisme que watch --daemon)',
    async () => {
      try {
        const result = await runStriartCommand(repo.root, ['dashboard', '--daemon', '--port', '0']);
        expect(result.ok).toBe(true);
        expect(result.output).toContain('tableau de bord lancé en arrière-plan');
      } finally {
        // Le daemon est un vrai process détaché : sans arrêt, il survivrait au
        // dépôt temporaire supprimé par afterEach.
        await runStriartCommand(repo.root, ['dashboard', '--stop']);
      }
    },
  );

  it('"dashboard --status"/"--stop" sont autorisés même sans --daemon (pas de serveur démarré)', async () => {
    const status = await runStriartCommand(repo.root, ['dashboard', '--status']);
    expect(status.ok).toBe(true);
    expect(status.output).toContain('aucun tableau de bord en arrière-plan');

    const stop = await runStriartCommand(repo.root, ['dashboard', '--stop']);
    expect(stop.ok).toBe(true);
    expect(stop.output).toContain('aucun tableau de bord en arrière-plan');
  });

  it('remonte un exitCode non nul (commande invalide) sans planter', async () => {
    const result = await runStriartCommand(repo.root, ['stop', 'agent-jamais-cree']);
    expect(result.ok).toBe(false);
    expect(result.output).toContain('Agent inconnu');
  });
});

/**
 * `runShellCommand` — "!" dans le champ, cf. SECURITY.md : même frontière de
 * confiance que le bus "@agent" (entrée locale uniquement), mais un VRAI
 * shell (PowerShell/bash) plutôt qu'un argv `striart <tokens>` : pipes,
 * redirections et binaires quelconques (git compris) fonctionnent, exactement
 * comme dans un vrai terminal.
 */
describe('runShellCommand (intégration)', () => {
  let repo;

  beforeEach(async () => {
    repo = await createTempRepo();
    await initStriart(repo.root);
  });

  afterEach(async () => {
    await repo.cleanup();
  });

  it('exécute une vraie commande shell (pas striart) et renvoie sa sortie', async () => {
    const result = await runShellCommand(repo.root, 'echo MARQUEUR-SHELL-REEL');
    expect(result.ok).toBe(true);
    expect(result.output).toContain('MARQUEUR-SHELL-REEL');
  });

  it("s'exécute dans le repo (cwd) — vérifié avec un vrai git (exemple de l'utilisateur)", async () => {
    const result = await runShellCommand(repo.root, 'git stash list');
    expect(result.ok).toBe(true); // liste vide (rien stashé), mais réussit bien dans CE repo
  });

  it('remonte un exitCode non nul sans planter (commande shell invalide)', async () => {
    const result = await runShellCommand(repo.root, 'striart-commande-inexistante-xyz');
    expect(result.ok).toBe(false);
  });

  it('un VRAI shell, pas juste striart en argv — pipes fonctionnent (impossible avec runStriartCommand)', async () => {
    const command =
      process.platform === 'win32' ? 'echo hello | Select-String hello' : 'echo hello | grep hello';
    const result = await runShellCommand(repo.root, command);
    expect(result.ok).toBe(true);
    expect(result.output).toContain('hello');
  });
});

/**
 * Reproduit la course de démarrage rapportée en usage réel : un message
 * "@agent" tapé avant que le premier `listAgents()` de l'UI ait résolu ne
 * doit jamais rapporter "Agent inconnu" pour un agent pourtant bien réel.
 */
describe('resolveAgentMeta (intégration)', () => {
  let repo;

  beforeEach(async () => {
    repo = await createTempRepo();
    await initStriart(repo.root);
  });

  afterEach(async () => {
    await repo.cleanup();
  });

  it("trouve l'agent dans l'instantané fourni, sans appel frais nécessaire", async () => {
    const snapshot = [{ name: 'agent-a', path: repo.root, command: null }];
    const meta = await resolveAgentMeta(repo.root, snapshot, 'agent-a');
    expect(meta?.name).toBe('agent-a');
  });

  it(
    'instantané vide (course de démarrage) : retombe sur un appel listAgents frais ' +
      'et trouve quand même un agent réellement enregistré',
    async () => {
      await seedAgentRegistry(repo.root, 'agent-a', { path: repo.root });
      const meta = await resolveAgentMeta(repo.root, [], 'agent-a');
      expect(meta?.name).toBe('agent-a');
    },
  );

  it("agent réellement inexistant : reste introuvable même après l'appel frais", async () => {
    const meta = await resolveAgentMeta(repo.root, [], 'agent-jamais-cree');
    expect(meta).toBeUndefined();
  });
});

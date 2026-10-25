/**
 * `stop` et `clean` nettoient les artefacts périphériques de l'agent (hôte ACP
 * persistant, Tab Configs Warp) : erreurs RAPPORTÉES, jamais bloquantes ni
 * avalées.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createTempRepo } from '../helpers/temp-repo.js';

const spies = vi.hoisted(() => ({
  stopAcpHost: vi.fn(),
  removeAgentTerminalArtifacts: vi.fn(),
}));

vi.mock('../../src/acp/host.ts', async (importOriginal) => ({
  ...(await importOriginal()),
  stopAcpHost: spies.stopAcpHost,
}));
vi.mock('../../src/terminal.js', async (importOriginal) => ({
  ...(await importOriginal()),
  removeAgentTerminalArtifacts: spies.removeAgentTerminalArtifacts,
}));

const { initStriart } = await import('../../src/init.js');
const { createAgent, cleanClones, removeAgentFromRegistry } = await import('../../src/clone.js');
const { stopAgent } = await import('../../src/orchestrator.js');

describe('artefacts périphériques à l’arrêt et au nettoyage (intégration)', () => {
  let repo;

  beforeEach(async () => {
    spies.stopAcpHost.mockReset();
    spies.removeAgentTerminalArtifacts.mockReset();
    spies.stopAcpHost.mockResolvedValue({
      stopped: true,
      wasStale: false,
      stopping: false,
      untouched: null,
    });
    spies.removeAgentTerminalArtifacts.mockResolvedValue(['/tmp/warp-tab.yaml']);
    repo = await createTempRepo();
    await initStriart(repo.root);
    await writeFile(
      path.join(repo.root, '.striartrc.json'),
      JSON.stringify({ testCommand: 'node -e "process.exit(0)"' }),
    );
  });

  afterEach(async () => {
    await repo.cleanup();
  });

  it('stopAgent : hôte ACP arrêté et Tab Configs Warp supprimés, rapportés dans le résultat', async () => {
    await createAgent({ root: repo.root, name: 'agent-a' });

    const result = await stopAgent({ root: repo.root, agent: 'agent-a', force: true });

    expect(spies.stopAcpHost).toHaveBeenCalledWith(repo.root, 'agent-a');
    expect(spies.removeAgentTerminalArtifacts).toHaveBeenCalledWith(
      expect.objectContaining({ root: repo.root, agent: 'agent-a' }),
    );
    expect(result.artifacts).toMatchObject({
      acpHost: { stopped: true },
      terminalArtifacts: ['/tmp/warp-tab.yaml'],
      errors: [],
    });
  });

  it('stopAgent : un échec d’artefact est RAPPORTÉ sans défaire l’arrêt', async () => {
    await createAgent({ root: repo.root, name: 'agent-a' });
    spies.stopAcpHost.mockRejectedValue(new Error('hôte illisible'));
    spies.removeAgentTerminalArtifacts.mockRejectedValue(new Error('Warp inaccessible'));

    const result = await stopAgent({ root: repo.root, agent: 'agent-a', force: true });

    expect(result.agent).toBe('agent-a');
    expect(result.artifacts.errors).toEqual([
      { what: 'acp-host', message: 'hôte illisible' },
      { what: 'terminal-artifacts', message: 'Warp inaccessible' },
    ]);
  });

  it('cleanClones : artefacts nettoyés pour chaque clone retiré, échecs dans artifactErrors', async () => {
    await createAgent({ root: repo.root, name: 'archive' });
    await removeAgentFromRegistry(repo.root, 'archive');
    spies.removeAgentTerminalArtifacts.mockRejectedValue(new Error('Warp inaccessible'));

    const result = await cleanClones({ root: repo.root, agent: 'archive', force: true });

    expect(result.removed.map((r) => r.name)).toEqual(['archive']);
    expect(spies.stopAcpHost).toHaveBeenCalledWith(repo.root, 'archive');
    expect(result.artifactErrors).toEqual([
      { name: 'archive', what: 'terminal-artifacts', message: 'Warp inaccessible' },
    ]);
  });
});

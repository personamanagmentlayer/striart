/**
 * `striart prune` et l'hôte de pty (K-I9) : un clone ARRÊTÉ (absent du registre)
 * dont l'hôte de terminal vit encore a pour répertoire courant son worktree.
 * cleanClones et la reprise des suppressions inachevées le respectent ;
 * la rétention doit le faire aussi — jamais de suppression sous un terminal
 * ouvert, et un état d'hôte illisible vaut « vivant » (fail closed).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, readdir, stat, utimes, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createTempRepo } from '../helpers/temp-repo.js';
import { initStriart } from '../../src/init.js';
import { createAgent, removeAgentFromRegistry, reuseAgent } from '../../src/clone.js';

// Identité de l'hôte : pilotée par le test (vivant reconnu / mort).
const verdict = vi.hoisted(() => ({ value: 'alive' }));
vi.mock('../../src/process-info.ts', async (importOriginal) => ({
  ...(await importOriginal()),
  checkProcessInstance: async () => {
    if (verdict.value === 'throw') throw new Error('lecture d’identité impossible');
    return verdict.value;
  },
}));

const { pruneWorkspace } = await import('../../src/prune.js');

async function ageDirectory(dir, date) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) await ageDirectory(p, date);
    await utimes(p, date, date).catch(() => {});
  }
  await utimes(dir, date, date).catch(() => {});
}

describe('prune — hôte de pty vivant', () => {
  let repo;
  const OLD = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

  async function stoppedOldClone(name) {
    const info = await createAgent({ root: repo.root, name });
    await removeAgentFromRegistry(repo.root, name);
    await ageDirectory(info.path, OLD);
    return info;
  }

  async function publishHost(name, content) {
    const pidFile = path.join(repo.root, '.striart', 'pty', name, 'host.pid');
    await mkdir(path.dirname(pidFile), { recursive: true });
    await writeFile(pidFile, content);
  }

  beforeEach(async () => {
    verdict.value = 'alive';
    repo = await createTempRepo();
    await initStriart(repo.root);
  });

  afterEach(async () => {
    await repo.cleanup();
  });

  it('un clone arrêté et inactif dont l’hôte de pty vit est CONSERVÉ (raison rapportée)', async () => {
    const info = await stoppedOldClone('vieux');
    await publishHost(
      'vieux',
      JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }),
    );

    const result = await pruneWorkspace({ root: repo.root, days: 14 });

    expect(result.clones.removed).toEqual([]);
    expect(result.clones.kept).toEqual([
      expect.objectContaining({ name: 'vieux', reason: 'PTY_HOST_LIVE' }),
    ]);
    await expect(stat(info.path)).resolves.toBeTruthy();
  });

  it('état de l’hôte impossible à établir : présumé vivant, rien n’est supprimé (fail closed)', async () => {
    verdict.value = 'throw';
    const info = await stoppedOldClone('vieux');
    await publishHost(
      'vieux',
      JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }),
    );

    const result = await pruneWorkspace({ root: repo.root, days: 14 });

    expect(result.clones.removed).toEqual([]);
    expect(result.clones.kept.map((c) => c.name)).toEqual(['vieux']);
    await expect(stat(info.path)).resolves.toBeTruthy();
  });

  it('l’hôte est mort (PID file périmé) : la rétention supprime le clone comme avant', async () => {
    verdict.value = 'dead';
    const info = await stoppedOldClone('vieux');
    await publishHost(
      'vieux',
      JSON.stringify({ pid: 2_000_000_000, startedAt: new Date().toISOString() }),
    );

    const result = await pruneWorkspace({ root: repo.root, days: 14 });

    expect(result.clones.removed.map((c) => c.name)).toEqual(['vieux']);
    await expect(stat(info.path)).rejects.toThrow();
  });

  it('dry-run : même décision, rien ne bouge', async () => {
    const info = await stoppedOldClone('vieux');
    await publishHost(
      'vieux',
      JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }),
    );

    const result = await pruneWorkspace({ root: repo.root, days: 14, dryRun: true });

    expect(result.clones.removed).toEqual([]);
    expect(result.clones.kept[0]).toMatchObject({ name: 'vieux', reason: 'PTY_HOST_LIVE' });
    await expect(stat(info.path)).resolves.toBeTruthy();
  });

  it('reuse : un clone dont l’hôte de pty vit est refusé (SESSION_LIVE), même avec force', async () => {
    const info = await stoppedOldClone('vieux');
    await publishHost(
      'vieux',
      JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }),
    );

    await expect(reuseAgent({ root: repo.root, name: 'vieux', force: true })).rejects.toMatchObject(
      {
        code: 'SESSION_LIVE',
        kind: 'refusal',
      },
    );
    await expect(stat(info.path)).resolves.toBeTruthy();
  });

  it('reuse : hôte mort → réhabilitation normale', async () => {
    verdict.value = 'dead';
    await stoppedOldClone('vieux');
    await publishHost(
      'vieux',
      JSON.stringify({ pid: 2_000_000_000, startedAt: new Date().toISOString() }),
    );

    const info = await reuseAgent({ root: repo.root, name: 'vieux' });

    expect(info.name).toBe('vieux');
  });
});

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readdir, stat, utimes } from 'node:fs/promises';
import path from 'node:path';
import { createTempRepo } from '../helpers/temp-repo.js';
import { initStriart } from '../../src/init.js';
import { createAgent, removeAgentFromRegistry } from '../../src/clone.js';
import {
  closeConflictTicket,
  createConflictTicket,
  listConflictTickets,
} from '../../src/conflicts.js';
import { pruneWorkspace } from '../../src/prune.js';

/** Vieillit récursivement tout un dossier (mtime) pour simuler l'inactivité. */
async function ageDirectory(dir, date) {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) await ageDirectory(p, date);
    await utimes(p, date, date).catch(() => {});
  }
  await utimes(dir, date, date).catch(() => {});
}

describe('striart prune — rétention (intégration)', () => {
  let repo;
  const OLD = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000); // 30 jours

  beforeEach(async () => {
    repo = await createTempRepo();
    await initStriart(repo.root);
  });

  afterEach(async () => {
    await repo.cleanup();
  });

  it('supprime les clones arrêtés inactifs, garde les récents et les actifs', async () => {
    const vieux = await createAgent({ root: repo.root, name: 'vieux' });
    const recent = await createAgent({ root: repo.root, name: 'recent' });
    const actif = await createAgent({ root: repo.root, name: 'actif' });

    // vieux et recent sont arrêtés ; seul vieux est inactif depuis 30 jours.
    await removeAgentFromRegistry(repo.root, 'vieux');
    await removeAgentFromRegistry(repo.root, 'recent');
    await ageDirectory(vieux.path, OLD);
    await ageDirectory(actif.path, OLD); // actif ET vieux : doit être conservé quand même

    const result = await pruneWorkspace({ root: repo.root, days: 14 });
    expect(result.clones.removed).toEqual([
      { name: 'vieux', freedBytes: expect.any(Number), lastActivity: expect.any(String) },
    ]);
    expect(result.clones.kept.map((c) => c.name)).toEqual(['recent']);
    expect(result.freedBytes).toBeGreaterThan(0);

    await expect(stat(vieux.path)).rejects.toThrow(); // supprimé
    await expect(stat(recent.path)).resolves.toBeTruthy(); // activité récente
    await expect(stat(actif.path)).resolves.toBeTruthy(); // règle d'or n°3
  });

  it('supprime les tickets résolus anciens, jamais les ouverts', async () => {
    const ouvert = await createConflictTicket(repo.root, {
      agent: 'a',
      branch: 'b',
      sha: 'c'.repeat(40),
      reason: 'GATE_FAILED',
      log: 'x',
    });
    const resolu = await createConflictTicket(repo.root, {
      agent: 'a',
      branch: 'b',
      sha: 'd'.repeat(40),
      reason: 'MERGE_CONFLICT',
    });
    await closeConflictTicket(repo.root, resolu.id);
    // Vieillit le marqueur RESOLVED.
    await utimes(path.join(resolu.dir, 'RESOLVED'), OLD, OLD);

    const result = await pruneWorkspace({ root: repo.root, days: 14 });
    expect(result.tickets.removed).toEqual([{ id: resolu.id, resolvedAt: expect.any(String) }]);
    await expect(stat(resolu.dir)).rejects.toThrow();
    await expect(stat(ouvert.dir)).resolves.toBeTruthy(); // fallback humain intouchable

    const remaining = await listConflictTickets(repo.root, { includeResolved: true });
    expect(remaining.map((t) => t.id)).toEqual([ouvert.id]);
  });

  it('--dry-run : rapporte sans rien supprimer', async () => {
    const vieux = await createAgent({ root: repo.root, name: 'vieux' });
    await removeAgentFromRegistry(repo.root, 'vieux');
    await ageDirectory(vieux.path, OLD);

    const result = await pruneWorkspace({ root: repo.root, days: 14, dryRun: true });
    expect(result.dryRun).toBe(true);
    expect(result.clones.removed).toHaveLength(1);
    await expect(stat(vieux.path)).resolves.toBeTruthy(); // rien supprimé
  });

  it('days: 0 → tout ce qui est arrêté est éligible immédiatement', async () => {
    const stopped = await createAgent({ root: repo.root, name: 'stopped' });
    await removeAgentFromRegistry(repo.root, 'stopped');

    const result = await pruneWorkspace({ root: repo.root, days: 0 });
    expect(result.clones.removed.map((c) => c.name)).toEqual(['stopped']);
    await expect(stat(stopped.path)).rejects.toThrow();
  });
});

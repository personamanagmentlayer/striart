import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createTempRepo, backdateDir } from '../helpers/temp-repo.js';
import { initStriart } from '../../src/init.ts';
import {
  cleanClones,
  clearCloneSizeCache,
  cloneWorkActivityMs,
  createAgent,
  dirSizeBytes,
  listAgents,
  removeAgentFromRegistry,
} from '../../src/clone.ts';
import { CLONE_MEMORY_FILE } from '../../src/memory.ts';

// D4 : la taille des clones est en cache horodaté (`sizesComputedAt`) ; le signal
// d'activité qui garde cleanClones/reuseAgent reste EXACT et n'est jamais caché.

/** Référence : l'algorithme d'activité d'avant D4 (parcours complet, .git exclu au premier niveau). */
async function referenceWorkActivityMs(clonePath) {
  async function latest(dir) {
    let max = 0;
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const p = path.join(dir, entry.name);
      const s = await stat(p).catch(() => null);
      if (!s) continue;
      max = Math.max(max, s.mtimeMs);
      if (entry.isDirectory()) max = Math.max(max, await latest(p));
    }
    return max;
  }
  let max = 0;
  const entries = await readdir(clonePath, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    if (entry.name === '.git' || entry.name === CLONE_MEMORY_FILE) continue;
    const p = path.join(clonePath, entry.name);
    const s = await stat(p).catch(() => null);
    if (!s) continue;
    max = Math.max(max, s.mtimeMs);
    if (entry.isDirectory()) max = Math.max(max, await latest(p));
  }
  return max;
}

describe('cache des tailles de clones (intégration)', () => {
  let repo;

  beforeEach(async () => {
    clearCloneSizeCache();
    repo = await createTempRepo();
    await initStriart(repo.root);
  });

  afterEach(async () => {
    vi.useRealTimers();
    await repo.cleanup();
  });

  const byName = (agents) => Object.fromEntries(agents.map((a) => [a.name, a]));

  it('listAgents expose sizesComputedAt ; un second appel sert le cache (même horodatage)', async () => {
    await createAgent({ root: repo.root, name: 'agent-a' });
    const first = byName(await listAgents(repo.root))['agent-a'];
    expect(first.sizesComputedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(first.sizeBytes).toBeGreaterThan(0);

    const second = byName(await listAgents(repo.root))['agent-a'];
    expect(second.sizesComputedAt).toBe(first.sizesComputedAt);
    expect(second.sizeBytes).toBe(first.sizeBytes);
  });

  it('sizeBytes (parcours unique worktree + .git) == dirSizeBytes, fichier de mémoire compris', async () => {
    const info = await createAgent({ root: repo.root, name: 'agent-a' });
    await mkdir(path.join(info.path, 'pkg'), { recursive: true });
    await writeFile(path.join(info.path, 'pkg', 'x.bin'), Buffer.alloc(12_345, 3));
    await writeFile(path.join(info.path, CLONE_MEMORY_FILE), 'mémoire partagée\n');
    const listed = byName(await listAgents(repo.root))['agent-a'];
    expect(listed.sizeBytes).toBe(await dirSizeBytes(info.path));
  });

  it('modifier le worktree invalide le cache : nouvelle taille, nouvel horodatage', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const info = await createAgent({ root: repo.root, name: 'agent-a' });
    const before = byName(await listAgents(repo.root))['agent-a'];

    vi.setSystemTime(Date.now() + 20_000); // au-delà du rafraîchissement minimal, bien avant le TTL
    await writeFile(path.join(info.path, 'big.bin'), Buffer.alloc(300_000, 1));

    const after = byName(await listAgents(repo.root))['agent-a'];
    expect(after.sizeBytes).toBeGreaterThanOrEqual(before.sizeBytes + 300_000);
    expect(Date.parse(after.sizesComputedAt)).toBeGreaterThan(Date.parse(before.sizesComputedAt));
  });

  it('au-delà du TTL, la taille est remesurée même sans modification', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    await createAgent({ root: repo.root, name: 'agent-a' });
    const before = byName(await listAgents(repo.root))['agent-a'];
    vi.setSystemTime(Date.now() + 60 * 60_000);
    const after = byName(await listAgents(repo.root))['agent-a'];
    expect(Date.parse(after.sizesComputedAt)).toBeGreaterThan(Date.parse(before.sizesComputedAt));
  });

  it('SÉCURITÉ : le cache de taille ne masque jamais une activité — un clone ancien redevient actif dès qu’on y écrit', async () => {
    const info = await createAgent({ root: repo.root, name: 'agent-a' });
    await backdateDir(info.path);

    const idle = byName(await listAgents(repo.root))['agent-a'];
    expect(idle.sessionActive).toBe(false); // cache chaud sur la taille
    expect(idle.session.state).toBe('idle');

    // Écriture IMMÉDIATE : bien dans la fenêtre de rafraîchissement minimal du cache.
    await writeFile(path.join(info.path, 'wip.txt'), 'travail en cours\n');
    const busy = byName(await listAgents(repo.root))['agent-a'];
    expect(busy.sessionActive).toBe(true);
    expect(busy.session.state).toBe('recent-activity');
    expect(Date.parse(busy.lastActivity)).toBeGreaterThan(Date.parse(idle.lastActivity));
  });

  it('SÉCURITÉ : cleanClones relit l’activité et la taille (jamais le cache) — clone actif refusé, taille libérée exacte', async () => {
    const info = await createAgent({ root: repo.root, name: 'agent-a' });
    await backdateDir(info.path);
    await listAgents(repo.root); // réchauffe le cache à l'état « ancien »
    await removeAgentFromRegistry(repo.root, 'agent-a');

    await writeFile(path.join(info.path, 'wip.txt'), Buffer.alloc(250_000, 2));
    const guarded = await cleanClones({ root: repo.root });
    expect(guarded.removed).toHaveLength(0);
    expect(guarded.skipped).toEqual([{ name: 'agent-a', reason: 'IN_USE' }]);

    const forced = await cleanClones({ root: repo.root, force: true });
    expect(forced.removed).toHaveLength(1);
    expect(forced.removed[0].freedBytes).toBeGreaterThanOrEqual(250_000);
  });

  it('équivalence : cloneWorkActivityMs == l’algorithme de référence (worktree, .git et mémoire exclus)', async () => {
    const info = await createAgent({ root: repo.root, name: 'agent-a' });
    await backdateDir(info.path);
    const check = async () => {
      expect(await cloneWorkActivityMs(info.path)).toBe(await referenceWorkActivityMs(info.path));
    };
    await check();

    await mkdir(path.join(info.path, 'a', 'b', 'c'), { recursive: true });
    await writeFile(path.join(info.path, 'a', 'b', 'c', 'deep.txt'), 'x');
    await check();
    const withDeep = await cloneWorkActivityMs(info.path);
    expect(withDeep).toBeGreaterThan(Date.now() - 60_000);

    // .git et le fichier de mémoire ne comptent PAS (Striart y écrit en continu).
    await backdateDir(info.path);
    await writeFile(path.join(info.path, '.git', 'striart-noise'), 'x');
    await writeFile(path.join(info.path, CLONE_MEMORY_FILE), 'mémoire\n');
    await check();
    expect(await cloneWorkActivityMs(info.path)).toBeLessThan(Date.now() - 30 * 60_000);
  });

  it('une modification en place (sans création ni suppression) est vue par le signal d’activité', async () => {
    const info = await createAgent({ root: repo.root, name: 'agent-a' });
    await backdateDir(info.path);
    await writeFile(path.join(info.path, 'README.md'), '# modifié en place\n');
    expect(await cloneWorkActivityMs(info.path)).toBeGreaterThan(Date.now() - 60_000);
  });
});

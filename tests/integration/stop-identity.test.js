import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { requestStop } from '../../src/stop-request.ts';
import { killProcessTree } from '../../src/process-tree.ts';

/** S-M2 : aucun signal à un PID dont l'identité n'est plus confirmée, et racine protégée par son heure de création. */
describe('arrêt : identité revérifiée avant tout repli (S-M2)', () => {
  let dir;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'striart-stop-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  // process.pid : vivant et sans accusé (personne ne surveille le fichier d'arrêt).
  const params = (extra) => ({
    file: path.join(dir, 'x.stop'),
    pid: process.pid,
    ackWaitMs: 60,
    waitMs: 60,
    ...extra,
  });

  it('identité non confirmée → fallback jamais appelé, résultat stopping', async () => {
    const fallback = vi.fn();
    const outcome = await requestStop(params({ fallback, confirmIdentity: async () => false }));
    expect(fallback).not.toHaveBeenCalled();
    expect(outcome).toBe('stopping');
  });

  it('identité confirmée → fallback appelé (comportement antérieur conservé)', async () => {
    const fallback = vi.fn();
    await requestStop(params({ fallback, confirmIdentity: async () => true }));
    expect(fallback).toHaveBeenCalledTimes(1);
  });

  it('sans confirmIdentity (appelants existants) → fallback appelé', async () => {
    const fallback = vi.fn();
    await requestStop(params({ fallback }));
    expect(fallback).toHaveBeenCalledTimes(1);
  });

  it('killProcessTree transmet rootStartedMs au binaire natif quand il est connu', async () => {
    const treeKill = vi.fn(async () => ({ complete: true }));
    await killProcessTree(
      { pid: 4242, kill: vi.fn() },
      { treeKill, rootStartedMs: 1_700_000_000_000 },
    );
    expect(treeKill).toHaveBeenCalledWith(4242, { rootStartedMs: 1_700_000_000_000 });
    const bare = vi.fn(async () => ({ complete: true }));
    await killProcessTree({ pid: 4242, kill: vi.fn() }, { treeKill: bare });
    expect(bare).toHaveBeenCalledWith(4242);
  });
});

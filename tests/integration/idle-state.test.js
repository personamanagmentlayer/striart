import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, stat, utimes } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startOutputBeat } from '../../src/idle/heartbeat.ts';
import { outputBeatPath, idleStatePath } from '../../src/idle/paths.ts';
import {
  CLOSE_CLAIM_TTL_MS,
  claimClose,
  finishClose,
  finishSweep,
  readIdleState,
  recordMark,
  resetMarks,
} from '../../src/idle/state.ts';

let root;
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'striart-idle-state-'));
  await mkdir(path.join(root, '.striart'), { recursive: true });
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true, maxRetries: 5 }).catch(() => undefined);
});

describe('battement de sortie (heartbeat)', () => {
  it('écrit au démarrage, au plus une fois par intervalle, et se retire à l’arrêt', async () => {
    let t = 1_000_000;
    const beat = await startOutputBeat(root, 'agent-a', { intervalMs: 10_000, now: () => t });
    const file = outputBeatPath(root, 'agent-a');
    expect((await stat(file)).size).toBe(0); // aucune donnée d'agent n'y transite

    // Marque le fichier dans le passé : on détecte si une écriture le « rafraîchit ».
    const past = new Date(Date.now() - 3_600_000);
    await utimes(file, past, past);
    t += 1_000;
    beat.note(); // < intervalle : pas d'écriture
    await new Promise((r) => setTimeout(r, 50));
    expect((await stat(file)).mtimeMs).toBeLessThan(Date.now() - 3_000_000);

    t += 10_000;
    beat.note(); // >= intervalle : écriture
    await new Promise((r) => setTimeout(r, 100));
    expect((await stat(file)).mtimeMs).toBeGreaterThan(Date.now() - 5_000);

    await beat.stop();
    await expect(stat(file)).rejects.toMatchObject({ code: 'ENOENT' });
    beat.note(); // après stop : sans effet, sans throw
  });

  it('un dossier non inscriptible ne fait jamais échouer la session (best effort)', async () => {
    // Un FICHIER à la place du dossier `idle/` : mkdir échoue.
    await rm(path.join(root, '.striart'), { recursive: true, force: true });
    await mkdir(path.join(root, '.striart'), { recursive: true });
    const { writeFile } = await import('node:fs/promises');
    await writeFile(path.join(root, '.striart', 'idle'), 'bloque');
    const beat = await startOutputBeat(root, 'agent-a');
    expect(() => beat.note()).not.toThrow();
    await expect(beat.stop()).resolves.toBeUndefined();
  });
});

describe('état persistant', () => {
  it('recordMark : une seule fois par période d’inactivité, atomique entre appels concurrents', async () => {
    const t = Date.UTC(2026, 9, 27, 12, 0, 0);
    const results = await Promise.all(
      [1, 2, 3, 4, 5].map(() =>
        recordMark(root, 'agent-a', 'warnedAt', { at: t, lastActivityAt: t - 1000 }),
      ),
    );
    expect(results.filter(Boolean)).toHaveLength(1);
    // Même période : refusé. Activité postérieure à l'avertissement : nouvelle période.
    expect(
      await recordMark(root, 'agent-a', 'warnedAt', { at: t + 5000, lastActivityAt: t - 500 }),
    ).toBe(false);
    expect(
      await recordMark(root, 'agent-a', 'warnedAt', { at: t + 9000, lastActivityAt: t + 100 }),
    ).toBe(true);
    expect((await readIdleState(root)).agents['agent-a'].warnedAt).toBe(
      new Date(t + 9000).toISOString(),
    );
  });

  it('claimClose : exclusif tant que la revendication est récente, reprenable au-delà du TTL', async () => {
    const t = Date.UTC(2026, 9, 27, 12, 0, 0);
    expect(await claimClose(root, 'agent-a', t)).toBe(true);
    expect(await claimClose(root, 'agent-a', t + 1000)).toBe(false);
    expect(await claimClose(root, 'agent-a', t + CLOSE_CLAIM_TTL_MS + 1)).toBe(true);
    await finishClose(root, 'agent-a', { result: 'CLOSED', host: 'process', at: t + 10 });
    const record = (await readIdleState(root)).agents['agent-a'];
    expect(record).toMatchObject({ lastClose: 'CLOSED', closedHost: 'process' });
    expect(record.closingAt).toBeUndefined();
    expect(await claimClose(root, 'agent-a', t + 20)).toBe(true);
  });

  it('un nouvel avertissement lève une revendication de fermeture périmée', async () => {
    const t = Date.UTC(2026, 9, 27, 12, 0, 0);
    await claimClose(root, 'agent-a', t);
    await recordMark(root, 'agent-a', 'warnedAt', { at: t + 1, lastActivityAt: t });
    expect((await readIdleState(root)).agents['agent-a'].closingAt).toBeUndefined();
  });

  it('finishSweep oublie les agents retirés du registre ; resetMarks efface avertissements et détections', async () => {
    const t = Date.UTC(2026, 9, 27, 12, 0, 0);
    await recordMark(root, 'gone', 'warnedAt', { at: t, lastActivityAt: 0 });
    await recordMark(root, 'kept', 'warnedAt', { at: t, lastActivityAt: 0 });
    await recordMark(root, 'kept', 'detectedAt', { at: t, lastActivityAt: 0 });
    await finishSweep(root, { at: t, knownAgents: ['kept'] });
    const state = await readIdleState(root);
    expect(Object.keys(state.agents)).toEqual(['kept']);
    expect(state.lastSweepAt).toBe(new Date(t).toISOString());
    await resetMarks(root);
    expect((await readIdleState(root)).agents.kept).toEqual({});
  });

  it('état absent : lecture neutre ; état corrompu : IDLE_STATE_CORRUPT (jamais ignoré en silence)', async () => {
    expect(await readIdleState(root)).toEqual({ version: 1, lastSweepAt: null, agents: {} });
    await mkdir(path.dirname(idleStatePath(root)), { recursive: true });
    const { writeFile } = await import('node:fs/promises');
    await writeFile(idleStatePath(root), '{ pas du json');
    await expect(readIdleState(root)).rejects.toMatchObject({ code: 'IDLE_STATE_CORRUPT' });
  });
});

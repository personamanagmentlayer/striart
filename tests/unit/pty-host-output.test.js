import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  ptyHostOutputFilePath,
  ptyHostStateDir,
  readPtyHostLastOutput,
} from '../../src/pty-host-state.ts';

/**
 * Lecture de `host.output` (dernière sortie du pty publiée par l'hôte natif) : bornée, liée au
 * PID de l'hôte, et FAIL CLOSED — tout doute est « sortie inobservable » (null), jamais une
 * date fabriquée.
 */
describe('readPtyHostLastOutput', () => {
  let root;
  const PID = 4242;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'striart-ptyout-'));
    await mkdir(ptyHostStateDir(root, 'agent-t'), { recursive: true });
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const write = (content) => writeFile(ptyHostOutputFilePath(root, 'agent-t'), content);
  const doc = (over = {}) =>
    JSON.stringify({ pid: PID, lastOutputAt: '2026-10-27T10:00:00.123Z', ...over });

  it('document valide, PID de l’hôte : l’instant en millisecondes', async () => {
    await write(`${doc()}\n`);
    expect(await readPtyHostLastOutput(root, 'agent-t', PID)).toBe(
      Date.parse('2026-10-27T10:00:00.123Z'),
    );
  });

  it.each([
    ['fichier absent', null],
    ['fichier vide', ''],
    ['JSON invalide', '{not json'],
    ['tableau', '[1,2]'],
    ['PID d’un autre hôte (reliquat)', doc({ pid: PID + 1 })],
    ['PID sous forme de chaîne', doc({ pid: String(PID) })],
    ['horodatage absent', JSON.stringify({ pid: PID })],
    ['horodatage non ISO', doc({ lastOutputAt: 'yesterday' })],
    ['horodatage sans millisecondes', doc({ lastOutputAt: '2026-10-27T10:00:00Z' })],
    ['horodatage impossible', doc({ lastOutputAt: '2026-13-45T99:99:99.000Z' })],
    ['horodatage numérique', doc({ lastOutputAt: 1795000000000 })],
    ['fichier démesuré', doc({ pad: 'x'.repeat(4096) })],
  ])('fail closed : %s → null', async (_label, content) => {
    if (content !== null) await write(content);
    expect(await readPtyHostLastOutput(root, 'agent-t', PID)).toBeNull();
  });

  it('agent sans dossier d’hôte : null, sans exception', async () => {
    expect(await readPtyHostLastOutput(root, 'agent-inconnu', PID)).toBeNull();
  });
});

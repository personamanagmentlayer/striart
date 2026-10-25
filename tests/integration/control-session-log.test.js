import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createTempRepo } from '../helpers/temp-repo.js';
import { initStriart } from '../../src/init.js';
import { createAgent } from '../../src/clone.js';
import { sessionLogPath } from '../../src/session.js';
import { SESSION_LOG_TAIL, HANDLERS } from '../../src/control/methods.ts';

describe('session.log — queue bornée en OCTETS, lue sans charger tout le fichier', () => {
  let repo;
  beforeEach(async () => {
    repo = await createTempRepo();
    await initStriart(repo.root);
  });
  afterEach(async () => {
    await repo.cleanup();
  });

  it('rend au plus SESSION_LOG_TAIL octets, UTF-8 valide (aucune coupe au milieu d’un caractère)', async () => {
    const info = await createAgent({
      root: repo.root,
      name: 'robot',
      mode: 'autonomous',
      profile: 'claude',
    });
    const logPath = sessionLogPath(repo.root, 'robot', info.taskId);
    await mkdir(path.dirname(logPath), { recursive: true });
    // Caractères de 3 octets : la coupe à N octets tombe au milieu d'un caractère.
    await writeFile(logPath, `début\n${'é€'.repeat(60_000)}\nFIN`, 'utf8');
    const result = await HANDLERS['session.log']({ root: repo.root }, { agent: 'robot' });
    const { log } = result.data;
    expect(Buffer.byteLength(log, 'utf8')).toBeLessThanOrEqual(SESSION_LOG_TAIL);
    expect(log.endsWith('\nFIN')).toBe(true);
    expect(log).not.toContain('�');
    expect(log).not.toContain('début');
  });

  it('un petit log est rendu en entier', async () => {
    const info = await createAgent({
      root: repo.root,
      name: 'petit',
      mode: 'autonomous',
      profile: 'claude',
    });
    const logPath = sessionLogPath(repo.root, 'petit', info.taskId);
    await mkdir(path.dirname(logPath), { recursive: true });
    await writeFile(logPath, 'trace courte', 'utf8');
    const result = await HANDLERS['session.log']({ root: repo.root }, { agent: 'petit' });
    expect(result.data.log).toBe('trace courte');
  });
});

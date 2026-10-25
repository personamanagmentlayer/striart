import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createTempRepo } from '../helpers/temp-repo.js';
import { initStriart } from '../../src/init.js';
import {
  createConflictTicket,
  readResolutionInputs,
  readTicketDetail,
  safeFileName,
} from '../../src/conflicts.js';

/** S-M6 : deux chemins distincts ne partagent jamais leurs fichiers de résolution. */
describe('ticket — nommage injectif des fichiers (S-M6)', () => {
  let repo;
  beforeEach(async () => {
    repo = await createTempRepo();
    await initStriart(repo.root);
  });
  afterEach(async () => {
    await repo.cleanup();
  });

  const resolution = (p, theirs) => ({ path: p, base: 'b', ours: 'o', theirs });

  it('a/b.txt et a__b.txt sont distincts (v1 : même préfixe a__b.txt)', () => {
    expect(safeFileName('a/b.txt')).not.toBe(safeFileName('a__b.txt'));
    expect(safeFileName('a/b.txt', 1)).toBe(safeFileName('a__b.txt', 1)); // le défaut corrigé
    expect(safeFileName('src/app.js')).toBe('src%2Fapp.js');
    expect(safeFileName('é.txt')).toBe('%C3%A9.txt');
  });

  it('un nom très long reste utilisable sur disque et distinct', () => {
    const a = safeFileName(`${'d/'.repeat(200)}x.txt`);
    const b = safeFileName(`${'d/'.repeat(200)}y.txt`);
    expect(a.length).toBeLessThan(220);
    expect(a).not.toBe(b);
  });

  it('un ticket garde les trois versions de chaque fichier homonyme à part', async () => {
    const ticket = await createConflictTicket(repo.root, {
      agent: 'agent-a',
      branch: 'b',
      sha: 'abc',
      reason: 'MERGE_CONFLICT',
      conflictedFiles: ['a/b.txt', 'a__b.txt'],
      resolutions: [
        resolution('a/b.txt', 'THEIRS-SLASH'),
        resolution('a__b.txt', 'THEIRS-UNDERSCORE'),
      ],
    });
    expect(ticket.fileNaming).toBe(2);
    const detail = await readTicketDetail(repo.root, ticket.id);
    expect(detail.resolutions.map((r) => r.theirs)).toEqual(['THEIRS-SLASH', 'THEIRS-UNDERSCORE']);

    await writeFile(path.join(ticket.dir, `${safeFileName('a/b.txt')}.resolved`), 'R-SLASH');
    const inputs = await readResolutionInputs(repo.root, ticket.id);
    expect(inputs.find((i) => i.path === 'a/b.txt')).toMatchObject({ kind: 'content' });
    expect(inputs.find((i) => i.path === 'a__b.txt')).toMatchObject({ kind: 'missing' });
  });

  it('un ticket antérieur (sans fileNaming) reste lisible avec l’ancien nommage', async () => {
    const ticket = await createConflictTicket(repo.root, {
      agent: 'agent-a',
      branch: 'b',
      sha: 'def',
      reason: 'MERGE_CONFLICT',
      conflictedFiles: ['src/x.js'],
      resolutions: [resolution('src/x.js', 'T')],
    });
    // Simule un ticket d'une version antérieure : pas de fileNaming, fichiers en `__`.
    const file = path.join(ticket.dir, 'ticket.json');
    const json = JSON.parse(await readFile(file, 'utf8'));
    delete json.fileNaming;
    await writeFile(file, JSON.stringify(json));
    for (const ext of ['base', 'ours', 'theirs'])
      await rename(
        path.join(ticket.dir, `${safeFileName('src/x.js')}.${ext}`),
        path.join(ticket.dir, `src__x.js.${ext}`),
      );
    const detail = await readTicketDetail(repo.root, ticket.id);
    expect(detail.resolutions[0].theirs).toBe('T');
  });
});

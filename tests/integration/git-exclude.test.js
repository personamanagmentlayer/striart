import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  cloneExcludePath,
  ensureCloneExclude,
  ensureCloneExcludes,
  removeCloneExcludes,
} from '../../src/git-exclude.ts';
import * as memory from '../../src/memory.ts';

// Intégration : vrai fichier .git/info/exclude sur disque.
let clone;
const exclude = () => readFile(cloneExcludePath(clone), 'utf8');

beforeEach(async () => {
  clone = await mkdtemp(path.join(os.tmpdir(), 'striart-exclude-'));
  await mkdir(path.join(clone, '.git'), { recursive: true });
});

afterEach(async () => {
  await rm(clone, { recursive: true, force: true });
});

describe('git-exclude — module partagé de .git/info/exclude', () => {
  it('memory.js délègue au module partagé (une seule implémentation)', () => {
    expect(memory.ensureCloneExclude).toBe(ensureCloneExclude);
  });

  it('comportement historique conservé : dossier info créé, entrée ajoutée, idempotent', async () => {
    await ensureCloneExclude(clone, '.striart-memory.md');
    await ensureCloneExclude(clone, '.striart-memory.md');
    expect(await exclude()).toBe('\n.striart-memory.md\n');
  });

  it('contenu existant préservé (CRLF compris), entrée déjà présente non dupliquée', async () => {
    await mkdir(path.dirname(cloneExcludePath(clone)), { recursive: true });
    await writeFile(cloneExcludePath(clone), '# git ls-files --others\r\n*.log\r\n');
    await ensureCloneExclude(clone, '*.log');
    expect(await exclude()).toBe('# git ls-files --others\r\n*.log\r\n');
    await ensureCloneExclude(clone, '/x');
    expect(await exclude()).toBe('# git ls-files --others\r\n*.log\n/x\n');
  });

  it('plusieurs entrées en une écriture, doublons ignorés', async () => {
    await ensureCloneExcludes(clone, ['/a', '/b', '/a']);
    expect(await exclude()).toBe('\n/a\n/b\n');
  });

  it('retrait : seules les entrées demandées partent, le reste est intact', async () => {
    await ensureCloneExcludes(clone, ['*.log', '/a', '/b']);
    await removeCloneExcludes(clone, ['/a', '/absent']);
    expect((await exclude()).split('\n').filter(Boolean)).toEqual(['*.log', '/b']);
    await removeCloneExcludes(clone, ['*.log', '/b']);
    expect(await exclude()).toBe('');
  });

  it('retrait sur fichier absent : rien créé', async () => {
    await removeCloneExcludes(clone, ['/a']);
    await expect(exclude()).rejects.toThrow();
  });

  it('fichier exclude illisible (dossier à sa place) → erreur, jamais écrasé', async () => {
    await mkdir(cloneExcludePath(clone), { recursive: true });
    await expect(ensureCloneExclude(clone, '/a')).rejects.toThrow();
  });
});

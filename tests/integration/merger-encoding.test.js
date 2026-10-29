import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { classifyConflict, extractConflictVersions } from '../../src/merger.ts';
import { createTempRepo } from '../helpers/temp-repo.js';

const cleanups = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()();
});

async function conflict(files) {
  const { root, git, cleanup } = await createTempRepo();
  cleanups.push(cleanup);
  const put = (content) => writeFile(path.join(root, 'f.txt'), content);
  await put(files.base);
  await git.add('f.txt');
  await git.commit('base');
  await git.checkoutLocalBranch('side');
  await put(files.theirs);
  await git.add('f.txt');
  await git.commit('theirs');
  await git.checkout('main');
  await put(files.ours);
  await git.add('f.txt');
  await git.commit('ours');
  await git.merge(['side']).catch(() => undefined);
  return git;
}

describe('extractConflictVersions : encodage', () => {
  it('UTF-8 valide (accents, BOM) : texte restitué à l’identique', async () => {
    const git = await conflict({
      base: '\uFEFFcafé\n',
      ours: '\uFEFFcafé ours\n',
      theirs: '\uFEFFcafé theirs\n',
    });
    const v = await extractConflictVersions(git, 'f.txt');
    expect(v).toEqual({
      base: '\uFEFFcafé\n',
      ours: '\uFEFFcafé ours\n',
      theirs: '\uFEFFcafé theirs\n',
    });
    expect(classifyConflict({ filePath: 'f.txt', ...v }).kind).toBe('text');
  });

  it('latin1 (octet 0xE9 isolé) : conflit humain « encoding », jamais fusionné', async () => {
    const latin = (s) => Buffer.from(s, 'latin1');
    const git = await conflict({
      base: latin('caf\u00e9\n'),
      ours: latin('caf\u00e9 ours\n'),
      theirs: latin('caf\u00e9 theirs\n'),
    });
    const v = await extractConflictVersions(git, 'f.txt');
    expect(classifyConflict({ filePath: 'f.txt', ...v })).toEqual({ kind: 'encoding' });
  });
});

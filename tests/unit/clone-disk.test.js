import { describe, expect, it } from 'vitest';
import { cloneDiskSize, cloneWorkActivityMs, cloneWorkScan } from '../../src/clone-disk.ts';

// Parcours disque d'un clone, avec un système de fichiers FACTICE (hermétique).
// Deux fonctions, deux statuts :
//  - cloneWorkActivityMs : SIGNAL DE SÉCURITÉ (sessionActive, gardes de
//    cleanClones/reuseAgent) — exact, jamais mis en cache, FAIL CLOSED ;
//  - cloneDiskSize : AFFICHAGE — somme des octets additionnels.

const file = (mtimeMs, size = 10, nlink = 1) => ({ mtimeMs, size, nlink });
const link = (mtimeMs = 1) => ({ mtimeMs, size: 0, nlink: 1, symlink: true });
const dir = (mtimeMs, children = {}) => ({ mtimeMs, children });

/** FS factice : arbre imbriqué, `failures` = chemin → code d'erreur. */
function fakeFs(tree, failures = {}) {
  const calls = { readdir: [], lstat: [] };
  const split = (p) => p.split(/[\\/]+/).filter(Boolean);
  const find = (p) => {
    let node = { children: { c: tree } }; // le clone est monté sur « /c »
    for (const part of split(p)) {
      node = node.children?.[part];
      if (!node) return null;
    }
    return node;
  };
  const fail = (p, op) => {
    const code = failures[split(p).join('/')];
    if (code) throw Object.assign(new Error(`${op} ${code}`), { code });
  };
  return {
    calls,
    async readdir(p) {
      calls.readdir.push(split(p).join('/'));
      fail(p, 'readdir');
      const node = find(p);
      if (!node?.children) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return Object.entries(node.children).map(([name, child]) => ({
        name,
        isDirectory: () => Boolean(child.children),
        isFile: () => !child.children && !child.symlink,
        isSymbolicLink: () => Boolean(child.symlink),
      }));
    },
    async lstat(p) {
      calls.lstat.push(split(p).join('/'));
      fail(p, 'lstat');
      const node = find(p);
      if (!node) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return { mtimeMs: node.mtimeMs, size: node.size ?? 0, nlink: node.nlink ?? 1 };
    },
  };
}

const NOW = 5_000_000;

describe('cloneWorkActivityMs (signal de sécurité)', () => {
  const tree = () =>
    dir(1, {
      '.git': dir(900, { index: file(990), objects: dir(950, { aa: dir(960, { x: file(970) }) }) }),
      '.striart-memory.md': file(800),
      src: dir(100, { 'a.js': file(300), deep: dir(110, { 'b.js': file(400) }) }),
      'top.txt': file(200),
    });

  it('mtime le plus récent du worktree, .git et le fichier de mémoire exclus', async () => {
    const ms = await cloneWorkActivityMs('/c', {
      fs: fakeFs(tree()),
      skipTop: ['.git', '.striart-memory.md'],
      now: () => NOW,
    });
    expect(ms).toBe(400);
  });

  it('ne descend jamais dans .git', async () => {
    const fs = fakeFs(tree());
    await cloneWorkActivityMs('/c', { fs, skipTop: ['.git'], now: () => NOW });
    expect(fs.calls.readdir.some((p) => p.includes('.git'))).toBe(false);
    expect(fs.calls.lstat.some((p) => p.includes('.git'))).toBe(false);
  });

  it('un .git imbriqué (sous-dossier) compte : seule l’entrée de premier niveau est exclue', async () => {
    const t = dir(1, {
      '.git': dir(999),
      vendor: dir(2, { '.git': dir(777, { HEAD: file(777) }) }),
    });
    const ms = await cloneWorkActivityMs('/c', {
      fs: fakeFs(t),
      skipTop: ['.git'],
      now: () => NOW,
    });
    expect(ms).toBe(777);
  });

  it('ne suit pas les liens symboliques et ne les compte pas', async () => {
    const t = dir(1, { out: link(9_999_999), real: file(50) });
    const fs = fakeFs(t);
    const ms = await cloneWorkActivityMs('/c', { fs, skipTop: [], now: () => NOW });
    expect(ms).toBe(50);
    expect(fs.calls.lstat.some((p) => p.endsWith('out'))).toBe(false);
  });

  it('dossier absent : 0 (rien à protéger)', async () => {
    const ms = await cloneWorkActivityMs('/absent', {
      fs: fakeFs(dir(1)),
      skipTop: [],
      now: () => NOW,
    });
    expect(ms).toBe(0);
  });

  it('FAIL CLOSED : un sous-dossier illisible (EACCES) rend « maintenant »', async () => {
    const t = dir(1, { src: dir(10, { secret: dir(5, { f: file(5) }) }) });
    const ms = await cloneWorkActivityMs('/c', {
      fs: fakeFs(t, { 'c/src/secret': 'EACCES' }),
      skipTop: [],
      now: () => NOW,
    });
    expect(ms).toBe(NOW);
  });

  it('FAIL CLOSED : un lstat en échec (EBUSY) rend « maintenant »', async () => {
    const t = dir(1, { a: file(5), b: file(6) });
    const ms = await cloneWorkActivityMs('/c', {
      fs: fakeFs(t, { 'c/b': 'EBUSY' }),
      skipTop: [],
      now: () => NOW,
    });
    expect(ms).toBe(NOW);
  });

  it('FAIL CLOSED : racine illisible (autre que ENOENT) rend « maintenant »', async () => {
    const ms = await cloneWorkActivityMs('/c', {
      fs: fakeFs(dir(1), { c: 'EPERM' }),
      skipTop: [],
      now: () => NOW,
    });
    expect(ms).toBe(NOW);
  });

  it('un fichier disparu en cours de parcours (ENOENT) est ignoré, pas traité comme un doute', async () => {
    const t = dir(1, { a: file(5), gone: file(6) });
    const ms = await cloneWorkActivityMs('/c', {
      fs: fakeFs(t, { 'c/gone': 'ENOENT' }),
      skipTop: [],
      now: () => NOW,
    });
    expect(ms).toBe(5);
  });
});

describe('cloneWorkScan (un parcours, deux usages)', () => {
  it('rend l’activité exacte ET les octets du worktree (.git exclu, hardlinks à 0)', async () => {
    const t = dir(1, {
      '.git': dir(900, { big: file(990, 99_999) }),
      a: file(300, 100),
      linked: file(350, 500, 2),
      sub: dir(10, { b: file(400, 50) }),
    });
    const scan = await cloneWorkScan('/c', { fs: fakeFs(t), skipTop: ['.git'], now: () => NOW });
    expect(scan).toEqual({ workActivityMs: 400, bytes: 150, complete: true });
  });

  it('FAIL CLOSED : partie illisible → activité « maintenant », complete:false', async () => {
    const t = dir(1, { a: file(5, 7), bad: dir(1, { f: file(1, 1) }) });
    const scan = await cloneWorkScan('/c', {
      fs: fakeFs(t, { 'c/bad': 'EACCES' }),
      skipTop: [],
      now: () => NOW,
    });
    expect(scan).toEqual({ workActivityMs: NOW, bytes: 7, complete: false });
  });
});

describe('cloneDiskSize (affichage)', () => {
  it('somme les fichiers à nlink 1, .git compris ; les hardlinks comptent 0', async () => {
    const t = dir(1, {
      '.git': dir(1, { objects: dir(1, { p: file(1, 1000, 2) }), HEAD: file(1, 20) }),
      'a.js': file(1, 100),
      sub: dir(1, { 'b.js': file(1, 50) }),
    });
    const r = await cloneDiskSize('/c', { fs: fakeFs(t) });
    expect(r).toEqual({ sizeBytes: 170, complete: true });
  });

  it('ne suit pas les liens symboliques', async () => {
    const t = dir(1, { out: link(), a: file(1, 5) });
    const fs = fakeFs(t);
    const r = await cloneDiskSize('/c', { fs });
    expect(r.sizeBytes).toBe(5);
    expect(fs.calls.lstat.some((p) => p.endsWith('out'))).toBe(false);
  });

  it('dossier illisible : taille partielle MAIS complete:false (jamais présentée comme exacte)', async () => {
    const t = dir(1, { a: file(1, 5), bad: dir(1, { f: file(1, 99) }) });
    const r = await cloneDiskSize('/c', { fs: fakeFs(t, { 'c/bad': 'EACCES' }) });
    expect(r).toEqual({ sizeBytes: 5, complete: false });
  });
});

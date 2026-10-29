// Confidentialité des données locales (.striart/) : modes RÉELS sous POSIX,
// ACL RÉELLES (icacls, SDDL) sous Windows. Migration idempotente de l'existant,
// héritage sur les fichiers créés ensuite, arbres de travail (agents/) intacts.
import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  hardenStriartDir,
  inspectStriartPrivacy,
  isPrivate,
  resetHardenMemo,
  writePrivateFile,
  restrictToCurrentUser,
} from '../../src/private-fs.ts';

const run = promisify(execFile);
const WIN = process.platform === 'win32';
const icacls = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'icacls.exe');

let root;

beforeEach(async () => {
  root = await mkdtemp(path.join(await realpath(os.tmpdir()), 'striart-priv-'));
  resetHardenMemo();
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true }).catch(() => {});
});

/** Un `.striart/` « à l'ancienne » : permissif, avec données et un clone. */
async function legacyStriart() {
  const base = path.join(root, '.striart');
  await mkdir(path.join(base, 'logs'), { recursive: true });
  await mkdir(path.join(base, 'conflicts', 'agent-a-1234'), { recursive: true });
  await mkdir(path.join(base, 'agents', 'agent-a', 'src'), { recursive: true });
  await writeFile(path.join(base, 'agents.json'), '{}\n');
  await writeFile(path.join(base, 'logs', 'session-x.log'), 'sortie');
  await writeFile(path.join(base, 'conflicts', 'agent-a-1234', 'a.ours'), 'code source');
  await writeFile(path.join(base, 'agents', 'agent-a', 'src', 'app.js'), 'clone');
  if (!WIN) {
    // Le umask de la machine de test peut déjà être strict : on force l'ancien état.
    for (const dir of [base, path.join(base, 'logs'), path.join(base, 'conflicts')]) {
      await chmod(dir, 0o755);
    }
    await chmod(path.join(base, 'agents.json'), 0o644);
    await chmod(path.join(base, 'logs', 'session-x.log'), 0o644);
    await chmod(path.join(base, 'conflicts', 'agent-a-1234'), 0o755);
    await chmod(path.join(base, 'conflicts', 'agent-a-1234', 'a.ours'), 0o644);
  }
  return base;
}

async function sddlOf(target) {
  const dump = path.join(root, `dump-${Math.random().toString(16).slice(2)}.acl`);
  await run(icacls, [target, '/save', dump]);
  const raw = await readFile(dump);
  await rm(dump, { force: true });
  return (raw[0] === 0xff ? raw.subarray(2) : raw).toString('utf16le').match(/D:[^\r\n]*/)?.[0];
}

/**
 * Grants d'une SDDL, en ignorant le bruit de forme que Windows peut ajouter
 * sans changer QUI a accès : le marqueur « hérité » (ID) d'une ACE, et les
 * drapeaux de contrôle de la DACL (P protégée, AI auto-héritée, AR). Isoler
 * un arbre de travail de la propagation (`icacls .../inheritance:d`) le
 * touche directement — il peut donc gagner ces marqueurs — sans jamais lui
 * accorder ou retirer un droit : c'est cela que « garde son ACL » vérifie.
 */
function sddlGrantsOf(sddl) {
  const match = /^D:[A-Z]*((?:\([^)]*\))*)$/.exec(sddl?.trim() ?? '');
  if (!match) return sddl;
  return [...match[1].matchAll(/\(([^)]*)\)/g)]
    .map((m) => {
      const parts = m[1].split(';');
      parts[1] = parts[1].replace(/ID/g, '');
      return parts.join(';');
    })
    .join('|');
}

describe('hardenStriartDir — migration de l’existant', () => {
  it('un .striart/ ouvert est constaté ouvert, puis resserré, puis constaté privé', async () => {
    const base = await legacyStriart();
    const before = await inspectStriartPrivacy(root);
    expect(before.failed.length).toBeGreaterThan(0);
    expect(before.tightened).toEqual([]);

    const report = await hardenStriartDir(root);
    expect(report.failed).toEqual([]);
    expect(report.tightened.length).toBeGreaterThan(0);

    const after = await inspectStriartPrivacy(root);
    expect(after.failed).toEqual([]);
    for (const target of [
      base,
      path.join(base, 'agents.json'),
      path.join(base, 'logs'),
      path.join(base, 'logs', 'session-x.log'),
      path.join(base, 'conflicts', 'agent-a-1234', 'a.ours'),
    ]) {
      expect(await isPrivate(target), target).toBe(true);
    }
  });

  it('est idempotent : un second passage ne resserre plus rien', async () => {
    await legacyStriart();
    await hardenStriartDir(root);
    resetHardenMemo();
    const second = await hardenStriartDir(root);
    expect(second.tightened).toEqual([]);
    expect(second.failed).toEqual([]);
  });

  it('privateStateDir: false (enabled: false) ne touche à rien', async () => {
    await legacyStriart();
    const report = await hardenStriartDir(root, { enabled: false });
    expect(report.tightened).toEqual([]);
    expect((await inspectStriartPrivacy(root)).failed.length).toBeGreaterThan(0);
  });

  it('un fichier créé APRÈS le durcissement est privé (héritage ACL / mode)', async () => {
    const base = await legacyStriart();
    await hardenStriartDir(root);
    const fresh = path.join(base, 'logs', 'later.log');
    await writePrivateFile(fresh, 'x');
    expect(await isPrivate(fresh)).toBe(true);
    // Un fichier créé « normalement » par un autre module hérite aussi (Windows) ;
    // sous POSIX le dossier 0700 en interdit l'accès aux autres comptes.
    const plain = path.join(base, 'logs', 'plain.log');
    await writeFile(plain, 'y');
    if (WIN) expect(await isPrivate(plain)).toBe(true);
    else expect((await stat(base)).mode & 0o077).toBe(0);
  });

  it('ne parcourt JAMAIS les clones (agents/) : le contenu garde son ACL / son mode', async () => {
    const base = await legacyStriart();
    const clonedFile = path.join(base, 'agents', 'agent-a', 'src', 'app.js');
    const before = WIN ? await sddlOf(clonedFile) : (await stat(clonedFile)).mode;
    await hardenStriartDir(root);
    const after = WIN ? await sddlOf(clonedFile) : (await stat(clonedFile)).mode;
    // Windows : seuls les GRANTS comptent (qui a accès) — isoler l'arbre de
    // travail touche le fichier directement et peut lui ajouter des drapeaux
    // de forme (protégée, auto-héritée) sans changer qui y a accès.
    expect(WIN ? sddlGrantsOf(after) : after).toBe(WIN ? sddlGrantsOf(before) : before);
    // Le contenu du clone reste lisible pour l'utilisateur (l'agent y travaille).
    expect(await readFile(clonedFile, 'utf8')).toBe('clone');
  });

  it('crée .striart/ absent, privé', async () => {
    await hardenStriartDir(root);
    expect(await isPrivate(path.join(root, '.striart'))).toBe(true);
  });
});

describe('restrictToCurrentUser / writePrivateFile', () => {
  it('crée un dossier privé et y écrit des fichiers privés', async () => {
    const dir = path.join(root, 'data', 'nested');
    await mkdir(dir, { recursive: true });
    await restrictToCurrentUser(dir);
    expect(await isPrivate(dir)).toBe(true);
    const file = path.join(dir, 'f.txt');
    await writePrivateFile(file, 'secret');
    expect(await isPrivate(file)).toBe(true);
    await writePrivateFile(file, 'more', { append: true });
    expect(await readFile(file, 'utf8')).toBe('secretmore');
  });
});

describe.skipIf(WIN)('modes POSIX réels', () => {
  it('dossiers 0700 et fichiers 0600 après durcissement', async () => {
    const base = await legacyStriart();
    await hardenStriartDir(root);
    expect((await stat(base)).mode & 0o777).toBe(0o700);
    expect((await stat(path.join(base, 'logs'))).mode & 0o777).toBe(0o700);
    // Le dossier des clones est fermé aux autres comptes ; son contenu n'est pas touché.
    expect((await stat(path.join(base, 'agents'))).mode & 0o777).toBe(0o700);
    expect((await stat(path.join(base, 'agents.json'))).mode & 0o777).toBe(0o600);
    expect((await stat(path.join(base, 'logs', 'session-x.log'))).mode & 0o777).toBe(0o600);
    expect((await stat(path.join(base, 'conflicts', 'agent-a-1234', 'a.ours'))).mode & 0o777).toBe(
      0o600,
    );
  });

  it('un fichier écrit par writePrivateFile sur un fichier existant ouvert est resserré en 0600', async () => {
    const file = path.join(root, 'old.log');
    await writeFile(file, 'old');
    await chmod(file, 0o644);
    await writePrivateFile(file, 'new');
    expect((await stat(file)).mode & 0o777).toBe(0o600);
  });
});

describe.skipIf(!WIN)('ACL Windows réelles', () => {
  it('la DACL du dossier est protégée et ne vise que l’utilisateur courant (héritable)', async () => {
    const base = await legacyStriart();
    await hardenStriartDir(root);
    const sddl = await sddlOf(base);
    expect(sddl).toMatch(/^D:P/); // protégée : l'héritage du dépôt est coupé
    const aces = [...sddl.matchAll(/\(([^)]*)\)/g)].map((m) => m[1].split(';'));
    expect(aces.length).toBe(1);
    expect(aces[0][1]).toContain('OI');
    expect(aces[0][1]).toContain('CI');
    // Un enfant existant (migré) n'accorde rien à un autre compte.
    const child = await sddlOf(path.join(base, 'logs', 'session-x.log'));
    expect([...child.matchAll(/\(([^)]*)\)/g)].length).toBe(1);
  });
});

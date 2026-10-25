import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  defaultShell,
  resolvePtyShell,
  resolveShellProgram,
  windowsPowerShellProfileRisk,
  windowsPowerShellProfiles,
} from '../../src/pty-host.ts';
import { quietShell } from '../helpers/pty-test-utils.js';

const WIN = process.platform === 'win32';
// Un « exécutable » factice : sous Windows l'extension .exe suffit (pas de
// bit x), sous POSIX le bit x compte.
const EXE = WIN ? 'fakesh.exe' : 'fakesh';

async function makeExecutable(dir, name = EXE) {
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, name);
  await writeFile(file, WIN ? 'MZ' : '#!/bin/sh\nexit 0\n');
  if (!WIN) await chmod(file, 0o755);
  return file;
}

describe('résolution du shell de l’hôte de pty', () => {
  let root;
  let pathDir;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'striart-pty-shell-'));
    pathDir = path.join(root, 'abs-bin');
  });
  afterEach(() => rm(root, { recursive: true, force: true }).catch(() => {}));

  const envWith = (...dirs) => ({
    PATH: dirs.join(path.delimiter),
    Path: dirs.join(path.delimiter),
  });
  const writeConfig = (pty) =>
    writeFile(path.join(root, '.striartrc.json'), JSON.stringify({ pty }));

  describe('resolveShellProgram', () => {
    it('un nom nu est résolu dans un dossier ABSOLU du PATH', async () => {
      const file = await makeExecutable(pathDir);
      const resolved = await resolveShellProgram(path.parse(EXE).name, envWith(pathDir));
      expect(resolved.toLowerCase()).toBe(file.toLowerCase());
    });

    it('un nom nu n’est JAMAIS cherché dans le dossier courant ni dans une entrée relative du PATH', async () => {
      const previous = process.cwd();
      await makeExecutable(path.join(root, 'rel-bin'));
      await makeExecutable(root);
      process.chdir(root);
      try {
        await expect(
          resolveShellProgram(EXE, { PATH: ['', '.', 'rel-bin'].join(path.delimiter) }),
        ).rejects.toMatchObject({ code: 'PTY_SHELL_INVALID', details: { reason: 'NOT_FOUND' } });
      } finally {
        process.chdir(previous);
      }
    });

    it('un chemin relatif (avec séparateur) est refusé', async () => {
      await makeExecutable(path.join(root, 'rel'));
      for (const spec of ['./rel/' + EXE, 'rel/' + EXE, '../x/' + EXE]) {
        await expect(resolveShellProgram(spec, envWith(pathDir))).rejects.toMatchObject({
          code: 'PTY_SHELL_INVALID',
          details: { reason: 'RELATIVE_PATH' },
        });
      }
    });

    it('un chemin absolu exécutable est accepté tel quel', async () => {
      const file = await makeExecutable(pathDir);
      await expect(resolveShellProgram(file, envWith())).resolves.toBe(file);
    });

    it('un chemin absolu inexistant ou désignant un dossier est refusé', async () => {
      await expect(
        resolveShellProgram(path.join(root, 'absent', EXE), envWith()),
      ).rejects.toMatchObject({ code: 'PTY_SHELL_INVALID', details: { reason: 'NOT_FOUND' } });
      await mkdir(path.join(root, 'dir.exe'));
      await expect(
        resolveShellProgram(path.join(root, 'dir.exe'), envWith()),
      ).rejects.toMatchObject({
        code: 'PTY_SHELL_INVALID',
        details: { reason: 'NOT_EXECUTABLE' },
      });
    });

    it.runIf(!WIN)('un fichier sans bit x est refusé (POSIX)', async () => {
      const file = path.join(root, 'plain');
      await writeFile(file, 'x');
      await chmod(file, 0o644);
      await expect(resolveShellProgram(file, envWith())).rejects.toMatchObject({
        code: 'PTY_SHELL_INVALID',
        details: { reason: 'NOT_EXECUTABLE' },
      });
    });

    it.runIf(WIN)('un chemin absolu sans extension exécutable est refusé (Windows)', async () => {
      const file = path.join(root, 'notes.txt');
      await writeFile(file, 'x');
      await expect(resolveShellProgram(file, envWith())).rejects.toMatchObject({
        code: 'PTY_SHELL_INVALID',
        details: { reason: 'NOT_EXECUTABLE' },
      });
    });

    it('le message est actionnable et ne fuit aucune valeur dans details', async () => {
      const error = await resolveShellProgram('shell-introuvable-xyz', envWith(pathDir)).catch(
        (e) => e,
      );
      expect(error.message).toMatch(/pty\.shell/);
      expect(JSON.stringify(error.details)).not.toContain('shell-introuvable-xyz');
    });
  });

  describe('resolvePtyShell', () => {
    it('sans config : auto, comportement inchangé (defaultShell, aucun argument)', async () => {
      await expect(resolvePtyShell(root)).resolves.toMatchObject({
        shell: defaultShell(),
        args: [],
        source: 'auto',
      });
    });

    it('`auto` explicite = sans config ; shellArgs s’applique aussi au shell auto', async () => {
      await writeConfig({ shell: 'auto', shellArgs: ['-x'] });
      await expect(resolvePtyShell(root)).resolves.toMatchObject({
        shell: defaultShell(),
        args: ['-x'],
        source: 'auto',
      });
    });

    it('pty.shell + shellArgs : shell résolu en chemin absolu, source config', async () => {
      const file = await makeExecutable(pathDir);
      await writeConfig({ shell: path.parse(EXE).name, shellArgs: ['-a', 'b c'] });
      const resolved = await resolvePtyShell(root, { env: envWith(pathDir) });
      expect(resolved.shell.toLowerCase()).toBe(file.toLowerCase());
      expect(resolved.args).toEqual(['-a', 'b c']);
      expect(resolved.source).toBe('config');
    });

    it('config partielle : les autres clés pty gardent leurs défauts', async () => {
      await writeConfig({ replayBytes: 2048 });
      await expect(resolvePtyShell(root)).resolves.toMatchObject({ source: 'auto', args: [] });
    });

    it('pty.shell introuvable : PTY_SHELL_INVALID (jamais de repli silencieux sur auto)', async () => {
      await writeConfig({ shell: 'shell-introuvable-xyz' });
      await expect(resolvePtyShell(root, { env: envWith(pathDir) })).rejects.toMatchObject({
        code: 'PTY_SHELL_INVALID',
      });
    });
  });

  describe('windowsPowerShellProfileRisk', () => {
    it('vrai pour powershell(.exe) sans -NoProfile, faux sinon', () => {
      expect(windowsPowerShellProfileRisk('powershell.exe', [], 'win32')).toBe(true);
      expect(
        windowsPowerShellProfileRisk(
          'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\POWERSHELL.EXE',
          ['-NoLogo'],
          'win32',
        ),
      ).toBe(true);
      expect(
        windowsPowerShellProfileRisk('powershell.exe', ['-NoLogo', '-noprofile'], 'win32'),
      ).toBe(false);
      expect(windowsPowerShellProfileRisk('pwsh', [], 'win32')).toBe(false);
      expect(windowsPowerShellProfileRisk('powershell.exe', [], 'linux')).toBe(false);
      expect(windowsPowerShellProfileRisk('cmd.exe', [], 'win32')).toBe(false);
    });
  });

  describe('windowsPowerShellProfiles', () => {
    // Fonction propre à Windows (chemins path.win32) : sans objet sous POSIX.
    it.skipIf(process.platform !== 'win32')(
      'ne liste que les profils qui existent (Documents, OneDrive)',
      async () => {
        const home = path.join(root, 'home');
        await mkdir(path.join(home, 'Documents', 'WindowsPowerShell'), { recursive: true });
        expect(await windowsPowerShellProfiles({}, home)).toEqual([]);
        await writeFile(path.join(home, 'Documents', 'WindowsPowerShell', 'profile.ps1'), '');
        const oneDrive = path.join(root, 'od');
        await mkdir(path.join(oneDrive, 'Documents', 'WindowsPowerShell'), { recursive: true });
        await writeFile(
          path.join(oneDrive, 'Documents', 'WindowsPowerShell', 'Microsoft.PowerShell_profile.ps1'),
          '',
        );
        const found = await windowsPowerShellProfiles({ OneDrive: oneDrive }, home);
        expect(found).toHaveLength(2);
      },
    );
  });

  describe('quietShell (helper des tests pty)', () => {
    it('shell sans profil pour PowerShell, rien pour les autres', () => {
      expect(quietShell('powershell.exe').args).toEqual(['-NoProfile', '-NoLogo']);
      expect(quietShell('C:\\x\\pwsh.exe').args).toEqual(['-NoProfile', '-NoLogo']);
      expect(quietShell('pwsh').args).toEqual(['-NoProfile', '-NoLogo']);
      expect(quietShell('cmd.exe').args).toEqual([]);
      expect(quietShell('/bin/bash').args).toEqual([]);
      expect(quietShell('sh').args).toEqual([]);
    });
    it('par défaut : le shell du produit', () => {
      expect(quietShell().shell).toBe(defaultShell());
    });
  });
});

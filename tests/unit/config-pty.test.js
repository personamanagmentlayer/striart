import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, validateConfig } from '../../src/config.ts';
import { StriartError } from '../../src/errors.ts';

// Clés `pty.shell` / `pty.shellArgs` : le shell que l'hôte de pty fait tourner.
// Validation pure (aucun disque) : la résolution réelle est couverte par
// tests/integration/pty-shell.test.js.
const ABSOLUTE =
  process.platform === 'win32' ? String.raw`C:\Tools\pwsh.exe` : '/usr/local/bin/pwsh';

describe('config pty.shell / pty.shellArgs', () => {
  it('défauts sûrs : shell "auto", aucun argument', () => {
    expect(DEFAULT_CONFIG.pty.shell).toBe('auto');
    expect(DEFAULT_CONFIG.pty.shellArgs).toEqual([]);
  });

  it.each([
    [{ shell: 'auto' }],
    [{ shell: 'pwsh' }],
    [{ shell: ABSOLUTE }],
    [{ shell: 'bash', shellArgs: ['--norc', '--noprofile'] }],
    [{ shellArgs: [] }],
    [{ replayBytes: 2048, shell: 'zsh', shellArgs: ['-f'] }],
  ])('accepte %j', (pty) => {
    expect(() => validateConfig({ pty })).not.toThrow();
  });

  it.each([
    ['shell non chaîne', { shell: 42 }],
    ['shell vide', { shell: '' }],
    ['shell avec saut de ligne', { shell: 'pwsh\nrm' }],
    ['shell avec NUL', { shell: 'pwsh\0' }],
    ['shell relatif avec séparateur', { shell: './bin/sh' }],
    ['shell relatif imbriqué', { shell: 'tools/pwsh' }],
    ['shell relatif remontant', { shell: '../pwsh' }],
    ['shell trop long', { shell: 'a'.repeat(4097) }],
    ['shellArgs non tableau', { shellArgs: '-NoProfile' }],
    ['shellArgs avec non-chaîne', { shellArgs: ['-NoProfile', 1] }],
    ['shellArgs avec saut de ligne', { shellArgs: ['-c\nid'] }],
    ['shellArgs avec NUL', { shellArgs: ['a\0b'] }],
    ['shellArgs trop nombreux', { shellArgs: Array.from({ length: 65 }, () => '-x') }],
    ['shellArgs élément trop long', { shellArgs: ['a'.repeat(4097)] }],
    ['clé inconnue (faute de frappe)', { shel: 'pwsh' }],
    ['clé héritée du prototype', { toString: 1 }],
  ])('refuse : %s', (_label, pty) => {
    expect(() => validateConfig({ pty })).toThrow(StriartError);
  });

  it('les clés numériques existantes restent validées', () => {
    expect(() => validateConfig({ pty: { replayBytes: 10 } })).toThrow(StriartError);
    expect(() => validateConfig({ pty: { replayBytes: '2048' } })).toThrow(StriartError);
  });
});

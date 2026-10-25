import { describe, expect, it } from 'vitest';
import { detectCapabilities } from '../../src/cli/caps.ts';

const tty = { isTTY: true, columns: 120 };
const pipe = { isTTY: false };

function caps(overrides = {}) {
  return detectCapabilities({
    env: {},
    platform: 'linux',
    stdout: tty,
    stderr: tty,
    stdin: tty,
    plain: false,
    color: null,
    ...overrides,
  });
}

describe('detectCapabilities — couleur', () => {
  it('suit isTTY par défaut, flux par flux', () => {
    const c = caps({ stdout: pipe, env: { LANG: 'fr_FR.UTF-8' } });
    expect(c.colorStdout).toBe(false);
    expect(c.colorStderr).toBe(true);
  });

  it('NO_COLOR (toute valeur non vide) l’emporte sur FORCE_COLOR et le terminal', () => {
    expect(caps({ env: { NO_COLOR: '1', FORCE_COLOR: '1' } }).colorStdout).toBe(false);
    expect(caps({ env: { NO_COLOR: '' } }).colorStdout).toBe(true);
  });

  it('FORCE_COLOR force la couleur hors terminal, FORCE_COLOR=0 la coupe', () => {
    expect(caps({ stdout: pipe, env: { FORCE_COLOR: '1' } }).colorStdout).toBe(true);
    expect(caps({ env: { FORCE_COLOR: '0' } }).colorStdout).toBe(false);
  });

  it('--no-color, --plain et TERM=dumb coupent la couleur', () => {
    expect(caps({ color: false }).colorStdout).toBe(false);
    expect(caps({ plain: true }).colorStdout).toBe(false);
    expect(caps({ env: { TERM: 'dumb' } }).colorStdout).toBe(false);
  });
});

describe('detectCapabilities — glyphes Unicode', () => {
  it('Windows : seulement dans un terminal moderne connu', () => {
    expect(caps({ platform: 'win32' }).unicode).toBe(false);
    expect(caps({ platform: 'win32', env: { WT_SESSION: 'x' } }).unicode).toBe(true);
    expect(caps({ platform: 'win32', env: { TERM_PROGRAM: 'vscode' } }).unicode).toBe(true);
  });

  it('Unix : locale UTF-8 (ou non précisée) oui, console texte non', () => {
    expect(caps({ env: { LANG: 'fr_FR.UTF-8' } }).unicode).toBe(true);
    expect(caps({ env: {} }).unicode).toBe(true);
    expect(caps({ env: { LANG: 'C' } }).unicode).toBe(false);
    expect(caps({ env: { TERM: 'linux', LANG: 'en_US.UTF-8' } }).unicode).toBe(false);
  });

  it('STRIART_ASCII=1 et --plain forcent l’ASCII', () => {
    expect(caps({ env: { STRIART_ASCII: '1' } }).unicode).toBe(false);
    expect(caps({ plain: true }).unicode).toBe(false);
  });
});

describe('detectCapabilities — largeur, liens, animation', () => {
  it('largeur : celle du terminal, sinon COLUMNS, sinon aucune limite', () => {
    expect(caps().columns).toBe(120);
    expect(caps({ stdout: pipe, env: { COLUMNS: '80' } }).columns).toBe(80);
    expect(caps({ stdout: pipe }).columns).toBeNull();
  });

  it('liens OSC 8 : terminal connu, jamais en CI ni hors terminal', () => {
    expect(caps({ env: { WT_SESSION: 'x' } }).hyperlinks).toBe(true);
    expect(caps({ env: {} }).hyperlinks).toBe(false);
    expect(caps({ env: { WT_SESSION: 'x', CI: 'true' } }).hyperlinks).toBe(false);
    expect(caps({ stdout: pipe, env: { WT_SESSION: 'x' } }).hyperlinks).toBe(false);
    expect(caps({ env: { FORCE_HYPERLINK: '1' } }).hyperlinks).toBe(true);
  });

  it('animation : stderr terminal, hors CI et hors --plain', () => {
    expect(caps().animate).toBe(true);
    expect(caps({ stderr: pipe }).animate).toBe(false);
    expect(caps({ env: { CI: '1' } }).animate).toBe(false);
    expect(caps({ env: { GITHUB_ACTIONS: 'true' } }).animate).toBe(false);
    expect(caps({ plain: true }).animate).toBe(false);
  });

  it('thème : STRIART_THEME (default, colorblind, mono)', () => {
    expect(caps().theme).toBe('default');
    expect(caps({ env: { STRIART_THEME: 'colorblind' } }).theme).toBe('colorblind');
    expect(caps({ env: { STRIART_THEME: 'mono' } }).theme).toBe('mono');
  });
});

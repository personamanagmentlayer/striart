import { describe, expect, it } from 'vitest';
import { editInput, moveSelection, navAction, PAGE_SIZE } from '../../src/watch-ui-keys.ts';

describe('navAction : raccourcis de navigation', () => {
  const act = (char, key = {}) => navAction(char, key);

  it('les touches imprimables sont des raccourcis', () => {
    expect(act('q')).toEqual({ type: 'quit' });
    expect(act('?')).toEqual({ type: 'help' });
    expect(act('m')).toEqual({ type: 'merge' });
    expect(act('s')).toEqual({ type: 'sync' });
    expect(act('j')).toEqual({ type: 'select', delta: 1 });
    expect(act('k')).toEqual({ type: 'select', delta: -1 });
    expect(act('/')).toEqual({ type: 'focus', prefix: '/' });
    expect(act('@')).toEqual({ type: 'focus', prefix: '@' });
    expect(act('!')).toEqual({ type: 'focus', prefix: '!' });
  });

  it('flèches, Entrée, Tab, Échap, pages', () => {
    expect(act('', { upArrow: true })).toEqual({ type: 'select', delta: -1 });
    expect(act('', { downArrow: true })).toEqual({ type: 'select', delta: 1 });
    expect(act('', { return: true })).toEqual({ type: 'zoom' });
    expect(act('', { tab: true })).toEqual({ type: 'pane' });
    expect(act('', { escape: true })).toEqual({ type: 'back' });
    expect(act('', { pageUp: true })).toEqual({ type: 'scroll', delta: PAGE_SIZE });
    expect(act('', { pageDown: true })).toEqual({ type: 'scroll', delta: -PAGE_SIZE });
  });

  it('Ctrl+C quitte ; aucune autre combinaison Ctrl ne déclenche de raccourci', () => {
    expect(act('c', { ctrl: true })).toEqual({ type: 'quit' });
    expect(act('m', { ctrl: true })).toBeNull();
    expect(act('q', { ctrl: true })).toBeNull();
  });

  it('une touche inconnue ne fait rien (aucun effet de bord par défaut)', () => {
    expect(act('x')).toBeNull();
    expect(act('M')).toBeNull();
    expect(act('m', { meta: true })).toBeNull();
  });
});

describe('editInput : le champ a le focus, tout caractère imprimable est du texte', () => {
  const type = (text, key = {}) => editInput({ text: '', cursor: 0 }, text, key);

  it('q, m, s, ?, j, k ne déclenchent rien : ils s’insèrent', () => {
    let buffer = { text: '', cursor: 0 };
    for (const ch of ['q', 'm', 's', '?', 'j', 'k', '/']) {
      const result = editInput(buffer, ch, {});
      expect(result.submit).toBeNull();
      buffer = result.buffer;
    }
    expect(buffer).toEqual({ text: 'qms?jk/', cursor: 7 });
  });

  it('Entrée soumet la ligne et vide le champ', () => {
    const result = editInput({ text: '/status', cursor: 7 }, '', { return: true });
    expect(result.submit).toBe('/status');
    expect(result.buffer).toEqual({ text: '', cursor: 0 });
  });

  it('un chunk avec fin de ligne (frappe rapide, collage) soumet ce qui précède', () => {
    expect(type('/status\r').submit).toBe('/status');
    expect(type('hello\nignored').submit).toBe('hello');
  });

  it('le curseur se déplace et l’insertion se fait à sa position', () => {
    let r = editInput({ text: 'ac', cursor: 2 }, '', { leftArrow: true });
    expect(r.buffer.cursor).toBe(1);
    r = editInput(r.buffer, 'b', {});
    expect(r.buffer).toEqual({ text: 'abc', cursor: 2 });
    r = editInput(r.buffer, '', { home: true });
    expect(r.buffer.cursor).toBe(0);
    r = editInput(r.buffer, '', { end: true });
    expect(r.buffer.cursor).toBe(3);
    r = editInput({ text: 'abc', cursor: 3 }, '', { rightArrow: true });
    expect(r.buffer.cursor).toBe(3);
  });

  it('retour arrière et suppression : aux bords, aucun effet', () => {
    expect(editInput({ text: 'ab', cursor: 0 }, '', { backspace: true }).buffer).toEqual({
      text: 'ab',
      cursor: 0,
    });
    expect(editInput({ text: 'ab', cursor: 2 }, '', { backspace: true }).buffer).toEqual({
      text: 'a',
      cursor: 1,
    });
    expect(editInput({ text: 'ab', cursor: 2 }, '', { delete: true }).buffer).toEqual({
      text: 'ab',
      cursor: 2,
    });
    expect(editInput({ text: 'ab', cursor: 0 }, '', { delete: true }).buffer).toEqual({
      text: 'b',
      cursor: 0,
    });
  });

  it('Ctrl+U, Ctrl+W, Ctrl+A, Ctrl+E', () => {
    expect(editInput({ text: 'abc def', cursor: 7 }, 'w', { ctrl: true }).buffer).toEqual({
      text: 'abc ',
      cursor: 4,
    });
    expect(editInput({ text: 'abc def', cursor: 3 }, 'u', { ctrl: true }).buffer).toEqual({
      text: ' def',
      cursor: 0,
    });
    expect(editInput({ text: 'abc', cursor: 1 }, 'a', { ctrl: true }).buffer.cursor).toBe(0);
    expect(editInput({ text: 'abc', cursor: 1 }, 'e', { ctrl: true }).buffer.cursor).toBe(3);
  });

  it('les caractères hors BMP comptent pour un (curseur en points de code)', () => {
    const r = editInput({ text: '', cursor: 0 }, '𝄞x', {});
    expect(r.buffer).toEqual({ text: '𝄞x', cursor: 2 });
    expect(editInput(r.buffer, '', { backspace: true }).buffer.text).toBe('𝄞');
  });

  it('les séquences de contrôle non reconnues ne s’insèrent jamais', () => {
    expect(editInput({ text: '', cursor: 0 }, '\u001b[99~', {}).buffer.text).toBe('');
    expect(editInput({ text: '', cursor: 0 }, '\u0007', {}).buffer.text).toBe('');
    expect(editInput({ text: 'x', cursor: 1 }, '', { escape: true }).buffer.text).toBe('x');
  });
});

describe('moveSelection : butées, jamais de boucle', () => {
  const names = ['a', 'b', 'c'];
  it('avance et recule jusqu’aux bords puis s’arrête', () => {
    expect(moveSelection(names, 'a', 1)).toBe('b');
    expect(moveSelection(names, 'c', 1)).toBe('c');
    expect(moveSelection(names, 'a', -1)).toBe('a');
  });
  it('sélection absente ou liste vide', () => {
    expect(moveSelection(names, null, 1)).toBe('a');
    expect(moveSelection(names, 'zzz', -1)).toBe('c');
    expect(moveSelection([], 'a', 1)).toBeNull();
  });
});

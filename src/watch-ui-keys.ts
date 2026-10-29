/**
 * Clavier du cockpit `watch --ui` : fonctions PURES (aucun Ink, aucun état
 * React) qui traduisent une frappe en intention. Deux modes disjoints :
 *
 *  - navigation : les touches imprimables (q, j, k, m, s, /, @, !, ?) sont des
 *    raccourcis ;
 *  - saisie : le champ a le focus, TOUT caractère imprimable est du texte —
 *    aucun raccourci ne se déclenche (q ne quitte pas pendant qu'on écrit).
 *
 * Échap revient toujours en arrière, dans le même ordre partout.
 */

/** Sous-ensemble des touches Ink dont dépend le cockpit. */
export interface KeyLike {
  upArrow?: boolean;
  downArrow?: boolean;
  leftArrow?: boolean;
  rightArrow?: boolean;
  pageUp?: boolean;
  pageDown?: boolean;
  home?: boolean;
  end?: boolean;
  return?: boolean;
  escape?: boolean;
  tab?: boolean;
  backspace?: boolean;
  delete?: boolean;
  ctrl?: boolean;
  meta?: boolean;
  shift?: boolean;
}

export type NavAction =
  | { type: 'select'; delta: number }
  | { type: 'select-edge'; edge: 'first' | 'last' }
  | { type: 'zoom' }
  | { type: 'merge' }
  | { type: 'sync' }
  | { type: 'focus'; prefix: string }
  | { type: 'pane' }
  | { type: 'scroll'; delta: number }
  | { type: 'help' }
  | { type: 'quit' }
  | { type: 'back' };

/** Lignes remontées par PgUp/PgDn. */
export const PAGE_SIZE = 10;

/** Intention d'une frappe en mode navigation ; `null` = rien à faire (jamais d'effet de bord par défaut). */
export function navAction(char: string, key: KeyLike): NavAction | null {
  if (key.ctrl) return char === 'c' ? { type: 'quit' } : null;
  if (key.escape) return { type: 'back' };
  if (key.upArrow) return { type: 'select', delta: -1 };
  if (key.downArrow) return { type: 'select', delta: 1 };
  if (key.home) return { type: 'select-edge', edge: 'first' };
  if (key.end) return { type: 'select-edge', edge: 'last' };
  if (key.pageUp) return { type: 'scroll', delta: PAGE_SIZE };
  if (key.pageDown) return { type: 'scroll', delta: -PAGE_SIZE };
  if (key.return) return { type: 'zoom' };
  if (key.tab) return { type: 'pane' };
  if (key.meta) return null;
  switch (char) {
    case 'j':
      return { type: 'select', delta: 1 };
    case 'k':
      return { type: 'select', delta: -1 };
    case 'g':
      return { type: 'select-edge', edge: 'first' };
    case 'G':
      return { type: 'select-edge', edge: 'last' };
    case 'm':
      return { type: 'merge' };
    case 's':
      return { type: 'sync' };
    case '?':
      return { type: 'help' };
    case 'q':
      return { type: 'quit' };
    case '/':
    case '@':
    case '!':
      return { type: 'focus', prefix: char };
    default:
      return null;
  }
}

export interface InputBuffer {
  text: string;
  /** Position du curseur, en CARACTÈRES (points de code), jamais en unités UTF-16. */
  cursor: number;
}

export interface EditResult {
  buffer: InputBuffer;
  /** Une ligne complète à soumettre (Entrée ou fin de ligne dans un collage). */
  submit: string | null;
}

/**
 * Applique une frappe au champ de saisie. `char` peut être un CHUNK de
 * plusieurs caractères (frappe rapide, collage) : une fin de ligne dedans
 * soumet ce qui précède. Les touches d'édition (curseur, suppression) sont
 * traitées ; tout le reste imprimable est inséré.
 */
export function editInput(buffer: InputBuffer, char: string, key: KeyLike): EditResult {
  const chars = [...buffer.text];
  const at = Math.min(buffer.cursor, chars.length);
  const set = (next: string[], cursor: number): EditResult => ({
    buffer: { text: next.join(''), cursor },
    submit: null,
  });

  if (key.ctrl) {
    if (char === 'u') return set(chars.slice(at), 0);
    if (char === 'a') return set(chars, 0);
    if (char === 'e') return set(chars, chars.length);
    if (char === 'w') {
      let start = at;
      while (start > 0 && chars[start - 1] === ' ') start -= 1;
      while (start > 0 && chars[start - 1] !== ' ') start -= 1;
      return set([...chars.slice(0, start), ...chars.slice(at)], start);
    }
    return { buffer, submit: null };
  }
  if (key.return) return { buffer: { text: '', cursor: 0 }, submit: buffer.text };
  if (key.leftArrow) return set(chars, Math.max(0, at - 1));
  if (key.rightArrow) return set(chars, Math.min(chars.length, at + 1));
  if (key.home) return set(chars, 0);
  if (key.end) return set(chars, chars.length);
  if (key.backspace) {
    return at === 0
      ? { buffer, submit: null }
      : set([...chars.slice(0, at - 1), ...chars.slice(at)], at - 1);
  }
  if (key.delete) {
    return at >= chars.length
      ? { buffer, submit: null }
      : set([...chars.slice(0, at), ...chars.slice(at + 1)], at);
  }
  if (!char || key.meta || key.tab || key.escape) return { buffer, submit: null };

  const newline = char.search(/[\r\n]/);
  if (newline !== -1) {
    const before = [...chars.slice(0, at), ...char.slice(0, newline)].join('');
    return { buffer: { text: '', cursor: 0 }, submit: before + chars.slice(at).join('') };
  }
  // Une séquence d'échappement non reconnue ne s'insère jamais, ni ses restes imprimables.
  if (char.includes('')) return { buffer, submit: null };
  const printable = [...char].filter((c) => c >= ' ' && c !== '\u007f');
  if (printable.length === 0) return { buffer, submit: null };
  return set([...chars.slice(0, at), ...printable, ...chars.slice(at)], at + printable.length);
}

/** Déplace la sélection dans une liste, sans boucler : les bords sont des butées (repère spatial stable). */
export function moveSelection(
  names: string[],
  current: string | null,
  delta: number,
): string | null {
  if (names.length === 0) return null;
  const idx = current === null ? -1 : names.indexOf(current);
  if (idx === -1) return names[delta < 0 ? names.length - 1 : 0];
  return names[Math.min(names.length - 1, Math.max(0, idx + delta))];
}

/**
 * Primitives de texte pures (aucune E/S) : largeur d'affichage, troncature,
 * neutralisation des caractères de contrôle. Partagées par le rendu de la
 * CLI et testées isolément.
 */

/**
 * Neutralise les caractères de contrôle C0/C1 (hors tabulation) d'un texte
 * NON FIABLE avant affichage : message de commit d'un agent, sortie git,
 * chemin, raison libre d'une réservation. Sans ça, un message de commit
 * contenant `ESC ]` ou `ESC [` pilote le terminal de l'humain (changer le
 * titre, effacer l'écran, forger un lien cliquable, réécrire une ligne
 * « ok »). Chaque caractère est remplacé par sa forme visible `\xNN`.
 */
export function sanitize(text: string): string {
  return text.replace(UNSAFE_CHARS, (ch) => {
    if (ch === '\n') return '↵';
    const code = ch.charCodeAt(0);
    return code > 0xff
      ? `\\u${code.toString(16).padStart(4, '0')}`
      : `\\x${code.toString(16).padStart(2, '0')}`;
  });
}

/**
 * C0/C1 (hors tabulation) et contrôles bidirectionnels : embeddings et
 * overrides U+202A-202E, isolats U+2066-2069, marques U+200E/U+200F/U+061C.
 * Un nom de fichier forgé avec un override réordonne visuellement la fin de
 * la ligne (U+202E devant « txt.exe » affiche « exe.txt ») et usurpe une
 * colonne de tableau. Les jointures d'émojis (U+200D) et le texte RTL
 * ordinaire, eux, sont légitimes et laissés tels quels.
 */
const UNSAFE_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x00, 0x08], // C0 avant la tabulation
  [0x0a, 0x1f], // C0 après la tabulation (LF compris : rendu en « ↵ »)
  [0x7f, 0x9f], // DEL et C1
  [0x061c, 0x061c], // marque de lettre arabe
  [0x200e, 0x200f], // marques gauche-droite / droite-gauche
  [0x202a, 0x202e], // embeddings et overrides bidirectionnels
  [0x2066, 0x2069], // isolats bidirectionnels
];
// Construite depuis des nombres : un littéral de regex serait « normalisé » en
// caractères bruts invisibles par le formateur, ce qui rendrait la source
// illisible — et ouverte à la même attaque que celle qu'elle neutralise.
const UNSAFE_CHARS = new RegExp(
  `[${UNSAFE_RANGES.map(([from, to]) => `\\u{${from.toString(16)}}-\\u{${to.toString(16)}}`).join('')}]`,
  'gu',
);

const SEGMENTER = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/** Largeur d'un graphème dans une grille de terminal (1 ou 2 colonnes). */
function graphemeWidth(grapheme: string): number {
  const cp = grapheme.codePointAt(0) ?? 0;
  if (cp === 0) return 0;
  // Marques combinantes seules, jointures, sélecteurs de variante.
  if (/^[\p{Mn}\p{Me}​-‏︀-️]+$/u.test(grapheme)) return 0;
  if (/\p{Extended_Pictographic}/u.test(grapheme) && grapheme.length > 1) return 2;
  if (
    (cp >= 0x1100 && cp <= 0x115f) || // Hangul Jamo
    (cp >= 0x2e80 && cp <= 0xa4cf && cp !== 0x303f) || // CJK, Kangxi, Yi…
    (cp >= 0xac00 && cp <= 0xd7a3) || // Hangul
    (cp >= 0xf900 && cp <= 0xfaff) || // CJK compat
    (cp >= 0xfe30 && cp <= 0xfe4f) ||
    (cp >= 0xff00 && cp <= 0xff60) || // pleine chasse
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1faff) || // émojis
    (cp >= 0x20000 && cp <= 0x3fffd)
  ) {
    return 2;
  }
  return 1;
}

const ANSI_RE = /\u001B\[[0-9;]*m|\u001B\]8;[^\u0007\u001B]*(?:\u0007|\u001B\\)/g;

/** Largeur affichée d'une chaîne, séquences de style et de lien ignorées. */
export function displayWidth(text: string): number {
  let width = 0;
  for (const { segment } of SEGMENTER.segment(text.replace(ANSI_RE, ''))) {
    width += graphemeWidth(segment);
  }
  return width;
}

/** Tronque à `max` colonnes avec une ellipse (texte NON stylé). */
export function truncate(text: string, max: number, ellipsis: string): string {
  if (displayWidth(text) <= max) return text;
  const room = Math.max(0, max - displayWidth(ellipsis));
  let out = '';
  let width = 0;
  for (const { segment } of SEGMENTER.segment(text)) {
    const w = graphemeWidth(segment);
    if (width + w > room) break;
    out += segment;
    width += w;
  }
  return out + ellipsis;
}

/** Complète à droite jusqu'à `width` colonnes. */
export function padEnd(text: string, width: number): string {
  return text + ' '.repeat(Math.max(0, width - displayWidth(text)));
}

/**
 * Équivalents ASCII des glyphes typographiques de NOS textes statiques (aide,
 * catalogue) pour `STRIART_ASCII=1` / `--plain` / `TERM=dumb` : flèches,
 * points de suspension, tirets, guillemets, coches. Les lettres accentuées
 * restent (ce sont des lettres, pas des glyphes). Jamais appliqué à des
 * DONNÉES (noms de fichiers, messages de commit) : elles seraient altérées.
 */
export function asciiGlyphs(text: string): string {
  return text
    .replace(/[→⟶]/g, '->')
    .replace(/←/g, '<-')
    .replace(/…/g, '...')
    .replace(/[–—]/g, '-')
    .replace(/[‘’‚‛]/g, "'")
    .replace(/[“”«»]/g, '"')
    .replace(/[  ]/g, ' ')
    .replace(/[✓✔]/g, 'ok')
    .replace(/[✗✘]/g, 'x');
}

/**
 * Coupe un texte SANS séquences de style en lignes d'au plus `width` colonnes,
 * aux espaces (algorithme glouton). Un mot plus long que la largeur n'est
 * jamais coupé : mieux vaut un chemin entier qui déborde qu'un chemin
 * illisible. `width` ≤ 0 : une seule ligne.
 */
export function wrapWords(text: string, width: number): string[] {
  if (width <= 0 || displayWidth(text) <= width) return [text];
  const lines: string[] = [];
  let current = '';
  for (const word of text.split(' ')) {
    if (current === '') {
      current = word;
    } else if (displayWidth(current) + 1 + displayWidth(word) <= width) {
      current += ` ${word}`;
    } else {
      lines.push(current);
      current = word;
    }
  }
  lines.push(current);
  return lines;
}

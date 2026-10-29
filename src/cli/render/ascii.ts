/**
 * Texte STATIQUE localisé (catalogue i18n) → ASCII pur, pour `STRIART_ASCII=1`,
 * `--plain` et `TERM=dumb` (lecteur d'écran, plage braille, console ancienne).
 * Ne s'applique jamais à une donnée (nom de fichier, message de commit) : elle
 * serait altérée. S'appuie sur `asciiGlyphs` (flèches, ellipses, tirets,
 * guillemets) et complète ce que le cockpit utilise en plus.
 */
import { asciiGlyphs } from '../text.ts';

export function asciiStatic(text: string): string {
  return asciiGlyphs(
    // Guillemets français : l'espace insécable intérieure disparaît avec eux (« a » → "a").
    text.replace(/«[\u00a0\u202f ]/gu, '«').replace(/[\u00a0\u202f ]»/gu, '»'),
  )
    .replace(/·/g, '-')
    .replace(/×/g, 'x')
    .replace(/↔/g, '<->')
    .replace(/↑/g, '^')
    .replace(/↓/g, 'v');
}

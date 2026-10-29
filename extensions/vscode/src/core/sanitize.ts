/**
 * Neutralisation du texte non fiable (agents, LLM, git) avant affichage.
 *
 * Tout ce que l'extension montre et qui vient d'un agent ou d'un dépôt est du
 * texte brut : contrôles retirés, surcharges bidirectionnelles retirées
 * (« Trojan Source »), taille bornée. Aucun HTML ni Markdown n'est interprété
 * côté appelant.
 */

// C0 (sauf \t \n), DEL, C1, séparateurs de ligne/paragraphe Unicode, marques
// et surcharges bidirectionnelles, caractères de largeur nulle.
const UNSAFE = new RegExp(
  ['[\u0000-\u0008\u000B-\u001F\u007F-\u009F', '\u2028\u2029\u200B-\u200F\u202A-\u202E\u2066-\u2069\u061C\uFEFF]'].join(
    '',
  ),
  'g',
);

/** Texte sur une seule ligne, borné à `max` caractères (ellipse comprise). */
export function sanitizeLine(value: unknown, max = 200): string {
  const text = typeof value === 'string' ? value : '';
  const flat = text
    .replace(UNSAFE, ' ')
    .replace(/[\t\n]+/g, ' ')
    .replace(/ {2,}/g, ' ')
    .trim();
  return truncate(flat, max);
}

/** Texte multi-ligne (tooltip, journal), borné à `max` caractères. */
export function sanitizeBlock(value: unknown, max = 2000): string {
  const text = typeof value === 'string' ? value : '';
  return truncate(text.replace(/\r\n?/g, '\n').replace(UNSAFE, ' ').trim(), max);
}

function truncate(text: string, max: number): string {
  const chars = Array.from(text);
  return chars.length <= max ? text : `${chars.slice(0, Math.max(0, max - 1)).join('')}…`;
}

/** Vrai si la chaîne contient un caractère de contrôle ou bidi interdit. */
export function hasUnsafeChars(value: string): boolean {
  UNSAFE.lastIndex = 0;
  const found = UNSAFE.test(value);
  UNSAFE.lastIndex = 0;
  return found || /[\r\n\t]/.test(value);
}

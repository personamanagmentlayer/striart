/**
 * Traduction d'un ton sémantique (`ok`, `warn`, `error`…) en propriétés de
 * style pour Ink. La couleur ne se décide NULLE PART ailleurs que dans les
 * thèmes d'`output.ts` (défaut, daltonien, monochrome) : ce module ne fait que
 * relire le même format `styleText` et l'exprimer en props `<Text>`. Le
 * cockpit `watch --ui` et les tableaux de la CLI partagent ainsi une seule
 * palette, et `NO_COLOR` / `--plain` (caps.colorStdout) la coupent d'un coup.
 */
import { toneFormat } from '../output.ts';
import type { Tone } from '../output.ts';
import type { ThemeName } from '../caps.ts';

export interface InkStyle {
  color?: string;
  bold?: boolean;
  dimColor?: boolean;
  underline?: boolean;
}

const NAMED_COLORS = new Set([
  'red',
  'green',
  'yellow',
  'blue',
  'magenta',
  'cyan',
  'white',
  'gray',
]);

/** Style Ink d'un ton ; `{}` quand la couleur est coupée (aucun attribut décoratif non plus). */
export function inkStyleForTone(tone: Tone, theme: ThemeName, color: boolean): InkStyle {
  if (!color) return {};
  const format = toneFormat(theme, tone);
  const names = Array.isArray(format) ? format : [format];
  const style: InkStyle = {};
  for (const raw of names) {
    const name = String(raw);
    if (NAMED_COLORS.has(name)) style.color = name;
    else if (name === 'bold') style.bold = true;
    else if (name === 'dim') style.dimColor = true;
    else if (name === 'underline') style.underline = true;
  }
  return style;
}

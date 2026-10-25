/**
 * Langue de la CLI : `STRIART_LANG` (fr|en) l'emporte, puis la locale POSIX
 * (LC_ALL, LC_MESSAGES, LANG), puis celle du système (Intl). Toute langue
 * autre que le français affiche l'anglais.
 *
 * Seul le catalogue choisi est chargé.
 */
import type { Messages } from './fr.ts';

export type { Messages } from './fr.ts';
export type Locale = 'fr' | 'en';

export function detectLocale(env: Record<string, string | undefined>): Locale {
  const explicit = env.STRIART_LANG?.toLowerCase();
  if (explicit === 'fr' || explicit === 'en') return explicit;
  const posix = env.LC_ALL || env.LC_MESSAGES || env.LANG;
  const raw =
    posix && posix !== 'C' && posix !== 'POSIX'
      ? posix
      : Intl.DateTimeFormat().resolvedOptions().locale;
  return raw.toLowerCase().startsWith('fr') ? 'fr' : 'en';
}

export async function loadMessages(locale: Locale): Promise<Messages> {
  if (locale === 'en') return (await import('./en.ts')).en;
  return (await import('./fr.ts')).fr;
}

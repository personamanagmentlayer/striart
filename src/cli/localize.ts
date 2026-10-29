import type { MergeResult } from '../types.js';
import type { Messages } from './i18n/index.ts';

/**
 * Localise, pour l'AFFICHAGE seulement, le texte d'échec d'une fusion sémantique.
 *
 * Le noyau garde `error` (texte français, compat du `--json`) et pose `errorCode` + `errorDetails`
 * (contrat stable). Quand le catalogue de la langue courante sait rendre ce code, son texte
 * remplace `error` ; sinon (français = langue de référence, code inconnu) le texte du noyau est
 * conservé tel quel. Rend une COPIE : le résultat d'origine — celui du document `--json` — n'est
 * jamais modifié.
 */
export function localizeMergeResult(m: Messages, result: MergeResult): MergeResult {
  if (result.status !== 'CONFLICT' || !result.errorCode) return result;
  const text = m.errors(result.errorCode, result.errorDetails ?? {});
  return text === null ? result : { ...result, error: text };
}

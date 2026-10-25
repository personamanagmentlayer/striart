/**
 * Échec de la comptabilité de tokens (écriture du registre d'usage, relecture
 * des cumuls de budget) : jamais silencieux. Une comptabilité tronquée rend
 * les budgets aveugles — l'utilisateur doit pouvoir le savoir (journal avec
 * un code stable) et, s'il le choisit, le refuser (`tokens.onAccountingError:
 * 'fail'`).
 *
 * Compromis du réglage (documenté dans la configuration) : 'warn' (défaut)
 * ne perd jamais la réponse d'un appel déjà payé ; 'fail' refuse à la place
 * d'avancer à l'aveugle (un appel LLM dont le relevé échoue est alors rejeté,
 * une session dont les cumuls sont illisibles ne démarre pas).
 */
import { StriartError } from '../errors.js';
import { logger } from '../logger.js';
import type { TokensSettings } from './settings.ts';

export const ACCOUNTING_FAILED_CODE = 'TOKEN_ACCOUNTING_FAILED';

/** Journalise seulement (contextes asynchrones où lever n'aurait pas de preneur : flux de session). */
export function logAccountingFailure(error: unknown, what: string): void {
  logger.warn(
    { code: ACCOUNTING_FAILED_CODE, what, err: error },
    'Token accounting failed: usage is not (fully) recorded, budgets may be blind',
  );
}

/**
 * Journalise l'échec (code stable, cause incluse) puis, si le réglage est
 * 'fail', lève `TOKEN_ACCOUNTING_FAILED`. `what` ne porte qu'un identifiant
 * d'opération (jamais une valeur de config ni un chemin).
 */
export function reportAccountingFailure(
  settings: Pick<TokensSettings, 'onAccountingError'>,
  error: unknown,
  what: string,
): void {
  logAccountingFailure(error, what);
  if (settings.onAccountingError !== 'fail') return;
  throw new StriartError(
    `Token accounting failed (${what}) and tokens.onAccountingError is 'fail': the operation is refused.`,
    {
      code: 'TOKEN_ACCOUNTING_FAILED',
      details: { what },
      hint: 'striart doctor',
      cause: error,
    },
  );
}

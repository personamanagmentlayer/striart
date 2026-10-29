/**
 * Codes de sortie — contrat public de la CLI (couche L4), décidés ICI et
 * nulle part ailleurs.
 *
 *  0   intention atteinte, ou ajournement voulu par conception (tâche mise
 *      en file, rebase reporté, déjà à jour) ;
 *  1   échec d'exécution ou d'environnement (git, LLM, disque, config,
 *      cible introuvable) — peut être transitoire, relancer peut suffire ;
 *  2   usage invalide : rejeté avant toute action (option inconnue,
 *      valeur hors bornes, options incompatibles) ;
 *  3   refus métier : une garde de Striart a dit non (conflit de merge,
 *      Test Gate rouge, travail non mergé, session vivante…) — relancer
 *      telle quelle ne changera rien, il faut une décision humaine ;
 *  130 interrompu par SIGINT (Ctrl+C), 143 par SIGTERM (convention POSIX
 *      128 + n, appliquée aussi sous Windows).
 *
 * Classés par NATURE, pas par statut : un nouveau statut se range dans une
 * classe existante sans créer de nouveau code. Le détail fin est dans le
 * document `--json` (`data.status`, `error.code`).
 */
import { errorKindOf } from '../errors.ts';
import type { ErrorKind } from '../errors.ts';

export const EXIT = Object.freeze({
  OK: 0,
  FAILURE: 1,
  USAGE: 2,
  REFUSED: 3,
  SIGINT: 130,
  SIGTERM: 143,
});

/** Issue d'une commande qui a abouti à un résultat (sans exception). */
export type Outcome = 'ok' | 'refused' | 'failed';

export function exitCodeForOutcome(outcome: Outcome): number {
  if (outcome === 'refused') return EXIT.REFUSED;
  if (outcome === 'failed') return EXIT.FAILURE;
  return EXIT.OK;
}

export function exitCodeForErrorKind(kind: ErrorKind): number {
  if (kind === 'usage') return EXIT.USAGE;
  if (kind === 'refusal') return EXIT.REFUSED;
  return EXIT.FAILURE;
}

/** Le pire de plusieurs issues (refus > échec > ok) — pour `plan`, `sync` global. */
export function worstOutcome(outcomes: Outcome[]): Outcome {
  if (outcomes.includes('refused')) return 'refused';
  if (outcomes.includes('failed')) return 'failed';
  return 'ok';
}

// --- Tables statut → issue, par type de résultat du domaine ------------------

export function mergeOutcome(status: string): Outcome {
  return status === 'CONFLICT' || status === 'GATE_FAILED' ? 'refused' : 'ok';
}

/** Rebase reporté ou en conflit = ajournement par conception (rattrapé au merge). */
export function syncOutcome(status: string): Outcome {
  return status === 'STASH_CONFLICT' ? 'refused' : 'ok';
}

export function promoteOutcome(status: string): Outcome {
  return status === 'GATE_FAILED' ? 'refused' : 'ok';
}

export function manualResolutionOutcome(status: string): Outcome {
  return status === 'GATE_FAILED' ? 'refused' : 'ok';
}

/**
 * Cycle autonome : la tâche mise en file ou mergée est une réussite ; une
 * session plantée, expirée ou vide est un échec d'exécution (relançable) ;
 * un merge bloqué (conflit, gate rouge) ou une session arrêtée par un plafond
 * de tokens (`keptDetail` 'BUDGET_EXCEEDED') est un refus. `KEPT` (commitPolicy
 * 'human' : l'agent a committé, AUCUN merge automatique, clone gardé pour revue)
 * est un renvoi voulu vers l'humain — un refus (3), jamais un échec (1).
 */
export function autonomousOutcome(
  status: string,
  keptDetail: string | null = null,
  errorCode: string | null = null,
): Outcome {
  if (status === 'MERGED' || status === 'QUEUED') return 'ok';
  if (status === 'KEPT') return 'refused';
  // Cause NOMMÉE d'un échec de session dont la nature est un refus (agent ACP
  // non connecté : un humain doit s'authentifier) : relancer ne changera rien.
  if (status === 'SESSION_FAILED' && refusalCause(errorCode)) return 'refused';
  // commitPolicy 'human' : personne ne committe, le travail reste dans le clone
  // pour revue humaine — un renvoi voulu vers l'humain, pas un incident.
  if (status === 'EMPTY' && keptDetail === 'human') return 'refused';
  // Session arrêtée par un plafond de tokens (`tokens.budgets`) : la garde a
  // parlé — relancer sans décision (relever le plafond, relire le clone) ne
  // changera rien. Un refus (3), comme TOKEN_BUDGET_EXCEEDED à l'appel de LLM.
  if (status === 'SESSION_FAILED' && keptDetail === 'BUDGET_EXCEEDED') return 'refused';
  // Commit Striart refusé (clone hors de sa branche, opération git en cours) :
  // une garde, pas un incident — relancer ne changera rien sans décision humaine.
  if (status === 'MERGE_BLOCKED' || status === 'COMMIT_REFUSED') return 'refused';
  return 'failed';
}

/**
 * Session lancée sur le principal (`run --on-main`). Même barème que le cycle
 * autonome : un plafond de tokens (`BUDGET_EXCEEDED`) ou une cause nommée de
 * refus (`errorCode` de nature refus) est un refus (3) ; le reste est un échec.
 */
export function mainSessionOutcome(status: string, errorCode: string | null = null): Outcome {
  if (status === 'COMPLETED') return 'ok';
  if (status === 'BUDGET_EXCEEDED') return 'refused';
  return refusalCause(errorCode) ? 'refused' : 'failed';
}

/** Vrai si le code d'erreur nommé est classé « refus » (ERROR_KINDS). */
function refusalCause(errorCode: string | null): boolean {
  return errorCode !== null && errorKindOf(errorCode) === 'refusal';
}

/**
 * Nœud orchestré (plan v2, `striart orchestrate`, lot O) : mergé ou tâche
 * supervisée menée à son terme = réussite ; une garde qui dit non (merge
 * bloqué, relecture négative, lecture seule ou périmètre violé, aucun
 * candidat vert) = refus ; le reste (session plantée, attente expirée, tâche
 * sautée, erreur) = échec d'exécution.
 */
const ORCHESTRATION_REFUSALS = new Set([
  'KEPT',
  'MERGE_BLOCKED',
  'COMMIT_REFUSED',
  'REVIEW_REJECTED',
  'REVIEW_EXHAUSTED',
  'VERDICT_INVALID',
  'READ_ONLY_VIOLATION',
  'SCOPE_VIOLATION',
  'TEAM_COMMIT_FORBIDDEN',
  'RACE_NO_WINNER',
]);

export function orchestrationOutcome(status: string, detail: string | null = null): Outcome {
  if (status === 'MERGED' || status === 'FINISHED' || status === 'STARTED' || status === 'QUEUED')
    return 'ok';
  if (ORCHESTRATION_REFUSALS.has(status)) return 'refused';
  // Nœud en erreur : le détail est le code de l'erreur de domaine levée
  // (SESSION_LIVE, AGENT_EXISTS…) — sa nature décide, comme pour une commande
  // seule. Un code inconnu ou inattendu reste un échec.
  if (status === 'ERROR' && detail !== null && errorKindOf(detail) === 'refusal') return 'refused';
  // Tour ou tâche arrêtés par un plafond de tokens : la garde a parlé (refus),
  // comme pour `run --autonomous`. Le détail est `BUDGET_EXCEEDED`, éventuellement
  // préfixé par le nœud (`<étape>:BUDGET_EXCEEDED`, `SESSION_FAILED:BUDGET_EXCEEDED`).
  if (status === 'SESSION_FAILED' && /(^|:)BUDGET_EXCEEDED$/.test(detail ?? '')) return 'refused';
  return 'failed';
}

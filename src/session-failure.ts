/**
 * Clone CONSERVÉ après une session autonome en échec, sans rien à merger.
 *
 * Décision utilisateur (« non bloquant ») : un clone dont la session s'est terminée EN ÉCHEC et
 * qui ne porte aucun commit attend un humain, il ne travaille plus. Qu'il tienne en respect une
 * tâche que le Router ne sait pas localiser (sentinelle WHOLE_REPO — tâche vague, prédiction
 * vide, budget épuisé) la bloquerait jusqu'au délai d'attente pour rien. Seule la SENTINELLE
 * l'ignore : une collision sur un fichier précis prédit reste bloquante dans tous les cas
 * (`detectCollisionsDetailed`, router.js), et l'allègement est toujours rendu visible
 * (événement `task:serialization-relaxed`, champ `relaxedBlockers`).
 *
 * La preuve est un marqueur écrit au registre par la fin de cycle (`concludeAutonomousSession`) ;
 * elle est fail closed : tout doute (session vivante, nouvelle session depuis, commits, mode
 * supervisé) la rend inopérante et le clone redevient bloquant.
 */
import type { AgentMeta } from './types.js';

/** Statuts de session qui constituent un ÉCHEC (une annulation demandée n'en est pas un). */
export function isFailedSessionStatus(status: string): boolean {
  return status !== 'COMPLETED' && status !== 'CANCELLED';
}

/** Marqueur écrit à la fin d'une session en échec. */
export function sessionFailureMarker(
  meta: Pick<AgentMeta, 'sessionStartedAt'>,
  status: string,
  hasCommits: boolean,
  now: Date = new Date(),
): NonNullable<AgentMeta['sessionFailure']> {
  return {
    status,
    at: now.toISOString(),
    hasCommits,
    sessionStartedAt: meta.sessionStartedAt ?? null,
  };
}

/**
 * Le clone est-il un clone « échoué, sans commit, inerte » dont la sentinelle WHOLE_REPO peut
 * se passer ? Retourne le statut de session échoué, ou null (clone bloquant).
 */
export function failedKeptSessionStatus(
  meta: Partial<
    Pick<AgentMeta, 'mode' | 'sessionPid' | 'sessionStartedAt' | 'sessionFailure' | 'removing'>
  >,
): string | null {
  const failure = meta.sessionFailure;
  if (!failure || typeof failure.status !== 'string') return null;
  if (meta.mode !== 'autonomous') return null;
  if (meta.removing) return null;
  // Une session vit (ou un PID est publié, même périmé) : jamais d'allègement.
  if (meta.sessionPid != null) return null;
  // Une session plus récente a démarré depuis : le marqueur ne parle plus d'elle.
  if ((failure.sessionStartedAt ?? null) !== (meta.sessionStartedAt ?? null)) return null;
  if (failure.hasCommits !== false) return null;
  return isFailedSessionStatus(failure.status) ? failure.status : null;
}

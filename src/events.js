import { notify } from './notify.js';
import { logger } from './logger.js';

/**
 * Bus d'observabilité interne — le mécanisme des CONSÉQUENCES SANS AUTORITÉ.
 *
 * Le kernel (orchestrator, sync) émet des événements structurés après coup ;
 * les abonnés (webhooks aujourd'hui, SSE du dashboard demain) informent,
 * jamais ne décident. Trois invariants, non négociables :
 *
 *  1. Un abonné qui throw ne casse RIEN : chaque abonné est isolé, son
 *     erreur est loggée et n'atteint ni le cycle de merge ni les autres
 *     abonnés. Même contrat best-effort que notify().
 *  2. In-process uniquement. Le bus ne franchit pas les process (watch,
 *     dashboard et CLI ponctuels sont des process distincts) — pas de
 *     journal disque : l'historique se reconstruit depuis le graphe Git,
 *     décision existante, aucun état parallèle.
 *  3. Aucune mutation d'état dans un abonné. La chaîne sérialisée est le
 *     modèle de concurrence du projet ; un abonné qui toucherait au repo ou
 *     aux fichiers d'état réintroduirait les courses qu'elle élimine.
 *
 * Les erreurs, elles, ne passent JAMAIS par ce bus : une erreur est une
 * valeur de contrôle qui remonte à l'appelant qui décide (StriartError,
 * résultats typés). Publier « quelque chose a échoué » sans garantir de
 * conséquence serait un repli silencieux par construction.
 *
 * Le `message` humain est construit au site d'émission — c'est là que vit le
 * contexte — et transporté par l'événement à côté de son payload structuré :
 * le pont notify relaie le texte à l'identique, les consommateurs machine
 * liront les champs.
 */

/** @type {Set<(config: import('./types.js').StriartConfig, event: import('./types.js').StriartEvent) => void | Promise<void>>} */
const subscribers = new Set();

/**
 * Abonne un consommateur. Retourne la fonction de désabonnement.
 * @param {(config: import('./types.js').StriartConfig, event: import('./types.js').StriartEvent) => void | Promise<void>} subscriber
 * @returns {() => void}
 */
export function onStriartEvent(subscriber) {
  subscribers.add(subscriber);
  return () => subscribers.delete(subscriber);
}

/**
 * Émet un événement vers tous les abonnés, séquentiellement et en les
 * attendant — l'émission reste awaitée par le kernel comme notify() l'était,
 * le comportement temporel ne change pas. Chaque abonné est isolé : son
 * throw est loggé, jamais propagé.
 *
 * @param {import('./types.js').StriartConfig} config
 * @param {import('./types.js').StriartEvent} event
 * @returns {Promise<void>}
 */
export async function emitStriartEvent(config, event) {
  for (const subscriber of subscribers) {
    try {
      await subscriber(config, event);
    } catch (error) {
      logger.warn(
        { err: error instanceof Error ? error.message : String(error), event: event.type },
        'Abonné du bus d’événements en échec (ignoré)',
      );
    }
  }
}

// Pont historique : tout événement porteur d'un message part vers les
// webhooks configurés. C'est la reproduction exacte du comportement d'avant
// le bus (chaque site d'émission appelait notify directement) — le jour où
// un événement ne doit PAS être notifié (ex: merge:done pour un futur SSE),
// il suffira de l'émettre sans message ou d'affiner ce filtre.
onStriartEvent(async (config, event) => {
  if (event.message) await notify(config, event.message);
});

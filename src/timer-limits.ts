/**
 * Plus grand délai (ms) que `setTimeout` accepte (2^31 - 1). Au-delà, Node
 * ramène le délai à 1 ms et affiche un avertissement : un Test Gate ou une
 * session d'agent configuré à 30 jours serait tué aussitôt. Borne haute commune
 * à tous les délais saisis par l'utilisateur (config, profils, plans).
 */
export const MAX_TIMER_MS = 2_147_483_647;

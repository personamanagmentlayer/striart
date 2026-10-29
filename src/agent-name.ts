import { StriartError } from './errors.ts';

/**
 * Nom d'agent : alphanumérique en tête, puis alphanumérique, tiret ou
 * underscore, 64 caractères au plus. Il devient un nom de dossier, un
 * morceau de nom de branche et un argument de commande : le jeu de
 * caractères est volontairement fermé (aucun séparateur de chemin, aucun
 * caractère interprété par un shell).
 *
 * Module sans dépendance lourde : la CLI valide un nom AVANT de charger git
 * (erreur d'usage immédiate, sortie 2).
 */
export const AGENT_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/i;

export function validateAgentName(name: unknown): string {
  if (typeof name !== 'string' || !AGENT_NAME_RE.test(name)) {
    throw new StriartError(
      `Nom d'agent invalide : ${JSON.stringify(name)}. Attendu : lettres, chiffres, tirets et underscores, commençant par une lettre ou un chiffre (64 caractères au plus).`,
      {
        code: 'INVALID_AGENT_NAME',
        details: { name },
        hint: 'striart start agent-a',
      },
    );
  }
  return name;
}

/**
 * Environnement RÉSEAU des sessions d'agents (argv, ACP en process, hôte ACP
 * persistant : tous passent par `runAgentSession`, qui l'applique une fois).
 *
 * Une session reçoit l'environnement de l'orchestrateur (c'est voulu : l'outil
 * d'agent a besoin de ses clés — voir SECURITY.md). Ce module ajoute deux
 * règles propres au réseau d'entreprise :
 *
 *  - `network.caFile` (config UTILISATEUR, src/user-config.ts) devient
 *    `NODE_EXTRA_CA_CERTS` de la session, pour que l'outil (Node) fasse
 *    confiance à l'autorité d'entreprise comme l'orchestrateur. Jamais depuis
 *    la config du dépôt (un dépôt hostile ajouterait sa propre CA), et jamais
 *    au détriment d'un `NODE_EXTRA_CA_CERTS` déjà posé dans le shell (une seule
 *    valeur possible : le choix explicite du shell l'emporte, et le fait est
 *    journalisé). L'`env` d'un profil de la config du dépôt vient APRÈS,
 *    comme toute variable de profil (session.js) ;
 *  - `STRIART_PROXY_AUTH` (identifiants du proxy d'entreprise) n'est JAMAIS
 *    transmise : c'est un secret de l'orchestrateur, que l'agent n'a pas à
 *    voir ni à écrire dans ses journaux. Les variables de proxy ordinaires
 *    (HTTP(S)_PROXY, NO_PROXY, ALL_PROXY…) restent héritées telles quelles.
 *
 * Pur et synchrone ; `loadSessionNetwork` lit la config utilisateur.
 */
import { logger } from './logger.ts';
import { readUserConfig } from './user-config.ts';

export interface SessionNetworkInput {
  /** `network.caFile` de la config utilisateur (chemin absolu validé) ou null. */
  caFile: string | null;
}

export interface SessionNetworkEnv {
  env: NodeJS.ProcessEnv;
  /** `applied` : posé depuis la config ; `shadowed` : le shell en avait déjà posé un autre ; `none` : rien à faire. */
  caFile: 'applied' | 'shadowed' | 'none';
}

const NEVER_PROPAGATED = /^STRIART_PROXY_AUTH$/i;
const CA_VAR = 'NODE_EXTRA_CA_CERTS';

export function sessionNetworkEnv(
  base: NodeJS.ProcessEnv,
  network: SessionNetworkInput | null,
): SessionNetworkEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(base)) {
    if (NEVER_PROPAGATED.test(name)) continue;
    env[name] = value;
  }
  const caFile = network?.caFile ?? null;
  if (!caFile) return { env, caFile: 'none' };
  const existing = Object.entries(env).find(
    ([name, value]) => name.toUpperCase() === CA_VAR && typeof value === 'string' && value !== '',
  );
  if (existing) return { env, caFile: existing[1] === caFile ? 'applied' : 'shadowed' };
  env[CA_VAR] = caFile;
  return { env, caFile: 'applied' };
}

let warnedUnreadable = false;
const warnedShadow = new Set<string>();

/**
 * Environnement de session = `base` filtré/complété par la config utilisateur.
 * Une config utilisateur illisible n'ajoute RIEN (fail closed) mais ne bloque
 * pas la session : la protection de `STRIART_PROXY_AUTH` s'applique quand même.
 */
export async function buildSessionEnv(base: NodeJS.ProcessEnv): Promise<NodeJS.ProcessEnv> {
  let network: SessionNetworkInput | null = null;
  try {
    network = { caFile: (await readUserConfig()).network.caFile };
  } catch (error) {
    if (!warnedUnreadable) {
      warnedUnreadable = true;
      logger.warn(
        { code: (error as { code?: string }).code },
        'Config utilisateur illisible : network.caFile n’est pas transmis aux sessions d’agents',
      );
    }
  }
  const out = sessionNetworkEnv(base, network);
  if (out.caFile === 'shadowed' && network?.caFile && !warnedShadow.has(network.caFile)) {
    warnedShadow.add(network.caFile);
    logger.warn(
      { caFile: network.caFile },
      'NODE_EXTRA_CA_CERTS est déjà défini dans l’environnement : network.caFile (config utilisateur) n’est pas transmis aux sessions d’agents (une seule valeur possible)',
    );
  }
  return out.env;
}

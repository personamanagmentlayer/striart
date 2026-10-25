/**
 * Fin de session d'un clone du proxy ACP `striart acp` (lot I10) : le cycle
 * autonome NORMAL, appliqué une fois la session amont close — contrat de
 * commit du profil (lot I3), puis merge sous Test Gate (la garde des chemins
 * protégés du lot I2 vit dans `mergeAgentCommit`), puis nettoyage SANS force.
 *
 * Cette glue n'a plus de logique propre : elle compose la primitive unique du
 * noyau (`src/autonomous-cycle.ts`, partagée avec `runAutonomousTask` et les
 * modes orchestrés) et n'ajoute que ce qui est spécifique au proxy :
 *  - aucun tour joué (`session` null) → `concludeUnstartedClone` ;
 *  - merge différé (`acpAgent.merge: manual`, éditeur déconnecté) → clone
 *    conservé, `MERGE_DEFERRED` ;
 *  - libellés anglais (`wording: 'acp-proxy'`, affichés dans l'éditeur) ;
 *  - un commit de l'agent déjà dans la cible (`UP_TO_DATE`) est un succès BRUYANT
 *    (décision du noyau, voir autonomous-cycle.ts) : `merge.mergeSha` désigne le
 *    commit de la cible qui porte le travail, `warnings: ['ALREADY_INTEGRATED']` ;
 *
 * Le verrou principal n'est jamais tenu ici (décision n°6) : la primitive appelle
 * `mergeAgentCommit` et `cleanClones`, qui le prennent chacun brièvement.
 */
import { concludeAutonomousSession, concludeUnstartedClone } from '../autonomous-cycle.ts';
import type {
  AcpProxyResult,
  AgentMeta,
  AgentProfile,
  SessionResult,
  StriartConfig,
} from '../types.js';

export type ProxyAgentInfo = AgentMeta & { name: string };

export interface ConcludeSpec {
  root: string;
  config: StriartConfig;
  meta: ProxyAgentInfo;
  profileKey: string;
  profile: AgentProfile;
  /** null : aucune session n'a tourné dans ce clone (clone créé puis tour annulé). */
  session: SessionResult | null;
  /** Premier prompt (tâche du clone, message des commits Striart). */
  prompt: string;
  /** false : merge laissé à l'humain (clone conservé, `MERGE_DEFERRED`). */
  merge: boolean;
  /** Pourquoi le merge est différé ('MANUAL' | 'DISCONNECTED'). */
  deferredReason: 'MANUAL' | 'DISCONNECTED';
}

export async function concludeProxySession(spec: ConcludeSpec): Promise<AcpProxyResult> {
  const { root, config, meta, profileKey, profile, session, prompt } = spec;
  if (!session) return concludeUnstartedClone({ root, meta, wording: 'acp-proxy' });
  return concludeAutonomousSession({
    root,
    config,
    meta,
    profileKey,
    profile,
    session,
    prompt,
    wording: 'acp-proxy',
    mergeMode: spec.merge ? 'auto' : { deferred: spec.deferredReason },
  });
}

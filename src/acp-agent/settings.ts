/**
 * Réglages du proxy ACP `striart acp` (lot I10) — clé de config `acpAgent`.
 *
 * Principe du projet : tout comportement à choix défendables est une option
 * validée, avec un défaut SÛR ; relâcher une protection est explicite,
 * journalisé et affichable (`acpAgentRelaxedProtections`). Module pur, sans
 * effet de bord : importé par `config.js` (validation au chargement) et par
 * le proxy (résolution des valeurs effectives).
 *
 * L'objet utilisateur est PARTIEL : ses clés remplacent celles des défauts
 * (`resolveAcpAgentSettings`), comme `orchestration` et `collab`.
 */
import { AGENT_NAME_RE } from '../agent-name.ts';

/**
 * Politique de permission d'une session IDE :
 *  - 'ask'     : chaque demande de l'agent est arbitrée par l'humain DANS
 *                l'IDE (session/request_permission relayé) — défaut ;
 *  - 'reject'  : tout refusé, sans question ;
 *  - 'allow'   : tout accordé ponctuellement (relâchement) ;
 *  - 'profile' : la politique déclarée par le profil amont (`acp.permissions`).
 */
export const ACP_AGENT_PERMISSION_POLICIES = ['ask', 'reject', 'allow', 'profile'] as const;
export type AcpAgentPermissionPolicy = (typeof ACP_AGENT_PERMISSION_POLICIES)[number];

/** Fin de session : merge sous Test Gate par Striart ('auto'), ou clone conservé ('manual'). */
export const ACP_AGENT_MERGE_MODES = ['auto', 'manual'] as const;
export type AcpAgentMergeMode = (typeof ACP_AGENT_MERGE_MODES)[number];

/**
 * IDE déconnecté sans fin explicite (stdin fermé) :
 *  - 'keep'   : la session amont est fermée proprement, le clone est
 *               CONSERVÉ sans merge (décision humaine différée) — défaut ;
 *  - 'finish' : fin de session normale (merge selon `merge`).
 */
export const ACP_AGENT_DISCONNECT_MODES = ['keep', 'finish'] as const;
export type AcpAgentDisconnectMode = (typeof ACP_AGENT_DISCONNECT_MODES)[number];

/** Collision du Router au premier prompt : refus immédiat, ou attente bornée. */
export const ACP_AGENT_COLLISION_POLICIES = ['fail', 'wait'] as const;
export type AcpAgentCollisionPolicy = (typeof ACP_AGENT_COLLISION_POLICIES)[number];

export interface AcpAgentSettings {
  /** Profil amont proposé par défaut ; null → le premier profil ACP (ordre alphabétique). */
  defaultProfile: string | null;
  /** Profils proposés à l'IDE (liste blanche) ; null → tous les profils ACP. */
  profiles: string[] | null;
  /** Politique de permission par défaut d'une session. */
  permissions: AcpAgentPermissionPolicy;
  /** Politiques que l'humain peut choisir depuis l'IDE (option de session). */
  permissionChoices: AcpAgentPermissionPolicy[];
  /** Délai d'arbitrage humain (politique 'ask') ; null → celui du profil. */
  askTimeoutMs: number | null;
  merge: AcpAgentMergeMode;
  /** L'humain peut basculer auto/manuel depuis l'IDE. */
  mergeChoice: boolean;
  onDisconnect: AcpAgentDisconnectMode;
  /** Nom FIXE du clone ; null → dérivé du premier prompt (comme `striart run`). */
  agentName: string | null;
  /** Réhabilite un clone archivé du même nom (exige `agentName`). */
  reuse: boolean;
  collisionPolicy: AcpAgentCollisionPolicy;
  collisionWaitMs: number;
  collisionPollMs: number;
  /** Durée maximale d'une session IDE (l'hôte annule au-delà, clone conservé). */
  sessionTimeoutMs: number;
  /** Relaie le raisonnement de l'agent (`agent_thought_chunk`) à l'IDE. */
  relayThoughts: boolean;
}

export const DEFAULT_ACP_AGENT_SETTINGS: Readonly<AcpAgentSettings> = Object.freeze({
  defaultProfile: null,
  profiles: null,
  permissions: 'ask',
  permissionChoices: ['ask', 'reject'],
  askTimeoutMs: null,
  merge: 'auto',
  mergeChoice: true,
  onDisconnect: 'keep',
  agentName: null,
  reuse: false,
  collisionPolicy: 'fail',
  collisionWaitMs: 600_000,
  collisionPollMs: 2_000,
  sessionTimeoutMs: 14_400_000,
  relayThoughts: true,
}) as Readonly<AcpAgentSettings>;

const KEYS = new Set(Object.keys(DEFAULT_ACP_AGENT_SETTINGS));
const PROFILE_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const isIntIn = (v: unknown, min: number, max: number) =>
  Number.isInteger(v) && (v as number) >= min && (v as number) <= max;
const oneOf = <T extends string>(values: readonly T[], v: unknown): v is T =>
  typeof v === 'string' && (values as readonly string[]).includes(v);

/**
 * Valide un objet `acpAgent` PARTIEL. Rend le CHAMP fautif (jamais la
 * valeur), ou null. Une clé inconnue est refusée : une faute de frappe sur
 * une protection ne doit pas passer pour un défaut appliqué.
 */
export function acpAgentSettingsProblem(value: unknown): string | null {
  if (!isPlainObject(value)) return 'acpAgent';
  for (const key of Object.keys(value)) if (!KEYS.has(key)) return `acpAgent.${key}`;
  const v = value;
  if (
    v.defaultProfile != null &&
    !(typeof v.defaultProfile === 'string' && PROFILE_KEY_RE.test(v.defaultProfile))
  )
    return 'acpAgent.defaultProfile';
  if (
    v.profiles != null &&
    !(
      Array.isArray(v.profiles) &&
      v.profiles.length > 0 &&
      v.profiles.length <= 64 &&
      v.profiles.every((p) => typeof p === 'string' && PROFILE_KEY_RE.test(p))
    )
  )
    return 'acpAgent.profiles';
  if (v.permissions !== undefined && !oneOf(ACP_AGENT_PERMISSION_POLICIES, v.permissions))
    return 'acpAgent.permissions';
  if (
    v.permissionChoices !== undefined &&
    !(
      Array.isArray(v.permissionChoices) &&
      v.permissionChoices.length > 0 &&
      v.permissionChoices.every((p) => oneOf(ACP_AGENT_PERMISSION_POLICIES, p)) &&
      new Set(v.permissionChoices).size === v.permissionChoices.length
    )
  )
    return 'acpAgent.permissionChoices';
  if (v.askTimeoutMs != null && !isIntIn(v.askTimeoutMs, 1_000, 86_400_000))
    return 'acpAgent.askTimeoutMs';
  if (v.merge !== undefined && !oneOf(ACP_AGENT_MERGE_MODES, v.merge)) return 'acpAgent.merge';
  if (v.mergeChoice !== undefined && typeof v.mergeChoice !== 'boolean')
    return 'acpAgent.mergeChoice';
  if (v.onDisconnect !== undefined && !oneOf(ACP_AGENT_DISCONNECT_MODES, v.onDisconnect))
    return 'acpAgent.onDisconnect';
  if (v.agentName != null && !(typeof v.agentName === 'string' && AGENT_NAME_RE.test(v.agentName)))
    return 'acpAgent.agentName';
  if (v.reuse !== undefined && typeof v.reuse !== 'boolean') return 'acpAgent.reuse';
  if (v.collisionPolicy !== undefined && !oneOf(ACP_AGENT_COLLISION_POLICIES, v.collisionPolicy))
    return 'acpAgent.collisionPolicy';
  if (v.collisionWaitMs !== undefined && !isIntIn(v.collisionWaitMs, 1_000, 86_400_000))
    return 'acpAgent.collisionWaitMs';
  if (v.collisionPollMs !== undefined && !isIntIn(v.collisionPollMs, 100, 600_000))
    return 'acpAgent.collisionPollMs';
  if (v.sessionTimeoutMs !== undefined && !isIntIn(v.sessionTimeoutMs, 60_000, 7 * 86_400_000))
    return 'acpAgent.sessionTimeoutMs';
  if (v.relayThoughts !== undefined && typeof v.relayThoughts !== 'boolean')
    return 'acpAgent.relayThoughts';
  // Cohérences : une réutilisation vise une archive PRÉCISE (comme `run --reuse`),
  // et la politique par défaut doit faire partie des choix offerts.
  const merged = { ...DEFAULT_ACP_AGENT_SETTINGS, ...v } as AcpAgentSettings;
  if (merged.reuse && !merged.agentName) return 'acpAgent.reuse';
  if (!merged.permissionChoices.includes(merged.permissions)) return 'acpAgent.permissions';
  return null;
}

/** Valeurs effectives : défauts complétés par l'objet utilisateur (déjà validé au chargement). */
export function resolveAcpAgentSettings(value: unknown): AcpAgentSettings {
  const partial = isPlainObject(value) ? value : {};
  const settings = { ...DEFAULT_ACP_AGENT_SETTINGS, ...partial } as AcpAgentSettings;
  return {
    ...settings,
    profiles: settings.profiles ? [...settings.profiles] : null,
    permissionChoices: [...settings.permissionChoices],
  };
}

/**
 * Protections relâchées par la config `acpAgent`, en identifiants stables —
 * journalisées au démarrage de `striart acp` et destinées à `striart doctor`.
 */
export function acpAgentRelaxedProtections(settings: AcpAgentSettings): string[] {
  const relaxed: string[] = [];
  if (settings.permissions === 'allow') relaxed.push('acpAgent.permissions');
  if (settings.permissionChoices.includes('allow')) relaxed.push('acpAgent.permissionChoices');
  if (settings.permissions === 'profile' || settings.permissionChoices.includes('profile'))
    relaxed.push('acpAgent.permissions.profile');
  if (settings.onDisconnect === 'finish') relaxed.push('acpAgent.onDisconnect');
  return relaxed;
}

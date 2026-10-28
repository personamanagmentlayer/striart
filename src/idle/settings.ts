/**
 * Réglages du GC d'agents et de sessions inactifs (`config.idle`, voir
 * src/idle/). Module FEUILLE : `config.js` le charge pour valider la clé sans
 * importer git, le clone ni le bus.
 *
 * Deux niveaux de décision, volontairement séparés :
 *  - la config du DÉPÔT fixe les seuils et la POLITIQUE (`action`) ;
 *  - l'AUTORISATION de fermer une session vit dans la config UTILISATEUR
 *    (`idle.closeRoots`, src/user-config.ts) : un dépôt hostile ne doit pas
 *    pouvoir, par un fichier commité, obtenir qu'on termine des process sur la
 *    machine de qui l'ouvre. Sans autorisation, `action: 'close'` dégrade en
 *    avertissement et le rapport le dit (`closeAuthorized: false`).
 */

export type IdleAction = 'report' | 'warn' | 'close';

export const IDLE_ACTIONS: readonly IdleAction[] = Object.freeze(['report', 'warn', 'close']);

export interface IdleSettings {
  /** Détecter et rapporter l'inactivité (false : relâchement EXPLICITE, affiché par `doctor`). */
  enabled: boolean;
  /**
   *  - 'report' : détection, statut `idle`, événement — rien d'autre ;
   *  - 'warn'   : + avertissement (journal, webhooks) avec délai de grâce ;
   *  - 'close'  : + fermeture propre de la session après la grâce (opt-in,
   *    autorisée par la config utilisateur).
   */
  action: IdleAction;
  /** Inactivité (tous signaux confondus) à partir de laquelle l'agent est `idle` et averti. */
  warnAfterMs: number;
  /** Inactivité à partir de laquelle la session est FERMABLE (jamais avant `warnAfterMs`). */
  closeAfterMs: number;
  /** Délai entre l'avertissement et la fermeture : toute activité dans l'intervalle annule. */
  graceMs: number;
  /** Période du balayage dans `striart watch`. */
  sweepIntervalMs: number;
  /** Fermetures maximales par balayage (borne un emballement : horloge, bug). */
  maxClosuresPerSweep: number;
  /**
   * Autoriser la fermeture d'un terminal (hôte de pty) dont la dernière sortie n'est PAS
   * observée (hôte d'une version antérieure qui ne publie pas `host.output`, programme encore
   * silencieux, fichier invalide) : « inactif » repose alors sur les autres signaux seuls.
   * Quand l'hôte natif publie l'heure de la dernière sortie, ce relâchement n'est pas requis.
   * Relâchement explicite.
   */
  closePty: boolean;
  /** Agents jamais touchés : noms exacts ou préfixe `nom*`. */
  excludeAgents: string[];
  /** Profils (`agentProfiles`) dont les agents ne sont jamais touchés. */
  excludeProfiles: string[];
}

export type IdleSettingsInput = Partial<IdleSettings>;

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export const DEFAULT_IDLE_SETTINGS: Readonly<IdleSettings> = Object.freeze({
  enabled: true,
  action: 'report',
  warnAfterMs: 30 * MINUTE,
  closeAfterMs: 2 * HOUR,
  graceMs: 5 * MINUTE,
  sweepIntervalMs: 5 * MINUTE,
  maxClosuresPerSweep: 4,
  closePty: false,
  excludeAgents: [],
  excludeProfiles: [],
}) as Readonly<IdleSettings>;

/** Bornes (plancher, plafond) de chaque durée — hors bornes = config refusée. */
export const IDLE_BOUNDS = Object.freeze({
  warnAfterMs: [MINUTE, 30 * DAY],
  closeAfterMs: [2 * MINUTE, 90 * DAY],
  graceMs: [10_000, DAY],
  sweepIntervalMs: [15_000, HOUR],
  maxClosuresPerSweep: [1, 64],
} as const);

const MAX_EXCLUSIONS = 128;
const KEYS = Object.keys(DEFAULT_IDLE_SETTINGS);
/** Nom d'agent exact, ou préfixe terminé par `*` (jamais un `*` seul : exclure tout = désactiver). */
const AGENT_PATTERN_RE = /^[a-z0-9][a-z0-9_-]{0,62}\*?$/i;
const PROFILE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

const intIn = (x: unknown, [min, max]: readonly [number, number]): boolean =>
  Number.isSafeInteger(x) && (x as number) >= min && (x as number) <= max;
const stringList = (x: unknown, re: RegExp): boolean =>
  Array.isArray(x) &&
  x.length <= MAX_EXCLUSIONS &&
  x.every((s) => typeof s === 'string' && re.test(s));

/**
 * Problème de `config.idle` (objet PARTIEL fusionné aux défauts avant les
 * contrôles croisés), ou null. Clé inconnue refusée : une faute de frappe sur
 * un garde-fou (`closeAfterMS`) ne passe pas en silence.
 */
export function idleSettingsProblem(v: unknown): string | null {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return 'objet attendu';
  const o = v as Record<string, unknown>;
  for (const key of Object.keys(o)) if (!KEYS.includes(key)) return `clé inconnue « ${key} »`;
  const m = { ...DEFAULT_IDLE_SETTINGS, ...o } as Record<string, unknown>;
  if (typeof m.enabled !== 'boolean') return 'enabled : booléen attendu';
  if (typeof m.closePty !== 'boolean') return 'closePty : booléen attendu';
  if (!IDLE_ACTIONS.includes(m.action as IdleAction)) return "action : 'report', 'warn' ou 'close'";
  for (const key of Object.keys(IDLE_BOUNDS) as Array<keyof typeof IDLE_BOUNDS>) {
    if (!intIn(m[key], IDLE_BOUNDS[key]))
      return `${key} : entier dans [${IDLE_BOUNDS[key][0]}, ${IDLE_BOUNDS[key][1]}] attendu`;
  }
  if ((m.closeAfterMs as number) < (m.warnAfterMs as number))
    return 'closeAfterMs doit être supérieur ou égal à warnAfterMs';
  if (!stringList(m.excludeAgents, AGENT_PATTERN_RE))
    return `excludeAgents : tableau (au plus ${MAX_EXCLUSIONS}) de noms d'agent ou de préfixes « nom* »`;
  if (!stringList(m.excludeProfiles, PROFILE_NAME_RE))
    return `excludeProfiles : tableau (au plus ${MAX_EXCLUSIONS}) de noms de profil`;
  return null;
}

export function isValidIdleSettings(v: unknown): boolean {
  return idleSettingsProblem(v) === null;
}

export function resolveIdleSettings(config: { idle?: unknown } | null | undefined): IdleSettings {
  const given = (config?.idle ?? {}) as IdleSettingsInput;
  return {
    ...DEFAULT_IDLE_SETTINGS,
    ...given,
    excludeAgents: [...(given.excludeAgents ?? DEFAULT_IDLE_SETTINGS.excludeAgents)],
    excludeProfiles: [...(given.excludeProfiles ?? DEFAULT_IDLE_SETTINGS.excludeProfiles)],
  };
}

/** L'agent `name` est-il exclu par nom (exact, insensible à la casse) ou par préfixe ? */
export function isAgentExcluded(settings: IdleSettings, name: string): boolean {
  const lower = name.toLowerCase();
  return settings.excludeAgents.some((pattern) => {
    const p = pattern.toLowerCase();
    return p.endsWith('*') ? lower.startsWith(p.slice(0, -1)) : lower === p;
  });
}

/** Relâchements : baisser une garde, jamais « choisir une politique ». */
export function idleRelaxations(
  config: { idle?: unknown } | null | undefined,
): Array<{ key: string; summary: string }> {
  const s = resolveIdleSettings(config);
  const out: Array<{ key: string; summary: string }> = [];
  if (!s.enabled) {
    out.push({
      key: 'idle.enabled',
      summary:
        'idle.enabled is false: forgotten agents and sessions are neither detected nor reported — processes and terminals stay open until someone stops them.',
    });
  }
  if (s.closePty) {
    out.push({
      key: 'idle.closePty',
      summary:
        'idle.closePty is true: a terminal session may be closed on the strength of the worktree, refs and message signals alone — the output of a terminal cannot be observed.',
    });
  }
  return out;
}

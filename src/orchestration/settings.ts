/**
 * Réglages du lot O (modes d'orchestration, canal de collaboration, LLM par
 * rôle). Module SANS dépendance vers config.js : config.js importe d'ici les
 * défauts et les validateurs (même schéma que terminal/config.ts), et les
 * consommateurs fusionnent la valeur PARTIELLE de l'utilisateur avec les
 * défauts par `resolve*Settings` — loadConfig ne fusionne qu'en surface.
 *
 * Principe : tout comportement à choix défendables est une clé validée avec
 * un défaut sûr ; une clé inconnue est refusée (une faute de frappe ne doit
 * jamais laisser croire à un réglage actif) ; tout relâchement d'une
 * protection est listé par `orchestrationRelaxations` pour `striart doctor`.
 */
import type { CollabSettings, LlmRoles, OrchestrationSettings, StriartConfig } from '../types.js';

export const DEFAULT_ORCHESTRATION_SETTINGS: OrchestrationSettings = Object.freeze({
  // Tâches simultanées d'un plan `parallel` sans `concurrency`, et plafond dur.
  concurrency: 2,
  maxConcurrency: 8,
  // Après un échec : plus rien ne démarre (le plus sûr : aucune tâche ne
  // part sur un état que l'auteur du plan n'a pas prévu).
  onFailure: 'stop',
  // Collision du Router sur une tâche orchestrée : attendre (borné) plutôt
  // que de laisser la file la relancer en SUPERVISÉ (perte du mode).
  collisionPolicy: 'wait',
  pollIntervalMs: 2000,
  // Attente maximale d'une dépendance ou d'un dégagement de collision.
  waitTimeoutMs: 86_400_000,
  // États de plans/groupes terminés conservés sous .striart/orchestration/.
  keepRuns: 50,
  review: Object.freeze({
    maxRounds: 3,
    verdictRetries: 1,
    quorum: 'all',
    reviewerWrites: 'fail',
    humanTimeoutMs: 86_400_000,
  }),
  race: Object.freeze({
    pick: 'first-green',
    losers: 'keep',
    maxCandidates: 5,
    judgeFallback: 'fail',
  }),
  team: Object.freeze({ cadence: 'turns', rounds: 1, maxRounds: 10, onScopeViolation: 'fail' }),
  pipeline: Object.freeze({ handoff: 'merge' }),
}) as OrchestrationSettings;

export const DEFAULT_COLLAB_SETTINGS: CollabSettings = Object.freeze({
  enabled: true,
  maxMessages: 200,
  maxBodyBytes: 8192,
  maxMessagesPerSender: 50,
  inboxFile: true,
  outboxFile: true,
  maxOutboxBytes: 65_536,
  briefingMaxChars: 12_000,
  logMarkers: true,
});

export const DEFAULT_LLM_ROLES: LlmRoles = Object.freeze({
  router: null,
  merger: null,
  memory: null,
  judge: null,
  planner: null,
});

export const LLM_ROLE_NAMES = ['router', 'merger', 'memory', 'judge', 'planner'] as const;
export type LlmRoleName = (typeof LLM_ROLE_NAMES)[number];

type Rec = Record<string, unknown>;

const isObject = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v);
const onlyKeys = (v: Rec, keys: readonly string[]) => Object.keys(v).every((k) => keys.includes(k));
const intIn = (x: unknown, min: number, max: number) =>
  x === undefined || (Number.isInteger(x) && (x as number) >= min && (x as number) <= max);
const oneOf = (x: unknown, values: readonly string[]) =>
  x === undefined || (typeof x === 'string' && values.includes(x));
const bool = (x: unknown) => x === undefined || typeof x === 'boolean';

const DAY_MS = 86_400_000;

function isValidSub(v: unknown, check: (s: Rec) => boolean): boolean {
  return v === undefined || (isObject(v) && check(v));
}

/** Valide `config.orchestration` (objet partiel). */
export function isValidOrchestrationSettings(v: unknown): boolean {
  if (!isObject(v)) return false;
  const top = [
    'concurrency',
    'maxConcurrency',
    'onFailure',
    'collisionPolicy',
    'pollIntervalMs',
    'waitTimeoutMs',
    'keepRuns',
    'review',
    'race',
    'team',
    'pipeline',
  ];
  if (!onlyKeys(v, top)) return false;
  const maxConcurrency = (v.maxConcurrency ??
    DEFAULT_ORCHESTRATION_SETTINGS.maxConcurrency) as number;
  return (
    intIn(v.maxConcurrency, 1, 64) &&
    intIn(v.concurrency, 1, 64) &&
    (v.concurrency === undefined || (v.concurrency as number) <= maxConcurrency) &&
    oneOf(v.onFailure, ['stop', 'skip-dependents']) &&
    oneOf(v.collisionPolicy, ['wait', 'fail']) &&
    intIn(v.pollIntervalMs, 100, 60_000) &&
    intIn(v.waitTimeoutMs, 1000, 30 * DAY_MS) &&
    intIn(v.keepRuns, 1, 10_000) &&
    isValidSub(
      v.review,
      (s) =>
        onlyKeys(s, [
          'maxRounds',
          'verdictRetries',
          'quorum',
          'reviewerWrites',
          'humanTimeoutMs',
        ]) &&
        intIn(s.maxRounds, 1, 10) &&
        intIn(s.verdictRetries, 0, 3) &&
        oneOf(s.quorum, ['all', 'any', 'majority']) &&
        oneOf(s.reviewerWrites, ['fail', 'discard']) &&
        intIn(s.humanTimeoutMs, 60_000, 30 * DAY_MS),
    ) &&
    isValidSub(
      v.race,
      (s) =>
        onlyKeys(s, ['pick', 'losers', 'maxCandidates', 'judgeFallback']) &&
        oneOf(s.pick, ['first-green', 'smallest-diff', 'judge']) &&
        oneOf(s.losers, ['keep', 'archive', 'clean']) &&
        intIn(s.maxCandidates, 2, 10) &&
        oneOf(s.judgeFallback, ['fail', 'first-green']),
    ) &&
    isValidSub(
      v.team,
      (s) =>
        onlyKeys(s, ['cadence', 'rounds', 'maxRounds', 'onScopeViolation']) &&
        oneOf(s.cadence, ['turns', 'parallel']) &&
        intIn(s.rounds, 1, 10) &&
        intIn(s.maxRounds, 1, 10) &&
        oneOf(s.onScopeViolation, ['fail', 'warn']),
    ) &&
    isValidSub(v.pipeline, (s) => onlyKeys(s, ['handoff']) && oneOf(s.handoff, ['merge', 'clone']))
  );
}

/** Valide `config.collab` (objet partiel). */
export function isValidCollabSettings(v: unknown): boolean {
  if (!isObject(v)) return false;
  return (
    onlyKeys(v, Object.keys(DEFAULT_COLLAB_SETTINGS)) &&
    bool(v.enabled) &&
    intIn(v.maxMessages, 1, 10_000) &&
    intIn(v.maxBodyBytes, 256, 262_144) &&
    intIn(v.maxMessagesPerSender, 1, 10_000) &&
    bool(v.inboxFile) &&
    bool(v.outboxFile) &&
    intIn(v.maxOutboxBytes, 1024, 4_194_304) &&
    intIn(v.briefingMaxChars, 1000, 24_000) &&
    bool(v.logMarkers)
  );
}

/** Forme d'un LlmSpec (la validation sémantique du fournisseur reste à llm.js). */
function isLlmSpecShape(v: unknown): boolean {
  if (v === null) return true;
  if (!isObject(v)) return false;
  if (!onlyKeys(v, ['provider', 'model', 'baseUrl', 'apiKeyEnv', 'apiVersion'])) return false;
  return Object.values(v).every(
    (x) => x === undefined || (typeof x === 'string' && x.trim() !== ''),
  );
}

/** Valide `config.llmRoles` : rôles connus seulement, chacun LlmSpec ou null. */
export function isValidLlmRoles(v: unknown): boolean {
  if (!isObject(v)) return false;
  return (
    onlyKeys(v, LLM_ROLE_NAMES) &&
    Object.values(v).every((spec) => spec === undefined || isLlmSpecShape(spec))
  );
}

type WithOrchestration = Partial<Pick<StriartConfig, 'orchestration' | 'collab' | 'llmRoles'>>;

/** Réglages effectifs : défauts complétés en profondeur par la config. */
export function resolveOrchestrationSettings(
  config: WithOrchestration | null,
): OrchestrationSettings {
  const given = (config?.orchestration ?? {}) as Partial<OrchestrationSettings>;
  const d = DEFAULT_ORCHESTRATION_SETTINGS;
  return {
    ...d,
    ...given,
    review: { ...d.review, ...(given.review ?? {}) },
    race: { ...d.race, ...(given.race ?? {}) },
    team: { ...d.team, ...(given.team ?? {}) },
    pipeline: { ...d.pipeline, ...(given.pipeline ?? {}) },
  };
}

export function resolveCollabSettings(config: WithOrchestration | null): CollabSettings {
  return { ...DEFAULT_COLLAB_SETTINGS, ...((config?.collab ?? {}) as Partial<CollabSettings>) };
}

/**
 * Relâchements de protection portés par `orchestration`, pour `striart
 * doctor` (anglais, comme les messages d'erreur du domaine). Resserrer
 * (collisionPolicy 'fail', collab désactivé) n'est pas listé.
 */
export function orchestrationRelaxations(
  config: WithOrchestration | null,
): Array<{ key: string; summary: string }> {
  const s = resolveOrchestrationSettings(config);
  const out: Array<{ key: string; summary: string }> = [];
  if (s.race.losers === 'clean') {
    out.push({
      key: 'orchestration.race.losers',
      summary:
        "orchestration.race.losers is 'clean': the losing clones of a race are DELETED with their unmerged work.",
    });
  }
  if (s.review.reviewerWrites === 'discard') {
    out.push({
      key: 'orchestration.review.reviewerWrites',
      summary:
        "orchestration.review.reviewerWrites is 'discard': changes a reviewer makes to the author's clone are reset instead of failing the review.",
    });
  }
  return out;
}

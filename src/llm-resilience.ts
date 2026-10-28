/**
 * Résilience des appels LLM : classement des erreurs, backoff exponentiel à
 * gigue complète, `Retry-After`, disjoncteur par fournisseur (lot T / L3).
 *
 *  - Une erreur de CONFIGURATION ou de requête (400, 401, 403, 404, 422) ne se
 *    retente jamais : la rejouer brûle du temps et des jetons pour le même
 *    refus. Seuls sont retentés : réseau/délai, 408, 409, 425, 429, 5xx.
 *  - Backoff : délai tiré uniformément dans [0, min(maxMs, baseMs·2^n)]
 *    (« full jitter ») — évite que des clients synchronisés reviennent tous
 *    au même instant. Sur 429/503, `Retry-After` (secondes ou date HTTP) est
 *    un PLANCHER ; au-delà de `maxRetryAfterMs` on n'attend pas : échec franc.
 *  - Disjoncteur par `fournisseur|hôte`, en mémoire du process (un watch ou un
 *    dashboard de longue durée en profite ; une CLI ponctuelle repart propre) :
 *    après `failureThreshold` échecs retentables consécutifs il s'OUVRE, les
 *    appels échouent immédiatement pendant `cooldownMs`, puis UN appel sonde
 *    est admis (demi-ouvert) ; son succès ferme, son échec rouvre.
 */
import { StriartError } from './errors.js';

type Rec = Record<string, unknown>;

export interface LlmResilience {
  backoff: { baseMs: number; maxMs: number; maxRetryAfterMs: number };
  breaker: { enabled: boolean; failureThreshold: number; cooldownMs: number };
}

export type LlmResilienceInput = {
  backoff?: Partial<LlmResilience['backoff']>;
  breaker?: Partial<LlmResilience['breaker']>;
};

export const DEFAULT_LLM_RESILIENCE: LlmResilience = Object.freeze({
  backoff: Object.freeze({ baseMs: 500, maxMs: 20_000, maxRetryAfterMs: 60_000 }),
  breaker: Object.freeze({ enabled: true, failureThreshold: 5, cooldownMs: 30_000 }),
}) as LlmResilience;

const isObject = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v);
const onlyKeys = (v: Rec, keys: readonly string[]) => Object.keys(v).every((k) => keys.includes(k));
const intIn = (x: unknown, min: number, max: number) =>
  x === undefined || (Number.isInteger(x) && (x as number) >= min && (x as number) <= max);

export function isValidLlmResilience(v: unknown): boolean {
  if (!isObject(v) || !onlyKeys(v, ['backoff', 'breaker'])) return false;
  const backoffOk =
    v.backoff === undefined ||
    (isObject(v.backoff) &&
      onlyKeys(v.backoff, ['baseMs', 'maxMs', 'maxRetryAfterMs']) &&
      intIn(v.backoff.baseMs, 1, 60_000) &&
      intIn(v.backoff.maxMs, 1, 600_000) &&
      intIn(v.backoff.maxRetryAfterMs, 0, 3_600_000));
  const breakerOk =
    v.breaker === undefined ||
    (isObject(v.breaker) &&
      onlyKeys(v.breaker, ['enabled', 'failureThreshold', 'cooldownMs']) &&
      (v.breaker.enabled === undefined || typeof v.breaker.enabled === 'boolean') &&
      intIn(v.breaker.failureThreshold, 1, 1000) &&
      intIn(v.breaker.cooldownMs, 100, 3_600_000));
  return backoffOk && breakerOk;
}

export function resolveLlmResilience(
  config: { llmResilience?: unknown } | null | undefined,
): LlmResilience {
  const given = (config?.llmResilience ?? {}) as LlmResilienceInput;
  return {
    backoff: { ...DEFAULT_LLM_RESILIENCE.backoff, ...(given.backoff ?? {}) },
    breaker: { ...DEFAULT_LLM_RESILIENCE.breaker, ...(given.breaker ?? {}) },
  };
}

/** Relâchements pour doctor : le disjoncteur désactivé en est un. */
export function llmResilienceRelaxations(
  config: { llmResilience?: unknown } | null | undefined,
): Array<{ key: string; summary: string }> {
  const r = resolveLlmResilience(config);
  return r.breaker.enabled
    ? []
    : [
        {
          key: 'llmResilience.breaker.enabled',
          summary:
            'llmResilience.breaker.enabled is false: a failing LLM provider is retried on every call instead of failing fast after repeated errors.',
        },
      ];
}

/**
 * Causes stables d'un échec d'appel LLM (`details.causeCode` de LLM_FAILED et dérivés). Le catalogue
 * anglais les rend ; le français reste le texte du noyau. Un code inconnu d'un client plus ancien se
 * rend par repli sur `details.cause`.
 */
export const LLM_CAUSE_CODES = [
  'TRANSPORT',
  'TIMEOUT',
  'HTTP_4XX',
  'HTTP_5XX',
  'TRUNCATED',
  'FILTERED',
  'REFUSED',
  'INVALID_JSON',
  'INVALID_RESPONSE',
] as const;
export type LlmCauseCode = (typeof LLM_CAUSE_CODES)[number];

/** Erreur HTTP/transport d'un appel LLM, avec ce qu'il faut pour décider du retry. */
export class LlmCallError extends Error {
  readonly status: number | null;
  readonly retryAfterMs: number | null;
  readonly retryable: boolean;
  /** Défaut du fournisseur (disponibilité) — compte pour le disjoncteur. */
  readonly providerFault: boolean;
  /** Cause STABLE (contrat `--json`/MCP/dashboard) ; `message` reste le texte français du noyau. */
  readonly causeCode: LlmCauseCode | null;
  /** Précision courte et non sensible de la cause (ex. code réseau `ECONNREFUSED`). */
  readonly causeDetail: string | null;

  constructor(
    message: string,
    {
      status = null,
      retryAfterMs = null,
      retryable,
      providerFault = retryable,
      causeCode = null,
      causeDetail = null,
    }: {
      status?: number | null;
      retryAfterMs?: number | null;
      retryable: boolean;
      providerFault?: boolean;
      causeCode?: LlmCauseCode | null;
      causeDetail?: string | null;
    },
  ) {
    super(message);
    this.name = 'LlmCallError';
    this.status = status;
    this.retryAfterMs = retryAfterMs;
    this.retryable = retryable;
    this.providerFault = providerFault;
    this.causeCode = causeCode;
    this.causeDetail = causeDetail;
  }
}

/** Un statut HTTP est-il retentable ? 408/409/425/429 et tout 5xx sauf 501/505. */
export function isRetryableStatus(status: number): boolean {
  if ([408, 409, 425, 429].includes(status)) return true;
  return status >= 500 && status <= 599 && status !== 501 && status !== 505;
}

/** `Retry-After` : secondes entières ou date HTTP → ms (null si absent/illisible). */
export function parseRetryAfter(
  header: string | null | undefined,
  now = Date.now(),
): number | null {
  if (!header) return null;
  const trimmed = header.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;
  const when = Date.parse(trimmed);
  if (Number.isNaN(when)) return null;
  return Math.max(0, when - now);
}

/** Full jitter : uniforme dans [0, min(maxMs, baseMs·2^(attempt-1))] ; attempt >= 1. */
export function backoffDelay(
  attempt: number,
  { baseMs, maxMs }: { baseMs: number; maxMs: number },
  random: () => number = Math.random,
): number {
  const ceiling = Math.min(maxMs, baseMs * 2 ** Math.max(0, attempt - 1));
  return Math.min(ceiling, Math.floor(random() * (ceiling + 1)));
}

// -------------------------------------------------------------------------
// Disjoncteur
// -------------------------------------------------------------------------

interface BreakerState {
  failures: number;
  openedAt: number | null;
  probing: boolean;
}

const breakers = new Map<string, BreakerState>();

/** Pour les tests. */
export function resetCircuitBreakers(): void {
  breakers.clear();
}

export function breakerKey(provider: string, baseUrl: string): string {
  let host = baseUrl;
  try {
    host = new URL(baseUrl).host;
  } catch {
    // baseUrl non analysable : la valeur brute sert de clé (jamais affichée).
  }
  return `${provider}|${host}`;
}

/**
 * Admet ou refuse un appel. Rend `null` (admis) ou le nombre de ms restant
 * avant la prochaine sonde (circuit ouvert).
 */
export function breakerAdmit(
  key: string,
  cfg: LlmResilience['breaker'],
  now = Date.now(),
): number | null {
  if (!cfg.enabled) return null;
  const state = breakers.get(key);
  if (!state || state.openedAt === null) return null;
  const remaining = state.openedAt + cfg.cooldownMs - now;
  if (remaining > 0) return remaining;
  if (state.probing) return cfg.cooldownMs; // une sonde est déjà en vol
  state.probing = true;
  return null;
}

export function breakerSuccess(key: string): void {
  breakers.delete(key);
}

export function breakerFailure(key: string, cfg: LlmResilience['breaker'], now = Date.now()): void {
  if (!cfg.enabled) return;
  const state = breakers.get(key) ?? { failures: 0, openedAt: null, probing: false };
  state.failures += 1;
  if (state.probing || state.failures >= cfg.failureThreshold) {
    state.openedAt = now;
    state.probing = false;
  }
  breakers.set(key, state);
}

/** Libère une sonde admise dont l'issue n'est pas un verdict sur le fournisseur. */
export function breakerRelease(key: string): void {
  const state = breakers.get(key);
  if (state) state.probing = false;
}

export function circuitOpenError(
  errorCode: string,
  message: string,
  provider: string,
  model: string,
  retryInMs: number,
): StriartError {
  return new StriartError(
    `${message} (${provider}:${model}) : circuit breaker open after repeated provider failures — retry in ${Math.ceil(retryInMs / 1000)} s.`,
    {
      code: errorCode,
      hint: 'striart doctor',
      details: { reason: 'CIRCUIT_OPEN', provider, model, retryInMs },
    },
  );
}

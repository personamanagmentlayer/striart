/** Backoff exponentiel à gigue « équitable » (moitié fixe, moitié aléatoire). */
export interface BackoffOptions {
  initialMs: number;
  maxMs: number;
}

/**
 * Délai avant la tentative n° `attempt` (1 = première reprise).
 * `random` ∈ [0, 1) injectable pour des tests déterministes.
 */
export function backoffDelayMs(
  attempt: number,
  { initialMs, maxMs }: BackoffOptions,
  random: () => number = Math.random,
): number {
  const n = Math.max(1, Math.floor(attempt));
  const exponential = Math.min(maxMs, initialMs * 2 ** Math.min(n - 1, 30));
  const half = exponential / 2;
  return Math.round(half + random() * half);
}

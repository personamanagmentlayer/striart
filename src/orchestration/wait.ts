/**
 * Attentes bornées et interruptibles du lot O : dépendance d'un plan (agent
 * supervisé à attendre), dégagement d'une collision du Router, verdict d'un
 * relecteur humain. Toujours trois issues explicites — jamais d'attente
 * infinie ni de repli silencieux :
 *  - 'ok'      : la condition est vraie ;
 *  - 'timeout' : délai dépassé (l'appelant échoue en fail closed) ;
 *  - 'aborted' : arrêt demandé (Ctrl+C).
 *
 * Aucune attente ne tient de verrou : la condition est relue à chaque tour
 * (lecture d'état brève), l'intervalle est configurable
 * (`orchestration.pollIntervalMs`).
 */
import { setTimeout as sleep } from 'node:timers/promises';

export type WaitOutcome = 'ok' | 'timeout' | 'aborted';

/** Attend `ms` sauf arrêt demandé ; rend false si interrompu. */
export async function sleepAbortable(ms: number, signal: AbortSignal | null): Promise<boolean> {
  if (signal?.aborted) return false;
  try {
    await sleep(ms, undefined, signal ? { signal } : undefined);
    return true;
  } catch (error) {
    if ((error as Error).name === 'AbortError') return false;
    throw error;
  }
}

export async function waitUntil(
  check: () => Promise<boolean>,
  {
    intervalMs,
    timeoutMs,
    signal,
  }: { intervalMs: number; timeoutMs: number; signal: AbortSignal | null },
): Promise<WaitOutcome> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (signal?.aborted) return 'aborted';
    if (await check()) return 'ok';
    const left = deadline - Date.now();
    if (left <= 0) return 'timeout';
    if (!(await sleepAbortable(Math.min(intervalMs, left), signal))) return 'aborted';
  }
}

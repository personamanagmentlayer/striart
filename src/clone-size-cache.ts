/**
 * Cache des tailles de clones (décision D4). La taille est de l'AFFICHAGE : elle
 * n'a pas à être temps réel, mais son âge n'est jamais caché (`computedAt`).
 * Aucune décision de sécurité ne lit ce cache (voir `clone-disk.ts`).
 *
 * Une entrée est servie si elle est plus jeune que `ttlMs` ET (sa signature —
 * l'empreinte des faits qui font varier la taille — est inchangée OU elle est
 * plus jeune que `minRefreshMs`). Ce second terme borne le coût d'un clone
 * dont le disque bouge en continu : au plus un parcours par `minRefreshMs`.
 * Une mesure incomplète n'est jamais mémorisée ; une horloge qui recule
 * invalide l'entrée ; les mesures simultanées d'une même clé sont fusionnées.
 */
export interface SizeMeasure {
  sizeBytes: number;
  complete: boolean;
}

export interface SizeReading {
  sizeBytes: number;
  /** Instant (ms) où la taille a été mesurée — jamais celui de la lecture du cache. */
  computedAt: number;
  cached: boolean;
}

export interface SizeCacheOptions {
  ttlMs: number;
  minRefreshMs: number;
  maxEntries?: number;
  now?: () => number;
}

interface Entry {
  sig: string;
  sizeBytes: number;
  computedAt: number;
}

export interface SizeCache {
  get(key: string, sig: string, measure: () => Promise<SizeMeasure>): Promise<SizeReading>;
  invalidate(key: string): void;
  clear(): void;
  size(): number;
}

export function createSizeCache({
  ttlMs,
  minRefreshMs,
  maxEntries = 256,
  now = () => Date.now(),
}: SizeCacheOptions): SizeCache {
  const entries = new Map<string, Entry>();
  const pending = new Map<string, Promise<SizeReading>>();
  /** Jeton de la mesure en vol : `invalidate` le retire, la mesure tardive n'est alors pas mémorisée. */
  const tokens = new Map<string, object>();

  function fresh(entry: Entry, sig: string): boolean {
    const age = now() - entry.computedAt;
    if (age < 0 || age >= ttlMs) return false;
    return entry.sig === sig || age < minRefreshMs;
  }

  function remember(key: string, entry: Entry): void {
    entries.delete(key);
    entries.set(key, entry);
    while (entries.size > maxEntries) {
      const oldest = entries.keys().next().value;
      if (oldest === undefined) break;
      entries.delete(oldest);
    }
  }

  return {
    async get(key, sig, measure) {
      const hit = entries.get(key);
      if (hit && fresh(hit, sig)) {
        return { sizeBytes: hit.sizeBytes, computedAt: hit.computedAt, cached: true };
      }
      const inFlight = pending.get(key);
      if (inFlight) return inFlight;
      const token = {};
      tokens.set(key, token);
      const run = (async (): Promise<SizeReading> => {
        const startedAt = now();
        const result = await measure();
        if (tokens.get(key) !== token) {
          // Invalidée pendant la mesure (clone supprimé ou recréé) : rendue, jamais mémorisée.
        } else if (result.complete) {
          remember(key, { sig, sizeBytes: result.sizeBytes, computedAt: startedAt });
        } else {
          entries.delete(key);
        }
        return { sizeBytes: result.sizeBytes, computedAt: startedAt, cached: false };
      })().finally(() => {
        if (tokens.get(key) === token) {
          tokens.delete(key);
          pending.delete(key);
        }
      });
      pending.set(key, run);
      return run;
    },
    invalidate(key) {
      entries.delete(key);
      tokens.delete(key);
      pending.delete(key);
    },
    clear() {
      entries.clear();
      tokens.clear();
      pending.clear();
    },
    size() {
      return entries.size;
    },
  };
}

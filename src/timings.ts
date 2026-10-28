/**
 * Durées par phase d'une opération du noyau (merge, resolve --apply, promote, run) — L8.
 *
 * Mesure, pas décision : le résultat d'une opération porte `timings` (ajout additif au `--json`)
 * pour que le gain du Test Gate hors verrou (L9) soit PROUVÉ par un avant/après, pas affirmé.
 *
 * Horloge MONOTONE (`performance.now`), jamais `Date.now` : un saut d'horloge système (NTP, veille)
 * ne doit pas fabriquer une durée négative ou énorme. Aucune donnée utilisateur n'entre ici : des
 * nombres, rien d'autre.
 *
 * Phases (toutes toujours présentes dans le snapshot, 0 quand elles ne s'appliquent pas) :
 *  - `route`     prédiction des fichiers (appel LLM du Router, hors verrou) ;
 *  - `lockWait`  attente du verrou principal (file en mémoire + file inter-process) ;
 *  - `sync`      fetch + rebase de l'agent sur la cible ;
 *  - `merge`     `git merge` et classement des conflits ;
 *  - `semantic`  fusion sémantique (appels LLM du Merger) ;
 *  - `gate`      Test Gate (tous les passages : merge, retries, promotion) ;
 *  - `commit`    commit de merge (hooks de la cible compris) et post-commit ;
 *  - `delivery`  push différé, APRÈS la libération du verrou ;
 *  - `memory`    Memory Layer (résumé LLM, après la libération du verrou) ;
 *  - `lockHeld`  durée pendant laquelle le verrou principal a été TENU (la section critique) ;
 *  - `total`     de l'appel à la réponse.
 * `lockHeld` recouvre sync + merge + semantic + gate + commit (+ le nettoyage de la section) :
 * c'est le chiffre que L9 doit faire chuter.
 */
export const PHASES = [
  'route',
  'lockWait',
  'sync',
  'merge',
  'semantic',
  'gate',
  'commit',
  'delivery',
  'memory',
  'lockHeld',
  'total',
] as const;

export type PhaseName = (typeof PHASES)[number];

export type Timings = { unit: 'ms' } & Record<PhaseName, number>;

/** Arrondi à 0,01 ms : assez fin pour un `git status`, jamais de bruit flottant dans un --json. */
const round = (ms: number): number => Math.round(ms * 100) / 100;

export class PhaseTimer {
  private readonly now: () => number;
  private readonly startedAt: number;
  private readonly durations = new Map<PhaseName, number>();
  /** Phases en cours de mesure : une phase imbriquée dans elle-même n'est pas comptée deux fois. */
  private readonly open = new Set<PhaseName>();

  /** `startedAt` : début réel de l'opération quand des phases l'ont précédée (même horloge). */
  constructor(now: () => number = () => performance.now(), startedAt?: number) {
    this.now = now;
    this.startedAt = startedAt ?? now();
  }

  /** Ajoute une durée (ms). Les valeurs non finies ou négatives sont ignorées (jamais de NaN en JSON). */
  add(phase: PhaseName, ms: number): void {
    if (!Number.isFinite(ms) || ms < 0) return;
    this.durations.set(phase, (this.durations.get(phase) ?? 0) + ms);
  }

  /**
   * Mesure `fn` dans `phase` — y compris quand elle throw (la durée d'un échec est une donnée) —
   * puis propage son résultat ou son erreur. Une imbrication de la MÊME phase court sans re-mesure.
   */
  async measure<T>(phase: PhaseName, fn: () => Promise<T> | T): Promise<T> {
    if (this.open.has(phase)) return fn();
    this.open.add(phase);
    const started = this.now();
    try {
      return await fn();
    } finally {
      this.open.delete(phase);
      this.add(phase, this.now() - started);
    }
  }

  snapshot(): Timings {
    const out = { unit: 'ms' } as Timings;
    for (const phase of PHASES) out[phase] = round(this.durations.get(phase) ?? 0);
    out.total = round(this.now() - this.startedAt);
    return out;
  }
}

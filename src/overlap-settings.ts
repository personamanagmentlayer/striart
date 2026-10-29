/**
 * Réglages du filet à l'exécution (`config.overlap`, voir overlap.ts). Module FEUILLE :
 * `config.js` le charge pour valider la clé sans importer git, le clone ni le bus.
 */

export interface OverlapSettings {
  /** Observer les chevauchements (false : relâchement EXPLICITE, affiché par `doctor`). */
  enabled: boolean;
  /** Rebase anticipé de l'agent concerné par un chevauchement avec la cible (jamais sur une session vivante). */
  autoSync: boolean;
  /** Appels git maximum par cycle d'observation (le reste est différé et déclaré). */
  maxGitCalls: number;
  /** Fichiers retenus par agent (au-delà : `truncated`, jamais un silence). */
  maxFilesPerAgent: number;
  /** Fichiers listés par chevauchement (le total reste dans `fileCount`). */
  maxFilesPerOverlap: number;
}

export type OverlapSettingsInput = Partial<OverlapSettings>;

export const DEFAULT_OVERLAP_SETTINGS: Readonly<OverlapSettings> = Object.freeze({
  enabled: true,
  autoSync: true,
  maxGitCalls: 64,
  maxFilesPerAgent: 5000,
  maxFilesPerOverlap: 50,
});

const KEYS = Object.keys(DEFAULT_OVERLAP_SETTINGS);
const intIn = (x: unknown, min: number, max: number) =>
  x === undefined || (Number.isInteger(x) && (x as number) >= min && (x as number) <= max);
const boolOrUndef = (x: unknown) => x === undefined || typeof x === 'boolean';

/** Validation de `config.overlap` (objet PARTIEL ; clé inconnue refusée : une faute de frappe sur un garde-fou ne passe pas). */
export function isValidOverlapSettings(v: unknown): boolean {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  const o = v as Record<string, unknown>;
  return (
    Object.keys(o).every((k) => KEYS.includes(k)) &&
    boolOrUndef(o.enabled) &&
    boolOrUndef(o.autoSync) &&
    intIn(o.maxGitCalls, 4, 1024) &&
    intIn(o.maxFilesPerAgent, 10, 100_000) &&
    intIn(o.maxFilesPerOverlap, 1, 500)
  );
}

export function resolveOverlapSettings(
  config: { overlap?: unknown } | null | undefined,
): OverlapSettings {
  return { ...DEFAULT_OVERLAP_SETTINGS, ...((config?.overlap ?? {}) as OverlapSettingsInput) };
}

/** Relâchement : ne plus observer laisse le Router seul juge des chevauchements. */
export function overlapRelaxations(
  config: { overlap?: unknown } | null | undefined,
): Array<{ key: string; summary: string }> {
  if (resolveOverlapSettings(config).enabled) return [];
  return [
    {
      key: 'overlap.enabled',
      summary:
        'overlap.enabled is false: no runtime net — a file two agents really touch (or that the target branch advanced under an agent) is only caught by the Router prediction, then by the merge and the Test Gate.',
    },
  ];
}

/**
 * Estimateur local de jetons — sans dépendance, CONSERVATEUR et calibré.
 *
 * Aucun tokenizer fournisseur n'est embarqué (chacun a le sien, ils évoluent,
 * et l'API de comptage d'Anthropic exige le réseau et une clé) : on estime
 * par « caractères effectifs » (un caractère non ASCII compte pour trois
 * ASCII : CJK, emoji et accents consomment plus de jetons par caractère),
 * divisés par un ratio caractères/jeton, puis multipliés par une marge.
 *
 * Le ratio initial est BAS (3 caractères/jeton : le code et le JSON
 * consomment plus que la prose) ; il est ensuite calibré par couple
 * fournisseur:modèle sur l'usage RÉEL déjà relevé (`calibrateFromRecords`,
 * moyenne mobile exponentielle bornée). Une sous-estimation laisserait passer
 * un appel au-dessus d'un plafond : l'erreur tolérée va toujours dans le
 * sens de la surestimation.
 */
import type { UsageRecord } from '../types.js';

/** Poids d'un caractère non ASCII, en caractères ASCII équivalents. */
const NON_ASCII_WEIGHT = 3;
/** Bornes du ratio calibré : au-delà, l'observation est jugée aberrante. */
const MIN_RATIO = 1.2;
const MAX_RATIO = 6;
const EWMA_ALPHA = 0.25;
/** Fenêtre de calibration : derniers relevés API retenus par modèle. */
const CALIBRATION_WINDOW = 60;

/** Caractères effectifs d'un texte (ASCII = 1, autre = NON_ASCII_WEIGHT). */
export function effectiveChars(text: string): number {
  let ascii = 0;
  let other = 0;
  for (let i = 0; i < text.length; i += 1) {
    if (text.charCodeAt(i) < 128) ascii += 1;
    else other += 1;
  }
  return ascii + other * NON_ASCII_WEIGHT;
}

export interface EstimatorOptions {
  /** Ratio caractères/jeton (défaut config : 3, ou calibré). */
  charsPerToken: number;
  /** Marge de prudence (>= 1). */
  safetyFactor: number;
}

export function estimateFromEffectiveChars(chars: number, options: EstimatorOptions): number {
  if (chars <= 0) return 0;
  return Math.ceil((chars / options.charsPerToken) * options.safetyFactor);
}

/** Jetons estimés d'un texte (au moins 1 pour un texte non vide). */
export function estimateTokens(text: string, options: EstimatorOptions): number {
  if (text.length === 0) return 0;
  return Math.max(1, estimateFromEffectiveChars(effectiveChars(text), options));
}

/** Clé de calibration : un ratio par couple fournisseur:modèle. */
export function calibrationKey(provider: string | null, model: string | null): string {
  return `${provider ?? '?'}:${model ?? '?'}`;
}

/**
 * Ratios caractères/jeton observés, par couple fournisseur:modèle, depuis des
 * relevés RÉELS (source 'api', entrée > 0, `promptChars` connu). Les relevés
 * arrivent dans l'ordre chronologique ; seuls les plus récents comptent.
 * Un ratio est ramené dans [MIN_RATIO, MAX_RATIO] puis plafonné par le ratio
 * de départ × 1,5 : jamais plus optimiste que 1,5× le défaut prudent.
 */
export function calibrateFromRecords(
  records: readonly UsageRecord[],
  defaultRatio: number,
): Map<string, number> {
  const byKey = new Map<string, number[]>();
  for (const r of records) {
    if (r.source !== 'api' || r.estimated || !r.promptChars || r.promptChars <= 0) continue;
    const input = (r.input ?? 0) + (r.cacheRead ?? 0) + (r.cacheWrite ?? 0);
    if (input <= 0) continue;
    const list = byKey.get(calibrationKey(r.provider, r.model)) ?? [];
    list.push(r.promptChars / input);
    byKey.set(calibrationKey(r.provider, r.model), list);
  }
  const ceiling = defaultRatio * 1.5;
  const out = new Map<string, number>();
  for (const [key, samples] of byKey) {
    const recent = samples.slice(-CALIBRATION_WINDOW);
    let ewma = recent[0];
    for (let i = 1; i < recent.length; i += 1)
      ewma = EWMA_ALPHA * recent[i] + (1 - EWMA_ALPHA) * ewma;
    out.set(key, Math.min(ceiling, Math.max(MIN_RATIO, Math.min(MAX_RATIO, ewma))));
  }
  return out;
}

/** Aides de présentation. Chaque libellé est un littéral l10n.t() complet (extractible). */

/** Choisit la forme singulière ou plurale (le catalogue gère chaque forme, pas une règle ICU). */
export function plural(count: number, one: string, other: string): string {
  return count === 1 ? one : other;
}

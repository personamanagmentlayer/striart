/**
 * Mise en page adaptative d'un tableau : quelles colonnes restent, quelle
 * largeur chacune prend. Fonction pure, partagée par `Output.table` (sortie
 * non interactive) et le cockpit `watch --ui` — UNE seule règle de repli, pour
 * que `striart status` et l'écran du watcher se dégradent de la même façon.
 */

export interface ColumnSpec {
  /** Plus la priorité est haute, plus la colonne résiste au manque de largeur (défaut 1). */
  priority?: number;
  /** Colonne compressible (ellipse) jusqu'à `min` colonnes, plutôt que retirée. */
  shrink?: { min: number };
}

export interface ColumnLayout {
  /** Indices des colonnes conservées, dans l'ordre d'origine. */
  visible: number[];
  /** Largeur de chaque colonne (indexée comme l'entrée, y compris les retirées). */
  widths: number[];
}

/**
 * Les colonnes sont sacrifiées de la MOINS importante à la plus importante :
 * chacune est d'abord compressée (si elle l'accepte), puis retirée si ça ne
 * suffit pas. Une colonne secondaire disparaît donc avant qu'une colonne
 * importante ne soit tronquée. La première colonne (l'identifiant de la
 * ligne) n'est jamais retirée. `limit === null` : pas de limite.
 */
export function layoutColumns(
  specs: ColumnSpec[],
  natural: number[],
  limit: number | null,
  gap = 2,
): ColumnLayout {
  let visible = specs.map((_, i) => i);
  const widths = [...natural];
  const total = () => visible.reduce((sum, i) => sum + widths[i], 0) + gap * (visible.length - 1);
  if (limit !== null) {
    const byPriority = [...visible]
      .slice(1)
      .sort((a, b) => (specs[a].priority ?? 1) - (specs[b].priority ?? 1));
    for (const i of byPriority) {
      if (total() <= limit) break;
      const shrink = specs[i].shrink;
      if (shrink) widths[i] = Math.max(shrink.min, widths[i] - (total() - limit));
      if (total() > limit) visible = visible.filter((v) => v !== i);
    }
  }
  return { visible, widths };
}

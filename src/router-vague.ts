/**
 * Détection des tâches VAGUES ou TRANSVERSES.
 *
 * Une prédiction de fichiers hasardeuse est pire qu'aucune : elle laisse croire
 * que la tâche est isolée. Quand les signaux convergent vers « je ne sais pas
 * où ça se passe » ou « ça touche tout », le Router préfère la sérialisation
 * prudente (sentinelle WHOLE_REPO : la tâche attend les agents actifs) à un
 * pari — le chemin sûr quand il ne sait pas, comme pour le budget épuisé.
 *
 * Signaux (chacun désactivable, seuils configurables) :
 *  - confiance globale du LLM basse, ou portée « broad » déclarée ;
 *  - trop de fichiers retenus (tâche transverse) ;
 *  - verbes/expressions transverses dans la demande (refactor, renommer,
 *    migrer, partout, tous les…) ;
 *  - aucune prédiction exploitable.
 */
export interface VagueSettings {
  enabled: boolean;
  minConfidence: number;
  maxFiles: number | null;
  verbs: boolean;
}

export interface VagueInput {
  task: string;
  /** Nombre de fichiers retenus par le LLM (avant expansion). */
  fileCount: number;
  /** Confiance globale du LLM, null si non fournie (prompt historique). */
  confidence: number | null;
  scope: 'narrow' | 'broad' | null;
  settings: VagueSettings;
}

/** Racines (sans accents) de verbes/expressions de portée transverse, FR et EN. */
const SWEEPING =
  /\b(refactor\w*|refonte\w*|refondre|renomm\w*|rename\w*|migr\w*|partout|globalement|globale?s?\b|(?:tous|toutes) (?:les|le|la)\b|l'ensemble|ensemble du|everywhere|across the|all the|codebase|monorepo|harmonis\w*|uniformis\w*|generalis\w*|systematiq\w*|remplacer? (?:tous|toutes|partout))/i;

function fold(text: string): string {
  return text.normalize('NFD').replace(/[̀-ͯ]/g, '');
}

export function sweepingVerb(task: string): string | null {
  const m = SWEEPING.exec(fold(task));
  return m ? m[0].toLowerCase() : null;
}

/** Raisons de traiter la tâche comme vague (liste vide = prédiction exploitable). */
export function vagueReasons(input: VagueInput): string[] {
  const { settings: s } = input;
  if (!s.enabled) return [];
  const reasons: string[] = [];
  if (input.fileCount === 0) reasons.push('empty-prediction');
  if (input.scope === 'broad') reasons.push('scope-broad');
  if (input.confidence !== null && input.confidence < s.minConfidence) {
    reasons.push(`low-confidence:${input.confidence.toFixed(2)}`);
  }
  if (s.maxFiles !== null && input.fileCount > s.maxFiles) {
    reasons.push(`many-files:${input.fileCount}`);
  }
  if (s.verbs) {
    const verb = sweepingVerb(input.task);
    if (verb) reasons.push(`sweeping-verb:${verb}`);
  }
  return reasons;
}

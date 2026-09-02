import { parse } from 'yaml';
import { StriartError } from './errors.js';
import type { PlanTask, StriartPlan } from './types.js';

/**
 * Format « tâches-as-code » — inspiré de Bruno (collections d'API en fichiers
 * texte co-localisés au repo, versionnés, diffés, revus en PR).
 *
 * Un PLAN est un fichier YAML qui déclare un graphe de tâches et leurs
 * dépendances. Deux principes non négociables :
 *
 *  1. **C'est de la DONNÉE, jamais du code.** Pas de `.mjs` exécutable : un
 *     plan est fait pour circuler (commit, PR, partage), l'exécuter serait la
 *     même faille que la config-as-code. Le prompt reste de la donnée
 *     (substitué en argv, jamais un shell) ; une tâche autonome référence un
 *     `profile` défini par l'admin en config, pas une commande arbitraire.
 *  2. **Aucune sémantique d'exécution nouvelle.** `apply` équivaut à la
 *     séquence de `striart run` que le plan décrit, `id` de plan résolus en
 *     noms d'agents pour `--after`. Le plan est du sucre git-persistant sur
 *     des commandes `run` : il compose la file, `--after` et `reconcile`, il
 *     ne les double pas.
 *
 * Contrat de format (`version: 1`) :
 *
 *   version: 1
 *   tasks:
 *     - id: schema                 # optionnel — alias local, cible d'un `after`
 *       prompt: |                  # OBLIGATOIRE (multi-ligne bienvenu)
 *         Ajoute une colonne jwt_version à la table users.
 *       agent: db-schema           # optionnel — dérivé du prompt si absent
 *     - id: auth
 *       prompt: Passe l'auth en JWT.
 *       after: schema              # dépend de la tâche `schema` (définie AVANT)
 *       autonomous: true           # défaut false (supervisé)
 *       profile: claude            # avec autonomous : profil d'invocation
 *       timeout: 900000            # avec autonomous : délai max (ms)
 *
 * Premier module TypeScript du dépôt (pilote de migration) : exécuté par le
 * type stripping natif de Node, sans étape de build.
 */

const OPTIONAL_STRINGS = ['id', 'agent', 'profile', 'command', 'after'] as const;

/**
 * Parse et valide un plan YAML. Ne produit AUCUN effet de bord : la validation
 * complète tombe avant toute application, pour que `--dry-run` puisse tout
 * vérifier et qu'une erreur de structure n'applique jamais un plan à moitié.
 */
export function parsePlan(text: string): StriartPlan {
  let doc: unknown;
  try {
    doc = parse(text);
  } catch (error) {
    throw new StriartError(`Plan illisible (YAML invalide) : ${(error as Error).message}`, {
      code: 'PLAN_INVALID',
    });
  }
  return validatePlan(doc);
}

/**
 * Valide un plan déjà désérialisé. Séparée de `parsePlan` pour être testable
 * sans passer par YAML.
 */
export function validatePlan(doc: unknown): StriartPlan {
  if (typeof doc !== 'object' || doc === null || Array.isArray(doc)) {
    throw invalid('le plan doit être un objet YAML (version + tasks).');
  }
  const plan = doc as Record<string, unknown>;
  if (plan.version !== 1) {
    throw invalid(`version de plan non supportée : ${JSON.stringify(plan.version)} (attendu : 1).`);
  }
  if (!Array.isArray(plan.tasks) || plan.tasks.length === 0) {
    throw invalid('"tasks" doit être une liste non vide.');
  }

  const ids = new Set<string>();
  const tasks: PlanTask[] = [];

  // Entrée externe (YAML) : chaque champ est de type `unknown`, verrouillé
  // au type attendu champ à champ. `asString` renvoie la chaîne ou null —
  // aucun `any`, le compilateur suit le contrat de bout en bout.
  const asString = (v: unknown): string | null => (typeof v === 'string' ? v : null);

  (plan.tasks as unknown[]).forEach((item, i) => {
    const label = asString((item as Record<string, unknown> | null)?.id);
    const where = `tâche #${i + 1}${label ? ` (${label})` : ''}`;
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      throw invalid(`${where} : chaque entrée de "tasks" doit être un objet.`);
    }
    const raw = item as Record<string, unknown>;
    if (typeof raw.prompt !== 'string' || raw.prompt.trim().length === 0) {
      throw invalid(`${where} : "prompt" est obligatoire et ne peut pas être vide.`);
    }
    for (const key of OPTIONAL_STRINGS) {
      const val = raw[key];
      if (val != null && (typeof val !== 'string' || val.trim().length === 0)) {
        throw invalid(`${where} : "${key}" doit être une chaîne non vide si présent.`);
      }
    }
    if (raw.autonomous != null && typeof raw.autonomous !== 'boolean') {
      throw invalid(`${where} : "autonomous" doit être un booléen.`);
    }
    if (
      raw.timeout != null &&
      (typeof raw.timeout !== 'number' || !Number.isInteger(raw.timeout) || raw.timeout < 1000)
    ) {
      throw invalid(`${where} : "timeout" doit être un entier de millisecondes ≥ 1000.`);
    }
    const id = asString(raw.id);
    if (id != null) {
      if (ids.has(id)) throw invalid(`${where} : id en double "${id}".`);
      ids.add(id);
    }
    tasks.push({
      id,
      agent: asString(raw.agent),
      prompt: raw.prompt,
      autonomous: raw.autonomous === true,
      profile: asString(raw.profile),
      command: asString(raw.command),
      timeout: typeof raw.timeout === 'number' ? raw.timeout : null,
      after: asString(raw.after),
    });
  });

  // Les `after` qui désignent un id de plan doivent pointer une tâche définie
  // AVANT. Contrainte simple et enseignable (comme une déclaration de
  // variable), et surtout : un graphe où toute arête va vers l'arrière est
  // acyclique PAR CONSTRUCTION — aucun cycle interne possible. Un `after` qui
  // ne désigne aucun id de plan est une référence d'exécution (agent/tâche
  // déjà vivant), laissée à la validation runtime de runTask (AFTER_UNKNOWN).
  const seen = new Set<string>();
  for (const task of tasks) {
    if (task.after && ids.has(task.after) && !seen.has(task.after)) {
      throw invalid(
        `tâche${task.id ? ` (${task.id})` : ''} : "after: ${task.after}" référence une tâche définie APRÈS. ` +
          'Une dépendance doit précéder la tâche qui en dépend (garantit un graphe acyclique).',
      );
    }
    if (task.id) seen.add(task.id);
  }

  return { version: 1, tasks };
}

function invalid(message: string): StriartError {
  return new StriartError(`Plan invalide : ${message}`, { code: 'PLAN_INVALID' });
}

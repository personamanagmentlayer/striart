/**
 * Schéma du plan `version: 2` (lot O, décision O1) — validation POSITIVE.
 *
 * Toute clé inconnue est refusée, toute valeur hors liste aussi : un plan v2
 * circule (PR, partage) et une faute de frappe (« mdoe: parallel ») ne doit
 * jamais laisser s'appliquer un comportement que son auteur n'a pas écrit.
 * La validation est complète AVANT tout effet de bord (`--dry-run` inclus),
 * et chaque refus porte une raison stable (`details.reason`, traduite dans
 * PLAN_REASONS de src/cli/i18n/en.ts) avec la position de la tâche.
 *
 * Les valeurs non précisées restent `null` : elles sont résolues à
 * l'exécution par les réglages (`orchestration.*`), pour qu'un changement de
 * défaut en config s'applique aux plans existants.
 */
import { AGENT_NAME_RE } from '../agent-name.ts';
import { StriartError } from '../errors.ts';
import { isExecutableName } from '../plan-command.ts';
import { MAX_TIMER_MS } from '../timer-limits.ts';
import { protectedPatternProblem } from '../protected-paths.ts';
import { ROLE_NAME_RE } from '../collab/message.ts';
import type {
  PlanAgentSpec,
  PlanNode,
  PlanReviewerSpec,
  PlanRoleSpec,
  PlanStepSpec,
  StriartPlanV2,
} from '../types.js';

type Rec = Record<string, unknown>;

const PLAN_KEYS = ['version', 'mode', 'concurrency', 'onFailure', 'tasks'];
const COMMON_KEYS = ['id', 'mode', 'agent', 'after', 'resources'];
const NODE_KEYS: Record<PlanNode['kind'], string[]> = {
  task: ['prompt', 'autonomous', 'profile', 'command', 'timeout'],
  review: ['prompt', 'author', 'reviewers', 'quorum', 'maxRounds'],
  pipeline: ['handoff', 'steps'],
  race: ['prompt', 'candidates', 'pick', 'losers'],
  team: ['prompt', 'cadence', 'rounds', 'roles'],
};
const KINDS = Object.keys(NODE_KEYS) as PlanNode['kind'][];

export const PLAN_LIMITS = Object.freeze({
  reviewers: 5,
  candidates: 10,
  roles: 8,
  steps: 10,
  rounds: 10,
  concurrency: 64,
  /** Un nom dérivé (`<agent>-<étape>`, `<agent>-<n>`) doit rester un nom d'agent valide. */
  derivedAgentMax: 30,
  /** Ressources hors-Git déclarées par un nœud (lot O, priorité 4) — borné contre un plan abusif. */
  resources: 10,
  resourceNameMax: 80,
});

/** Rôles réservés : l'auteur d'un review et Striart lui-même. */
const RESERVED_ROLES = new Set(['author', 'striart']);

function invalid(message: string, details: Rec): StriartError {
  return new StriartError(`Plan invalide : ${message}`, {
    code: 'PLAN_INVALID',
    hint: 'striart plan <fichier> --dry-run',
    details,
  });
}

const isObject = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v);
const nonEmptyString = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;

export function validatePlanV2(plan: Rec): StriartPlanV2 {
  const unknownTop = Object.keys(plan).find((k) => !PLAN_KEYS.includes(k));
  if (unknownTop) {
    throw invalid(`clé inconnue "${unknownTop}".`, {
      reason: 'UNKNOWN_KEY',
      field: unknownTop.slice(0, 40),
    });
  }
  if (plan.mode !== undefined && plan.mode !== 'sequential' && plan.mode !== 'parallel') {
    throw invalid('"mode" doit valoir sequential ou parallel.', { reason: 'MODE_INVALID' });
  }
  if (
    plan.concurrency !== undefined &&
    (!Number.isInteger(plan.concurrency) ||
      (plan.concurrency as number) < 1 ||
      (plan.concurrency as number) > PLAN_LIMITS.concurrency)
  ) {
    throw invalid(`"concurrency" doit être un entier de 1 à ${PLAN_LIMITS.concurrency}.`, {
      reason: 'CONCURRENCY_INVALID',
      max: PLAN_LIMITS.concurrency,
    });
  }
  if (
    plan.onFailure !== undefined &&
    plan.onFailure !== 'stop' &&
    plan.onFailure !== 'skip-dependents'
  ) {
    throw invalid('"onFailure" doit valoir stop ou skip-dependents.', {
      reason: 'ON_FAILURE_INVALID',
    });
  }
  if (!Array.isArray(plan.tasks) || plan.tasks.length === 0) {
    throw invalid('"tasks" doit être une liste non vide.', { reason: 'TASKS_EMPTY' });
  }

  const ids = new Set<string>();
  const tasks: PlanNode[] = [];
  (plan.tasks as unknown[]).forEach((item, i) => {
    tasks.push(validateNode(item, i, ids));
  });

  // Dépendances vers l'ARRIÈRE seulement (graphe acyclique par construction,
  // comme en v1) ; une référence qui ne désigne aucun id de plan est une
  // référence d'exécution (agent/tâche vivant), attendue à l'application.
  const seen = new Set<string>();
  for (const node of tasks) {
    for (const ref of node.after) {
      if (ids.has(ref) && !seen.has(ref)) {
        throw invalid(
          `tâche${node.id ? ` (${node.id})` : ''} : "after: ${ref}" référence une tâche définie APRÈS (ou elle-même).`,
          { reason: 'AFTER_FORWARD', taskId: node.id, after: ref },
        );
      }
    }
    if (node.id) seen.add(node.id);
  }

  return {
    version: 2,
    mode: (plan.mode as StriartPlanV2['mode']) ?? 'sequential',
    concurrency: (plan.concurrency as number | undefined) ?? null,
    onFailure: (plan.onFailure as StriartPlanV2['onFailure'] | undefined) ?? null,
    tasks,
  };
}

function validateNode(item: unknown, i: number, ids: Set<string>): PlanNode {
  const label = isObject(item) && typeof item.id === 'string' ? item.id : null;
  const at = { task: i + 1, taskId: label };
  const where = `tâche #${i + 1}${label ? ` (${label})` : ''}`;
  if (!isObject(item)) {
    throw invalid(`${where} : chaque entrée de "tasks" doit être un objet.`, {
      reason: 'TASK_NOT_AN_OBJECT',
      ...at,
    });
  }
  const kind = (item.mode ?? 'task') as PlanNode['kind'];
  if (typeof kind !== 'string' || !KINDS.includes(kind)) {
    throw invalid(`${where} : mode de tâche inconnu ${JSON.stringify(item.mode)}.`, {
      reason: 'KIND_UNKNOWN',
      kind: String(JSON.stringify(item.mode)).slice(0, 40),
      ...at,
    });
  }
  if (kind === 'pipeline' && item.prompt !== undefined) {
    throw invalid(`${where} : un pipeline n'a pas de "prompt" (chaque étape a le sien).`, {
      reason: 'PROMPT_FORBIDDEN',
      ...at,
    });
  }
  const allowed = [...COMMON_KEYS, ...NODE_KEYS[kind]];
  const unknown = Object.keys(item).find((k) => !allowed.includes(k));
  if (unknown) {
    throw invalid(`${where} : clé inconnue "${unknown}" pour le mode ${kind}.`, {
      reason: 'UNKNOWN_KEY',
      field: unknown.slice(0, 40),
      ...at,
    });
  }

  const optString = (key: string): string | null => {
    const v = item[key];
    if (v === undefined || v === null) return null;
    if (!nonEmptyString(v)) {
      throw invalid(`${where} : "${key}" doit être une chaîne non vide si présent.`, {
        reason: 'FIELD_NOT_STRING',
        field: key,
        ...at,
      });
    }
    return v;
  };
  const id = optString('id');
  if (id !== null) {
    if (ids.has(id))
      throw invalid(`${where} : id en double "${id}".`, { reason: 'DUPLICATE_ID', id, ...at });
    ids.add(id);
  }
  const agent = optString('agent');
  const derivesNames = kind === 'pipeline' || kind === 'race';
  if (
    agent !== null &&
    (!AGENT_NAME_RE.test(agent) || (derivesNames && agent.length > PLAN_LIMITS.derivedAgentMax))
  ) {
    throw invalid(`${where} : "agent" n'est pas un nom d'agent valide.`, {
      reason: 'AGENT_INVALID',
      max: derivesNames ? PLAN_LIMITS.derivedAgentMax : 64,
      ...at,
    });
  }
  const after = parseAfter(item.after, where, at);
  const resources = parseResources(item.resources, where, at);
  const base = { id, agent, after, resources };

  const requirePrompt = (): string => {
    if (!nonEmptyString(item.prompt)) {
      throw invalid(`${where} : "prompt" est obligatoire et ne peut pas être vide.`, {
        reason: 'PROMPT_MISSING',
        ...at,
      });
    }
    return item.prompt;
  };
  const timeoutOf = (v: unknown, field: string): number | null => {
    if (v === undefined || v === null) return null;
    if (!Number.isInteger(v) || (v as number) < 1000 || (v as number) > MAX_TIMER_MS) {
      throw invalid(
        `${where} : "${field}" doit être un entier de millisecondes compris entre 1000 et ${MAX_TIMER_MS}.`,
        {
          reason: 'TIMEOUT_INVALID',
          field,
          ...at,
        },
      );
    }
    return v as number;
  };
  const roundsOf = (field: string): number | null => {
    const v = item[field];
    if (v === undefined || v === null) return null;
    if (!Number.isInteger(v) || (v as number) < 1 || (v as number) > PLAN_LIMITS.rounds) {
      throw invalid(`${where} : "${field}" doit être un entier de 1 à ${PLAN_LIMITS.rounds}.`, {
        reason: 'ROUNDS_INVALID',
        field,
        max: PLAN_LIMITS.rounds,
        ...at,
      });
    }
    return v as number;
  };
  const choice = <T extends string>(
    field: string,
    values: readonly T[],
    reason: string,
  ): T | null => {
    const v = item[field];
    if (v === undefined || v === null) return null;
    if (typeof v !== 'string' || !(values as readonly string[]).includes(v)) {
      throw invalid(`${where} : "${field}" doit valoir ${values.join(', ')}.`, { reason, ...at });
    }
    return v as T;
  };
  const specOf = (v: unknown, keys: string[], what: string): Rec => {
    if (!isObject(v)) {
      throw invalid(`${where} : chaque ${what} doit être un objet.`, {
        reason: 'SPEC_NOT_AN_OBJECT',
        field: what,
        ...at,
      });
    }
    const bad = Object.keys(v).find((k) => !keys.includes(k));
    if (bad) {
      throw invalid(`${where} : clé inconnue "${bad}" dans ${what}.`, {
        reason: 'UNKNOWN_KEY',
        field: bad.slice(0, 40),
        ...at,
      });
    }
    for (const k of ['profile', 'prompt', 'name', 'id']) {
      if (v[k] !== undefined && v[k] !== null && !nonEmptyString(v[k])) {
        throw invalid(`${where} : "${k}" (${what}) doit être une chaîne non vide.`, {
          reason: 'FIELD_NOT_STRING',
          field: k,
          ...at,
        });
      }
    }
    return v;
  };
  const agentSpec = (v: unknown, what: string): PlanAgentSpec => {
    const s = specOf(v ?? {}, ['profile', 'timeout'], what);
    return {
      profile: (s.profile as string | undefined) ?? null,
      timeout: timeoutOf(s.timeout, `${what}.timeout`),
    };
  };
  const roleName = (name: unknown, fallback: string | null, seen: Set<string>): string => {
    const value = name ?? fallback;
    if (typeof value !== 'string' || !ROLE_NAME_RE.test(value)) {
      throw invalid(
        `${where} : nom de rôle invalide ${JSON.stringify(value)} (minuscules, chiffres, tirets).`,
        {
          reason: 'NAME_INVALID',
          ...at,
        },
      );
    }
    if (RESERVED_ROLES.has(value)) {
      throw invalid(`${where} : le nom "${value}" est réservé.`, {
        reason: 'NAME_RESERVED',
        name: value,
        ...at,
      });
    }
    if (seen.has(value)) {
      throw invalid(`${where} : nom en double "${value}".`, {
        reason: 'NAME_DUPLICATE',
        name: value,
        ...at,
      });
    }
    seen.add(value);
    return value;
  };

  if (kind === 'task') {
    const prompt = requirePrompt();
    if (item.autonomous !== undefined && typeof item.autonomous !== 'boolean') {
      throw invalid(`${where} : "autonomous" doit être un booléen.`, {
        reason: 'AUTONOMOUS_NOT_BOOLEAN',
        ...at,
      });
    }
    const autonomous = item.autonomous === true;
    const profile = optString('profile');
    const command = optString('command');
    if (command !== null && !isExecutableName(command)) {
      throw invalid(
        `${where} : "command" doit être un nom d'exécutable (sans chemin, espace ni option).`,
        { reason: 'COMMAND_NOT_AN_EXECUTABLE_NAME', ...at },
      );
    }
    if (autonomous && command !== null) {
      throw invalid(
        `${where} : "command" (outil supervisé) est incompatible avec autonomous: true.`,
        {
          reason: 'COMMAND_AUTONOMOUS_CONFLICT',
          ...at,
        },
      );
    }
    if (!autonomous && profile !== null) {
      throw invalid(`${where} : "profile" n'a de sens qu'avec autonomous: true.`, {
        reason: 'PROFILE_NEEDS_AUTONOMOUS',
        ...at,
      });
    }
    const timeout = timeoutOf(item.timeout, 'timeout');
    if (!autonomous && timeout !== null) {
      throw invalid(`${where} : "timeout" n'a de sens qu'avec autonomous: true.`, {
        reason: 'PROFILE_NEEDS_AUTONOMOUS',
        field: 'timeout',
        ...at,
      });
    }
    return { ...base, kind, prompt, autonomous, profile, command, timeout };
  }

  if (kind === 'review') {
    const prompt = requirePrompt();
    if (!Array.isArray(item.reviewers) || item.reviewers.length === 0) {
      throw invalid(`${where} : "reviewers" doit lister au moins un relecteur.`, {
        reason: 'REVIEWERS_MISSING',
        ...at,
      });
    }
    if (item.reviewers.length > PLAN_LIMITS.reviewers) {
      throw invalid(`${where} : ${PLAN_LIMITS.reviewers} relecteurs au plus.`, {
        reason: 'REVIEWERS_TOO_MANY',
        max: PLAN_LIMITS.reviewers,
        ...at,
      });
    }
    const names = new Set<string>();
    const reviewers: PlanReviewerSpec[] = item.reviewers.map((r: unknown, n: number) => {
      const s = specOf(r, ['name', 'profile', 'timeout', 'prompt', 'human'], 'reviewer');
      if (s.human !== undefined && typeof s.human !== 'boolean') {
        throw invalid(`${where} : "human" doit être un booléen.`, {
          reason: 'FIELD_NOT_BOOLEAN',
          field: 'human',
          ...at,
        });
      }
      const human = s.human === true;
      if (human && (s.profile !== undefined || s.timeout !== undefined)) {
        throw invalid(`${where} : un relecteur humain n'a ni "profile" ni "timeout".`, {
          reason: 'HUMAN_REVIEWER_PROFILE',
          ...at,
        });
      }
      return {
        name: roleName(s.name, `reviewer-${n + 1}`, names),
        kind: human ? 'human' : 'agent',
        profile: (s.profile as string | undefined) ?? null,
        timeout: timeoutOf(s.timeout, 'reviewer.timeout'),
        prompt: (s.prompt as string | undefined) ?? null,
      };
    });
    return {
      ...base,
      kind,
      prompt,
      author: agentSpec(item.author, 'author'),
      reviewers,
      quorum: choice('quorum', ['all', 'any', 'majority'] as const, 'QUORUM_INVALID'),
      maxRounds: roundsOf('maxRounds'),
    };
  }

  if (kind === 'pipeline') {
    if (!Array.isArray(item.steps) || item.steps.length < 2) {
      throw invalid(`${where} : un pipeline compte au moins 2 étapes ("steps").`, {
        reason: 'STEPS_MISSING',
        ...at,
      });
    }
    if (item.steps.length > PLAN_LIMITS.steps) {
      throw invalid(`${where} : ${PLAN_LIMITS.steps} étapes au plus.`, {
        reason: 'STEPS_TOO_MANY',
        max: PLAN_LIMITS.steps,
        ...at,
      });
    }
    const stepIds = new Set<string>();
    const steps: PlanStepSpec[] = item.steps.map((st: unknown) => {
      const s = specOf(st, ['id', 'prompt', 'profile', 'timeout'], 'step');
      if (typeof s.id !== 'string' || !ROLE_NAME_RE.test(s.id) || RESERVED_ROLES.has(s.id)) {
        throw invalid(`${where} : chaque étape a un "id" (minuscules, chiffres, tirets).`, {
          reason: 'STEP_ID_INVALID',
          ...at,
        });
      }
      if (stepIds.has(s.id)) {
        throw invalid(`${where} : id d'étape en double "${s.id}".`, {
          reason: 'STEP_ID_DUPLICATE',
          id: s.id,
          ...at,
        });
      }
      stepIds.add(s.id);
      if (!nonEmptyString(s.prompt)) {
        throw invalid(`${where} : l'étape "${s.id}" n'a pas de "prompt".`, {
          reason: 'PROMPT_MISSING',
          ...at,
        });
      }
      return {
        id: s.id,
        prompt: s.prompt,
        profile: (s.profile as string | undefined) ?? null,
        timeout: timeoutOf(s.timeout, 'step.timeout'),
      };
    });
    return {
      ...base,
      kind,
      handoff: choice('handoff', ['merge', 'clone'] as const, 'HANDOFF_INVALID'),
      steps,
    };
  }

  if (kind === 'race') {
    const prompt = requirePrompt();
    if (!Array.isArray(item.candidates) || item.candidates.length < 2) {
      throw invalid(`${where} : une course compte au moins 2 candidats ("candidates").`, {
        reason: 'CANDIDATES_TOO_FEW',
        ...at,
      });
    }
    if (item.candidates.length > PLAN_LIMITS.candidates) {
      throw invalid(`${where} : ${PLAN_LIMITS.candidates} candidats au plus.`, {
        reason: 'CANDIDATES_TOO_MANY',
        max: PLAN_LIMITS.candidates,
        ...at,
      });
    }
    return {
      ...base,
      kind,
      prompt,
      candidates: item.candidates.map((c: unknown) => agentSpec(c, 'candidate')),
      pick: choice('pick', ['first-green', 'smallest-diff', 'judge'] as const, 'PICK_INVALID'),
      losers: choice('losers', ['keep', 'archive', 'clean'] as const, 'LOSERS_INVALID'),
    };
  }

  // team — collaboration intra-clone.
  const prompt = requirePrompt();
  if (item.cadence === 'dynamic') {
    // Partition dynamique : exige la médiation des écritures dans le client
    // ACP (lot I6) — refusée tant que ce crochet n'existe pas, plutôt
    // qu'offerte sans arbitrage réel.
    throw invalid(
      `${where} : la cadence "dynamic" n'est pas disponible (arbitrage des écritures non branché).`,
      {
        reason: 'CADENCE_UNAVAILABLE',
        cadence: 'dynamic',
        ...at,
      },
    );
  }
  const cadence = choice('cadence', ['turns', 'parallel'] as const, 'CADENCE_INVALID');
  if (!Array.isArray(item.roles) || item.roles.length < 2) {
    throw invalid(`${where} : une équipe compte au moins 2 rôles ("roles").`, {
      reason: 'ROLES_TOO_FEW',
      ...at,
    });
  }
  if (item.roles.length > PLAN_LIMITS.roles) {
    throw invalid(`${where} : ${PLAN_LIMITS.roles} rôles au plus.`, {
      reason: 'ROLES_TOO_MANY',
      max: PLAN_LIMITS.roles,
      ...at,
    });
  }
  const names = new Set<string>();
  const roles: PlanRoleSpec[] = item.roles.map((r: unknown) => {
    const s = specOf(r, ['name', 'profile', 'timeout', 'prompt', 'files'], 'role');
    const name = roleName(s.name, null, names);
    let files: string[] | null = null;
    if (s.files !== undefined && s.files !== null) {
      if (!Array.isArray(s.files) || s.files.some((g) => protectedPatternProblem(g) !== null)) {
        throw invalid(
          `${where} : "files" du rôle "${name}" doit lister des globs relatifs valides.`,
          {
            reason: 'SCOPE_INVALID',
            role: name,
            ...at,
          },
        );
      }
      files = [...(s.files as string[])];
    }
    if (cadence === 'parallel' && files === null) {
      throw invalid(
        `${where} : en cadence parallel, le rôle "${name}" doit déclarer "files" (partition statique).`,
        {
          reason: 'PARALLEL_SCOPE_MISSING',
          role: name,
          ...at,
        },
      );
    }
    return {
      name,
      profile: (s.profile as string | undefined) ?? null,
      timeout: timeoutOf(s.timeout, 'role.timeout'),
      prompt: (s.prompt as string | undefined) ?? null,
      files,
    };
  });
  return { ...base, kind: 'team', prompt, cadence, rounds: roundsOf('rounds'), roles };
}

function parseAfter(v: unknown, where: string, at: Rec): string[] {
  if (v === undefined || v === null) return [];
  const list = typeof v === 'string' ? [v] : v;
  if (
    !Array.isArray(list) ||
    list.length === 0 ||
    list.some((x) => !nonEmptyString(x)) ||
    new Set(list).size !== list.length
  ) {
    throw invalid(`${where} : "after" doit être un id ou une liste d'ids distincts non vide.`, {
      reason: 'AFTER_INVALID',
      ...at,
    });
  }
  return [...(list as string[])];
}

/**
 * Ressources hors-Git déclarées par un nœud (lot O, priorité 4) — base,
 * port, fichier verrouillé, service externe : un nom libre (opaque pour
 * Striart), jamais interprété comme un chemin ni une commande. Deux nœuds
 * qui déclarent le même nom ne tournent jamais en même temps, même sans
 * dépendance ni collision prédite par le Router.
 */
function parseResources(v: unknown, where: string, at: Rec): string[] {
  if (v === undefined || v === null) return [];
  if (
    !Array.isArray(v) ||
    v.some((x) => !nonEmptyString(x) || x.length > PLAN_LIMITS.resourceNameMax) ||
    new Set(v).size !== v.length
  ) {
    throw invalid(
      `${where} : "resources" doit être une liste de noms distincts non vides (${PLAN_LIMITS.resourceNameMax} caractères au plus chacun).`,
      { reason: 'RESOURCES_INVALID', max: PLAN_LIMITS.resourceNameMax, ...at },
    );
  }
  if (v.length > PLAN_LIMITS.resources) {
    throw invalid(`${where} : ${PLAN_LIMITS.resources} ressources déclarées au plus.`, {
      reason: 'RESOURCES_TOO_MANY',
      max: PLAN_LIMITS.resources,
      ...at,
    });
  }
  return [...(v as string[])];
}

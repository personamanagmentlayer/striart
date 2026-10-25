/**
 * Validation des formulaires d'elicitation ACP v1 (`elicitation/create`,
 * mode `form` — stabilisé le 2026-07-22). Le schéma vient de l'AGENT (donnée
 * non fiable) et la réponse de l'HUMAIN via la boîte aux lettres : les deux
 * sont contrôlés ici, côté client, avant tout envoi à l'agent — « Clients
 * should validate submitted values, and Agents should validate them again ».
 *
 * Sous-ensemble supporté, celui du protocole : un objet PLAT dont chaque
 * propriété est une primitive (string avec enum/oneOf/format/longueurs/
 * pattern, number, integer avec bornes, boolean) ou une sélection multiple
 * (array d'items énumérés). Tout le reste est refusé : un schéma qu'on ne
 * sait pas valider n'est jamais soumis à l'humain (fail closed).
 */

export type ElicitationProblemReason =
  | 'TYPE'
  | 'REQUIRED'
  | 'ENUM'
  | 'MIN_LENGTH'
  | 'MAX_LENGTH'
  | 'PATTERN'
  | 'FORMAT'
  | 'MINIMUM'
  | 'MAXIMUM'
  | 'MIN_ITEMS'
  | 'MAX_ITEMS'
  | 'UNKNOWN_FIELD';

export type ElicitationValidation =
  { ok: true } | { ok: false; field: string | null; reason: ElicitationProblemReason };

type Schema = Record<string, unknown>;

/** Bornes défensives : le schéma est fourni par l'agent. */
const MAX_PROPERTIES = 64;
const MAX_ENUM = 256;
const MAX_PATTERN_CHARS = 512;
/** Longueur maximale d'une chaîne saisie quand le schéma n'en fixe pas. */
const DEFAULT_MAX_STRING = 65_536;

const FORMATS: Record<string, (v: string) => boolean> = {
  email: (v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v),
  uri: (v) => {
    try {
      return Boolean(new URL(v).protocol);
    } catch {
      return false;
    }
  },
  date: (v) => /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v)),
  'date-time': (v) => /^\d{4}-\d{2}-\d{2}T/.test(v) && !Number.isNaN(Date.parse(v)),
};

const isObject = (v: unknown): v is Schema =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const isNonNegInt = (v: unknown) => Number.isInteger(v) && (v as number) >= 0;

/** Valeurs autorisées d'une primitive énumérée (enum ou oneOf de const), null sinon. */
function enumValues(schema: Schema): unknown[] | null {
  if (Array.isArray(schema.enum)) return schema.enum;
  if (Array.isArray(schema.oneOf)) return schema.oneOf.map((o) => (o as Schema)?.const);
  if (Array.isArray(schema.anyOf)) return schema.anyOf.map((o) => (o as Schema)?.const);
  return null;
}

/** Un motif plus long que cela n'est pas évalué (le coût d'un motif sûr reste borné par l'entrée). */
const MAX_PATTERN_INPUT = 4096;

/**
 * Le motif est fourni par l'AGENT et évalué sur la saisie de l'HUMAIN, dans la
 * boucle d'événements du dashboard : `^(\w+\s?)*$` y bloquerait tout (ReDoS,
 * S-M3). Analyse structurelle conservative — refusé : référence arrière,
 * lookaround, et groupe QUANTIFIÉ (`*`, `+`, `{n,}`, `{n,m}`) qui contient
 * lui-même un quantificateur ou une alternance (les formes à retour
 * arrière exponentiel ou polynomial élevé). Les motifs usuels (`^[a-z0-9-]+$`,
 * `^v\d+\.\d+$`, `^(abc|def)$`) passent ; un motif refusé rend le schéma
 * invalide : il n'est jamais soumis à l'humain (fail closed).
 */
export function isSafePattern(pattern: string): boolean {
  type Group = { quantified: boolean; alternation: boolean };
  const stack: Group[] = [];
  let lastClosed: Group | null = null;
  const markInner = () => {
    const top = stack[stack.length - 1];
    if (top) top.quantified = true;
  };
  for (let i = 0; i < pattern.length; i += 1) {
    const c = pattern[i];
    if (c === '\\') {
      const next = pattern[i + 1] ?? '';
      if (/[1-9]/.test(next) || next === 'k') return false; // référence arrière
      i += 1;
      lastClosed = null;
      continue;
    }
    if (c === '[') {
      // Classe de caractères : son contenu n'est jamais un quantificateur.
      i += 1;
      while (i < pattern.length && pattern[i] !== ']') i += pattern[i] === '\\' ? 2 : 1;
      lastClosed = null;
      continue;
    }
    if (c === '(') {
      if (pattern[i + 1] === '?') {
        const kind = pattern.slice(i + 2, i + 4);
        // (?:  (?<name>  autorisés ; (?=  (?!  (?<=  (?<!  refusés.
        if (kind.startsWith('=') || kind.startsWith('!') || kind === '<=' || kind === '<!')
          return false;
      }
      stack.push({ quantified: false, alternation: false });
      lastClosed = null;
      continue;
    }
    if (c === ')') {
      lastClosed = stack.pop() ?? null;
      const parent = stack[stack.length - 1];
      if (lastClosed && parent) {
        parent.quantified ||= lastClosed.quantified;
        parent.alternation ||= lastClosed.alternation;
      }
      continue;
    }
    if (c === '|') {
      const top = stack[stack.length - 1];
      if (top) top.alternation = true;
      lastClosed = null;
      continue;
    }
    let quantifier = false;
    if (c === '*' || c === '+') quantifier = true;
    else if (c === '?') quantifier = pattern[i - 1] !== '(';
    else if (c === '{') quantifier = /^\{\d+(,\d*)?\}/.test(pattern.slice(i));
    if (quantifier) {
      // `?` qui suit un quantificateur = paresseux, pas un nouveau quantificateur.
      const lazy = c === '?' && /[*+}?]/.test(pattern[i - 1] ?? '');
      if (!lazy) {
        const repeats = c !== '?';
        if (lastClosed && repeats && (lastClosed.quantified || lastClosed.alternation))
          return false;
        markInner();
      }
      lastClosed = null;
      continue;
    }
    lastClosed = null;
  }
  return stack.length === 0;
}

function compilePattern(pattern: unknown): RegExp | null {
  if (typeof pattern !== 'string' || pattern.length > MAX_PATTERN_CHARS) return null;
  if (!isSafePattern(pattern)) return null;
  try {
    return new RegExp(pattern, 'u');
  } catch {
    return null;
  }
}

function propertyProblem(name: string, prop: unknown): string | null {
  if (!isObject(prop)) return `property "${name}" is not a schema object`;
  const values = enumValues(prop);
  if (values && (values.length === 0 || values.length > MAX_ENUM))
    return `property "${name}" has an empty or oversized enum`;
  switch (prop.type) {
    case 'string':
      if (values && !values.every((v) => typeof v === 'string'))
        return `property "${name}" enum values must be strings`;
      if (prop.minLength != null && !isNonNegInt(prop.minLength))
        return `property "${name}" minLength is invalid`;
      if (prop.maxLength != null && !isNonNegInt(prop.maxLength))
        return `property "${name}" maxLength is invalid`;
      if (prop.pattern != null && !compilePattern(prop.pattern))
        return `property "${name}" pattern is invalid, too long or unsafe (nested quantifiers, backreference, lookaround)`;
      if (prop.format != null && !(typeof prop.format === 'string' && prop.format in FORMATS))
        return `property "${name}" format is not supported`;
      return null;
    case 'number':
    case 'integer':
      if (prop.minimum != null && typeof prop.minimum !== 'number')
        return `property "${name}" minimum is invalid`;
      if (prop.maximum != null && typeof prop.maximum !== 'number')
        return `property "${name}" maximum is invalid`;
      return null;
    case 'boolean':
      return null;
    case 'array': {
      if (!isObject(prop.items)) return `property "${name}" items must be a schema`;
      const itemValues = enumValues(prop.items);
      if (!itemValues || itemValues.length === 0 || itemValues.length > MAX_ENUM)
        return `property "${name}" items must enumerate their values`;
      if (prop.minItems != null && !isNonNegInt(prop.minItems))
        return `property "${name}" minItems is invalid`;
      if (prop.maxItems != null && !isNonNegInt(prop.maxItems))
        return `property "${name}" maxItems is invalid`;
      return null;
    }
    default:
      return `property "${name}" has an unsupported type`;
  }
}

/** Un schéma demandé par l'agent est-il un formulaire plat valide ? Rend la cause, ou null. */
export function elicitationSchemaProblem(schema: unknown): string | null {
  if (!isObject(schema) || schema.type !== 'object') return 'schema must be an object schema';
  const properties = schema.properties ?? {};
  if (!isObject(properties)) return 'schema properties must be an object';
  const names = Object.keys(properties);
  if (names.length > MAX_PROPERTIES) return 'schema has too many properties';
  for (const name of names) {
    const problem = propertyProblem(name, properties[name]);
    if (problem) return problem;
  }
  if (schema.required != null) {
    if (!Array.isArray(schema.required)) return 'schema required must be an array';
    for (const r of schema.required)
      if (typeof r !== 'string' || !names.includes(r))
        return `required field "${String(r)}" is not a declared property`;
  }
  return null;
}

function valueProblem(prop: Schema, value: unknown): ElicitationProblemReason | null {
  const values = enumValues(prop);
  switch (prop.type) {
    case 'string': {
      if (typeof value !== 'string') return 'TYPE';
      if (values && !values.includes(value)) return 'ENUM';
      if (typeof prop.minLength === 'number' && value.length < prop.minLength) return 'MIN_LENGTH';
      const max = typeof prop.maxLength === 'number' ? prop.maxLength : DEFAULT_MAX_STRING;
      if (value.length > max) return 'MAX_LENGTH';
      if (prop.pattern != null) {
        // Entrée bornée : même un motif jugé sûr n'est jamais évalué sur une saisie géante.
        if (value.length > MAX_PATTERN_INPUT) return 'PATTERN';
        if (!compilePattern(prop.pattern)?.test(value)) return 'PATTERN';
      }
      if (typeof prop.format === 'string' && !FORMATS[prop.format]?.(value)) return 'FORMAT';
      return null;
    }
    case 'number':
    case 'integer': {
      if (typeof value !== 'number' || !Number.isFinite(value)) return 'TYPE';
      if (prop.type === 'integer' && !Number.isInteger(value)) return 'TYPE';
      if (typeof prop.minimum === 'number' && value < prop.minimum) return 'MINIMUM';
      if (typeof prop.maximum === 'number' && value > prop.maximum) return 'MAXIMUM';
      return null;
    }
    case 'boolean':
      return typeof value === 'boolean' ? null : 'TYPE';
    case 'array': {
      if (!Array.isArray(value)) return 'TYPE';
      const allowed = enumValues(prop.items as Schema) ?? [];
      if (!value.every((v) => allowed.includes(v))) return 'ENUM';
      if (new Set(value).size !== value.length) return 'ENUM';
      if (typeof prop.minItems === 'number' && value.length < prop.minItems) return 'MIN_ITEMS';
      if (typeof prop.maxItems === 'number' && value.length > prop.maxItems) return 'MAX_ITEMS';
      return null;
    }
    default:
      return 'TYPE';
  }
}

/**
 * Une réponse humaine est-elle conforme au schéma demandé ? Tout champ non
 * déclaré est refusé (l'agent ne reçoit que ce qu'il a demandé). Le schéma
 * est supposé déjà validé par `elicitationSchemaProblem`.
 */
export function validateElicitationContent(
  schema: unknown,
  content: unknown,
): ElicitationValidation {
  if (!isObject(schema)) return { ok: false, field: null, reason: 'TYPE' };
  if (!isObject(content)) return { ok: false, field: null, reason: 'TYPE' };
  const properties = (isObject(schema.properties) ? schema.properties : {}) as Record<
    string,
    Schema
  >;
  for (const key of Object.keys(content)) {
    if (!(key in properties)) return { ok: false, field: key, reason: 'UNKNOWN_FIELD' };
  }
  const required = Array.isArray(schema.required) ? (schema.required as string[]) : [];
  for (const key of required) {
    if (content[key] === undefined || content[key] === null)
      return { ok: false, field: key, reason: 'REQUIRED' };
  }
  for (const [key, value] of Object.entries(content)) {
    const reason = valueProblem(properties[key], value);
    if (reason) return { ok: false, field: key, reason };
  }
  return { ok: true };
}

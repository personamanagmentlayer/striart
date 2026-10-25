/**
 * Validateur JSON Schema — sous-ensemble fermé de la draft 2020-12, celui
 * qu'emploient les schémas PUBLIÉS du Striart Control Protocol
 * (`src/control/schema.ts`). Le même schéma sert donc de documentation aux
 * clients ET de validation positive côté serveur : aucune divergence
 * possible entre ce qui est annoncé et ce qui est accepté.
 *
 * Pourquoi pas une bibliothèque (ajv) : le sous-ensemble utilisé tient en
 * quelques mots-clés, et une dépendance de plus serait une surface de chaîne
 * d'approvisionnement chargée à chaque requête du protocole. Fermeture
 * vérifiée : un mot-clé non pris en charge dans un schéma est une erreur de
 * PROGRAMMATION (`assertSupportedSchema`, appelée par les tests), jamais une
 * contrainte ignorée en silence.
 *
 * Annotation propre à Striart : `x-striart-error` sur un schéma nomme le
 * code d'erreur stable à rendre quand une valeur y échoue (ex. un nom
 * d'agent mal formé → INVALID_AGENT_NAME, comme la CLI).
 */

export type JsonSchema = Record<string, unknown>;

export interface SchemaError {
  /** Chemin de la valeur fautive (`params.agent`, `data.results[0].status`). */
  path: string;
  /** Mot-clé qui a échoué (`type`, `pattern`, `required`…). */
  keyword: string;
  /** Explication courte, sans la valeur fautive (qui peut être un secret). */
  message: string;
  /** Code d'erreur annoncé par le schéma (`x-striart-error`), sinon null. */
  errorCode: string | null;
}

const ASSERTIONS = new Set([
  '$ref',
  'type',
  'enum',
  'const',
  'properties',
  'required',
  'additionalProperties',
  'items',
  'minItems',
  'maxItems',
  'minLength',
  'maxLength',
  'pattern',
  'minimum',
  'maximum',
  'oneOf',
  'anyOf',
  'allOf',
]);

const ANNOTATIONS = new Set([
  '$schema',
  '$id',
  '$comment',
  '$defs',
  'title',
  'description',
  'examples',
  'default',
  'deprecated',
  'readOnly',
  'format',
]);

const TYPES = new Set(['null', 'boolean', 'object', 'array', 'number', 'integer', 'string']);

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function typeMatches(type: string, value: unknown): boolean {
  switch (type) {
    case 'null':
      return value === null;
    case 'boolean':
      return typeof value === 'boolean';
    case 'object':
      return isObject(value);
    case 'array':
      return Array.isArray(value);
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'integer':
      return Number.isInteger(value);
    case 'string':
      return typeof value === 'string';
    default:
      return false;
  }
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b))
    return a.length === b.length && a.every((v, i) => deepEqual(v, b[i]));
  if (isObject(a) && isObject(b)) {
    const ka = Object.keys(a);
    return ka.length === Object.keys(b).length && ka.every((k) => deepEqual(a[k], b[k]));
  }
  return false;
}

function childPath(path: string, key: string | number): string {
  if (typeof key === 'number') return `${path}[${key}]`;
  return path ? `${path}.${key}` : key;
}

/**
 * Valide `value` contre `schema`. Les `$ref` locaux (`#/components/schemas/X`
 * ou `#/$defs/X`) sont résolus dans `root`. Rend la PREMIÈRE erreur, ou null.
 */
export function createValidator(root: JsonSchema) {
  const patterns = new Map<string, RegExp>();
  const pattern = (source: string) => {
    let re = patterns.get(source);
    if (!re) {
      re = new RegExp(source, 'u');
      patterns.set(source, re);
    }
    return re;
  };

  const resolve = (ref: string): JsonSchema => {
    const match = /^#\/(components\/schemas|\$defs)\/([A-Za-z0-9_.-]+)$/.exec(ref);
    const container =
      match?.[1] === '$defs'
        ? root.$defs
        : isObject(root.components)
          ? root.components.schemas
          : undefined;
    const target = match && isObject(container) ? container[match[2]] : undefined;
    if (!isObject(target)) throw new Error(`Unresolvable schema reference: ${ref}`);
    return target;
  };

  const fail = (
    path: string,
    keyword: string,
    message: string,
    errorCode: string | null,
  ): SchemaError => ({ path: path || '(root)', keyword, message, errorCode });

  function check(
    schema: JsonSchema,
    value: unknown,
    path: string,
    inherited: string | null,
  ): SchemaError | null {
    const code =
      typeof schema['x-striart-error'] === 'string' ? schema['x-striart-error'] : inherited;

    if (typeof schema.$ref === 'string') {
      const error = check(resolve(schema.$ref), value, path, code);
      if (error) return error;
    }
    if (schema.type !== undefined) {
      const types = Array.isArray(schema.type)
        ? (schema.type as string[])
        : [schema.type as string];
      if (!types.some((t) => typeMatches(t, value)))
        return fail(path, 'type', `expected ${types.join(' or ')}`, code);
    }
    if (Array.isArray(schema.enum) && !schema.enum.some((v) => deepEqual(v, value)))
      return fail(
        path,
        'enum',
        `expected one of ${schema.enum.map((v) => JSON.stringify(v)).join(', ')}`,
        code,
      );
    if ('const' in schema && !deepEqual(schema.const, value))
      return fail(path, 'const', `expected ${JSON.stringify(schema.const)}`, code);

    if (typeof value === 'string') {
      // Longueur en points de code, comme le prescrit JSON Schema.
      const length = [...value].length;
      if (typeof schema.minLength === 'number' && length < schema.minLength)
        return fail(path, 'minLength', `at least ${schema.minLength} characters`, code);
      if (typeof schema.maxLength === 'number' && length > schema.maxLength)
        return fail(path, 'maxLength', `at most ${schema.maxLength} characters`, code);
      if (typeof schema.pattern === 'string' && !pattern(schema.pattern).test(value))
        return fail(path, 'pattern', 'does not match the expected format', code);
    }
    if (typeof value === 'number') {
      if (typeof schema.minimum === 'number' && value < schema.minimum)
        return fail(path, 'minimum', `at least ${schema.minimum}`, code);
      if (typeof schema.maximum === 'number' && value > schema.maximum)
        return fail(path, 'maximum', `at most ${schema.maximum}`, code);
    }
    if (Array.isArray(value)) {
      if (typeof schema.minItems === 'number' && value.length < schema.minItems)
        return fail(path, 'minItems', `at least ${schema.minItems} items`, code);
      if (typeof schema.maxItems === 'number' && value.length > schema.maxItems)
        return fail(path, 'maxItems', `at most ${schema.maxItems} items`, code);
      if (isObject(schema.items)) {
        for (let i = 0; i < value.length; i += 1) {
          const error = check(schema.items, value[i], childPath(path, i), code);
          if (error) return error;
        }
      }
    }
    if (isObject(value)) {
      const properties = isObject(schema.properties) ? schema.properties : {};
      if (Array.isArray(schema.required)) {
        for (const key of schema.required as string[]) {
          if (!Object.hasOwn(value, key))
            return fail(
              childPath(path, key),
              'required',
              'is required',
              propertyCode(Object.hasOwn(properties, key) ? properties[key] : undefined, code),
            );
        }
      }
      for (const [key, child] of Object.entries(value)) {
        // Propriété PROPRE seulement : `__proto__` d'un JSON.parse ne doit jamais
        // résoudre vers Object.prototype (contournement d'additionalProperties).
        const sub = Object.hasOwn(properties, key) ? properties[key] : undefined;
        if (isObject(sub)) {
          const error = check(sub, child, childPath(path, key), code);
          if (error) return error;
        } else if (schema.additionalProperties === false) {
          return fail(
            childPath(path, key),
            'additionalProperties',
            'is not an accepted field',
            code,
          );
        } else if (isObject(schema.additionalProperties)) {
          const error = check(schema.additionalProperties, child, childPath(path, key), code);
          if (error) return error;
        }
      }
    }
    if (Array.isArray(schema.allOf)) {
      for (const sub of schema.allOf as JsonSchema[]) {
        const error = check(sub, value, path, code);
        if (error) return error;
      }
    }
    for (const keyword of ['oneOf', 'anyOf'] as const) {
      const branches = schema[keyword];
      if (!Array.isArray(branches)) continue;
      const errors = (branches as JsonSchema[]).map((b) => check(b, value, path, code));
      const matches = errors.filter((e) => e === null).length;
      if (keyword === 'anyOf' ? matches >= 1 : matches === 1) continue;
      if (matches > 1) return fail(path, keyword, 'matches more than one variant', code);
      // Diagnostic utile : l'erreur de la variante désignée par son
      // discriminant (`status`, `action`, `mode`…), sinon une erreur globale.
      const chosen = discriminated(branches as JsonSchema[], value);
      return chosen !== -1 && errors[chosen]
        ? errors[chosen]
        : fail(
            path,
            keyword,
            'matches no accepted variant',
            // Sans discriminant : le code annoncé par une variante (ex. le
            // nom d'agent d'un « AgentName | null ») plutôt qu'un code générique.
            code ?? errors.find((e) => e?.errorCode)?.errorCode ?? null,
          );
    }
    return null;
  }

  function propertyCode(sub: unknown, inherited: string | null): string | null {
    if (!isObject(sub)) return inherited;
    if (typeof sub['x-striart-error'] === 'string') return sub['x-striart-error'];
    if (typeof sub.$ref === 'string') {
      const target = resolve(sub.$ref);
      if (typeof target['x-striart-error'] === 'string') return target['x-striart-error'];
    }
    return inherited;
  }

  function discriminated(branches: JsonSchema[], value: unknown): number {
    if (!isObject(value)) return -1;
    return branches.findIndex((branch) => {
      const target = typeof branch.$ref === 'string' ? resolve(branch.$ref) : branch;
      const properties = isObject(target.properties) ? target.properties : {};
      return Object.entries(properties).some(
        ([key, sub]) => isObject(sub) && 'const' in sub && deepEqual(sub.const, value[key]),
      );
    });
  }

  return (schema: JsonSchema, value: unknown, path = ''): SchemaError | null =>
    check(schema, value, path, null);
}

/**
 * Vérifie qu'un document de schémas n'emploie QUE des mots-clés pris en
 * charge (et des `$ref` résolubles). Lève sinon : un mot-clé ignoré serait
 * une contrainte publiée mais jamais appliquée.
 */
export function assertSupportedSchema(root: JsonSchema, schemas: Iterable<JsonSchema>): void {
  const validate = createValidator(root);
  const seen = new Set<unknown>();
  const visit = (schema: unknown, where: string) => {
    if (!isObject(schema) || seen.has(schema)) return;
    seen.add(schema);
    for (const [key, value] of Object.entries(schema)) {
      if (key.startsWith('x-')) continue;
      if (!ASSERTIONS.has(key) && !ANNOTATIONS.has(key))
        throw new Error(`Unsupported JSON Schema keyword "${key}" at ${where}`);
      if (key === 'type') {
        const types = Array.isArray(value) ? value : [value];
        for (const t of types)
          if (!TYPES.has(String(t))) throw new Error(`Unknown type "${String(t)}" at ${where}`);
      }
      if (key === 'pattern') new RegExp(String(value), 'u');
      if (key === '$ref') validate({ $ref: value }, undefined);
    }
    if (isObject(schema.properties))
      for (const [k, v] of Object.entries(schema.properties)) visit(v, `${where}.properties.${k}`);
    if (isObject(schema.items)) visit(schema.items, `${where}.items`);
    if (isObject(schema.additionalProperties))
      visit(schema.additionalProperties, `${where}.additionalProperties`);
    for (const keyword of ['oneOf', 'anyOf', 'allOf'])
      if (Array.isArray(schema[keyword]))
        (schema[keyword] as unknown[]).forEach((v, i) => visit(v, `${where}.${keyword}[${i}]`));
  };
  let index = 0;
  for (const schema of schemas) visit(schema, `schema[${index++}]`);
}

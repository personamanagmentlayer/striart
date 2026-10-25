import { describe, expect, it } from 'vitest';
import { assertSupportedSchema, createValidator } from '../../src/control/validate.ts';

const ROOT = {
  components: {
    schemas: {
      Name: { type: 'string', pattern: '^[a-z]+$', 'x-striart-error': 'INVALID_AGENT_NAME' },
      Thing: {
        type: 'object',
        properties: {
          name: { $ref: '#/components/schemas/Name' },
          n: { type: 'integer', minimum: 1 },
        },
        required: ['name'],
        additionalProperties: false,
      },
      Union: {
        oneOf: [
          {
            type: 'object',
            properties: { status: { const: 'A' }, a: { type: 'string' } },
            required: ['status', 'a'],
          },
          {
            type: 'object',
            properties: { status: { const: 'B' }, b: { type: 'integer' } },
            required: ['status', 'b'],
          },
        ],
      },
    },
  },
};
const validate = createValidator(ROOT);
const ref = (name) => ({ $ref: `#/components/schemas/${name}` });

describe('validateur JSON Schema du protocole', () => {
  it('accepte une valeur conforme', () => {
    expect(validate(ref('Thing'), { name: 'abc', n: 2 })).toBeNull();
  });

  it('type, pattern, minimum, required, champ inconnu : première erreur, chemin et mot-clé', () => {
    expect(validate(ref('Thing'), 'x')).toMatchObject({ keyword: 'type', path: '(root)' });
    expect(validate(ref('Thing'), { name: 'ABC' }, 'params')).toMatchObject({
      keyword: 'pattern',
      path: 'params.name',
      errorCode: 'INVALID_AGENT_NAME',
    });
    expect(validate(ref('Thing'), { name: 'a', n: 0 })).toMatchObject({
      keyword: 'minimum',
      path: 'n',
    });
    expect(validate(ref('Thing'), { name: 'a', n: 1.5 })).toMatchObject({ keyword: 'type' });
    expect(validate(ref('Thing'), {}, 'params')).toMatchObject({
      keyword: 'required',
      path: 'params.name',
      errorCode: 'INVALID_AGENT_NAME',
    });
    expect(validate(ref('Thing'), { name: 'a', extra: 1 })).toMatchObject({
      keyword: 'additionalProperties',
      path: 'extra',
    });
  });

  it('le message d’erreur ne recopie jamais la valeur fautive', () => {
    const secret = 'sk-ant-SECRET-VALUE';
    const error = validate(ref('Thing'), { name: secret });
    expect(JSON.stringify(error)).not.toContain(secret);
  });

  it('oneOf : la variante désignée par son discriminant donne le diagnostic', () => {
    expect(validate(ref('Union'), { status: 'A', a: 'x' })).toBeNull();
    expect(validate(ref('Union'), { status: 'B', b: 'pas un entier' })).toMatchObject({
      keyword: 'type',
      path: 'b',
    });
    expect(validate(ref('Union'), { status: 'C' })).toMatchObject({ keyword: 'oneOf' });
  });

  it('anyOf sans discriminant (« Nom | null ») : le code annoncé par la variante, pas un code générique', () => {
    const nullableName = { anyOf: [ref('Name'), { type: 'null' }] };
    expect(validate(nullableName, null)).toBeNull();
    expect(validate(nullableName, 0)).toMatchObject({
      keyword: 'anyOf',
      errorCode: 'INVALID_AGENT_NAME',
    });
  });

  it('longueurs en points de code (pas en unités UTF-16)', () => {
    expect(validate({ type: 'string', maxLength: 1 }, '😀')).toBeNull();
    expect(validate({ type: 'string', minLength: 2 }, '😀')).toMatchObject({
      keyword: 'minLength',
    });
  });

  it('assertSupportedSchema : un mot-clé non pris en charge est une erreur, jamais ignoré', () => {
    expect(() => assertSupportedSchema(ROOT, Object.values(ROOT.components.schemas))).not.toThrow();
    expect(() =>
      assertSupportedSchema(ROOT, [{ type: 'string', format: 'email', uniqueItems: true }]),
    ).toThrow(/uniqueItems/);
    expect(() => assertSupportedSchema(ROOT, [{ $ref: '#/components/schemas/Absent' }])).toThrow(
      /Unresolvable/,
    );
    expect(() => assertSupportedSchema(ROOT, [{ type: 'strnig' }])).toThrow(/Unknown type/);
  });

  it('M3 : une clé __proto__ propre à la valeur ne contourne pas additionalProperties:false', () => {
    const value = JSON.parse('{"name":"abc","__proto__":{"polluted":true}}');
    expect(validate(ref('Thing'), value)).toMatchObject({
      keyword: 'additionalProperties',
      path: '__proto__',
    });
  });

  it('M3 : une propriété héritée (constructor, toString) n’est jamais prise pour une propriété déclarée', () => {
    const value = JSON.parse('{"name":"abc","constructor":1}');
    expect(validate(ref('Thing'), value)).toMatchObject({ keyword: 'additionalProperties' });
  });
});

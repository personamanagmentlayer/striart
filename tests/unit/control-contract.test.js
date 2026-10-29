import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { StriartError } from '../../src/errors.ts';
import { en } from '../../src/cli/i18n/en.ts';
import { fr } from '../../src/cli/i18n/fr.ts';
import { errorDocument, errorObject, successDocument } from '../../src/control/envelope.ts';
import { errorResponse } from '../../src/control/rpc.ts';
import {
  METHOD_SPECS,
  NOTIFICATION_SPECS,
  SCHEMA_ROOT,
  buildDocumentJsonSchema,
  buildOpenRpcDocument,
  componentSchemas,
  paramsSchema,
  resultSchema,
} from '../../src/control/schema.ts';
import { assertSupportedSchema, createValidator } from '../../src/control/validate.ts';

const SCHEMAS = new URL('../../schemas/', import.meta.url);
const validate = createValidator(SCHEMA_ROOT);
const refOf = (name) => ({ $ref: `#/components/schemas/${name}` });

const REGENERATE =
  'node src/cli.js api --schema openrpc > schemas/striart-control-v1.openrpc.json && node src/cli.js api --schema json-schema > schemas/striart-document-v1.schema.json && npx prettier --write schemas/';

describe('contrat CLI ↔ Striart Control Protocol (mêmes schémas)', () => {
  it('les fichiers publiés de schemas/ sont exactement ceux générés par le code', async () => {
    const openrpc = JSON.parse(
      await readFile(new URL('striart-control-v1.openrpc.json', SCHEMAS), 'utf8'),
    );
    const bundle = JSON.parse(
      await readFile(new URL('striart-document-v1.schema.json', SCHEMAS), 'utf8'),
    );
    expect(openrpc, `schemas/ périmé — régénère : ${REGENERATE}`).toEqual(buildOpenRpcDocument());
    expect(bundle, `schemas/ périmé — régénère : ${REGENERATE}`).toEqual(buildDocumentJsonSchema());
  });

  it('les schémas publiés n’emploient que des mots-clés appliqués par le validateur', () => {
    const all = [
      ...Object.values(componentSchemas()),
      ...METHOD_SPECS.flatMap((spec) => [paramsSchema(spec), resultSchema(spec)]),
    ];
    expect(() => assertSupportedSchema(SCHEMA_ROOT, all)).not.toThrow();
    // Le bundle JSON Schema se résout en $defs, sans référence pendante.
    const bundle = buildDocumentJsonSchema();
    expect(() => assertSupportedSchema(bundle, Object.values(bundle.$defs))).not.toThrow();
  });

  it('chaque méthode et notification référence des définitions existantes ; noms uniques', () => {
    const defs = componentSchemas();
    const names = METHOD_SPECS.map((s) => s.name);
    expect(new Set(names).size).toBe(names.length);
    for (const spec of METHOD_SPECS) expect(defs[spec.data], spec.name).toBeDefined();
    for (const n of NOTIFICATION_SPECS) expect(defs[n.params], n.name).toBeDefined();
  });

  it('le plan humain expose ce que le plan agent (MCP) n’expose jamais', () => {
    const mutating = METHOD_SPECS.filter((s) => s.mutating).map((s) => s.name);
    for (const name of ['permission.answer', 'ticket.close', 'mainSession.release'])
      expect(mutating).toContain(name);
  });

  it('erreur : la CLI et le protocole produisent LE MÊME objet error, valide contre ErrorObject', () => {
    const error = new StriartError('Agent inconnu : « x ».', {
      code: 'AGENT_UNKNOWN',
      details: { agent: 'x', apiKey: 'sk-secret' },
      hint: 'striart status',
    });
    for (const m of [en, fr]) {
      const cli = errorDocument('merge', errorObject(error, m, { exposeUnexpected: true }));
      const protocol = errorResponse(1, 'merge', error, { m }).error.data;
      expect(protocol).toEqual(cli);
      expect(validate(refOf('Document'), cli)).toBeNull();
      expect(validate(refOf('ErrorDocument'), protocol)).toBeNull();
      // Caviardage défensif commun (publicErrorDetails).
      expect(protocol.error.details).toEqual({ agent: 'x', apiKey: '[redacted]' });
    }
  });

  it('erreur inattendue : la CLI montre la cause, le protocole jamais (A10)', () => {
    const boom = new Error('EACCES: /home/alice/.ssh/id_rsa');
    expect(errorObject(boom, en, { exposeUnexpected: true }).message).toContain('id_rsa');
    const protocol = errorResponse(1, 'state.get', boom, { m: en });
    expect(JSON.stringify(protocol)).not.toContain('id_rsa');
    expect(protocol.error).toMatchObject({
      code: -32603,
      data: { error: { code: 'UNEXPECTED', kind: 'failure' } },
    });
  });

  it('succès : le document de résultat de la CLI (sans outcome) et du protocole (avec) valident le même schéma', () => {
    const cli = { schemaVersion: 1, command: 'status', ok: true, data: {} };
    const protocol = successDocument('agent.merge', { status: 'CONFLICT' }, { outcome: 'refused' });
    expect(protocol).toMatchObject({ ok: false, outcome: 'refused' });
    expect(validate(refOf('Document'), cli)).toBeNull();
    expect(validate(refOf('Document'), protocol)).toBeNull();
  });
});

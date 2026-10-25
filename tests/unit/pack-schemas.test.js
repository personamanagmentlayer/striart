import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { SCHEMA_FILES, verifyPackedSchemas, verifySchemaContents } from '../../scripts/pack.ts';

const PKG = new URL('../../package.json', import.meta.url);
const read = (rel) => readFile(new URL(`../../${rel}`, import.meta.url), 'utf8');

describe('scripts/pack.ts — schemas/ publiés (contrat du Control Protocol)', () => {
  it('package.json déclare schemas/ dans "files"', async () => {
    const manifest = JSON.parse(await readFile(PKG, 'utf8'));
    expect(manifest.files).toContain('schemas/');
  });

  it('SCHEMA_FILES nomme les deux schémas versionnés', () => {
    expect(SCHEMA_FILES).toEqual([
      'schemas/striart-control-v1.openrpc.json',
      'schemas/striart-document-v1.schema.json',
    ]);
  });

  it('archive complète : accepté', () => {
    expect(() =>
      verifyPackedSchemas(['package.json', ...SCHEMA_FILES], { files: ['src/', 'schemas/'] }),
    ).not.toThrow();
  });

  it('un fichier de schéma absent de l’archive : PACK_SCHEMAS_MISSING', () => {
    expect(() =>
      verifyPackedSchemas(['package.json', SCHEMA_FILES[0]], { files: ['src/', 'schemas/'] }),
    ).toThrow(expect.objectContaining({ code: 'PACK_SCHEMAS_MISSING' }));
  });

  it('"files" sans schemas/ : PACK_SCHEMAS_MISSING même si les fichiers y sont par ailleurs', () => {
    expect(() => verifyPackedSchemas([...SCHEMA_FILES], { files: ['src/'] })).toThrow(
      expect.objectContaining({ code: 'PACK_SCHEMAS_MISSING' }),
    );
  });

  it('contenu identique à ce que génère le code : accepté', async () => {
    await expect(verifySchemaContents(read)).resolves.toBeUndefined();
  });

  it('contenu périmé dans l’archive : PACK_SCHEMAS_STALE', async () => {
    const stale = async (rel) => {
      const doc = JSON.parse(await read(rel));
      doc.info = { ...(doc.info ?? {}), title: 'tampered' };
      return JSON.stringify(doc);
    };
    await expect(verifySchemaContents(stale)).rejects.toMatchObject({ code: 'PACK_SCHEMAS_STALE' });
  });

  it('contenu illisible (JSON invalide) : PACK_SCHEMAS_STALE, jamais ignoré', async () => {
    await expect(verifySchemaContents(async () => '{nope')).rejects.toMatchObject({
      code: 'PACK_SCHEMAS_STALE',
    });
  });
});

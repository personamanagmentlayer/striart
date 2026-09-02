import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readJson, writeJsonAtomic } from '../../src/json-file.js';
import { StriartError } from '../../src/errors.js';

describe('json-file — le socle des fichiers d’état (.striart/*.json)', () => {
  let dir;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'striart-json-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('fichier absent → fallback, jamais une erreur', async () => {
    const result = await readJson(path.join(dir, 'absent.json'), { fallback: { agents: {} } });
    expect(result).toEqual({ agents: {} });
  });

  it('fichier corrompu → StriartError avec le code du fichier concerné', async () => {
    const file = path.join(dir, 'agents.json');
    await writeFile(file, '{ "agents": ', 'utf8'); // JSON tronqué (crash au milieu d’un write non atomique)

    // Le code est celui de l'APPELANT (REGISTRY_CORRUPT, QUEUE_CORRUPT…) :
    // c'est lui qui dit à l'humain QUEL fichier réparer ou supprimer.
    const attempt = readJson(file, { fallback: {}, code: 'REGISTRY_CORRUPT' });
    await expect(attempt).rejects.toThrow(StriartError);
    await expect(attempt).rejects.toMatchObject({
      code: 'REGISTRY_CORRUPT',
      details: { path: file },
    });
  });

  it('sans code explicite → JSON_CORRUPT par défaut', async () => {
    const file = path.join(dir, 'x.json');
    await writeFile(file, 'pas du json', 'utf8');
    await expect(readJson(file, { fallback: {} })).rejects.toMatchObject({
      code: 'JSON_CORRUPT',
    });
  });

  it('écriture atomique : le contenu final est complet et le .tmp a disparu', async () => {
    const file = path.join(dir, 'state.json');
    await writeJsonAtomic(file, { streak: 2, manual: false });

    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ streak: 2, manual: false });
    // Le fichier temporaire ne doit jamais survivre : c'est lui qui garantit
    // qu'un crash laisse soit l'ancien état, soit le nouveau — jamais un
    // fichier à moitié écrit.
    await expect(readFile(`${file}.tmp`, 'utf8')).rejects.toThrow();
  });

  it('écriture atomique : écraser un état existant ne le corrompt pas', async () => {
    const file = path.join(dir, 'queue.json');
    await writeJsonAtomic(file, { tasks: ['a'] });
    await writeJsonAtomic(file, { tasks: ['a', 'b'] });
    await expect(readJson(file, { fallback: null })).resolves.toEqual({ tasks: ['a', 'b'] });
  });
});

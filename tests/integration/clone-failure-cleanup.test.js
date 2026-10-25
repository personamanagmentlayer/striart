/**
 * Un clone partiel ne survit pas à l'échec de sa création (revue du noyau
 * K-M10). Avant : après `CLONE_FAILED` le dossier restait, le nom d'agent
 * devenait inutilisable (`AGENT_EXISTS`) sans entrée au registre pour le
 * retirer.
 *
 * Échec provoqué par une collision de références : la branche courante du
 * principal s'appelle `striart` — le clone la reprend, et `striart/<agent>/…`
 * ne peut plus être créée (fichier/dossier de ref).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { execa } from 'execa';
import { createTempRepo } from '../helpers/temp-repo.js';
import { initStriart } from '../../src/init.js';
import { createAgent, readRegistry } from '../../src/clone.js';

const git = (cwd, ...args) => execa('git', ['-C', cwd, ...args]).then((r) => r.stdout.trim());

describe('création de clone — échec sans reliquat (intégration)', () => {
  let repo;

  beforeEach(async () => {
    repo = await createTempRepo();
    await initStriart(repo.root);
    await git(repo.root, 'checkout', '-q', '-b', 'striart');
  });

  afterEach(async () => {
    await repo.cleanup();
  });

  it('CLONE_FAILED : le clone partiel est supprimé, le nom reste utilisable', async () => {
    const dest = path.join(repo.root, '.striart', 'agents', 'agent-a');

    const error = await createAgent({ root: repo.root, name: 'agent-a' }).catch((e) => e);

    expect(error).toMatchObject({ code: 'CLONE_FAILED' });
    await expect(stat(dest)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readRegistry(repo.root)).toEqual({});

    // Cause levée : le même nom est de nouveau disponible (pas d'AGENT_EXISTS).
    await git(repo.root, 'branch', '-m', 'striart', 'principal');
    const info = await createAgent({ root: repo.root, name: 'agent-a' });
    expect(info.name).toBe('agent-a');
  });
});

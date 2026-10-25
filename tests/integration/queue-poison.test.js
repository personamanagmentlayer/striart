/**
 * File d'attente — un ticket « empoisonné » ne gèle plus tout le dégagement
 * (revue du noyau K-I5). Toute erreur propre à UNE tâche (nom d'agent invalide
 * écrit à la main, clone en cours de suppression, clone incomplet…) la maintient
 * en file avec son `blockedReason` ; les suivantes sont examinées. Et un
 * `stopAgent` dont le retryQueue échoue rapporte l'échec sans défaire l'arrêt
 * (agent retiré) ni sauter l'arrêt de l'hôte de pty.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createTempRepo } from '../helpers/temp-repo.js';
import { initStriart } from '../../src/init.js';
import { createAgent, readRegistry } from '../../src/clone.js';
import { readQueue, enqueueTask } from '../../src/queue.js';
import { retryQueue, stopAgent } from '../../src/orchestrator.js';

const task = (agent) => ({
  agent,
  prompt: `tâche ${agent}`,
  predictedFiles: [],
  collisions: [],
});

describe('file d’attente — poison-pill (intégration)', () => {
  let repo;

  beforeEach(async () => {
    repo = await createTempRepo();
    await initStriart(repo.root);
    await writeFile(
      path.join(repo.root, '.striartrc.json'),
      JSON.stringify({ testCommand: 'node -e "process.exit(0)"' }),
    );
  });

  afterEach(async () => {
    await repo.cleanup();
  });

  it('une tâche à nom invalide reste en file avec son motif ; la suivante démarre', async () => {
    await enqueueTask(repo.root, task('Nom Invalide!'));
    await enqueueTask(repo.root, task('bonne-tache'));

    const result = await retryQueue({ root: repo.root });

    expect(result.started.map((s) => s.task.agent)).toEqual(['bonne-tache']);
    expect(result.stillWaiting).toEqual([
      expect.objectContaining({ agent: 'Nom Invalide!', blockedReason: 'INVALID_AGENT_NAME' }),
    ]);
    expect(Object.keys(await readRegistry(repo.root))).toEqual(['bonne-tache']);
    // La tâche empoisonnée n'est PAS retirée de la file : un humain la voit.
    expect((await readQueue(repo.root)).map((t) => t.agent)).toEqual(['Nom Invalide!']);
  });

  it('stopAgent : l’arrêt réussit et rapporte la tâche bloquée au lieu d’échouer', async () => {
    await createAgent({ root: repo.root, name: 'sortant' });
    await enqueueTask(repo.root, task('Nom Invalide!'));
    await enqueueTask(repo.root, task('bonne-tache'));

    const result = await stopAgent({ root: repo.root, agent: 'sortant', force: true });

    expect(result.agent).toBe('sortant');
    expect(result.started.map((s) => s.task.agent)).toEqual(['bonne-tache']);
    expect(result.stillWaiting.map((t) => t.blockedReason)).toEqual(['INVALID_AGENT_NAME']);
    expect(result.queueError ?? null).toBeNull();
    expect(Object.keys(await readRegistry(repo.root))).toEqual(['bonne-tache']);
  });

  it('stopAgent : file illisible → agent retiré, échec RAPPORTÉ (queueError), arrêt de l’hôte de pty atteint', async () => {
    await createAgent({ root: repo.root, name: 'sortant' });
    await writeFile(path.join(repo.root, '.striart', 'queue.json'), '{ pas du json');

    const result = await stopAgent({ root: repo.root, agent: 'sortant', force: true });

    expect(result.agent).toBe('sortant');
    expect(result.started).toEqual([]);
    expect(result.queueError).toMatchObject({ code: 'QUEUE_CORRUPT' });
    expect(Object.keys(await readRegistry(repo.root))).toEqual([]);
    // stopPtyHost a bien été atteint (aucun hôte ici : rien à arrêter).
    expect(result.ptyHost).toBeDefined();
  });
});

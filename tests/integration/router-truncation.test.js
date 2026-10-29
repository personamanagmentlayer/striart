/**
 * `listProjectFiles` ne tronque plus en silence à 400 fichiers avant le Router :
 * la borne est `tokens.router.tree.maxFiles` (défaut large) et, quand elle
 * coupe, la troncature est DÉCLARÉE (événement, journal, prompt) et le
 * comportement par défaut est la sérialisation prudente.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createTempRepo } from '../helpers/temp-repo.js';
import { initStriart } from '../../src/init.ts';
import { onStriartEvent } from '../../src/events.ts';
import { runTask } from '../../src/orchestrator.ts';
import { resetRootCache } from '../../src/tokens/call.ts';
import { resetUsageIndex } from '../../src/tokens/ledger.ts';

const name = (i) => `f${String(i).padStart(3, '0')}.txt`;

async function commitFiles(repo, count) {
  const paths = [];
  for (let i = 1; i <= count; i += 1) {
    await writeFile(path.join(repo.root, name(i)), `${i}\n`);
    paths.push(name(i));
  }
  await repo.git.add(paths);
  await repo.git.commit('chore: many files');
}

const trackedCount = async (repo) =>
  (await repo.git.raw(['ls-files'])).split(String.fromCharCode(10)).filter(Boolean).length;

const setConfig = (root, config) =>
  writeFile(path.join(root, '.striartrc.json'), JSON.stringify(config));

describe('Router : liste de fichiers bornée explicitement', () => {
  let repo;
  let fetchMock;

  beforeEach(async () => {
    resetUsageIndex();
    resetRootCache();
    repo = await createTempRepo();
    await initStriart(repo.root);
    fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ response: JSON.stringify({ files: [name(1)] }) }),
    }));
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await repo.cleanup();
  });

  it('plus de coupe silencieuse à 400 : un fichier nommé par la tâche au-delà du 400e atteint le Router', async () => {
    await commitFiles(repo, 450);
    const result = await runTask({
      root: repo.root,
      agent: 'agent-a',
      prompt: 'corrige le tout dernier fichier du dépôt',
    });
    expect(result.status).toBe('STARTED');
    const prompt = JSON.parse(fetchMock.mock.calls[0][1].body).prompt;
    expect(prompt).toContain(name(450));
    expect(prompt).not.toMatch(/TRUNCATED|tronquée/i);
  });

  it('au-delà de maxFiles : sérialisation prudente (sentinelle **), aucun appel LLM, troncature annoncée', async () => {
    await setConfig(repo.root, { tokens: { router: { tree: { maxFiles: 100 } } } });
    await commitFiles(repo, 150);
    const total = await trackedCount(repo);
    const events = [];
    const off = onStriartEvent((_config, e) => {
      if (e.type === 'router:tree-truncated') events.push(e);
    });

    const result = await runTask({ root: repo.root, agent: 'agent-a', prompt: 'tâche' });
    off();

    expect(result.status).toBe('STARTED');
    expect(result.predictedFiles).toEqual(['**']);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ agent: 'agent-a', kept: 100, total, policy: 'serialize' });
    expect(events[0].message).toMatch(/100/);

    // Et la tâche suivante attend : la sentinelle bloque tout agent actif.
    const second = await runTask({ root: repo.root, agent: 'agent-b', prompt: 'autre tâche' });
    expect(second.status).toBe('QUEUED');
  });

  it('predict : le LLM voit la liste coupée ET la mention de troncature', async () => {
    await setConfig(repo.root, {
      tokens: { router: { onTreeTruncated: 'predict', tree: { maxFiles: 100 } } },
    });
    await commitFiles(repo, 150);
    const total = await trackedCount(repo);

    const result = await runTask({ root: repo.root, agent: 'agent-a', prompt: 'tâche' });
    expect(result.status).toBe('STARTED');
    expect(result.predictedFiles).toEqual([name(1)]);
    const prompt = JSON.parse(fetchMock.mock.calls[0][1].body).prompt;
    expect(prompt).toMatch(/TRUNCATED|tronquée/i);
    expect(prompt).toContain(String(total));
    expect(prompt).not.toContain(name(150));
  });
});

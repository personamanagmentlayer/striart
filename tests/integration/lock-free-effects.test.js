/**
 * Invariant n°1 : le verrou principal n'est JAMAIS tenu pendant un appel LLM
 * ni réseau (revue du noyau K-I3). Router (prédiction), Memory Layer (résumé
 * du merge) et webhooks (5 s chacun) gelaient tout l'orchestrateur. Observés
 * ici par la présence de `.striart/main.lock` PENDANT chaque appel sortant.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { execa } from 'execa';
import { createTempRepo } from '../helpers/temp-repo.js';
import { initStriart } from '../../src/init.js';
import { createAgent } from '../../src/clone.js';
import { mergeAgentCommit, runTask } from '../../src/orchestrator.js';

const WEBHOOK = 'https://hooks.example.invalid/slack';
const git = (cwd, ...args) => execa('git', ['-C', cwd, ...args]).then((r) => r.stdout.trim());

describe('aucun appel LLM / réseau sous le verrou principal (intégration)', () => {
  let repo;
  /** @type {Array<{kind: 'webhook'|'llm', lockHeld: boolean}>} */
  let observed;

  beforeEach(async () => {
    repo = await createTempRepo();
    await initStriart(repo.root);
    await writeFile(
      path.join(repo.root, '.striartrc.json'),
      JSON.stringify({
        gateContainer: 'process',
        testCommand: 'node -e "process.exit(0)"',
        semanticMerge: false,
        memoryLayer: true,
        webhookUrl: WEBHOOK,
      }),
    );
    observed = [];
    const lockFile = path.join(repo.root, '.striart', 'main.lock');
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url) => {
        const lockHeld = Boolean(await stat(lockFile).catch(() => null));
        if (String(url).includes('hooks.example.invalid')) {
          observed.push({ kind: 'webhook', lockHeld });
          return { ok: true, status: 200, text: async () => 'ok', json: async () => ({}) };
        }
        observed.push({ kind: 'llm', lockHeld });
        return {
          ok: true,
          json: async () => ({ response: JSON.stringify({ files: ['feature.js'] }) }),
        };
      }),
    );
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await repo.cleanup();
  });

  it('runTask : prédiction du Router et webhook « tâche en file » hors verrou', async () => {
    const first = await runTask({ root: repo.root, agent: 'agent-a', prompt: 'ajoute feature' });
    expect(first.status).toBe('STARTED');
    const second = await runTask({
      root: repo.root,
      agent: 'agent-b',
      prompt: 'ajoute feature aussi',
    });
    expect(second.status).toBe('QUEUED');

    expect(observed.filter((o) => o.kind === 'llm')).toHaveLength(2);
    expect(observed.filter((o) => o.kind === 'webhook').length).toBeGreaterThanOrEqual(1);
    expect(observed.filter((o) => o.lockHeld)).toEqual([]);
  });

  it('mergeAgentCommit : résumé de la Memory Layer et webhook « conflit » hors verrou ; la mémoire est tout de même rapportée', async () => {
    const agent = await createAgent({ root: repo.root, name: 'agent-a' });
    await writeFile(
      path.join(agent.path, 'feature.js'),
      'export function feature() { return 1; }\n',
    );
    await git(agent.path, 'add', 'feature.js');
    await git(
      agent.path,
      '-c',
      'user.name=A',
      '-c',
      'user.email=a@example.com',
      'commit',
      '-q',
      '-m',
      'feat: feature',
    );

    const merged = await mergeAgentCommit({ root: repo.root, agent: 'agent-a' });

    expect(merged.status).toBe('MERGED');
    expect(merged.memory).toMatchObject({ updated: true });
    expect(observed.filter((o) => o.kind === 'llm').length).toBeGreaterThanOrEqual(1);

    expect(observed.filter((o) => o.lockHeld)).toEqual([]);
  });

  it('mergeAgentCommit : webhook « conflit » hors verrou', async () => {
    // Conflit : ticket + webhook.
    const other = await createAgent({ root: repo.root, name: 'agent-b' });
    await writeFile(path.join(repo.root, 'app.js'), 'const v = "main";\n');
    await git(repo.root, 'add', 'app.js');
    await git(repo.root, 'commit', '-q', '-m', 'feat: main');
    await writeFile(path.join(other.path, 'app.js'), 'const v = "agent";\n');
    await git(other.path, 'add', 'app.js');
    await git(
      other.path,
      '-c',
      'user.name=A',
      '-c',
      'user.email=a@example.com',
      'commit',
      '-q',
      '-m',
      'feat: agent',
    );
    const conflict = await mergeAgentCommit({ root: repo.root, agent: 'agent-b' });
    expect(conflict.status).toBe('CONFLICT');

    expect(observed.filter((o) => o.kind === 'webhook').length).toBeGreaterThanOrEqual(1);
    expect(observed.filter((o) => o.lockHeld)).toEqual([]);
  });
});

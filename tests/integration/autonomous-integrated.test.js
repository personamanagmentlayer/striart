/**
 * Cycle autonome dont le commit est DÉJÀ dans la branche cible (revue L1,
 * second tour, M7) : `mergeAgentCommit` rend `UP_TO_DATE { alreadyMerged }`.
 * Le travail est intégré — ce n'est pas un échec : le cycle va au nettoyage
 * (garde-fous de cleanClones, jamais de force) et rend `MERGED`, avec
 * `merge.alreadyMerged` que la CLI affiche.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { simpleGit } from 'simple-git';
import { createTempRepo } from '../helpers/temp-repo.js';
import { initStriart } from '../../src/init.js';
import { readRegistry } from '../../src/clone.js';
import { applyPlan, runAutonomousTask } from '../../src/orchestrator.js';
import { renderMergeResult } from '../../src/cli/render/results.ts';
import { autonomousOutcome } from '../../src/cli/exit.ts';
import { en } from '../../src/cli/i18n/en.ts';

const GATE_KO = 'node -e "console.error(\'jamais exécuté\'); process.exit(1)"';

/**
 * Faux agent : commite dans son clone PUIS fait avancer la branche cible du
 * principal sur ce commit (fast-forward) — le travail arrive dans la cible
 * par un autre chemin que le merge de fin de cycle.
 */
const INTEGRATING_AGENT = `
const { writeFileSync } = require('node:fs');
const { execFileSync } = require('node:child_process');
const git = (args, cwd) => execFileSync('git', args, { stdio: 'pipe', cwd }).toString().trim();
writeFileSync('feature.js', 'export const feature = 1;\\n');
git(['add', '-A']);
git(['-c', 'user.email=a@example.com', '-c', 'user.name=Agent', 'commit', '-m', 'feat: feature']);
const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']);
const main = process.env.STRIART_TEST_MAIN_ROOT;
git(['fetch', '-q', process.cwd(), branch], main);
git(['merge', '-q', '--ff-only', 'FETCH_HEAD'], main);
`;

describe('mode autonome — commit déjà intégré à la cible (intégration)', () => {
  let repo;

  beforeEach(async () => {
    repo = await createTempRepo();
    await initStriart(repo.root);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ response: JSON.stringify({ files: ['feature.js'] }) }),
      })),
    );
    const script = path.join(repo.root, '.striart', 'integrating-agent.cjs');
    await writeFile(script, INTEGRATING_AGENT);
    await writeFile(
      path.join(repo.root, '.striartrc.json'),
      JSON.stringify({
        // Gate rouge : s'il tournait (merge réel), le cycle échouerait.
        gateContainer: 'process',
        testCommand: GATE_KO,
        agentProfiles: { fake: { command: process.execPath, args: [script, '{{prompt}}'] } },
      }),
    );
    process.env.STRIART_TEST_MAIN_ROOT = repo.root;
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    delete process.env.STRIART_TEST_MAIN_ROOT;
    await repo.cleanup();
  });

  it('UP_TO_DATE alreadyMerged → MERGED, clone nettoyé sous les garde-fous, rendu CLI dédié', async () => {
    const result = await runAutonomousTask({
      root: repo.root,
      agent: 'agent-a',
      prompt: 'ajoute une feature',
      profile: 'fake',
    });

    expect(result.merge).toMatchObject({ status: 'UP_TO_DATE', alreadyMerged: true });
    expect(result.status).toBe('MERGED');
    expect(autonomousOutcome(result.status)).toBe('ok');
    expect(result.cleaned).toBe(true);
    expect(result.keptReason).toBeNull();
    // Succès BRUYANT (K-I2) : l'avertissement est dans le résultat, rien n'est tu.
    expect(result.warnings).toEqual(['ALREADY_INTEGRATED']);
    expect(result.merge.mergeSha).toBe((await simpleGit(repo.root).revparse(['HEAD'])).trim());
    expect(await readRegistry(repo.root)).toEqual({});
    expect(await stat(result.clonePath).catch(() => null)).toBeNull();
    // Le travail est bien dans la cible (arrivé par le fast-forward de l'agent).
    expect(await readFile(path.join(repo.root, 'feature.js'), 'utf8')).toContain('feature');

    // Rendu humain : un message dédié, pas le « déjà à jour » générique.
    const lines = [];
    const out = {
      m: en,
      line: (_level, text) => lines.push(text),
      detail: (text) => lines.push(text),
    };
    renderMergeResult(out, result.merge);
    expect(lines.join('\n')).toMatch(/already in the target branch/);
  });

  it('plan v1 : le résultat de la tâche autonome transmet warnings (ALREADY_INTEGRATED) et errorCode', async () => {
    const planText = [
      'version: 1',
      'tasks:',
      '  - id: t1',
      '    agent: agent-a',
      '    prompt: ajoute une feature',
      '    autonomous: true',
      '    profile: fake',
      '',
    ].join('\n');

    const result = await applyPlan({ root: repo.root, planText });

    expect(result.results).toHaveLength(1);
    expect(result.results[0]).toMatchObject({
      id: 't1',
      status: 'MERGED',
      warnings: ['ALREADY_INTEGRATED'],
      errorCode: null,
    });
  });
});

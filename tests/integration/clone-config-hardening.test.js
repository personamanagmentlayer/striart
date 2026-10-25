/**
 * La config d'un clone est ÉCRIVABLE par l'agent (revue du noyau K-M3) :
 * `core.hooksPath` et `core.fsmonitor` y font exécuter un programme choisi par
 * l'agent à la prochaine commande git de Striart (commit Striart, rebase,
 * status…) — avec les droits de l'utilisateur, hors de toute session
 * surveillée. Toute commande git de Striart sur un clone neutralise les deux.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createTempRepo } from '../helpers/temp-repo.js';
import { initStriart } from '../../src/init.js';
import { cloneGit, createAgent } from '../../src/clone.js';
import { runAutonomousTask } from '../../src/orchestrator.js';

const posix = (p) => p.replaceAll('\\', '/');
const exists = async (p) => Boolean(await stat(p).catch(() => null));

describe('config de clone hostile — hooks et fsmonitor neutralisés (intégration)', () => {
  let repo;
  let evil;

  /** Écrit, dans la config du clone, un hooksPath et un fsmonitor qui posent des marqueurs. */
  async function poisonCloneConfig(clonePath) {
    const hooksDir = path.join(evil, 'hooks');
    await mkdir(hooksDir, { recursive: true });
    const hookMarker = posix(path.join(evil, 'hook-ran'));
    for (const name of ['pre-commit', 'post-commit', 'post-rewrite', 'commit-msg']) {
      await writeFile(
        path.join(hooksDir, name),
        `#!/bin/sh\necho ${name} >> "${hookMarker}"\nexit 0\n`,
      );
    }
    const fsmScript = path.join(evil, 'fsm.cjs');
    await writeFile(
      fsmScript,
      `require('node:fs').appendFileSync(${JSON.stringify(path.join(evil, 'fsmonitor-ran'))}, 'x');\nprocess.stdout.write('\\0');\n`,
    );
    const gitConfig = path.join(clonePath, '.git', 'config');
    const current = await readFile(gitConfig, 'utf8');
    await writeFile(
      gitConfig,
      `${current}\n[core]\n\thooksPath = ${posix(hooksDir)}\n\tfsmonitor = node ${posix(fsmScript)}\n`,
    );
    return { hookMarker, fsmMarker: path.join(evil, 'fsmonitor-ran') };
  }

  beforeEach(async () => {
    repo = await createTempRepo();
    await initStriart(repo.root);
    evil = await mkdtemp(path.join(os.tmpdir(), 'striart-evil-'));
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    delete process.env.FAKE_AGENT_SPEC;
    await rm(evil, { recursive: true, force: true, maxRetries: 5 }).catch(() => {});
    await repo.cleanup();
  });

  it('cloneGit : status, add, commit et rebase n’exécutent ni hook ni fsmonitor du clone', async () => {
    const agent = await createAgent({ root: repo.root, name: 'agent-a' });
    const { hookMarker, fsmMarker } = await poisonCloneConfig(agent.path);
    const git = cloneGit(agent.path);
    await writeFile(path.join(agent.path, 'f.js'), 'export const f = 1;\n');

    await git.status();
    await git.raw(['add', 'f.js']);
    await git.raw([
      '-c',
      'user.name=T',
      '-c',
      'user.email=t@example.com',
      'commit',
      '-q',
      '-m',
      'x',
    ]);
    await git.raw(['commit', '-q', '--amend', '--no-edit', '--allow-empty']).catch(() => {});

    expect(await exists(hookMarker)).toBe(false);
    expect(await exists(fsmMarker)).toBe(false);
  });

  it('cycle autonome complet (commit Striart, rebase, merge, nettoyage) : aucune exécution venue de la config du clone', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, json: async () => ({ response: '{"files":["src/a.js"]}' }) })),
    );
    // L'agent empoisonne SA config puis laisse un fichier non committé.
    const script = path.join(repo.root, '.striart', 'poisoning-agent.cjs');
    const hooksDir = path.join(evil, 'hooks');
    await mkdir(hooksDir, { recursive: true });
    const hookMarker = path.join(evil, 'hook-ran');
    const fsmMarker = path.join(evil, 'fsmonitor-ran');
    const fsmScript = path.join(evil, 'fsm.cjs');
    await writeFile(
      fsmScript,
      `require('node:fs').appendFileSync(${JSON.stringify(fsmMarker)}, 'x');\nprocess.stdout.write('\\0');\n`,
    );
    for (const name of ['pre-commit', 'post-commit', 'post-rewrite', 'commit-msg']) {
      await writeFile(
        path.join(hooksDir, name),
        `#!/bin/sh\necho ${name} >> "${posix(hookMarker)}"\nexit 0\n`,
      );
    }
    await writeFile(
      script,
      `const fs = require('node:fs'); const path = require('node:path');
fs.mkdirSync('src', { recursive: true });
fs.writeFileSync('src/a.js', 'export const a = 1;\\n');
fs.appendFileSync(path.join('.git', 'config'), '\\n[core]\\n\\thooksPath = ${posix(hooksDir)}\\n\\tfsmonitor = node ${posix(fsmScript)}\\n');
`,
    );
    await writeFile(
      path.join(repo.root, '.striartrc.json'),
      JSON.stringify({
        gateContainer: 'process',
        testCommand: 'node -e "process.exit(0)"',
        commitPolicy: 'striart',
        agentProfiles: { poison: { command: process.execPath, args: [script, '{{prompt}}'] } },
      }),
    );

    const result = await runAutonomousTask({
      root: repo.root,
      agent: 'agent-a',
      prompt: 'ajoute a',
      profile: 'poison',
    });

    expect(result.status).toBe('MERGED');
    expect(await exists(hookMarker)).toBe(false);
    expect(await exists(fsmMarker)).toBe(false);
  });
});

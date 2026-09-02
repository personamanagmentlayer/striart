import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTempRepo } from '../helpers/temp-repo.js';
import { initStriart } from '../../src/init.js';
import { createAgent } from '../../src/clone.js';
import { runAgentSession } from '../../src/session.js';
import { applyPlan, runAutonomousTask } from '../../src/orchestrator.js';

const FAKE_AGENT = fileURLToPath(new URL('../helpers/fake-agent.cjs', import.meta.url));

function mockRouter(files) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ ok: true, json: async () => ({ response: JSON.stringify({ files }) }) })),
  );
}

describe('profils enrichis (env + timeout par profil)', () => {
  let repo;

  beforeEach(async () => {
    repo = await createTempRepo();
    await initStriart(repo.root);
    mockRouter(['feature.js']);
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await repo.cleanup();
  });

  it("profile.env atteint le process enfant (cloisonnement d'une clé par outil)", async () => {
    // runAgentSession en direct : pas de merge/clean, le clone survit et on
    // peut lire ce que l'agent a écrit avec la variable du PROFIL.
    const info = await createAgent({ root: repo.root, name: 'agent-a' });
    const session = await runAgentSession({
      root: repo.root,
      agent: 'agent-a',
      taskId: info.taskId,
      cwd: info.path,
      profile: {
        command: process.execPath,
        args: [FAKE_AGENT, '{{prompt}}'],
        env: { STRIART_PROFILE_ENV_PROBE: 'valeur-du-profil' },
      },
      prompt: 'tâche',
    });
    expect(session.status).toBe('COMPLETED');
    const probe = await readFile(path.join(info.path, 'profile-env-probe.txt'), 'utf8');
    expect(probe).toBe('valeur-du-profil');
  });

  it('profile.timeout prime sur le global (une session bloquée est tuée à SON délai)', async () => {
    // Profil au délai court + faux agent qui ne sort jamais → TIMEOUT rapide,
    // ce qui PROUVE que profile.timeout (1500 ms) l'emporte sur le global
    // (autonomousTimeoutMs, 30 min par défaut). Sinon le test durerait 30 min.
    await writeFile(
      path.join(repo.root, '.striartrc.json'),
      JSON.stringify({
        testCommand: 'node -e "process.exit(0)"',
        agentProfiles: {
          lent: {
            command: process.execPath,
            args: [FAKE_AGENT, '{{prompt}}'],
            env: { FAKE_AGENT_MODE: 'hang' },
            timeout: 1500,
          },
        },
      }),
    );

    const startedAt = Date.now();
    const result = await runAutonomousTask({
      root: repo.root,
      agent: 'agent-a',
      prompt: 'boucle sans fin',
      profile: 'lent',
    });
    const elapsed = Date.now() - startedAt;

    expect(result.session.timedOut).toBe(true);
    expect(result.session.status).toBe('TIMEOUT');
    expect(result.status).toBe('SESSION_FAILED');
    // Tué à ~1,5 s, très loin des 30 min du global : la précédence est prouvée.
    expect(elapsed).toBeLessThan(20_000);
  });

  it('un plan multi-IA citant un profil inconnu échoue AVANT tout lancement', async () => {
    await writeFile(
      path.join(repo.root, '.striartrc.json'),
      JSON.stringify({ agentProfiles: { fake: { command: 'node', args: ['{{prompt}}'] } } }),
    );
    const planText = `
version: 1
tasks:
  - id: a
    prompt: première tâche
    autonomous: true
    profile: fake
  - id: b
    prompt: deuxième tâche
    autonomous: true
    profile: ia-qui-n-existe-pas
`;
    // Même en --dry-run : le nom d'IA mal orthographié doit tomber à la revue.
    await expect(applyPlan({ root: repo.root, planText, dryRun: true })).rejects.toMatchObject({
      code: 'PROFILE_UNKNOWN',
    });
    // Et à l'application : aucune tâche ne part (validation avant effet de bord).
    const { readRegistry } = await import('../../src/clone.js');
    await expect(applyPlan({ root: repo.root, planText })).rejects.toMatchObject({
      code: 'PROFILE_UNKNOWN',
    });
    expect(await readRegistry(repo.root)).toEqual({});
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// Le domaine est simulé : seul compte le calcul de l'issue par la commande.
const applyPlan = vi.fn();
vi.mock('../../src/orchestrator.js', () => ({ applyPlan: (...args) => applyPlan(...args) }));
vi.mock('../../src/pty-host.ts', () => ({ openAttendedSession: async () => ({}) }));

const { plan } = await import('../../src/cli/commands/plan.ts');
const { fr } = await import('../../src/cli/i18n/fr.ts');

describe('striart plan : issue d’un plan interrompu', () => {
  let dir;
  let ctx;
  let ctrl;

  beforeEach(async () => {
    ctrl = new AbortController();
    dir = await mkdtemp(path.join(os.tmpdir(), 'striart-plan-cmd-'));
    await writeFile(path.join(dir, 'plan.yaml'), 'version: 1\ntasks: []\n');
    ctx = {
      cwd: dir,
      m: fr,
      signal: ctrl.signal,
      repoRoot: async () => dir,
      out: { task: (_label, fn) => fn() },
    };
  });

  afterEach(async () => {
    applyPlan.mockReset();
    await rm(dir, { recursive: true, force: true });
  });

  // Avant : l'issue ne regardait que les tâches autonomes appliquées — un
  // Ctrl+C pendant une tâche supervisée rendait `ok: true` en --json.
  it('des tâches non appliquées → issue en échec, jamais ok', async () => {
    applyPlan.mockResolvedValue({
      dryRun: false,
      tasks: [],
      results: [{ id: 'a', agent: 'agent-a', mode: 'attended', status: 'STARTED', info: null }],
      interrupted: true,
      notApplied: [{ id: 'b', agent: 'agent-b' }],
    });
    const result = await plan.execute(ctx, { file: 'plan.yaml', dryRun: false });
    expect(result.outcome).toBe('failed');
    // Le signal transmis est dérivé (AbortSignal.any : annulation de l'utilisateur OU échec d'ouverture d'une session supervisée).
    const { signal } = applyPlan.mock.calls[0][0];
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(signal.aborted).toBe(false);
    ctrl.abort();
    expect(signal.aborted).toBe(true);
  });

  it('plan complet → ok', async () => {
    applyPlan.mockResolvedValue({
      dryRun: false,
      tasks: [],
      results: [],
      interrupted: false,
      notApplied: [],
    });
    const result = await plan.execute(ctx, { file: 'plan.yaml', dryRun: false });
    expect(result.outcome).toBe('ok');
  });
});

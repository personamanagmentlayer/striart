/**
 * Une session autonome arrêtée par un plafond de tokens (`BUDGET_EXCEEDED`,
 * lot T) traverse le chemin « session non COMPLETED » du cycle : rien n'est
 * mergé, le clone est conservé, l'événement `session:failed` porte le vrai
 * statut, et la raison dit quel plafond a été franchi et quoi faire.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTempRepo } from '../helpers/temp-repo.js';
import { initStriart } from '../../src/init.js';
import { onStriartEvent } from '../../src/events.js';
import { runAutonomousTask } from '../../src/orchestrator.js';
import { resetUsageIndex } from '../../src/tokens/ledger.ts';
import { resetAlertDedup } from '../../src/tokens/budget.ts';
import { resetRootCache } from '../../src/tokens/call.ts';

const USAGE_AGENT = fileURLToPath(new URL('../helpers/fake-usage-agent.cjs', import.meta.url));

describe('mode autonome — session arrêtée par un plafond de tokens', () => {
  let repo;

  beforeEach(async () => {
    resetUsageIndex();
    resetAlertDedup();
    resetRootCache();
    repo = await createTempRepo();
    await initStriart(repo.root);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ response: JSON.stringify({ files: ['feature.js'] }) }),
      })),
    );
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await repo.cleanup();
  });

  it('SESSION_FAILED / BUDGET_EXCEEDED : clone conservé, rien de mergé, raison actionnable', async () => {
    await writeFile(
      path.join(repo.root, '.striartrc.json'),
      JSON.stringify({
        testCommand: 'node -e "process.exit(0)"',
        tokens: { budgets: { perTask: { maxTokens: 3000 } } },
        agentProfiles: {
          usage: {
            command: process.execPath,
            args: [USAGE_AGENT, '200', 'claude', '{{prompt}}'],
            structuredOutput: 'claude-stream-json',
            instructions: { channel: 'none' },
          },
        },
      }),
    );
    const events = [];
    const off = onStriartEvent((_c, e) => {
      if (e.type === 'session:failed') events.push(e);
    });

    const result = await runAutonomousTask({
      root: repo.root,
      agent: 'agent-b',
      prompt: 'tâche coûteuse',
      profile: 'usage',
    });
    off();

    expect(result.session.status).toBe('BUDGET_EXCEEDED');
    expect(result.session.budget).toMatchObject({ scope: 'perTask', limit: 3000 });
    expect(result).toMatchObject({
      status: 'SESSION_FAILED',
      keptCode: 'SESSION_FAILED',
      keptDetail: 'BUDGET_EXCEEDED',
      cleaned: false,
      merge: null,
    });
    expect(result.keptReason).toMatch(/budget/i);
    expect(result.keptReason).toContain('striart usage');
    expect(await stat(result.clonePath).catch(() => null)).not.toBeNull();
    // L'événement porte le VRAI statut (pas « FAILED »).
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ agent: 'agent-b', status: 'BUDGET_EXCEEDED' });
    expect(events[0].message).toContain('striart usage');
  });
});

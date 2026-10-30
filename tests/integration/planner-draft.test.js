import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { draftPlan } from '../../src/orchestration/planner.ts';

/**
 * Planner (lot O, priorité 3) : tourne un objectif en plan v2, validé par
 * l'exact même chemin qu'un plan écrit à la main. Ne lance jamais un agent,
 * ne mute jamais le dépôt.
 */
describe('Planner — draftPlan', () => {
  let root;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'striart-planner-'));
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await rm(root, { recursive: true, force: true });
  });

  const config = {
    agentProfiles: { dev: { command: 'node', args: [] } },
    ollamaModel: 'llama3.1:8b',
    ollamaHost: 'http://localhost:11434',
  };

  const stubPlannerResponse = (body) =>
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ response: JSON.stringify(body) }),
      })),
    );

  it('produit un plan v2 validé, avec estimation et notes', async () => {
    stubPlannerResponse({
      version: 2,
      mode: 'sequential',
      tasks: [
        {
          id: 'a',
          agent: 'a',
          prompt: 'Add pagination. Verify with: npm test.',
          autonomous: true,
          profile: 'dev',
        },
      ],
      notes: ['assumes the API already has a stable endpoint'],
    });
    const draft = await draftPlan({ root, config, objective: 'Add pagination to the API' });
    expect(draft.plan.version).toBe(2);
    expect(draft.plan.tasks).toHaveLength(1);
    expect(draft.estimate.tasks).toBe(1);
    expect(draft.estimate.estimatedPromptTokens).toBeGreaterThan(0);
    expect(draft.notes).toEqual(['assumes the API already has a stable endpoint']);
    expect(draft.yaml).toContain('version: 2');
  });

  it('refuse un objectif trop ambigu plutôt que de deviner', async () => {
    stubPlannerResponse({ refused: 'the objective does not state what "done" means' });
    await expect(draftPlan({ root, config, objective: 'make it better' })).rejects.toMatchObject({
      code: 'PLANNER_REFUSED',
      details: { reason: 'the objective does not state what "done" means' },
    });
  });

  it('refuse un profil inventé — même validateur qu’un plan écrit à la main', async () => {
    stubPlannerResponse({
      version: 2,
      mode: 'sequential',
      tasks: [
        {
          id: 'a',
          agent: 'a',
          prompt: 'Do the thing. Verify with: npm test.',
          autonomous: true,
          profile: 'nonexistent',
        },
      ],
    });
    await expect(draftPlan({ root, config, objective: 'do the thing' })).rejects.toMatchObject({
      code: 'PROFILE_UNKNOWN',
    });
  });

  it('sans profil configuré, refuse avant le moindre appel LLM', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(
      draftPlan({ root, config: { agentProfiles: {} }, objective: 'do anything' }),
    ).rejects.toMatchObject({ code: 'PLANNER_FAILED', details: { reason: 'NO_PROFILES' } });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

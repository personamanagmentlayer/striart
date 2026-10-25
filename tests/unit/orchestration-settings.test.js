import { describe, expect, it } from 'vitest';
import { validateConfig } from '../../src/config.js';
import {
  DEFAULT_COLLAB_SETTINGS,
  DEFAULT_ORCHESTRATION_SETTINGS,
  orchestrationRelaxations,
  resolveCollabSettings,
  resolveOrchestrationSettings,
} from '../../src/orchestration/settings.ts';
import { llmConfigForRole } from '../../src/orchestration/llm-roles.ts';

/**
 * Réglages du lot O : objets PARTIELS côté utilisateur, fusionnés en
 * profondeur avec des défauts sûrs, validés au chargement (clé inconnue
 * refusée). Tout relâchement est listé pour `striart doctor`.
 */
describe('réglages d’orchestration', () => {
  it('défauts sûrs', () => {
    const s = resolveOrchestrationSettings({});
    expect(s).toEqual(DEFAULT_ORCHESTRATION_SETTINGS);
    expect(s.onFailure).toBe('stop');
    expect(s.collisionPolicy).toBe('wait');
    expect(s.review.reviewerWrites).toBe('fail');
    expect(s.race.losers).toBe('keep');
    expect(s.race.pick).toBe('first-green');
    expect(s.team.cadence).toBe('turns');
    expect(s.pipeline.handoff).toBe('merge');
    expect(orchestrationRelaxations({})).toEqual([]);
  });

  it('fusion en profondeur : surcharger un sous-réglage garde les autres', () => {
    const s = resolveOrchestrationSettings({ orchestration: { review: { maxRounds: 5 } } });
    expect(s.review.maxRounds).toBe(5);
    expect(s.review.quorum).toBe('all');
    expect(s.concurrency).toBe(DEFAULT_ORCHESTRATION_SETTINGS.concurrency);
  });

  it('validation au chargement : clé inconnue, valeur hors liste, bornes', () => {
    const invalid = (orchestration) =>
      expect(() => validateConfig({ orchestration })).toThrowError(/orchestration/);
    invalid({ concurency: 2 });
    invalid({ concurrency: 0 });
    invalid({ concurrency: 9, maxConcurrency: 8 });
    invalid({ review: { quorum: 'most' } });
    invalid({ race: { losers: 'delete' } });
    invalid({ team: { cadence: 'dynamic' } });
    invalid({ pollIntervalMs: 10 });
    expect(() =>
      validateConfig({ orchestration: { concurrency: 4, review: { maxRounds: 2 } } }),
    ).not.toThrow();
  });

  it('relâchements listés : perdants supprimés, écritures du relecteur jetées', () => {
    const keys = orchestrationRelaxations({
      orchestration: { race: { losers: 'clean' }, review: { reviewerWrites: 'discard' } },
      collab: { logMarkers: true },
    }).map((r) => r.key);
    expect(keys).toEqual(['orchestration.race.losers', 'orchestration.review.reviewerWrites']);
  });
});

describe('réglages du canal de collaboration', () => {
  it('défauts et fusion', () => {
    expect(resolveCollabSettings({})).toEqual(DEFAULT_COLLAB_SETTINGS);
    expect(resolveCollabSettings({ collab: { maxMessages: 10 } }).maxMessages).toBe(10);
  });

  it('validation : bornes et clés', () => {
    expect(() => validateConfig({ collab: { maxBodyBytes: 10 } })).toThrowError(/collab/);
    expect(() => validateConfig({ collab: { enabeld: false } })).toThrowError(/collab/);
    expect(() => validateConfig({ collab: { enabled: false } })).not.toThrow();
  });
});

describe('LLM par rôle', () => {
  it('un rôle absent replie sur le bloc global, un rôle défini le remplace', () => {
    const global = { provider: 'ollama', model: 'qwen' };
    const judge = { provider: 'anthropic', model: 'claude', apiKeyEnv: 'ANTHROPIC_API_KEY' };
    const config = { llm: global, llmRoles: { judge } };
    expect(llmConfigForRole(config, 'router').llm).toBe(global);
    expect(llmConfigForRole(config, 'judge').llm).toBe(judge);
  });

  it('validation : rôle inconnu refusé', () => {
    expect(() => validateConfig({ llmRoles: { planner: null } })).toThrowError(/llmRoles/);
    expect(() =>
      validateConfig({ llmRoles: { judge: { provider: 'ollama', model: 'x' } } }),
    ).not.toThrow();
  });
});

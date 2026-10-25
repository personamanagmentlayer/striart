import { describe, expect, it } from 'vitest';
import { autonomousOutcome, orchestrationOutcome } from '../../src/cli/exit.ts';
import { en } from '../../src/cli/i18n/en.ts';
import { fr } from '../../src/cli/i18n/fr.ts';

/**
 * Une session arrêtée par un plafond de tokens (`BUDGET_EXCEEDED`) traverse le
 * chemin « session non COMPLETED » : status SESSION_FAILED, keptDetail
 * 'BUDGET_EXCEEDED'. Le rendu doit dire CE QUI S'EST PASSÉ (budget franchi),
 * que le clone est conservé, et la commande qui permet d'agir (`striart usage`).
 */
describe('BUDGET_EXCEEDED : rendu et issue', () => {
  it('CLI fr/en : raison dédiée, clone conservé, commande `striart usage`', () => {
    for (const catalog of [fr, en]) {
      const text = catalog.run.kept('SESSION_FAILED', 'BUDGET_EXCEEDED');
      expect(text).toContain('striart usage');
      expect(text).not.toBe(catalog.run.kept('SESSION_FAILED', 'FAILED'));
    }
    expect(fr.run.kept('SESSION_FAILED', 'BUDGET_EXCEEDED')).toMatch(/budget|plafond/i);
    expect(fr.run.kept('SESSION_FAILED', 'BUDGET_EXCEEDED')).toMatch(/clone conservé/);
    expect(en.run.kept('SESSION_FAILED', 'BUDGET_EXCEEDED')).toMatch(/budget/i);
    expect(en.run.kept('SESSION_FAILED', 'BUDGET_EXCEEDED')).toMatch(/clone kept/);
  });

  it('un échec de session ordinaire garde son rendu historique', () => {
    expect(fr.run.kept('SESSION_FAILED', 'TIMEOUT')).toBe(
      'session TIMEOUT — clone conservé pour diagnostic.',
    );
    expect(en.run.kept('SESSION_FAILED', 'TIMEOUT')).toBe(
      'session TIMEOUT — clone kept for diagnosis.',
    );
  });

  it('proxy ACP fr/en : raison dédiée avec `striart usage`', () => {
    for (const catalog of [fr, en]) {
      const reasons = catalog.acpProxy.keptReasons;
      expect(reasons.SESSION_FAILED('BUDGET_EXCEEDED')).toContain('striart usage');
      expect(reasons.SESSION_FAILED('FAILED')).not.toContain('striart usage');
    }
  });

  it('issue : un plafond qui arrête la session est un REFUS (sortie 3), pas une panne', () => {
    expect(autonomousOutcome('SESSION_FAILED', 'BUDGET_EXCEEDED')).toBe('refused');
    expect(autonomousOutcome('SESSION_FAILED', 'TIMEOUT')).toBe('failed');
    expect(autonomousOutcome('SESSION_FAILED')).toBe('failed');
    expect(autonomousOutcome('SESSION_FAILED', null)).toBe('failed');
  });

  it('nœud orchestré : même issue (refus) quand la session d’un tour est arrêtée par un plafond', () => {
    for (const detail of [
      'BUDGET_EXCEEDED',
      'SESSION_FAILED:BUDGET_EXCEEDED',
      'step-1:BUDGET_EXCEEDED',
    ]) {
      expect(orchestrationOutcome('SESSION_FAILED', detail)).toBe('refused');
    }
    expect(orchestrationOutcome('SESSION_FAILED', 'TIMEOUT')).toBe('failed');
    expect(orchestrationOutcome('SESSION_FAILED')).toBe('failed');
    expect(orchestrationOutcome('MERGE_BLOCKED')).toBe('refused');
    expect(orchestrationOutcome('MERGED', 'BUDGET_EXCEEDED')).toBe('ok');
  });
});

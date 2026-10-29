/**
 * Revue du noyau (K-M7) :
 *  - une clé de PREMIER niveau inconnue (faute de frappe : `testComand`,
 *    `commitPolcy`) était tolérée en silence — la protection visée restait à son
 *    défaut sans que personne le voie. Elle est refusée (CONFIG_INVALID,
 *    reason UNKNOWN_KEY) ; `unknownConfigKeys: 'warn'` est le relâchement
 *    explicite (journalisé, affiché par doctor) ;
 *  - les délais n'avaient pas de borne haute : au-delà de 2^31-1 ms, setTimeout
 *    arme un délai de 1 ms (le Test Gate ou la session était tué aussitôt).
 */
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_CONFIG, validateConfig } from '../../src/config.ts';
import { StriartError } from '../../src/errors.ts';
import { logger } from '../../src/logger.ts';
import { parsePlan } from '../../src/plan.ts';
import { collectRelaxations } from '../../src/doctor-relaxations.ts';

const MAX_TIMER_MS = 2_147_483_647;

describe('validateConfig — clés de premier niveau inconnues', () => {
  it('refuse une faute de frappe, nomme la clé et propose la plus proche', () => {
    let error;
    try {
      validateConfig({ testComand: 'pytest' });
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(StriartError);
    expect(error).toMatchObject({
      code: 'CONFIG_INVALID',
      details: { reason: 'UNKNOWN_KEY', key: 'testComand', suggestion: 'testCommand' },
    });
    expect(() => validateConfig({ commitPolcy: 'human' })).toThrow(/commitPolcy/);
  });

  it('refuse sans suggestion quand rien ne ressemble à la clé', () => {
    let error;
    try {
      validateConfig({ futureOption: 123 });
    } catch (e) {
      error = e;
    }
    expect(error).toMatchObject({
      code: 'CONFIG_INVALID',
      details: { reason: 'UNKNOWN_KEY', key: 'futureOption' },
    });
    expect(error.details.suggestion ?? null).toBeNull();
  });

  it('tolère $schema (référence de schéma JSON de l’éditeur)', () => {
    expect(() => validateConfig({ $schema: 'https://example.invalid/s.json' })).not.toThrow();
  });

  it('chaque clé des défauts est une clé connue', () => {
    for (const key of Object.keys(DEFAULT_CONFIG)) {
      try {
        validateConfig({ [key]: DEFAULT_CONFIG[key] });
      } catch (error) {
        // Une valeur par défaut peut être refusée par son validateur (forme
        // brute) ; elle ne doit jamais l'être comme clé INCONNUE.
        expect(error.details?.reason, key).not.toBe('UNKNOWN_KEY');
      }
    }
  });

  it("unknownConfigKeys: 'warn' : accepte, journalise chaque clé inconnue", () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    try {
      expect(() =>
        validateConfig({ unknownConfigKeys: 'warn', futureOption: 1, autreOption: 2 }),
      ).not.toThrow();
      const keys = warn.mock.calls.map((call) => call[0]?.key).filter(Boolean);
      expect(keys.sort()).toEqual(['autreOption', 'futureOption']);
    } finally {
      warn.mockRestore();
    }
  });

  it('unknownConfigKeys : valeur hors liste refusée', () => {
    expect(() => validateConfig({ unknownConfigKeys: 'ignore' })).toThrow(StriartError);
    expect(() => validateConfig({ unknownConfigKeys: true })).toThrow(StriartError);
  });

  it("le relâchement 'warn' apparaît dans les protections relâchées de doctor", () => {
    const report = collectRelaxations({ config: { unknownConfigKeys: 'warn' } });
    expect(report.names).toContain('unknownConfigKeys');
    expect(collectRelaxations({ config: { unknownConfigKeys: 'error' } }).names).not.toContain(
      'unknownConfigKeys',
    );
  });
});

describe('délais bornés à la limite de setTimeout (2^31-1 ms)', () => {
  it.each(['testTimeoutMs', 'autonomousTimeoutMs'])('%s : borne haute', (key) => {
    expect(() => validateConfig({ [key]: MAX_TIMER_MS })).not.toThrow();
    expect(() => validateConfig({ [key]: MAX_TIMER_MS + 1 })).toThrow(StriartError);
    expect(() => validateConfig({ [key]: 2 ** 40 })).toThrow(StriartError);
    expect(() => validateConfig({ [key]: 999 })).toThrow(StriartError);
  });

  it('timeout d’un profil d’agent : même borne', () => {
    const profile = (timeout) => ({
      agentProfiles: { p: { command: 'x', args: ['{{prompt}}'], timeout } },
    });
    expect(() => validateConfig(profile(MAX_TIMER_MS))).not.toThrow();
    expect(() => validateConfig(profile(MAX_TIMER_MS + 1))).toThrow(StriartError);
  });

  it('timeout d’une tâche de plan (v1) : même borne', () => {
    const plan = (timeout) =>
      `version: 1\ntasks:\n  - prompt: x\n    autonomous: true\n    timeout: ${timeout}\n`;
    expect(() => parsePlan(plan(MAX_TIMER_MS))).not.toThrow();
    expect(() => parsePlan(plan(MAX_TIMER_MS + 1))).toThrow(StriartError);
  });
});

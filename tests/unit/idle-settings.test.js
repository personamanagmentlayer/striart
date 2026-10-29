import { describe, expect, it } from 'vitest';
import {
  DEFAULT_IDLE_SETTINGS,
  IDLE_BOUNDS,
  idleRelaxations,
  idleSettingsProblem,
  isAgentExcluded,
  isValidIdleSettings,
  resolveIdleSettings,
} from '../../src/idle/settings.ts';
import { collectRelaxations } from '../../src/doctor-relaxations.ts';
import { validateUserConfig } from '../../src/user-config.ts';
import { errorKindOf } from '../../src/errors.ts';

describe('idle : réglages', () => {
  it('défauts conservateurs : détection et rapport, fermeture NON activée', () => {
    expect(DEFAULT_IDLE_SETTINGS).toMatchObject({
      enabled: true,
      action: 'report',
      warnAfterMs: 30 * 60_000,
      closeAfterMs: 2 * 3_600_000,
      graceMs: 5 * 60_000,
      closePty: false,
      excludeAgents: [],
      excludeProfiles: [],
    });
    expect(resolveIdleSettings({})).toEqual(DEFAULT_IDLE_SETTINGS);
    expect(resolveIdleSettings(undefined)).toEqual(DEFAULT_IDLE_SETTINGS);
  });

  it('objet partiel fusionné aux défauts, sans partager les tableaux des défauts', () => {
    const resolved = resolveIdleSettings({ idle: { action: 'warn', excludeAgents: ['a*'] } });
    expect(resolved.action).toBe('warn');
    expect(resolved.warnAfterMs).toBe(DEFAULT_IDLE_SETTINGS.warnAfterMs);
    resolved.excludeProfiles.push('x');
    expect(DEFAULT_IDLE_SETTINGS.excludeProfiles).toEqual([]);
  });

  it('clé inconnue refusée (une faute de frappe sur un garde-fou ne passe pas)', () => {
    expect(isValidIdleSettings({ closeAfterMS: 5 })).toBe(false);
    expect(idleSettingsProblem({ closeAfterMS: 5 })).toMatch(/closeAfterMS/);
  });

  it('refuse un type ou une action invalide', () => {
    expect(isValidIdleSettings(null)).toBe(false);
    expect(isValidIdleSettings([])).toBe(false);
    expect(isValidIdleSettings({ enabled: 'yes' })).toBe(false);
    expect(isValidIdleSettings({ closePty: 1 })).toBe(false);
    expect(isValidIdleSettings({ action: 'kill' })).toBe(false);
    expect(isValidIdleSettings({ action: 'close' })).toBe(true);
  });

  it('bornes : plancher ET plafond de chaque durée, entiers seulement', () => {
    for (const [key, [min, max]] of Object.entries(IDLE_BOUNDS)) {
      const cross =
        key === 'closeAfterMs'
          ? { warnAfterMs: min }
          : key === 'warnAfterMs'
            ? { closeAfterMs: IDLE_BOUNDS.closeAfterMs[1] }
            : {};
      expect(isValidIdleSettings({ ...cross, [key]: min }), `${key} plancher`).toBe(true);
      expect(isValidIdleSettings({ ...cross, [key]: max }), `${key} plafond`).toBe(true);
      expect(isValidIdleSettings({ ...cross, [key]: min - 1 }), `${key} sous le plancher`).toBe(
        false,
      );
      expect(isValidIdleSettings({ ...cross, [key]: max + 1 }), `${key} au-dessus`).toBe(false);
      expect(isValidIdleSettings({ ...cross, [key]: min + 0.5 }), `${key} non entier`).toBe(false);
      expect(isValidIdleSettings({ ...cross, [key]: '1000000' }), `${key} chaîne`).toBe(false);
      expect(isValidIdleSettings({ ...cross, [key]: Number.NaN }), `${key} NaN`).toBe(false);
    }
  });

  it('closeAfterMs ne peut pas précéder warnAfterMs (contrôle croisé, défauts compris)', () => {
    expect(isValidIdleSettings({ warnAfterMs: 3_600_000, closeAfterMs: 1_800_000 })).toBe(false);
    // warnAfterMs relevé seul au-delà du défaut de closeAfterMs (2 h).
    expect(isValidIdleSettings({ warnAfterMs: 3 * 3_600_000 })).toBe(false);
    expect(isValidIdleSettings({ warnAfterMs: 3_600_000, closeAfterMs: 3_600_000 })).toBe(true);
  });

  it('exclusions : noms ou préfixes « nom* », jamais « * » seul, plafonnées', () => {
    expect(isValidIdleSettings({ excludeAgents: ['agent-a', 'review-*'] })).toBe(true);
    expect(isValidIdleSettings({ excludeAgents: ['*'] })).toBe(false);
    expect(isValidIdleSettings({ excludeAgents: ['../x'] })).toBe(false);
    expect(isValidIdleSettings({ excludeAgents: 'agent-a' })).toBe(false);
    expect(isValidIdleSettings({ excludeAgents: Array.from({ length: 129 }, () => 'a') })).toBe(
      false,
    );
    expect(isValidIdleSettings({ excludeProfiles: ['claude', 'my.profile'] })).toBe(true);
    expect(isValidIdleSettings({ excludeProfiles: ['a b'] })).toBe(false);
  });

  it('isAgentExcluded : exact ou préfixe, insensible à la casse', () => {
    const s = resolveIdleSettings({ idle: { excludeAgents: ['Keep', 'rev-*'] } });
    expect(isAgentExcluded(s, 'keep')).toBe(true);
    expect(isAgentExcluded(s, 'rev-1')).toBe(true);
    expect(isAgentExcluded(s, 'other')).toBe(false);
    expect(isAgentExcluded(s, 'keeper')).toBe(false);
  });
});

describe('idle : politique et relâchements', () => {
  it('desactiver la détection ou fermer un terminal sont des RELÂCHEMENTS affichés par doctor', () => {
    expect(idleRelaxations({}).map((r) => r.key)).toEqual([]);
    expect(idleRelaxations({ idle: { enabled: false } }).map((r) => r.key)).toEqual([
      'idle.enabled',
    ]);
    expect(idleRelaxations({ idle: { closePty: true } }).map((r) => r.key)).toEqual([
      'idle.closePty',
    ]);
    const report = collectRelaxations({ config: { idle: { enabled: false, closePty: true } } });
    expect(report.names).toEqual(expect.arrayContaining(['idle.enabled', 'idle.closePty']));
  });

  it("action 'close' / 'warn' sont des POLITIQUES (doctor), pas des relâchements", () => {
    const close = collectRelaxations({ config: { idle: { action: 'close' } } });
    expect(close.policies).toContain('idle:close');
    expect(close.names).toEqual([]);
    expect(collectRelaxations({ config: { idle: { action: 'warn' } } }).policies).toContain(
      'idle:warn',
    );
    expect(collectRelaxations({ config: {} }).policies).toEqual([]);
  });
});

describe('idle : config utilisateur (autorisation de fermer)', () => {
  it('idle.closeRoots : défaut vide, chemins absolus seulement, jamais la racine du disque', () => {
    expect(validateUserConfig({}).idle).toEqual({ closeRoots: [] });
    const root = process.platform === 'win32' ? 'C:\\Projets\\x' : '/home/u/x';
    expect(validateUserConfig({ idle: { closeRoots: [root] } }).idle.closeRoots).toEqual([root]);
    expect(() => validateUserConfig({ idle: { closeRoots: ['relatif/x'] } })).toThrow(
      /USER_CONFIG|chemin absolu/,
    );
    expect(() => validateUserConfig({ idle: { closeRoots: ['/'] } })).toThrow();
    expect(() => validateUserConfig({ idle: { closeRoots: ['C:\\'] } })).toThrow();
    expect(() => validateUserConfig({ idle: { closeRoot: [] } })).toThrow();
    expect(() => validateUserConfig({ idle: 'oui' })).toThrow();
  });
});

describe('idle : codes d’erreur classés', () => {
  it('refus de fermeture = sortie 3, échec = sortie 1', () => {
    for (const code of [
      'IDLE_CLOSE_UNVERIFIED',
      'IDLE_CLOSE_NOT_ACKNOWLEDGED',
      'IDLE_CLOSE_BLOCKED',
    ]) {
      expect(errorKindOf(code), code).toBe('refusal');
    }
    expect(errorKindOf('IDLE_CLOSE_FAILED')).toBe('failure');
    expect(errorKindOf('IDLE_STATE_CORRUPT')).toBe('failure');
  });
});

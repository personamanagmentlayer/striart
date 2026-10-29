import { describe, expect, it } from 'vitest';
import { StriartError } from '../../src/errors.ts';
import { validateConfig, DEFAULT_CONFIG } from '../../src/config.ts';
import {
  deliveryBranchName,
  gitSpawnEnv,
  promotionBranchName,
  redactRemoteCredentials,
} from '../../src/delivery.ts';

const NOW = new Date('2026-10-26T08:09:10.000Z');

describe('deliveryBranchName', () => {
  it('striart/<agent>/<taskId> quand le taskId est un motif sûr', () => {
    expect(deliveryBranchName({ agent: 'agent-a', taskId: 'a1b2c3d4', now: NOW })).toBe(
      'striart/agent-a/a1b2c3d4',
    );
  });

  it('retombe sur la date UTC sans taskId', () => {
    expect(deliveryBranchName({ agent: 'agent-a', taskId: null, now: NOW })).toBe(
      'striart/agent-a/20261026-080910',
    );
  });

  it.each(['../x', 'a b', 'x;rm -rf', 'a..b', '-rf', 'x.lock', '', 'é', 'a/b', 'x'.repeat(65)])(
    'un taskId douteux (%j) n’entre jamais dans le nom : repli sur la date',
    (taskId) => {
      expect(deliveryBranchName({ agent: 'agent-a', taskId, now: NOW })).toBe(
        'striart/agent-a/20261026-080910',
      );
    },
  );

  it('un nom d’agent invalide est refusé (DELIVERY_REF_INVALID)', () => {
    expect(() => deliveryBranchName({ agent: '../evil', taskId: null, now: NOW })).toThrowError(
      expect.objectContaining({ code: 'DELIVERY_REF_INVALID' }),
    );
  });
});

describe('promotionBranchName', () => {
  it('striart/promote/<date>-<sha8>', () => {
    expect(promotionBranchName({ sha: 'abcdef0123456789'.repeat(2).slice(0, 40), now: NOW })).toBe(
      'striart/promote/20261026-080910-abcdef01',
    );
  });
});

describe('gitSpawnEnv', () => {
  it('retire toute GIT_* héritée, interdit les invites interactives', () => {
    const env = gitSpawnEnv({
      GIT_DIR: '/evil',
      GIT_WORK_TREE: '/evil',
      git_index_file: '/evil',
      PATH: '/bin',
      HOME: '/home/x',
    });
    expect(Object.keys(env).filter((k) => k.toUpperCase().startsWith('GIT_'))).toEqual([
      'GIT_TERMINAL_PROMPT',
    ]);
    expect(env.GIT_TERMINAL_PROMPT).toBe('0');
    expect(env.GCM_INTERACTIVE).toBe('never');
    expect(env.PATH).toBe('/bin');
    expect(env.HOME).toBe('/home/x');
  });
});

describe('redactRemoteCredentials', () => {
  it('caviarde user:token@ dans une URL', () => {
    expect(
      redactRemoteCredentials("fatal: unable to access 'https://bob:s3cret@forge.example/r.git/'"),
    ).toBe("fatal: unable to access 'https://***@forge.example/r.git/'");
  });
});

describe('config : delivery, pushTimeoutMs, commitTimeoutMs', () => {
  it('défauts : push, délais bornés', () => {
    expect(DEFAULT_CONFIG.delivery).toBe('push');
    expect(DEFAULT_CONFIG.pushTimeoutMs).toBeGreaterThanOrEqual(1000);
    expect(DEFAULT_CONFIG.commitTimeoutMs).toBeGreaterThanOrEqual(1000);
  });

  it('accepte delivery push|branch (branch exige autoPush)', () => {
    expect(() => validateConfig({ delivery: 'push' })).not.toThrow();
    expect(() => validateConfig({ delivery: 'branch', autoPush: true })).not.toThrow();
  });

  it('refuse delivery inconnue', () => {
    expect(() => validateConfig({ delivery: 'force' })).toThrowError(StriartError);
  });

  it('delivery: branch sans autoPush est refusé au chargement (fail closed, jamais un push implicite)', () => {
    expect(() => validateConfig({ delivery: 'branch' })).toThrowError(
      expect.objectContaining({
        code: 'CONFIG_INVALID',
        details: expect.objectContaining({ reason: 'DELIVERY_REQUIRES_AUTOPUSH' }),
      }),
    );
  });

  it.each([
    ['pushTimeoutMs', 999],
    ['pushTimeoutMs', 1.5],
    ['pushTimeoutMs', '5000'],
    ['commitTimeoutMs', 0],
    ['commitTimeoutMs', -1],
  ])('refuse %s = %j', (key, value) => {
    expect(() => validateConfig({ [key]: value })).toThrowError(StriartError);
  });

  it('accepte des délais valides', () => {
    expect(() => validateConfig({ pushTimeoutMs: 1000, commitTimeoutMs: 60000 })).not.toThrow();
  });
});

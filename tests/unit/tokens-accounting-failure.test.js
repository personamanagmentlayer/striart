import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/logger.js', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../src/tokens/ledger.ts', async (importOriginal) => ({
  ...(await importOriginal()),
  appendUsage: vi.fn(async () => {
    throw new Error('ENOSPC simulé');
  }),
  currentTotals: vi.fn(async () => {
    throw new Error('registre illisible');
  }),
}));

const { logger } = await import('../../src/logger.ts');
const { recordRefusal } = await import('../../src/tokens/call.ts');
const { SessionMeter } = await import('../../src/tokens/session-meter.ts');
const { DEFAULT_TOKENS_SETTINGS, isValidTokensSettings, resolveTokensSettings } =
  await import('../../src/tokens/settings.ts');
const { StriartError, ERROR_KINDS } = await import('../../src/errors.ts');

const scopeWith = (tokens) => ({
  root: '/repo',
  settings: resolveTokensSettings({ tokens }),
  guard: {},
  role: 'router',
  agent: null,
  taskId: null,
  provider: 'ollama',
  model: 'm',
});

const warnedWithCode = () =>
  logger.warn.mock.calls.some(([fields]) => fields?.code === 'TOKEN_ACCOUNTING_FAILED');

describe('comptabilité de tokens — un échec de relevé n’est jamais silencieux', () => {
  beforeEach(() => vi.clearAllMocks());

  it('réglage tokens.onAccountingError : défaut warn, valeurs validées positivement', () => {
    expect(DEFAULT_TOKENS_SETTINGS.onAccountingError).toBe('warn');
    expect(isValidTokensSettings({ onAccountingError: 'fail' })).toBe(true);
    expect(isValidTokensSettings({ onAccountingError: 'ignore' })).toBe(false);
  });

  it('le code est classé (failure)', () => {
    expect(ERROR_KINDS.TOKEN_ACCOUNTING_FAILED).toBe('failure');
  });

  it('warn (défaut) : l’appel n’est pas perdu, mais l’échec est journalisé avec un code stable', async () => {
    await expect(recordRefusal(scopeWith({}), 'x')).resolves.toBeUndefined();
    expect(warnedWithCode()).toBe(true);
  });

  it('fail : l’échec d’écriture du relevé est refusé (TOKEN_ACCOUNTING_FAILED)', async () => {
    const error = await recordRefusal(scopeWith({ onAccountingError: 'fail' }), 'x').catch(
      (e) => e,
    );
    expect(error).toBeInstanceOf(StriartError);
    expect(error.code).toBe('TOKEN_ACCOUNTING_FAILED');
    expect(JSON.stringify(error.details ?? {})).not.toContain('ENOSPC');
  });

  const meterOptions = (tokens) => ({
    root: '/repo',
    agent: 'a',
    taskId: 't',
    config: { tokens },
    format: 'none',
  });

  it('SessionMeter.open — cumuls illisibles : warn avec code stable', async () => {
    await expect(SessionMeter.open(meterOptions({}))).resolves.not.toBeNull();
    expect(warnedWithCode()).toBe(true);
  });

  it('SessionMeter.open — cumuls illisibles en mode fail : refus avant de dépenser quoi que ce soit', async () => {
    await expect(
      SessionMeter.open(meterOptions({ onAccountingError: 'fail' })),
    ).rejects.toMatchObject({ code: 'TOKEN_ACCOUNTING_FAILED' });
  });
});

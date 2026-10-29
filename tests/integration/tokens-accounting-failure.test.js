import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_CONFIG } from '../../src/config.ts';
import { llmGenerate } from '../../src/llm.ts';
import { resetUsageIndex } from '../../src/tokens/ledger.ts';
import { resetRootCache } from '../../src/tokens/call.ts';

describe('llmGenerate — registre d’usage inscriptible ou non (tokens.onAccountingError)', () => {
  let root;
  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'striart-acct-fail-'));
    await mkdir(path.join(root, '.striart'), { recursive: true });
    // `.striart/usage` est un FICHIER : toute écriture du registre échoue.
    await writeFile(path.join(root, '.striart', 'usage'), 'bloque', 'utf8');
    resetUsageIndex();
    resetRootCache();
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue({ ok: true, json: async () => ({ response: 'réponse', done: true }) }),
    );
  });
  afterEach(async () => {
    vi.unstubAllGlobals();
    await rm(root, { recursive: true, force: true, maxRetries: 5 });
  });

  const config = (tokens) => ({
    ...DEFAULT_CONFIG,
    llm: { provider: 'ollama', model: 'm', baseUrl: 'http://127.0.0.1:11434' },
    tokens,
  });

  it('warn (défaut) : la réponse d’un appel payé n’est pas perdue', async () => {
    await expect(
      llmGenerate({ config: config({}), prompt: 'p', role: 'router', root }),
    ).resolves.toBe('réponse');
  });

  it('fail : un relevé impossible refuse l’appel avec TOKEN_ACCOUNTING_FAILED', async () => {
    await expect(
      llmGenerate({
        config: config({ onAccountingError: 'fail' }),
        prompt: 'p',
        role: 'router',
        root,
      }),
    ).rejects.toMatchObject({ code: 'TOKEN_ACCOUNTING_FAILED' });
  });
});

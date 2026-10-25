import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { llmGenerate } from '../../src/llm.js';
import { detectCollisions, predictFiles, WHOLE_REPO } from '../../src/router.js';
import { updateMemoryAfterMerge } from '../../src/memory.js';
import { onStriartEvent } from '../../src/events.js';
import { readRecords, resetUsageIndex } from '../../src/tokens/ledger.ts';
import { resetAlertDedup } from '../../src/tokens/budget.ts';
import { resetRootCache } from '../../src/tokens/call.ts';
import { resetCircuitBreakers } from '../../src/llm-resilience.ts';
import { withTokenContext } from '../../src/tokens/context.ts';

const OLLAMA = (tokens = {}, extra = {}) => ({
  ollamaHost: 'http://localhost:11434',
  ollamaModel: 'llama-x',
  tokens,
  ...extra,
});
const reply = (response, usage = { prompt_eval_count: 120, eval_count: 30 }) => ({
  ok: true,
  json: async () => ({ response, done_reason: 'stop', ...usage }),
});

describe('comptabilité des appels LLM (disque)', () => {
  let root;
  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'striart-tokens-'));
    await mkdir(path.join(root, '.striart'), { recursive: true });
    resetUsageIndex();
    resetAlertDedup();
    resetRootCache();
    resetCircuitBreakers();
  });
  afterEach(async () => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true, maxRetries: 5 });
  });

  it('relève l’usage RÉEL du fournisseur (Ollama), attribué au rôle, à l’agent et à la tâche', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(reply('ok')));
    await llmGenerate({
      config: OLLAMA(),
      prompt: 'bonjour',
      role: 'merger',
      root,
      agent: 'agent-a',
      taskId: 't-1',
      retries: 0,
    });
    const { records } = await readRecords(root);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      role: 'merger',
      provider: 'ollama',
      model: 'llama-x',
      agent: 'agent-a',
      taskId: 't-1',
      source: 'api',
      outcome: 'ok',
      estimated: false,
      input: 120,
      output: 30,
      costUsd: 0, // modèle local
    });
  });

  it('OpenAI : cache lu et raisonnement distingués ; coût depuis la table de prix configurée', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'sk-test');
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          choices: [{ message: { content: 'x' }, finish_reason: 'stop' }],
          usage: {
            prompt_tokens: 1_000_000,
            completion_tokens: 100_000,
            prompt_tokens_details: { cached_tokens: 600_000 },
            completion_tokens_details: { reasoning_tokens: 40_000 },
          },
        }),
      }),
    );
    const config = {
      llm: { provider: 'openai', model: 'gpt-x' },
      tokens: {
        pricing: {
          'openai:gpt-x': {
            inputPerMTok: 1,
            outputPerMTok: 10,
            cacheReadPerMTok: 0.1,
            asOf: '2026-10-01',
          },
        },
      },
    };
    await llmGenerate({ config, prompt: 'p', root, role: 'router', retries: 0 });
    const [r] = (await readRecords(root)).records;
    expect(r).toMatchObject({
      input: 400_000,
      cacheRead: 600_000,
      output: 100_000,
      reasoning: 40_000,
    });
    // 0.4M×1 + 0.6M×0.1 + 0.1M×10 = 1.46
    expect(r.costUsd).toBeCloseTo(1.46, 6);
  });

  it('sans usage rapporté : estimation locale, marquée comme telle', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ response: 'réponse', done_reason: 'stop' }),
      }),
    );
    await llmGenerate({
      config: OLLAMA(),
      prompt: 'a'.repeat(300),
      root,
      role: 'memory',
      retries: 0,
    });
    const [r] = (await readRecords(root)).records;
    expect(r).toMatchObject({ source: 'estimate', estimated: true });
    expect(r.input).toBeGreaterThanOrEqual(100);
  });

  it('une réponse REJETÉE par la validation coûte quand même : relevée (outcome rejected) à chaque tentative', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(reply('pas du json')));
    await expect(
      llmGenerate({
        config: OLLAMA(),
        prompt: 'p',
        root,
        role: 'router',
        retries: 1,
        retryDelayMs: 1,
        transform: (t) => JSON.parse(t),
      }),
    ).rejects.toMatchObject({ code: 'LLM_FAILED' });
    const { records } = await readRecords(root);
    expect(records.map((x) => x.outcome)).toEqual(['rejected', 'rejected']);
    expect(records.every((x) => x.input === 120)).toBe(true);
  });

  it('jamais de prompt ni de réponse au registre', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(reply('RÉPONSE CONFIDENTIELLE')));
    await llmGenerate({
      config: OLLAMA(),
      prompt: 'PROMPT CONFIDENTIEL',
      root,
      role: 'merger',
      retries: 0,
    });
    const text = JSON.stringify((await readRecords(root)).records);
    expect(text).not.toContain('CONFIDENTIEL');
  });

  it('contexte asynchrone : root/agent/tâche posés une fois pour tout ce que l’appel déclenche', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(reply('ok')));
    await withTokenContext({ root, agent: 'ctx-agent', taskId: 'ctx-task' }, () =>
      llmGenerate({ config: OLLAMA(), prompt: 'p', role: 'memory', retries: 0 }),
    );
    expect((await readRecords(root)).records[0]).toMatchObject({
      agent: 'ctx-agent',
      taskId: 'ctx-task',
    });
  });

  it('comptabilité coupée (relâchement) : aucun registre', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(reply('ok')));
    await llmGenerate({
      config: OLLAMA({ accounting: false }),
      prompt: 'p',
      root,
      role: 'merger',
      retries: 0,
    });
    expect((await readRecords(root)).records).toEqual([]);
  });
});

describe('budgets : fail closed AVANT envoi', () => {
  let root;
  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'striart-tokens-'));
    await mkdir(path.join(root, '.striart'), { recursive: true });
    resetUsageIndex();
    resetAlertDedup();
    resetRootCache();
    resetCircuitBreakers();
  });
  afterEach(async () => {
    vi.unstubAllGlobals();
    await rm(root, { recursive: true, force: true, maxRetries: 5 });
  });

  it('plafond par appel : TOKEN_BUDGET_EXCEEDED, aucun appel réseau, refus tracé au registre', async () => {
    const fetchMock = vi.fn().mockResolvedValue(reply('ok'));
    vi.stubGlobal('fetch', fetchMock);
    const config = OLLAMA({ budgets: { perCall: { maxInputTokens: 50 } } });
    await expect(
      llmGenerate({ config, prompt: 'x'.repeat(3000), root, role: 'merger', retries: 2 }),
    ).rejects.toMatchObject({
      code: 'TOKEN_BUDGET_EXCEEDED',
      details: expect.objectContaining({ scope: 'perCall', metric: 'inputTokens', role: 'merger' }),
    });
    expect(fetchMock).not.toHaveBeenCalled();
    const { records } = await readRecords(root);
    expect(records).toEqual([
      expect.objectContaining({ outcome: 'budget', role: 'merger', input: 0 }),
    ]);
  });

  it('plafond par jour : les appels réussis cumulent, le suivant est refusé', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(reply('ok', { prompt_eval_count: 400, eval_count: 100 }));
    vi.stubGlobal('fetch', fetchMock);
    const config = OLLAMA({ budgets: { perDay: { maxTokens: 800 } } });
    await llmGenerate({ config, prompt: 'p', root, role: 'router', retries: 0 }); // 500 comptés
    await expect(
      llmGenerate({ config, prompt: 'x'.repeat(1500), root, role: 'router', retries: 0 }),
    ).rejects.toMatchObject({
      code: 'TOKEN_BUDGET_EXCEEDED',
      details: expect.objectContaining({ scope: 'perDay' }),
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('alert-only : le plafond alerte (événement exceeded) mais ne refuse jamais', async () => {
    const events = [];
    const off = onStriartEvent((_c, e) => {
      if (e.type === 'tokens:alert') events.push(e);
    });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(reply('ok')));
    const config = OLLAMA({
      budgets: { enforcement: 'alert-only', perCall: { maxInputTokens: 10 } },
    });
    await expect(
      llmGenerate({ config, prompt: 'x'.repeat(900), root, role: 'merger', retries: 0 }),
    ).resolves.toBe('ok');
    off();
    expect(events).toEqual([
      expect.objectContaining({ level: 'exceeded', scope: 'perCall', role: 'merger' }),
    ]);
  });

  it('seuil d’alerte : événement typé warn sur le bus quand le plafond approche', async () => {
    const events = [];
    const off = onStriartEvent((_c, e) => {
      if (e.type === 'tokens:alert') events.push(e);
    });
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(reply('ok', { prompt_eval_count: 700, eval_count: 100 })),
    );
    const config = OLLAMA({ budgets: { perDay: { maxTokens: 1000 } } });
    await llmGenerate({ config, prompt: 'p', root, role: 'router', retries: 0 });
    off();
    expect(events).toEqual([
      expect.objectContaining({ level: 'warn', scope: 'perDay', limit: 1000 }),
    ]);
    expect(events[0].message).toContain('Budget de tokens');
  });

  it('plafond de coût sans prix déclaré : TOKEN_PRICE_MISSING (jamais une protection fantôme)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(reply('ok')));
    vi.stubEnv('OPENAI_API_KEY', 'sk');
    const config = {
      llm: { provider: 'openai', model: 'inconnu' },
      tokens: { budgets: { perDay: { maxCostUsd: 1 } } },
    };
    await expect(
      llmGenerate({ config, prompt: 'p', root, role: 'router', retries: 0 }),
    ).rejects.toMatchObject({
      code: 'TOKEN_PRICE_MISSING',
    });
  });

  it('plafond de sortie : transmis au fournisseur (num_predict) ; une sortie coupée est une erreur', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ response: 'coupé', done_reason: 'length' }),
    });
    vi.stubGlobal('fetch', fetchMock);
    const config = OLLAMA({ budgets: { perCall: { maxOutputTokens: 64 } } });
    await expect(
      llmGenerate({ config, prompt: 'p', root, role: 'merger', retries: 0, maxOutputTokens: 4096 }),
    ).rejects.toMatchObject({
      message: expect.stringContaining('limite de longueur'),
    });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).options.num_predict).toBe(64);
  });

  it('Router : budget épuisé → sérialisation prudente (WHOLE_REPO), pas d’échec ; onBudgetExceeded: fail → erreur', async () => {
    vi.stubGlobal('fetch', vi.fn());
    const config = OLLAMA({ budgets: { perCall: { maxInputTokens: 5 } } });
    const files = await predictFiles({
      prompt: 'ajoute un login',
      projectFiles: ['a.js'],
      config,
      root,
      retries: 0,
    });
    expect(files).toEqual([WHOLE_REPO]);
    expect(detectCollisions(files, [{ name: 'a', predictedFiles: ['x.js'] }])).toHaveLength(1);
    const strict = OLLAMA({
      budgets: { perCall: { maxInputTokens: 5 } },
      router: { onBudgetExceeded: 'fail' },
    });
    await expect(
      predictFiles({ prompt: 'x', projectFiles: ['a.js'], config: strict, root, retries: 0 }),
    ).rejects.toMatchObject({
      code: 'TOKEN_BUDGET_EXCEEDED',
    });
  });
});

describe('cache de résultats : prédictions du Router', () => {
  let root;
  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'striart-tokens-'));
    await mkdir(path.join(root, '.striart'), { recursive: true });
    resetUsageIndex();
    resetRootCache();
  });
  afterEach(async () => {
    vi.unstubAllGlobals();
    await rm(root, { recursive: true, force: true, maxRetries: 5 });
  });
  const router = (extra = {}) => ({ ...OLLAMA({}, extra) });
  const rep = () => reply(JSON.stringify({ files: ['src/a.js'] }));

  it('même tâche + même arbre : un seul appel LLM, le second est un hit relevé à zéro jeton', async () => {
    const fetchMock = vi.fn().mockResolvedValue(rep());
    vi.stubGlobal('fetch', fetchMock);
    const args = {
      prompt: 'ajoute  un login',
      projectFiles: ['src/a.js', 'src/b.js'],
      config: router(),
      root,
      retries: 0,
    };
    expect(await predictFiles(args)).toEqual(['src/a.js']);
    expect(await predictFiles({ ...args, prompt: 'ajoute un login ' })).toEqual(['src/a.js']); // espaces normalisés
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const outcomes = (await readRecords(root)).records.map((r) => r.outcome);
    expect(outcomes).toEqual(['ok', 'cache-hit']);
  });

  it('invalidation : un fichier ajouté à l’arbre, une autre tâche ou un autre HEAD → nouvel appel', async () => {
    const fetchMock = vi.fn().mockResolvedValue(rep());
    vi.stubGlobal('fetch', fetchMock);
    const base = {
      prompt: 'login',
      projectFiles: ['src/a.js'],
      config: router(),
      root,
      retries: 0,
    };
    await predictFiles(base);
    await predictFiles({ ...base, projectFiles: ['src/a.js', 'src/new.js'] });
    await predictFiles({ ...base, prompt: 'logout' });
    await predictFiles({ ...base, headSha: 'abc123' });
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('cache désactivable', async () => {
    const fetchMock = vi.fn().mockResolvedValue(rep());
    vi.stubGlobal('fetch', fetchMock);
    const config = OLLAMA({ cache: { enabled: false } });
    const args = { prompt: 'login', projectFiles: ['src/a.js'], config, root, retries: 0 };
    await predictFiles(args);
    await predictFiles(args);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('une entrée de cache qui ne passe plus la validation est purgée et l’appel réel a lieu', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(reply('pas du json')).mockResolvedValue(rep());
    vi.stubGlobal('fetch', fetchMock);
    const args = {
      prompt: 'login',
      projectFiles: ['src/a.js'],
      config: router(),
      root,
      retries: 1,
      retryDelayMs: 1,
    };
    expect(await predictFiles(args)).toEqual(['src/a.js']); // 1re réponse rejetée (non cachée), 2e acceptée
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('jamais de cache pour un rôle non listé (merger par défaut) ni pour un rôle hors rôles cacheables', async () => {
    const fetchMock = vi.fn().mockResolvedValue(reply('x'));
    vi.stubGlobal('fetch', fetchMock);
    const call = () =>
      llmGenerate({
        config: OLLAMA({}),
        prompt: 'p',
        root,
        role: 'merger',
        retries: 0,
        resultCache: { promptVersion: 'v', material: ['m'] },
      });
    await call();
    await call();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('Memory Layer : bornée et sans appel inutile', () => {
  let root;
  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'striart-tokens-'));
    await mkdir(path.join(root, '.striart'), { recursive: true });
    resetUsageIndex();
    resetRootCache();
  });
  afterEach(async () => {
    vi.unstubAllGlobals();
    await rm(root, { recursive: true, force: true, maxRetries: 5 });
  });

  const DIFF =
    'diff --git a/src/auth.js b/src/auth.js\n--- a/src/auth.js\n+++ b/src/auth.js\n@@ -1 +1 @@\n-export function login(a) {}\n+export function login(a, b) {}\n';

  it('diff sans API (lockfile) : aucun appel LLM', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const res = await updateMemoryAfterMerge({
      root,
      config: { ...OLLAMA(), memoryMaxEntries: 5 },
      agent: 'a',
      sha: 'abcdef123456',
      diff: 'diff --git a/package-lock.json b/package-lock.json\n+x\n',
    });
    expect(res).toMatchObject({ updated: false, skipped: 'NO_API_CHANGES' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('une puce sur un symbole déjà documenté REMPLACE l’ancienne ; relevé au rôle memory', async () => {
    const config = { ...OLLAMA(), memoryMaxEntries: 5 };
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(reply('- `login(a)` ajoutée'))
        .mockResolvedValueOnce(reply('- `login(a, b)` : nouvelle signature')),
    );
    await updateMemoryAfterMerge({ root, config, agent: 'a', sha: '11111111aaaa', diff: DIFF });
    await updateMemoryAfterMerge({
      root,
      config,
      agent: 'b',
      sha: '22222222bbbb',
      diff: `${DIFF}// 2\n+x`,
    });
    const memory = await readFile(path.join(root, '.striart', 'memory.md'), 'utf8');
    expect(memory).toContain('login(a, b)');
    expect(memory).not.toContain('`login(a)` ajoutée');
    expect((await readRecords(root)).records.every((r) => r.role === 'memory')).toBe(true);
  });
});

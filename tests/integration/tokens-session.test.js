import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_CONFIG } from '../../src/config.js';
import { onStriartEvent } from '../../src/events.js';
import { runAgentSession } from '../../src/session.js';
import { readRecords, resetUsageIndex } from '../../src/tokens/ledger.ts';
import { resetAlertDedup } from '../../src/tokens/budget.ts';
import { resetRootCache } from '../../src/tokens/call.ts';

const AGENT = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'helpers',
  'fake-usage-agent.cjs',
);

describe('sessions d’agent : relevé d’usage et arrêt sur budget', () => {
  let root;
  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'striart-session-tokens-'));
    await mkdir(path.join(root, '.striart', 'logs'), { recursive: true });
    resetUsageIndex();
    resetAlertDedup();
    resetRootCache();
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true, maxRetries: 5 });
  });

  const profile = (messages, format = 'claude') => ({
    command: process.execPath,
    args: [AGENT, String(messages), format, '{{prompt}}'],
    structuredOutput: format === 'claude' ? 'claude-stream-json' : 'codex-jsonl',
    instructions: { channel: 'none' },
  });
  const run = (prof, tokens = {}, extra = {}) =>
    runAgentSession({
      root,
      agent: 'agent-a',
      taskId: 'task-1',
      cwd: root,
      profile: prof,
      prompt: 'tâche',
      timeoutMs: 30_000,
      config: {
        ...DEFAULT_CONFIG,
        agentInstructions: { ...DEFAULT_CONFIG.agentInstructions, enabled: false },
        tokens,
      },
      ...extra,
    });

  it('Claude stream-json : total autoritaire du `result` (tokens + coût rapporté), dédoublonnage par id', async () => {
    const result = await run(profile(4));
    expect(result.status).toBe('COMPLETED');
    expect(result.usage).toMatchObject({
      source: 'agent-stream',
      metered: true,
      input: 4000,
      output: 400,
      costUsd: 0.25,
    });
    const { records } = await readRecords(root);
    const sum = records.reduce(
      (s, r) => ({
        input: s.input + (r.input ?? 0),
        output: s.output + (r.output ?? 0),
        cost: s.cost + (r.costUsd ?? 0),
      }),
      { input: 0, output: 0, cost: 0 },
    );
    expect(sum).toEqual({ input: 4000, output: 400, cost: 0.25 });
    expect(records.at(-1)).toMatchObject({
      role: 'agent',
      agent: 'agent-a',
      taskId: 'task-1',
      source: 'agent-stream',
      outcome: 'ok',
    });
  });

  it('Codex turn.completed : usage additif par tour', async () => {
    const result = await run(profile(3, 'codex'));
    expect(result.status).toBe('COMPLETED');
    expect(result.usage).toMatchObject({ input: 3000, output: 300, source: 'agent-stream' });
  });

  it('plafond par tâche franchi en cours de session : arbre tué, statut BUDGET_EXCEEDED, relevé « stopped »', async () => {
    const events = [];
    const off = onStriartEvent((_c, e) => {
      if (e.type === 'tokens:alert') events.push(e);
    });
    const startedAt = Date.now();
    const result = await run(profile(200), { budgets: { perTask: { maxTokens: 3000 } } });
    off();
    expect(result.status).toBe('BUDGET_EXCEEDED');
    expect(result.budget).toMatchObject({ scope: 'perTask', metric: 'tokens', limit: 3000 });
    expect(result.error).toContain('Token budget exceeded');
    // Arrêté bien avant la fin naturelle (200 × 80 ms = 16 s).
    expect(Date.now() - startedAt).toBeLessThan(10_000);
    const { records } = await readRecords(root);
    expect(records.at(-1)).toMatchObject({ outcome: 'stopped', role: 'agent' });
    expect(events.some((e) => e.level === 'exceeded' && e.scope === 'perTask')).toBe(true);
  });

  it('alert-only : jamais d’arrêt, la session va à son terme', async () => {
    const result = await run(profile(4), {
      budgets: { enforcement: 'alert-only', perTask: { maxTokens: 1000 } },
    });
    expect(result.status).toBe('COMPLETED');
  });

  it('plafond par jour partagé : le cumul des sessions précédentes compte', async () => {
    await run(profile(3)); // 3 300 tokens relevés
    resetUsageIndex();
    const second = await run(
      profile(50),
      { budgets: { perDay: { maxTokens: 6000 } } },
      { taskId: 'task-2' },
    );
    expect(second.status).toBe('BUDGET_EXCEEDED');
    expect(second.budget.scope).toBe('perDay');
  });

  it('session sans flux structuré : « unmetered », déclarée telle (seul le délai la borne)', async () => {
    const result = await run({
      command: process.execPath,
      args: ['-e', 'console.log(1)', '{{prompt}}'],
      instructions: { channel: 'none' },
    });
    expect(result.status).toBe('COMPLETED');
    expect(result.usage).toMatchObject({ metered: false, source: 'unmetered', input: null });
    expect((await readRecords(root)).records.at(-1)).toMatchObject({
      source: 'unmetered',
      input: null,
    });
  });

  it('comptabilité coupée : aucun relevé, aucun usage dans le résultat', async () => {
    const result = await run(profile(2), { accounting: false });
    expect(result.status).toBe('COMPLETED');
    expect(result.usage).toBeUndefined();
    expect((await readRecords(root)).records).toEqual([]);
  });
});

describe('SessionMeter : flux brut', () => {
  let root;
  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'striart-meter-'));
    await mkdir(path.join(root, '.striart'), { recursive: true });
    resetUsageIndex();
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true, maxRetries: 5 });
  });

  it('lignes coupées entre deux morceaux, bruit non JSON, messages répétés (même id) comptés une fois', async () => {
    const { SessionMeter } = await import('../../src/tokens/session-meter.ts');
    const meter = await SessionMeter.open({
      root,
      agent: 'a',
      taskId: 't',
      config: DEFAULT_CONFIG,
      format: 'claude-stream-json',
    });
    const msg = JSON.stringify({
      type: 'assistant',
      message: { id: 'm1', usage: { input_tokens: 10, output_tokens: 5 } },
    });
    meter.feedChunk('bannière de démarrage\n');
    meter.feedChunk(msg.slice(0, 30));
    meter.feedChunk(`${msg.slice(30)}\n${msg}\n`);
    meter.feedChunk(
      `${JSON.stringify({ type: 'assistant', message: { id: 'm2', usage: { input_tokens: 1, output_tokens: 1 } } })}\n`,
    );
    expect(meter.current()).toMatchObject({ input: 11, output: 6 });
    const summary = await meter.close();
    expect(summary).toMatchObject({ metered: true, input: 11, output: 6 });
  });
});

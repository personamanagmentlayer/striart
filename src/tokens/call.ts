/**
 * Instrumentation d'UN appel LLM de Striart (lot T) : résolution du contexte
 * de comptabilité, estimation, garde de budget AVANT envoi, relevé APRÈS.
 *
 * Utilisé par `llmGenerate` (src/llm.js) — seul point d'entrée des appels du
 * Router, du Merger, de la Memory Layer et des futurs relecteurs. Ce module
 * ne fait aucun appel réseau.
 */
import { stat } from 'node:fs/promises';
import path from 'node:path';
import type { StriartConfig, TokenUsage, UsageRecord, UsageRole } from '../types.js';
import { reportAccountingFailure } from './accounting-error.ts';
import { type GuardContext, evaluateBudgets, emitFindings, guardCall } from './budget.ts';
import { currentTokenContext } from './context.ts';
import {
  calibrateFromRecords,
  calibrationKey,
  effectiveChars,
  estimateFromEffectiveChars,
  estimateTokens,
} from './estimate.ts';
import { appendUsage, currentTotals, readRecords, utcDay } from './ledger.ts';
import { costOf } from './pricing.ts';
import { type TokensSettings, resolveTokensSettings } from './settings.ts';

export interface CallScope {
  root: string;
  settings: TokensSettings;
  guard: GuardContext;
  role: UsageRole;
  agent: string | null;
  taskId: string | null;
  provider: string;
  model: string;
}

// -------------------------------------------------------------------------
// Racine du dépôt
// -------------------------------------------------------------------------

const rootCache = new Map<string, string | null>();

/**
 * Racine Striart (dossier contenant `.striart/`) en remontant depuis `start`.
 * Un appel LLM hors dépôt initialisé n'a pas de registre : il n'est ni
 * compté ni plafonné (le cas des tests unitaires et des usages en bibliothèque).
 */
export async function findStriartRoot(start: string): Promise<string | null> {
  const origin = path.resolve(start);
  if (rootCache.has(origin)) return rootCache.get(origin) ?? null;
  let dir = origin;
  let found: string | null = null;
  for (let i = 0; i < 40; i += 1) {
    const st = await stat(path.join(dir, '.striart')).catch(() => null);
    if (st?.isDirectory()) {
      found = dir;
      break;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  rootCache.set(origin, found);
  return found;
}

/** Pour les tests. */
export function resetRootCache(): void {
  rootCache.clear();
  calibrationMemo.clear();
}

/**
 * Variable d'environnement qui coupe la découverte IMPLICITE de la racine
 * (remontée depuis le dossier de la config ou le répertoire courant). Posée par
 * le projet vitest `unit` : sans elle, un test qui appelle le LLM sans racine
 * écrirait registre d'usage et cache dans le `.striart/` du dépôt de
 * développement (dogfooding). Une racine explicite ou posée par le contexte reste
 * toujours honorée. Valeur '1' seulement : tout autre valeur, vide comprise,
 * laisse la découverte active (jamais de coupe accidentelle de la comptabilité).
 */
export const NO_DISCOVERY_ENV = 'STRIART_TOKENS_NO_DISCOVERY';

export async function resolveRoot(
  explicit: string | null | undefined,
  config: { configPath?: string | null },
): Promise<string | null> {
  if (explicit) return explicit;
  const ctxRoot = currentTokenContext().root;
  if (ctxRoot) return ctxRoot;
  if (process.env[NO_DISCOVERY_ENV] === '1') return null;
  const start = config.configPath ? path.dirname(config.configPath) : process.cwd();
  return findStriartRoot(start);
}

// -------------------------------------------------------------------------
// Calibration (lue du registre, mémoïsée 60 s par racine)
// -------------------------------------------------------------------------

const calibrationMemo = new Map<string, { at: number; ratios: Map<string, number> }>();
const CALIBRATION_TTL_MS = 60_000;

async function calibrationRatios(root: string, defaultRatio: number): Promise<Map<string, number>> {
  const hit = calibrationMemo.get(root);
  if (hit && Date.now() - hit.at < CALIBRATION_TTL_MS) return hit.ratios;
  const fromDay = utcDay(Date.now() - 2 * 86_400_000);
  const { records } = await readRecords(root, { fromDay }).catch(() => ({
    records: [] as UsageRecord[],
  }));
  const ratios = calibrateFromRecords(records, defaultRatio);
  calibrationMemo.set(root, { at: Date.now(), ratios });
  return ratios;
}

// -------------------------------------------------------------------------
// Portée d'un appel
// -------------------------------------------------------------------------

export async function openCallScope(params: {
  config: StriartConfig | Record<string, unknown>;
  role: UsageRole;
  root?: string | null;
  agent?: string | null;
  taskId?: string | null;
  provider: string;
  model: string;
}): Promise<CallScope | null> {
  const settings = resolveTokensSettings(params.config as { tokens?: unknown });
  if (!settings.accounting) return null;
  const root = await resolveRoot(params.root, params.config as { configPath?: string | null });
  if (!root) return null;
  const ctx = currentTokenContext();
  const agent = params.agent ?? ctx.agent ?? null;
  const taskId = params.taskId ?? ctx.taskId ?? null;
  return {
    root,
    settings,
    role: params.role,
    agent,
    taskId,
    provider: params.provider,
    model: params.model,
    guard: { root, config: params.config, settings, role: params.role, agent, taskId },
  };
}

export interface Preflight {
  estimatedInput: number;
  promptChars: number;
  maxOutputTokens: number | null;
}

/** Estime l'entrée puis applique la garde de budget (throw TOKEN_BUDGET_EXCEEDED / TOKEN_PRICE_MISSING). */
export async function preflight(
  scope: CallScope,
  prompt: string,
  requestedOutputTokens: number | null,
): Promise<Preflight> {
  const ratios = await calibrationRatios(scope.root, scope.settings.estimator.charsPerToken);
  const ratio =
    ratios.get(calibrationKey(scope.provider, scope.model)) ??
    scope.settings.estimator.charsPerToken;
  const promptChars = effectiveChars(prompt);
  const estimatedInput = Math.max(
    prompt.length > 0 ? 1 : 0,
    estimateFromEffectiveChars(promptChars, {
      charsPerToken: ratio,
      safetyFactor: scope.settings.estimator.safetyFactor,
    }),
  );
  const { maxOutputTokens } = await guardCall({
    ctx: scope.guard,
    provider: scope.provider,
    model: scope.model,
    inputTokens: estimatedInput,
    requestedOutputTokens,
  });
  return { estimatedInput, promptChars, maxOutputTokens };
}

export interface RecordParams {
  usage: TokenUsage | null;
  /** Texte de la réponse (estimation de la sortie quand le fournisseur n'a rien rapporté) — jamais enregistré. */
  responseText?: string | null;
  durationMs: number;
  outcome: UsageRecord['outcome'];
  estimatedInput: number;
  promptChars: number;
  detail?: string | null;
}

/**
 * Relève un appel dans le registre (best effort : un échec d'écriture est
 * journalisé, jamais propagé — l'appel a eu lieu, sa réponse ne doit pas être
 * perdue pour un disque capricieux), puis émet les alertes de seuil.
 */
export async function recordCall(scope: CallScope, p: RecordParams): Promise<void> {
  const estimated = p.usage === null;
  const usage: TokenUsage =
    p.usage ??
    ({
      input: p.estimatedInput,
      output: p.responseText ? estimateTokens(p.responseText, scope.settings.estimator) : 0,
      cacheRead: 0,
      cacheWrite: 0,
      reasoning: 0,
    } satisfies TokenUsage);
  const record: UsageRecord = {
    v: 1,
    ts: new Date().toISOString(),
    role: scope.role,
    provider: scope.provider,
    model: scope.model,
    agent: scope.agent,
    taskId: scope.taskId,
    durationMs: p.durationMs,
    source: estimated ? 'estimate' : 'api',
    outcome: p.outcome,
    estimated,
    input: usage.input,
    output: usage.output,
    cacheRead: usage.cacheRead,
    cacheWrite: usage.cacheWrite,
    reasoning: usage.reasoning,
    costUsd: costOf(usage, scope.settings.pricing, scope.provider, scope.model),
    promptChars: p.promptChars,
    ...(p.detail ? { detail: p.detail } : {}),
  };
  await writeRecord(scope, record);
}

/** Relevé d'un résultat servi par le cache local : zéro jeton, enregistré pour le taux de hit. */
export async function recordCacheHit(scope: CallScope, durationMs: number): Promise<void> {
  await writeRecord(scope, {
    v: 1,
    ts: new Date().toISOString(),
    role: scope.role,
    provider: scope.provider,
    model: scope.model,
    agent: scope.agent,
    taskId: scope.taskId,
    durationMs,
    source: 'api',
    outcome: 'cache-hit',
    estimated: false,
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    reasoning: 0,
    costUsd: 0,
  });
}

/** Relevé d'un appel REFUSÉ par un budget (aucun jeton dépensé) — la trace de la protection. */
export async function recordRefusal(scope: CallScope, detail: string): Promise<void> {
  await writeRecord(scope, {
    v: 1,
    ts: new Date().toISOString(),
    role: scope.role,
    provider: scope.provider,
    model: scope.model,
    agent: scope.agent,
    taskId: scope.taskId,
    durationMs: 0,
    source: 'estimate',
    outcome: 'budget',
    estimated: true,
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    reasoning: 0,
    costUsd: 0,
    detail,
  });
}

async function writeRecord(scope: CallScope, record: UsageRecord): Promise<void> {
  try {
    await appendUsage(scope.root, record);
  } catch (error) {
    // Appel non compté : journalisé (TOKEN_ACCOUNTING_FAILED), refusé si demandé.
    reportAccountingFailure(scope.settings, error, 'usage-ledger-write');
    return;
  }
  try {
    const totals = await currentTotals(scope.root, { taskId: scope.taskId, agent: scope.agent });
    const findings = evaluateBudgets(
      scope.settings,
      totals,
      { inputTokens: 0, outputTokens: 0, costUsd: 0 },
      { agent: scope.agent, taskId: scope.taskId, day: utcDay(Date.now()) },
    ).filter((f) => f.scope !== 'perCall');
    await emitFindings(findings, scope.guard);
  } catch (error) {
    reportAccountingFailure(scope.settings, error, 'post-call-budget-evaluation');
  }
}

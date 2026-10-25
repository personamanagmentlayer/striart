/**
 * Budgets de tokens et de coût (lot T) : évaluation PURE + garde d'appel.
 *
 * Cinq portées : par appel, par tâche (ou session), par agent, par jour UTC,
 * global (rétention du registre). Chacune accepte un plafond en jetons
 * et/ou en USD. Deux niveaux :
 *  - ALERTE : au seuil `warnAtRatio` d'un plafond posé, ou au franchissement
 *    d'un seuil absolu de `tokens.alerts` (quand aucun plafond n'est posé) —
 *    événement `tokens:alert` sur le bus (notify, SSE), jamais bloquant ;
 *  - PLAFOND DUR (`enforcement: 'hard'`, défaut) : l'appel est REFUSÉ avant
 *    envoi (`TOKEN_BUDGET_EXCEEDED`, fail closed) ; une session d'agent est
 *    arrêtée proprement (statut `BUDGET_EXCEEDED`).
 *
 * Fail closed : un plafond de COÛT sans prix déclaré pour le modèle ne peut
 * pas être tenu — l'appel est refusé (`TOKEN_PRICE_MISSING`) plutôt que de
 * laisser croire à une protection absente.
 */
import type { BudgetBreach, BudgetScope, StriartConfig, UsageRole } from '../types.js';
import { StriartError } from '../errors.js';
import { emitStriartEvent } from '../events.js';
import { logger } from '../logger.js';
import { type CurrentTotals, currentTotals } from './ledger.ts';
import { costOf, lookupPrice } from './pricing.ts';
import type { BudgetLimits, TokensSettings } from './settings.ts';

export interface Planned {
  /** Entrée estimée de l'appel (jetons). */
  inputTokens: number;
  /** Sortie plafonnée de l'appel (jetons) — null quand non bornée. */
  outputTokens: number | null;
  /** Coût estimé de l'appel (USD) — null si le modèle n'a pas de prix. */
  costUsd: number | null;
}

export interface BudgetFinding extends BudgetBreach {
  level: 'warn' | 'exceeded';
  /** Libellé de la clé (tâche/agent/jour) pour le message. */
  key: string | null;
}

const ZERO_TOTALS = { tokens: 0, costUsd: 0, unpriced: 0 };

function check(
  findings: BudgetFinding[],
  scope: BudgetScope,
  metric: BudgetBreach['metric'],
  limit: number | null,
  used: number,
  planned: number,
  warnAt: number,
  key: string | null,
): void {
  if (limit === null) return;
  const projected = used + planned;
  if (projected > limit)
    findings.push({ scope, metric, limit, used: projected, level: 'exceeded', key });
  else if (projected >= limit * warnAt) {
    findings.push({ scope, metric, limit, used: projected, level: 'warn', key });
  }
}

/**
 * Évalue toutes les portées pour un appel prévu (`planned`) ou, avec un
 * planned nul, l'état courant (surveillance d'une session). PURE.
 */
export function evaluateBudgets(
  settings: TokensSettings,
  totals: CurrentTotals,
  planned: Planned,
  ids: { agent: string | null; taskId: string | null; day: string },
): BudgetFinding[] {
  const b = settings.budgets;
  const warnAt = b.warnAtRatio;
  const findings: BudgetFinding[] = [];
  const plannedTokens = planned.inputTokens + (planned.outputTokens ?? 0);

  // Par appel : plafonds propres à UN appel.
  check(
    findings,
    'perCall',
    'inputTokens',
    b.perCall.maxInputTokens,
    0,
    planned.inputTokens,
    warnAt,
    null,
  );
  check(findings, 'perCall', 'tokens', b.perCall.maxTokens, 0, plannedTokens, warnAt, null);
  if (planned.costUsd !== null) {
    check(findings, 'perCall', 'costUsd', b.perCall.maxCostUsd, 0, planned.costUsd, warnAt, null);
  }

  const rolling: Array<
    [BudgetScope, BudgetLimits, { tokens: number; costUsd: number }, string | null]
  > = [
    ['perTask', b.perTask, totals.perTask, ids.taskId],
    ['perAgent', b.perAgent, totals.perAgent, ids.agent],
    ['perDay', b.perDay, totals.perDay, ids.day],
    ['global', b.global, totals.global, null],
  ];
  for (const [scope, limits, used, key] of rolling) {
    // Une portée par clé sans clé (pas de tâche/agent connu) n'a rien à mesurer.
    if ((scope === 'perTask' || scope === 'perAgent') && !key) continue;
    check(findings, scope, 'tokens', limits.maxTokens, used.tokens, plannedTokens, warnAt, key);
    if (planned.costUsd !== null || planned.inputTokens === 0) {
      check(
        findings,
        scope,
        'costUsd',
        limits.maxCostUsd,
        used.costUsd,
        planned.costUsd ?? 0,
        warnAt,
        key,
      );
    }
  }

  // Seuils absolus : alertes seulement, et seulement si aucun plafond de
  // tokens n'est posé sur la portée (le plafond posé porte déjà ses alertes).
  const a = settings.alerts;
  if (
    a.callInputTokens !== null &&
    b.perCall.maxInputTokens === null &&
    planned.inputTokens >= a.callInputTokens
  ) {
    findings.push({
      scope: 'perCall',
      metric: 'inputTokens',
      limit: a.callInputTokens,
      used: planned.inputTokens,
      level: 'warn',
      key: null,
    });
  }
  if (
    a.taskTokens !== null &&
    b.perTask.maxTokens === null &&
    ids.taskId &&
    totals.perTask.tokens + plannedTokens >= a.taskTokens
  ) {
    findings.push({
      scope: 'perTask',
      metric: 'tokens',
      limit: a.taskTokens,
      used: totals.perTask.tokens + plannedTokens,
      level: 'warn',
      key: ids.taskId,
    });
  }
  if (
    a.dayTokens !== null &&
    b.perDay.maxTokens === null &&
    totals.perDay.tokens + plannedTokens >= a.dayTokens
  ) {
    findings.push({
      scope: 'perDay',
      metric: 'tokens',
      limit: a.dayTokens,
      used: totals.perDay.tokens + plannedTokens,
      level: 'warn',
      key: ids.day,
    });
  }
  return findings;
}

/** Plafonds de coût posés quelque part (exigent un prix). */
export function hasCostLimit(settings: TokensSettings): boolean {
  const b = settings.budgets;
  return [b.perCall, b.perTask, b.perAgent, b.perDay, b.global].some((l) => l.maxCostUsd !== null);
}

const alerted = new Set<string>();

/** Pour les tests : oublie les alertes déjà émises. */
export function resetAlertDedup(): void {
  alerted.clear();
}

function alertMessage(f: BudgetFinding, ctx: GuardContext): string {
  const unit = f.metric === 'costUsd' ? 'USD' : 'jetons';
  const where =
    f.scope === 'perCall'
      ? `un appel (${ctx.role})`
      : f.scope === 'perTask'
        ? `la tâche ${f.key}`
        : f.scope === 'perAgent'
          ? `l'agent ${f.key}`
          : f.scope === 'perDay'
            ? `le jour ${f.key} (UTC)`
            : 'le cumul global';
  const fmt = (n: number) => (f.metric === 'costUsd' ? n.toFixed(4) : String(Math.round(n)));
  return f.level === 'exceeded'
    ? `⛔ [Striart] Budget de tokens dépassé pour ${where} : ${fmt(f.used)} / ${fmt(f.limit)} ${unit}.`
    : `⚠️ [Striart] Budget de tokens bientôt atteint pour ${where} : ${fmt(f.used)} / ${fmt(f.limit)} ${unit}.`;
}

export interface GuardContext {
  root: string;
  config: StriartConfig | Record<string, unknown>;
  settings: TokensSettings;
  role: UsageRole;
  agent: string | null;
  taskId: string | null;
}

/** Émet les alertes (une fois par portée/métrique/niveau/clé/jour et par process). */
export async function emitFindings(findings: BudgetFinding[], ctx: GuardContext): Promise<void> {
  for (const f of findings) {
    const dedupKey = `${ctx.root}|${f.scope}|${f.metric}|${f.level}|${f.key ?? ''}|${new Date().toISOString().slice(0, 10)}`;
    if (alerted.has(dedupKey)) continue;
    alerted.add(dedupKey);
    logger.warn(
      {
        scope: f.scope,
        metric: f.metric,
        level: f.level,
        used: f.used,
        limit: f.limit,
        role: ctx.role,
      },
      'Budget de tokens : seuil franchi',
    );
    await emitStriartEvent(ctx.config as StriartConfig, {
      type: 'tokens:alert',
      level: f.level,
      scope: f.scope,
      metric: f.metric,
      used: f.used,
      limit: f.limit,
      role: ctx.role,
      agent: ctx.agent,
      taskId: ctx.taskId,
      message: alertMessage(f, ctx),
    });
  }
}

export interface GuardInput {
  ctx: GuardContext;
  provider: string | null;
  model: string | null;
  inputTokens: number;
  /** Sortie demandée par l'appelant (null = non bornée). */
  requestedOutputTokens: number | null;
}

/**
 * Garde d'un appel LLM AVANT envoi. Rend la sortie maximale effective à
 * transmettre au fournisseur (`perCall.maxOutputTokens` appliqué), ou throw
 * `TOKEN_BUDGET_EXCEEDED` / `TOKEN_PRICE_MISSING` — fail closed, aucune
 * troncature silencieuse : l'appelant bascule sur son chemin sûr.
 */
export async function guardCall(input: GuardInput): Promise<{ maxOutputTokens: number | null }> {
  const { ctx, provider, model } = input;
  const s = ctx.settings;
  const cap = s.budgets.perCall.maxOutputTokens;
  const maxOutputTokens =
    cap === null ? input.requestedOutputTokens : Math.min(cap, input.requestedOutputTokens ?? cap);

  const found = lookupPrice(s.pricing, provider, model);
  const plannedCost = found.priced
    ? costOf(
        {
          input: input.inputTokens,
          output: maxOutputTokens ?? 0,
          cacheRead: 0,
          cacheWrite: 0,
          reasoning: 0,
        },
        s.pricing,
        provider,
        model,
      )
    : null;
  const enforcing = s.budgets.enforcement === 'hard';
  if (!found.priced && hasCostLimit(s) && enforcing) {
    throw new StriartError(
      `A cost ceiling is configured (tokens.budgets) but no price is declared for ${provider ?? '?'}:${model ?? '?'}: the ceiling cannot be enforced, so the call is refused. Declare the model in tokens.pricing (with its "asOf" date) or remove the cost ceiling.`,
      {
        code: 'TOKEN_PRICE_MISSING',
        hint: 'striart doctor',
        details: { provider, model, role: ctx.role },
      },
    );
  }

  const totals = await currentTotals(ctx.root, { taskId: ctx.taskId, agent: ctx.agent }).catch(
    (error) => {
      logger.warn({ err: error }, 'Budgets : cumuls illisibles (calcul sur un registre vide)');
      return {
        perDay: ZERO_TOTALS,
        perTask: ZERO_TOTALS,
        perAgent: ZERO_TOTALS,
        global: ZERO_TOTALS,
      };
    },
  );
  const day = new Date().toISOString().slice(0, 10);
  const findings = evaluateBudgets(
    s,
    totals,
    { inputTokens: input.inputTokens, outputTokens: maxOutputTokens, costUsd: plannedCost },
    { agent: ctx.agent, taskId: ctx.taskId, day },
  );
  await emitFindings(findings, ctx);
  const breach = findings.find((f) => f.level === 'exceeded');
  if (breach && enforcing) {
    throw new StriartError(
      `Token budget exceeded (${breach.scope}, ${breach.metric}: ${formatNumber(breach.used, breach.metric)} > ${formatNumber(breach.limit, breach.metric)}) — the ${ctx.role} call was refused before being sent. Raise tokens.budgets.${breach.scope} or wait for the period to roll over.`,
      {
        code: 'TOKEN_BUDGET_EXCEEDED',
        hint: 'striart usage',
        details: {
          scope: breach.scope,
          metric: breach.metric,
          limit: breach.limit,
          used: Math.round(breach.used * 10_000) / 10_000,
          role: ctx.role,
          agent: ctx.agent,
          taskId: ctx.taskId,
        },
      },
    );
  }
  return { maxOutputTokens };
}

function formatNumber(n: number, metric: BudgetBreach['metric']): string {
  return metric === 'costUsd' ? `${n.toFixed(4)} USD` : String(Math.round(n));
}

/** Première violation dure d'un jeu de constats, ou null. */
export function firstBreach(
  findings: BudgetFinding[],
  settings: TokensSettings,
): BudgetBreach | null {
  if (settings.budgets.enforcement !== 'hard') return null;
  const f = findings.find((x) => x.level === 'exceeded');
  return f ? { scope: f.scope, metric: f.metric, limit: f.limit, used: f.used } : null;
}

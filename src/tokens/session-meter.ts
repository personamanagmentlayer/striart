/**
 * Compteur d'usage d'UNE session d'agent (lot T) : alimenté en direct par le
 * flux structuré de l'outil (argv) ou par les `session/update` / réponses de
 * tour (ACP), il consigne l'usage au registre par DELTAS réguliers (donc
 * visible des autres process et résistant à un crash) et signale le
 * franchissement d'un plafond pendant que la session tourne.
 *
 * Ce qu'il ne fait PAS : tuer le process. Il appelle `onBreach` (une seule
 * fois) ; l'appelant (session.js / acp/session.ts) arrête l'arbre de process
 * et rend le statut BUDGET_EXCEEDED. Aucun relevé = aucune application :
 * une session sans flux structuré est « unmetered » (déclaré tel quel au
 * registre et à `striart usage`), seul le délai la borne.
 */
import type {
  BudgetBreach,
  SessionUsageSummary,
  StriartConfig,
  TokenUsage,
  UsageRecord,
  UsageSource,
} from '../types.js';
import { extractStreamUsage } from '../agents/transcript.ts';
import { logger } from '../logger.js';
import { logAccountingFailure, reportAccountingFailure } from './accounting-error.ts';
import { type BudgetFinding, emitFindings, evaluateBudgets, firstBreach } from './budget.ts';
import { estimateTokens } from './estimate.ts';
import { appendUsage, currentTotals, utcDay } from './ledger.ts';
import { costOf } from './pricing.ts';
import { type TokensSettings, resolveTokensSettings } from './settings.ts';
import {
  type StreamUsageEvent,
  addUsage,
  emptyUsage,
  fromAcpUsage,
  maxUsage,
  totalTokens,
} from './usage.ts';

/** Intervalle minimal entre deux écritures de delta au registre. */
const FLUSH_INTERVAL_MS = 10_000;

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

export interface SessionMeterOptions {
  root: string;
  agent: string;
  taskId: string;
  config: StriartConfig;
  /** Format structuré du profil ('none' = pas de relevé) ou 'acp'. */
  format: string;
  /** Modèle de l'outil si connu (profil / flux) : sert à chiffrer le coût. */
  model?: string | null;
  provider?: string | null;
  onBreach?: (breach: BudgetBreach) => void;
}

export class SessionMeter {
  private readonly o: SessionMeterOptions;
  private readonly settings: TokensSettings;
  private readonly source: UsageSource;
  private readonly format: string;
  /** Usage par message Claude (dédupliqué par id) / cumul de tours Codex / total autoritaire. */
  private readonly perMessage = new Map<string, TokenUsage>();
  private turns: TokenUsage = emptyUsage();
  private authoritative: TokenUsage | null = null;
  private reportedCostUsd: number | null = null;
  private acpCostUsd: number | null = null;
  private contextUsed: number | null = null;
  private model: string | null;
  private buffer = '';
  private metered = false;
  private instructionsTokens: number | null = null;
  private flushed: TokenUsage = emptyUsage();
  private flushedCostUsd = 0;
  private lastFlush = 0;
  private flushing: Promise<void> = Promise.resolve();
  private breached: BudgetBreach | null = null;
  private baseTotals: Awaited<ReturnType<typeof currentTotals>> | null = null;
  private startedAt = Date.now();

  private constructor(o: SessionMeterOptions) {
    this.o = o;
    this.settings = resolveTokensSettings(o.config);
    this.format = o.format;
    this.source = o.format === 'acp' ? 'acp' : 'agent-stream';
    this.model = o.model ?? null;
  }

  /** `null` quand la comptabilité est coupée par la config. */
  static async open(o: SessionMeterOptions): Promise<SessionMeter | null> {
    const settings = resolveTokensSettings(o.config);
    if (!settings.accounting) return null;
    const meter = new SessionMeter(o);
    await meter.refreshBase();
    return meter;
  }

  get breach(): BudgetBreach | null {
    return this.breached;
  }

  /** Taille estimée des consignes injectées (mesurée, jamais le texte). */
  noteInstructions(text: string | null): void {
    this.instructionsTokens = text ? estimateTokens(text, this.settings.estimator) : null;
  }

  private async refreshBase(): Promise<void> {
    try {
      this.baseTotals = await currentTotals(this.o.root, {
        taskId: this.o.taskId,
        agent: this.o.agent,
      });
    } catch (error) {
      // Base vide = budgets aveugles : journalisé (code stable), refusé en mode 'fail'.
      reportAccountingFailure(this.settings, error, 'session-budget-baseline');
    }
  }

  // ------------------------------------------------------------------ flux

  /** Alimente le compteur avec un morceau de sortie brute (argv). */
  feedChunk(chunk: string | Buffer): void {
    if (this.format === 'none' || this.format === 'acp' || this.format === 'ndjson') return;
    this.buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    let nl: number;
    while ((nl = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, nl).trim();
      this.buffer = this.buffer.slice(nl + 1);
      this.feedLine(line);
    }
    // Ligne sans fin de ligne qui s'étire indéfiniment : jamais de mémoire non bornée.
    if (this.buffer.length > 1_048_576) this.buffer = '';
  }

  private feedLine(line: string): void {
    // Préfiltre : n'analyser que les lignes susceptibles de porter un usage
    // (les sorties d'outils volumineuses ne sont jamais parsées).
    if (!line.startsWith('{') || !(line.includes('"usage"') || line.includes('"stats"'))) return;
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      return; // ligne tronquée / non JSON : ignorée, le flux brut garde tout
    }
    if (!isObject(event)) return;
    const usage = extractStreamUsage(this.format as never, event);
    if (usage) this.apply(usage);
  }

  private apply(ev: StreamUsageEvent): void {
    this.metered = true;
    if (ev.kind === 'message') {
      const prev = this.perMessage.get(ev.id);
      this.perMessage.set(ev.id, prev ? maxUsage(prev, ev.usage) : ev.usage);
      if (ev.model) this.model = ev.model;
    } else if (ev.kind === 'turn') {
      this.turns = addUsage(this.turns, ev.usage);
    } else {
      this.authoritative = ev.usage;
      if (ev.costUsd !== null) this.reportedCostUsd = ev.costUsd;
    }
    this.afterUpdate();
  }

  /** ACP : `session/update` de l'agent (usage_update : contexte utilisé + coût cumulé de session). */
  feedAcpUpdate(update: Json): void {
    if (update.sessionUpdate !== 'usage_update') return;
    this.metered = true;
    const used = update.used;
    if (typeof used === 'number' && Number.isFinite(used) && used >= 0) this.contextUsed = used;
    const cost = update.cost;
    if (isObject(cost) && typeof cost.amount === 'number' && cost.currency === 'USD') {
      this.acpCostUsd = cost.amount;
    }
    this.afterUpdate();
  }

  /** ACP : usage de tour de la réponse à `session/prompt` (champ `usage` du brouillon du protocole). */
  feedAcpTurn(turn: unknown): void {
    if (!isObject(turn)) return;
    const usage = fromAcpUsage(turn.usage);
    if (!usage) return;
    this.metered = true;
    this.turns = addUsage(this.turns, usage);
    this.afterUpdate();
  }

  // --------------------------------------------------------------- cumuls

  /** Usage cumulé de la session (total autoritaire > cumul de messages + tours). */
  current(): TokenUsage {
    if (this.authoritative) return this.authoritative;
    let sum = this.turns;
    for (const u of this.perMessage.values()) sum = addUsage(sum, u);
    return sum;
  }

  private costNow(): number | null {
    if (this.reportedCostUsd !== null) return this.reportedCostUsd;
    if (this.acpCostUsd !== null) return this.acpCostUsd;
    return costOf(this.current(), this.settings.pricing, this.o.provider ?? null, this.model);
  }

  private afterUpdate(): void {
    this.checkBudget();
    const now = Date.now();
    if (now - this.lastFlush >= FLUSH_INTERVAL_MS) this.scheduleFlush('ok');
  }

  private liveFindings(): BudgetFinding[] {
    const base = this.baseTotals ?? {
      perDay: { tokens: 0, costUsd: 0, unpriced: 0 },
      perTask: { tokens: 0, costUsd: 0, unpriced: 0 },
      perAgent: { tokens: 0, costUsd: 0, unpriced: 0 },
      global: { tokens: 0, costUsd: 0, unpriced: 0 },
    };
    // `base` a été relu au dernier flush (il contient donc déjà les deltas
    // écrits) : on y ajoute seulement ce qui n'est pas encore au registre.
    const pendingTokens = Math.max(0, totalTokens(this.current()) - totalTokens(this.flushed));
    const cost = this.costNow();
    const pendingCost = cost === null ? 0 : Math.max(0, cost - this.flushedCostUsd);
    const plus = (t: { tokens: number; costUsd: number; unpriced: number }) => ({
      tokens: t.tokens + pendingTokens,
      costUsd: t.costUsd + pendingCost,
      unpriced: t.unpriced,
    });
    return evaluateBudgets(
      this.settings,
      {
        perDay: plus(base.perDay),
        perTask: plus(base.perTask),
        perAgent: plus(base.perAgent),
        global: plus(base.global),
      },
      { inputTokens: 0, outputTokens: 0, costUsd: 0 },
      { agent: this.o.agent, taskId: this.o.taskId, day: utcDay(Date.now()) },
    ).filter((f) => f.scope !== 'perCall');
  }

  private checkBudget(): void {
    const findings = this.liveFindings();
    void emitFindings(findings, {
      root: this.o.root,
      config: this.o.config,
      settings: this.settings,
      role: 'agent',
      agent: this.o.agent,
      taskId: this.o.taskId,
    }).catch((error) => logAccountingFailure(error, 'session-alert-emission'));
    const breach = firstBreach(findings, this.settings);
    if (breach && !this.breached) {
      this.breached = breach;
      try {
        this.o.onBreach?.(breach);
      } catch (error) {
        logger.warn({ err: error }, 'Session : arrêt sur budget en échec');
      }
    }
  }

  // ------------------------------------------------------------- registre

  private scheduleFlush(outcome: UsageRecord['outcome']): void {
    this.lastFlush = Date.now();
    this.flushing = this.flushing
      .then(() => this.writeDelta(outcome))
      .catch((error) => {
        // Dans un flux : rien ne peut recevoir une exception, journalisé seulement.
        logAccountingFailure(error, 'session-usage-flush');
      });
  }

  private async writeDelta(outcome: UsageRecord['outcome'], final = false): Promise<void> {
    const now = this.current();
    const delta: TokenUsage = {
      input: Math.max(0, now.input - this.flushed.input),
      output: Math.max(0, now.output - this.flushed.output),
      cacheRead: Math.max(0, now.cacheRead - this.flushed.cacheRead),
      cacheWrite: Math.max(0, now.cacheWrite - this.flushed.cacheWrite),
      reasoning: Math.max(0, now.reasoning - this.flushed.reasoning),
    };
    const empty = totalTokens(delta) === 0;
    const cost = this.costNow();
    const costDelta = cost === null ? null : Math.max(0, cost - this.flushedCostUsd);
    if (empty && !final && (costDelta ?? 0) === 0) return;
    const metered = this.metered;
    const record: UsageRecord = {
      v: 1,
      ts: new Date().toISOString(),
      role: 'agent',
      provider: this.o.provider ?? null,
      model: this.model,
      agent: this.o.agent,
      taskId: this.o.taskId,
      durationMs: final ? Date.now() - this.startedAt : 0,
      source: metered ? this.source : 'unmetered',
      outcome,
      estimated: false,
      input: metered ? delta.input : null,
      output: metered ? delta.output : null,
      cacheRead: metered ? delta.cacheRead : null,
      cacheWrite: metered ? delta.cacheWrite : null,
      reasoning: metered ? delta.reasoning : null,
      costUsd: metered ? costDelta : null,
      ...(final && this.instructionsTokens !== null
        ? { instructionsTokens: this.instructionsTokens }
        : {}),
      ...(this.contextUsed !== null ? { contextUsed: this.contextUsed } : {}),
    };
    await appendUsage(this.o.root, record);
    this.flushed = now;
    this.flushedCostUsd = cost ?? this.flushedCostUsd;
    await this.refreshBase();
  }

  /**
   * Fin de session : dernier delta (outcome 'ok', ou 'stopped' si un budget a
   * arrêté la session), puis le résumé pour le SessionResult.
   */
  async close(): Promise<SessionUsageSummary> {
    if (this.buffer.trim().length > 0) {
      this.feedLine(this.buffer.trim());
      this.buffer = '';
    }
    this.checkBudget();
    await this.flushing;
    try {
      await this.writeDelta(this.breached ? 'stopped' : 'ok', true);
    } catch (error) {
      logAccountingFailure(error, 'session-final-flush');
    }
    const u = this.current();
    return {
      source: this.metered ? this.source : 'unmetered',
      metered: this.metered,
      input: this.metered ? u.input : null,
      output: this.metered ? u.output : null,
      cacheRead: this.metered ? u.cacheRead : null,
      cacheWrite: this.metered ? u.cacheWrite : null,
      costUsd: this.metered ? this.costNow() : null,
      instructionsTokens: this.instructionsTokens,
    };
  }
}

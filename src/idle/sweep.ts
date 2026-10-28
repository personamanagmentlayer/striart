/**
 * Balayage du GC d'inactivité : détecter → avertir → fermer, sur tous les agents
 * du registre, SANS jamais tenir le verrou principal (lecture seule + fermeture
 * propre d'une session ; les écritures d'état passent par `updateJsonLocked`).
 *
 * Invariants (voir l'ADR) :
 *  - Aucune suppression de données ici : ni clone, ni registre, ni branche. Le
 *    GC ne rebase pas, ne merge pas — il ferme au plus une SESSION, proprement.
 *  - Aucune fermeture sans : action 'close' (ou demande humaine explicite),
 *    autorisation de la config UTILISATEUR (sauf demande humaine), avertissement
 *    antérieur d'au moins \`graceMs\`, inactivité >= \`closeAfterMs\`, aucun
 *    garde-fou, aucune source de contexte illisible, et une REVÉRIFICATION
 *    fraîche juste avant d'agir (un signal apparu entre-temps annule).
 *  - \`dryRun\` n'écrit rien (ni état, ni événement) et ne ferme rien.
 *  - Reprise de veille (\`suspended\`) : aucune décision, l'horloge a sauté.
 */
import { readRegistry } from '../clone.js';
import { loadConfig } from '../config.js';
import { agentUnknownError } from '../errors.js';
import { emitStriartEvent } from '../events.js';
import { logger } from '../logger.js';
import { rm } from 'node:fs/promises';
import { closeAuthorization } from './authorize.ts';
import type { AgentMeta } from '../types.js';
import { classifyAgent } from './classify.ts';
import type {
  BlockerCode,
  HostKind,
  IdleStage,
  IdleVerdict,
  SessionKind,
  SignalName,
} from './classify.ts';
import { closeSession, DEFAULT_CLOSE_TIMINGS } from './close.ts';
import type { CloseTimings } from './close.ts';
import { closeRequestPath } from './paths.ts';
import { collectAgentFacts, loadSweepContext } from './signals.ts';
import type { AgentFacts, SweepContext } from './signals.ts';
import { resolveIdleSettings } from './settings.ts';
import type { IdleAction } from './settings.ts';
import {
  claimClose,
  finishClose,
  finishSweep,
  readIdleState,
  recordMark,
  resetMarks,
} from './state.ts';
import type { IdleState } from './state.ts';

export interface AgentIdleReport {
  agent: string;
  state: IdleVerdict['state'];
  stage: IdleStage;
  session: SessionKind;
  host: HostKind;
  idleMs: number | null;
  lastActivityAt: string | null;
  lastActivitySignal: SignalName | null;
  reasons: string[];
  blockers: BlockerCode[];
  plan: IdleVerdict['plan'];
  closable: boolean;
  closeBlockedBy: string[];
  warnedAt: string | null;
  closeNotBefore: string | null;
  signals: Array<{ name: SignalName; status: string; at: string | null }>;
  /** Parcours du worktree sauté parce qu'un signal frais suffisait. */
  worktreeSkipped: boolean;
}

export interface SweepReport {
  generatedAt: string;
  dryRun: boolean;
  enabled: boolean;
  action: IdleAction;
  /** La config UTILISATEUR autorise-t-elle la fermeture pour ce dépôt ? */
  closeAuthorized: boolean;
  /** Code stable si la config utilisateur n'a pas pu être lue (fermeture alors refusée). */
  authorizationError: string | null;
  /** Fermeture demandée explicitement par un humain pour ce balayage. */
  forced: boolean;
  /** Balayage neutralisé : reprise de veille détectée (aucune décision prise). */
  suspended: boolean;
  /** Sources de contexte illisibles : tant qu'il y en a, aucune fermeture. */
  holds: string[];
  thresholds: { warnAfterMs: number; closeAfterMs: number; graceMs: number };
  agents: AgentIdleReport[];
  /** Agents avertis par CE balayage. */
  warned: string[];
  /** Sessions fermées (`CLOSED`) ou en cours de fermeture (`CLOSING`) par CE balayage. */
  closed: Array<{ agent: string; host: HostKind; code: string }>;
  /** Fermetures refusées par une garde (codes IDLE_CLOSE_*) : la session reste vivante. */
  refused: Array<{ agent: string; host: HostKind; code: string; detail: string | null }>;
}

export interface SweepOptions {
  root: string;
  dryRun?: boolean;
  /** Demande humaine de fermer (`striart gc --close`) : remplace action et autorisation, jamais la grâce. */
  close?: boolean;
  /** Limiter le balayage à un agent. */
  agent?: string | null;
  now?: number;
  /** Reprise de veille détectée par l'appelant : observer seulement. */
  suspended?: boolean;
  timings?: CloseTimings;
  /** Activité du worktree déjà mesurée par l'appelant (évite un second parcours). */
  worktreeMs?: ReadonlyMap<string, number>;
  /** Config déjà chargée (sinon lue). */
  config?: import('../types.js').StriartConfig;
}

const iso = (ms: number | null): string | null => (ms === null ? null : new Date(ms).toISOString());

function toReport(verdict: IdleVerdict, facts: AgentFacts): AgentIdleReport {
  return {
    agent: verdict.agent,
    state: verdict.state,
    stage: verdict.stage,
    session: verdict.kind,
    host: verdict.host,
    idleMs: verdict.idleMs,
    lastActivityAt: iso(verdict.lastActivityAt),
    lastActivitySignal: verdict.lastActivitySignal,
    reasons: verdict.reasons,
    blockers: verdict.blockers,
    plan: verdict.plan,
    closable: verdict.closable,
    closeBlockedBy: verdict.closeBlockedBy,
    warnedAt: iso(verdict.warnedAt),
    closeNotBefore: iso(verdict.closeNotBefore),
    signals: facts.readings.map((r) => ({ name: r.name, status: r.status, at: iso(r.at) })),
    worktreeSkipped: facts.worktreeSkipped,
  };
}

const CONCURRENCY = 4;

async function mapLimited<T, R>(items: readonly T[], fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, items.length) }, async () => {
      while (next < items.length) {
        const index = next++;
        out[index] = await fn(items[index]!);
      }
    }),
  );
  return out;
}

const minutes = (ms: number) => Math.max(1, Math.round(ms / 60_000));

export async function sweepIdle(options: SweepOptions): Promise<SweepReport> {
  const { root, dryRun = false, close = false, agent = null, suspended = false } = options;
  const now = options.now ?? Date.now();
  const config = options.config ?? (await loadConfig(root));
  const settings = resolveIdleSettings(config);
  const authorization = await closeAuthorization(root);

  const report: SweepReport = {
    generatedAt: new Date(now).toISOString(),
    dryRun,
    enabled: settings.enabled,
    action: settings.action,
    closeAuthorized: authorization.authorized,
    authorizationError: authorization.error,
    forced: close,
    suspended,
    holds: [],
    thresholds: {
      warnAfterMs: settings.warnAfterMs,
      closeAfterMs: settings.closeAfterMs,
      graceMs: settings.graceMs,
    },
    agents: [],
    warned: [],
    closed: [],
    refused: [],
  };
  if (!settings.enabled) return report;

  const registry = await readRegistry(root);
  // Un agent désigné qui n'existe pas est une erreur, pas un balayage vide qui « réussit ».
  if (agent !== null && !registry[agent]) throw agentUnknownError(agent);
  const names = Object.keys(registry).filter((n) => agent === null || n === agent);
  const ctx = await loadSweepContext(root, settings);
  report.holds = [...ctx.holds];

  let state: IdleState;
  try {
    state = await readIdleState(root);
  } catch {
    // État illisible : on ne sait plus qui a été averti → aucune fermeture, aucune écriture.
    state = { version: 1, lastSweepAt: null, agents: {} };
    report.holds.push('IDLE_STATE_UNREADABLE');
  }
  const mayWrite = !dryRun && !report.holds.includes('IDLE_STATE_UNREADABLE');

  const classifyOne = async (name: string, meta: AgentMeta, hint?: number) => {
    const facts = await collectAgentFacts(ctx, name, meta, { worktreeMs: hint, now });
    const warned = Date.parse(state.agents[name]?.warnedAt ?? '');
    const verdict = classifyAgent(
      {
        name,
        kind: facts.kind,
        host: facts.host,
        signals: facts.readings,
        blockers: facts.blockers,
        warnedAt: Number.isFinite(warned) ? warned : null,
        closeAuthorized: authorization.authorized,
        forceClose: close,
        ptyOutputObserved: facts.ptyOutputObserved,
      },
      settings,
      now,
    );
    return { facts, verdict };
  };

  const results = await mapLimited(names, async (name) => {
    try {
      return { name, ...(await classifyOne(name, registry[name]!, options.worktreeMs?.get(name))) };
    } catch (error) {
      // Un agent qu'on n'a pas su inspecter n'est jamais jugé inactif (fail closed).
      logger.warn(
        { agent: name, err: (error as { code?: string }).code },
        'Inspection GC impossible',
      );
      return null;
    }
  });

  const decided: Array<NonNullable<(typeof results)[number]>> = [];
  for (const result of results) {
    if (result === null) continue;
    decided.push(result);
    report.agents.push(toReport(result.verdict, result.facts));
  }

  if (suspended && !dryRun) {
    await resetMarks(root).catch((error) => {
      logger.warn({ err: (error as { code?: string }).code }, 'Marques du GC non réinitialisées');
    });
  }
  if (suspended || dryRun) {
    return report;
  }

  let closures = 0;
  for (const { name, facts, verdict } of decided) {
    const lastActivityAt = verdict.lastActivityAt;

    // Détection (une fois par période d'inactivité, sessions vivantes seulement).
    if (verdict.state === 'idle' && verdict.kind === 'live' && mayWrite) {
      if (await recordMark(root, name, 'detectedAt', { at: now, lastActivityAt })) {
        await emitStriartEvent(config, {
          type: 'idle:detected',
          agent: name,
          idleMs: verdict.idleMs ?? 0,
          session: verdict.kind,
          host: verdict.host,
        });
      }
    }

    if (verdict.plan === 'warn' && mayWrite) {
      if (await recordMark(root, name, 'warnedAt', { at: now, lastActivityAt })) {
        report.warned.push(name);
        const willClose =
          (close || settings.action === 'close') && (close || authorization.authorized);
        await emitStriartEvent(config, {
          type: 'idle:warned',
          agent: name,
          idleMs: verdict.idleMs ?? 0,
          closeNotBefore: iso(now + settings.graceMs),
          willClose,
          message: willClose
            ? `⏳ [Striart] Agent ${name} inactif depuis ${minutes(verdict.idleMs ?? 0)} min : sa session sera fermée dans ${minutes(settings.graceMs)} min sans nouvelle activité (le clone et son travail sont conservés).`
            : `⏳ [Striart] Agent ${name} inactif depuis ${minutes(verdict.idleMs ?? 0)} min (session ${verdict.host}) — fermeture automatique non activée.`,
        });
      }
      continue;
    }

    if (verdict.plan !== 'close') continue;

    const refuse = async (code: string, detail: string | null, host: HostKind) => {
      report.refused.push({ agent: name, host, code, detail });
      await emitStriartEvent(config, {
        type: 'idle:close-refused',
        agent: name,
        host: host as 'acp' | 'pty' | 'process',
        code,
        detail,
        message: `⚠️ [Striart] Fermeture de la session inactive de ${name} refusée (${code}${detail ? ` : ${detail}` : ''}) — session laissée intacte.`,
      });
    };

    if (report.holds.length > 0) {
      await refuse('IDLE_CLOSE_BLOCKED', report.holds[0]!, verdict.host);
      continue;
    }
    if (closures >= settings.maxClosuresPerSweep) continue; // reporté au balayage suivant
    if (!(await claimClose(root, name, now))) continue; // un autre balayage la mène

    try {
      // REVÉRIFICATION fraîche juste avant d'agir : registre, signaux, garde-fous, sans indice.
      const freshRegistry = await readRegistry(root);
      const freshMeta = freshRegistry[name];
      const freshCtx: SweepContext = await loadSweepContext(root, settings);
      let second: Awaited<ReturnType<typeof classifyOne>> | null = null;
      if (freshMeta && freshCtx.holds.length === 0) {
        const recheckNow = options.now ?? Date.now();
        const factsAgain = await collectAgentFacts(freshCtx, name, freshMeta, { now: recheckNow });
        second = {
          facts: factsAgain,
          verdict: classifyAgent(
            {
              name,
              kind: factsAgain.kind,
              host: factsAgain.host,
              signals: factsAgain.readings,
              blockers: factsAgain.blockers,
              warnedAt: verdict.warnedAt,
              closeAuthorized: authorization.authorized,
              forceClose: close,
              ptyOutputObserved: factsAgain.ptyOutputObserved,
            },
            settings,
            recheckNow,
          ),
        };
      }
      if (!second || second.verdict.plan !== 'close' || second.facts.host !== facts.host) {
        await finishClose(root, name, { result: 'SKIPPED_ACTIVE', host: facts.host, at: now });
        continue;
      }
      closures += 1;
      const outcome = await closeSession(
        root,
        name,
        freshMeta!,
        { host: second.facts.host, pid: second.facts.sessionPid },
        options.timings ?? DEFAULT_CLOSE_TIMINGS,
      );
      await finishClose(root, name, {
        result: outcome.code ?? outcome.status,
        host: outcome.host,
        at: Date.now(),
      });
      if (outcome.status === 'CLOSED' || outcome.status === 'CLOSING') {
        report.closed.push({ agent: name, host: outcome.host, code: outcome.status });
        await emitStriartEvent(config, {
          type: 'idle:closed',
          agent: name,
          host: outcome.host as 'acp' | 'pty' | 'process',
          code: outcome.status,
          message: `🧹 [Striart] Session inactive de ${name} fermée proprement (${outcome.host}) — clone et travail non commité conservés.`,
        });
      } else {
        await refuse(outcome.code ?? 'IDLE_CLOSE_FAILED', outcome.detail, outcome.host);
      }
    } catch (error) {
      await finishClose(root, name, {
        result: 'IDLE_CLOSE_FAILED',
        host: facts.host,
        at: Date.now(),
      }).catch(() => undefined);
      report.refused.push({
        agent: name,
        host: facts.host,
        code: 'IDLE_CLOSE_FAILED',
        detail: (error as { code?: string }).code ?? 'ERROR',
      });
    }
  }

  // Demandes de fermeture périmées : aucune session vivante ne les lira jamais.
  for (const { name, verdict } of decided) {
    if (verdict.kind !== 'live')
      await rm(closeRequestPath(root, name), { force: true }).catch(() => undefined);
  }

  if (mayWrite && agent === null) {
    await finishSweep(root, { at: now, knownAgents: Object.keys(registry) }).catch((error) => {
      logger.warn({ err: (error as { code?: string }).code }, 'État du GC non mis à jour');
    });
  }
  return report;
}

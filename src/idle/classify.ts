/**
 * Classification d'inactivité d'un agent — logique PURE (aucune E/S, l'horloge
 * est un paramètre), donc testable à l'unité sur tous les cas limites.
 *
 * Principes (voir l'ADR du GC d'inactivité) :
 *  1. Un agent n'est `idle` que si TOUS les signaux d'activité dépassent le
 *     seuil : l'activité est le MAX des horodatages, jamais un signal seul.
 *  2. FAIL CLOSED : un signal illisible (`unknown`), une horloge incohérente
 *     ou l'absence de tout signal rendent l'agent ACTIF. Seul un signal
 *     `absent` (« rien n'a jamais eu lieu ») ou `unobservable` (« ce type
 *     d'hôte ne le publie pas ») ne compte ni pour ni contre.
 *  3. Un garde-fou (`blockers`) protège l'agent de toute action, quelle que
 *     soit son inactivité : demande humaine en attente, ticket ouvert, plan
 *     d'orchestration, merge en cours, session du principal, suppression en
 *     cours, exclusion de la config.
 *  4. Le plan est gradué : détecter → avertir → (grâce) → fermer. Aucune
 *     fermeture sans un avertissement antérieur d'au moins `graceMs`, posé
 *     DEPUIS la dernière activité : toute activité remet le compteur à zéro.
 */
import type { IdleSettings } from './settings.ts';

export type SignalName = 'sessionStart' | 'sessionOutput' | 'worktree' | 'refs' | 'messages';

export interface SignalReading {
  name: SignalName;
  /**
   *  - known        : `at` est l'instant (ms epoch) de la dernière activité ;
   *  - absent       : le signal n'a jamais eu lieu (aucune contribution) ;
   *  - unknown      : lecture impossible (FAIL CLOSED : agent actif) ;
   *  - unobservable : ce type d'hôte ne publie pas ce signal (aucune contribution).
   */
  status: 'known' | 'absent' | 'unknown' | 'unobservable';
  at: number | null;
}

/** `live` : un process de session vit ; `ended` : session terminée, clone conservé ; `none` : jamais lancée. */
export type SessionKind = 'live' | 'ended' | 'none';
/** Comment la session vivante est portée (détermine la voie de fermeture). */
export type HostKind = 'acp' | 'pty' | 'process' | 'none';

export type BlockerCode =
  | 'HUMAN_REQUEST'
  | 'OPEN_TICKET'
  | 'ORCHESTRATED'
  | 'MERGE_IN_PROGRESS'
  | 'MAIN_SESSION'
  | 'REMOVING'
  | 'EXCLUDED';

export interface IdleInput {
  name: string;
  kind: SessionKind;
  host: HostKind;
  signals: readonly SignalReading[];
  blockers: readonly BlockerCode[];
  /** Instant du dernier avertissement émis pour cet agent (état persistant), sinon null. */
  warnedAt: number | null;
  /** La config UTILISATEUR autorise-t-elle la fermeture pour ce dépôt ? */
  closeAuthorized: boolean;
  /** Demande humaine explicite de fermer (`striart gc --close`) : remplace action et autorisation. */
  forceClose: boolean;
  /**
   * Terminal : la dernière sortie du pty est PUBLIÉE par l'hôte (`host.output`) et lue avec succès
   * pour cette passe. Seule cette lecture lève `PTY_OUTPUT_UNOBSERVABLE` sans `idle.closePty` ;
   * absent / faux = la sortie du terminal n'est pas observée (fail closed).
   */
  ptyOutputObserved?: boolean;
}

export type IdleStage = 'active' | 'protected' | 'idle' | 'warned' | 'closable';

export interface IdleVerdict {
  agent: string;
  kind: SessionKind;
  host: HostKind;
  /** active : au moins un signal frais ; idle : tous au-delà du seuil ; protected : garde-fou. */
  state: 'active' | 'idle' | 'protected';
  stage: IdleStage;
  /** Dernière activité (ms epoch), null si inconnue. */
  lastActivityAt: number | null;
  lastActivitySignal: SignalName | null;
  idleMs: number | null;
  /** Pourquoi l'agent est considéré actif (codes stables), vide s'il est idle. */
  reasons: string[];
  blockers: BlockerCode[];
  /** Action à entreprendre à ce balayage. */
  plan: 'none' | 'warn' | 'close';
  /** La fermeture est-elle permise MAINTENANT (grâce écoulée, seuil atteint, autorisée) ? */
  closable: boolean;
  /** Pourquoi la fermeture n'est pas (encore) permise, codes stables. */
  closeBlockedBy: string[];
  warnedAt: number | null;
  /** Instant avant lequel la fermeture reste interdite (fin de la grâce), si averti. */
  closeNotBefore: number | null;
}

/** Écart d'horloge toléré entre un mtime de fichier et l'heure du balayage. */
const CLOCK_TOLERANCE_MS = 5_000;

const validTime = (at: unknown): at is number =>
  typeof at === 'number' && Number.isFinite(at) && at >= 0;

export function classifyAgent(input: IdleInput, settings: IdleSettings, now: number): IdleVerdict {
  const reasons: string[] = [];
  let last: number | null = null;
  let lastSignal: SignalName | null = null;

  for (const signal of input.signals) {
    if (signal.status === 'absent' || signal.status === 'unobservable') continue;
    if (signal.status === 'unknown' || !validTime(signal.at)) {
      reasons.push(`SIGNAL_UNKNOWN:${signal.name}`);
      continue;
    }
    let at = signal.at;
    if (at > now + CLOCK_TOLERANCE_MS) {
      reasons.push('CLOCK_SKEW');
      reasons.push(`SIGNAL_FRESH:${signal.name}`);
      at = now;
    } else if (at > now) {
      at = now;
    }
    if (last === null || at > last) {
      last = at;
      lastSignal = signal.name;
    }
  }
  if (last === null && reasons.length === 0) reasons.push('NO_SIGNAL');

  const idleMs = last === null ? null : now - last;
  const failClosed = reasons.length > 0;
  const base = {
    agent: input.name,
    kind: input.kind,
    host: input.host,
    lastActivityAt: last,
    lastActivitySignal: lastSignal,
    idleMs,
    blockers: [...input.blockers],
    warnedAt: input.warnedAt,
  };

  if (input.blockers.length > 0) {
    return {
      ...base,
      state: 'protected',
      stage: 'protected',
      reasons,
      plan: 'none',
      closable: false,
      closeBlockedBy: [...input.blockers],
      closeNotBefore: null,
    };
  }

  if (failClosed || idleMs === null) {
    return {
      ...base,
      state: 'active',
      stage: 'active',
      reasons,
      plan: 'none',
      closable: false,
      closeBlockedBy: ['ACTIVE'],
      closeNotBefore: null,
    };
  }

  if (idleMs < settings.warnAfterMs) {
    // Les signaux frais sont nommés pour l'explication (« pourquoi actif ? »).
    for (const signal of input.signals) {
      if (
        signal.status === 'known' &&
        validTime(signal.at) &&
        now - signal.at < settings.warnAfterMs
      )
        reasons.push(`SIGNAL_FRESH:${signal.name}`);
    }
    return {
      ...base,
      state: 'active',
      stage: 'active',
      reasons,
      plan: 'none',
      closable: false,
      closeBlockedBy: ['ACTIVE'],
      closeNotBefore: null,
    };
  }

  // Idle : tous les signaux sont au-delà de warnAfterMs.
  const verdict = { ...base, state: 'idle' as const, reasons: [] as string[] };
  const blockedBy: string[] = [];

  if (input.kind !== 'live') {
    // Rien à fermer : session morte ou jamais lancée. Rapporté, jamais « traité ».
    return {
      ...verdict,
      stage: 'idle',
      plan: 'none',
      closable: false,
      closeBlockedBy: ['NO_LIVE_SESSION'],
      closeNotBefore: null,
    };
  }

  const action = input.forceClose ? 'close' : settings.action;
  if (action === 'report') {
    return {
      ...verdict,
      stage: 'idle',
      plan: 'none',
      closable: false,
      closeBlockedBy: ['ACTION_REPORT'],
      closeNotBefore: null,
    };
  }

  // L'avertissement ne vaut que pour la période d'inactivité en cours : posé
  // avant la dernière activité, il appartient à une période révolue.
  const warnValid = input.warnedAt !== null && last !== null && input.warnedAt >= last;
  if (!warnValid) {
    return {
      ...verdict,
      stage: 'idle',
      plan: 'warn',
      closable: false,
      closeBlockedBy: ['NOT_WARNED'],
      closeNotBefore: null,
    };
  }

  const closeNotBefore = (input.warnedAt as number) + settings.graceMs;
  if (action === 'warn') {
    return {
      ...verdict,
      stage: 'warned',
      plan: 'none',
      closable: false,
      closeBlockedBy: ['ACTION_WARN'],
      closeNotBefore,
    };
  }

  if (idleMs < settings.closeAfterMs) blockedBy.push('BELOW_CLOSE_THRESHOLD');
  if (now < closeNotBefore) blockedBy.push('GRACE_RUNNING');
  if (!input.forceClose && !input.closeAuthorized) blockedBy.push('NOT_AUTHORIZED');
  if (input.host === 'pty' && !settings.closePty && input.ptyOutputObserved !== true)
    blockedBy.push('PTY_OUTPUT_UNOBSERVABLE');

  const closable = blockedBy.length === 0;
  return {
    ...verdict,
    stage: closable ? 'closable' : 'warned',
    plan: closable ? 'close' : 'none',
    closable,
    closeBlockedBy: blockedBy,
    closeNotBefore,
  };
}

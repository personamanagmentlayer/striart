/**
 * État persistant du GC d'inactivité (`.striart/idle/state.json`).
 *
 * Ce qui DOIT survivre d'un balayage à l'autre — et seulement cela :
 *  - l'instant de l'avertissement par agent (le délai de grâce court depuis lui,
 *    et le balayage suivant peut être un autre process : `striart gc` puis
 *    `striart watch`) ;
 *  - la revendication d'une fermeture en cours (deux balayages concurrents ne
 *    ferment pas la même session deux fois) ;
 *  - le résultat de la dernière fermeture (affiché, jamais rejoué).
 * L'inactivité elle-même n'est PAS stockée : elle se recalcule à chaque balayage
 * depuis les signaux, donc ne peut pas périmer.
 *
 * Toute lecture-modification-écriture passe par `updateJsonLocked` (verrou
 * d'état de `idle/`, section courte : ni git, ni process, ni attente réseau).
 */
import { mkdir } from 'node:fs/promises';
import { readJson, updateJsonLocked, UNCHANGED } from '../json-file.ts';
import { idleDir, idleStatePath } from './paths.ts';

export interface AgentIdleRecord {
  /** Dernier avertissement (ISO). */
  warnedAt?: string;
  /** Dernière détection d'inactivité signalée (ISO). */
  detectedAt?: string;
  /** Fermeture revendiquée (ISO) par le process `closingPid`. */
  closingAt?: string;
  closingPid?: number;
  /** Dernière fermeture aboutie (ISO) et son hôte. */
  closedAt?: string;
  closedHost?: string;
  /** Dernier résultat de fermeture (`CLOSED`, `CLOSING`, un code `IDLE_CLOSE_*` ou `SKIPPED_ACTIVE`). */
  lastClose?: string;
}

export interface IdleState {
  version: 1;
  /** Dernier balayage mené jusqu'au bout (ISO). */
  lastSweepAt: string | null;
  agents: Record<string, AgentIdleRecord>;
}

const FALLBACK = (): IdleState => ({ version: 1, lastSweepAt: null, agents: {} });
const OPTIONS = { code: 'IDLE_STATE_CORRUPT' } as const;
/** Une revendication plus vieille que ça est abandonnée (process mort pendant la fermeture). */
export const CLOSE_CLAIM_TTL_MS = 2 * 60_000;

export async function readIdleState(root: string): Promise<IdleState> {
  const state = await readJson(idleStatePath(root), { fallback: FALLBACK(), ...OPTIONS });
  // Forme minimale garantie : un fichier d'une autre version ne casse pas le balayage.
  return {
    version: 1,
    lastSweepAt: typeof state?.lastSweepAt === 'string' ? state.lastSweepAt : null,
    agents: typeof state?.agents === 'object' && state.agents !== null ? state.agents : {},
  };
}

async function update(root: string, mutate: (state: IdleState) => IdleState | typeof UNCHANGED) {
  await mkdir(idleDir(root), { recursive: true, mode: 0o700 });
  return updateJsonLocked(idleStatePath(root), { fallback: FALLBACK(), ...OPTIONS }, (current) => {
    const state: IdleState = {
      version: 1,
      lastSweepAt: current?.lastSweepAt ?? null,
      agents: { ...(current?.agents ?? {}) },
    };
    return mutate(state);
  });
}

/**
 * Marque `field` (`warnedAt` : avertissement ; `detectedAt` : détection) de `agent` —
 * ATOMIQUEMENT, et une seule fois par période d'inactivité : si une marque
 * postérieure à `lastActivityAt` est déjà enregistrée (un autre process l'a
 * posée), rend false et n'écrit rien. Le balayage qui reçoit true est le seul
 * à notifier. Un nouvel avertissement lève aussi une revendication de
 * fermeture périmée.
 */
export async function recordMark(
  root: string,
  agent: string,
  field: 'warnedAt' | 'detectedAt',
  { at, lastActivityAt }: { at: number; lastActivityAt: number | null },
): Promise<boolean> {
  let recorded = false;
  await update(root, (state) => {
    const record: AgentIdleRecord = { ...state.agents[agent] };
    const existing = Date.parse(record[field] ?? '');
    if (Number.isFinite(existing) && existing >= (lastActivityAt ?? 0)) return UNCHANGED;
    record[field] = new Date(at).toISOString();
    if (field === 'warnedAt') {
      delete record.closingAt;
      delete record.closingPid;
    }
    state.agents[agent] = record;
    recorded = true;
    return state;
  });
  return recorded;
}

/**
 * Efface avertissements et détections de TOUS les agents (reprise de veille) :
 * le délai de grâce repart de zéro, les agents gelés avec la machine ayant le
 * temps de reprendre avant toute décision.
 */
export async function resetMarks(root: string): Promise<void> {
  await update(root, (state) => {
    let changed = false;
    for (const record of Object.values(state.agents)) {
      for (const field of ['warnedAt', 'detectedAt', 'closingAt', 'closingPid'] as const) {
        if (field in record) {
          delete record[field];
          changed = true;
        }
      }
    }
    return changed ? state : UNCHANGED;
  });
}

/** Revendique la fermeture de `agent` ; false si un autre balayage la mène déjà (revendication récente). */
export async function claimClose(root: string, agent: string, now: number): Promise<boolean> {
  let claimed = false;
  await update(root, (state) => {
    const record = state.agents[agent] ?? {};
    const claimedAt = Date.parse(record.closingAt ?? '');
    if (Number.isFinite(claimedAt) && now - claimedAt < CLOSE_CLAIM_TTL_MS) return UNCHANGED;
    state.agents[agent] = {
      ...record,
      closingAt: new Date(now).toISOString(),
      closingPid: process.pid,
    };
    claimed = true;
    return state;
  });
  return claimed;
}

/** Libère la revendication et consigne l'issue (`CLOSED` ou un code IDLE_CLOSE_*). */
export async function finishClose(
  root: string,
  agent: string,
  { result, host, at }: { result: string; host: string; at: number },
): Promise<void> {
  await update(root, (state) => {
    const record: AgentIdleRecord = { ...state.agents[agent] };
    delete record.closingAt;
    delete record.closingPid;
    record.lastClose = result;
    if (result === 'CLOSED') {
      record.closedAt = new Date(at).toISOString();
      record.closedHost = host;
    }
    state.agents[agent] = record;
    return state;
  });
}

/** Fin d'un balayage : date, et oubli des agents qui ne sont plus au registre. */
export async function finishSweep(
  root: string,
  { at, knownAgents }: { at: number; knownAgents: readonly string[] },
): Promise<void> {
  const known = new Set(knownAgents);
  await update(root, (state) => {
    state.lastSweepAt = new Date(at).toISOString();
    for (const name of Object.keys(state.agents)) if (!known.has(name)) delete state.agents[name];
    return state;
  });
}

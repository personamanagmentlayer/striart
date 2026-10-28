/**
 * État persistant des orchestrations (lot O) — l'OBSERVABILITÉ entre process.
 *
 * `striart plan` (ou `orchestrate`) tourne dans un process ; `status`, le
 * dashboard et le Control Protocol en lisent l'état depuis d'autres. Comme
 * pour le reste de `.striart/`, la source de vérité inter-process est le
 * disque : un fichier par application de plan (`runs/<id>.json`) et par
 * groupe orchestré (`groups/<id>.json`), écrits en lecture-modification-
 * écriture sous le verrou d'état de leur dossier.
 *
 * Ces fichiers INFORMENT, ils ne décident de rien : aucun garde ne les lit
 * (les gardes vivent au registre — `sessionPid`). Un état `running` dont le
 * PID est mort est rendu tel quel avec `alive: false` (process interrompu) ;
 * rétention bornée (`orchestration.keepRuns`).
 */
import { randomBytes } from 'node:crypto';
import { readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { UNCHANGED, readJson, updateJsonLocked } from '../json-file.js';
import { logger } from '../logger.js';
import { striartDir } from '../paths.js';
import { mkdirPrivate } from '../private-fs.ts';
import { isProcessAlive } from '../process-tree.js';
import type {
  OrchestrationGroupState,
  OrchestrationRunState,
  OrchestrationStatus,
} from '../types.js';

const RUN_ID_RE = /^run-[0-9a-f]{12}$/;
const GROUP_ID_RE = /^(review|team|pipeline|race)-[0-9a-f]{12}$/;

export function orchestrationDir(root: string): string {
  return path.join(striartDir(root), 'orchestration');
}
const runsDir = (root: string) => path.join(orchestrationDir(root), 'runs');
const groupsDir = (root: string) => path.join(orchestrationDir(root), 'groups');

function runPath(root: string, id: string): string {
  if (!RUN_ID_RE.test(id)) throw new Error(`invalid run id ${id}`);
  return path.join(runsDir(root), `${id}.json`);
}
function groupPath(root: string, id: string): string {
  if (!GROUP_ID_RE.test(id)) throw new Error(`invalid group id ${id}`);
  return path.join(groupsDir(root), `${id}.json`);
}

const now = () => new Date().toISOString();

export async function createRunState(
  root: string,
  init: Pick<OrchestrationRunState, 'mode' | 'concurrency' | 'nodes'>,
  keep: number,
): Promise<OrchestrationRunState> {
  await mkdirPrivate(runsDir(root));
  await pruneFinished(runsDir(root), RUN_ID_RE, keep);
  const state: OrchestrationRunState = {
    id: `run-${randomBytes(6).toString('hex')}`,
    ...init,
    status: 'running',
    pid: process.pid,
    startedAt: now(),
    updatedAt: now(),
  };
  await updateJsonLocked(
    runPath(root, state.id),
    { fallback: null, code: 'ORCHESTRATION_STATE_CORRUPT' },
    () => state,
  );
  return state;
}

/** Mise à jour best effort : l'état est de l'observabilité, jamais une raison d'échouer un nœud. */
async function patch<T extends { updatedAt: string }>(
  file: string,
  fn: (s: T) => T,
): Promise<void> {
  try {
    await updateJsonLocked(
      file,
      { fallback: null as T | null, code: 'ORCHESTRATION_STATE_CORRUPT' },
      (s: T | null) => (s ? { ...fn(s), updatedAt: now() } : UNCHANGED),
    );
  } catch (error) {
    logger.warn({ err: error, file }, 'État d’orchestration : mise à jour impossible (ignorée)');
  }
}

export async function updateRunNode(
  root: string,
  runId: string,
  index: number,
  change: Partial<OrchestrationRunState['nodes'][number]>,
): Promise<void> {
  await patch<OrchestrationRunState>(runPath(root, runId), (s) => ({
    ...s,
    nodes: s.nodes.map((n, i) => (i === index ? { ...n, ...change } : n)),
  }));
}

export async function finishRunState(
  root: string,
  runId: string,
  status: OrchestrationRunState['status'],
): Promise<void> {
  await patch<OrchestrationRunState>(runPath(root, runId), (s) => ({ ...s, status }));
}

export async function createGroupState(
  root: string,
  init: Pick<OrchestrationGroupState, 'id' | 'kind' | 'runId' | 'nodeId' | 'agents'>,
  keep: number,
): Promise<void> {
  try {
    await mkdirPrivate(groupsDir(root));
    await pruneFinished(groupsDir(root), GROUP_ID_RE, keep);
    const state: OrchestrationGroupState = {
      ...init,
      status: 'running',
      result: null,
      round: 0,
      activeRoles: [],
      verdicts: [],
      humanReview: null,
      pid: process.pid,
      startedAt: now(),
      updatedAt: now(),
    };
    await updateJsonLocked(
      groupPath(root, init.id),
      { fallback: null, code: 'ORCHESTRATION_STATE_CORRUPT' },
      () => state,
    );
  } catch (error) {
    logger.warn(
      { err: error, group: init.id },
      'État d’orchestration : création impossible (ignorée)',
    );
  }
}

export async function updateGroupState(
  root: string,
  id: string,
  change: Partial<OrchestrationGroupState>,
): Promise<void> {
  await patch<OrchestrationGroupState>(groupPath(root, id), (s) => ({ ...s, ...change }));
}

export async function finishGroupState(
  root: string,
  id: string,
  result: OrchestrationStatus,
): Promise<void> {
  await updateGroupState(root, id, { status: 'done', result, activeRoles: [], humanReview: null });
}

async function readAll<T>(dir: string, re: RegExp): Promise<T[]> {
  const names = await readdir(dir).catch(() => [] as string[]);
  const out: T[] = [];
  for (const name of names) {
    const id = name.endsWith('.json') ? name.slice(0, -5) : '';
    if (!re.test(id)) continue;
    const value = await readJson(path.join(dir, name), {
      fallback: null,
      code: 'ORCHESTRATION_STATE_CORRUPT',
    }).catch(() => null);
    if (value) out.push(value as T);
  }
  return out;
}

/** Retire les états TERMINÉS les plus anciens au-delà de `keep` (jamais un état en cours). */
async function pruneFinished(dir: string, re: RegExp, keep: number): Promise<void> {
  const all = await readAll<{ id: string; status: string; startedAt: string }>(dir, re);
  const finished = all
    .filter((s) => s.status !== 'running')
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  for (const old of finished.slice(Math.max(0, keep - 1))) {
    await rm(path.join(dir, `${old.id}.json`), { force: true }).catch(() => {});
  }
}

/** Vue lisible par `status --json` : `alive` = le process qui porte l'état vit encore. */
export async function listOrchestrationState(root: string): Promise<{
  runs: Array<OrchestrationRunState & { alive: boolean }>;
  groups: Array<OrchestrationGroupState & { alive: boolean }>;
}> {
  const alive = <T extends { status: string; pid: number }>(s: T) => ({
    ...s,
    alive: s.status === 'running' && isProcessAlive(s.pid),
  });
  const byDate = (a: { startedAt: string }, b: { startedAt: string }) =>
    b.startedAt.localeCompare(a.startedAt);
  const runs = (await readAll<OrchestrationRunState>(runsDir(root), RUN_ID_RE)).sort(byDate);
  const groups = (await readAll<OrchestrationGroupState>(groupsDir(root), GROUP_ID_RE)).sort(
    byDate,
  );
  return { runs: runs.map(alive), groups: groups.map(alive) };
}

import { mkdir, readFile, readdir, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { writeJsonAtomic } from './json-file.js';
import { striartDir } from './paths.js';
import { StriartError } from './errors.js';
import { logger } from './logger.js';

/**
 * Boîte aux lettres des permissions semi-autonomes (Phase F de l'intégration
 * ACP) : quand un profil déclare `acp: { permissions: 'ask' }`, chaque
 * `session/request_permission` de l'agent est matérialisée ICI, sur disque —
 * la session (un process) et le dashboard (un autre) n'ont pas de canal
 * commun, et la source de vérité inter-process du projet est le disque,
 * comme pour le reste de `.striart/` (même raison que le SSE du dashboard).
 *
 * Cycle de vie d'une demande :
 *  1. la session écrit `<id>.json` (status PENDING) et poll le fichier ;
 *  2. le dashboard la liste (SSE via le watcher d'état existant), l'humain
 *     clique une option → status ANSWERED + optionId (écriture atomique) ;
 *  3. la session lit la réponse, répond au protocole, supprime le fichier.
 *     Sans réponse dans le délai : FAIL CLOSED — la politique `reject`
 *     s'applique, la décision est tracée au log de session.
 *
 * Le fichier est éphémère : la trace d'audit est le log de session (Phase D),
 * pas la boîte aux lettres.
 */

/** Forme d'une option de permission proposée par l'agent (sous-ensemble ACP). */
export interface PermissionRequestOption {
  optionId: string;
  name?: string;
  kind?: string;
}

export interface PermissionRequest {
  id: string;
  agent: string;
  taskId: string;
  /** Titre de l'action demandée (ex: « Run npm test »), tel que fourni par l'agent. */
  title: string;
  options: PermissionRequestOption[];
  status: 'PENDING' | 'ANSWERED';
  /** optionId choisi par l'humain (status ANSWERED). */
  answer: string | null;
  createdAt: string;
  answeredAt: string | null;
  /** Date limite après laquelle la session tranche seule (fail closed). */
  expiresAt: string;
}

/** Ids générés par nous : validation stricte, aucun chemin dérivé d'une entrée libre. */
const PERMISSION_ID_RE = /^perm-[0-9a-f-]{8,36}$/;

/** Cadence de poll de la session en attente d'arbitrage. */
const POLL_INTERVAL_MS = 500;

export function permissionsDir(root: string): string {
  return path.join(striartDir(root), 'permissions');
}

function permissionPath(root: string, id: string): string {
  if (!PERMISSION_ID_RE.test(id)) {
    throw new StriartError(`Identifiant de permission invalide : "${id}".`, {
      code: 'PERMISSION_ID_INVALID',
      details: { id },
    });
  }
  return path.join(permissionsDir(root), `${id}.json`);
}

async function readPermission(root: string, id: string): Promise<PermissionRequest | null> {
  try {
    return JSON.parse(await readFile(permissionPath(root, id), 'utf8')) as PermissionRequest;
  } catch (error) {
    if (error instanceof StriartError) throw error;
    return null;
  }
}

/** Dépose une demande PENDING. Appelé par la session ACP (politique 'ask'). */
export async function createPermissionRequest(
  root: string,
  {
    agent,
    taskId,
    title,
    options,
    timeoutMs,
  }: {
    agent: string;
    taskId: string;
    title: string;
    options: PermissionRequestOption[];
    timeoutMs: number;
  },
): Promise<PermissionRequest> {
  const request: PermissionRequest = {
    id: `perm-${randomUUID()}`,
    agent,
    taskId,
    title,
    options: options.map(({ optionId, name, kind }) => ({ optionId, name, kind })),
    status: 'PENDING',
    answer: null,
    createdAt: new Date().toISOString(),
    answeredAt: null,
    expiresAt: new Date(Date.now() + timeoutMs).toISOString(),
  };
  await mkdir(permissionsDir(root), { recursive: true });
  await writeJsonAtomic(permissionPath(root, request.id), request);
  return request;
}

/**
 * Attend la réponse humaine (poll disque) jusqu'au délai. Retourne l'optionId
 * choisi, ou null si personne n'a tranché à temps — au CALLER d'appliquer le
 * fail closed. Le fichier est supprimé dans tous les cas : une demande
 * expirée qui resterait affichée au dashboard serait un bouton mort.
 */
export async function awaitPermissionAnswer(
  root: string,
  id: string,
  timeoutMs: number,
): Promise<string | null> {
  const deadline = Date.now() + timeoutMs;
  try {
    for (;;) {
      const request = await readPermission(root, id);
      if (request?.status === 'ANSWERED' && typeof request.answer === 'string') {
        return request.answer;
      }
      if (Date.now() >= deadline) return null;
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }
  } finally {
    await rm(permissionPath(root, id), { force: true }).catch(() => {});
  }
}

/** Demandes en attente, pour l'état du dashboard. Best effort (état consultable). */
export async function listPendingPermissions(root: string): Promise<PermissionRequest[]> {
  const entries = await readdir(permissionsDir(root)).catch(() => [] as string[]);
  const pending: PermissionRequest[] = [];
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue;
    const request = await readPermission(root, entry.slice(0, -'.json'.length)).catch(() => null);
    if (request?.status === 'PENDING') pending.push(request);
  }
  return pending.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/**
 * Réponse humaine (action du dashboard) : valide que la demande existe, est
 * PENDING, et que l'option choisie fait partie de celles PROPOSÉES par
 * l'agent — l'UI ne peut pas inventer une option que le protocole refuserait.
 */
export async function answerPermissionRequest(
  root: string,
  id: string,
  optionId: string,
): Promise<PermissionRequest> {
  const request = await readPermission(root, id);
  if (!request || request.status !== 'PENDING') {
    throw new StriartError(`Demande de permission introuvable ou déjà tranchée : "${id}".`, {
      code: 'PERMISSION_NOT_PENDING',
      details: { id },
    });
  }
  if (!request.options.some((o) => o.optionId === optionId)) {
    throw new StriartError(`Option inconnue pour la demande "${id}" : "${optionId}".`, {
      code: 'PERMISSION_OPTION_UNKNOWN',
      details: { id, optionId, known: request.options.map((o) => o.optionId) },
    });
  }
  const answered: PermissionRequest = {
    ...request,
    status: 'ANSWERED',
    answer: optionId,
    answeredAt: new Date().toISOString(),
  };
  await writeJsonAtomic(permissionPath(root, id), answered);
  return answered;
}

/**
 * Hygiène (reconcile) : purge les demandes expirées dont la session est
 * morte sans nettoyer (crash) — sans quoi le dashboard afficherait des
 * boutons morts pour toujours.
 */
export async function prunePermissions(root: string): Promise<number> {
  const entries = await readdir(permissionsDir(root)).catch(() => [] as string[]);
  let pruned = 0;
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue;
    const id = entry.slice(0, -'.json'.length);
    const request = await readPermission(root, id).catch(() => null);
    if (!request || Date.parse(request.expiresAt) > Date.now()) continue;
    try {
      await rm(permissionPath(root, id), { force: true });
      pruned += 1;
    } catch (error) {
      logger.warn({ err: error, id }, 'Purge d’une permission expirée impossible (ignorée)');
    }
  }
  return pruned;
}

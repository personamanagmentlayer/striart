import { mkdir, readFile, readdir, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { writeJsonAtomic } from './json-file.js';
import { striartDir } from './paths.js';
import { StriartError } from './errors.js';
import { logger } from './logger.js';
import { sanitizeAgentText } from './collab/message.ts';
import { elicitationSchemaProblem, validateElicitationContent } from './acp/elicitation-schema.ts';

/**
 * Boîte aux lettres des demandes HUMAINES des sessions semi-autonomes
 * (Phase F de l'intégration ACP, étendue au lot I6) : quand un profil déclare
 * `acp: { permissions: 'ask' }`, chaque `session/request_permission` et
 * chaque `elicitation/create` de l'agent est matérialisée ICI, sur disque —
 * la session (un process, l'hôte de session ACP) et le dashboard (un autre)
 * n'ont pas de canal commun, et la source de vérité inter-process du projet
 * est le disque, comme pour le reste de `.striart/`.
 *
 * Cycle de vie d'une demande :
 *  1. la session écrit `<id>.json` (status PENDING) et poll le fichier ;
 *  2. le dashboard la liste, l'humain tranche → status ANSWERED + réponse
 *     (écriture atomique), validée contre ce que l'agent a PROPOSÉ (options
 *     d'une permission, schéma d'une elicitation) ;
 *  3. la session lit la réponse (revalidée), répond au protocole, supprime
 *     le fichier. Sans réponse dans le délai : FAIL CLOSED — refus pour une
 *     permission, `cancel` pour une elicitation ; tracé au log de session.
 *
 * Le fichier est éphémère : la trace d'audit est le log de session.
 *
 * API pour le plan humain (dashboard, Striart Control Protocol) :
 *  - `listPendingHumanRequests(root)` → toutes les demandes, union
 *    discriminée sur `kind` ('permission' | 'elicitation') ;
 *  - `answerPermissionRequest(root, id, optionId)` pour une permission ;
 *  - `answerElicitationRequest(root, id, { action, content? })` pour une
 *    elicitation (`accept` + contenu conforme au `requestedSchema`,
 *    `decline`, `cancel`) ;
 *  - `listPendingPermissions` / `listPendingElicitations` : vues filtrées.
 */

/** Forme d'une option de permission proposée par l'agent (sous-ensemble ACP). */
export interface PermissionRequestOption {
  optionId: string;
  name?: string;
  kind?: string;
}

export interface PermissionRequest {
  /** Absent dans les fichiers antérieurs au lot I6 : lu comme 'permission'. */
  kind?: 'permission';
  id: string;
  agent: string;
  taskId: string;
  /** Titre de l'action demandée (ex: « Run npm test »), tel que fourni par l'agent. */
  title: string;
  /**
   * Identifiant de l'appel d'outil concerné (`toolCall.toolCallId` ACP), si
   * l'agent l'a fourni et qu'il est sûr — le proxy `striart acp` (lot I10)
   * rattache ainsi la question à l'appel d'outil déjà affiché par l'IDE.
   */
  toolCallId?: string | null;
  options: PermissionRequestOption[];
  status: 'PENDING' | 'ANSWERED';
  /** optionId choisi par l'humain (status ANSWERED). */
  answer: string | null;
  createdAt: string;
  answeredAt: string | null;
  /** Date limite après laquelle la session tranche seule (fail closed). */
  expiresAt: string;
}

/**
 * Question structurée de l'agent (`elicitation/create`, ACP v1, stabilisée le
 * 2026-07-22) routée vers l'humain — même boîte aux lettres, même cycle de
 * vie, même fail closed que les permissions. Le schéma vient de l'agent :
 * validé avant dépôt, la réponse l'est contre lui avant d'être acceptée.
 */
export interface ElicitationRequest {
  kind: 'elicitation';
  id: string;
  agent: string;
  taskId: string;
  /** 'form' : formulaire plat (`requestedSchema`) ; 'url' : parcours hors bande (`url`). */
  mode: 'form' | 'url';
  /** Texte de l'agent, à afficher comme contenu NON FIABLE (jamais interprété). */
  message: string;
  requestedSchema: Record<string, unknown> | null;
  /** Mode 'url' : adresse proposée par l'agent — affichée, jamais ouverte automatiquement. */
  url: string | null;
  status: 'PENDING' | 'ANSWERED';
  answer: ElicitationAnswer | null;
  createdAt: string;
  answeredAt: string | null;
  expiresAt: string;
}

/** Réponse humaine à une elicitation (forme du protocole : action + contenu). */
export interface ElicitationAnswer {
  action: 'accept' | 'decline' | 'cancel';
  content?: Record<string, unknown> | null;
}

/** Toute demande en attente d'un humain. */
export type HumanRequest = PermissionRequest | ElicitationRequest;

/** Ids générés par nous : validation stricte, aucun chemin dérivé d'une entrée libre. */
const PERMISSION_ID_RE = /^(perm|elic)-[0-9a-f-]{8,36}$/;

/** Identifiant d'appel d'outil recevable (ASCII imprimable, borné). */
const TOOL_CALL_ID_RE = /^[\x21-\x7e]{1,128}$/;

/** Cadence de poll de la session en attente d'arbitrage. */
const POLL_INTERVAL_MS = 500;

/** Bornes des données de l'agent affichées à l'humain. */
const MAX_ELICITATION_MESSAGE_CHARS = 8_192;
/**
 * Bornes d'une demande de permission (texte d'AGENT, poussé au dashboard et à
 * l'IDE — S-M4) : titre, nombre d'options, nom et identifiant de chaque option.
 */
const MAX_PERMISSION_TITLE_BYTES = 8_192;
const MAX_PERMISSION_OPTIONS = 16;
const MAX_PERMISSION_OPTION_NAME_BYTES = 256;
const OPTION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;

/** Options retenues : identifiant imprimable borné, nom neutralisé (bidi, contrôles, zéro-largeur), au plus 16. */
export function boundPermissionOptions(options: unknown): PermissionRequestOption[] {
  if (!Array.isArray(options)) return [];
  const bounded: PermissionRequestOption[] = [];
  for (const raw of options) {
    if (bounded.length >= MAX_PERMISSION_OPTIONS) break;
    const o = raw as Partial<PermissionRequestOption> | null;
    if (!o || typeof o.optionId !== 'string' || !OPTION_ID_RE.test(o.optionId)) continue;
    bounded.push({
      optionId: o.optionId,
      name:
        typeof o.name === 'string'
          ? sanitizeAgentText(o.name, MAX_PERMISSION_OPTION_NAME_BYTES).text
          : undefined,
      kind: typeof o.kind === 'string' ? sanitizeAgentText(o.kind, 32).text : undefined,
    });
  }
  return bounded;
}
const MAX_ELICITATION_URL_CHARS = 4_096;

/**
 * Pause entre deux lectures, écourtée par `signal` : une session annulée
 * (Ctrl+C, délai, arrêt de l'hôte) retire sa demande tout de suite au lieu
 * de laisser un bouton mort au dashboard jusqu'au délai d'arbitrage.
 */
function pollDelay(signal: AbortSignal | null): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, POLL_INTERVAL_MS);
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    }
    signal?.addEventListener('abort', done, { once: true });
  });
}

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

async function readHumanRequest(root: string, id: string): Promise<HumanRequest | null> {
  try {
    return JSON.parse(await readFile(permissionPath(root, id), 'utf8')) as HumanRequest;
  } catch (error) {
    if (error instanceof StriartError) throw error;
    return null;
  }
}

const isElicitation = (r: HumanRequest | null): r is ElicitationRequest =>
  r?.kind === 'elicitation';

async function readPermission(root: string, id: string): Promise<PermissionRequest | null> {
  const request = await readHumanRequest(root, id);
  return request && !isElicitation(request) ? request : null;
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
    toolCallId = null,
  }: {
    agent: string;
    taskId: string;
    title: string;
    options: PermissionRequestOption[];
    timeoutMs: number;
    toolCallId?: string | null;
  },
): Promise<PermissionRequest> {
  const request: PermissionRequest = {
    kind: 'permission',
    id: `perm-${randomUUID()}`,
    agent,
    taskId,
    title: sanitizeAgentText(String(title ?? ''), MAX_PERMISSION_TITLE_BYTES).text,
    // Donnée de l'agent : retenue seulement si c'est un identifiant imprimable borné.
    toolCallId:
      typeof toolCallId === 'string' && TOOL_CALL_ID_RE.test(toolCallId) ? toolCallId : null,
    options: boundPermissionOptions(options),
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
 * fail closed. `signal` : la session est annulée, l'attente cesse (null).
 * Le fichier est supprimé dans tous les cas : une demande expirée qui
 * resterait affichée au dashboard serait un bouton mort.
 */
export async function awaitPermissionAnswer(
  root: string,
  id: string,
  timeoutMs: number,
  { signal = null }: { signal?: AbortSignal | null } = {},
): Promise<string | null> {
  const deadline = Date.now() + timeoutMs;
  try {
    for (;;) {
      const request = await readPermission(root, id);
      if (request?.status === 'ANSWERED' && typeof request.answer === 'string') {
        return request.answer;
      }
      if (Date.now() >= deadline || signal?.aborted) return null;
      await pollDelay(signal);
    }
  } finally {
    await rm(permissionPath(root, id), { force: true }).catch(() => {});
  }
}

/**
 * Toutes les demandes humaines en attente (permissions ET elicitations), par
 * ordre d'arrivée. Best effort (état consultable). Un fichier dont le nom ne
 * suit pas le motif des ids est ignoré, jamais lu par chemin libre.
 */
export async function listPendingHumanRequests(root: string): Promise<HumanRequest[]> {
  const entries = await readdir(permissionsDir(root)).catch(() => [] as string[]);
  const pending: HumanRequest[] = [];
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue;
    const id = entry.slice(0, -'.json'.length);
    if (!PERMISSION_ID_RE.test(id)) continue;
    const request = await readHumanRequest(root, id).catch(() => null);
    if (request?.status === 'PENDING') pending.push(request);
  }
  return pending.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/** Demandes de permission en attente (contrat historique du dashboard : permissions seules). */
export async function listPendingPermissions(root: string): Promise<PermissionRequest[]> {
  return (await listPendingHumanRequests(root)).filter(
    (r): r is PermissionRequest => !isElicitation(r),
  );
}

/** Elicitations en attente d'une réponse humaine. */
export async function listPendingElicitations(root: string): Promise<ElicitationRequest[]> {
  return (await listPendingHumanRequests(root)).filter(isElicitation);
}

/**
 * Réponse humaine (action du dashboard) : valide que la demande existe, est
 * une permission PENDING, et que l'option choisie fait partie de celles
 * PROPOSÉES par l'agent — l'UI ne peut pas inventer une option que le
 * protocole refuserait.
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
 * Dépose une elicitation PENDING (session ACP, politique 'ask'). Refuse —
 * avant tout dépôt — un schéma qu'on ne saurait pas valider, une URL non
 * http(s) ou un message hors bornes (ELICITATION_INVALID) : la session le
 * traduit en erreur JSON-RPC « invalid params » pour l'agent, l'humain ne
 * voit jamais un formulaire qu'on ne pourrait pas contrôler.
 */
export async function createElicitationRequest(
  root: string,
  {
    agent,
    taskId,
    mode,
    message,
    requestedSchema = null,
    url = null,
    timeoutMs,
  }: {
    agent: string;
    taskId: string;
    mode: 'form' | 'url';
    message: string;
    requestedSchema?: Record<string, unknown> | null;
    url?: string | null;
    timeoutMs: number;
  },
): Promise<ElicitationRequest> {
  const invalid = (reason: string) =>
    new StriartError(`Elicitation refusée : ${reason}.`, {
      code: 'ELICITATION_INVALID',
      details: { agent, reason },
    });
  if (typeof message !== 'string' || message.length > MAX_ELICITATION_MESSAGE_CHARS)
    throw invalid('message missing or too long');
  if (mode === 'form') {
    const problem = elicitationSchemaProblem(requestedSchema);
    if (problem) throw invalid(problem);
  } else if (mode === 'url') {
    let parsed: URL | null = null;
    try {
      parsed =
        typeof url === 'string' && url.length <= MAX_ELICITATION_URL_CHARS ? new URL(url) : null;
    } catch {
      parsed = null;
    }
    if (!parsed || !['https:', 'http:'].includes(parsed.protocol))
      throw invalid('url must be an http(s) URL');
  } else {
    throw invalid('unsupported mode');
  }
  const request: ElicitationRequest = {
    kind: 'elicitation',
    id: `elic-${randomUUID()}`,
    agent,
    taskId,
    mode,
    message: sanitizeAgentText(message, MAX_ELICITATION_MESSAGE_CHARS).text,
    requestedSchema: mode === 'form' ? requestedSchema : null,
    url: mode === 'url' ? url : null,
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

/** Réponse relue du disque : toute forme non conforme devient un `cancel` (fail closed). */
function sanitizeElicitationAnswer(
  request: ElicitationRequest,
  answer: ElicitationAnswer,
): ElicitationAnswer {
  if (answer.action === 'decline' || answer.action === 'cancel') return { action: answer.action };
  if (answer.action !== 'accept') return { action: 'cancel' };
  if (request.mode === 'url') return { action: 'accept' };
  const content = answer.content ?? {};
  return validateElicitationContent(request.requestedSchema, content).ok
    ? { action: 'accept', content }
    : { action: 'cancel' };
}

/**
 * Attend la réponse humaine à une elicitation (poll disque) jusqu'au délai.
 * null si personne n'a répondu — au CALLER d'appliquer le fail closed
 * (`cancel`). La réponse est REVALIDÉE ici : le fichier est sur disque, un
 * autre process a pu l'écrire sans passer par `answerElicitationRequest`.
 * Le fichier est supprimé dans tous les cas.
 */
export async function awaitElicitationAnswer(
  root: string,
  id: string,
  timeoutMs: number,
  { signal = null }: { signal?: AbortSignal | null } = {},
): Promise<ElicitationAnswer | null> {
  const deadline = Date.now() + timeoutMs;
  try {
    for (;;) {
      const request = await readHumanRequest(root, id);
      if (isElicitation(request) && request.status === 'ANSWERED' && request.answer) {
        return sanitizeElicitationAnswer(request, request.answer);
      }
      if (Date.now() >= deadline || signal?.aborted) return null;
      await pollDelay(signal);
    }
  } finally {
    await rm(permissionPath(root, id), { force: true }).catch(() => {});
  }
}

/**
 * Réponse humaine à une elicitation (dashboard / plan de contrôle humain) :
 * la demande doit exister et être PENDING (ELICITATION_NOT_PENDING) ; un
 * `accept` en mode form doit porter un contenu CONFORME au schéma demandé
 * (ELICITATION_CONTENT_INVALID, la demande reste ouverte) ; `decline` et
 * `cancel` ne transmettent jamais de contenu.
 */
export async function answerElicitationRequest(
  root: string,
  id: string,
  answer: ElicitationAnswer,
): Promise<ElicitationRequest> {
  const request = await readHumanRequest(root, id);
  if (!isElicitation(request) || request.status !== 'PENDING') {
    throw new StriartError(`Elicitation introuvable ou déjà tranchée : "${id}".`, {
      code: 'ELICITATION_NOT_PENDING',
      details: { id },
    });
  }
  if (!answer || !['accept', 'decline', 'cancel'].includes(answer.action)) {
    throw new StriartError(`Action d'elicitation inconnue pour "${id}".`, {
      code: 'ELICITATION_CONTENT_INVALID',
      details: { id, field: null, reason: 'ACTION' },
    });
  }
  let stored: ElicitationAnswer = { action: answer.action };
  if (answer.action === 'accept' && request.mode === 'form') {
    const content = answer.content ?? {};
    const verdict = validateElicitationContent(request.requestedSchema, content);
    if ('reason' in verdict) {
      throw new StriartError(
        `Réponse non conforme au formulaire demandé (champ "${verdict.field ?? '(racine)'}").`,
        {
          code: 'ELICITATION_CONTENT_INVALID',
          details: { id, field: verdict.field, reason: verdict.reason },
        },
      );
    }
    stored = { action: 'accept', content };
  }
  const answered: ElicitationRequest = {
    ...request,
    status: 'ANSWERED',
    answer: stored,
    answeredAt: new Date().toISOString(),
  };
  await writeJsonAtomic(permissionPath(root, id), answered);
  return answered;
}

/**
 * Hygiène (reconcile) : purge les demandes expirées (permissions et
 * elicitations) dont la session est morte sans nettoyer (crash) — sans quoi
 * le dashboard afficherait des boutons morts pour toujours.
 */
export async function prunePermissions(root: string): Promise<number> {
  const entries = await readdir(permissionsDir(root)).catch(() => [] as string[]);
  let pruned = 0;
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue;
    const id = entry.slice(0, -'.json'.length);
    if (!PERMISSION_ID_RE.test(id)) continue;
    const request = await readHumanRequest(root, id).catch(() => null);
    if (!request || Date.parse(request.expiresAt) > Date.now()) continue;
    try {
      await rm(permissionPath(root, id), { force: true });
      pruned += 1;
    } catch (error) {
      logger.warn({ err: error, id }, 'Purge d’une demande humaine expirée impossible (ignorée)');
    }
  }
  return pruned;
}

/**
 * Canal de collaboration entre agents (lot O, décision O4) — le magasin.
 *
 * Un GROUPE réunit les membres d'une collaboration orchestrée (auteur et
 * relecteurs d'un `review`, rôles d'un `team`, étapes d'un `pipeline`) ;
 * chaque membre est un couple (agent = clone, rôle). Les messages sont
 * stockés sous `.striart/collab/<groupe>.json`, en lecture-modification-
 * écriture sous le verrou d'état (aucune mise à jour perdue entre la session
 * qui récolte une outbox et le serveur MCP d'un agent qui poste).
 *
 * Invariants, non négociables :
 *  1. MÉDIÉ : aucun agent n'accède au clone d'un autre ni ne reçoit de
 *     chemin. Striart reçoit, valide, stocke, puis livre (inbox, briefing).
 *  2. EXPÉDITEUR DÉDUIT : du clone appelant (MCP, borné au clone — D6) ou du
 *     clone récolté (outbox) ; jamais lu dans le message.
 *  3. BORNÉ : nombre total, nombre par expéditeur, taille du corps ; un
 *     dépassement est REFUSÉ explicitement et compté (`dropped`), jamais
 *     avalé en silence.
 *  4. NON FIABLE : le corps est neutralisé à l'entrée, encadré à la sortie
 *     (message.ts). Aucune action d'arbitrage n'est atteignable : un
 *     `verdict` n'est recevable que d'un rôle relecteur PENDANT son tour, et
 *     ne fait que proposer — le merge reste au Test Gate.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readdir } from 'node:fs/promises';
import path from 'node:path';
import { validateAgentName } from '../agent-name.ts';
import { StriartError } from '../errors.js';
import { UNCHANGED, readJson, updateJsonLocked } from '../json-file.js';
import { striartDir } from '../paths.js';
import type {
  CollabGroup,
  CollabMember,
  CollabMessage,
  CollabMessageKind,
  CollabSettings,
} from '../types.js';
import { ROLE_NAME_RE, STRIART_ROLE, validateMessageInput } from './message.ts';

export const COLLAB_GROUP_ID_RE = /^(review|team|pipeline|race)-[0-9a-f]{12}$/;

/** Membre tel que déclaré à la création ; `verdict` : rôle relecteur. */
export interface CollabMemberSpec extends CollabMember {
  verdict?: boolean;
}

type StoredGroup = CollabGroup;

export function collabDir(root: string): string {
  return path.join(striartDir(root), 'collab');
}

function groupPath(root: string, id: string): string {
  // L'id est généré par Striart ; revalidé à chaque usage, jamais un chemin libre.
  if (!COLLAB_GROUP_ID_RE.test(id)) throw unknownGroup(id);
  return path.join(collabDir(root), `${id}.json`);
}

const STRIART_MEMBER: CollabMember = Object.freeze({ agent: STRIART_ROLE, role: STRIART_ROLE });

/** Crée un groupe. Les membres sont validés (nom d'agent, nom de rôle). */
export async function createCollabGroup(
  root: string,
  { kind, members }: { kind: CollabGroup['kind']; members: CollabMemberSpec[] },
): Promise<StoredGroup> {
  for (const m of members) {
    validateAgentName(m.agent);
    if (!ROLE_NAME_RE.test(m.role) || m.role === STRIART_ROLE) {
      throw new StriartError(`Invalid collaboration role name "${m.role}".`, {
        code: 'COLLAB_MESSAGE_INVALID',
        details: { reason: 'ROLE_INVALID' },
      });
    }
  }
  const id = `${kind}-${randomBytes(6).toString('hex')}`;
  const group: StoredGroup = {
    version: 1,
    id,
    kind,
    members: members.map(({ agent, role }) => ({ agent, role })),
    verdictRoles: members.filter((m) => m.verdict).map((m) => m.role),
    activeRoles: [],
    fenceKey: randomBytes(16).toString('hex'),
    messages: [],
    seq: 0,
    perSender: {},
    dropped: 0,
    createdAt: new Date().toISOString(),
    closedAt: null,
  };
  await mkdir(collabDir(root), { recursive: true });
  await updateJsonLocked(
    groupPath(root, id),
    { fallback: null, code: 'COLLAB_CORRUPT' },
    () => group,
  );
  return group;
}

export async function readCollabGroup(root: string, id: string): Promise<StoredGroup> {
  const group = (await readJson(groupPath(root, id), {
    fallback: null,
    code: 'COLLAB_CORRUPT',
  })) as StoredGroup | null;
  if (!group) throw unknownGroup(id);
  return group;
}

/** Tous les groupes (les plus récents d'abord) — observabilité, `status`. */
export async function listCollabGroups(root: string): Promise<StoredGroup[]> {
  const names = await readdir(collabDir(root)).catch(() => [] as string[]);
  const groups: StoredGroup[] = [];
  for (const name of names) {
    const id = name.endsWith('.json') ? name.slice(0, -5) : '';
    if (!COLLAB_GROUP_ID_RE.test(id)) continue;
    const group = await readCollabGroup(root, id).catch(() => null);
    if (group) groups.push(group);
  }
  return groups.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

async function mutateGroup(
  root: string,
  id: string,
  mutator: (g: StoredGroup) => StoredGroup | typeof UNCHANGED,
): Promise<StoredGroup> {
  const next = (await updateJsonLocked(
    groupPath(root, id),
    { fallback: null, code: 'COLLAB_CORRUPT' },
    (current: StoredGroup | null) => {
      if (!current) throw unknownGroup(id);
      return mutator(current);
    },
  )) as StoredGroup | null;
  if (!next) throw unknownGroup(id);
  return next;
}

/** Rôles dont c'est le tour (posé par l'orchestrateur avant/après chaque tour). */
export async function setActiveRoles(root: string, id: string, roles: string[]): Promise<void> {
  await mutateGroup(root, id, (g) => ({ ...g, activeRoles: [...roles] }));
}

/** Clôt le groupe : plus aucun message accepté. Idempotent. */
export async function closeCollabGroup(root: string, id: string): Promise<void> {
  await mutateGroup(root, id, (g) =>
    g.closedAt ? UNCHANGED : { ...g, activeRoles: [], closedAt: new Date().toISOString() },
  );
}

interface AppendInput {
  from: CollabMember;
  to: string;
  kind: CollabMessageKind;
  body: string;
  truncated: boolean;
  source: CollabMessage['source'];
}

/**
 * Ajoute un message sous le verrou d'état, bornes comprises. Un refus pour
 * borne est PERSISTÉ (`dropped`) avant d'être levé.
 */
async function appendMessage(
  root: string,
  id: string,
  input: AppendInput,
  settings: Pick<CollabSettings, 'maxMessages' | 'maxMessagesPerSender'>,
): Promise<CollabMessage> {
  // Affectées dans le mutateur : typées explicitement (le flot de contrôle
  // ne suit pas les affectations faites dans un rappel).
  let refused = null as 'TOTAL' | 'SENDER' | null;
  let stored = null as CollabMessage | null;
  const senderKey = `${input.from.agent}:${input.from.role}`;
  await mutateGroup(root, id, (g) => {
    if (g.closedAt) throw notMember(input.from.agent);
    if (g.messages.length >= settings.maxMessages) refused = 'TOTAL';
    else if ((g.perSender[senderKey] ?? 0) >= settings.maxMessagesPerSender) refused = 'SENDER';
    if (refused) return { ...g, dropped: g.dropped + 1 };
    const message: CollabMessage = {
      seq: g.seq + 1,
      id: `msg-${randomUUID().slice(0, 8)}`,
      group: g.id,
      from: { agent: input.from.agent, role: input.from.role },
      to: input.to,
      kind: input.kind,
      body: input.body,
      truncated: input.truncated,
      source: input.source,
      createdAt: new Date().toISOString(),
    };
    stored = message;
    return {
      ...g,
      seq: message.seq,
      messages: [...g.messages, message],
      perSender: { ...g.perSender, [senderKey]: (g.perSender[senderKey] ?? 0) + 1 },
    };
  });
  if (refused || !stored) {
    throw new StriartError(
      refused === 'SENDER'
        ? `Collaboration message refused: this sender reached collab.maxMessagesPerSender in group ${id}.`
        : `Collaboration message refused: group ${id} reached collab.maxMessages.`,
      {
        code: 'COLLAB_LIMIT_REACHED',
        hint: 'striart status',
        details: { group: id, limit: refused === 'SENDER' ? 'sender' : 'total' },
      },
    );
  }
  return stored;
}

function assertEnabled(settings: Pick<CollabSettings, 'enabled'>): void {
  if (settings.enabled) return;
  throw new StriartError('The collaboration channel is disabled (collab.enabled: false).', {
    code: 'COLLAB_DISABLED',
    hint: 'striart doctor',
    details: {},
  });
}

function assertRecipient(group: StoredGroup, to: string): void {
  if (to === '*' || group.members.some((m) => m.role === to)) return;
  throw new StriartError(`Unknown recipient role "${to}" in group ${group.id}.`, {
    code: 'COLLAB_RECIPIENT_UNKNOWN',
    hint: 'striart status',
    details: { group: group.id, to },
  });
}

/** Message de Striart lui-même (faits, relais) — borné comme les autres. */
export async function postStriartMessage(
  root: string,
  id: string,
  input: { to: string; kind: CollabMessageKind; body: string },
  settings: CollabSettings,
): Promise<CollabMessage> {
  const msg = validateMessageInput(input, settings);
  const group = await readCollabGroup(root, id);
  assertRecipient(group, msg.to);
  return appendMessage(root, id, { ...msg, from: STRIART_MEMBER, source: 'striart' }, settings);
}

/**
 * Messages récoltés à la fin d'un tour (outbox, log) pour un membre CONNU
 * (déduit par l'orchestrateur). Chaque message est validé ; les refus sont
 * comptés et rendus, jamais levés : un tour d'agent ne s'interrompt pas pour
 * un message mal formé.
 */
export async function postHarvestedMessages(
  root: string,
  id: string,
  member: CollabMember,
  inputs: unknown[],
  source: 'outbox' | 'log',
  settings: CollabSettings,
): Promise<{ accepted: CollabMessage[]; refused: Array<{ reason: string }> }> {
  const accepted: CollabMessage[] = [];
  const refused: Array<{ reason: string }> = [];
  if (!settings.enabled) return { accepted, refused: inputs.map(() => ({ reason: 'DISABLED' })) };
  const group = await readCollabGroup(root, id);
  for (const input of inputs) {
    try {
      const msg = validateMessageInput(input, settings);
      // Un verdict passe par son propre chemin (lecture du tour du relecteur),
      // jamais comme message libre récolté.
      if (msg.kind === 'verdict') throw kindForbidden(group.id, msg.kind);
      assertRecipient(group, msg.to);
      accepted.push(await appendMessage(root, id, { ...msg, from: member, source }, settings));
    } catch (error) {
      if (!(error instanceof StriartError)) throw error;
      refused.push({ reason: String(error.details?.reason ?? error.code) });
    }
  }
  return { accepted, refused };
}

/** Groupes OUVERTS dont `agent` est membre. */
async function openGroupsOf(root: string, agent: string, group?: string | null) {
  if (group) {
    const g = await readCollabGroup(root, group).catch(() => null);
    return g && !g.closedAt && g.members.some((m) => m.agent === agent) ? [g] : [];
  }
  return (await listCollabGroups(root)).filter(
    (g) => !g.closedAt && g.members.some((m) => m.agent === agent),
  );
}

/**
 * Poste un message au nom de l'agent APPELANT — point d'entrée de l'outil
 * MCP `striart_collab_post` (lot I7). `agent` est l'identité du clone
 * appelant établie par le serveur MCP (D6), jamais un paramètre de l'outil.
 * `role` n'est utile que si l'agent tient plusieurs rôles actifs à la fois
 * (cadence parallèle d'un team) : il doit alors désigner l'un d'eux — des
 * rôles du MÊME clone partagent le même worktree, ce choix n'est pas une
 * frontière de sécurité.
 */
export async function postAgentMessage(
  params: {
    root: string;
    agent: string;
    group?: string | null;
    role?: string | null;
    to?: string;
    kind: string;
    body: unknown;
  },
  settings: CollabSettings,
): Promise<{ message: CollabMessage }> {
  assertEnabled(settings);
  validateAgentName(params.agent);
  const msg = validateMessageInput(
    { to: params.to, kind: params.kind, body: params.body },
    settings,
  );
  const groups = await openGroupsOf(params.root, params.agent, params.group);
  if (groups.length === 0) throw notMember(params.agent);
  if (groups.length > 1) {
    throw new StriartError(
      `Agent "${params.agent}" belongs to several collaboration groups: name the group.`,
      {
        code: 'COLLAB_GROUP_AMBIGUOUS',
        hint: 'striart status',
        details: { agent: params.agent, groups: groups.map((g) => g.id) },
      },
    );
  }
  const group = groups[0];
  const role = senderRole(group, params.agent, params.role ?? null, msg.kind);
  assertRecipient(group, msg.to);
  const message = await appendMessage(
    params.root,
    group.id,
    { ...msg, from: { agent: params.agent, role }, source: 'mcp' },
    settings,
  );
  return { message };
}

function senderRole(
  group: StoredGroup,
  agent: string,
  requested: string | null,
  kind: CollabMessageKind,
): string {
  const own = group.members.filter((m) => m.agent === agent).map((m) => m.role);
  const active = own.filter((r) => group.activeRoles.includes(r));
  if (kind === 'verdict') {
    const candidates = active.filter((r) => group.verdictRoles.includes(r));
    const chosen = requested ? candidates.filter((r) => r === requested) : candidates;
    if (chosen.length !== 1) throw kindForbidden(group.id, kind);
    return chosen[0];
  }
  if (requested) {
    if (!own.includes(requested)) throw notMember(agent);
    return requested;
  }
  if (own.length === 1) return own[0];
  if (active.length === 1) return active[0];
  throw new StriartError(
    `Agent "${agent}" holds several roles in group ${group.id}: name the sending role.`,
    {
      code: 'COLLAB_ROLE_AMBIGUOUS',
      hint: 'striart status',
      details: { agent, group: group.id, roles: own },
    },
  );
}

/**
 * Messages destinés à l'agent APPELANT — point d'entrée de l'outil MCP
 * `striart_collab_read` (lot I7, lecture seule). Rend les messages adressés
 * à ses rôles (ou à `role` s'il est précisé) et les diffusions, jamais les
 * siens, dans les groupes OUVERTS dont il est membre.
 */
export async function readAgentMessages(params: {
  root: string;
  agent: string;
  role?: string | null;
  group?: string | null;
  sinceSeq?: number;
}): Promise<{ messages: CollabMessage[]; groups: Array<{ id: string; seq: number }> }> {
  validateAgentName(params.agent);
  const groups = await openGroupsOf(params.root, params.agent, params.group);
  const messages: CollabMessage[] = [];
  for (const g of groups) {
    const own = g.members.filter((m) => m.agent === params.agent).map((m) => m.role);
    const roles = params.role ? own.filter((r) => r === params.role) : own;
    for (const m of g.messages) {
      if (m.seq <= (params.sinceSeq ?? 0)) continue;
      if (m.from.agent === params.agent && roles.includes(m.from.role)) continue;
      if (m.to === '*' || roles.includes(m.to)) messages.push(m);
    }
  }
  return { messages, groups: groups.map((g) => ({ id: g.id, seq: g.seq })) };
}

/** Messages destinés à des rôles (livraison par l'orchestrateur : inbox, briefing). */
export function messagesForRoles(
  group: CollabGroup,
  roles: string[],
  { sinceSeq = 0 }: { sinceSeq?: number } = {},
): CollabMessage[] {
  return group.messages.filter(
    (m) =>
      m.seq > sinceSeq &&
      !(roles.includes(m.from.role) && m.from.agent !== STRIART_ROLE) &&
      (m.to === '*' || roles.includes(m.to)),
  );
}

function unknownGroup(id: string): StriartError {
  return new StriartError(`Unknown collaboration group "${String(id).slice(0, 60)}".`, {
    code: 'COLLAB_GROUP_UNKNOWN',
    hint: 'striart status',
    details: { group: String(id).slice(0, 60) },
  });
}

function notMember(agent: string): StriartError {
  return new StriartError(
    `Agent "${agent}" is not a member of an open collaboration group: messages are only exchanged inside an orchestrated collaboration.`,
    { code: 'COLLAB_NOT_MEMBER', hint: 'striart status', details: { agent } },
  );
}

function kindForbidden(group: string, kind: string): StriartError {
  return new StriartError(
    `Message kind "${kind}" refused: a verdict is accepted only from a reviewer role during its own review turn.`,
    { code: 'COLLAB_KIND_FORBIDDEN', hint: 'striart status', details: { group, kind } },
  );
}

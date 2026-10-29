/**
 * Arbitrage humain DANS l'IDE (proxy `striart acp`, lot I10, politique 'ask').
 *
 * Le client ACP de Striart (dans l'hôte de session, I6) dépose chaque demande
 * de l'agent amont dans la boîte aux lettres disque `.striart/permissions/`
 * et attend une réponse, fail closed au délai. Ce relais la REPREND telle
 * quelle — aucune nouvelle voie d'autorité : il lit les demandes de SON
 * agent et de SA tâche, les pose à l'humain dans l'éditeur
 * (`session/request_permission`, `elicitation/create` si l'IDE l'annonce),
 * et répond par les mêmes primitives que le dashboard, qui revalident la
 * réponse contre ce que l'agent a PROPOSÉ. Le dashboard reste utilisable en
 * parallèle : la première réponse l'emporte, l'autre est refusée
 * (PENDING exigé).
 *
 * Pourquoi c'est acceptable ici : l'IDE EST l'interface humaine de cette
 * session (c'est l'humain qui l'a ouverte et qui y tape ses prompts) — le
 * plan humain, pas le plan agent. L'agent amont ne parle jamais au client
 * IDE : il ne peut pas s'auto-arbitrer par ce chemin.
 */
import {
  answerElicitationRequest,
  answerPermissionRequest,
  listPendingHumanRequests,
} from '../permissions.ts';
import type { ElicitationRequest, HumanRequest, PermissionRequest } from '../permissions.ts';
import { selectPermissionOption } from '../acp/protocol.ts';
import { logger } from '../logger.ts';
import type { RpcPeer } from './rpc.ts';

const PERMISSION_KINDS = new Set(['allow_once', 'allow_always', 'reject_once', 'reject_always']);
const DEFAULT_POLL_MS = 300;

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

export interface PermissionRelayOptions {
  root: string;
  agent: string;
  taskId: string;
  /** sessionId ACP côté IDE. */
  ideSessionId: string;
  peer: RpcPeer;
  clientCapabilities: Record<string, unknown>;
  /** Message affiché dans l'éditeur (agent_message_chunk étiqueté [striart]). */
  say: (text: string) => void;
  messages: { elicitationElsewhere: string; permissionLost: (title: string) => string };
  pollMs?: number;
}

export class PermissionRelay {
  private readonly o: PermissionRelayOptions;
  private readonly seen = new Set<string>();
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;

  constructor(options: PermissionRelayOptions) {
    this.o = options;
  }

  start(): void {
    if (this.timer || this.stopped) return;
    const loop = async () => {
      if (this.stopped) return;
      await this.tick().catch((error: unknown) =>
        logger.warn({ err: error }, 'Relais des permissions (striart acp) : lecture en échec'),
      );
      if (!this.stopped)
        this.timer = setTimeout(() => void loop(), this.o.pollMs ?? DEFAULT_POLL_MS);
    };
    this.timer = setTimeout(() => void loop(), 0);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private async tick(): Promise<void> {
    const pending = await listPendingHumanRequests(this.o.root);
    for (const request of pending) {
      if (request.agent !== this.o.agent || request.taskId !== this.o.taskId) continue;
      if (this.seen.has(request.id)) continue;
      this.seen.add(request.id);
      void this.forward(request).catch((error: unknown) =>
        logger.warn(
          { err: error, id: request.id },
          'Relais d’une demande humaine vers l’IDE en échec',
        ),
      );
    }
  }

  private async forward(request: HumanRequest): Promise<void> {
    if (request.kind === 'elicitation') return this.forwardElicitation(request);
    return this.forwardPermission(request as PermissionRequest);
  }

  private async forwardPermission(request: PermissionRequest): Promise<void> {
    const { peer, ideSessionId } = this.o;
    // ACP exige un `kind` par option : sans lui, aucune option n'est inventée —
    // la demande reste au dashboard (et au fail closed du délai).
    if (!request.options.every((o) => typeof o.kind === 'string' && PERMISSION_KINDS.has(o.kind))) {
      this.o.say(this.o.messages.elicitationElsewhere);
      return;
    }
    const synthetic = !request.toolCallId;
    const toolCallId = request.toolCallId ?? `striart-permission-${request.id}`;
    if (synthetic) {
      peer.notify('session/update', {
        sessionId: ideSessionId,
        update: {
          sessionUpdate: 'tool_call',
          toolCallId,
          title: request.title,
          kind: 'other',
          status: 'pending',
        },
      });
    }
    let response: unknown;
    try {
      response = await peer.request('session/request_permission', {
        sessionId: ideSessionId,
        toolCall: { toolCallId, title: request.title },
        options: request.options.map((o) => ({
          optionId: o.optionId,
          name: o.name ?? o.optionId,
          kind: o.kind,
        })),
      });
    } catch (error) {
      // IDE en erreur ou parti : la demande expirera côté session (fail closed).
      logger.warn({ err: error, id: request.id }, 'Permission non arbitrée par l’IDE');
      return;
    }
    const outcome =
      isPlainObject(response) && isPlainObject(response.outcome) ? response.outcome : null;
    let chosen =
      outcome?.outcome === 'selected' && typeof outcome.optionId === 'string'
        ? (request.options.find((o) => o.optionId === outcome.optionId) ?? null)
        : null;
    // Prompt annulé côté IDE (ou option inconnue) : refus explicite si l'agent
    // en propose un — jamais un accord par défaut.
    if (!chosen) chosen = selectPermissionOption(request.options, 'reject');
    if (chosen) {
      try {
        await answerPermissionRequest(this.o.root, request.id, chosen.optionId);
      } catch {
        this.o.say(this.o.messages.permissionLost(request.title));
      }
    }
    if (synthetic) {
      peer.notify('session/update', {
        sessionId: ideSessionId,
        update: {
          sessionUpdate: 'tool_call_update',
          toolCallId,
          status: chosen?.kind?.startsWith('allow') ? 'completed' : 'failed',
        },
      });
    }
  }

  private async forwardElicitation(request: ElicitationRequest): Promise<void> {
    const caps = isPlainObject(this.o.clientCapabilities.elicitation)
      ? this.o.clientCapabilities.elicitation
      : null;
    // Seul le mode formulaire est relayé (schéma déjà validé au dépôt) ; le
    // mode URL reste au dashboard, qui affiche l'adresse sans jamais l'ouvrir.
    if (request.mode !== 'form' || !caps || !isPlainObject(caps.form)) {
      this.o.say(this.o.messages.elicitationElsewhere);
      return;
    }
    let response: unknown;
    try {
      response = await this.o.peer.request('elicitation/create', {
        sessionId: this.o.ideSessionId,
        mode: 'form',
        message: request.message,
        requestedSchema: request.requestedSchema,
      });
    } catch (error) {
      logger.warn({ err: error, id: request.id }, 'Elicitation non relayée par l’IDE');
      return;
    }
    const r = isPlainObject(response) ? response : {};
    const action = r.action === 'accept' || r.action === 'decline' ? r.action : 'cancel';
    try {
      await answerElicitationRequest(this.o.root, request.id, {
        action,
        content: action === 'accept' && isPlainObject(r.content) ? r.content : null,
      });
    } catch {
      // Réponse non conforme au schéma, ou déjà tranchée : la session applique
      // son fail closed (cancel) au délai.
      this.o.say(this.o.messages.permissionLost(request.message.slice(0, 80)));
    }
  }
}

/**
 * Méthodes du Striart Control Protocol v1 — le plan HUMAIN de Striart.
 *
 * Aucune logique métier ici : chaque méthode appelle les fonctions du
 * domaine (orchestrateur, conflits, permissions, session principale) avec
 * les mêmes verrous et les mêmes garde-fous que la CLI, et rend les MÊMES
 * données que la commande CLI correspondante en `--json` (même `data`, même
 * issue `outcome` via exit.ts). Écart assumé et documenté : le protocole
 * n'ouvre jamais de terminal (`session: null` pour un lancement supervisé,
 * pas de champ `session` sur les tâches démarrées par la file).
 *
 * Les paramètres arrivent DÉJÀ validés par leur schéma publié (rpc.ts) ; la
 * validation de fond (agent inscrit, option proposée par l'agent, ticket
 * ouvert…) reste celle du domaine.
 */
import { open } from 'node:fs/promises';
import { cleanClones, readRegistry, validateAgentName } from '../clone.ts';
import {
  closeConflictTicket,
  prepareResolutionScaffold,
  readResolutionInputs,
  readTicketDetail,
} from '../conflicts.ts';
import { loadConfig } from '../config.ts';
import { runDoctor } from '../doctor.ts';
import { StriartError, agentUnknownError } from '../errors.ts';
import { logger } from '../logger.ts';
import { readMainSessionStatus, stopMainSession } from '../main-session.ts';
import {
  applyTicketResolution,
  mergeAgentCommit,
  promoteStaging,
  reconcile,
  retryQueue,
  rollbackLastMerge,
  runAutonomousTask,
  runTask,
  stopAgent,
} from '../orchestrator.ts';
import { answerElicitationRequest, answerPermissionRequest } from '../permissions.ts';
import { answerHumanReview, listHumanReviews } from '../orchestration/human-review.ts';
import { listOrchestrationState } from '../orchestration/store.ts';
import { presentReview } from './state.ts';
import { pruneWorkspace } from '../prune.ts';
import { sweepIdle } from '../idle/sweep.ts';
import { DEFAULT_PROFILE, resolveAgentProfile, sessionLogPath } from '../session.ts';
import { resetManualMode } from '../state.ts';
import { syncAgentWithMain, syncAllAgents } from '../sync.ts';
import {
  manualResolutionOutcome,
  mergeOutcome,
  promoteOutcome,
  syncOutcome,
  worstOutcome,
} from '../cli/exit.ts';
import type { Outcome } from '../cli/exit.ts';
import type { Locale, Messages } from '../cli/i18n/index.ts';
import { CONTROL_PROTOCOL_VERSION, SCHEMA_VERSION } from './envelope.ts';
import type { DocumentWarning } from './envelope.ts';
import type { ControlHub } from './hub.ts';
import { METHOD_SPECS, NOTIFICATION_SPECS, buildOpenRpcDocument } from './schema.ts';
import type { Transport } from './schema.ts';

/** Fin de log de session servie (même borne que le dashboard historique). */
export const SESSION_LOG_TAIL = 64_000;

/** Abonnements d'une connexion à flux (stdio). */
export interface StreamConnection {
  subscribe(): Promise<{
    subscriptionId: string;
    seq: number;
    state: unknown;
    activate: () => void;
  }>;
  unsubscribe(id: string): boolean;
}

export interface MethodContext {
  root: string;
  hub: ControlHub;
  m: Messages;
  locale: Locale;
  version: string;
  transport: Transport;
  /** null sur HTTP (l'abonnement y passe par GET /events). */
  connection: StreamConnection | null;
}

export interface MethodOutput {
  data: unknown;
  outcome?: Outcome;
  warnings?: DocumentWarning[];
  /** Appelé une fois la réponse écrite (ex. activer un abonnement). */
  afterResponse?: () => void;
}

/** Revues humaines au format du plan humain : texte non fiable neutralisé. */
async function reviewsForHuman(root: string) {
  return (await listHumanReviews(root)).map(presentReview);
}

type Params = Record<string, unknown>;
type Handler = (ctx: MethodContext, params: Params) => Promise<MethodOutput>;

const nullableAgent = (value: unknown): string | null =>
  value === undefined || value === null ? null : validateAgentName(value);

/**
 * Lancement autonome : une session dure des minutes voire des heures, la
 * réponse ne peut pas l'attendre. Le profil (et, par le schéma, le nom
 * d'agent) sont validés AVANT de répondre — un profil inconnu échoue dans
 * la requête, pas en tâche de fond —, puis le cycle vit dans le process qui
 * sert le protocole : ses échecs remontent par le bus d'événements et son
 * épilogue par une `control.notice`. La session meurt avec ce process,
 * exactement comme avec la CLI qui l'aurait lancée.
 */
async function launchAutonomous(
  ctx: MethodContext,
  { prompt, agent, profile }: { prompt: string; agent: string | null; profile: string | null },
): Promise<MethodOutput> {
  const config = await loadConfig(ctx.root);
  const profileKey = profile ?? DEFAULT_PROFILE;
  resolveAgentProfile(config, profileKey);
  const c = ctx.m.control;
  void runAutonomousTask({ root: ctx.root, agent, prompt, profile: profileKey }).then(
    (result) => {
      if (result.status === 'MERGED') {
        ctx.hub.notice(
          'autonomous:merged',
          c.autonomousMerged(result.agent, result.cleaned ? null : result.keptReason),
        );
      } else if (result.status === 'QUEUED') {
        ctx.hub.notice('autonomous:queued', c.autonomousQueued(result.agent));
      } else {
        ctx.hub.notice(
          `autonomous:${result.status.toLowerCase()}`,
          c.autonomousBlocked(result.agent, result.keptReason ?? result.status),
        );
      }
    },
    (error: Error & { code?: string }) => {
      // Trace persistante AVANT la notice : celle-ci est perdue sans abonné,
      // et le bus d'événements n'accepte jamais les erreurs (events.js).
      logger.error(
        { err: error, agent, profile: profileKey, code: error.code ?? null },
        'Autonomous task launched through the control protocol failed',
      );
      ctx.hub.notice('autonomous:failed', c.autonomousFailed(error.message));
    },
  );
  return { data: { mode: 'autonomous', launched: true, agent, profile: profileKey } };
}

/**
 * Queue (maxBytes octets au plus) d'un fichier, lue depuis la fin : un log
 * de session peut peser des centaines de Mo, il n'est jamais chargé en
 * entier. Le début de la fenêtre est recalé sur une frontière de caractère
 * UTF-8 (jamais d'octets de continuation orphelins → pas de U+FFFD).
 */
async function readLogTail(file: string, maxBytes: number): Promise<string> {
  const handle = await open(file, 'r');
  try {
    const { size } = await handle.stat();
    const length = Math.min(size, maxBytes);
    const buffer = Buffer.alloc(length);
    let read = 0;
    while (read < length) {
      const { bytesRead } = await handle.read(buffer, read, length - read, size - length + read);
      if (bytesRead === 0) break;
      read += bytesRead;
    }
    let start = 0;
    if (size > length) while (start < read && (buffer[start] & 0xc0) === 0x80) start += 1;
    return buffer.toString('utf8', start, read);
  } finally {
    await handle.close();
  }
}

export const HANDLERS: Record<string, Handler> = {
  async 'control.initialize'(ctx, params) {
    if (params.protocolVersion !== CONTROL_PROTOCOL_VERSION) {
      throw new StriartError(
        `Unsupported Striart Control Protocol version ${String(params.protocolVersion)}: this server speaks version ${CONTROL_PROTOCOL_VERSION}.`,
        {
          code: 'CONTROL_VERSION_UNSUPPORTED',
          details: { requested: params.protocolVersion, supported: [CONTROL_PROTOCOL_VERSION] },
          hint: 'Update the client or Striart so that both speak the same protocol version.',
        },
      );
    }
    return {
      data: {
        protocolVersion: CONTROL_PROTOCOL_VERSION,
        schemaVersion: SCHEMA_VERSION,
        server: { name: 'striart', version: ctx.version },
        transport: ctx.transport,
        locale: ctx.locale,
        methods: METHOD_SPECS.filter((s) => s.transports.includes(ctx.transport)).map(
          (s) => s.name,
        ),
        notifications: NOTIFICATION_SPECS.map((n) => n.name),
      },
    };
  },

  async 'rpc.discover'(ctx) {
    return { data: buildOpenRpcDocument(ctx.version) };
  },

  async 'state.get'(ctx) {
    return { data: await ctx.hub.getState() };
  },

  async 'state.subscribe'(ctx) {
    const { subscriptionId, seq, state, activate } = await requireConnection(ctx).subscribe();
    return { data: { subscriptionId, seq, state }, afterResponse: activate };
  },

  async 'state.unsubscribe'(ctx, params) {
    const id = String(params.subscriptionId);
    if (!requireConnection(ctx).unsubscribe(id)) {
      throw new StriartError(`Unknown subscription "${id}" on this connection.`, {
        code: 'CONTROL_SUBSCRIPTION_UNKNOWN',
        details: { subscriptionId: id },
        hint: 'Call state.subscribe to get a subscription id.',
      });
    }
    return { data: { subscriptionId: id, unsubscribed: true } };
  },

  async 'ticket.get'(ctx, params) {
    const id = String(params.id);
    const detail = await readTicketDetail(ctx.root, id);
    const resolutionInputs = detail.resolved
      ? []
      : (await readResolutionInputs(ctx.root, id)).map((input) => ({
          path: input.path,
          kind: input.kind,
        }));
    return { data: { ...detail, resolutionInputs } };
  },

  async 'session.log'(ctx, params) {
    // Chemin reconstruit depuis le registre, jamais depuis la requête.
    const agent = validateAgentName(params.agent);
    const meta = (await readRegistry(ctx.root))[agent];
    if (!meta) throw agentUnknownError(agent);
    const logPath = sessionLogPath(ctx.root, agent, meta.taskId);
    let log: string;
    try {
      log = await readLogTail(logPath, SESSION_LOG_TAIL);
    } catch (error) {
      throw new StriartError(
        `No session log for "${agent}" yet: the session may not have started.`,
        {
          code: 'SESSION_LOG_UNAVAILABLE',
          details: { agent },
          hint: 'striart status',
          cause: error,
        },
      );
    }
    return { data: { agent, path: logPath, log } };
  },

  async 'doctor.run'(ctx) {
    return { data: await runDoctor(ctx.root) };
  },

  async 'task.run'(ctx, params) {
    const prompt = String(params.prompt);
    const agent = nullableAgent(params.agent);
    if (params.mode === 'autonomous') {
      return launchAutonomous(ctx, {
        prompt,
        agent,
        profile: typeof params.profile === 'string' ? params.profile : null,
      });
    }
    const run = await runTask({ root: ctx.root, prompt, agent });
    return { data: { mode: 'attended', run, session: null } };
  },

  async 'agent.merge'(ctx, params) {
    const result = await mergeAgentCommit({
      root: ctx.root,
      agent: validateAgentName(params.agent),
    });
    return { data: result, outcome: mergeOutcome(result.status) };
  },

  async 'agent.sync'(ctx, params) {
    const agent = nullableAgent(params.agent);
    const results = agent
      ? [await syncAgentWithMain({ root: ctx.root, agent })]
      : await syncAllAgents({ root: ctx.root });
    return { data: { results }, outcome: worstOutcome(results.map((r) => syncOutcome(r.status))) };
  },

  async 'agent.stop'(ctx, params) {
    const agent = validateAgentName(params.agent);
    const result = await stopAgent({ root: ctx.root, agent, force: params.force === true });
    // Même avertissements que `striart stop` : un terminal resté vivant ne
    // doit jamais faire croire le clone libre.
    const warnings: DocumentWarning[] = [];
    if (result.ptyHost.stopping)
      warnings.push({ code: 'PTY_HOST_STOPPING', message: ctx.m.stop.hostStopping(agent) });
    if (result.ptyHost.untouched)
      warnings.push({
        code: 'PTY_HOST_UNTOUCHED',
        message: ctx.m.stop.hostUntouched(agent, ctx.m.stop.hostWhy(result.ptyHost.untouched)),
      });
    return { data: result, warnings };
  },

  async 'queue.retry'(ctx) {
    const { started, stillWaiting } = await retryQueue({ root: ctx.root });
    return { data: { action: 'retry', started, stillWaiting } };
  },

  async 'reconcile.run'(ctx) {
    const result = await reconcile({ root: ctx.root });
    return {
      data: {
        sessionPidsCleared: result.sessionPidsCleared,
        started: result.started,
        stillWaiting: result.stillWaiting,
      },
    };
  },

  async 'staging.promote'(ctx, params) {
    const result = await promoteStaging({ root: ctx.root, rollback: params.rollback === true });
    return { data: result, outcome: promoteOutcome(result.status) };
  },

  async 'merge.rollback'(ctx) {
    return { data: await rollbackLastMerge({ root: ctx.root }) };
  },

  async 'ticket.prepare'(ctx, params) {
    const ticketId = String(params.id);
    const acceptTheirs = Array.isArray(params.acceptTheirs) ? params.acceptTheirs.map(String) : [];
    const files = await prepareResolutionScaffold(ctx.root, ticketId, { acceptTheirs });
    return { data: { action: 'prepare', ticketId, files } };
  },

  async 'ticket.apply'(ctx, params) {
    const result = await applyTicketResolution({ root: ctx.root, ticketId: String(params.id) });
    return { data: { action: 'apply', result }, outcome: manualResolutionOutcome(result.status) };
  },

  async 'ticket.close'(ctx, params) {
    return {
      data: { action: 'close', ticket: await closeConflictTicket(ctx.root, String(params.id)) },
    };
  },

  async 'permission.answer'(ctx, params) {
    return {
      data: await answerPermissionRequest(ctx.root, String(params.id), String(params.option)),
    };
  },

  async 'review.list'(ctx) {
    return { data: { reviews: await reviewsForHuman(ctx.root) } };
  },

  async 'review.answer'(ctx, params) {
    // Le schéma a déjà validé les types ; parseVerdict (domaine) refait la
    // validation positive complète (chemins sûrs, bornes en octets) et
    // neutralise le texte. Seules les clés fournies sont transmises.
    const input: Record<string, unknown> = { verdict: params.verdict };
    if (params.summary !== undefined) input.summary = params.summary;
    if (params.comments !== undefined) input.comments = params.comments;
    await answerHumanReview(ctx.root, String(params.id), input);
    const answered = (await reviewsForHuman(ctx.root)).find((r) => r.id === params.id);
    return { data: { review: answered } };
  },

  async 'orchestration.state'(ctx) {
    const [orchestration, reviews] = await Promise.all([
      listOrchestrationState(ctx.root),
      reviewsForHuman(ctx.root),
    ]);
    return { data: { ...orchestration, reviews } };
  },

  async 'elicitation.answer'(ctx, params) {
    // Le contenu est validé contre le schéma de l'agent par permissions.ts
    // (ELICITATION_CONTENT_INVALID : la demande reste ouverte) ; decline et
    // cancel ne transmettent jamais de contenu.
    const action = params.action as 'accept' | 'decline' | 'cancel';
    const content =
      action === 'accept' && params.content && typeof params.content === 'object'
        ? (params.content as Record<string, unknown>)
        : undefined;
    return {
      data: await answerElicitationRequest(ctx.root, String(params.id), {
        action,
        ...(content ? { content } : {}),
      }),
    };
  },

  async 'mainSession.release'(ctx) {
    const released = await readMainSessionStatus(ctx.root);
    await stopMainSession(ctx.root);
    return { data: { action: 'stop', released } };
  },

  async 'semantic.unlock'(ctx) {
    await resetManualMode(ctx.root);
    return { data: { action: 'unlock' } };
  },

  async 'clones.clean'(ctx, params) {
    const agent = nullableAgent(params.agent);
    // Garde-fous de cleanClones inchangés : jamais all/force depuis le plan
    // humain distant — seuls les clones d'agents arrêtés sans travail en
    // attente partent.
    const result = await cleanClones({ root: ctx.root, agent, all: false, force: false });
    const refused = agent !== null && result.removed.length === 0 && result.skipped.length > 0;
    return { data: result, outcome: refused ? 'refused' : 'ok' };
  },

  async 'workspace.gc'(ctx, params) {
    const agent = nullableAgent(params.agent);
    const report = await sweepIdle({
      root: ctx.root,
      agent,
      close: params.close === true,
      dryRun: params.dryRun === true,
    });
    const failed = report.refused.some((r) => r.code === 'IDLE_CLOSE_FAILED');
    return {
      data: report,
      outcome: failed ? 'failed' : report.refused.length > 0 ? 'refused' : 'ok',
    };
  },

  async 'workspace.prune'(ctx, params) {
    return {
      data: await pruneWorkspace({ root: ctx.root, days: null, dryRun: params.dryRun === true }),
    };
  },
};

function requireConnection(ctx: MethodContext): StreamConnection {
  if (!ctx.connection) {
    throw new StriartError(
      'This method needs a streaming transport (stdio); over HTTP, use GET /events.',
      {
        code: 'CONTROL_METHOD_UNAVAILABLE',
        details: { transport: ctx.transport },
        hint: 'striart api --stdio',
      },
    );
  }
  return ctx.connection;
}

for (const spec of METHOD_SPECS) {
  if (!HANDLERS[spec.name]) throw new Error(`Control method without handler: ${spec.name}`);
}
for (const name of Object.keys(HANDLERS)) {
  if (!METHOD_SPECS.some((s) => s.name === name))
    throw new Error(`Control handler without spec: ${name}`);
}

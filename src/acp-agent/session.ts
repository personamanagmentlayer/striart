/**
 * Une session ACP ouverte par l'IDE dans le proxy `striart acp` (lot I10) =
 * UN clone Striart isolé + l'agent amont choisi + un merge sous Test Gate.
 *
 * Cycle :
 *  1. `session/new` : rien n'est créé — l'IDE reçoit les options de session
 *     (agent amont, politique de permission, fin de session) ;
 *  2. premier `session/prompt` : le clone est créé par `runTask` (Router,
 *     secrets, mode autonome — le watcher ne le merge jamais), puis l'hôte
 *     de session ACP persistant d'I6 est lancé (`closeWhenIdle: false`) avec
 *     ce prompt ; son PID est publié au registre (SESSION_LIVE couvre l'hôte) ;
 *  3. prompts suivants : remis à l'hôte par le bus (`sendHumanPrompt`),
 *     étiquetés pour que le tour qui y répond soit reconnu ;
 *  4. fin (`/striart-finish`, `session/close`, déconnexion) : fermeture
 *     propre de la session amont, puis `concludeProxySession` (commit policy,
 *     merge sous Test Gate, nettoyage) — tout échec garde le clone et le dit.
 *
 * Le verrou principal n'est JAMAIS tenu ici : chaque primitive du noyau le
 * prend brièvement de son côté. Les capacités fs/terminal de l'IDE ne sont
 * jamais utilisées (voir rpc.ts) : l'agent amont est servi, borné au clone,
 * par le client ACP de Striart dans l'hôte.
 */
import { randomUUID } from 'node:crypto';
import { buildInitialPrompt, striartMcpServers } from '../acp.ts';
import { resolveAcpOptions } from '../acp/protocol.ts';
import type { AcpOptions } from '../acp/protocol.ts';
import {
  acpHostStatus,
  connectAcpHostOwner,
  launchAcpHost,
  sendHumanPrompt,
  stopAcpHost,
  waitForAcpHostExit,
} from '../acp/host.ts';
import type { AcpHostEvent, AcpHostOwnerConnection } from '../acp/host.ts';
import { readRegistry, updateAgentMeta } from '../clone.js';
import { StriartError } from '../errors.js';
import { logger } from '../logger.js';
import { runTask } from '../orchestrator.js';
import { removeTask } from '../queue.js';
import { resolveAgentProfile } from '../session.js';
import { waitUntil } from '../orchestration/wait.ts';
import type { Messages } from '../cli/i18n/index.ts';
import type { AcpProxyResult, AgentProfile, SessionResult, StriartConfig } from '../types.js';
import { STRIART_COMMANDS, parseSlashCommand, promptToText } from './content.ts';
import { concludeProxySession } from './cycle.ts';
import type { ProxyAgentInfo } from './cycle.ts';
import { PermissionRelay } from './permission-relay.ts';
import { AcpAgentRpcError, RPC } from './rpc.ts';
import type { RpcPeer } from './rpc.ts';
import type { AcpAgentPermissionPolicy, AcpAgentSettings } from './settings.ts';

/** Délai laissé à l'hôte pour rendre son résultat après une fin de session demandée. */
const CLOSE_BACKSTOP_MS = 60_000;
/** Marge du propriétaire au-delà du délai de session (annulation + sortie de l'hôte). */
const OWNER_BACKSTOP_MS = 20_000;

type State = 'configuring' | 'starting' | 'cloned' | 'running' | 'finishing' | 'ended';
export type FinishReason = 'explicit' | 'close' | 'disconnect' | 'interrupted';

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** Profils ACP proposés à l'IDE (liste blanche de la config, ou tous). */
export function acpProfileChoices(config: StriartConfig, settings: AcpAgentSettings): string[] {
  const all = Object.entries(config.agentProfiles ?? {})
    .filter(([, p]) => Boolean((p as AgentProfile).acp))
    .map(([key]) => key)
    .sort();
  if (!settings.profiles) return all;
  for (const key of settings.profiles) {
    if (!all.includes(key)) {
      throw new StriartError(
        `acpAgent.profiles lists "${key}", which is not an ACP agent profile (acp: true) of this repository.`,
        {
          code: 'ACP_PROXY_PROFILE_UNAVAILABLE',
          hint: 'striart profiles',
          details: { profile: key },
        },
      );
    }
  }
  return [...settings.profiles];
}

/**
 * Options ACP effectives d'une session IDE : celles du profil (validées par
 * `resolveAcpOptions`, fail closed), avec la politique de permission choisie,
 * l'hôte persistant et le bus imposés (les prompts suivants de l'IDE passent
 * par lui), et le délai d'arbitrage de `acpAgent.askTimeoutMs` s'il est posé.
 */
export function effectiveAcpOptions(
  profile: AgentProfile,
  policy: AcpAgentPermissionPolicy,
  settings: AcpAgentSettings,
): AcpOptions {
  const base = resolveAcpOptions(profile);
  const permissions = policy === 'profile' ? base.permissions : policy;
  const raw = isPlainObject(profile.acp) ? (profile.acp as Record<string, unknown>) : {};
  const e = isPlainObject(raw.elicitation)
    ? (raw.elicitation as { form?: boolean; url?: boolean })
    : {};
  const ask = permissions === 'ask';
  return {
    ...base,
    permissions,
    askTimeoutMs: settings.askTimeoutMs ?? base.askTimeoutMs,
    persistentHost: true,
    bus: true,
    elicitation: { form: ask && (e.form ?? true), url: ask && (e.url ?? false) },
  };
}

export interface ProxySessionSpec {
  root: string;
  config: StriartConfig;
  settings: AcpAgentSettings;
  peer: RpcPeer;
  m: Messages;
  clientCapabilities: Record<string, unknown>;
  profileChoices: string[];
  profileKey: string;
  /** Serveurs MCP proposés par l'IDE à session/new — jamais transmis (worktree principal). */
  ideMcpServers: number;
}

export class ProxySession {
  readonly id = `striart-${randomUUID()}`;
  private readonly s: ProxySessionSpec;
  private state: State = 'configuring';
  private profileKey: string;
  private permissions: AcpAgentPermissionPolicy;
  private mergeMode: AcpAgentSettings['merge'];
  private meta: ProxyAgentInfo | null = null;
  private firstPrompt: string | null = null;
  private turns = 0;
  private owner: AcpHostOwnerConnection | null = null;
  private hostLogPath: string | null = null;
  private result: Promise<SessionResult> | null = null;
  private endedResult: SessionResult | null = null;
  private waiter: {
    tag: string | null;
    resolve: (stopReason: string | null | 'SESSION_ENDED') => void;
  } | null = null;
  private promptInFlight = false;
  private cancelRequested = false;
  private abort: AbortController | null = null;
  private relay: PermissionRelay | null = null;
  private finishPromise: Promise<AcpProxyResult | null> | null = null;
  private readonly ideTags = new Set<string>();
  private tagCounter = 0;
  private startedNoticeSent = false;

  constructor(spec: ProxySessionSpec) {
    this.s = spec;
    this.profileKey = spec.profileKey;
    this.permissions = spec.settings.permissions;
    this.mergeMode = spec.settings.merge;
  }

  get isEnded(): boolean {
    return this.state === 'ended';
  }

  // ---------------------------------------------------------------- options

  /** Options de session ACP (`configOptions`), source unique de session/new et set_config_option. */
  configOptions(): Record<string, unknown>[] {
    const { m, settings, config } = this.s;
    const t = m.acpProxy;
    const options: Record<string, unknown>[] = [
      {
        id: 'profile',
        name: t.optionProfile,
        description: t.optionProfileHelp,
        type: 'select',
        currentValue: this.profileKey,
        options: this.s.profileChoices.map((key) => ({
          value: key,
          name: key,
          description:
            (config.agentProfiles?.[key] as AgentProfile | undefined)?.command ?? undefined,
        })),
      },
      {
        id: 'permissions',
        name: t.optionPermissions,
        description: t.optionPermissionsHelp,
        category: 'mode',
        type: 'select',
        currentValue: this.permissions,
        options: settings.permissionChoices.map((value) => ({
          value,
          name: t.permissionLabels[value],
        })),
      },
    ];
    if (settings.mergeChoice) {
      options.push({
        id: 'merge',
        name: t.optionMerge,
        description: t.optionMergeHelp,
        type: 'select',
        currentValue: this.mergeMode,
        options: (['auto', 'manual'] as const).map((value) => ({
          value,
          name: t.mergeLabels[value],
        })),
      });
    }
    return options;
  }

  /** Modes de session (API héritée, remplacée par configOptions) : la politique de permission. */
  modes(): Record<string, unknown> {
    const labels = this.s.m.acpProxy.permissionLabels;
    return {
      currentModeId: this.permissions,
      availableModes: this.s.settings.permissionChoices.map((id) => ({ id, name: labels[id] })),
    };
  }

  setConfigOption(configId: unknown, value: unknown): Record<string, unknown>[] {
    const locked = this.state !== 'configuring';
    if (configId === 'profile') {
      if (locked) throw this.lockedError('profile');
      if (typeof value !== 'string' || !this.s.profileChoices.includes(value))
        throw invalidValue('profile');
      this.profileKey = value;
    } else if (configId === 'permissions') {
      if (locked) throw this.lockedError('permissions');
      if (
        typeof value !== 'string' ||
        !(this.s.settings.permissionChoices as string[]).includes(value)
      )
        throw invalidValue('permissions');
      this.permissions = value as AcpAgentPermissionPolicy;
    } else if (configId === 'merge' && this.s.settings.mergeChoice) {
      if (this.state === 'finishing' || this.state === 'ended') throw this.lockedError('merge');
      if (value !== 'auto' && value !== 'manual') throw invalidValue('merge');
      this.mergeMode = value;
    } else {
      throw new AcpAgentRpcError(
        RPC.INVALID_PARAMS,
        `Unknown session config option: ${String(configId)}`,
        {
          code: 'ACP_PROXY_OPTION_UNKNOWN',
        },
      );
    }
    return this.configOptions();
  }

  private lockedError(option: string): AcpAgentRpcError {
    return new AcpAgentRpcError(
      RPC.INVALID_PARAMS,
      `The "${option}" option is locked once the session has started (open a new session to change it).`,
      { code: 'ACP_PROXY_OPTION_LOCKED', option },
    );
  }

  // ---------------------------------------------------------------- relais vers l'IDE

  private say(text: string): void {
    if (this.s.peer.isClosed) return;
    this.s.peer.notify('session/update', {
      sessionId: this.id,
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text },
        _meta: { striart: { origin: 'striart' } },
      },
    });
  }

  /** Commandes Striart annoncées à l'IDE, fusionnées avec celles de l'agent amont. */
  announceCommands(upstream: unknown[] = []): void {
    const ours = STRIART_COMMANDS.map((c) => ({
      name: c.name,
      description:
        c.kind === 'finish' ? this.s.m.acpProxy.commandFinish : this.s.m.acpProxy.commandStatus,
    }));
    const names = new Set<string>(ours.map((c) => c.name));
    const theirs = upstream.filter(
      (c) => isPlainObject(c) && typeof c.name === 'string' && !names.has(c.name),
    );
    this.s.peer.notify('session/update', {
      sessionId: this.id,
      update: {
        sessionUpdate: 'available_commands_update',
        availableCommands: [...ours, ...theirs],
      },
    });
  }

  /**
   * Mise à jour de l'agent amont → IDE. Étiquetée (`_meta.striart`), sessionId
   * réécrit ; écartées : l'écho du message utilisateur, et les options/modes
   * PROPRES à l'amont (l'IDE les confondrait avec celles de Striart — un
   * set_config_option viserait alors un id que Striart ne connaît pas).
   */
  private relayUpdate(update: Record<string, unknown>): void {
    if (this.s.peer.isClosed || !isPlainObject(update)) return;
    const kind = update.sessionUpdate;
    if (
      kind === 'user_message_chunk' ||
      kind === 'config_option_update' ||
      kind === 'current_mode_update'
    )
      return;
    if (kind === 'agent_thought_chunk' && !this.s.settings.relayThoughts) return;
    if (kind === 'available_commands_update') {
      this.announceCommands(
        Array.isArray(update.availableCommands) ? update.availableCommands : [],
      );
      return;
    }
    const meta = isPlainObject(update._meta) ? update._meta : {};
    this.s.peer.notify('session/update', {
      sessionId: this.id,
      update: {
        ...update,
        _meta: {
          ...meta,
          striart: { origin: 'upstream', agent: this.meta?.name ?? null, turn: this.turns },
        },
      },
    });
  }

  private onHostEvent(event: AcpHostEvent): void {
    if (event.type === 'update') {
      this.relayUpdate(event.update);
      return;
    }
    if (event.phase === 'start') {
      this.turns = event.turn;
      const ours =
        event.source === 'initial' || (event.tag !== null && this.ideTags.has(event.tag));
      if (!ours) this.say(this.s.m.acpProxy.foreignTurn);
      return;
    }
    const matches =
      this.waiter &&
      (this.waiter.tag === null
        ? event.turn === 1 && event.tag === null
        : event.tag === this.waiter.tag);
    if (matches && this.waiter) {
      const { resolve } = this.waiter;
      this.waiter = null;
      if (event.stopReason === 'cancelled' && this.cancelRequested)
        this.say(this.s.m.acpProxy.turnCancelled);
      resolve(event.stopReason ?? null);
    }
  }

  // ---------------------------------------------------------------- prompt

  async prompt(params: Record<string, unknown>): Promise<{ stopReason: string }> {
    if (this.state === 'finishing' || this.state === 'ended') {
      throw new AcpAgentRpcError(
        RPC.INVALID_REQUEST,
        'This Striart session has ended (its outcome was reported above): open a new session.',
        { code: 'ACP_PROXY_SESSION_ENDED' },
      );
    }
    if (this.promptInFlight) {
      throw new AcpAgentRpcError(
        RPC.INVALID_REQUEST,
        'A prompt is already running in this session: cancel it first.',
        {
          code: 'ACP_PROXY_PROMPT_BUSY',
        },
      );
    }
    const conversion = promptToText(params.prompt, this.s.root);
    if (conversion.ok === false) {
      throw new AcpAgentRpcError(RPC.INVALID_PARAMS, `Prompt refused: ${conversion.detail}.`, {
        code: 'ACP_PROMPT_INVALID',
        reason: conversion.reason,
      });
    }
    this.promptInFlight = true;
    this.cancelRequested = false;
    this.abort = new AbortController();
    try {
      const command = parseSlashCommand(conversion.text);
      if (command === 'status') {
        this.say(this.statusLine());
        return { stopReason: 'end_turn' };
      }
      if (command === 'finish') {
        await this.finish('explicit');
        return { stopReason: 'end_turn' };
      }
      if (conversion.replacedControls > 0)
        this.say(this.s.m.acpProxy.replacedControls(conversion.replacedControls));
      if (this.state === 'configuring') {
        const started = await this.startClone(conversion.text);
        if (!started || this.cancelRequested) return { stopReason: 'cancelled' };
      }
      if (this.state === 'cloned') return { stopReason: await this.launch(conversion.text) };
      return { stopReason: await this.sendFollowUp(conversion.text) };
    } finally {
      this.promptInFlight = false;
      this.abort = null;
    }
  }

  private statusLine(): string {
    return this.s.m.acpProxy.status({
      agent: this.meta?.name ?? null,
      profile: this.profileKey,
      permissions: this.permissions,
      merge: this.mergeMode,
      turns: this.turns,
      clonePath: this.meta?.path ?? null,
    });
  }

  /** Crée le clone (Router compris). Rend false si l'humain a annulé pendant l'attente. */
  private async startClone(prompt: string): Promise<boolean> {
    const { root, config, settings } = this.s;
    const profile = resolveAgentProfile(config, this.profileKey) as AgentProfile;
    // Les options du profil sont validées AVANT de créer le clone : un profil
    // invalide échoue à vide, sans clone orphelin.
    effectiveAcpOptions(profile, this.permissions, settings);
    this.state = 'starting';
    const deadline = Date.now() + settings.collisionWaitMs;
    let name = settings.agentName;
    try {
      for (;;) {
        const r = await runTask({
          root,
          agent: name,
          prompt,
          command: profile.command,
          mode: 'autonomous',
          profile: this.profileKey,
          reuse: settings.reuse,
        });
        if (r.status === 'STARTED') {
          this.meta = r.info as ProxyAgentInfo;
          this.firstPrompt = prompt;
          this.state = 'cloned';
          return true;
        }
        name = r.task.agent;
        if (!(await removeTask(root, r.task.id))) {
          throw new StriartError(
            'The queued task was relaunched by the queue before Striart could take it back.',
            {
              code: 'ACP_PROXY_QUEUE_TOOK_OVER',
              hint: 'striart queue',
              details: { agent: name },
            },
          );
        }
        const blockers = r.collisions.map((c) => c.agent);
        if (settings.collisionPolicy === 'fail') {
          throw new StriartError(
            `The Router predicts a collision with ${blockers.join(', ')}: no clone was created.`,
            {
              code: 'ACP_PROXY_COLLISION',
              hint: 'striart status',
              details: { agents: blockers },
            },
          );
        }
        this.say(this.s.m.acpProxy.collisionWaiting(blockers.join(', ')));
        const outcome = await waitUntil(
          async () => {
            const registry = await readRegistry(root);
            return blockers.every((b) => !registry[b]);
          },
          {
            intervalMs: settings.collisionPollMs,
            timeoutMs: Math.max(0, deadline - Date.now()),
            signal: this.abort?.signal ?? null,
          },
        );
        if (outcome === 'aborted') {
          this.state = 'configuring';
          return false;
        }
        if (outcome === 'timeout') {
          throw new StriartError(`Gave up waiting for ${blockers.join(', ')} to finish.`, {
            code: 'ACP_PROXY_COLLISION',
            hint: 'striart status',
            details: { agents: blockers },
          });
        }
      }
    } catch (error) {
      if (this.state === 'starting') this.state = 'configuring';
      throw error;
    }
  }

  /** Premier tour : lance l'hôte persistant avec ce prompt, attend la fin du tour 1. */
  private async launch(prompt: string): Promise<string> {
    const { root, config, settings } = this.s;
    const meta = this.meta as ProxyAgentInfo;
    const profile = resolveAgentProfile(config, this.profileKey) as AgentProfile;
    const options = effectiveAcpOptions(profile, this.permissions, settings);
    const initialPrompt = await buildInitialPrompt({
      root,
      agent: meta.name,
      profileKey: this.profileKey,
      profile,
      config,
      prompt,
    });
    const turnEnded = this.awaitTurn(null);
    const launched = await launchAcpHost(root, {
      agent: meta.name,
      taskId: meta.taskId,
      cwd: meta.path,
      profile,
      profileKey: this.profileKey,
      options,
      initialPrompt,
      timeoutMs: settings.sessionTimeoutMs,
      closeWhenIdle: false,
      ownerPid: process.pid,
      mcpServers: striartMcpServers(root, meta.name, options),
    }).catch((error: unknown) => {
      this.waiter = null;
      throw error;
    });
    this.hostLogPath = launched.logPath;
    // SESSION_LIVE : le PID publié est celui de l'hôte, qui ne sort qu'après l'agent.
    await updateAgentMeta(root, meta.name, {
      sessionPid: launched.pid,
      sessionStartedAt: new Date().toISOString(),
    });
    try {
      this.owner = await connectAcpHostOwner(root, meta.name, {
        pid: launched.pid,
        ownerToken: launched.ownerToken,
        onEvent: (event) => this.onHostEvent(event),
      });
    } catch (error) {
      this.waiter = null;
      await stopAcpHost(root, meta.name).catch(() => null);
      await updateAgentMeta(root, meta.name, { sessionPid: null }).catch(() => {});
      throw new StriartError(
        `The ACP session host could not be reached: ${(error as Error).message}`,
        {
          code: 'ACP_HOST_LOST',
          hint: 'striart doctor',
          details: { agent: meta.name },
        },
      );
    }
    this.state = 'running';
    if (!this.startedNoticeSent) {
      this.startedNoticeSent = true;
      this.say(this.s.m.acpProxy.started(meta.name, this.profileKey, meta.path));
      if (this.s.ideMcpServers > 0) this.say(this.s.m.acpProxy.ideMcpIgnored(this.s.ideMcpServers));
    }
    this.result = this.watchResult(this.owner, launched.pid);
    if (options.permissions === 'ask') {
      this.relay = new PermissionRelay({
        root,
        agent: meta.name,
        taskId: meta.taskId,
        ideSessionId: this.id,
        peer: this.s.peer,
        clientCapabilities: this.s.clientCapabilities,
        say: (text) => this.say(text),
        messages: {
          elicitationElsewhere: this.s.m.acpProxy.elicitationElsewhere,
          permissionLost: this.s.m.acpProxy.permissionLost,
        },
      });
      this.relay.start();
    }
    if (this.cancelRequested) this.owner.cancelTurn();
    return this.finishTurn(await turnEnded);
  }

  /** Prompt suivant : bus de l'hôte, étiqueté ; attend la fin de SON tour. */
  private async sendFollowUp(text: string): Promise<string> {
    const meta = this.meta as ProxyAgentInfo;
    this.tagCounter += 1;
    const tag = `ide-${this.tagCounter}`;
    this.ideTags.add(tag);
    const turnEnded = this.awaitTurn(tag);
    const sent = await sendHumanPrompt(this.s.root, meta.name, text, { tag });
    if (sent.ok === false) {
      this.waiter = null;
      throw new AcpAgentRpcError(
        RPC.INTERNAL_ERROR,
        `The upstream session refused the prompt: ${sent.message}`,
        {
          code: sent.code,
        },
      );
    }
    return this.finishTurn(await turnEnded);
  }

  private awaitTurn(tag: string | null): Promise<string | null | 'SESSION_ENDED'> {
    return new Promise((resolve) => {
      this.waiter = { tag, resolve };
    });
  }

  /** Issue d'un tour vue par l'IDE ; une session amont finie en route est conclue et signalée. */
  private async finishTurn(stopReason: string | null | 'SESSION_ENDED'): Promise<string> {
    if (stopReason !== 'SESSION_ENDED') return stopReason ?? 'end_turn';
    const outcome = await this.finish('close');
    throw new AcpAgentRpcError(
      RPC.INTERNAL_ERROR,
      `The upstream agent session ended (${this.endedResult?.status ?? 'FAILED'}${this.endedResult?.error ? `: ${this.endedResult.error}` : ''}); outcome: ${outcome?.status ?? 'NOTHING_STARTED'}.`,
      {
        code: 'ACP_PROXY_UPSTREAM_ENDED',
        status: this.endedResult?.status ?? null,
        outcome: outcome?.status ?? null,
      },
    );
  }

  /** Résultat de la session amont, filet du propriétaire compris ; jamais rejeté. */
  private watchResult(owner: AcpHostOwnerConnection, pid: number): Promise<SessionResult> {
    const startedAt = Date.now();
    const failed = (errorCode: string, error: string): SessionResult => ({
      status: 'FAILED',
      agent: this.meta?.name ?? 'unknown',
      exitCode: null,
      durationMs: Date.now() - startedAt,
      timedOut: false,
      logPath: this.hostLogPath ?? '',
      command: '',
      stopReason: null,
      turns: this.turns,
      errorCode,
      error,
    });
    let backstop: NodeJS.Timeout | null = null;
    const overdue = new Promise<'overdue'>((resolve) => {
      backstop = setTimeout(
        () => resolve('overdue'),
        this.s.settings.sessionTimeoutMs + OWNER_BACKSTOP_MS,
      );
      backstop.unref();
    });
    const result = (async () => {
      try {
        const outcome = await Promise.race([owner.result, overdue]);
        if (outcome === 'overdue') {
          await stopAcpHost(this.s.root, this.meta!.name).catch(() => null);
          return {
            ...failed(
              'ACP_HOST_LOST',
              'ACP session host did not report within its deadline: stopped.',
            ),
            status: 'TIMEOUT',
            timedOut: true,
          } as SessionResult;
        }
        return outcome;
      } catch (error) {
        await stopAcpHost(this.s.root, this.meta!.name).catch(() => null);
        return failed('ACP_HOST_LOST', (error as Error).message);
      } finally {
        if (backstop) clearTimeout(backstop);
        owner.close();
        if (!(await waitForAcpHostExit(pid)))
          await stopAcpHost(this.s.root, this.meta!.name).catch(() => null);
        const status = await acpHostStatus(this.s.root, this.meta!.name, { fresh: true }).catch(
          () => null,
        );
        if (status?.stale) await stopAcpHost(this.s.root, this.meta!.name).catch(() => null);
      }
    })();
    void result.then((r) => {
      this.endedResult = r;
      this.relay?.stop();
      // Session amont finie sans fin demandée (délai, crash, arrêt de l'hôte) :
      // le prompt en attente l'apprend tout de suite, la conclusion suit.
      if (this.waiter) {
        const { resolve } = this.waiter;
        this.waiter = null;
        resolve('SESSION_ENDED');
      } else if (this.state === 'running') {
        void this.finish('close').catch((error: unknown) =>
          logger.error({ err: error }, 'Conclusion de session (striart acp) en échec'),
        );
      }
    });
    return result;
  }

  // ---------------------------------------------------------------- annulation / fin

  /** `session/cancel` : annule le TOUR en cours (la session continue). */
  cancel(): void {
    if (this.state === 'finishing') {
      this.say(this.s.m.acpProxy.cancelIgnoredWhileFinishing);
      return;
    }
    if (!this.promptInFlight) return;
    this.cancelRequested = true;
    this.abort?.abort();
    if (this.state === 'running') this.owner?.cancelTurn();
  }

  /**
   * Fin de session (idempotente). `explicit` (/striart-finish) et `close`
   * appliquent `merge` ; `disconnect` applique `acpAgent.onDisconnect` ;
   * `interrupted` (Ctrl+C, SIGTERM) ne merge jamais — une interruption n'est
   * pas un accord. Le merge en cours ne s'interrompt jamais.
   */
  finish(reason: FinishReason): Promise<AcpProxyResult | null> {
    if (this.finishPromise) return this.finishPromise;
    this.finishPromise = this.runFinish(reason);
    return this.finishPromise;
  }

  private async runFinish(reason: FinishReason): Promise<AcpProxyResult | null> {
    const previous = this.state;
    this.state = 'finishing';
    this.abort?.abort();
    const { root, config, settings, m } = this.s;
    if (!this.meta) {
      this.state = 'ended';
      this.say(m.acpProxy.outcomeNothing);
      return null;
    }
    this.say(m.acpProxy.finishing);
    let session: SessionResult | null = null;
    if (previous === 'running' && this.owner && this.result) {
      // ACP session/close : le travail en cours est annulé, puis la session
      // amont se ferme proprement (session/close vers l'agent).
      if (this.waiter) this.owner.cancelTurn();
      this.owner.closeSession();
      const closeBackstop = setTimeout(() => {
        void stopAcpHost(root, this.meta!.name).catch(() => null);
      }, CLOSE_BACKSTOP_MS);
      closeBackstop.unref();
      session = await this.result;
      clearTimeout(closeBackstop);
    } else if (this.result) {
      session = await this.result;
    }
    this.relay?.stop();
    const merge =
      reason === 'interrupted'
        ? false
        : reason === 'disconnect'
          ? settings.onDisconnect === 'finish' && this.mergeMode === 'auto'
          : this.mergeMode === 'auto';
    const deferredReason =
      reason === 'disconnect' || reason === 'interrupted' ? 'DISCONNECTED' : 'MANUAL';
    let outcome: AcpProxyResult;
    try {
      outcome = await concludeProxySession({
        root,
        config,
        meta: this.meta,
        profileKey: this.profileKey,
        profile: resolveAgentProfile(config, this.profileKey) as AgentProfile,
        session,
        prompt: this.firstPrompt ?? '',
        merge,
        deferredReason: merge ? 'MANUAL' : deferredReason,
      });
    } catch (error) {
      // Erreur du noyau (verrou, session principale déclarée…) : le clone est
      // conservé, l'IDE l'apprend — jamais un faux vert.
      await updateAgentMeta(root, this.meta.name, { sessionPid: null }).catch(() => {});
      const code = error instanceof StriartError ? error.code : 'UNEXPECTED';
      logger.error({ err: error, agent: this.meta.name }, 'Fin de session (striart acp) en échec');
      outcome = {
        agent: this.meta.name,
        session,
        merge: null,
        commit: null,
        cleaned: false,
        clonePath: this.meta.path,
        status: 'MERGE_BLOCKED',
        keptCode: 'MERGE_BLOCKED',
        keptDetail: code,
        keptReason: (error as Error).message,
      };
    }
    this.report(outcome);
    this.state = 'ended';
    return outcome;
  }

  private report(outcome: AcpProxyResult): void {
    const t = this.s.m.acpProxy;
    if (outcome.status === 'MERGED' && outcome.cleaned && outcome.merge?.status === 'MERGED') {
      this.say(t.outcomeMerged(outcome.agent, outcome.merge.mergeSha));
    } else if (
      outcome.status === 'MERGED' &&
      outcome.cleaned &&
      outcome.merge?.status === 'UP_TO_DATE' &&
      outcome.merge.mergeSha
    ) {
      this.say(t.outcomeAlreadyIntegrated(outcome.agent, outcome.merge.mergeSha));
    } else if (outcome.status === 'NOTHING_STARTED' && outcome.cleaned) {
      this.say(t.outcomeNothing);
    } else {
      const code = outcome.keptCode;
      const reasons = t.keptReasons;
      let reason: string;
      switch (code) {
        case 'NO_COMMIT':
        case 'NO_CHANGES':
        case 'ONLY_EXCLUDED_CHANGES':
          reason = reasons[code];
          break;
        case 'MERGE_DEFERRED':
          reason = reasons.MERGE_DEFERRED(outcome.agent, outcome.keptDetail);
          break;
        case 'HUMAN_REVIEW_REQUIRED':
          reason = reasons.HUMAN_REVIEW_REQUIRED(outcome.agent);
          break;
        case 'SESSION_FAILED':
        case 'COMMIT_REFUSED':
        case 'COMMIT_FAILED':
        case 'MERGE_BLOCKED':
        case 'CLEANUP_SKIPPED':
          reason = reasons[code](outcome.keptDetail);
          break;
        default:
          reason = outcome.keptReason ?? '';
      }
      this.say(t.outcomeKept(outcome.agent, reason, outcome.cleaned ? null : outcome.clonePath));
    }
    const logPath = outcome.session?.logPath || this.hostLogPath;
    if (logPath) this.say(t.logAt(logPath));
  }
}

function invalidValue(option: string): AcpAgentRpcError {
  return new AcpAgentRpcError(
    RPC.INVALID_PARAMS,
    `Invalid value for the "${option}" session option.`,
    {
      code: 'ACP_PROXY_OPTION_INVALID',
      option,
    },
  );
}

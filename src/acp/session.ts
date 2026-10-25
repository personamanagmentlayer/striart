import { execa, type Result, type ResultPromise } from 'execa';
import { createRequire } from 'node:module';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { loadConfig } from '../config.js';
import { logger } from '../logger.js';
import { SessionMeter } from '../tokens/session-meter.ts';
import { boundedLines } from '../line-reader.ts';
import { killProcessTree, normalizeExitCode } from '../process-tree.js';
import {
  awaitElicitationAnswer,
  awaitPermissionAnswer,
  createElicitationRequest,
  createPermissionRequest,
} from '../permissions.ts';
import {
  ACP_PROTOCOL_VERSION,
  JSONRPC,
  acpRelaxedProtections,
  buildAuthRequiredMessage,
  formatSessionUpdate,
  isProtocolAuthMethod,
  parseAuthMethods,
  resolvePathInsideClone,
  resolveWritablePathInsideClone,
  selectPermissionOption,
} from './protocol.ts';
import type {
  AcpOptions,
  AuthMethod,
  JsonRpcMessage,
  McpServerSpec,
  PermissionOption,
  TextContentBlock,
} from './protocol.ts';
import { SessionLog } from './session-log.ts';
import { RpcError, TerminalManager } from './terminals.ts';
import type { AgentProfile, SessionResult, StriartConfig } from '../types.js';

/**
 * Session ACP v1 côté client : la connexion JSON-RPC (ndjson sur le stdio de
 * l'agent) et son déroulé — handshake, authentification sur décision
 * explicite, `session/new` (avec le serveur MCP Striart), une FILE de
 * prompts (le premier, puis les messages humains du bus `@agent` en
 * Phase E), `session/cancel`, `session/close`. Ce module est le moteur
 * commun aux deux modes d'hébergement : en process (`persistentHost: false`)
 * et dans l'hôte persistant détaché (`host-run.ts`). Il ne publie rien et ne
 * prend aucun verrou : le verrou principal n'est jamais tenu pendant une
 * session (décision n°6).
 *
 * Requêtes entrantes servies (agent → client), toutes bornées :
 *  - session/request_permission : politique allow/reject, ou humain ('ask') ;
 *  - elicitation/create         : humain seulement ('ask'), schéma validé ;
 *  - fs/read_text_file, fs/write_text_file : bornées au clone (liens compris) ;
 *  - terminal/*                 : bornées au clone (voir terminals.ts).
 */

/** Grâce accordée à l'agent pour honorer `session/cancel` avant le kill. */
export const CANCEL_GRACE_MS = 3_000;
/** Grâce accordée au process pour sortir seul après la fermeture de stdin. */
const EXIT_GRACE_MS = 2_000;
/** Attente maximale de la réponse à `session/close` (cancel + libération côté agent). */
const CLOSE_TIMEOUT_MS = 3_000;
/**
 * Borne d'une ligne entrante, appliquée PENDANT la lecture (boundedLines) —
 * jamais après accumulation. L'agent est du code de confiance (SECURITY.md),
 * la borne protège d'un adaptateur emballé ; assez large pour un
 * `fs/write_text_file` d'un gros fichier légitime.
 */
export const MAX_LINE_BYTES = 16_000_000;

const { version: STRIART_VERSION } = createRequire(import.meta.url)('../../package.json') as {
  version: string;
};

/** Échec nommé d'une session (contrat SessionResult.errorCode). */
export class AcpSessionError extends Error {
  readonly code: string;
  constructor({ code, message }: { code: string; message: string }) {
    super(message);
    this.code = code;
  }
}

class RpcRequestError extends Error {
  readonly rpcCode: number;
  constructor(rpcCode: number, message: string) {
    super(`${message} (code ${rpcCode})`);
    this.rpcCode = rpcCode;
  }
}

export interface AcpSessionSpec {
  root: string;
  agent: string;
  taskId: string;
  cwd: string;
  profile: AgentProfile;
  profileKey: string;
  options: AcpOptions;
  /** Environnement de base de l'agent (profile.env et STRIART_SESSION s'y ajoutent). */
  env: NodeJS.ProcessEnv;
  mcpServers: McpServerSpec[];
}

/**
 * File des prompts d'une session. Le premier est fourni au démarrage ; les
 * suivants arrivent du bus (texte HUMAIN seulement — jamais une sortie de
 * LLM réinjectée : seul l'hôte, sur un message d'un client authentifié par
 * jeton, appelle `enqueue`). `closeWhenIdle` : la session se ferme dès que
 * la file est vide à la fin d'un tour — décision atomique (boucle
 * d'événements unique), un message arrivé ensuite est refusé, jamais perdu
 * en silence.
 */
export class PromptQueue {
  private readonly items: Array<{
    blocks: TextContentBlock[];
    source: 'initial' | 'bus';
    tag: string | null;
  }> = [];
  private closing = false;
  private waiter: (() => void) | null = null;
  readonly closeWhenIdle: boolean;

  constructor(initial: TextContentBlock[], { closeWhenIdle }: { closeWhenIdle: boolean }) {
    this.items.push({ blocks: initial, source: 'initial', tag: null });
    this.closeWhenIdle = closeWhenIdle;
  }

  get isClosing(): boolean {
    return this.closing;
  }

  get length(): number {
    return this.items.length;
  }

  /**
   * Ajoute un prompt ; rend sa position (1 = prochain), ou null si la session
   * se ferme. `tag` : étiquette opaque rendue avec le tour (le proxy ACP
   * `striart acp`, lot I10, y reconnaît le tour qui répond à SON prompt).
   */
  enqueue(blocks: TextContentBlock[], tag: string | null = null): number | null {
    if (this.closing) return null;
    this.items.push({ blocks, source: 'bus', tag });
    this.waiter?.();
    return this.items.length;
  }

  /** Ferme la file : plus aucun prompt accepté. */
  close(): void {
    this.closing = true;
    this.waiter?.();
  }

  /** Prochain prompt, ou null quand la session doit se fermer. */
  async next(): Promise<{
    blocks: TextContentBlock[];
    source: 'initial' | 'bus';
    tag: string | null;
  } | null> {
    for (;;) {
      const item = this.items.shift();
      if (item && !this.closing) return item;
      if (this.closing) return null;
      if (this.closeWhenIdle) {
        this.closing = true;
        return null;
      }
      await new Promise<void>((resolve) => {
        this.waiter = () => {
          this.waiter = null;
          resolve();
        };
      });
    }
  }
}

/** Connexion JSON-RPC à un agent ACP lancé par Striart. */
export class AcpConnection {
  private readonly spec: AcpSessionSpec;
  private readonly log: SessionLog;
  private readonly subprocess: ResultPromise;
  private readonly pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >();
  private readonly terminals: TerminalManager | null;
  /** Annule les attentes humaines en vol (permission, elicitation) à la fin de session. */
  private readonly humanWaits = new AbortController();
  private nextId = 1;
  private finished = false;
  /** Le process de l'agent est mort (spawn échoué compris) : plus aucune réponse ne viendra. */
  private processExited = false;
  private agentCapabilities: Record<string, unknown> = {};
  private authMethods: AuthMethod[] = [];
  readonly exited: Promise<Result>;
  sessionId: string | null = null;
  /** Observateur des `session/update` de l'agent (relais du proxy `striart acp`, lot I10). */
  onUpdate: ((update: Record<string, unknown>) => void) | null = null;
  /** Observateur de la réponse à `session/prompt` (usage de tour — lot T). */
  onTurnResult: ((turn: unknown) => void) | null = null;

  constructor(spec: AcpSessionSpec, log: SessionLog) {
    this.spec = spec;
    this.log = log;
    const { profile, cwd, env } = spec;
    // Même composition d'environnement que le mode argv (session.js) :
    // STRIART_SESSION en dernier, non surchargeable par un env de profil.
    const agentEnv = { ...env, ...(profile.env ?? {}), STRIART_SESSION: '1' };
    this.subprocess = execa(profile.command, profile.args ?? [], {
      cwd,
      shell: false,
      reject: false,
      detached: process.platform !== 'win32',
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
      env: agentEnv,
    });
    this.terminals = spec.options.terminal.enabled
      ? new TerminalManager({
          cloneRoot: path.resolve(cwd),
          env: agentEnv,
          limits: spec.options.terminal,
          log: (text) => this.log.append(text),
        })
      : null;
    // stderr = canal de debug de l'adaptateur : capturé au log, jamais
    // interprété. setEncoding : un caractère multi-octets coupé entre deux
    // chunks est recollé (chunk.toString() le casserait).
    this.subprocess.stderr?.setEncoding('utf8');
    this.subprocess.stderr?.on('data', (chunk: string) => this.log.append(chunk));
    this.exited = this.subprocess.then((r) => r);
    // Une mort du process avant l'issue doit faire échouer les requêtes en
    // vol, sinon la session attendrait une réponse qui ne viendra jamais.
    void this.exited.then(() => {
      this.processExited = true;
      if (!this.finished)
        this.failAllPending('Le process de l’agent ACP est sorti avant la fin de session.');
    });
    void this.readLoop();
  }

  get pid(): number | undefined {
    return this.subprocess.pid;
  }

  private async readLoop(): Promise<void> {
    // Sur un échec de spawn (binaire introuvable), execa peut ne pas fournir
    // de flux : la session échouera par la mort du process.
    const stdout = this.subprocess.stdout;
    if (!stdout) return;
    try {
      for await (const line of boundedLines(stdout, {
        maxLineBytes: MAX_LINE_BYTES,
        encoding: 'utf8',
        onOverflow: (dropped) =>
          this.log.append(`\n[acp] ligne de ${dropped} octets ignorée (borne anti-emballement)\n`),
      })) {
        this.onLine(line);
      }
    } catch (error) {
      this.log.append(
        `\n[acp] lecture de la sortie de l'agent interrompue : ${(error as Error).message}\n`,
      );
    }
  }

  private onLine(line: string): void {
    if (line.length === 0) return;
    let message: JsonRpcMessage;
    try {
      message = JSON.parse(line);
    } catch {
      // Texte hors protocole sur stdout : journalisé sans casser la session.
      this.log.append(`${line}\n`);
      return;
    }
    if (message === null || typeof message !== 'object') return;
    if (message.id != null && (message.result !== undefined || message.error !== undefined)) {
      const entry = this.pending.get(message.id as number);
      if (entry) {
        this.pending.delete(message.id as number);
        if (message.error) {
          entry.reject(new RpcRequestError(message.error.code, message.error.message));
        } else {
          entry.resolve(message.result);
        }
      }
      return;
    }
    if (message.method && message.id != null) {
      void this.handleIncomingRequest(message);
      return;
    }
    if (message.method === 'session/update') {
      const update = (message.params?.update ?? {}) as Record<string, unknown>;
      this.log.append(formatSessionUpdate(update));
      try {
        this.onUpdate?.(update);
      } catch (error) {
        // Un observateur défaillant ne casse jamais la session (le log reste la trace).
        logger.warn({ err: error }, 'Relais de session/update en échec (ignoré)');
      }
    }
    // Autres notifications (elicitation/complete…) : optionnelles, ignorées.
  }

  private send(message: JsonRpcMessage): void {
    const stdin = this.subprocess.stdin;
    if (this.finished || !stdin || !stdin.writable) return;
    stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
  }

  request(method: string, params: Record<string, unknown>): Promise<unknown> {
    return new Promise((resolve, reject) => {
      // Spawn échoué (binaire introuvable) : le process est déjà mort quand
      // la session ouvre sa première requête, donc failAllPending est passé
      // avant elle et ne la verrait jamais — sans ce garde, l'attente est infinie.
      if (this.processExited) {
        reject(new Error('Le process de l’agent ACP est sorti avant la fin de session.'));
        return;
      }
      const id = this.nextId++;
      this.pending.set(id, { resolve, reject });
      this.send({ id, method, params });
    });
  }

  private failAllPending(reason: string): void {
    for (const [, entry] of this.pending) entry.reject(new Error(reason));
    this.pending.clear();
  }

  // ---------------------------------------------------------------- cycle

  /** initialize → (authenticate sur décision explicite) → session/new. */
  async open(): Promise<void> {
    const { options } = this.spec;
    const clientCapabilities: Record<string, unknown> = {
      fs: { readTextFile: true, writeTextFile: true },
      terminal: options.terminal.enabled,
    };
    // Elicitation annoncée seulement si un humain peut répondre (politique
    // 'ask') — un mode annoncé sans répondant serait une capacité morte.
    if (options.elicitation.form || options.elicitation.url) {
      clientCapabilities.elicitation = {
        ...(options.elicitation.form ? { form: {} } : {}),
        ...(options.elicitation.url ? { url: {} } : {}),
      };
    }
    const init = (await this.request('initialize', {
      protocolVersion: ACP_PROTOCOL_VERSION,
      clientCapabilities,
      clientInfo: { name: 'striart', title: 'Striart', version: STRIART_VERSION },
    })) as { protocolVersion?: number; agentCapabilities?: unknown; authMethods?: unknown };
    if (init?.protocolVersion !== ACP_PROTOCOL_VERSION) {
      throw new Error(
        `Version de protocole incompatible : agent v${init?.protocolVersion}, client v${ACP_PROTOCOL_VERSION}.`,
      );
    }
    this.agentCapabilities =
      init.agentCapabilities && typeof init.agentCapabilities === 'object'
        ? (init.agentCapabilities as Record<string, unknown>)
        : {};
    this.authMethods = parseAuthMethods(init.authMethods);
    this.log.append(`[acp] handshake ok (protocole v${ACP_PROTOCOL_VERSION})\n`);

    let created: { sessionId?: string };
    try {
      created = await this.newSession();
    } catch (error) {
      if (!(error instanceof RpcRequestError) || error.rpcCode !== JSONRPC.AUTH_REQUIRED)
        throw error;
      await this.authenticate();
      created = await this.newSession().catch((retry) => {
        if (retry instanceof RpcRequestError && retry.rpcCode === JSONRPC.AUTH_REQUIRED)
          throw this.authRequiredError();
        throw retry;
      });
    }
    if (typeof created?.sessionId !== 'string' || created.sessionId.length === 0) {
      throw new Error('session/new n’a pas retourné de sessionId.');
    }
    this.sessionId = created.sessionId;
    this.log.append(`[acp] session ${this.sessionId} ouverte\n\n`);
  }

  private newSession(): Promise<{ sessionId?: string }> {
    return this.request('session/new', {
      cwd: path.resolve(this.spec.cwd),
      mcpServers: this.spec.mcpServers,
    }) as Promise<{ sessionId?: string }>;
  }

  private authRequiredError(): AcpSessionError {
    const { profile, profileKey } = this.spec;
    return new AcpSessionError({
      code: 'ACP_AUTH_REQUIRED',
      message: buildAuthRequiredMessage({
        profileKey,
        command: profile.command,
        args: profile.args ?? [],
        methods: this.authMethods,
      }),
    });
  }

  /**
   * L'agent exige une authentification. Jamais automatique : seule une
   * méthode désignée EXPLICITEMENT par la config (`acp.auth.methodId`),
   * annoncée par l'agent et pilotée par le protocole (type 'agent' — une
   * méthode 'terminal' ne se passe jamais à `authenticate`) est tentée.
   */
  private async authenticate(): Promise<void> {
    const methodId = this.spec.options.authMethodId;
    if (!methodId) throw this.authRequiredError();
    const method = this.authMethods.find((m) => m.id === methodId);
    if (!method || !isProtocolAuthMethod(method)) {
      throw new AcpSessionError({
        code: 'ACP_AUTH_METHOD_UNAVAILABLE',
        message: `The configured ACP auth method "${methodId}" is not an advertised protocol method of this agent (terminal methods are never passed to "authenticate"). ${this.authRequiredError().message}`,
      });
    }
    this.log.append(`[acp] authenticate → ${methodId} (décision explicite : acp.auth.methodId)\n`);
    try {
      await this.request('authenticate', { methodId });
    } catch (error) {
      throw new AcpSessionError({
        code: 'ACP_AUTH_REQUIRED',
        message: `Authentication with method "${methodId}" failed: ${(error as Error).message}. ${this.authRequiredError().message}`,
      });
    }
  }

  /** Un tour : session/prompt → stopReason. */
  async prompt(blocks: TextContentBlock[]): Promise<string | null> {
    try {
      const turn = (await this.request('session/prompt', {
        sessionId: this.sessionId,
        prompt: blocks,
      })) as { stopReason?: string; usage?: unknown };
      try {
        this.onTurnResult?.(turn);
      } catch (error) {
        logger.warn({ err: error }, 'Relevé d’usage de tour en échec (ignoré)');
      }
      return turn?.stopReason ?? null;
    } catch (error) {
      if (error instanceof RpcRequestError && error.rpcCode === JSONRPC.AUTH_REQUIRED)
        throw this.authRequiredError();
      throw error;
    }
  }

  /**
   * Annule le TOUR en cours sans fermer la session (`session/cancel` du
   * protocole) — l'agent répond au prompt par `cancelled`, la file continue.
   * Rend false sans session ouverte (rien à annuler à ce niveau).
   */
  cancelTurn(): boolean {
    if (!this.sessionId) return false;
    this.send({ method: 'session/cancel', params: { sessionId: this.sessionId } });
    return true;
  }

  /** Arrêt propre du tour en cours ; sans session ouverte, kill direct. */
  cancel(): void {
    if (this.sessionId)
      this.send({ method: 'session/cancel', params: { sessionId: this.sessionId } });
    else void killProcessTree(this.subprocess);
  }

  kill(): Promise<void> {
    return killProcessTree(this.subprocess);
  }

  /**
   * Fin de session : session/close si l'agent l'annonce (stabilisé le
   * 2026-04-23 — l'agent annule et libère sans qu'on tue le process), puis
   * terminaux libérés, stdin fermé, kill d'arbre si le process s'attarde.
   * Rend le résultat du process (son code de sortie est informatif).
   */
  async shutdown({ graceful }: { graceful: boolean }): Promise<Result> {
    this.humanWaits.abort();
    const sessionCaps = this.agentCapabilities.sessionCapabilities as
      Record<string, unknown> | undefined;
    if (graceful && this.sessionId && sessionCaps?.close != null) {
      const closed = await Promise.race([
        this.request('session/close', { sessionId: this.sessionId }).then(
          () => true,
          () => false,
        ),
        new Promise<boolean>((resolve) =>
          setTimeout(() => resolve(false), CLOSE_TIMEOUT_MS).unref(),
        ),
      ]);
      this.log.append(
        closed ? '[acp] session fermée (session/close)\n' : '[acp] session/close sans réponse\n',
      );
    }
    this.finished = true;
    await this.terminals?.releaseAll();
    try {
      this.subprocess.stdin?.end();
    } catch {
      // stdin déjà fermé (process mort) : rien à faire.
    }
    const exitTimer = setTimeout(() => void killProcessTree(this.subprocess), EXIT_GRACE_MS);
    const result = await this.exited;
    clearTimeout(exitTimer);
    this.failAllPending('Session terminée.');
    return result;
  }

  // ------------------------------------------------------- requêtes entrantes

  private async handleIncomingRequest(message: JsonRpcMessage): Promise<void> {
    const params = message.params ?? {};
    try {
      const result = await this.serve(message.method as string, params);
      this.send({ id: message.id, result: result ?? null });
    } catch (error) {
      if (error instanceof RpcError) {
        this.send({ id: message.id, error: { code: error.rpcCode, message: error.message } });
        return;
      }
      this.send({
        id: message.id,
        error: {
          code: JSONRPC.INTERNAL_ERROR,
          message: error instanceof Error ? error.message : String(error),
        },
      });
    }
  }

  private async serve(method: string, params: Record<string, unknown>): Promise<unknown> {
    switch (method) {
      case 'session/request_permission':
        return this.servePermission(params);
      case 'elicitation/create':
        return this.serveElicitation(params);
      case 'fs/read_text_file':
        return this.serveRead(params);
      case 'fs/write_text_file':
        return this.serveWrite(params);
      case 'terminal/create':
      case 'terminal/output':
      case 'terminal/wait_for_exit':
      case 'terminal/kill':
      case 'terminal/release':
        return this.serveTerminal(method, params);
      default:
        throw new RpcError(JSONRPC.METHOD_NOT_FOUND, `Méthode non supportée : ${method}`);
    }
  }

  private async servePermission(params: Record<string, unknown>) {
    const { options, root, agent, taskId } = this.spec;
    const toolCall = params.toolCall as { title?: string; toolCallId?: unknown } | undefined;
    const choices = (Array.isArray(params.options) ? params.options : []) as PermissionOption[];
    const title = typeof toolCall?.title === 'string' ? toolCall.title : '(action)';

    // Politique 'ask' (semi-autonome) : arbitrage humain via la boîte aux
    // lettres disque. Sans réponse dans le délai : FAIL CLOSED (reject).
    if (options.permissions === 'ask') {
      const requestFile = await createPermissionRequest(root, {
        agent,
        taskId,
        title,
        options: choices,
        timeoutMs: options.askTimeoutMs,
        toolCallId: typeof toolCall?.toolCallId === 'string' ? toolCall.toolCallId : null,
      });
      this.log.append(
        `\n[permission] ${title} → en attente d'arbitrage humain (dashboard, ${Math.round(options.askTimeoutMs / 1000)}s max)\n`,
      );
      const optionId = await awaitPermissionAnswer(root, requestFile.id, options.askTimeoutMs, {
        signal: this.humanWaits.signal,
      });
      const chosen = optionId ? (choices.find((o) => o.optionId === optionId) ?? null) : null;
      if (chosen) {
        this.log.append(`[permission] ${title} → ${chosen.kind ?? chosen.optionId} (humain)\n`);
        return { outcome: { outcome: 'selected', optionId: chosen.optionId } };
      }
      const fallback = selectPermissionOption(choices, 'reject');
      if (fallback) {
        this.log.append(
          `[permission] ${title} → ${fallback.kind ?? fallback.optionId} (délai d'arbitrage dépassé, fail closed)\n`,
        );
        return { outcome: { outcome: 'selected', optionId: fallback.optionId } };
      }
      this.log.append(`[permission] ${title} → annulée (délai dépassé, aucune option de refus)\n`);
      return { outcome: { outcome: 'cancelled' } };
    }

    const selected = selectPermissionOption(choices, options.permissions);
    if (selected) {
      this.log.append(
        `\n[permission] ${title} → ${selected.kind ?? selected.optionId} (politique ${options.permissions})\n`,
      );
      return { outcome: { outcome: 'selected', optionId: selected.optionId } };
    }
    this.log.append(`\n[permission] ${title} → annulée (aucune option applicable)\n`);
    return { outcome: { outcome: 'cancelled' } };
  }

  /**
   * Question structurée de l'agent : routée vers l'humain (même boîte aux
   * lettres que les permissions), réponse validée contre le schéma demandé.
   * Mode non annoncé → « invalid params » (protocole). Sans réponse dans le
   * délai d'arbitrage : FAIL CLOSED — `cancel`, jamais une réponse inventée.
   */
  private async serveElicitation(params: Record<string, unknown>) {
    const { options, root, agent, taskId } = this.spec;
    const mode = params.mode;
    if (!(
      (mode === 'form' && options.elicitation.form) ||
      (mode === 'url' && options.elicitation.url)
    )) {
      throw new RpcError(
        JSONRPC.INVALID_PARAMS,
        `Elicitation mode not supported by this client: ${String(mode)}`,
      );
    }
    const message = typeof params.message === 'string' ? params.message : '';
    let request;
    try {
      request = await createElicitationRequest(root, {
        agent,
        taskId,
        mode,
        message,
        requestedSchema: (params.requestedSchema as Record<string, unknown>) ?? null,
        url: typeof params.url === 'string' ? params.url : null,
        timeoutMs: options.askTimeoutMs,
      });
    } catch (error) {
      this.log.append(
        `\n[elicitation] refusée (schéma ou paramètres invalides) : ${(error as Error).message}\n`,
      );
      throw new RpcError(JSONRPC.INVALID_PARAMS, (error as Error).message);
    }
    this.log.append(
      `\n[elicitation] ${message.slice(0, 200)} → en attente d'une réponse humaine (dashboard, ${Math.round(options.askTimeoutMs / 1000)}s max)\n`,
    );
    const answer = await awaitElicitationAnswer(root, request.id, options.askTimeoutMs, {
      signal: this.humanWaits.signal,
    });
    if (!answer) {
      this.log.append('[elicitation] → cancel (délai de réponse dépassé, fail closed)\n');
      return { action: 'cancel' };
    }
    this.log.append(`[elicitation] → ${answer.action} (humain)\n`);
    return answer.action === 'accept' && answer.content
      ? { action: 'accept', content: answer.content }
      : { action: answer.action };
  }

  private async serveRead(params: Record<string, unknown>) {
    const filePath = params.path as string;
    const target = await resolvePathInsideClone(this.spec.cwd, filePath);
    if (!target) {
      this.log.append(`\n[fs] lecture REFUSÉE (hors clone) : ${String(filePath)}\n`);
      throw new RpcError(
        JSONRPC.INVALID_PARAMS,
        `Chemin hors du clone refusé : ${String(filePath)}`,
      );
    }
    // Plafond de lecture : un fichier géant (ou un flux spécial) servi en entier
    // saturerait la mémoire de l'orchestrateur ; refus explicite, jamais tronqué.
    const info = await stat(target);
    const maxBytes = this.spec.options.fsReadMaxBytes;
    if (!info.isFile() || info.size > maxBytes) {
      this.log.append(
        `\n[fs] lecture REFUSÉE (pas un fichier ordinaire, ou > ${maxBytes} octets) : ${String(filePath)}\n`,
      );
      throw new RpcError(
        JSONRPC.INVALID_PARAMS,
        `File is not a regular file or exceeds the read limit (${maxBytes} bytes): ${String(filePath)}`,
      );
    }
    let content = await readFile(target, 'utf8');
    const line = params.line as number | undefined;
    const limit = params.limit as number | undefined;
    if (Number.isInteger(line) || Number.isInteger(limit)) {
      const lines = content.split('\n');
      const start = Number.isInteger(line) ? Math.max(0, (line as number) - 1) : 0;
      const count = Number.isInteger(limit) ? (limit as number) : lines.length;
      content = lines.slice(start, start + count).join('\n');
    }
    return { content };
  }

  private async serveWrite(params: Record<string, unknown>) {
    const filePath = params.path as string;
    const target = await resolveWritablePathInsideClone(this.spec.cwd, filePath);
    if (!target) {
      this.log.append(`\n[fs] écriture REFUSÉE (hors clone ou dans .git) : ${String(filePath)}\n`);
      throw new RpcError(
        JSONRPC.INVALID_PARAMS,
        `Chemin hors du clone, ou dans .git, refusé en écriture : ${String(filePath)}`,
      );
    }
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, String(params.content ?? ''), 'utf8');
    return null;
  }

  private async serveTerminal(method: string, params: Record<string, unknown>) {
    if (!this.terminals) {
      throw new RpcError(
        JSONRPC.METHOD_NOT_FOUND,
        'The terminal capability is disabled for this profile.',
      );
    }
    switch (method) {
      case 'terminal/create':
        return this.terminals.create(params);
      case 'terminal/output':
        return this.terminals.output(params);
      case 'terminal/wait_for_exit':
        return this.terminals.waitForExit(params);
      case 'terminal/kill':
        return this.terminals.kill(params);
      default:
        return this.terminals.release(params);
    }
  }
}

export interface DriveHooks {
  /** PID de l'agent, au plus tôt (mode en process : publié au registre). */
  onAgentSpawn?: (pid: number | undefined) => void | Promise<void>;
  /** Début d'un tour (observabilité de l'hôte). `tag` : étiquette du prompt (PromptQueue.enqueue). */
  onTurnStart?: (turn: number, source: 'initial' | 'bus', tag: string | null) => void;
  /** Fin d'un tour, avec son `stopReason` (relais du proxy `striart acp`, lot I10). */
  onTurnEnd?: (turn: number, stopReason: string | null, tag: string | null) => void;
  /** Chaque `session/update` de l'agent, tel quel (donnée non fiable). */
  onUpdate?: (update: Record<string, unknown>) => void;
  /**
   * Commandes de session exposées au superviseur : annulation du SEUL tour
   * en cours (`session/cancel`), la session continuant ensuite.
   */
  onControl?: (control: { cancelTurn: () => boolean }) => void;
}

export interface DriveControl {
  /** Arrêt demandé (Ctrl+C, propriétaire disparu, arrêt de l'hôte) → CANCELLED. */
  signal: AbortSignal;
  timeoutMs: number;
}

/**
 * Déroule une session complète : ouverture, tours successifs tirés de la
 * file, fermeture. Même contrat que `runAgentSession` : ne throw JAMAIS pour
 * un échec de l'agent — rapporte, l'orchestrateur décide.
 *
 * Issue (`stopReason` du protocole, pas le code de sortie de l'adaptateur) :
 * annulation → CANCELLED ; délai (ou tour annulé sans demande) → TIMEOUT ;
 * DERNIER tour en `end_turn` → COMPLETED (le dernier message humain est la
 * dernière consigne : c'est à elle que l'agent a répondu) ; sinon FAILED.
 */
export async function driveAcpSession(
  spec: AcpSessionSpec,
  queue: PromptQueue,
  control: DriveControl,
  log: SessionLog,
  hooks: DriveHooks = {},
): Promise<SessionResult> {
  const startedAt = Date.now();
  const { profile, agent, cwd } = spec;
  const commandLine = `${profile.command} ${(profile.args ?? []).join(' ')}`.trim();
  logger.info(
    { agent, command: commandLine, cwd, timeoutMs: control.timeoutMs },
    'Session ACP démarrée',
  );

  const relaxed = acpRelaxedProtections(spec.options);
  if (relaxed.length > 0) {
    log.append(`[acp] protections relâchées par la config : ${relaxed.join(', ')}\n`);
    logger.warn({ agent, relaxed }, 'Session ACP : protections relâchées par la config du profil');
  }
  const connection = new AcpConnection(spec, log);
  // Lot T : relevé d'usage (usage_update, usage de tour) et arrêt sur budget.
  let budgetStopped = false;
  let meter: SessionMeter | null = null;
  try {
    meter = await SessionMeter.open({
      root: spec.root,
      agent,
      taskId: spec.taskId,
      config: (await loadConfig(spec.root)) as StriartConfig,
      format: 'acp',
      onBreach: () => {
        if (timedOut || cancelled) return;
        budgetStopped = true;
        interrupt();
      },
    });
  } catch (error) {
    logger.warn(
      { err: error, agent },
      'Session ACP : comptabilité indisponible (session non relevée)',
    );
  }
  const forwardUpdate = hooks.onUpdate;
  connection.onUpdate = (update) => {
    meter?.feedAcpUpdate(update);
    forwardUpdate?.(update);
  };
  connection.onTurnResult = (turn) => meter?.feedAcpTurn(turn);
  // Annulation de tour demandée par le superviseur : retenue pour qualifier
  // l'issue (un dernier tour annulé par l'humain n'est ni un délai ni un succès).
  let turnCancelRequested = false;
  hooks.onControl?.({
    cancelTurn: () => {
      const sent = connection.cancelTurn();
      if (sent) turnCancelRequested = true;
      return sent;
    },
  });
  if (hooks.onAgentSpawn) {
    try {
      await hooks.onAgentSpawn(connection.pid);
    } catch (error) {
      logger.warn({ err: error, agent }, 'Publication du PID de session impossible');
    }
  }

  let timedOut = false;
  let cancelled = false;
  let interrupting = false;
  const interrupt = () => {
    if (interrupting) return;
    interrupting = true;
    queue.close();
    connection.cancel();
    setTimeout(() => void connection.kill(), CANCEL_GRACE_MS).unref();
  };
  const timer = setTimeout(() => {
    if (cancelled) return;
    timedOut = true;
    interrupt();
  }, control.timeoutMs);
  const onAbort = () => {
    if (timedOut || cancelled) return;
    cancelled = true;
    interrupt();
  };
  if (control.signal.aborted) onAbort();
  else control.signal.addEventListener('abort', onAbort, { once: true });

  let status: SessionResult['status'];
  let stopReason: string | null = null;
  let errorMessage: string | null = null;
  let errorCode: string | null = null;
  let turns = 0;

  try {
    await connection.open();
    for (;;) {
      const item = await queue.next();
      if (!item || cancelled || timedOut) break;
      turns += 1;
      turnCancelRequested = false;
      hooks.onTurnStart?.(turns, item.source, item.tag);
      if (turns > 1) {
        log.append(
          `\n[acp] tour #${turns} (${item.source === 'bus' ? 'message humain du bus @agent' : 'prompt'})\n`,
        );
      }
      stopReason = await connection.prompt(item.blocks);
      log.append(`\n[acp] tour #${turns} terminé : ${stopReason ?? '(stopReason absent)'}\n`);
      hooks.onTurnEnd?.(turns, stopReason, item.tag);
      if (cancelled || timedOut) break;
    }
    if (cancelled) {
      status = 'CANCELLED';
    } else if (stopReason === 'cancelled' && turnCancelRequested) {
      // Dernier tour annulé à la demande du superviseur (humain) : la
      // consigne finale n'a pas abouti — jamais un vert, ni un « délai ».
      status = 'CANCELLED';
      errorMessage = 'The last turn was cancelled on request before the session closed.';
    } else if (!budgetStopped && (timedOut || stopReason === 'cancelled')) {
      status = 'TIMEOUT';
      timedOut = true;
    } else if (stopReason === 'end_turn') {
      status = 'COMPLETED';
    } else {
      // refusal, max_tokens, max_turn_requests, ou stopReason absent : la
      // session n'a pas abouti — au ticket de le dire, pas à un faux vert.
      status = 'FAILED';
      errorMessage = `Session ACP terminée sans succès : stopReason=${stopReason ?? '(absent)'}.`;
    }
  } catch (error) {
    status = cancelled ? 'CANCELLED' : timedOut ? 'TIMEOUT' : 'FAILED';
    errorMessage = error instanceof Error ? error.message : String(error);
    if (error instanceof AcpSessionError) errorCode = error.code;
    log.append(`\n[acp] erreur${errorCode ? ` ${errorCode}` : ''} : ${errorMessage}\n`);
  } finally {
    clearTimeout(timer);
    control.signal.removeEventListener('abort', onAbort);
    queue.close();
  }

  const result = await connection.shutdown({ graceful: !interrupting });
  const durationMs = Date.now() - startedAt;
  if (cancelled) {
    log.append('\n[Striart] Session interrompue : arrêt demandé.');
    status = 'CANCELLED';
  } else if (timedOut) {
    log.append(`\n[Striart] Session interrompue : délai de ${control.timeoutMs}ms dépassé.`);
    status = 'TIMEOUT';
  } else if (budgetStopped) {
    log.append(
      `\n[Striart] Session interrompue : budget de tokens dépassé (${meter?.breach?.scope}, ${meter?.breach?.metric}).`,
    );
    status = 'BUDGET_EXCEEDED';
    errorMessage = `Token budget exceeded (${meter?.breach?.scope}, ${meter?.breach?.metric}): session stopped, clone kept. Raise tokens.budgets or review the work before merging.`;
  }
  const usage = meter ? await meter.close() : undefined;
  // « Adaptateur introuvable / mort avant handshake » : le détail utile est
  // le message du spawn, pas l'erreur de requête orpheline.
  if (status === 'FAILED' && !errorCode && result.failed && result.shortMessage) {
    errorMessage = result.shortMessage;
  }
  await log.flush();

  const exitCode = normalizeExitCode(result.exitCode ?? null);
  logger.info({ agent, status, stopReason, durationMs, exitCode, turns }, 'Session ACP terminée');
  return {
    status,
    agent,
    exitCode,
    durationMs,
    timedOut,
    logPath: log.path,
    command: commandLine,
    stopReason,
    turns,
    errorCode:
      status === 'COMPLETED'
        ? null
        : status === 'BUDGET_EXCEEDED'
          ? 'TOKEN_BUDGET_EXCEEDED'
          : errorCode,
    error: status === 'COMPLETED' ? null : errorMessage,
    ...(usage ? { usage } : {}),
    ...(budgetStopped && meter?.breach ? { budget: meter.breach } : {}),
  };
}

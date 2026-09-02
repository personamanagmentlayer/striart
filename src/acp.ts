import { execa, type ResultPromise } from 'execa';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';
import { StriartError } from './errors.js';
import { logger } from './logger.js';
import { killProcessTree, normalizeExitCode } from './process-tree.js';
import { awaitPermissionAnswer, createPermissionRequest } from './permissions.ts';
import { sessionLogPath } from './session.js';
import type { AgentProfile, SessionResult } from './types.js';

/**
 * Client ACP (Agent Client Protocol — agentclientprotocol.com) pour le mode
 * autonome : au lieu de traiter l'outil de coding en boîte noire argv
 * (`claude -p "<prompt>"`, code de sortie, log brut), Striart dialogue avec
 * lui en JSON-RPC 2.0 ndjson sur son stdio.
 *
 * Positionnement symétrique du serveur MCP : MCP = l'agent pilote Striart,
 * ACP = Striart pilote l'agent. Même choix d'implémentation que `mcp.js` :
 * le sous-ensemble du protocole utilisé (initialize, session/new,
 * session/prompt, session/update, session/request_permission, fs/*,
 * session/cancel) ne justifie pas un SDK.
 *
 * Trois invariants, hérités du mode autonome argv :
 *  - même contrat de retour `SessionResult` — l'orchestrateur ne distingue
 *    pas le transport ;
 *  - le prompt reste de la DONNÉE : bloc de contenu du protocole, jamais
 *    un argv ni un shell (le placeholder {{prompt}} est interdit dans les
 *    args d'un profil ACP — un seul canal de transmission) ;
 *  - `STRIART_SESSION` est posé en dernier, non surchargeable : la garde de
 *    profondeur MCP ne se désarme pas parce que le transport change.
 *
 * Et un point de contrôle NOUVEAU par rapport au mode argv : les capacités
 * filesystem déclarées au handshake sont servies par Striart et BORNÉES au
 * clone — un chemin hors du clone est refusé en erreur JSON-RPC.
 */

/** Version du protocole parlée par ce client (la v1 stable). */
export const ACP_PROTOCOL_VERSION = 1;

/** Grâce accordée à l'agent pour honorer `session/cancel` avant le kill. */
const CANCEL_GRACE_MS = 3_000;

/** Grâce accordée au process pour sortir seul après la fin du prompt. */
const EXIT_GRACE_MS = 2_000;

/**
 * Borne de parse d'une ligne entrante. L'agent ACP est du code de confiance
 * (SECURITY.md), la borne ne protège que d'un adaptateur emballé — assez
 * large pour un `fs/write_text_file` d'un gros fichier légitime.
 */
const MAX_LINE_CHARS = 16_000_000;

interface AcpOptions {
  permissions: 'allow' | 'reject' | 'ask';
  /** Politique 'ask' : délai d'arbitrage humain avant le fail closed (reject). */
  askTimeoutMs: number;
}

/** Délai d'arbitrage humain par défaut de la politique 'ask'. */
const DEFAULT_ASK_TIMEOUT_MS = 120_000;

interface JsonRpcMessage {
  jsonrpc?: string;
  id?: number | string | null;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { code: number; message: string };
}

interface PermissionOption {
  optionId: string;
  name?: string;
  kind?: string;
}

/**
 * Normalise le champ `acp` d'un profil (`true` ou `{ permissions }`) vers ses
 * options effectives. `allow` par défaut : c'est le niveau de confiance des
 * profils headless existants, tous lancés en `--yes`/`-p` — l'isolation vient
 * du clone et l'autorité du Test Gate, pas de la politique de permission.
 */
export function resolveAcpOptions(profile: AgentProfile): AcpOptions {
  const acp = profile.acp;
  if (acp == null || typeof acp === 'boolean') {
    return { permissions: 'allow', askTimeoutMs: DEFAULT_ASK_TIMEOUT_MS };
  }
  return {
    permissions: acp.permissions ?? 'allow',
    askTimeoutMs: acp.askTimeoutMs ?? DEFAULT_ASK_TIMEOUT_MS,
  };
}

/**
 * Un chemin demandé par l'agent (fs/read, fs/write) est-il DANS le clone ?
 * Refus de tout ce qui en sort — y compris par `..` ou chemin absolu tiers.
 * Même philosophie que `isSafeProjectPath` côté Router : la sortie d'un
 * process externe est un identifiant à contraindre, jamais un chemin libre.
 */
export function isPathInsideClone(cloneRoot: string, candidate: string): boolean {
  if (typeof candidate !== 'string' || candidate.trim().length === 0) return false;
  const resolved = path.resolve(cloneRoot, candidate);
  const relative = path.relative(path.resolve(cloneRoot), resolved);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/**
 * Choisit la réponse à une demande de permission selon la politique du
 * profil. `allow` privilégie l'accord ponctuel (`allow_once`) sur l'accord
 * permanent : la politique re-décide à chaque demande, l'agent n'obtient
 * jamais un blanc-seing qu'un futur mode semi-autonome ne pourrait retirer.
 */
export function selectPermissionOption(
  options: PermissionOption[],
  policy: AcpOptions['permissions'],
): PermissionOption | null {
  if (!Array.isArray(options) || options.length === 0) return null;
  const byKind = (kinds: string[]) =>
    kinds.map((k) => options.find((o) => o.kind === k)).find(Boolean) ?? null;
  if (policy === 'allow') {
    return byKind(['allow_once', 'allow_always']) ?? options[0];
  }
  return byKind(['reject_once', 'reject_always']);
}

/** Extrait le texte des blocs de contenu d'une mise à jour de session. */
function contentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (content && typeof content === 'object' && 'text' in content) {
    const text = (content as { text?: unknown }).text;
    return typeof text === 'string' ? text : '';
  }
  return '';
}

/**
 * Transcrit une notification `session/update` en ligne(s) de log lisibles.
 * C'est le gain d'observabilité du transport : le log raconte le déroulé
 * (messages, plan, appels d'outils), pas seulement la fin de la session.
 */
export function formatSessionUpdate(update: Record<string, unknown>): string | null {
  const kind = update?.sessionUpdate;
  switch (kind) {
    case 'agent_message_chunk':
      return contentText(update.content) || null;
    case 'agent_thought_chunk':
      return null; // Le raisonnement interne n'est pas du déroulé : bruit.
    case 'tool_call': {
      const title = typeof update.title === 'string' ? update.title : '(outil)';
      const status = typeof update.status === 'string' ? update.status : 'pending';
      return `\n[outil] ${title} — ${status}\n`;
    }
    case 'tool_call_update': {
      const status = typeof update.status === 'string' ? update.status : null;
      return status ? `[outil] → ${status}\n` : null;
    }
    case 'plan': {
      const entries = Array.isArray(update.entries) ? update.entries : [];
      const lines = entries
        .map((e) => {
          const entry = e as { content?: unknown; status?: unknown };
          const text = contentText(entry.content) || String(entry.content ?? '');
          return `  - [${entry.status ?? '?'}] ${text}`;
        })
        .join('\n');
      return lines ? `\n[plan]\n${lines}\n` : null;
    }
    default:
      return null; // user_message_chunk, available_commands_update… : écho ou méta.
  }
}

/**
 * Lance une session autonome en transport ACP et la supervise jusqu'à l'issue
 * du prompt ou l'expiration du délai. Même contrat que `runAgentSession`
 * (session.js) : ne throw JAMAIS pour un échec de l'agent — rapporte, et
 * l'orchestrateur décide (conservation du clone, ticket).
 *
 * L'issue est portée par le `stopReason` du protocole, pas par le code de
 * sortie du process (l'adaptateur est un pont, son exit code ne dit rien du
 * travail) : `end_turn` → COMPLETED, tout le reste → FAILED, délai → TIMEOUT.
 */
export async function runAcpSession({
  root,
  agent,
  taskId,
  cwd,
  profile,
  prompt,
  timeoutMs = 1_800_000,
  env = process.env,
  onSpawn = null,
}: {
  root: string;
  agent: string;
  taskId: string;
  cwd: string;
  profile: AgentProfile;
  prompt: string;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  onSpawn?: ((pid: number | undefined) => Promise<void> | void) | null;
}): Promise<SessionResult> {
  const args = profile.args ?? [];
  if (typeof profile.command !== 'string' || profile.command.trim().length === 0) {
    throw new StriartError('Profil invalide : "command" doit être une chaîne non vide.', {
      code: 'PROFILE_INVALID',
      details: { profile },
    });
  }
  // Un seul canal pour le prompt : le protocole. Un placeholder dans l'argv
  // d'un profil ACP signale une config recopiée d'un profil argv — refus
  // explicite plutôt qu'un prompt transmis deux fois par deux canaux.
  if (args.some((a) => a.includes('{{prompt}}'))) {
    throw new StriartError(
      'Profil ACP invalide : {{prompt}} est interdit dans les args — le prompt passe par le protocole.',
      { code: 'PROFILE_INVALID', details: { profile } },
    );
  }
  const options = resolveAcpOptions(profile);
  const logPath = sessionLogPath(root, agent, taskId);
  await mkdir(path.dirname(logPath), { recursive: true });

  const startedAt = Date.now();
  const commandLine = `${profile.command} ${args.join(' ')}`.trim();
  logger.info({ agent, command: commandLine, cwd, timeoutMs }, 'Session ACP démarrée');

  const logChunks: string[] = [`[acp] ${commandLine} (cwd: ${cwd})\n`];
  const appendLog = (text: string | null) => {
    if (text) logChunks.push(text);
  };

  const subprocess: ResultPromise = execa(profile.command, args, {
    cwd,
    shell: false,
    reject: false,
    detached: process.platform !== 'win32',
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
    // Même composition d'environnement que le mode argv (session.js) :
    // STRIART_SESSION en dernier, non surchargeable par un env de profil.
    env: { ...env, ...(profile.env ?? {}), STRIART_SESSION: '1' },
  });

  if (onSpawn) {
    try {
      await onSpawn(subprocess.pid);
    } catch (error) {
      logger.warn({ err: error, agent }, 'Publication du PID de session impossible');
    }
  }

  // stderr = canal de debug de l'adaptateur (comme mcp.js côté serveur) :
  // capturé au log, jamais interprété.
  subprocess.stderr?.on('data', (chunk: Buffer) => appendLog(chunk.toString()));

  let nextId = 1;
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  let sessionId: string | null = null;
  let finished = false;

  const send = (message: JsonRpcMessage) => {
    if (finished || !subprocess.stdin || !subprocess.stdin.writable) return;
    subprocess.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
  };

  const request = (method: string, params: Record<string, unknown>) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      send({ id, method, params });
    });

  const failAllPending = (reason: string) => {
    for (const [, entry] of pending) entry.reject(new Error(reason));
    pending.clear();
  };

  // Requêtes ENTRANTES (agent → client) : permissions et filesystem.
  const handleIncomingRequest = async (message: JsonRpcMessage) => {
    const params = message.params ?? {};
    try {
      switch (message.method) {
        case 'session/request_permission': {
          const toolCall = params.toolCall as { title?: string } | undefined;
          const choices = (params.options ?? []) as PermissionOption[];
          const title = toolCall?.title ?? '(action)';

          // Politique 'ask' (semi-autonome, Phase F) : l'arbitrage est routé
          // vers l'humain via la boîte aux lettres disque que le dashboard
          // affiche. Sans réponse dans le délai : FAIL CLOSED — la politique
          // reject s'applique, jamais un accord par défaut.
          if (options.permissions === 'ask') {
            const requestFile = await createPermissionRequest(root, {
              agent,
              taskId,
              title,
              options: choices,
              timeoutMs: options.askTimeoutMs,
            });
            appendLog(
              `\n[permission] ${title} → en attente d'arbitrage humain (dashboard, ${Math.round(options.askTimeoutMs / 1000)}s max)\n`,
            );
            const optionId = await awaitPermissionAnswer(
              root,
              requestFile.id,
              options.askTimeoutMs,
            );
            const chosen = optionId ? (choices.find((o) => o.optionId === optionId) ?? null) : null;
            const fallback = chosen ?? selectPermissionOption(choices, 'reject');
            if (chosen) {
              appendLog(`[permission] ${title} → ${chosen.kind ?? chosen.optionId} (humain)\n`);
              send({
                id: message.id,
                result: { outcome: { outcome: 'selected', optionId: chosen.optionId } },
              });
            } else if (fallback) {
              appendLog(
                `[permission] ${title} → ${fallback.kind ?? fallback.optionId} (délai d'arbitrage dépassé, fail closed)\n`,
              );
              send({
                id: message.id,
                result: { outcome: { outcome: 'selected', optionId: fallback.optionId } },
              });
            } else {
              appendLog(
                `[permission] ${title} → annulée (délai dépassé, aucune option de refus)\n`,
              );
              send({ id: message.id, result: { outcome: { outcome: 'cancelled' } } });
            }
            return;
          }

          const selected = selectPermissionOption(choices, options.permissions);
          if (selected) {
            appendLog(
              `\n[permission] ${title} → ${selected.kind ?? selected.optionId} (politique ${options.permissions})\n`,
            );
            send({
              id: message.id,
              result: { outcome: { outcome: 'selected', optionId: selected.optionId } },
            });
          } else {
            appendLog(`\n[permission] ${title} → annulée (aucune option applicable)\n`);
            send({ id: message.id, result: { outcome: { outcome: 'cancelled' } } });
          }
          return;
        }
        case 'fs/read_text_file': {
          const filePath = params.path as string;
          if (!isPathInsideClone(cwd, filePath)) {
            send({
              id: message.id,
              error: { code: -32602, message: `Chemin hors du clone refusé : ${filePath}` },
            });
            appendLog(`\n[fs] lecture REFUSÉE (hors clone) : ${filePath}\n`);
            return;
          }
          let content = await readFile(path.resolve(cwd, filePath), 'utf8');
          const line = params.line as number | undefined;
          const limit = params.limit as number | undefined;
          if (Number.isInteger(line) || Number.isInteger(limit)) {
            const lines = content.split('\n');
            const start = Number.isInteger(line) ? Math.max(0, (line as number) - 1) : 0;
            const count = Number.isInteger(limit) ? (limit as number) : lines.length;
            content = lines.slice(start, start + count).join('\n');
          }
          send({ id: message.id, result: { content } });
          return;
        }
        case 'fs/write_text_file': {
          const filePath = params.path as string;
          if (!isPathInsideClone(cwd, filePath)) {
            send({
              id: message.id,
              error: { code: -32602, message: `Chemin hors du clone refusé : ${filePath}` },
            });
            appendLog(`\n[fs] écriture REFUSÉE (hors clone) : ${filePath}\n`);
            return;
          }
          const target = path.resolve(cwd, filePath);
          await mkdir(path.dirname(target), { recursive: true });
          await writeFile(target, String(params.content ?? ''), 'utf8');
          send({ id: message.id, result: null });
          return;
        }
        default:
          send({
            id: message.id,
            error: { code: -32601, message: `Méthode non supportée : ${message.method}` },
          });
      }
    } catch (error) {
      send({
        id: message.id,
        error: { code: -32603, message: error instanceof Error ? error.message : String(error) },
      });
    }
  };

  // Sur un échec de spawn (binaire introuvable), execa peut ne pas fournir de
  // flux : la session échouera par la mort du process (failAllPending), le
  // détail portable étant dans result.shortMessage — comme en mode argv.
  const rl = subprocess.stdout
    ? readline.createInterface({ input: subprocess.stdout, terminal: false })
    : null;
  rl?.on('line', (line) => {
    if (line.length > MAX_LINE_CHARS) {
      appendLog(`\n[acp] ligne de ${line.length} caractères ignorée (borne anti-emballement)\n`);
      return;
    }
    let message: JsonRpcMessage;
    try {
      message = JSON.parse(line);
    } catch {
      // Un adaptateur peut laisser fuiter du texte hors protocole sur stdout :
      // on le journalise sans casser la session.
      appendLog(`${line}\n`);
      return;
    }
    if (message.id != null && (message.result !== undefined || message.error !== undefined)) {
      const entry = pending.get(message.id as number);
      if (entry) {
        pending.delete(message.id as number);
        if (message.error) {
          entry.reject(new Error(`${message.error.message} (code ${message.error.code})`));
        } else {
          entry.resolve(message.result);
        }
      }
      return;
    }
    if (message.method && message.id != null) {
      void handleIncomingRequest(message);
      return;
    }
    if (message.method === 'session/update') {
      appendLog(formatSessionUpdate((message.params?.update ?? {}) as Record<string, unknown>));
    }
    // Autres notifications : ignorées, le protocole les définit comme optionnelles.
  });

  const processExit = subprocess.then((r) => r);
  // Une mort du process avant l'issue du prompt doit faire échouer les
  // requêtes en vol, sinon la session attendrait une réponse qui ne viendra
  // jamais (jusqu'au timeout — un délai entier perdu pour un crash immédiat).
  void processExit.then(() => {
    if (!finished) failAllPending('Le process de l’agent ACP est sorti avant la fin de session.');
  });

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    // Arrêt propre d'abord : l'agent peut finaliser (répondre `cancelled`,
    // arrêter ses sous-process). Le kill d'arbre reste le filet, pas le geste.
    if (sessionId) send({ method: 'session/cancel', params: { sessionId } });
    setTimeout(() => {
      void killProcessTree(subprocess);
    }, CANCEL_GRACE_MS).unref();
  }, timeoutMs);

  let status: SessionResult['status'];
  let stopReason: string | null = null;
  let errorMessage: string | null = null;

  try {
    const init = (await request('initialize', {
      protocolVersion: ACP_PROTOCOL_VERSION,
      clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } },
    })) as { protocolVersion?: number };
    if (init?.protocolVersion !== ACP_PROTOCOL_VERSION) {
      throw new Error(
        `Version de protocole incompatible : agent v${init?.protocolVersion}, client v${ACP_PROTOCOL_VERSION}.`,
      );
    }
    appendLog(`[acp] handshake ok (protocole v${ACP_PROTOCOL_VERSION})\n`);

    const created = (await request('session/new', {
      cwd: path.resolve(cwd),
      mcpServers: [],
    })) as { sessionId?: string };
    if (typeof created?.sessionId !== 'string' || created.sessionId.length === 0) {
      throw new Error('session/new n’a pas retourné de sessionId.');
    }
    sessionId = created.sessionId;
    appendLog(`[acp] session ${sessionId} ouverte\n\n`);

    const turn = (await request('session/prompt', {
      sessionId,
      prompt: [{ type: 'text', text: prompt }],
    })) as { stopReason?: string };
    stopReason = turn?.stopReason ?? null;

    if (timedOut || stopReason === 'cancelled') {
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
    status = timedOut ? 'TIMEOUT' : 'FAILED';
    errorMessage = error instanceof Error ? error.message : String(error);
    appendLog(`\n[acp] erreur : ${errorMessage}\n`);
  } finally {
    finished = true;
    clearTimeout(timer);
    rl?.close();
  }

  // Fin de vie du process : fermer stdin (la plupart des adaptateurs sortent
  // sur EOF), puis kill d'arbre si le process s'attarde. Son code de sortie
  // est informatif — l'issue de la session est déjà décidée par le protocole.
  try {
    subprocess.stdin?.end();
  } catch {
    // stdin déjà fermé (process mort) : rien à faire.
  }
  const exitTimer = setTimeout(() => {
    void killProcessTree(subprocess);
  }, EXIT_GRACE_MS);
  const result = await processExit;
  clearTimeout(exitTimer);

  const durationMs = Date.now() - startedAt;
  if (timedOut) {
    appendLog(`\n[Striart] Session interrompue : délai de ${timeoutMs}ms dépassé.`);
    status = 'TIMEOUT';
  }
  // Cas « adaptateur introuvable / mort avant handshake » : le détail utile
  // est le message du spawn, pas l'erreur de requête orpheline.
  if (status === 'FAILED' && result.failed && result.shortMessage) {
    errorMessage = result.shortMessage;
  }

  await writeFile(logPath, logChunks.join(''), 'utf8').catch((error) => {
    logger.warn({ err: error, logPath }, 'Écriture du log de session impossible');
  });

  const exitCode = normalizeExitCode(result.exitCode ?? null);
  logger.info({ agent, status, stopReason, durationMs, exitCode }, 'Session ACP terminée');

  return {
    status,
    agent,
    exitCode,
    durationMs,
    timedOut,
    logPath,
    command: commandLine,
    stopReason,
    error: status === 'COMPLETED' ? null : errorMessage,
  };
}

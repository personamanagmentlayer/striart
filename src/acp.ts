import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { StriartError } from './errors.js';
import { logger } from './logger.js';
import { loadConfig } from './config.js';
import { sessionLogPath } from './session.js';
import { buildAgentInstructions } from './agents/instructions.ts';
import { resolveAcpOptions } from './acp/protocol.ts';
import type { AcpOptions, McpServerSpec, TextContentBlock } from './acp/protocol.ts';
import { PromptQueue, driveAcpSession } from './acp/session.ts';
import { SessionLog } from './acp/session-log.ts';
import {
  acpHostStatus,
  connectAcpHostOwner,
  launchAcpHost,
  stopAcpHost,
  waitForAcpHostExit,
} from './acp/host.ts';
import type { AgentProfile, SessionResult, StriartConfig } from './types.js';

/**
 * Client ACP (Agent Client Protocol v1 — agentclientprotocol.com) pour le
 * mode autonome : au lieu de traiter l'outil de coding en boîte noire argv
 * (`claude -p "<prompt>"`, code de sortie, log brut), Striart dialogue avec
 * lui en JSON-RPC 2.0 ndjson sur son stdio.
 *
 * Positionnement symétrique du serveur MCP : MCP = l'agent pilote Striart,
 * ACP = Striart pilote l'agent. Le moteur vit dans `src/acp/` :
 *  - `protocol.ts`  : vocabulaire et fonctions pures (options, chemins, permissions) ;
 *  - `session.ts`   : connexion, handshake, authentification, file de prompts ;
 *  - `terminals.ts` : capacité terminal bornée au clone ;
 *  - `host*.ts`     : hôte de session persistant (process détaché adressable).
 *
 * Invariants, hérités du mode autonome argv :
 *  - même contrat de retour `SessionResult` — l'orchestrateur ne distingue
 *    pas le transport ;
 *  - le prompt reste de la DONNÉE : bloc de contenu du protocole, jamais un
 *    argv ni un shell ({{prompt}} est interdit dans les args d'un profil ACP) ;
 *  - `STRIART_SESSION` est posé en dernier, non surchargeable ;
 *  - le verrou principal n'est jamais tenu pendant la session ;
 *  - fs et terminal bornés au clone, fail closed au délai d'arbitrage humain.
 */

export {
  ACP_PROTOCOL_VERSION,
  acpOptionsProblem,
  acpRelaxedProtections,
  formatSessionUpdate,
  isPathInsideClone,
  resolveAcpOptions,
  selectPermissionOption,
} from './acp/protocol.ts';
export type { AcpOptions } from './acp/protocol.ts';

/** Marge du propriétaire au-delà du délai de session (annulation + sortie de l'hôte). */
const OWNER_BACKSTOP_MS = 20_000;

/**
 * Serveurs MCP transmis à l'agent à `session/new` : le serveur MCP de
 * Striart, en LECTURE SEULE et borné au clone de cet agent (`--agent`,
 * `--read-only`, plus `--collab` : poster dans le canal de collaboration, rien d'autre), racine du dépôt principal explicite (`--root` — l'agent le
 * lance depuis le clone, où la racine se résoudrait au clone), garde de
 * profondeur posée (`STRIART_SESSION=1`). Chemins absolus : l'agent ne
 * dépend pas du PATH.
 */
export function striartMcpServers(
  root: string,
  agent: string,
  options: AcpOptions,
  onMain = false,
): McpServerSpec[] {
  if (options.mcp === 'none') return [];
  const cliPath = fileURLToPath(new URL('./cli.js', import.meta.url));
  return [
    {
      name: 'striart',
      command: process.execPath,
      // Session sur le principal : aucun clone à borner (`--agent` serait
      // refusé, l'agent n'est pas au registre) — lecture seule, hors clone.
      args: [
        cliPath,
        'mcp',
        '--root',
        root,
        // `--collab` : l'agent peut POSTER dans le canal de collaboration (au
        // nom de son clone) — le seul outil non lecture qu'il obtient.
        ...(onMain ? ['--read-only'] : ['--agent', agent, '--read-only', '--collab']),
      ],
      env: [{ name: 'STRIART_SESSION', value: '1' }],
    },
  ];
}

/**
 * Premier prompt : consignes Striart EN TÊTE (bloc séparé du prompt de tâche
 * par une ligne vide), puis la tâche. Les consignes ne sont données qu'au
 * premier prompt d'une session — les prompts suivants (bus) les ont déjà.
 */
export async function buildInitialPrompt({
  root,
  agent,
  profileKey,
  profile,
  config,
  prompt,
  onMain = false,
}: {
  root: string;
  agent: string;
  profileKey: string;
  profile: AgentProfile;
  config: StriartConfig;
  prompt: string;
  /** Session sur le repo PRINCIPAL : les consignes décrivent un clone, elles y seraient fausses. */
  onMain?: boolean;
}): Promise<TextContentBlock[]> {
  const instructions = onMain
    ? null
    : await buildAgentInstructions({
        root,
        agent,
        profileKey,
        profile,
        config,
        mode: 'autonomous',
      });
  if (!instructions) return [{ type: 'text', text: prompt }];
  return [
    { type: 'text', text: `${instructions.trimEnd()}\n\n` },
    { type: 'text', text: prompt },
  ];
}

function validateAcpProfile(profile: AgentProfile): void {
  if (typeof profile.command !== 'string' || profile.command.trim().length === 0) {
    throw new StriartError('Profil invalide : "command" doit être une chaîne non vide.', {
      code: 'PROFILE_INVALID',
      hint: 'striart profiles',
      // Jamais le profil lui-même : son env porte des clés d'API.
      details: { reason: 'COMMAND_EMPTY', field: 'command' },
    });
  }
  // Un seul canal pour le prompt : le protocole. Un placeholder dans l'argv
  // d'un profil ACP signale une config recopiée d'un profil argv — refus
  // explicite plutôt qu'un prompt transmis deux fois par deux canaux.
  if ((profile.args ?? []).some((a) => a.includes('{{prompt}}'))) {
    throw new StriartError(
      'Profil ACP invalide : {{prompt}} est interdit dans les args — le prompt passe par le protocole.',
      {
        code: 'PROFILE_INVALID',
        hint: 'striart profiles',
        details: { reason: 'PLACEHOLDER_FORBIDDEN', field: 'args' },
      },
    );
  }
}

/**
 * Lance une session autonome en transport ACP et la supervise jusqu'à son
 * issue. Même contrat que `runAgentSession` (session.js) : ne throw JAMAIS
 * pour un échec de l'agent — rapporte, l'orchestrateur décide. Throw pour
 * une erreur de Striart ou de config (PROFILE_INVALID, ACP_HOST_BUSY).
 *
 * Par défaut (`acp.persistentHost`, vrai), la session vit dans un hôte
 * détaché adressable par le bus `@agent` (Phase E) : `onSpawn` reçoit le
 * PID de l'HÔTE (publié au registre — SESSION_LIVE couvre l'hôte, qui ne
 * sort qu'après l'agent). Sans hôte, la session tourne dans ce process et
 * `onSpawn` reçoit le PID de l'agent, comme en transport argv.
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
  signal = null,
  config = null,
  profileKey = null,
  onMain = undefined,
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
  /** Arrêt demandé par l'appelant (Ctrl+C) : session/cancel, puis kill — statut 'CANCELLED'. */
  signal?: AbortSignal | null;
  /** Config chargée par l'appelant (session.js) ; relue sinon. */
  config?: StriartConfig | null;
  /** Clé du profil dans `agentProfiles` (consignes, messages d'authentification). */
  profileKey?: string | null;
  /** Session sur le repo principal (`run --on-main`) ; absent, déduit de `cwd === root`. */
  onMain?: boolean;
}): Promise<SessionResult> {
  validateAcpProfile(profile);
  const options = resolveAcpOptions(profile);
  const key = profileKey ?? (profile as AgentProfile & { preset?: string }).preset ?? 'custom';
  const effectiveConfig = config ?? ((await loadConfig(root)) as StriartConfig);
  // `onMain` explicite (runMainSession via session.js) l'emporte ; sinon déduit du cwd.
  const isMainSession = onMain ?? path.resolve(cwd) === path.resolve(root);
  const initialPrompt = await buildInitialPrompt({
    root,
    agent,
    profileKey: key,
    profile,
    config: effectiveConfig,
    prompt,
    onMain: isMainSession,
  });
  const mcpServers = striartMcpServers(root, agent, options, isMainSession);
  const abortSignal = signal ?? new AbortController().signal;

  if (!options.persistentHost) {
    const log = new SessionLog(sessionLogPath(root, agent, taskId));
    await log.open(
      `[acp] ${`${profile.command} ${(profile.args ?? []).join(' ')}`.trim()} (cwd: ${cwd})\n`,
    );
    return driveAcpSession(
      { root, agent, taskId, cwd, profile, profileKey: key, options, env, mcpServers },
      new PromptQueue(initialPrompt, { closeWhenIdle: true }),
      { signal: abortSignal, timeoutMs },
      log,
      { onAgentSpawn: onSpawn ?? undefined },
    );
  }
  return runHostedSession({
    root,
    agent,
    taskId,
    cwd,
    profile,
    profileKey: key,
    options,
    env,
    mcpServers,
    initialPrompt,
    timeoutMs,
    signal: abortSignal,
    onSpawn,
  });
}

/** Session portée par l'hôte persistant : ce process en est le PROPRIÉTAIRE. */
async function runHostedSession({
  root,
  agent,
  taskId,
  cwd,
  profile,
  profileKey,
  options,
  env,
  mcpServers,
  initialPrompt,
  timeoutMs,
  signal,
  onSpawn,
}: {
  root: string;
  agent: string;
  taskId: string;
  cwd: string;
  profile: AgentProfile;
  profileKey: string;
  options: AcpOptions;
  env: NodeJS.ProcessEnv;
  mcpServers: McpServerSpec[];
  initialPrompt: TextContentBlock[];
  timeoutMs: number;
  signal: AbortSignal;
  onSpawn: ((pid: number | undefined) => Promise<void> | void) | null;
}): Promise<SessionResult> {
  const startedAt = Date.now();
  const commandLine = `${profile.command} ${(profile.args ?? []).join(' ')}`.trim();
  const launched = await launchAcpHost(root, {
    agent,
    taskId,
    cwd,
    profile,
    profileKey,
    options,
    initialPrompt,
    timeoutMs,
    closeWhenIdle: true,
    ownerPid: process.pid,
    mcpServers,
    env,
  });
  if (onSpawn) {
    try {
      await onSpawn(launched.pid);
    } catch (error) {
      logger.warn({ err: error, agent }, 'Publication du PID de session impossible');
    }
  }

  const failed = (errorCode: string, error: string): SessionResult => ({
    status: signal.aborted ? 'CANCELLED' : 'FAILED',
    agent,
    exitCode: null,
    durationMs: Date.now() - startedAt,
    timedOut: false,
    logPath: launched.logPath,
    command: commandLine,
    stopReason: null,
    turns: 0,
    errorCode,
    error,
  });

  let owner;
  try {
    owner = await connectAcpHostOwner(root, agent, {
      pid: launched.pid,
      ownerToken: launched.ownerToken,
    });
  } catch (error) {
    await stopAcpHost(root, agent).catch(() => null);
    return failed('ACP_HOST_LOST', `ACP session host unreachable: ${(error as Error).message}`);
  }
  const onAbort = () => owner.cancel();
  if (signal.aborted) onAbort();
  else signal.addEventListener('abort', onAbort, { once: true });

  // Filet du propriétaire : l'hôte applique le délai lui-même ; s'il ne rend
  // rien bien au-delà, il est arrêté (demande d'arrêt, puis kill d'arbre).
  let backstop: NodeJS.Timeout | null = null;
  const overdue = new Promise<'overdue'>((resolve) => {
    backstop = setTimeout(() => resolve('overdue'), timeoutMs + OWNER_BACKSTOP_MS);
  });
  try {
    const outcome = await Promise.race([owner.result, overdue]);
    if (outcome === 'overdue') {
      await stopAcpHost(root, agent).catch(() => null);
      return {
        ...failed('ACP_HOST_LOST', 'ACP session host did not report within its deadline: stopped.'),
        status: 'TIMEOUT',
        timedOut: true,
      };
    }
    return outcome;
  } catch (error) {
    await stopAcpHost(root, agent).catch(() => null);
    return failed('ACP_HOST_LOST', (error as Error).message);
  } finally {
    if (backstop) clearTimeout(backstop);
    signal.removeEventListener('abort', onAbort);
    owner.close();
    // Rendre la main seulement hôte sorti : l'appelant dépubliera ensuite la
    // session (SESSION_LIVE) et pourra supprimer le clone. S'il s'attarde,
    // arrêt propre (demande puis kill d'arbre) — jamais un process laissé
    // vivant derrière une session déclarée finie.
    if (!(await waitForAcpHostExit(launched.pid))) await stopAcpHost(root, agent).catch(() => null);
    // L'hôte retire ses fichiers en sortant ; un hôte mort entre-temps
    // laisserait un PID file orphelin — nettoyé ici, jamais un vivant.
    const status = await acpHostStatus(root, agent, { fresh: true }).catch(() => null);
    if (status?.stale) await stopAcpHost(root, agent).catch(() => null);
  }
}

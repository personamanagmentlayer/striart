/**
 * Proxy ACP `striart acp` (lot I10) : Striart vu par l'IDE comme un AGENT
 * ACP v1 (agentclientprotocol.com, vérifié le 2026-10-24 : options de session
 * `configOptions` + `session/set_config_option`, `session/close` stabilisé ;
 * le RFD « proxy chains » — `proxy/initialize`, `proxy/successor` — reste un
 * brouillon non accepté, et relaierait par construction les capacités du
 * client vers l'agent suivant : écarté, Striart est un agent TERMINAL qui
 * pilote lui-même l'agent amont).
 *
 * Trois plans, jamais mélangés : l'IDE (humain) parle ACP à ce proxy ; le
 * proxy pilote l'agent amont par son propre client ACP (I6, dans l'hôte de
 * session, fs/terminal bornés au clone) ; l'agent amont parle à Striart par
 * MCP en lecture seule, borné à son clone. Aucun message de l'agent amont
 * n'atteint l'IDE autrement que comme `session/update` relayé et étiqueté ou
 * comme demande d'arbitrage humain.
 */
import path from 'node:path';
import { assertInitialized, findRepoRoot } from '../clone.js';
import { loadConfig } from '../config.js';
import { StriartError, errorKindOf, publicErrorDetails } from '../errors.js';
import { logger } from '../logger.js';
import type { Messages } from '../cli/i18n/index.ts';
import type { StriartConfig } from '../types.js';
import { ACP_PROTOCOL_VERSION } from '../acp/protocol.ts';
import { AcpAgentRpcError, RPC, RpcPeer } from './rpc.ts';
import { ProxySession, acpProfileChoices } from './session.ts';
import type { FinishReason } from './session.ts';
import { acpAgentRelaxedProtections, resolveAcpAgentSettings } from './settings.ts';

/** Seule méthode d'authentification annoncée : Striart n'a pas de compte (voir registry/acp). */
export const STRIART_AUTH_METHOD_ID = 'striart-local';

export interface ServeAcpAgentOptions {
  input: NodeJS.ReadableStream;
  output: NodeJS.WritableStream;
  /** `--root` : toute session doit se trouver dans ce dépôt. */
  rootOption: string | null;
  /** `--profile` : profil amont proposé par défaut. */
  profileOption: string | null;
  m: Messages;
  version: string;
  signal?: AbortSignal | null;
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

function isInside(base: string, target: string): boolean {
  const relative = path.relative(base, target);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/** Erreur inattendue → erreur JSON-RPC : code Striart stable, aucun détail sensible. */
export function toRpcError(error: unknown): AcpAgentRpcError {
  if (error instanceof AcpAgentRpcError) return error;
  if (error instanceof StriartError) {
    const kind = errorKindOf(error.code);
    return new AcpAgentRpcError(
      kind === 'usage' ? RPC.INVALID_PARAMS : RPC.INTERNAL_ERROR,
      error.message,
      {
        code: error.code,
        ...(error.hint ? { hint: error.hint } : {}),
        details: publicErrorDetails(error.details ?? {}),
      },
    );
  }
  logger.error({ err: error }, 'striart acp : erreur inattendue');
  return new AcpAgentRpcError(
    RPC.INTERNAL_ERROR,
    'Internal Striart error (see the Striart log on stderr).',
    {
      code: 'UNEXPECTED',
    },
  );
}

export async function serveAcpAgent(options: ServeAcpAgentOptions): Promise<{ sessions: number }> {
  const { m, version } = options;
  const sessions = new Map<string, ProxySession>();
  let initialized = false;
  let clientCapabilities: Record<string, unknown> = {};
  let created = 0;

  const sessionOf = (params: Record<string, unknown>): ProxySession => {
    const id = params.sessionId;
    const session = typeof id === 'string' ? sessions.get(id) : undefined;
    if (!session) {
      throw new AcpAgentRpcError(RPC.RESOURCE_NOT_FOUND, `Unknown session: ${String(id)}`, {
        code: 'ACP_PROXY_SESSION_UNKNOWN',
      });
    }
    return session;
  };

  const newSession = async (params: Record<string, unknown>) => {
    const cwd = params.cwd;
    if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) {
      throw new AcpAgentRpcError(RPC.INVALID_PARAMS, 'session/new requires an absolute "cwd".', {
        code: 'INVALID_ARGUMENT',
        option: 'cwd',
      });
    }
    let root: string;
    if (options.rootOption) {
      root = path.resolve(options.rootOption);
      if (!isInside(root, path.resolve(cwd))) {
        throw new AcpAgentRpcError(
          RPC.INVALID_PARAMS,
          'The session directory is outside the repository this "striart acp" serves (--root).',
          { code: 'ACP_PROXY_CWD_OUTSIDE_ROOT' },
        );
      }
    } else {
      root = await findRepoRoot(cwd);
    }
    await assertInitialized(root);
    const config = (await loadConfig(root)) as StriartConfig;
    const settings = resolveAcpAgentSettings(config.acpAgent);
    const choices = acpProfileChoices(config, settings);
    if (choices.length === 0) {
      throw new StriartError(
        'No ACP agent profile is configured: declare one (acp: true), e.g. agentProfiles: { claude: { preset: "claude-acp" } }.',
        { code: 'ACP_PROXY_NO_PROFILE', hint: 'striart profiles --detect' },
      );
    }
    const profileKey = options.profileOption ?? settings.defaultProfile ?? choices[0];
    if (!choices.includes(profileKey)) {
      throw new StriartError(`Profile "${profileKey}" is not an available ACP agent profile.`, {
        code: 'ACP_PROXY_PROFILE_UNAVAILABLE',
        hint: 'striart profiles',
        details: { profile: profileKey },
      });
    }
    const relaxed = acpAgentRelaxedProtections(settings);
    if (relaxed.length > 0) {
      logger.warn({ relaxed }, 'striart acp : protections relâchées par la config acpAgent');
    }
    const ideMcpServers = Array.isArray(params.mcpServers) ? params.mcpServers.length : 0;
    if (ideMcpServers > 0) {
      logger.info(
        { count: ideMcpServers },
        'striart acp : serveurs MCP de l’IDE non transmis (worktree principal)',
      );
    }
    const session = new ProxySession({
      root,
      config,
      settings,
      peer,
      m,
      clientCapabilities,
      profileChoices: choices,
      profileKey,
      ideMcpServers,
    });
    sessions.set(session.id, session);
    created += 1;
    // Annoncées après la réponse : le client connaît alors le sessionId.
    setImmediate(() => {
      if (!session.isEnded) session.announceCommands();
    });
    return {
      sessionId: session.id,
      configOptions: session.configOptions(),
      modes: session.modes(),
    };
  };

  const onRequest = async (method: string, params: Record<string, unknown>): Promise<unknown> => {
    if (method === 'initialize') {
      initialized = true;
      clientCapabilities = isPlainObject(params.clientCapabilities)
        ? params.clientCapabilities
        : {};
      return {
        protocolVersion: ACP_PROTOCOL_VERSION,
        agentCapabilities: {
          loadSession: false,
          promptCapabilities: { image: false, audio: false, embeddedContext: true },
          mcpCapabilities: { http: false, sse: false },
          sessionCapabilities: { close: {} },
        },
        agentInfo: { name: 'striart', title: 'Striart', version },
        authMethods: [
          {
            id: STRIART_AUTH_METHOD_ID,
            name: 'Local (no account)',
            description:
              'Striart runs locally and needs no account; upstream agents sign in with their own CLI.',
            type: 'agent',
          },
        ],
      };
    }
    if (!initialized) {
      throw new AcpAgentRpcError(RPC.INVALID_REQUEST, 'Call "initialize" first.', {
        code: 'ACP_PROXY_NOT_INITIALIZED',
      });
    }
    switch (method) {
      case 'authenticate':
        if (params.methodId !== STRIART_AUTH_METHOD_ID) {
          throw new AcpAgentRpcError(
            RPC.INVALID_PARAMS,
            `Unknown authentication method: ${String(params.methodId)}`,
            {
              code: 'ACP_PROXY_AUTH_METHOD_UNKNOWN',
            },
          );
        }
        return {};
      case 'session/new':
        return newSession(params);
      case 'session/set_config_option':
        return { configOptions: sessionOf(params).setConfigOption(params.configId, params.value) };
      case 'session/set_mode':
        sessionOf(params).setConfigOption('permissions', params.modeId);
        return {};
      case 'session/prompt':
        return sessionOf(params).prompt(params);
      case 'session/close': {
        const session = sessionOf(params);
        await session.finish('close');
        sessions.delete(session.id);
        return {};
      }
      default:
        // fs/*, terminal/* et toute méthode client→agent inconnue : Striart ne
        // sert ni ne relaie AUCUNE capacité de fichier ou de terminal.
        throw new AcpAgentRpcError(
          RPC.METHOD_NOT_FOUND,
          `Method not supported by Striart: ${method}`,
          {
            code: 'ACP_PROXY_METHOD_UNSUPPORTED',
          },
        );
    }
  };

  const onNotification = (method: string, params: Record<string, unknown>) => {
    if (method !== 'session/cancel') return;
    const id = params.sessionId;
    if (typeof id === 'string') sessions.get(id)?.cancel();
  };

  const peer: RpcPeer = new RpcPeer({
    input: options.input,
    output: options.output,
    onRequest,
    onNotification,
    mapError: toRpcError,
  });

  const finishAll = async (reason: FinishReason) => {
    await Promise.allSettled(
      [...sessions.values()].filter((s) => !s.isEnded).map((s) => s.finish(reason)),
    );
  };

  const signal = options.signal ?? null;
  const interrupted = new Promise<'interrupted'>((resolve) => {
    if (!signal) return;
    if (signal.aborted) resolve('interrupted');
    else signal.addEventListener('abort', () => resolve('interrupted'), { once: true });
  });
  const served = peer.serve().then(() => 'eof' as const);
  const first = await Promise.race([served, interrupted]);
  // Fin du flux (IDE fermé) ou arrêt demandé : chaque session encore vivante
  // est close proprement — le merge en vol se termine, jamais coupé.
  await finishAll(first === 'eof' ? 'disconnect' : 'interrupted');
  return { sessions: created };
}

import { sanitize } from '../cli/text.ts';
import type { StriartConfig } from '../types.js';
import { canonicalEvent, getAdapter, neutralOutput } from './adapters.ts';
import type { HookAdapter, HookKind } from './adapters.ts';
import { findCollisions, resolveHookAgent, toCloneRelative } from './advisory.ts';
import type { FileCollision, HookAgentContext } from './advisory.ts';
import { resolveHookSettings } from './config.ts';
import { readBoundedInput, parseHookPayload } from './stdin.ts';
import type { InputFailure } from './stdin.ts';

/**
 * Exécution d'un hook advisory : `striart hook <outil> <événement>`.
 *
 * Contrat NON NÉGOCIABLE : cette fonction ne lève jamais et ne bloque
 * jamais l'outil. Toute anomalie (outil inconnu, entrée trop longue, JSON
 * invalide, registre illisible, hors clone) donne la sortie NEUTRE de
 * l'outil plus un avertissement (stderr). La CLI sort toujours en 0 : pour
 * Claude Code, Codex et Gemini CLI, un code 2 BLOQUERAIT l'action ; pour
 * Copilot CLI, tout code non nul sur preToolUse vaut un refus.
 *
 * Confiance dans la config : un hook installé pour l'UTILISATEUR tourne dans
 * n'importe quel projet ; il ne lit donc que la config DONNÉES du dépôt
 * (`.striartrc.json`, YAML, package.json) et n'exécute JAMAIS une config
 * code (`striart.config.mjs`) — le dépôt pourrait être hostile. Installé
 * dans un CLONE, il reçoit `--root <racine>` choisie par l'utilisateur au
 * moment de l'installation : la config complète de cette racine est chargée.
 * Même effet pour une racine listée dans `hooks.trustedRoots` de la config
 * UTILISATEUR de Striart (src/user-config.ts) — usage journalisé.
 */

export interface HookMessages {
  collision(entries: FileCollision[]): string;
  sessionEnded(agent: string, tool: string, reason: string | null): string;
  warnings: {
    unknownTool(tool: string): string;
    unknownEvent(tool: string, event: string): string;
    noEvent(reason: InputFailure): string;
    invalidPayload: string;
    eventMismatch(expected: string, actual: string): string;
    contextFailed(message: string): string;
    codeConfigUntrusted: string;
    configFailed(message: string): string;
    userConfigFailed(message: string): string;
  };
}

export interface HookRunResult {
  /** Sortie stdout attendue par l'outil ('' : rien). */
  output: string;
  /** Avis communiqué à l'outil, null si rien à signaler. */
  advisory: string | null;
  warnings: string[];
  kind: HookKind | null;
  agent: string | null;
  /** Fin de session notifiée aux webhooks (au moins un canal a accepté). */
  notified: boolean;
  /**
   * Origine de la confiance accordée à une config code du dépôt :
   * 'install' (--root écrit par install --agent), 'user-config'
   * (hooks.trustedRoots), null (config données seulement).
   */
  trustedBy: 'install' | 'user-config' | null;
}

export interface RunHookParams {
  tool: string;
  event: string;
  stdin: NodeJS.ReadableStream & { isTTY?: boolean };
  messages: HookMessages;
  /** Racine choisie à l'installation (hook installé dans un clone), sinon null. */
  trustedRoot?: string | null;
  platform?: NodeJS.Platform;
  cwd?: string;
  readOptions?: { maxBytes?: number; timeoutMs?: number };
  /** Environnement (emplacement de la config utilisateur) — défaut process.env. */
  env?: NodeJS.ProcessEnv;
}

interface ConfigView {
  config: StriartConfig | null;
  warnings: string[];
  trustedBy: HookRunResult['trustedBy'];
}

async function loadHookConfig(
  root: string,
  trustedRoot: boolean,
  messages: HookMessages,
  { platform, env }: { platform: NodeJS.Platform; env: NodeJS.ProcessEnv },
): Promise<ConfigView> {
  const { DEFAULT_CONFIG, findConfigWithoutExecuting, loadConfig, validateConfig } =
    await import('../config.js');
  try {
    if (trustedRoot) return { config: await loadConfig(root), warnings: [], trustedBy: 'install' };
    const found = await findConfigWithoutExecuting(root);
    if (found.kind === 'none') {
      return { config: { ...DEFAULT_CONFIG } as StriartConfig, warnings: [], trustedBy: null };
    }
    if (found.kind === 'code') return codeConfig(root, found.filepath);
    validateConfig(found.config);
    return {
      config: { ...DEFAULT_CONFIG, ...found.config, configPath: found.filepath } as StriartConfig,
      warnings: [],
      trustedBy: null,
    };
  } catch (error) {
    return {
      config: null,
      warnings: [messages.warnings.configFailed(errorMessage(error))],
      trustedBy: null,
    };
  }

  /** Config code : chargée seulement pour une racine de confiance de la config utilisateur. */
  async function codeConfig(repoRoot: string, filepath: string): Promise<ConfigView> {
    const { isTrustedRoot, readUserConfig, userConfigPath } = await import('../user-config.ts');
    let trusted = false;
    try {
      const user = await readUserConfig({ platform, env });
      trusted = await isTrustedRoot(repoRoot, user.hooks.trustedRoots, platform);
    } catch (error) {
      return {
        config: null,
        warnings: [
          messages.warnings.userConfigFailed(errorMessage(error)),
          messages.warnings.codeConfigUntrusted,
        ],
        trustedBy: null,
      };
    }
    if (!trusted)
      return { config: null, warnings: [messages.warnings.codeConfigUntrusted], trustedBy: null };
    const { logger } = await import('../logger.js');
    // Relâchement explicite décidé par l'utilisateur : toujours journalisé.
    logger.info(
      { root: repoRoot, configPath: filepath, userConfig: userConfigPath({ platform, env }) },
      'hook : racine de confiance (hooks.trustedRoots de la config utilisateur) — config code du dépôt chargée',
    );
    return { config: await loadConfig(repoRoot), warnings: [], trustedBy: 'user-config' };
  }
}

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));

export async function runHook(params: RunHookParams): Promise<HookRunResult> {
  const warnings: string[] = [];
  const result = (
    adapter: HookAdapter | null,
    event: string | null,
    extra: Partial<HookRunResult> = {},
  ): HookRunResult => ({
    output: neutralOutput(adapter, event),
    advisory: null,
    warnings,
    kind: null,
    agent: null,
    notified: false,
    trustedBy: null,
    ...extra,
  });
  try {
    return await runHookUnsafe(params, warnings, result);
  } catch (error) {
    // Filet ultime : une erreur imprévue ne doit JAMAIS bloquer l'outil.
    warnings.push(params.messages.warnings.contextFailed(errorMessage(error)));
    return result(getAdapter(params.tool), params.event);
  }
}

async function runHookUnsafe(
  {
    tool,
    event,
    stdin,
    messages,
    trustedRoot = null,
    platform = process.platform,
    cwd,
    readOptions,
    env = process.env,
  }: RunHookParams,
  warnings: string[],
  result: (
    adapter: HookAdapter | null,
    event: string | null,
    extra?: Partial<HookRunResult>,
  ) => HookRunResult,
): Promise<HookRunResult> {
  const adapter = getAdapter(tool);
  if (!adapter) {
    warnings.push(messages.warnings.unknownTool(sanitize(String(tool))));
    return result(null, null);
  }
  const canonical = canonicalEvent(adapter, event);
  if (!canonical) {
    warnings.push(messages.warnings.unknownEvent(tool, sanitize(String(event))));
    return result(adapter, null);
  }
  const kind = adapter.events[canonical];
  const neutral = (extra: Partial<HookRunResult> = {}) =>
    result(adapter, canonical, { kind, ...extra });

  const input = await readBoundedInput(stdin, readOptions);
  if (!input.ok) {
    warnings.push(messages.warnings.noEvent((input as { reason: InputFailure }).reason));
    return neutral();
  }
  const payload = parseHookPayload(input.text);
  if (!payload) {
    warnings.push(messages.warnings.invalidPayload);
    return neutral();
  }
  const parsed = adapter.parse(payload);
  const declared = parsed.eventName ? canonicalEvent(adapter, parsed.eventName) : null;
  if (parsed.eventName && declared && declared !== canonical) {
    warnings.push(messages.warnings.eventMismatch(canonical, sanitize(parsed.eventName)));
    return neutral();
  }

  const baseDir = parsed.cwd ?? cwd ?? process.cwd();
  let context: HookAgentContext | null;
  try {
    context = await resolveHookAgent(baseDir, { trustedRoot, platform });
  } catch (error) {
    warnings.push(messages.warnings.contextFailed(errorMessage(error)));
    return neutral();
  }
  // Hors d'un clone Striart (hook utilisateur dans un projet quelconque) : rien à dire.
  if (!context) return neutral();
  const agent = context.agent;

  if (kind === 'session-end') return sessionEnd(context, tool, parsed.reason);

  const files = parsed.files
    .map((f) => toCloneRelative(f, baseDir, context.clonePath, platform))
    .filter((f): f is string => f !== null);
  let collisions: FileCollision[];
  try {
    collisions = await findCollisions(context, files, platform);
  } catch (error) {
    warnings.push(messages.warnings.contextFailed(errorMessage(error)));
    return neutral({ agent });
  }
  if (collisions.length === 0) return neutral({ agent });
  // Config lue seulement s'il y a quelque chose à dire (chemin de chaque écriture).
  const view = await loadHookConfig(context.root, trustedRoot !== null, messages, {
    platform,
    env,
  });
  warnings.push(...view.warnings);
  if (!resolveHookSettings(view.config?.hooks).collisions) {
    return neutral({ agent, trustedBy: view.trustedBy });
  }
  const message = sanitize(
    messages.collision(collisions.map((c) => ({ file: sanitize(c.file), agents: c.agents }))),
  );
  return result(adapter, canonical, {
    output: adapter.render(canonical, kind, message),
    advisory: message,
    kind,
    agent,
    trustedBy: view.trustedBy,
  });

  async function sessionEnd(ctx: HookAgentContext, toolName: string, reason: string | null) {
    // Agent autonome : sa fin de cycle (merge, gate, nettoyage) appartient à l'orchestrateur.
    if (ctx.meta.mode === 'autonomous') return neutral({ agent: ctx.agent });
    const view = await loadHookConfig(ctx.root, trustedRoot !== null, messages, { platform, env });
    warnings.push(...view.warnings);
    if (!view.config || !resolveHookSettings(view.config.hooks).notifySessionEnd) {
      return neutral({ agent: ctx.agent, trustedBy: view.trustedBy });
    }
    const safeReason = reason ? sanitize(reason).slice(0, 80) : null;
    const message = messages.sessionEnded(ctx.agent, toolName, safeReason);
    const { notify } = await import('../notify.js');
    const { emitStriartEvent } = await import('../events.js');
    // Événement émis SANS message (le pont du bus ne le relaie donc pas) ;
    // la notification part ici, une seule fois, pour en connaître l'issue.
    await emitStriartEvent(view.config, {
      type: 'session:ended',
      agent: ctx.agent,
      tool: toolName,
      reason: safeReason,
    });
    const notified = await notify(view.config, message);
    return neutral({ agent: ctx.agent, notified, trustedBy: view.trustedBy });
  }
}

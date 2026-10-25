import path from 'node:path';
import { StriartError, agentUnknownError } from '../../errors.js';
import type { HookFileChange, HookScope } from '../../hooks/install.ts';
import type { CommandModule, Ctx } from '../context.ts';

/**
 * `striart hook <outil> <événement>` — exécuté PAR l'outil de coding, à
 * chaque événement : lit l'événement sur stdin (borné), répond sur stdout au
 * format de l'outil, et sort TOUJOURS en 0. Advisory : jamais un blocage
 * (pour Claude Code, Codex et Gemini CLI, un code 2 bloquerait l'action).
 * La déclaration commander est volontairement permissive (options et
 * arguments en trop tolérés) : une configuration de hook écrite par une
 * version antérieure ne doit jamais se transformer en erreur d'usage.
 *
 * `striart hook install|uninstall <outil> (--user | --agent <nom>) [--dry-run]`
 * — commande HUMAINE : écrit (ou retire) la configuration de hook de l'outil.
 */

export interface HookInput {
  words: string[];
  user: boolean;
  agent: string | null;
  dryRun: boolean;
  root: string | null;
}

export type HookData =
  | {
      action: 'run';
      tool: string;
      event: string;
      output: string;
      advisory: string | null;
      agent: string | null;
      notified: boolean;
    }
  | {
      action: 'install' | 'uninstall';
      tool: string;
      scope: HookScope;
      agent: string | null;
      dryRun: boolean;
      changes: HookFileChange[];
    };

export const hook: CommandModule<HookInput, HookData> = {
  async execute(ctx, input) {
    const [first = '', second = ''] = input.words;
    if (first === 'install' || first === 'uninstall') return manage(ctx, input, first, second);
    return runtime(ctx, input, first, second);
  },

  render(ctx, { data }) {
    const { out, m } = ctx;
    if (data.action === 'run') {
      // Données brutes au format de l'outil — jamais décorées.
      if (data.output !== '') out.print(data.output);
      return;
    }
    const verb = data.action === 'install' ? m.hook.installed : m.hook.uninstalled;
    out.line(data.dryRun ? 'info' : 'ok', verb(data.tool, data.scope, data.agent, data.dryRun));
    for (const change of data.changes) {
      out.detail(m.hook.change(change.action, out.path(change.path)));
    }
    if (data.action === 'install' && !data.dryRun) out.hint(m.hook.reloadHint(data.tool));
  },
};

async function runtime(ctx: Ctx, input: HookInput, tool: string, event: string) {
  const { runHook } = await import('../../hooks/run.ts');
  // --root n'est retenu qu'absolu : il désigne la racine de CONFIANCE choisie à l'installation.
  const trustedRoot = input.root && path.isAbsolute(input.root) ? input.root : null;
  const result = await runHook({
    tool,
    event,
    stdin: process.stdin,
    messages: ctx.m.hook,
    trustedRoot,
    cwd: ctx.cwd,
  });
  return {
    data: {
      action: 'run' as const,
      tool,
      event,
      output: result.output,
      advisory: result.advisory,
      agent: result.agent,
      notified: result.notified,
    },
    outcome: 'ok' as const,
    warnings: result.warnings.map((message) => ({ code: 'HOOK_ADVISORY_SKIPPED', message })),
  };
}

async function manage(ctx: Ctx, input: HookInput, action: 'install' | 'uninstall', tool: string) {
  if (input.user === (input.agent !== null)) {
    throw new StriartError(ctx.m.hook.scopeRequired, {
      code: 'HOOK_SCOPE_REQUIRED',
      details: {},
      hint: `striart hook ${action} ${tool || 'claude'} --user`,
    });
  }
  const { installHooks, uninstallHooks } = await import('../../hooks/install.ts');
  const scope: HookScope = input.user ? 'user' : 'clone';
  let clone: { root: string; agent: string; clonePath: string } | null = null;
  if (input.agent !== null) {
    const { assertInitialized, readRegistry } = await import('../../clone.js');
    const root = await ctx.repoRoot();
    await assertInitialized(root);
    const registry = await readRegistry(root);
    const meta = Object.hasOwn(registry, input.agent) ? registry[input.agent] : null;
    if (!meta) throw agentUnknownError(input.agent);
    clone = { root, agent: input.agent, clonePath: meta.path };
  }
  const run = action === 'install' ? installHooks : uninstallHooks;
  const changes = await run({ tool, scope, dryRun: input.dryRun, ...(clone ?? {}) });
  return {
    data: {
      action,
      tool,
      scope,
      agent: clone?.agent ?? null,
      dryRun: input.dryRun,
      changes,
    },
    outcome: 'ok' as const,
  };
}

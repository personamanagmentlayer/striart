import { createRequire } from 'node:module';
import { assertHumanPlane } from '../../control/guard.ts';
import type { CommandModule } from '../context.ts';

export interface AcpInput {
  /** `--root` : dépôt servi ; toute session doit s'y trouver. */
  root: string | null;
  /** `--profile` : profil amont proposé par défaut. */
  profile: string | null;
}

/**
 * `striart acp` — Striart exposé comme AGENT ACP v1 sur stdio (lot I10),
 * pour Zed, JetBrains, Neovim (CodeCompanion), Emacs (agent-shell) et les
 * extensions ACP de VS Code. stdout EST le canal du protocole : rien d'autre
 * n'y est écrit (journaux sur stderr). Se termine quand l'éditeur ferme
 * stdin, après avoir clos chaque session (merge en vol jamais interrompu).
 *
 * Plan HUMAIN (l'éditeur arbitre les permissions) : refusé dans une session
 * d'agent Striart, comme `striart api` — un agent ne lance pas son propre
 * arbitre. La racine se résout par session (`cwd` de `session/new`) : un même
 * process sert l'éditeur quel que soit le projet ouvert.
 */
export const acp: CommandModule<AcpInput, { action: 'acp'; sessions: number }> = {
  async execute(ctx, input) {
    assertHumanPlane(process.env, 'striart acp');
    const { version } = createRequire(import.meta.url)('../../../package.json') as {
      version: string;
    };
    const { serveAcpAgent } = await import('../../acp-agent/server.ts');
    const { sessions } = await serveAcpAgent({
      input: process.stdin,
      output: process.stdout,
      rootOption: input.root,
      profileOption: input.profile,
      m: ctx.m,
      version,
      signal: ctx.signal,
    });
    // Arrêt demandé alors que l'éditeur garde stdin ouvert : la lecture
    // pendante retiendrait le process — les sessions sont closes, on la coupe.
    if (ctx.signal.aborted) process.stdin.destroy();
    return { data: { action: 'acp', sessions }, outcome: 'ok' };
  },
};

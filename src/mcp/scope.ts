import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { AGENT_NAME_RE } from '../agent-name.ts';
import { loadConfig } from '../config.js';
import { StriartError } from '../errors.js';
import { findRepoRoot, readRegistry } from '../clone.js';
import { striartDir } from '../paths.js';
import { logger } from '../logger.js';
import { resolveMcpSettings } from './settings.ts';
import type { McpSettings } from '../types.js';

/**
 * QUI appelle le serveur MCP, et donc sur QUOI il peut agir (décision D6).
 *
 * Trois niveaux, du plus étroit au plus large :
 *  - lecture seule : `--read-only`, ou process descendant d'une session
 *    autonome (`STRIART_SESSION=1`, garde de profondeur) — aucun outil mutant ;
 *  - BORNÉ à un agent : le cwd désigne un clone (`.striart/agents/<nom>/`)
 *    ou `--agent <nom>` — les outils mutants n'agissent que sur CET agent
 *    (son merge, ses tickets) ; pas de `striart_run` (engendrer des agents
 *    n'est pas agir sur soi) ;
 *  - ORCHESTRATEUR : hors clone ET `mcp.scope: 'orchestrator'` explicite
 *    en config — run/merge/résolution sur tout le dépôt. Sans cette clé,
 *    un appelant hors clone n'a que la lecture (fail closed).
 *
 * Exception assumée : le canal de collaboration (`striart_collab_post` /
 * `striart_collab_read`, lot O) suit `grants.collab`, pas `mutate` — il agit
 * au nom du clone appelant (jamais sur le dépôt, jamais sur un autre agent),
 * reste disponible à profondeur 1 (STRIART_SESSION) et n'existe pas sans agent
 * appelant ; `--read-only` n'en laisse que la lecture, SAUF si `--collab` est
 * aussi passé (sessions ACP : acp.ts passe `--read-only --collab`) —
 * `--collab` n'accorde que `striart_collab_post`, aucun outil mutant, et reste
 * inerte sans agent borné.
 *
 * Invariants valables à TOUS les niveaux : aucun outil ne ferme un ticket
 * sans Test Gate (striart_resolve n'existe plus côté MCP) ni n'arbitre une
 * permission semi-autonome — ces gestes restent humains (CLI, dashboard).
 *
 * Limite assumée (SECURITY.md) : un process local peut toujours lancer
 * `striart mcp` depuis le principal avec une config élargie ; le bornage
 * est une défense en profondeur contre l'agent qui pilote Striart par MCP,
 * pas une frontière contre un process arbitraire de l'utilisateur.
 */

export interface McpCaller {
  /** Agent auquel l'appelant est borné (null = non borné). */
  agent: string | null;
  /** Origine du bornage, pour le journal et doctor. */
  boundBy: 'cwd' | 'option' | null;
  /** `--read-only` : aucun outil mutant exposé. */
  readOnly: boolean;
  /**
   * `--collab` : accorde `striart_collab_post` à un appelant en lecture seule
   * borné à un agent — et SEULEMENT cela. Absent/faux = `--read-only` strict.
   * Inerte sans agent borné (et sans `--read-only`, le post est déjà accordé).
   */
  collab?: boolean;
  /** Niveau configuré (`mcp.scope`). */
  scope: McpSettings['scope'];
}

/** Ce que l'appelant peut faire — dérivé, jamais stocké. */
export interface McpGrants {
  /** Une mutation est-elle envisageable (sinon : lecture seule) ? */
  mutate: boolean;
  /** striart_run (engendrer un agent). */
  run: boolean;
  /** Agent imposé aux mutations (null = tout le dépôt). */
  onlyAgent: string | null;
  /**
   * Canal de collaboration (lot O) — accordé à l'appelant BORNÉ à un agent,
   * jamais au niveau orchestrateur sans agent : 'post' (lire et poster),
   * 'read' (`--read-only` : lire seulement), 'none' (aucun agent appelant).
   * Indépendant de `mutate` : poster un message n'est pas agir sur le dépôt
   * (pas de merge, pas d'agent engendré), donc la profondeur bornée à 1
   * (STRIART_SESSION) ne le retire pas ; `--read-only` le ramène à 'read'.
   */
  collab: 'none' | 'read' | 'post';
  /** Motif du refus d'une mutation, quand `mutate` est faux. */
  denial: {
    code: 'MCP_READ_ONLY' | 'MCP_DEPTH_LIMIT' | 'MCP_SCOPE_DENIED';
    message: string;
    hint: string;
  } | null;
}

export function isNestedSession(env: NodeJS.ProcessEnv): boolean {
  return env.STRIART_SESSION === '1';
}

export function grantsOf(caller: McpCaller, env: NodeJS.ProcessEnv): McpGrants {
  if (caller.readOnly) {
    return {
      mutate: false,
      run: false,
      onlyAgent: caller.agent,
      collab: caller.agent ? (caller.collab === true ? 'post' : 'read') : 'none',
      denial: {
        code: 'MCP_READ_ONLY',
        message: 'This MCP server was started with --read-only: mutating tools are disabled.',
        hint: 'Use striart_status / striart_queue / striart_ticket, or ask the human operator.',
      },
    };
  }
  if (isNestedSession(env)) {
    return {
      mutate: false,
      run: false,
      onlyAgent: caller.agent,
      collab: caller.agent ? 'post' : 'none',
      denial: {
        code: 'MCP_DEPTH_LIMIT',
        message:
          'Refused: this process descends from a Striart autonomous session (STRIART_SESSION=1). ' +
          'Orchestration depth is bounded to 1 (profondeur bornée à 1): an agent can read the state, never spawn agents or merge.',
        hint: 'Commit your work; the session end merges it under the Test Gate.',
      },
    };
  }
  if (caller.agent) {
    return { mutate: true, run: false, onlyAgent: caller.agent, collab: 'post', denial: null };
  }
  if (caller.scope === 'orchestrator') {
    return { mutate: true, run: true, onlyAgent: null, collab: 'none', denial: null };
  }
  return {
    mutate: false,
    run: false,
    onlyAgent: null,
    collab: 'none',
    denial: {
      code: 'MCP_SCOPE_DENIED',
      message:
        'No agent is bound to this MCP server (not started from a clone, no --agent) and the ' +
        'configuration does not grant the orchestrator scope: mutating tools are disabled.',
      hint: "Start it from the agent clone (or `striart mcp --agent <name>`), or set mcp.scope: 'orchestrator' in the Striart config.",
    },
  };
}

/** Le chemin `inner` est-il `outer` ou l'un de ses descendants ? */
function isWithin(outer: string, inner: string): boolean {
  const rel = path.relative(outer, inner);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

async function canonical(p: string): Promise<string> {
  const real = await realpath(p).catch(() => path.resolve(p));
  // Windows/macOS : systèmes de fichiers insensibles à la casse par défaut.
  return process.platform === 'win32' || process.platform === 'darwin' ? real.toLowerCase() : real;
}

async function isInitialized(root: string): Promise<boolean> {
  return stat(striartDir(root)).then(
    (s) => s.isDirectory(),
    () => false,
  );
}

/**
 * Le dossier `dir` est-il (dans) le clone d'un agent ENREGISTRÉ d'un dépôt
 * Striart ? Reconnu par la forme du chemin `<racine>/.striart/agents/<nom>`
 * PUIS confirmé par le registre (le chemin enregistré doit être ce dossier) :
 * un dossier qui a seulement la bonne forme ne suffit pas.
 */
export async function detectCloneOf(dir: string): Promise<{ root: string; agent: string } | null> {
  const resolved = path.resolve(dir);
  const parts = resolved.split(path.sep);
  for (let i = parts.length - 3; i >= 1; i--) {
    if (parts[i] !== '.striart' || parts[i + 1] !== 'agents') continue;
    const agent = parts[i + 2];
    if (!agent || !AGENT_NAME_RE.test(agent)) continue;
    const root = parts.slice(0, i).join(path.sep) || path.sep;
    if (!(await isInitialized(root))) continue;
    const meta = (await readRegistry(root).catch(() => ({})))[agent];
    if (!meta) continue;
    const [clonePath, here] = await Promise.all([canonical(meta.path), canonical(resolved)]);
    if (isWithin(clonePath, here)) return { root, agent };
  }
  return null;
}

/**
 * Résout la racine du dépôt PRINCIPAL et l'appelant de `striart mcp`.
 *
 *  - `--root` : explicite, prioritaire. Doit être un dépôt Striart initialisé.
 *  - sinon le cwd : depuis un clone, `git rev-parse` désigne le CLONE (un
 *    vrai dépôt git, décision n°1) — la racine principale est alors celle
 *    qui enregistre ce clone, et l'appelant y est borné.
 *  - `--agent` : borne explicitement ; doit être un agent enregistré, et ne
 *    peut pas contredire le clone désigné par le cwd.
 */
export async function resolveMcpCaller({
  cwd,
  rootOption,
  agentOption,
  readOnly,
  collab = false,
}: {
  cwd: string;
  rootOption: string | null;
  agentOption: string | null;
  readOnly: boolean;
  /** `--collab` (voir McpCaller.collab). */
  collab?: boolean;
}): Promise<{ root: string; caller: McpCaller; settings: McpSettings }> {
  if (agentOption !== null && !AGENT_NAME_RE.test(agentOption)) {
    throw new StriartError(`Invalid agent name "${agentOption}".`, {
      code: 'INVALID_AGENT_NAME',
      details: { name: agentOption },
    });
  }
  const fromCwd = await detectCloneOf(cwd);
  let root: string;
  if (rootOption !== null) {
    root = path.resolve(cwd, rootOption);
    if (!(await isInitialized(root))) {
      throw new StriartError(
        `--root does not designate an initialized Striart repository: ${root}`,
        {
          code: 'MCP_ROOT_INVALID',
          hint: 'striart mcp --root <path of the main repository (contains .striart/)>',
          details: { root },
        },
      );
    }
  } else if (fromCwd) {
    root = fromCwd.root;
  } else {
    root = await findRepoRoot(cwd);
  }

  // Le cwd ne borne que s'il désigne un clone DU dépôt servi.
  const cwdAgent =
    fromCwd && (await canonical(fromCwd.root)) === (await canonical(root)) ? fromCwd.agent : null;
  if (agentOption !== null && cwdAgent !== null && agentOption !== cwdAgent) {
    throw new StriartError(
      `--agent ${agentOption} contradicts the clone of agent "${cwdAgent}" designated by the working directory.`,
      {
        code: 'MCP_SCOPE_CONFLICT',
        hint: `striart mcp --agent ${cwdAgent}`,
        details: { agent: agentOption, cwdAgent },
      },
    );
  }
  const agent = agentOption ?? cwdAgent;
  if (agent !== null && agentOption !== null) {
    const registry = await readRegistry(root);
    if (!registry[agent]) {
      throw new StriartError(`Agent "${agent}" is not registered in ${root}.`, {
        code: 'AGENT_UNKNOWN',
        hint: 'striart status',
        details: { agent, root },
      });
    }
  }
  const settings = resolveMcpSettings(await loadConfig(root));
  const caller: McpCaller = {
    agent,
    boundBy: agentOption !== null ? 'option' : cwdAgent !== null ? 'cwd' : null,
    readOnly,
    collab,
    scope: settings.scope,
  };
  return { root, caller, settings };
}

/**
 * Description lisible du niveau, pour le journal de démarrage et doctor.
 * Le niveau ORCHESTRATEUR est un relâchement : il est signalé en `warn`.
 */
export function describeMcpScope(
  caller: McpCaller,
  env: NodeJS.ProcessEnv,
): {
  level: 'read-only' | 'agent' | 'orchestrator';
  relaxed: boolean;
  summary: string;
} {
  const grants = grantsOf(caller, env);
  if (!grants.mutate) {
    const post = grants.collab === 'post' ? ' + collaboration post (--collab)' : '';
    return {
      level: 'read-only',
      relaxed: false,
      summary: `read-only (${grants.denial?.code})${post}`,
    };
  }
  if (grants.onlyAgent) {
    return {
      level: 'agent',
      relaxed: false,
      summary: `bound to agent "${grants.onlyAgent}" (${caller.boundBy})`,
    };
  }
  return {
    level: 'orchestrator',
    relaxed: true,
    summary:
      "orchestrator scope (mcp.scope: 'orchestrator'): run/merge/resolution on the whole repository",
  };
}

/** Journalise le niveau effectif au démarrage (relâchement → warn). */
export function logMcpScope(root: string, caller: McpCaller, env: NodeJS.ProcessEnv): void {
  const scope = describeMcpScope(caller, env);
  const fields = { root, level: scope.level, agent: caller.agent, boundBy: caller.boundBy };
  if (scope.relaxed) logger.warn(fields, `MCP: ${scope.summary}`);
  else logger.info(fields, `MCP: ${scope.summary}`);
}

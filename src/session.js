import { execa } from 'execa';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { runAcpSession } from './acp.ts';
import { StriartError } from './errors.js';
import { logger } from './logger.js';
import { striartDir } from './paths.js';
import { killProcessTree, normalizeExitCode } from './process-tree.js';

/** Marqueur substitué par le prompt de la tâche dans les args d'un profil. */
export const PROMPT_PLACEHOLDER = '{{prompt}}';

/**
 * Profil appliqué quand l'appelant n'en nomme aucun. Source unique : tout
 * consommateur (`runAutonomousTask`, `applyPlan`, dashboard, CLI) doit passer
 * par cette constante — deux défauts codés en dur qui divergent feraient
 * valider un profil et en exécuter un autre.
 */
export const DEFAULT_PROFILE = 'claude';

/**
 * Chemin du log d'une session autonome. Volontairement sous .striart/logs/ et
 * JAMAIS dans le clone : le clone est supprimé en fin de session réussie, le
 * log doit lui survivre (c'est la seule trace de ce que l'agent a fait).
 *
 * @param {string} root @param {string} agent @param {string} taskId
 */
export function sessionLogPath(root, agent, taskId) {
  return path.join(striartDir(root), 'logs', `session-${agent}-${taskId}.log`);
}

/**
 * Résout le profil d'invocation non interactive d'un outil de coding.
 *
 * Un profil décrit COMMENT lancer l'outil sans interaction humaine — chaque
 * fournisseur a sa propre syntaxe (`claude -p`, `aider --message --yes`,
 * `codex exec`, `ollama run <modèle>`), d'où une table plutôt qu'une
 * commande unique : c'est ce qui permet de superviser des agents Claude,
 * OpenAI, Ollama ou Kimi côte à côte sur le même projet.
 *
 * @param {import('./types.js').StriartConfig} config
 * @param {string} name Clé dans config.agentProfiles.
 * @returns {import('./types.js').AgentProfile}
 */
export function resolveAgentProfile(config, name) {
  const profiles = config.agentProfiles ?? {};
  const profile = profiles[name];
  if (!profile) {
    const known = Object.keys(profiles).sort().join(', ') || '(aucun)';
    throw new StriartError(`Profil d'agent inconnu : "${name}". Profils configurés : ${known}.`, {
      code: 'PROFILE_UNKNOWN',
      details: { profile: name, known: Object.keys(profiles) },
    });
  }
  return profile;
}

/**
 * Décrit les profils configurés pour affichage (`striart profiles`).
 * N'expose que les CLÉS d'environnement, jamais les valeurs : un profil peut
 * en principe contenir une valeur sensible, on ne la relaie pas dans une
 * sortie de commande.
 *
 * @param {import('./types.js').StriartConfig} config
 * @returns {Array<{name: string, command: string, invocation: string, envKeys: string[], timeout: number | null, acp: boolean}>}
 */
export function listProfiles(config) {
  const profiles = config.agentProfiles ?? {};
  return Object.entries(profiles)
    .map(([name, p]) => ({
      name,
      command: p.command,
      invocation: `${p.command} ${p.args.join(' ')}`,
      envKeys: Object.keys(p.env ?? {}),
      timeout: p.timeout ?? null,
      acp: Boolean(p.acp),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Construit l'argv complet d'une session à partir d'un profil et du prompt.
 *
 * Le prompt est injecté comme ÉLÉMENT d'argv, jamais concaténé dans une
 * chaîne de shell : un prompt contient naturellement des guillemets, des
 * backticks, des `$`, des `&&` — passer par un shell en ferait une injection
 * de commande immédiate, avec du texte que l'utilisateur n'a pas écrit
 * lui-même (il peut venir d'un ticket, d'une issue, d'un fichier).
 *
 * @param {import('./types.js').AgentProfile} profile
 * @param {string} prompt
 * @returns {{command: string, args: string[]}}
 */
export function buildAgentArgv(profile, prompt) {
  // Un profil ACP ne construit pas d'argv-avec-prompt : le prompt passe par
  // le protocole (voir acp.ts). Arriver ici avec un tel profil est une erreur
  // d'aiguillage, pas un cas à rattraper en silence.
  if (profile?.acp) {
    throw new StriartError(
      'Profil ACP : le prompt passe par le protocole, pas par l’argv (utiliser runAgentSession).',
      { code: 'PROFILE_INVALID', details: { profile } },
    );
  }
  if (typeof profile?.command !== 'string' || profile.command.trim().length === 0) {
    throw new StriartError('Profil invalide : "command" doit être une chaîne non vide.', {
      code: 'PROFILE_INVALID',
      details: { profile },
    });
  }
  const args = profile.args ?? [];
  if (!Array.isArray(args) || args.some((a) => typeof a !== 'string')) {
    throw new StriartError('Profil invalide : "args" doit être un tableau de chaînes.', {
      code: 'PROFILE_INVALID',
      details: { profile },
    });
  }
  // Sans marqueur, le prompt ne serait jamais transmis : l'agent démarrerait
  // sans tâche et sortirait en 0. Un succès vide est pire qu'une erreur —
  // on refuse au montage plutôt que de laisser passer un faux positif.
  if (!args.some((a) => a.includes(PROMPT_PLACEHOLDER))) {
    throw new StriartError(
      `Profil invalide : aucun argument ne contient ${PROMPT_PLACEHOLDER}, le prompt ne serait pas transmis à l'agent.`,
      { code: 'PROFILE_INVALID', details: { profile, placeholder: PROMPT_PLACEHOLDER } },
    );
  }
  return {
    command: profile.command,
    args: args.map((a) => a.split(PROMPT_PLACEHOLDER).join(prompt)),
  };
}

/**
 * Lance un agent de coding en mode non interactif dans son clone et supervise
 * son exécution jusqu'à la sortie du process ou l'expiration du délai.
 *
 * Ne throw JAMAIS pour un échec de l'agent : comme le Test Gate, cette
 * fonction rapporte, l'orchestrateur décide. Un throw ici empêcherait la
 * suite du cycle (conservation du clone, ticket) de s'exécuter.
 *
 * @param {{
 *   root: string, agent: string, taskId: string, cwd: string,
 *   profile: import('./types.js').AgentProfile, prompt: string,
 *   timeoutMs?: number, env?: NodeJS.ProcessEnv,
 *   onSpawn?: (pid: number|undefined) => Promise<void>|void,
 * }} params
 * @returns {Promise<import('./types.js').SessionResult>}
 */
export async function runAgentSession({
  root,
  agent,
  taskId,
  cwd,
  profile,
  prompt,
  timeoutMs = 1_800_000,
  env = process.env,
  onSpawn = null,
}) {
  // Transport ACP : même contrat SessionResult, même supervision (PID publié,
  // timeout, log hors du clone) — seule la frontière avec l'outil change :
  // un protocole au lieu d'un argv. L'orchestrateur ne voit pas la différence.
  if (profile?.acp) {
    return runAcpSession({ root, agent, taskId, cwd, profile, prompt, timeoutMs, env, onSpawn });
  }
  const { command, args } = buildAgentArgv(profile, prompt);
  const logPath = sessionLogPath(root, agent, taskId);
  await mkdir(path.dirname(logPath), { recursive: true });

  const startedAt = Date.now();
  logger.info({ agent, command, cwd, timeoutMs }, 'Session autonome démarrée');

  const subprocess = execa(command, args, {
    cwd,
    // shell: false (défaut) — voir buildAgentArgv : le prompt est de la
    // donnée, il ne doit jamais être interprété comme du code.
    shell: false,
    all: true,
    reject: false,
    detached: process.platform !== 'win32', // POSIX : groupe de process tuable d'un bloc
    // Environnement de la session, par ordre de priorité croissant :
    //  - `env` (celui du process, ou celui passé en test) ;
    //  - `profile.env` — les variables PROPRES au profil, qui cloisonnent
    //    (clé API par outil, MODEL, région…) et peuvent donc surcharger
    //    l'environnement de base ;
    //  - `STRIART_SESSION` en DERNIER, non surchargeable : c'est lui qui
    //    borne la profondeur d'orchestration à 1 (mcp.js refuse les outils
    //    mutants à un descendant). Un profil ne doit jamais pouvoir le
    //    désarmer.
    env: { ...env, ...(profile.env ?? {}), STRIART_SESSION: '1' },
  });

  // Publication du PID au plus tôt : c'est lui qui rend la session visible au
  // reste de l'orchestrateur (qui doit alors s'abstenir de toucher au clone).
  // Best effort : un échec de publication ne doit pas tuer une session valide,
  // le pire cas étant un rebase concurrent que les garde-fous de sync
  // rattrapent déjà.
  if (onSpawn) {
    try {
      await onSpawn(subprocess.pid);
    } catch (error) {
      logger.warn({ err: error, agent }, 'Publication du PID de session impossible');
    }
  }

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    void killProcessTree(subprocess);
  }, timeoutMs);

  let result;
  try {
    result = await subprocess;
  } finally {
    clearTimeout(timer);
  }

  const durationMs = Date.now() - startedAt;
  const output = result.all ?? '';
  const log = timedOut
    ? `${output}\n[Striart] Session interrompue : délai de ${timeoutMs}ms dépassé.`
    : output;

  // Le log est écrit même en cas d'échec de spawn : c'est précisément là
  // qu'on en a besoin (binaire introuvable, profil mal configuré).
  await writeFile(logPath, log, 'utf8').catch((error) => {
    logger.warn({ err: error, logPath }, 'Écriture du log de session impossible');
  });

  // Volontairement trois statuts seulement. Distinguer « binaire introuvable »
  // d'un « agent qui a échoué » serait utile, mais n'est pas portable : execa
  // normalise le ENOENT de Windows en exitCode 1 sans code d'erreur, là où
  // POSIX l'expose. Un statut juste sur un OS et faux sur un autre vaut moins
  // que pas de statut — le détail reste dans `error` et dans le log.
  /** @type {import('./types.js').SessionResult['status']} */
  const status = timedOut ? 'TIMEOUT' : result.exitCode === 0 ? 'COMPLETED' : 'FAILED';

  // Même normalisation que le Test Gate : Windows rend les codes en uint32,
  // et « code de sortie 4294963238 » ne renseigne personne.
  const exitCode = normalizeExitCode(result.exitCode);
  logger.info({ agent, status, durationMs, exitCode }, 'Session autonome terminée');

  return {
    status,
    agent,
    exitCode,
    durationMs,
    timedOut,
    logPath,
    command: `${command} ${args.join(' ')}`,
    // Porte notamment le cas « binaire introuvable » : le message d'execa cite
    // la commande, ce qui suffit à diagnostiquer un profil mal configuré.
    error: status === 'COMPLETED' ? null : (result.shortMessage ?? null),
  };
}

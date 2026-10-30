import { execa } from 'execa';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { runAcpSession } from './acp.ts';
import {
  buildAgentInstructions,
  planArgvInstructions,
  resolveInstructionsChannel,
  writeSessionSettings,
} from './agents/instructions.ts';
import {
  INSTRUCTIONS_FILE_PLACEHOLDER,
  INSTRUCTIONS_PLACEHOLDER,
  PROMPT_PLACEHOLDER,
  TEST_COMMAND_PLACEHOLDER,
} from './agents/profile-schema.ts';
import { transcribeStructuredOutput } from './agents/transcript.ts';
import { loadConfig } from './config.ts';
import { startOutputBeat } from './idle/heartbeat.ts';
import { closeRequestPath } from './idle/paths.ts';
import { StriartError } from './errors.ts';
import { logger } from './logger.ts';
import { striartDir } from './paths.ts';
import { writePrivateFile } from './private-fs.ts';
import { killProcessTree, normalizeExitCode } from './process-tree.ts';
import type { AgentProfile, SessionResult, StriartConfig } from './types.js';
import { redactSecrets, secretValuesFromEnv } from './redact-secrets.ts';
import { applyEnvAllowlist, buildSessionEnv } from './session-env.ts';
import { ensureStateProtection } from './state-protection.ts';
import { clearStopRequest, watchStopRequest } from './stop-request.ts';
import { SessionMeter } from './tokens/session-meter.ts';

/**
 * Message d'échec d'une session SANS la ligne de commande : le `shortMessage`
 * d'execa la recopie en entier, prompt et consignes compris.
 * @param {{exitCode?: number, signal?: string, originalMessage?: string}} result
 * @param {string} command
 */
function describeFailure(result, command) {
  const how =
    result.exitCode != null
      ? ` with exit code ${normalizeExitCode(result.exitCode)}`
      : result.signal
        ? ` with signal ${result.signal}`
        : '';
  // « spawn <binaire> ENOENT » : cite le binaire, jamais les arguments.
  const detail =
    typeof result.originalMessage === 'string' && result.originalMessage.trim()
      ? `: ${result.originalMessage.split('\n')[0].slice(0, 300)}`
      : '';
  return `Command failed${how} (${command})${detail}`;
}

/** Délai entre le SIGTERM de la fermeture d'inactivité et le kill d'arbre (POSIX). */
const IDLE_CLOSE_TERM_GRACE_MS = 5_000;

/** Marqueur substitué par le prompt de la tâche dans les args d'un profil. */
export { PROMPT_PLACEHOLDER };

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
 * Flux BRUT d'une session à sortie structurée (JSONL de l'outil), conservé à
 * côté du log transcrit : la transcription tronque les sorties d'outils
 * volumineuses, le flux brut garde tout pour le diagnostic.
 * @param {string} root @param {string} agent @param {string} taskId
 */
export function sessionRawLogPath(root, agent, taskId) {
  return path.join(striartDir(root), 'logs', `session-${agent}-${taskId}.raw.jsonl`);
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
 * @param name Clé dans config.agentProfiles.
 */
export function resolveAgentProfile(config: StriartConfig, name: string): AgentProfile {
  const profiles = config.agentProfiles ?? {};
  const profile = profiles[name];
  if (!profile) {
    const known = Object.keys(profiles).sort().join(', ') || '(aucun)';
    throw new StriartError(`Profil d'agent inconnu : "${name}". Profils configurés : ${known}.`, {
      code: 'PROFILE_UNKNOWN',
      hint: 'striart profiles',
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
 */
export function listProfiles(config: StriartConfig): Array<{
  name: string;
  command: string;
  invocation: string;
  envKeys: string[];
  /** `null` = hérite tout l'environnement (défaut) ; sinon la liste `envAllow` déclarée. */
  envAllow: string[] | null;
  timeout: number | null;
  acp: boolean;
  preset: string | null;
  experimental: boolean;
  writeMode: string | null;
  commitPolicy: string | null;
  structuredOutput: string;
  instructions: string;
}> {
  const profiles: Record<string, AgentProfile> = config.agentProfiles ?? {};
  return Object.entries(profiles)
    .map(([name, p]) => ({
      name,
      command: p.command,
      invocation: `${p.command} ${p.args.join(' ')}`,
      envKeys: Object.keys(p.env ?? {}),
      envAllow: p.envAllow ?? null,
      timeout: p.timeout ?? null,
      acp: Boolean(p.acp),
      preset: p.preset ?? null,
      experimental: p.experimental === true,
      writeMode: p.writeMode ?? null,
      commitPolicy: p.commitPolicy ?? null,
      structuredOutput: p.structuredOutput ?? 'none',
      // Canal effectif (auto résolu) : ce que l'agent recevra vraiment.
      instructions:
        config.agentInstructions?.enabled === false ? 'none' : resolveInstructionsChannel(p),
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
 * Les emplacements optionnels de consignes (`{{striartInstructions}}`,
 * `{{striartInstructionsFile}}`) sont remplis dans la MÊME passe que le
 * prompt : un texte inséré n'est jamais re-scanné, donc un prompt qui
 * contiendrait littéralement un marqueur reste de la donnée. Un
 * emplacement sans valeur est retiré, avec le drapeau qui le précède
 * (`--flag {{slot}}`) : un drapeau orphelin avalerait l'argument suivant.
 *
 * `testCommand` remplit `{{striartTestCommand}}` (règles d'autorisation
 * d'un preset qui laissent l'agent lancer le Test Gate lui-même).
 *
 * @param appendArgs Ajoutés en fin d'argv (canal system-prompt-file).
 */
export function buildAgentArgv(
  profile: AgentProfile,
  prompt: string,
  slots: { instructions?: string; instructionsFile?: string; testCommand?: string } = {},
  appendArgs: string[] = [],
): { command: string; args: string[] } {
  // Un profil ACP ne construit pas d'argv-avec-prompt : le prompt passe par
  // le protocole (voir acp.ts). Arriver ici avec un tel profil est une erreur
  // d'aiguillage, pas un cas à rattraper en silence.
  if (profile?.acp) {
    throw new StriartError(
      'Profil ACP : le prompt passe par le protocole, pas par l’argv (utiliser runAgentSession).',
      {
        code: 'PROFILE_INVALID',
        hint: 'striart profiles',
        details: { reason: 'ACP_TRANSPORT', field: 'acp' },
      },
    );
  }
  if (typeof profile?.command !== 'string' || profile.command.trim().length === 0) {
    throw new StriartError('Profil invalide : "command" doit être une chaîne non vide.', {
      code: 'PROFILE_INVALID',
      hint: 'striart profiles',
      // Jamais le profil lui-même : son env porte des clés d'API.
      details: { reason: 'COMMAND_EMPTY', field: 'command' },
    });
  }
  const args = profile.args ?? [];
  if (!Array.isArray(args) || args.some((a) => typeof a !== 'string')) {
    throw new StriartError('Profil invalide : "args" doit être un tableau de chaînes.', {
      code: 'PROFILE_INVALID',
      hint: 'striart profiles',
      details: { reason: 'ARGS_NOT_STRINGS', field: 'args' },
    });
  }
  // Sans marqueur, le prompt ne serait jamais transmis : l'agent démarrerait
  // sans tâche et sortirait en 0. Un succès vide est pire qu'une erreur —
  // on refuse au montage plutôt que de laisser passer un faux positif.
  if (!args.some((a) => a.includes(PROMPT_PLACEHOLDER))) {
    throw new StriartError(
      `Profil invalide : aucun argument ne contient ${PROMPT_PLACEHOLDER}, le prompt ne serait pas transmis à l'agent.`,
      {
        code: 'PROFILE_INVALID',
        hint: 'striart profiles',
        details: { reason: 'PLACEHOLDER_MISSING', field: 'args', placeholder: PROMPT_PLACEHOLDER },
      },
    );
  }
  /** @type {Record<string, string>} */
  const values = {
    [PROMPT_PLACEHOLDER]: prompt,
    [INSTRUCTIONS_PLACEHOLDER]: slots.instructions ?? '',
    [INSTRUCTIONS_FILE_PLACEHOLDER]: slots.instructionsFile ?? '',
    [TEST_COMMAND_PLACEHOLDER]: slots.testCommand ?? '',
  };
  const slotRe =
    /\{\{(?:prompt|striartInstructions|striartInstructionsFile|striartTestCommand)\}\}/g;
  /** @type {string[]} */
  const out = [];
  for (const arg of args) {
    const isOptionalSlot =
      arg === INSTRUCTIONS_PLACEHOLDER || arg === INSTRUCTIONS_FILE_PLACEHOLDER;
    if (isOptionalSlot && values[arg] === '') {
      if (out.length > 0 && out[out.length - 1].startsWith('-')) out.pop();
      continue;
    }
    // Argument qui EST le marqueur (position libre : `exec {{prompt}}`, ou
    // valeur d'un drapeau) : une valeur commençant par `-` serait lue comme une
    // option par l'outil (`--dangerously-skip-permissions…`). Une espace de tête
    // la rend positionnelle pour tout analyseur d'options, sans rien changer
    // pour le modèle. Intégré à un texte (`--message={{prompt}}`), l'argument
    // commence déjà par son drapeau : rien à faire.
    if (Object.hasOwn(values, arg) && values[arg].startsWith('-')) {
      out.push(` ${values[arg]}`);
      continue;
    }
    out.push(arg.replace(slotRe, (match) => values[match]));
  }
  return { command: profile.command, args: [...out, ...appendArgs] };
}

/**
 * Lance un agent de coding en mode non interactif dans son clone et supervise
 * son exécution jusqu'à la sortie du process ou l'expiration du délai.
 *
 * Ne throw JAMAIS pour un échec de l'agent : comme le Test Gate, cette
 * fonction rapporte, l'orchestrateur décide. Un throw ici empêcherait la
 * suite du cycle (conservation du clone, ticket) de s'exécuter.
 *
 * `onMain` : session sur le repo PRINCIPAL (`run --on-main`) — aucune
 * consigne de clone n'est injectée ; absent, déduit de `cwd === root`.
 * `config` / `profileKey` : config déjà chargée et clé du profil, pour les
 * consignes Striart (src/agents/instructions.ts) ; relue / déduite sinon.
 * `signal` : arrêt demandé par l'appelant (Ctrl+C de la CLI). L'arbre de
 * process est tué et la session rend 'CANCELLED' — sans lui, l'agent
 * (groupe de process propre sous POSIX) survivrait à l'orchestrateur.
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
  signal?: AbortSignal | null;
  config?: StriartConfig | null;
  profileKey?: string | null;
  onMain?: boolean;
}): Promise<SessionResult> {
  // Valeurs à caviarder : celles de l'environnement D'ORIGINE (STRIART_PROXY_AUTH
  // comprise), même si la session ne la reçoit pas.
  const redactionEnv = env;
  // Allégement de confiance (priorité 5) : restreint l'environnement HÉRITÉ
  // avant tout ajout de Striart, pour qu'une liste restreinte ne prive jamais
  // une session de ce que Striart pose lui-même ensuite (CA, profile.env,
  // STRIART_SESSION). `null` (défaut) : comportement inchangé.
  env = applyEnvAllowlist(env, profile?.envAllow ?? null);
  // Environnement réseau de la session (une seule fois pour les trois
  // transports : argv, ACP en process, hôte ACP persistant) : network.caFile
  // de la config UTILISATEUR → NODE_EXTRA_CA_CERTS ; STRIART_PROXY_AUTH jamais.
  env = await buildSessionEnv(env);
  // Transport ACP : même contrat SessionResult, même supervision (PID publié,
  // timeout, log hors du clone) — seule la frontière avec l'outil change :
  // un protocole au lieu d'un argv. L'orchestrateur ne voit pas la différence.
  if (profile?.acp) {
    return runAcpSession({
      root,
      agent,
      taskId,
      cwd,
      profile,
      prompt,
      timeoutMs,
      env,
      onSpawn,
      signal,
      config,
      profileKey,
      onMain,
    });
  }
  const cfg = config ?? (await loadConfig(root));
  const key = profileKey ?? profile?.preset ?? 'custom';
  // Session sur le repo PRINCIPAL (`run --on-main`, cwd = racine) : les
  // consignes décrivent un clone isolé, elles y seraient fausses.
  // `onMain` explicite (runMainSession) l'emporte ; sinon déduit du cwd.
  const isMainSession = onMain ?? path.resolve(cwd) === path.resolve(root);
  const instructions = isMainSession
    ? null
    : await buildAgentInstructions({
        root,
        agent,
        profileKey: key,
        profile,
        config: cfg,
        mode: 'autonomous',
      });
  // Lot T : relevé d'usage en direct (flux structuré) et arrêt sur budget. Sans
  // flux structuré la session est « unmetered » : seul le délai la borne.
  // `timedOut` / `cancelled` sont déclarés ICI : le relevé peut déclencher
  // onBreach dès le premier chunk, avant la fin de la préparation.
  let budgetStopped = false;
  let timedOut = false;
  let cancelled = false;
  const meter = await SessionMeter.open({
    root,
    agent,
    taskId,
    config: cfg,
    format: profile.structuredOutput ?? 'none',
    onBreach: () => {
      // Un délai ou un arrêt demandé déjà en cours gardent la priorité du statut.
      if (timedOut || cancelled) return;
      budgetStopped = true;
      void killProcessTree(subprocess);
    },
  });
  meter?.noteInstructions(instructions);
  // Préparation (consignes, réglages, argv) : une erreur de CONFIGURATION (profil
  // invalide, fichier de consignes non écrivable) est levée avant tout lancement
  // — contrairement à un échec de l'agent, qui est rapporté dans le résultat.
  // Le relevé d'usage déjà ouvert est refermé dans tous les cas.
  let plan;
  let command;
  let args;
  const logPath = sessionLogPath(root, agent, taskId);
  try {
    plan = await planArgvInstructions({ root, agent, taskId, instructions, profile, prompt });
    const settingsArgs = await writeSessionSettings({ root, agent, taskId, cwd, profile });
    ({ command, args } = buildAgentArgv(
      profile,
      plan.prompt,
      { ...plan.slots, testCommand: cfg.testCommand },
      [...settingsArgs, ...plan.appendArgs],
    ));
    // Journaux = code et sorties d'outils : `.striart/` réservé à l'utilisateur
    // (migration de l'existant comprise) avant d'y écrire quoi que ce soit.
    await ensureStateProtection(root, cfg);
    await mkdir(path.dirname(logPath), { recursive: true, mode: 0o700 });
  } catch (error) {
    await meter?.close().catch(() => undefined);
    throw error;
  }
  // Le prompt et les consignes sont de la donnée potentiellement sensible (issue,
  // fichier) : jamais recopiés dans le résultat, le journal ou un ticket par le
  // biais de la ligne de commande.
  const secrets = [plan.prompt, plan.slots?.instructions].filter(
    (s) => typeof s === 'string' && s.length > 0,
  );
  // Une valeur très courte (« fix ») ne se remplace que lorsqu'elle EST l'argument :
  // une recherche de sous-chaîne défigurerait les drapeaux (« pr<prompt>ix »).
  const redact = (arg) =>
    secrets.reduce(
      (acc, secret) =>
        secret.length >= 8
          ? acc.split(secret).join('<prompt>')
          : acc.trim() === secret
            ? '<prompt>'
            : acc,
      String(arg),
    );
  const describedArgs = args.map((a) => redact(a));
  // Valeurs à retirer de tout ce qui est écrit ou rendu : clés d'API de
  // l'environnement hérité et variables propres au profil (un outil qui
  // s'« affiche » lui-même, une trace d'erreur HTTP, un `env` verbeux).
  const secretValues = [
    ...secretValuesFromEnv(redactionEnv),
    ...Object.values(profile.env ?? {}).filter((v) => typeof v === 'string'),
  ];
  const scrub = (/** @type {unknown} */ text) => redactSecrets(text, { values: secretValues });

  const startedAt = Date.now();
  logger.info({ agent, command, cwd, timeoutMs }, 'Session autonome démarrée');

  // GC d'inactivité (src/idle/) : le journal de cette session n'est écrit qu'à sa FIN, donc un
  // battement de sortie (au plus un toutes les 10 s) dit si l'agent parle encore ; et une demande
  // de fermeture propre déposée sur disque est lue par CE process, qui tient le handle du
  // sous-process (aucun PID n'est deviné par le demandeur). Les deux sont best effort.
  const closeFile = closeRequestPath(root, agent);
  await clearStopRequest(closeFile).catch(() => undefined);
  const beat = await startOutputBeat(root, agent).catch(() => null);

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

  subprocess.all?.on('data', (chunk) => {
    meter?.feedChunk(chunk);
    beat?.note();
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

  const timer = setTimeout(() => {
    if (cancelled) return;
    timedOut = true;
    void killProcessTree(subprocess);
  }, timeoutMs);
  const onAbort = () => {
    if (timedOut) return;
    cancelled = true;
    void killProcessTree(subprocess);
  };
  if (signal?.aborted) onAbort();
  else signal?.addEventListener('abort', onAbort, { once: true });

  // Fermeture demandée par le GC d'inactivité (accusée avant d'agir, voir watchStopRequest) : arrêt
  // doux d'abord (SIGTERM, POSIX), kill d'arbre si l'agent est encore là après la grâce. Statut
  // CANCELLED comme un Ctrl+C : le clone et son travail sont conservés par la fin de cycle.
  let idleClosed = false;
  const onIdleClose = () => {
    if (timedOut || cancelled) return;
    cancelled = true;
    idleClosed = true;
    if (process.platform === 'win32') {
      void killProcessTree(subprocess);
      return;
    }
    try {
      subprocess.kill('SIGTERM');
    } catch {
      // Déjà sorti : rien à interrompre.
    }
    setTimeout(() => {
      if (subprocess.exitCode === null) void killProcessTree(subprocess);
    }, IDLE_CLOSE_TERM_GRACE_MS).unref();
  };
  const stopCloseWatch = subprocess.pid
    ? watchStopRequest(closeFile, { pid: subprocess.pid, onStop: onIdleClose })
    : () => undefined;

  let result;
  try {
    result = await subprocess;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
    stopCloseWatch();
    await clearStopRequest(closeFile, subprocess.pid ?? null).catch(() => undefined);
    await beat?.stop();
  }

  const durationMs = Date.now() - startedAt;
  const usage = meter ? await meter.close() : undefined;
  const raw = result.all ?? '';
  const structured = profile.structuredOutput ?? 'none';
  if (structured !== 'none') {
    await writePrivateFile(sessionRawLogPath(root, agent, taskId), scrub(raw)).catch((error) => {
      logger.warn({ err: error, agent }, 'Écriture du flux brut de session impossible');
    });
  }
  // Transcription lisible du flux structuré (messages, outils, commandes,
  // issue) ; sortie texte inchangée pour un profil sans format déclaré.
  const output = scrub(transcribeStructuredOutput(structured, raw));
  const log = timedOut
    ? `${output}\n[Striart] Session interrompue : délai de ${timeoutMs}ms dépassé.`
    : cancelled
      ? `${output}\n[Striart] Session interrompue : ${
          idleClosed
            ? "fermée par le GC d'inactivité (aucune activité), clone conservé"
            : 'arrêt demandé'
        }.`
      : budgetStopped
        ? `${output}\n[Striart] Session interrompue : budget de tokens dépassé (${meter?.breach?.scope}, ${meter?.breach?.metric}).`
        : output;

  // Le log est écrit même en cas d'échec de spawn : c'est précisément là
  // qu'on en a besoin (binaire introuvable, profil mal configuré).
  await writePrivateFile(logPath, log).catch((error) => {
    logger.warn({ err: error, logPath }, 'Écriture du log de session impossible');
  });

  // Volontairement trois statuts seulement. Distinguer « binaire introuvable »
  // d'un « agent qui a échoué » serait utile, mais n'est pas portable : execa
  // normalise le ENOENT de Windows en exitCode 1 sans code d'erreur, là où
  // POSIX l'expose. Un statut juste sur un OS et faux sur un autre vaut moins
  // que pas de statut — le détail reste dans `error` et dans le log.
  /** @type {import('./types.js').SessionResult['status']} */
  const status = timedOut
    ? 'TIMEOUT'
    : cancelled
      ? 'CANCELLED'
      : budgetStopped
        ? 'BUDGET_EXCEEDED'
        : result.exitCode === 0
          ? 'COMPLETED'
          : 'FAILED';

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
    command: scrub(`${command} ${describedArgs.join(' ')}`),
    // Porte notamment le cas « binaire introuvable » : le message cite la
    // commande (sans le prompt), ce qui suffit à diagnostiquer un profil mal
    // configuré. `shortMessage` d'execa recopie la ligne de commande COMPLÈTE,
    // prompt compris : redacté (et ses échappements ne sont pas fiables pour un
    // remplacement exact, d'où la reconstruction à partir des champs).
    error:
      status === 'BUDGET_EXCEEDED'
        ? `Token budget exceeded (${meter?.breach?.scope}, ${meter?.breach?.metric}): session stopped, clone kept. Raise tokens.budgets or review the work before merging.`
        : status === 'COMPLETED'
          ? null
          : scrub(describeFailure(result, command)),
    ...(usage ? { usage } : {}),
    ...(budgetStopped && meter?.breach ? { budget: meter.breach } : {}),
  };
}

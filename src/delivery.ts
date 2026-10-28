import { stat, rm } from 'node:fs/promises';
import path from 'node:path';
import { execa } from 'execa';
import { StriartError } from './errors.js';
import { validateAgentName } from './agent-name.ts';
import { logger } from './logger.js';
import { killProcessTree, normalizeExitCode } from './process-tree.js';

/**
 * Opérations git BORNÉES du chemin de livraison : commit de merge (hooks de la
 * cible, signature) et push vers `origin`.
 *
 * Pourquoi pas simple-git ici : ces deux opérations lancent du code qui n'est pas
 * le nôtre (hook `pre-commit` / `commit-msg` / `pre-push` d'entreprise, programme
 * de signature, helper d'identifiants) et qui peut bloquer. Il faut donc (1) un
 * DÉLAI dur, (2) tuer l'ARBRE de process au délai (le hook est un petit-fils de
 * git), (3) aucune invite interactive possible, (4) la sortie du hook conservée
 * — bornée — pour la remonter. simple-git ne sait faire aucun des quatre.
 *
 * Aucune donnée utilisateur n'est jamais passée à un shell : `git` est lancé en
 * `argv`, `shell: false`. Jamais de `--no-verify` : les hooks d'une entreprise ne
 * se contournent pas.
 */

/** Sortie conservée d'une commande bornée (la FIN est gardée : c'est là que sont les violations). */
const OUTPUT_TAIL_CHARS = 16 * 1024;
/** Délai laissé à l'arbre de process, après le kill, pour libérer ses flux. */
const KILL_GRACE_MS = 10_000;
/** Délai des sondes locales courtes (chemin d'un hook, ancêtre, ls-remote hors push). */
const PROBE_TIMEOUT_MS = 30_000;

/**
 * Environnement d'un git lancé par Striart : AUCUNE variable `GIT_*` héritée (un
 * `GIT_DIR` ou `GIT_INDEX_FILE` ambiant — hook parent, IDE, `rebase --exec` —
 * désignerait un autre dépôt ; c'est aussi la règle de simple-git 4), plus les
 * deux interdictions d'invite : `GIT_TERMINAL_PROMPT=0` (git) et
 * `GCM_INTERACTIVE=never` (Git Credential Manager). Une invite sans terminal gèlerait
 * la livraison jusqu'au délai ; mieux vaut un échec immédiat et nommé.
 */
export function gitSpawnEnv(base: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(base)) {
    if (value === undefined) continue;
    if (name.toUpperCase().startsWith('GIT_')) continue;
    env[name] = value;
  }
  env.GIT_TERMINAL_PROMPT = '0';
  env.GCM_INTERACTIVE = 'never';
  return env;
}

/** `https://user:token@forge/` → `https://***@forge/` : un jeton ne finit ni en journal ni en ticket. */
export function redactRemoteCredentials(text: string): string {
  return text.replaceAll(/(\/\/)[^/@\s'"]+@/g, '$1***@');
}

export interface BoundedGitResult {
  /** Code de sortie normalisé ; null si le process n'a pas pu être lancé ou a été tué sans code. */
  exitCode: number | null;
  /** Fin de la sortie (stdout + stderr mêlés), bornée. */
  output: string;
  /** La sortie a été tronquée (seule la fin est conservée). */
  truncated: boolean;
  /** Le délai a été atteint : l'arbre de process a été tué. */
  timedOut: boolean;
}

export async function runBoundedGit(options: {
  cwd: string;
  args: string[];
  timeoutMs: number;
}): Promise<BoundedGitResult> {
  const { cwd, args, timeoutMs } = options;
  const subprocess = execa('git', args, {
    cwd,
    env: gitSpawnEnv(),
    extendEnv: false,
    stdin: 'ignore',
    all: true,
    buffer: false,
    reject: false,
    windowsHide: true,
    // POSIX : groupe de process (et session) propre — tuable d'un bloc, et sans
    // terminal de contrôle sur lequel un ssh ou un gpg pourrait demander un secret.
    detached: process.platform !== 'win32',
  });
  let output = '';
  let truncated = false;
  subprocess.all?.on('data', (chunk: Buffer | string) => {
    output += chunk.toString();
    if (output.length > OUTPUT_TAIL_CHARS) {
      output = output.slice(-OUTPUT_TAIL_CHARS);
      truncated = true;
    }
  });

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    void killProcessTree(subprocess);
  }, timeoutMs);
  let hardTimer: NodeJS.Timeout | undefined;
  const hardStop = new Promise<'hard'>((resolve) => {
    hardTimer = setTimeout(() => resolve('hard'), timeoutMs + KILL_GRACE_MS);
  });
  try {
    const settled = await Promise.race([subprocess, hardStop]);
    if (settled === 'hard') {
      // L'arbre n'a pas libéré ses flux dans le délai de grâce : on rend la main
      // (le kill a été demandé), jamais d'attente sans borne.
      timedOut = true;
      logger.error(
        { pid: subprocess.pid, timeoutMs },
        'git borné : flux non libérés après le kill, abandon de l’attente',
      );
      return { exitCode: null, output, truncated, timedOut };
    }
    return {
      exitCode: normalizeExitCode(settled.exitCode ?? null),
      output,
      truncated,
      timedOut,
    };
  } finally {
    clearTimeout(timer);
    clearTimeout(hardTimer);
  }
}

// --- Commit de merge ---------------------------------------------------------

/** Hooks que `git commit` exécute en concluant un merge. */
const COMMIT_HOOKS = ['pre-commit', 'pre-merge-commit', 'prepare-commit-msg', 'commit-msg'];

/** Sorties de git qui désignent l'identité ou la signature, pas un hook. */
const IDENTITY_FAILURE =
  /please tell me who you are|empty ident name|unable to auto-detect email|author identity unknown/i;
const SIGNING_FAILURE =
  /gpg failed to sign|failed to sign the data|could not run gpg|cannot run [^\n]*(gpg|sign)|failed to write commit object|ssh-keygen/i;

export interface CommitOutcome {
  ok: boolean;
  /** ok : commit fait ; hook : un hook de la cible a rejeté ; timeout : hook/signature bloqué, arbre tué ; other : identité, signature, disque… */
  kind: 'ok' | 'hook' | 'timeout' | 'other';
  output: string;
  truncated: boolean;
  exitCode: number | null;
}

/** Le dépôt a-t-il un hook exécuté par `git commit` ? (`core.hooksPath` respecté par git lui-même.) */
async function hasActiveCommitHook(root: string): Promise<boolean> {
  for (const name of COMMIT_HOOKS) {
    const located = await runBoundedGit({
      cwd: root,
      args: ['rev-parse', '--git-path', `hooks/${name}`],
      timeoutMs: PROBE_TIMEOUT_MS,
    });
    const relative = located.output.trim().split(/\r?\n/).pop() ?? '';
    if (located.exitCode !== 0 || !relative) continue;
    const info = await stat(path.resolve(root, relative)).catch(() => null);
    if (!info?.isFile()) continue;
    // POSIX : git ignore un hook sans bit exécutable.
    if (process.platform === 'win32' || (info.mode & 0o111) !== 0) return true;
  }
  return false;
}

/**
 * Exécute une commande git qui CRÉE UN COMMIT (`commit`, `revert`), hooks de la
 * cible compris, sous un délai dur. Ne lève jamais : l'issue est typée, l'appelant
 * (qui détient le verrou et l'état du merge) décide.
 */
export async function runCommitBounded(options: {
  root: string;
  args: string[];
  timeoutMs: number;
}): Promise<CommitOutcome> {
  const { root, args, timeoutMs } = options;
  const result = await runBoundedGit({ cwd: root, args, timeoutMs });
  const base = { output: result.output, truncated: result.truncated };
  if (!result.timedOut && result.exitCode === 0) {
    return { ...base, ok: true, kind: 'ok', exitCode: 0 };
  }
  if (result.timedOut) {
    // Un git tué en plein commit laisse son verrou d'index : l'arbre est mort
    // (kill d'arbre confirmé), le verrou est un débris — sans quoi l'annulation du
    // merge échouerait. Journalisé, jamais silencieux.
    await removeIndexLockAfterKill(root);
    return { ...base, ok: false, kind: 'timeout', exitCode: null };
  }
  if (IDENTITY_FAILURE.test(result.output) || SIGNING_FAILURE.test(result.output)) {
    return { ...base, ok: false, kind: 'other', exitCode: result.exitCode };
  }
  const hook = await hasActiveCommitHook(root);
  return { ...base, ok: false, kind: hook ? 'hook' : 'other', exitCode: result.exitCode };
}

/** Conclut le merge ouvert (`git commit -m`), hooks de la cible COMPRIS, sous un délai dur. */
export function commitMergeBounded(options: {
  root: string;
  message: string;
  timeoutMs: number;
}): Promise<CommitOutcome> {
  return runCommitBounded({
    root: options.root,
    args: ['commit', '-m', options.message],
    timeoutMs: options.timeoutMs,
  });
}

async function removeIndexLockAfterKill(root: string): Promise<void> {
  const located = await runBoundedGit({
    cwd: root,
    args: ['rev-parse', '--git-path', 'index.lock'],
    timeoutMs: PROBE_TIMEOUT_MS,
  });
  const relative = located.output.trim().split(/\r?\n/).pop() ?? '';
  if (located.exitCode !== 0 || !relative) return;
  const lock = path.resolve(root, relative);
  if (
    await stat(lock).then(
      () => false,
      () => true,
    )
  )
    return;
  await rm(lock, { force: true });
  logger.warn({ lock }, 'index.lock laissé par un git tué au délai de commit : supprimé');
}

// --- Livraison (push) ----------------------------------------------------------

export type DeliveryMode = 'push' | 'branch';

export interface DeliveryRequest {
  root: string;
  /** SHA EXACT testé — jamais `HEAD`. */
  sha: string;
  /** Nom court de la branche distante cible (sans `refs/heads/`) ; null si le nom n'a pu être validé. */
  ref: string | null;
  /** Raison pour laquelle `ref` est null. */
  refError?: string;
  /** Branche locale qui doit toujours contenir `sha` au moment du push (un rollback intercalé la ferait reculer). */
  localBranch: string;
  mode?: DeliveryMode;
  timeoutMs: number;
}

export interface DeliveryReport {
  mode: DeliveryMode;
  remote: 'origin';
  ref: string | null;
  sha: string;
  pushed: boolean;
  /** Le remote portait déjà ce SHA (livré par un push concurrent) : succès, sans nouveau push. */
  alreadyDelivered: boolean;
  /** Code stable d'échec (PUSH_*), null si livré. */
  code: string | null;
  message: string | null;
  hint: string | null;
  durationMs: number;
}

const SAFE_TASK_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

function stamp(now: Date): string {
  const iso = now.toISOString(); // 2026-10-26T08:09:10.000Z
  return `${iso.slice(0, 10).replaceAll('-', '')}-${iso.slice(11, 19).replaceAll(':', '')}`;
}

/**
 * `striart/<agent>/<taskId|date>` — dérivé de motifs VALIDÉS, jamais d'une donnée
 * brute : l'agent passe par `validateAgentName`, le taskId par un jeu de
 * caractères fermé (un taskId douteux retombe sur l'horodatage UTC).
 */
export function deliveryBranchName(options: {
  agent: string;
  taskId?: string | null;
  now?: Date;
}): string {
  const agent = validateAgentNameForRef(options.agent);
  const taskId = options.taskId;
  const safe =
    typeof taskId === 'string' &&
    SAFE_TASK_ID.test(taskId) &&
    !taskId.includes('..') &&
    !taskId.endsWith('.') &&
    !taskId.endsWith('.lock');
  return `striart/${agent}/${safe ? taskId : stamp(options.now ?? new Date())}`;
}

/** `striart/promote/<date>-<sha8>` : la promotion en mode branche. */
export function promotionBranchName(options: { sha: string; now?: Date }): string {
  if (!/^[0-9a-f]{7,64}$/.test(options.sha)) {
    throw new StriartError('SHA invalide pour le nom de branche de promotion.', {
      code: 'DELIVERY_REF_INVALID',
      details: { reason: 'SHA' },
    });
  }
  return `striart/promote/${stamp(options.now ?? new Date())}-${options.sha.slice(0, 8)}`;
}

function validateAgentNameForRef(agent: string): string {
  try {
    return validateAgentName(agent);
  } catch (error) {
    throw new StriartError(
      'Nom d’agent invalide : aucune branche de livraison ne peut en être dérivée.',
      { code: 'DELIVERY_REF_INVALID', details: { reason: 'AGENT_NAME' }, cause: error },
    );
  }
}

type DeliveryConfig = {
  delivery: DeliveryMode;
  targetBranch: string;
  mainBranch: string | null;
  pushTimeoutMs: number;
};

/** Plan de livraison d'un merge (`finalizeMergeCommit`) : le commit de merge testé. */
export function planMergeDelivery(options: {
  root: string;
  config: DeliveryConfig;
  agent: string;
  taskId: string | null;
  sha: string;
  now?: Date;
}): DeliveryRequest {
  const { root, config, agent, taskId, sha, now } = options;
  const base = {
    root,
    sha,
    localBranch: config.targetBranch,
    mode: config.delivery,
    timeoutMs: config.pushTimeoutMs,
  };
  if (config.delivery === 'push') return { ...base, ref: config.targetBranch };
  try {
    return { ...base, ref: deliveryBranchName({ agent, taskId, now }) };
  } catch (error) {
    return { ...base, ref: null, refError: (error as Error).message };
  }
}

/** Plan de livraison d'une promotion : main (mode push) ou une branche `striart/promote/…`. */
export function planPromotionDelivery(options: {
  root: string;
  config: DeliveryConfig;
  sha: string;
  now?: Date;
}): DeliveryRequest {
  const { root, config, sha, now } = options;
  const mainBranch = config.mainBranch as string;
  const base = {
    root,
    sha,
    localBranch: mainBranch,
    mode: config.delivery,
    timeoutMs: config.pushTimeoutMs,
  };
  if (config.delivery === 'push') return { ...base, ref: mainBranch };
  try {
    return { ...base, ref: promotionBranchName({ sha, now }) };
  } catch (error) {
    return { ...base, ref: null, refError: (error as Error).message };
  }
}

function failure(
  request: DeliveryRequest,
  startedAt: number,
  code: string,
  message: string,
  hint: string,
): DeliveryReport {
  return {
    mode: request.mode ?? 'push',
    remote: 'origin',
    ref: request.ref,
    sha: request.sha,
    pushed: false,
    alreadyDelivered: false,
    code,
    message: redactRemoteCredentials(message),
    hint,
    durationMs: Date.now() - startedAt,
  };
}

/** `pushError` historique (chaîne) dérivé du rapport : `[CODE] message`. */
export function deliveryErrorText(report: DeliveryReport): string | null {
  if (report.pushed) return null;
  return `[${report.code}] ${report.message ?? ''}`.trim();
}

const NON_FAST_FORWARD =
  /non-fast-forward|fetch first|\[rejected\]|stale info|tip of your current branch is behind/i;

/**
 * Pousse le SHA EXACT `request.sha` vers `refs/heads/<ref>` d'`origin`, sans
 * JAMAIS forcer. Ne lève pas : l'issue est un rapport typé (le merge local reste
 * valide, l'échec reste visible).
 *
 *  - SUPERSEDED : le SHA n'est plus dans la branche locale (un rollback est
 *    intervenu entre le merge et le push) — publier ce SHA publierait un travail
 *    défait ;
 *  - NON_FAST_FORWARD : `origin` a avancé hors de Striart. Si le remote porte déjà
 *    notre SHA (un push concurrent plus récent le contient), c'est un succès ;
 *  - TIMEOUT : hook pre-push, authentification ou réseau bloqués — l'arbre est tué.
 */
export async function deliverSha(request: DeliveryRequest): Promise<DeliveryReport> {
  const startedAt = Date.now();
  const { root, sha, ref, localBranch, timeoutMs } = request;
  if (ref === null) {
    return failure(
      request,
      startedAt,
      'DELIVERY_REF_INVALID',
      request.refError ?? 'aucune branche de livraison valide',
      'striart doctor',
    );
  }

  const reachable = await runBoundedGit({
    cwd: root,
    args: ['merge-base', '--is-ancestor', sha, `refs/heads/${localBranch}`],
    timeoutMs: PROBE_TIMEOUT_MS,
  });
  if (reachable.exitCode === 1) {
    return failure(
      request,
      startedAt,
      'PUSH_SUPERSEDED',
      `${sha.slice(0, 8)} n'est plus dans ${localBranch} (rollback ou réécriture depuis le merge) : rien n'a été publié.`,
      `git log --oneline -5 ${localBranch}`,
    );
  }
  if (reachable.exitCode !== 0) {
    return failure(
      request,
      startedAt,
      'PUSH_FAILED',
      `vérification locale impossible avant le push (${localBranch}) : ${reachable.output.trim().slice(-300)}`,
      'git status',
    );
  }

  const refspec = `${sha}:refs/heads/${ref}`;
  const pushed = await runBoundedGit({
    cwd: root,
    args: ['push', '--porcelain', 'origin', refspec],
    timeoutMs,
  });
  if (!pushed.timedOut && pushed.exitCode === 0) {
    return {
      mode: request.mode ?? 'push',
      remote: 'origin',
      ref,
      sha,
      pushed: true,
      alreadyDelivered: false,
      code: null,
      message: null,
      hint: null,
      durationMs: Date.now() - startedAt,
    };
  }
  if (pushed.timedOut) {
    return failure(
      request,
      startedAt,
      'PUSH_TIMEOUT',
      `push vers origin/${ref} interrompu après ${timeoutMs} ms (hook pre-push, authentification ou réseau bloqué) : l'arbre de process a été tué, le merge local reste valide.`,
      `augmente pushTimeoutMs, ou pousse à la main : git push origin ${refspec}`,
    );
  }

  const text = pushed.output.trim();
  if (NON_FAST_FORWARD.test(text)) {
    if (await remoteAlreadyHas(root, sha, ref, timeoutMs)) {
      return {
        mode: request.mode ?? 'push',
        remote: 'origin',
        ref,
        sha,
        pushed: true,
        alreadyDelivered: true,
        code: null,
        message: null,
        hint: null,
        durationMs: Date.now() - startedAt,
      };
    }
    return failure(
      request,
      startedAt,
      'PUSH_NON_FAST_FORWARD',
      `origin/${ref} a avancé hors de Striart : push refusé (Striart ne force jamais). Le merge local reste valide.`,
      `git fetch origin && git merge origin/${ref} (ou rebase), puis git push origin ${localBranch}`,
    );
  }
  const rejected =
    /\[remote rejected\]|\[rejected\]|hook declined|pre-receive|protected branch|denied/i.test(
      text,
    );
  return failure(
    request,
    startedAt,
    rejected ? 'PUSH_REJECTED' : 'PUSH_FAILED',
    text.slice(-500) || `git push a échoué (sortie ${pushed.exitCode})`,
    rejected
      ? `le remote ou un hook pre-push a refusé le push ; corrige la cause puis : git push origin ${refspec}`
      : `git remote -v ; git push origin ${refspec}`,
  );
}

/** Le SHA de `origin/<ref>` contient-il `sha` ? (sonde `ls-remote` + ancêtre local.) */
async function remoteAlreadyHas(
  root: string,
  sha: string,
  ref: string,
  timeoutMs: number,
): Promise<boolean> {
  const listed = await runBoundedGit({
    cwd: root,
    args: ['ls-remote', 'origin', `refs/heads/${ref}`],
    timeoutMs,
  });
  if (listed.exitCode !== 0 || listed.timedOut) return false;
  const remoteSha = listed.output.trim().split(/\s+/)[0] ?? '';
  if (!/^[0-9a-f]{40,64}$/.test(remoteSha)) return false;
  if (remoteSha === sha) return true;
  const ancestor = await runBoundedGit({
    cwd: root,
    args: ['merge-base', '--is-ancestor', sha, remoteSha],
    timeoutMs: PROBE_TIMEOUT_MS,
  });
  return ancestor.exitCode === 0;
}

// --- Sérialisation ----------------------------------------------------------------

/**
 * Chaîne de livraisons par dépôt, dans le process : deux merges successifs
 * poussent chacun le leur ; hors verrou, l'ordre d'arrivée des pushs n'est plus
 * celui des merges — sans cette chaîne, le push du premier arriverait derrière celui
 * du second (déjà fast-forward-incluant) et serait refusé à tort. Entre process
 * (watch + CLI), `remoteAlreadyHas` traite le même cas.
 */
const chains = new Map<string, Promise<void>>();

export function deliverSerialized(request: DeliveryRequest): Promise<DeliveryReport> {
  const key = path.resolve(request.root);
  const previous = chains.get(key) ?? Promise.resolve();
  const run = previous
    .then(() => deliverSha(request))
    // deliverSha ne lève pas ; si un défaut inattendu survient, il devient un échec de
    // livraison NOMMÉ et journalisé (le merge local reste valide), jamais un rejet muet.
    .catch((error: unknown) => {
      logger.error({ err: error }, 'Livraison : défaut inattendu');
      return failure(
        request,
        Date.now(),
        'PUSH_FAILED',
        String((error as Error)?.message ?? error).slice(0, 500),
        'striart doctor',
      );
    });
  const tail = run.then(
    () => undefined,
    () => undefined,
  );
  chains.set(key, tail);
  void tail.then(() => {
    if (chains.get(key) === tail) chains.delete(key);
  });
  return run;
}

/** Attend les livraisons en cours de CE process pour ce dépôt (rollback : « poussé ? » doit être définitif). */
export async function settlePendingDeliveries(root: string): Promise<void> {
  await chains.get(path.resolve(root));
}

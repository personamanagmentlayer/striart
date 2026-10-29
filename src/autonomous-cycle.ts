/**
 * Primitive UNIQUE de fin de session autonome : session terminée → contrat de
 * commit → merge (garde des chemins protégés comprise) → nettoyage SANS force
 * → statut / keptCode / keptDetail.
 *
 * Cette suite existait en trois copies (`runAutonomousTask` dans
 * orchestrator.js, `runTurn`/`finalizeClone` dans orchestration/unit.ts,
 * `concludeProxySession` dans acp-agent/cycle.ts) qui dérivaient doucement
 * l'une de l'autre. Elle vit ici, en couches que les trois appelants composent :
 *
 *  - `applyCommitContract`   : le contrat de commit (lot I3), réutilisable seul
 *    par un tour d'orchestration (le tour a sa propre ligne de base) ;
 *  - `mergeAndCleanClone`    : merge sous Test Gate puis nettoyage sans `force` ;
 *  - `concludeAutonomousSession` : le cycle complet d'un clone dont la session
 *    vient de se terminer (runAutonomousTask, proxy ACP).
 *
 * Invariants (décision architecturale n°6, tous repris tels quels) :
 *  - le verrou principal n'est JAMAIS tenu ici : `mergeAgentCommit` et
 *    `cleanClones` le prennent chacun brièvement de leur côté ;
 *  - pendant le commit Striart, `sessionPid` désigne CE process (une seule
 *    écriture remplace le PID de l'agent mort : aucune fenêtre où un sync
 *    stasherait le worktree), puis il est dépublié AVANT le merge (sa garde
 *    SESSION_LIVE verrait ce process vivant) ;
 *  - le clone n'est supprimé que sur le chemin entièrement vert, et le
 *    nettoyage n'utilise jamais `force` : les garde-fous de `cleanClones`
 *    (travail non mergé, session vivante, clone occupé) gardent le dernier mot ;
 *  - AUCUN signal d'annulation n'entre ici : Ctrl+C arrête la SESSION (arbre
 *    tué en amont, statut CANCELLED) ; une fois le merge commencé il n'est
 *    jamais interrompu — il tient son verrou brièvement et un second Ctrl+C
 *    reste couvert par la récupération après coupure (verrou et merge
 *    orphelins). Un paramètre `signal` ici serait un mensonge : rien ne
 *    l'honorerait.
 *
 * Décisions de convergence entre les trois copies (documentées, pas
 * silencieuses) :
 *  - merge `UP_TO_DATE` avec `alreadyMerged` (le commit de l'agent est déjà dans
 *    la cible) : décision UNIQUE pour les trois appelants — le travail est
 *    intégré, MERGED + nettoyage, mais BRUYANT : avertissement `ALREADY_INTEGRATED`
 *    dans le résultat, événement `session:already-integrated`, et `merge.mergeSha`
 *    désigne le commit de la cible qui porte déjà le travail. Aucun Test Gate n'est
 *    rejoué (rien n'est mergé). Un `UP_TO_DATE` sans `alreadyMerged` (rien de neuf)
 *    reste un merge bloqué : jamais de clone supprimé sur « rien à merger » ;
 *  - `commitPolicy: 'human'` : si l'agent a committé, AUCUN merge — statut `KEPT`,
 *    keptCode `HUMAN_REVIEW_REQUIRED`, clone conservé pour revue ;
 *  - une annulation (Ctrl+C) n'émet pas `session:failed` : l'arrêt est voulu ;
 *  - le libellé des raisons est fixé par `wording` : `'runner'` (français,
 *    `striart run --autonomous`) ou `'acp-proxy'` (anglais, affiché à l'éditeur) ;
 *  - l'événement `session:striart-commit` n'est émis que si `announce` (un tour
 *    d'orchestration publie ses propres événements `collab:turn`).
 */
import { cleanClones, cloneGit, readRegistry, updateAgentMeta } from './clone.ts';
import {
  commitSessionLeftovers,
  resolveCommitPolicy,
  striartShouldCommit,
} from './commit-policy.ts';
import type { LeftoverCommitOutcome } from './commit-policy.ts';
import { loadConfig } from './config.ts';
import { StriartError } from './errors.ts';
import { emitStriartEvent } from './events.ts';
import { logger } from './logger.ts';
import { mergeAgentCommit } from './orchestrator.ts';
import { isFailedSessionStatus, sessionFailureMarker } from './session-failure.ts';
import type {
  AcpProxyResult,
  AgentMeta,
  AgentProfile,
  AutonomousKeptCode,
  AutonomousWarningCode,
  CommitPolicy,
  MergeResult,
  SessionResult,
  StriartCommitResult,
  StriartConfig,
} from './types.js';

export type CycleAgentInfo = AgentMeta & { name: string };

/** Issue du cycle : `AutonomousResult` plus les cas propres au proxy ACP (`KEPT`, `NOTHING_STARTED`). */
export type CycleOutcome = AcpProxyResult;

/** Langue et ton des raisons de conservation : 'runner' (français), 'acp-proxy' (anglais). */
export type CycleWording = 'runner' | 'acp-proxy';

/** Raisons d'un clone conservé sans rien à merger (même contrat que `AutonomousResult`). */
type EmptyCode = Extract<AutonomousKeptCode, 'NO_COMMIT' | 'NO_CHANGES' | 'ONLY_EXCLUDED_CHANGES'>;

// -------------------------------------------------------------------------
// Libellés
// -------------------------------------------------------------------------

interface Wording {
  sessionFailedEvent: (name: string, session: SessionResult) => string;
  sessionFailedKept: (name: string, session: SessionResult) => string;
  commitFailedLog: string;
  commitFailed: (code: string, message: string) => string;
  commitRefused: (reason: string) => string;
  empty: Record<EmptyCode, (policy: CommitPolicy) => string>;
  humanReview: (name: string) => string;
  mergeBlocked: (status: string) => string;
  mergeDeferredManual: (name: string) => string;
  mergeDeferredDisconnected: (name: string) => string;
  cleanupSkipped: (reason: string | null) => string;
  neverStarted: (reason: string | null) => string;
}

function budgetClause(session: SessionResult): string {
  const b = session.budget;
  return b ? `${b.scope}, ${b.metric}: ${b.used}/${b.limit}` : 'plafond de tokens';
}

const FR: Wording = {
  sessionFailedEvent: (name, session) =>
    session.status === 'BUDGET_EXCEEDED'
      ? `⛔ [Striart] Session autonome de ${name} arrêtée : budget de tokens franchi (${budgetClause(session)}). Clone conservé, rien n'a été mergé — consulte "striart usage". Log : ${session.logPath}`
      : `⛔ [Striart] Session autonome de ${name} : ${session.status}. Clone conservé, log : ${session.logPath}`,
  sessionFailedKept: (name, session) =>
    session.status === 'BUDGET_EXCEEDED'
      ? `Budget de tokens franchi (${budgetClause(session)}) — session arrêtée, rien n'a été mergé, clone conservé (log : ${session.logPath}). Consulte "striart usage", relève tokens.budgets si c'est voulu, ou relis le travail du clone avant de le merger à la main (striart merge ${name}).`
      : `Session ${session.status} — clone conservé pour diagnostic (log : ${session.logPath}).`,
  commitFailedLog: 'Commit Striart en échec',
  commitFailed: (code, message) =>
    `Commit Striart impossible (${code}) : ${message} — clone conservé, rien n'a été mergé.`,
  commitRefused: (reason) =>
    `Commit Striart refusé (${reason}) : l'état du clone est ambigu — clone conservé pour décision humaine.`,
  empty: {
    NO_COMMIT: (policy) =>
      policy === 'human'
        ? "commitPolicy 'human' : personne ne committe, le travail reste dans le clone pour revue humaine."
        : "L'agent est sorti en 0 sans produire de commit — rien à merger, clone conservé.",
    NO_CHANGES: () =>
      "L'agent est sorti sans aucune modification — rien à committer ni à merger, clone conservé.",
    ONLY_EXCLUDED_CHANGES: () =>
      "Seuls des fichiers exclus du commit restaient (secrets, fichiers injectés par Striart) — rien n'a été committé, clone conservé.",
  },
  humanReview: (name) =>
    `commitPolicy 'human' : l'agent a committé mais personne ne merge automatiquement — clone conservé pour revue humaine ; lance "striart merge ${name}" après relecture.`,
  mergeBlocked: (status) =>
    `Merge ${status} — clone conservé, le travail de l'agent n'est pas perdu.`,
  mergeDeferredManual: (name) =>
    `Merge laissé à ta main (acpAgent.merge: manual) — lance "striart merge ${name}" le moment venu.`,
  mergeDeferredDisconnected: (name) =>
    `L'éditeur s'est déconnecté sans finir la session — clone conservé, non mergé ; lance "striart merge ${name}" le moment venu.`,
  cleanupSkipped: (reason) =>
    `Merge réussi mais nettoyage sauté (${reason ?? 'raison inconnue'}) — clone conservé.`,
  neverStarted: (reason) =>
    `Aucun tour n'a tourné dans ce clone, mais il n'a pas pu être retiré (${reason ?? 'raison inconnue'}) — clone conservé.`,
};

const EN: Wording = {
  sessionFailedEvent: (name, session) =>
    session.status === 'BUDGET_EXCEEDED'
      ? `⛔ [Striart] IDE session (striart acp) of ${name} stopped: token budget exceeded (${budgetClause(session)}). Clone kept, nothing merged — see "striart usage". Log: ${session.logPath}`
      : `⛔ [Striart] Session IDE (striart acp) de ${name} : ${session.status}. Clone conservé, log : ${session.logPath}`,
  sessionFailedKept: (name, session) =>
    session.status === 'BUDGET_EXCEEDED'
      ? `Token budget exceeded (${budgetClause(session)}) — session stopped, nothing merged, clone kept (log: ${session.logPath}). Check "striart usage", raise tokens.budgets if intended, or review the clone's work before merging it by hand (striart merge ${name}).`
      : `Session ${session.status} — clone kept for diagnosis (log: ${session.logPath}).`,
  commitFailedLog: 'Commit Striart en échec (striart acp)',
  commitFailed: (code) =>
    `Striart could not commit the leftovers (${code}) — clone kept, nothing merged.`,
  commitRefused: (reason) =>
    `Striart commit refused (${reason}): the clone state is ambiguous — clone kept for a human decision.`,
  empty: {
    NO_COMMIT: (policy) =>
      policy === 'human'
        ? "commitPolicy 'human': nobody commits, the work stays in the clone for human review."
        : 'The agent produced no commit — nothing to merge, clone kept.',
    NO_CHANGES: () => 'The agent left no change — nothing to commit or merge, clone kept.',
    ONLY_EXCLUDED_CHANGES: () =>
      'Only files excluded from commits were left (secrets, files injected by Striart) — nothing committed, clone kept.',
  },
  humanReview: (name) =>
    `commitPolicy 'human': the agent committed but nobody merges automatically — clone kept for human review; run "striart merge ${name}" after reviewing.`,
  mergeBlocked: (status) => `Merge ${status} — clone kept, the agent's work is not lost.`,
  mergeDeferredManual: (name) =>
    `Merge left to you (acpAgent.merge: manual) — run "striart merge ${name}" when ready.`,
  mergeDeferredDisconnected: (name) =>
    `The editor disconnected without finishing the session — clone kept unmerged; run "striart merge ${name}" when ready.`,
  cleanupSkipped: (reason) =>
    `Merged, but the clone cleanup was skipped (${reason ?? 'unknown reason'}) — clone kept.`,
  neverStarted: (reason) =>
    `No turn ran in this clone, but it could not be removed (${reason ?? 'unknown reason'}) — clone kept.`,
};

const WORDINGS: Record<CycleWording, Wording> = { runner: FR, 'acp-proxy': EN };

// -------------------------------------------------------------------------
// Briques
// -------------------------------------------------------------------------

/** Pointe de la branche de TÂCHE du clone (c'est elle que le merge récupère), null si illisible. */
export async function branchTip(meta: CycleAgentInfo): Promise<string | null> {
  const out = await cloneGit(meta.path)
    .raw(['rev-parse', '-q', '--verify', `refs/heads/${meta.branch}`])
    .catch(() => '');
  return out.trim() || null;
}

/** Écriture de `sessionPid` en échec : nommée au journal, jamais muette. */
function warnPidWrite(agent: string, message: string): (error: unknown) => void {
  return (error: unknown) => {
    logger.warn({ agent, err: error }, message);
  };
}

async function emit(
  config: StriartConfig,
  event: Parameters<typeof emitStriartEvent>[1],
): Promise<void> {
  await emitStriartEvent(config, event).catch((error: unknown) => {
    logger.warn({ err: error }, 'Émission d’événement en échec (ignorée)');
  });
}

export interface CommitContractSpec {
  root: string;
  config: StriartConfig;
  meta: CycleAgentInfo;
  profileKey: string;
  profile: AgentProfile;
  /** Message des commits Striart (la tâche du clone). */
  prompt: string;
  /** Politique résolue (`resolveCommitPolicy`). */
  policy: CommitPolicy;
  /** Pointe de la branche de tâche AVANT la session/le tour : « l'agent a committé » = elle a bougé. */
  baselineTip: string | null;
  /** Émettre `session:striart-commit` (+ journal d'information) après un commit. */
  announce: boolean;
  wording: CycleWording;
  /** Champs ajoutés aux journaux d'erreur (rôle d'un tour d'orchestration…). */
  logFields?: Record<string, unknown>;
}

export type CommitContractResult =
  | { kind: 'done'; commit: StriartCommitResult }
  | { kind: 'failed'; code: string; message: string }
  | { kind: 'refused'; reason: string };

/**
 * Contrat de commit (lot I3) : si la politique demande à Striart de committer ce
 * que l'agent a laissé, le fait. Ne lève jamais pour un échec de commit : rend
 * `failed` (git, hook, identité) ou `refused` (état du clone ambigu) — l'appelant
 * décide du statut et conserve le clone.
 */
export async function applyCommitContract(spec: CommitContractSpec): Promise<CommitContractResult> {
  const { root, config, meta, profileKey, profile, prompt, policy, baselineTip, wording } = spec;
  const name = meta.name;
  const agentCommitted = (await branchTip(meta)) !== baselineTip;
  if (!striartShouldCommit(policy, agentCommitted)) {
    return {
      kind: 'done',
      commit: {
        policy,
        status: 'SKIPPED_AGENT_COMMITTED',
        sha: null,
        files: [],
        excluded: { secrets: [], injected: [] },
        author: null,
        committer: null,
      },
    };
  }
  let outcome: LeftoverCommitOutcome;
  try {
    outcome = await commitSessionLeftovers({
      root,
      clonePath: meta.path,
      branch: meta.branch,
      agent: name,
      profileKey,
      profile,
      config,
      taskId: meta.taskId,
      prompt,
      policy,
    });
  } catch (error) {
    const code = error instanceof StriartError ? error.code : 'GIT_FAILED';
    logger.error({ agent: name, ...spec.logFields, err: error }, WORDINGS[wording].commitFailedLog);
    return { kind: 'failed', code, message: (error as Error).message };
  }
  if (outcome.status === 'REFUSED') return { kind: 'refused', reason: outcome.reason };
  if (outcome.status !== 'COMMITTED') {
    return {
      kind: 'done',
      commit: {
        policy,
        status: 'NOTHING_TO_COMMIT',
        sha: null,
        files: [],
        excluded: outcome.excluded,
        author: null,
        committer: null,
      },
    };
  }
  if (spec.announce) {
    logger.info(
      { agent: name, sha: outcome.sha, files: outcome.files.length, policy },
      'Commit Striart créé',
    );
    await emit(config, {
      type: 'session:striart-commit',
      agent: name,
      sha: outcome.sha,
      files: outcome.files.length,
      message: `📝 [Striart] ${name} : ${outcome.files.length} fichier(s) laissé(s) par l'agent, committé(s) par Striart (${outcome.sha.slice(0, 8)}, commitPolicy ${policy}).`,
    });
  }
  return {
    kind: 'done',
    commit: {
      policy,
      status: 'COMMITTED',
      sha: outcome.sha,
      files: outcome.files,
      excluded: outcome.excluded,
      author: outcome.author,
      committer: outcome.committer,
    },
  };
}

/**
 * Nettoyage du clone d'un cycle terminé. `force` reste FAUX : les garde-fous de
 * `cleanClones` (travail non mergé, session vivante, clone verrouillé) gardent le
 * dernier mot — un refus n'est pas un obstacle à contourner mais un signal à
 * remonter. `sessionEnded` court-circuite seulement l'heuristique de présence
 * disque : la mort constatée du process est une information strictement meilleure.
 */
export async function cleanupClone(
  root: string,
  name: string,
): Promise<{ removed: boolean; skippedReason: string | null }> {
  const cleanup = await cleanClones({
    root,
    agent: name,
    all: true,
    force: false,
    sessionEnded: true,
  });
  const removed = cleanup.removed.some((r: { name: string }) => r.name === name);
  const skipped = cleanup.skipped.find((s: { name: string }) => s.name === name);
  return { removed, skippedReason: skipped?.reason ?? null };
}

export type MergeAndCleanResult =
  | { kind: 'blocked'; merge: MergeResult; detail: string }
  | {
      kind: 'merged';
      merge: MergeResult;
      cleaned: boolean;
      /** Motif du refus de nettoyage (null si le clone a été retiré). */
      skippedReason: string | null;
      /** Le commit de l'agent était déjà dans la cible : rien n'a été mergé ni testé. */
      alreadyIntegrated: boolean;
    };

/**
 * Merge sous Test Gate puis nettoyage sans `force`. `UP_TO_DATE` avec
 * `alreadyMerged` (le commit de l'agent est déjà dans la cible, arrivé par un
 * autre chemin) n'est PAS un échec : le travail est intégré, rien à merger ni à
 * débloquer, le cycle va au nettoyage — mais le succès est bruyant (événement
 * `session:already-integrated`, `alreadyIntegrated: true` rendu à l'appelant).
 * Un `UP_TO_DATE` sans `alreadyMerged` (rien de neuf) reste bloqué : un clone
 * n'est jamais supprimé sur « rien à merger ».
 */
export async function mergeAndCleanClone(spec: {
  root: string;
  name: string;
}): Promise<MergeAndCleanResult> {
  const merge = await mergeAgentCommit({ root: spec.root, agent: spec.name });
  const alreadyIntegrated = merge.status === 'UP_TO_DATE' && merge.alreadyMerged === true;
  if (merge.status !== 'MERGED' && !alreadyIntegrated) {
    return {
      kind: 'blocked',
      merge,
      detail: merge.status === 'CONFLICT' ? merge.reason : merge.status,
    };
  }
  if (alreadyIntegrated) {
    const config = await loadConfig(spec.root);
    const sha = merge.status === 'UP_TO_DATE' ? merge.sha : '';
    await emit(config, {
      type: 'session:already-integrated',
      agent: spec.name,
      sha,
      message: `ℹ️ [Striart] Le commit de ${spec.name} (${sha.slice(0, 8)}) était déjà dans ${config.targetBranch} (arrivé par un autre chemin) : rien à merger, Test Gate non rejoué — clone nettoyé.`,
    });
  }
  const { removed, skippedReason } = await cleanupClone(spec.root, spec.name);
  return { kind: 'merged', merge, cleaned: removed, skippedReason, alreadyIntegrated };
}

// -------------------------------------------------------------------------
// Cycle complet
// -------------------------------------------------------------------------

export interface ConcludeSessionSpec {
  root: string;
  config: StriartConfig;
  meta: CycleAgentInfo;
  profileKey: string;
  /** Profil résolu (contrat de commit, identité des commits). */
  profile: AgentProfile;
  /** Session terminée dans le clone (tout statut). */
  session: SessionResult;
  /** Tâche du clone (message des commits Striart). */
  prompt: string;
  wording: CycleWording;
  /** Défaut : merge immédiat. `{ deferred }` : clone conservé, merge laissé à l'humain (`MERGE_DEFERRED`). */
  mergeMode?: 'auto' | { deferred: 'MANUAL' | 'DISCONNECTED' };
}

/**
 * Conclut un clone dont la session vient de se terminer : contrat de commit,
 * contrôle « quelque chose à merger ? », merge (garde des chemins protégés
 * comprise), nettoyage. Ne lève pas pour un échec de l'agent ni du commit : rend
 * un statut et conserve le clone avec une raison. Lève seulement une erreur du
 * noyau (verrou, session principale déclarée…) — l'appelant la rend explicite.
 */
export async function concludeAutonomousSession(spec: ConcludeSessionSpec): Promise<CycleOutcome> {
  const { root, config, meta, profileKey, profile, session, prompt } = spec;
  const w = WORDINGS[spec.wording];
  const name = meta.name;
  const base: Pick<
    CycleOutcome,
    'agent' | 'session' | 'merge' | 'commit' | 'cleaned' | 'clonePath' | 'warnings'
  > = {
    agent: name,
    session,
    merge: null,
    commit: null,
    cleaned: false,
    clonePath: meta.path,
    warnings: [],
  };
  const kept = (
    status: CycleOutcome['status'],
    keptCode: NonNullable<CycleOutcome['keptCode']>,
    keptDetail: string | null,
    keptReason: string,
  ): CycleOutcome => ({ ...base, status, keptCode, keptDetail, keptReason });

  const policy = resolveCommitPolicy(config, profile);
  // Commit Striart à venir : le clone reste intouchable jusqu'à sa fin. Le PID de
  // l'agent (mort) est REMPLACÉ par celui de ce process en UNE écriture — aucune
  // fenêtre où un sync de watch stasherait/rebaserait le worktree pendant qu'on en
  // lit le statut et qu'on l'indexe. Sinon : dépublication immédiate.
  const commitStep = session.status === 'COMPLETED' && policy !== 'agent' && policy !== 'human';
  // Marqueur d'échec (session-failure.ts), écrit dans la MÊME mise à jour que la dépublication du
  // PID : aucune fenêtre où le clone est « sans session » sans que l'on sache qu'elle a échoué.
  // Un doute sur les commits (lecture de la branche impossible) vaut « il y en a » : fail closed.
  let sessionFailure: AgentMeta['sessionFailure'] = null;
  if (isFailedSessionStatus(session.status)) {
    const hasCommits = await branchTip(meta).then(
      (tip) => tip !== meta.baseCommit,
      () => true,
    );
    // `meta` date de la création du clone : le départ de session est celui du REGISTRE.
    const current = ((await readRegistry(root).catch(() => ({}))) as Record<string, AgentMeta>)[
      name
    ];
    sessionFailure = sessionFailureMarker(
      { sessionStartedAt: current?.sessionStartedAt ?? null },
      session.status,
      hasCommits,
    );
  }
  await updateAgentMeta(root, name, {
    sessionPid: commitStep ? process.pid : null,
    sessionOwnerPid: null,
    sessionFailure,
  }).catch(warnPidWrite(name, 'Remplacement du PID de session par celui de ce process impossible'));

  if (session.status !== 'COMPLETED') {
    // Un arrêt demandé (Ctrl+C) est voulu : pas d'alerte « session échouée »
    // vers les webhooks. Tout autre statut (échec, délai, plafond de tokens) l'est.
    if (session.status === 'CANCELLED') {
      logger.info({ agent: name }, 'Session annulée sur demande — aucun événement session:failed');
    } else {
      await emit(config, {
        type: 'session:failed',
        agent: name,
        status: session.status,
        logPath: session.logPath,
        message: w.sessionFailedEvent(name, session),
      });
    }
    return kept(
      'SESSION_FAILED',
      'SESSION_FAILED',
      session.status,
      w.sessionFailedKept(name, session),
    );
  }

  if (commitStep) {
    try {
      const contract = await applyCommitContract({
        root,
        config,
        meta,
        profileKey,
        profile,
        prompt,
        policy,
        baselineTip: meta.baseCommit,
        announce: true,
        wording: spec.wording,
      });
      if (contract.kind === 'failed') {
        return kept(
          'COMMIT_FAILED',
          'COMMIT_FAILED',
          contract.code,
          w.commitFailed(contract.code, contract.message),
        );
      }
      if (contract.kind === 'refused') {
        return kept(
          'COMMIT_REFUSED',
          'COMMIT_REFUSED',
          contract.reason,
          w.commitRefused(contract.reason),
        );
      }
      base.commit = contract.commit;
    } finally {
      // Dépublié AVANT le merge : sa garde SESSION_LIVE verrait ce process vivant.
      await updateAgentMeta(root, name, { sessionPid: null, sessionOwnerPid: null }).catch(
        warnPidWrite(name, 'Dépublication du PID de session impossible'),
      );
    }
  }

  // Rien de neuf sur la branche de tâche : ni succès ni échec, un troisième cas.
  // Le traiter comme un succès serait un faux positif silencieux (on supprimerait
  // un clone en croyant avoir mergé du travail inexistant).
  if ((await branchTip(meta)) === meta.baseCommit) {
    const excludedCount =
      (base.commit?.excluded.secrets.length ?? 0) + (base.commit?.excluded.injected.length ?? 0);
    const code: EmptyCode = !commitStep
      ? 'NO_COMMIT'
      : excludedCount > 0
        ? 'ONLY_EXCLUDED_CHANGES'
        : 'NO_CHANGES';
    const reason = w.empty[code](policy);
    await emit(config, {
      type: 'session:empty',
      agent: name,
      message: `⚠️ [Striart] Agent ${name} : ${reason}`,
    });
    return kept('EMPTY', code, policy, reason);
  }

  // `commitPolicy: 'human'` : personne ne committe NI ne merge. Si l'agent a
  // committé quand même, son travail attend la revue humaine — jamais de merge
  // automatique contre le contrat documenté de la politique.
  if (policy === 'human') {
    return kept('KEPT', 'HUMAN_REVIEW_REQUIRED', policy, w.humanReview(name));
  }

  if (spec.mergeMode && spec.mergeMode !== 'auto') {
    const deferred = spec.mergeMode.deferred;
    return kept(
      'KEPT',
      'MERGE_DEFERRED',
      deferred,
      deferred === 'MANUAL' ? w.mergeDeferredManual(name) : w.mergeDeferredDisconnected(name),
    );
  }

  const done = await mergeAndCleanClone({ root, name });
  base.merge = done.merge;
  if (done.kind === 'blocked') {
    return kept('MERGE_BLOCKED', 'MERGE_BLOCKED', done.detail, w.mergeBlocked(done.merge.status));
  }
  if (done.alreadyIntegrated) base.warnings = ['ALREADY_INTEGRATED'];
  if (done.cleaned) {
    return {
      ...base,
      status: 'MERGED',
      cleaned: true,
      keptReason: null,
      keptCode: null,
      keptDetail: null,
    };
  }
  return kept(
    'MERGED',
    'CLEANUP_SKIPPED',
    done.skippedReason,
    w.cleanupSkipped(done.skippedReason),
  );
}

/**
 * Clone créé mais aucun tour joué (proxy ACP : tour annulé avant le premier
 * prompt) : un clone vierge se retire par les garde-fous ordinaires de
 * `cleanClones` (jamais `force`) ; un refus le conserve.
 */
export async function concludeUnstartedClone(spec: {
  root: string;
  meta: CycleAgentInfo;
  wording: CycleWording;
}): Promise<CycleOutcome> {
  const { root, meta } = spec;
  const base = {
    agent: meta.name,
    session: null,
    merge: null,
    commit: null,
    clonePath: meta.path,
    warnings: [] as AutonomousWarningCode[],
  };
  await updateAgentMeta(root, meta.name, { sessionPid: null, sessionOwnerPid: null }).catch(
    warnPidWrite(meta.name, 'Dépublication du PID de session impossible'),
  );
  const { removed, skippedReason } = await cleanupClone(root, meta.name);
  if (removed) {
    return {
      ...base,
      status: 'NOTHING_STARTED',
      cleaned: true,
      keptCode: null,
      keptDetail: null,
      keptReason: null,
    };
  }
  return {
    ...base,
    status: 'NOTHING_STARTED',
    cleaned: false,
    keptCode: 'CLEANUP_SKIPPED',
    keptDetail: skippedReason,
    keptReason: WORDINGS[spec.wording].neverStarted(skippedReason),
  };
}

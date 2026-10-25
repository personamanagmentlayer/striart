/**
 * Contrat de commit des sessions autonomes (lot I3, décisions D3/D14).
 *
 * `commitPolicy` (global, surchargeable par profil) décide qui committe le
 * travail laissé par une session autonome sortie COMPLETED :
 *  - 'agent'              : l'agent seul (défaut — comportement historique) ;
 *  - 'agent-then-striart' : l'agent ; s'il n'a rien committé, Striart committe
 *                           ce qu'il a laissé dans le worktree ;
 *  - 'striart'            : Striart committe toujours le reste non committé ;
 *  - 'human'              : personne — le clone est conservé pour revue.
 *
 * Le commit Striart est ensuite traité EXACTEMENT comme un commit d'agent :
 * garde des chemins protégés, rebase, fusion, Test Gate. Invariants :
 *  - jamais un fichier exclu : `secretPatterns` (sémantique gitignore, évaluée
 *    par git lui-même) ni un fichier injecté par Striart (consignes, mémoire —
 *    déclarés dans le `.git/info/exclude` du clone), même suivi, même déjà
 *    indexé par l'agent (commit `--only` : l'index de l'agent n'est pas
 *    utilisé tel quel) — et c'est revérifié sur le commit produit ;
 *  - auteur = profil d'agent (nom + e-mail configurables), committer =
 *    identité git de l'utilisateur, lue dans le repo PRINCIPAL (la config
 *    locale du principal n'est pas héritée par un clone) ;
 *  - jamais sur un clone dans un état ambigu (hors de sa branche de tâche,
 *    merge/rebase/cherry-pick en cours, chemins non fusionnés) : refus.
 */
import { mkdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { simpleGit } from 'simple-git';
import type { SimpleGit } from 'simple-git';
import { cloneGit } from './clone.js';
import { DEFAULT_CONFIG } from './config.js';
import { StriartError } from './errors.js';
import { parseMergeSubject, parseRevertSubject } from './merge-subject.ts';
import type { AgentProfile, CommitPolicy, StriartCommitResult, StriartConfig } from './types.js';

/** Trailers ajoutés à TOUT commit Striart, quel que soit le gabarit : il reste reconnaissable. */
export const STRIART_COMMIT_TRAILERS = Object.freeze({
  agent: 'Striart-Agent',
  task: 'Striart-Task',
  policy: 'Striart-Commit-Policy',
});

/** Domaine réservé (RFC 2606) : l'e-mail par défaut ne désigne jamais une vraie boîte. */
const DEFAULT_AUTHOR_DOMAIN = 'striart.invalid';
/** Longueur max de {{task}} dans le sujet (convention des 72 colonnes). */
const TASK_SUBJECT_MAX = 72;
/** Chemins par appel git (borne la longueur de ligne de commande, Windows compris). */
const PATHS_PER_CALL = 200;
const NUL = String.fromCharCode(0);

export interface GitIdentity {
  name: string;
  email: string;
}

/** Politique effective d'un profil : profil > global > 'agent'. */
export function resolveCommitPolicy(
  config: Pick<StriartConfig, 'commitPolicy'>,
  profile: Pick<AgentProfile, 'commitPolicy'>,
): CommitPolicy {
  return profile.commitPolicy ?? config.commitPolicy ?? 'agent';
}

/** Striart doit-il committer, vu la politique et ce que l'agent a fait ? */
export function striartShouldCommit(policy: CommitPolicy, agentCommitted: boolean): boolean {
  if (policy === 'striart') return true;
  if (policy === 'agent-then-striart') return !agentCommitted;
  return false;
}

const CONTROL = /[\u0000-\u001f\u007f]+/g;
const oneLine = (value: string): string => value.replace(CONTROL, ' ').trim();

/**
 * Auteur des commits Striart d'un profil. Défaut dérivé de la clé :
 * `<clé> (Striart agent) <<clé>.agent@striart.invalid>`. Les caractères qui
 * casseraient une identité git (`<`, `>`, contrôles) sont neutralisés.
 */
export function resolveCommitAuthor(profileKey: string, profile: AgentProfile): GitIdentity {
  const safeKey = oneLine(profileKey).replace(/[<>]/g, '') || 'agent';
  const slug =
    safeKey
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, '-')
      .replace(/^[-.]+|[-.]+$/g, '') || 'agent';
  const name = oneLine(profile.commitAuthor?.name ?? `${safeKey} (Striart agent)`).replace(
    /[<>]/g,
    '',
  );
  // `commitAuthor` configuré : déjà validé au chargement (isValidCommitAuthor,
  // src/agents/profile-schema.ts — source unique). Seul le défaut dérivé de
  // la clé est construit ici, et il est sûr par construction.
  const email = oneLine(profile.commitAuthor?.email ?? `${slug}.agent@${DEFAULT_AUTHOR_DOMAIN}`);
  return { name: name || `${slug} (Striart agent)`, email };
}

/**
 * Message d'un commit Striart : gabarit rendu (placeholders remplacés par des
 * valeurs réduites à une ligne — un prompt multi-ligne ne peut pas forger de
 * trailer), sujet jamais confondu avec un merge Striart (history/rollback le
 * prendraient pour un merge), puis trailers Striart-*.
 */
export function renderStriartCommitMessage({
  template,
  agent,
  profile,
  prompt,
  taskId,
  branch,
  policy,
}: {
  template: string;
  agent: string;
  profile: string;
  prompt: string | null;
  taskId: string;
  branch: string;
  policy: CommitPolicy;
}): string {
  const firstLine =
    (prompt ?? '')
      .split(/\r?\n/)
      .map(oneLine)
      .find((l) => l.length > 0) ?? '';
  const task =
    firstLine.length > TASK_SUBJECT_MAX
      ? `${firstLine.slice(0, TASK_SUBJECT_MAX - 1)}…`
      : firstLine || 'session autonome';
  const values: Record<string, string> = {
    '{{agent}}': oneLine(agent),
    '{{profile}}': oneLine(profile),
    '{{task}}': task,
    '{{taskId}}': oneLine(taskId),
    '{{branch}}': oneLine(branch),
  };
  // Gabarit validé au chargement (isValidCommitMessageTemplate) : un
  // placeholder inconnu ne peut pas arriver ici ; il resterait tel quel.
  const rendered = template
    .replace(/\{\{[^{}]*\}\}/g, (p) => values[p] ?? p)
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '');
  const lines = rendered.split('\n');
  let subject = oneLine(lines[0]) || `striart(${values['{{agent}}']}): ${task}`;
  if (parseMergeSubject(subject) || parseRevertSubject(subject)) subject = `striart: ${subject}`;
  const body = lines.slice(1).join('\n').trim();
  const trailers = [
    `${STRIART_COMMIT_TRAILERS.agent}: ${values['{{agent}}']}`,
    `${STRIART_COMMIT_TRAILERS.task}: ${values['{{taskId}}']}`,
    `${STRIART_COMMIT_TRAILERS.policy}: ${policy}`,
  ].join('\n');
  return body ? `${subject}\n\n${body}\n\n${trailers}\n` : `${subject}\n\n${trailers}\n`;
}

/**
 * Identité git effective de l'utilisateur dans le repo principal
 * (`git var GIT_COMMITTER_IDENT` : config locale, globale, système).
 */
export async function readCommitterIdentity(root: string): Promise<GitIdentity> {
  let raw = '';
  try {
    raw = (await simpleGit(root).raw(['var', 'GIT_COMMITTER_IDENT'])).trim();
  } catch {
    // Identité absente (user.useConfigOnly, aucune config) : refus ci-dessous.
  }
  const match = /^(.*) <([^<>]*)> \d+ [+-]\d{4}$/.exec(raw);
  if (!match || match[1].trim().length === 0 || !match[2] || match[2].endsWith('(none)')) {
    throw new StriartError(
      "Identité git de l'utilisateur introuvable dans le repo principal : le commit Striart " +
        "n'aurait pas de committer légitime. Configure user.name et user.email.",
      {
        code: 'COMMITTER_IDENTITY_MISSING',
        hint: 'git config user.name "<nom>" && git config user.email "<e-mail>"',
        details: { root },
      },
    );
  }
  return { name: match[1].trim(), email: match[2] };
}

export type LeftoverCommitOutcome =
  | {
      status: 'COMMITTED';
      sha: string;
      files: string[];
      excluded: StriartCommitResult['excluded'];
      author: GitIdentity;
      committer: GitIdentity;
    }
  | { status: 'NOTHING_TO_COMMIT'; excluded: StriartCommitResult['excluded'] }
  | {
      status: 'REFUSED';
      reason: 'NOT_ON_TASK_BRANCH' | 'OPERATION_IN_PROGRESS' | 'UNMERGED_PATHS';
    };

/** `git status --porcelain=v1 -z` → { chemins, chemins non fusionnés }. */
async function readLeftovers(git: SimpleGit): Promise<{ paths: string[]; unmerged: string[] }> {
  const raw = await git.raw([
    'status',
    '--porcelain=v1',
    '-z',
    '--untracked-files=all',
    '--no-renames',
  ]);
  const paths: string[] = [];
  const unmerged: string[] = [];
  for (const entry of raw.split(NUL)) {
    if (entry.length < 4) continue;
    const xy = entry.slice(0, 2);
    const filePath = entry.slice(3);
    paths.push(filePath);
    if (xy.includes('U') || xy === 'AA' || xy === 'DD') unmerged.push(filePath);
  }
  return { paths, unmerged };
}

/**
 * Parmi `paths`, ceux que les motifs désignent — évalué par git lui-même
 * (`ls-files --ignored` avec UNIQUEMENT les motifs passés : ni .gitignore ni
 * négation du dépôt ne peuvent les contredire). Fichiers suivis (`--cached`)
 * et non suivis (`--others`) confondus.
 */
async function matchIgnored(
  git: SimpleGit,
  paths: string[],
  { patterns = [], excludeFrom = null }: { patterns?: string[]; excludeFrom?: string | null },
): Promise<Set<string>> {
  const matched = new Set<string>();
  if (paths.length === 0 || (patterns.length === 0 && !excludeFrom)) return matched;
  const selectors = [
    ...patterns.map((p) => `--exclude=${p}`),
    ...(excludeFrom ? [`--exclude-from=${excludeFrom}`] : []),
  ];
  for (let i = 0; i < paths.length; i += PATHS_PER_CALL) {
    const chunk = paths.slice(i, i + PATHS_PER_CALL);
    const raw = await git.raw([
      '--literal-pathspecs',
      'ls-files',
      '-z',
      '--cached',
      '--others',
      '--ignored',
      ...selectors,
      '--',
      ...chunk,
    ]);
    for (const f of raw.split(NUL)) if (f) matched.add(f);
  }
  return matched;
}

const exists = async (p: string) => Boolean(await stat(p).catch(() => null));

/** Chemin d'un fichier interne du `.git` du clone (worktree, gitdir séparé). */
async function gitPath(git: SimpleGit, clonePath: string, name: string): Promise<string> {
  return path.resolve(clonePath, (await git.raw(['rev-parse', '--git-path', name])).trim());
}

/**
 * Committe, dans le clone, ce que la session a laissé — hors fichiers exclus.
 * Lève (StriartError ou erreur git) sur un échec d'exécution ; rend
 * `REFUSED` quand l'état du clone interdit de committer sans ambiguïté.
 */
export async function commitSessionLeftovers({
  root,
  clonePath,
  branch,
  agent,
  profileKey,
  profile,
  config,
  taskId,
  prompt,
  policy,
}: {
  root: string;
  clonePath: string;
  branch: string;
  agent: string;
  profileKey: string;
  profile: AgentProfile;
  config: Pick<StriartConfig, 'secretPatterns' | 'commitMessage'>;
  taskId: string;
  prompt: string | null;
  policy: CommitPolicy;
}): Promise<LeftoverCommitOutcome> {
  const git = cloneGit(clonePath);

  const current = (await git.raw(['symbolic-ref', '-q', 'HEAD']).catch(() => '')).trim();
  if (current !== `refs/heads/${branch}`)
    return { status: 'REFUSED', reason: 'NOT_ON_TASK_BRANCH' };

  for (const ref of ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD']) {
    const inProgress = await git.raw(['rev-parse', '-q', '--verify', ref]).then(
      (out) => out.trim().length > 0,
      () => false,
    );
    if (inProgress) return { status: 'REFUSED', reason: 'OPERATION_IN_PROGRESS' };
  }
  for (const dir of ['rebase-merge', 'rebase-apply']) {
    if (await exists(await gitPath(git, clonePath, dir))) {
      return { status: 'REFUSED', reason: 'OPERATION_IN_PROGRESS' };
    }
  }

  const leftovers = await readLeftovers(git);
  if (leftovers.unmerged.length > 0) return { status: 'REFUSED', reason: 'UNMERGED_PATHS' };

  const infoExclude = await gitPath(git, clonePath, 'info/exclude');
  const [secretSet, injectedSet] = await Promise.all([
    matchIgnored(git, leftovers.paths, { patterns: config.secretPatterns ?? [] }),
    (await exists(infoExclude))
      ? matchIgnored(git, leftovers.paths, { excludeFrom: infoExclude })
      : Promise.resolve(new Set<string>()),
  ]);
  const excluded = {
    secrets: leftovers.paths.filter((p) => secretSet.has(p)).sort(),
    injected: leftovers.paths.filter((p) => injectedSet.has(p) && !secretSet.has(p)).sort(),
  };
  const files = leftovers.paths.filter((p) => !secretSet.has(p) && !injectedSet.has(p)).sort();
  if (files.length === 0) return { status: 'NOTHING_TO_COMMIT', excluded };

  const author = resolveCommitAuthor(profileKey, profile);
  const committer = await readCommitterIdentity(root);
  const message = renderStriartCommitMessage({
    template: profile.commitMessage ?? config.commitMessage ?? DEFAULT_CONFIG.commitMessage,
    agent,
    profile: profileKey,
    prompt,
    taskId,
    branch,
    policy,
  });

  // Pathspec et message dans le .git du clone : jamais dans le worktree (ils
  // finiraient dans le statut), jamais en argv (longueur, retours à la ligne).
  const workDir = await gitPath(git, clonePath, 'striart-commit');
  await mkdir(workDir, { recursive: true });
  const pathspecFile = path.join(workDir, 'pathspec');
  const messageFile = path.join(workDir, 'message');
  const headBefore = (await git.revparse(['HEAD'])).trim();
  try {
    await writeFile(pathspecFile, files.join(NUL) + NUL);
    await writeFile(messageFile, message, 'utf8');
    const pathspec = ['--pathspec-from-file', pathspecFile, '--pathspec-file-nul'];
    // --all : ajouts, modifications ET suppressions des chemins listés.
    await git.raw(['--literal-pathspecs', 'add', '--all', ...pathspec]);
    // --only : seuls les chemins listés entrent dans le commit — un fichier
    // exclu que l'agent aurait indexé lui-même reste hors du commit.
    await git.raw([
      '--literal-pathspecs',
      '-c',
      `user.name=${committer.name}`,
      '-c',
      `user.email=${committer.email}`,
      'commit',
      '--only',
      ...pathspec,
      `--author=${author.name} <${author.email}>`,
      '--cleanup=whitespace',
      '--file',
      messageFile,
    ]);
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }

  const sha = (await git.revparse(['HEAD'])).trim();
  // Contrôle a posteriori : le commit contient exactement des chemins
  // autorisés. Un écart (hook qui indexe, bug de pathspec) est défait — la
  // branche revient à son état d'avant, rien n'est perdu du worktree.
  const committed = (
    await git.raw(['diff', '--name-only', '--no-renames', '-z', headBefore, sha, '--'])
  )
    .split(NUL)
    .filter(Boolean);
  const allowed = new Set(files);
  const leaked = committed.filter((f) => !allowed.has(f) || secretSet.has(f) || injectedSet.has(f));
  if (leaked.length > 0) {
    await git.raw(['reset', '--soft', headBefore]);
    throw new StriartError(
      `Commit Striart annulé : il contenait des chemins non autorisés (${leaked.join(', ')}).`,
      {
        code: 'STRIART_COMMIT_UNSAFE',
        hint: 'striart status',
        details: { agent, files: leaked },
      },
    );
  }
  return { status: 'COMMITTED', sha, files: committed.sort(), excluded, author, committer };
}

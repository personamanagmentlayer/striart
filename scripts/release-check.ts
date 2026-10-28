#!/usr/bin/env node
// Contrôle de cohérence d'une release — SANS rien publier, taguer ni pousser.
//
// Usage : node scripts/release-check.ts [--tag vX.Y.Z] [--require-ci]
//           [--require-signed] [--repro --native-dir <dossier>]
//           [--notes <fichier>] [--json] [--root <dossier>]
//
// Refuse (sortie 1) quand : le tag n'est pas du SemVer attendu (vX.Y.Z ou
// vX.Y.Z-rc.N), diffère de la version de package.json, n'a pas d'entrée
// CHANGELOG datée, l'arbre est sale, le tag n'est pas annoté / ne désigne pas
// HEAD / ne progresse pas par rapport aux tags existants, le commit n'est pas
// atteignable depuis une branche de release, la CI n'est pas verte sur ce
// commit (--require-ci : « non vérifiable » devient une erreur), ou l'archive
// n'est pas reproductible (--repro). Sans --tag, la version de package.json
// est contrôlée AVANT de créer le tag (mode préparation).
//
// Règle de version 0.x : tant que la majeure est 0, une montée de MINEURE peut
// rompre la compatibilité (annoncée dans « Ruptures » du CHANGELOG) et une
// montée de PATCH ne contient que des correctifs.
//
// Données sur stdout, diagnostics sur stderr. Sorties : 0 conforme, 1 refus,
// 2 usage.

import { execFile, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promises as fs, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, promisify } from 'node:util';

const run = promisify(execFile);
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// ── SemVer ───────────────────────────────────────────────────────────────

export interface Version {
  major: number;
  minor: number;
  patch: number;
  rc: number | null;
}

const VERSION_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-rc\.(0|[1-9]\d*))?$/;

/** « 1.2.3 » ou « 1.2.3-rc.1 » (seule pré-version admise : rc.N). */
export function parseVersion(text: string): Version | null {
  const m = VERSION_RE.exec(text);
  if (!m) return null;
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    rc: m[4] === undefined ? null : Number(m[4]),
  };
}

/** « v1.2.3 » → Version (null si le tag n'est pas de la forme attendue). */
export function parseTag(tag: string): Version | null {
  return tag.startsWith('v') ? parseVersion(tag.slice(1)) : null;
}

/** <0, 0, >0 ; une pré-version précède sa version finale. */
export function compareVersions(a: Version, b: Version): number {
  for (const key of ['major', 'minor', 'patch'] as const) {
    if (a[key] !== b[key]) return a[key] - b[key];
  }
  if (a.rc === b.rc) return 0;
  if (a.rc === null) return 1;
  if (b.rc === null) return -1;
  return a.rc - b.rc;
}

// ── CHANGELOG ────────────────────────────────────────────────────────────

export interface ChangelogEntry {
  heading: string;
  /** Date ISO de l'entrée datée, null pour « Non publié ». */
  date: string | null;
  unreleased: boolean;
  start: number; // index de ligne du titre
  end: number; // index de ligne (exclu) de la fin de la section
}

const DASH = '[—–-]';
const DATED_RE = new RegExp(
  `^## \\[(\\d+\\.\\d+\\.\\d+(?:-rc\\.\\d+)?)\\]\\s*${DASH}\\s*(\\d{4}-\\d{2}-\\d{2})\\s*$`,
);
const UNRELEASED_RE = new RegExp(
  `^## \\[Non publié\\](?:\\s*${DASH}\\s*(\\d+\\.\\d+\\.\\d+(?:-rc\\.\\d+)?)\\b.*)?$`,
  'i',
);

/** Entrée du CHANGELOG pour `version` : datée, ou « Non publié — X.Y.Z en préparation ». */
export function findChangelogEntry(changelog: string, version: string): ChangelogEntry | null {
  const lines = changelog.split('\n');
  let found: ChangelogEntry | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;
    const dated = DATED_RE.exec(line);
    const unreleased = dated ? null : UNRELEASED_RE.exec(line);
    const matches = (dated && dated[1] === version) || (unreleased && unreleased[1] === version);
    if (!matches) continue;
    let end = lines.length;
    for (let j = i + 1; j < lines.length; j++) {
      if ((lines[j] as string).startsWith('## [')) {
        end = j;
        break;
      }
    }
    found = {
      heading: line,
      date: dated ? (dated[2] as string) : null,
      unreleased: !dated,
      start: i,
      end,
    };
    // Une entrée datée l'emporte sur un titre « Non publié » du même numéro.
    if (dated) break;
  }
  return found;
}

/** Corps de la section d'une version (notes de release), sans son titre. */
export function changelogNotes(changelog: string, version: string): string | null {
  const entry = findChangelogEntry(changelog, version);
  if (!entry) return null;
  return changelog
    .split('\n')
    .slice(entry.start + 1, entry.end)
    .join('\n')
    .trim();
}

// ── évaluation (pure) ────────────────────────────────────────────────────

export type CiState = 'success' | 'failure' | 'pending' | 'absent' | 'unknown';

export interface ReleaseFacts {
  tag: string;
  packageVersion: string;
  changelog: string;
  today: string; // YYYY-MM-DD
  dirty: string[];
  /** null : le tag n'existe pas encore (mode préparation). */
  tagObjectType: 'tag' | 'commit' | null;
  tagCommit: string | null;
  headCommit: string;
  existingTags: string[];
  /** Branche courante, null en HEAD détaché. */
  branch: string | null;
  /** null : aucune référence distante pour trancher. */
  reachableFromReleaseBranch: boolean | null;
  ci: CiState;
  signed: boolean | null;
  reproducible: boolean | null;
  requireCi: boolean;
  requireSigned: boolean;
}

export interface Problem {
  code: string;
  level: 'error' | 'warning';
  message: string;
}

export function evaluateRelease(f: ReleaseFacts): Problem[] {
  const out: Problem[] = [];
  const error = (code: string, message: string) => out.push({ code, level: 'error', message });
  const warn = (code: string, message: string) => out.push({ code, level: 'warning', message });

  const tagVersion = parseTag(f.tag);
  if (!tagVersion) {
    error('TAG_INVALID', `Tag « ${f.tag} » invalide : attendu vX.Y.Z ou vX.Y.Z-rc.N (SemVer).`);
  }
  if (!parseVersion(f.packageVersion)) {
    error(
      'VERSION_INVALID',
      `Version « ${f.packageVersion} » de package.json invalide (SemVer X.Y.Z[-rc.N]).`,
    );
  }
  if (f.tag !== `v${f.packageVersion}`) {
    error(
      'VERSION_MISMATCH',
      `Le tag ${f.tag} ne correspond pas à la version de package.json (${f.packageVersion}).`,
    );
  }

  const version = f.tag.replace(/^v/, '');
  const entry = findChangelogEntry(f.changelog, version);
  if (!entry) {
    error('CHANGELOG_MISSING', `CHANGELOG.md : aucune entrée pour ${version}.`);
  } else if (entry.unreleased) {
    // Une pré-version peut vivre sous « Non publié — X.Y.Z en préparation » ;
    // la version finale exige une entrée datée.
    if (tagVersion?.rc === null || tagVersion === null) {
      error(
        'CHANGELOG_UNDATED',
        `CHANGELOG.md : l'entrée de ${version} est encore « Non publié » — la dater (## [${version}] — AAAA-MM-JJ).`,
      );
    }
  } else if (entry.date !== null) {
    const valid =
      !Number.isNaN(Date.parse(`${entry.date}T00:00:00Z`)) &&
      new Date(`${entry.date}T00:00:00Z`).toISOString().startsWith(entry.date);
    if (!valid)
      error('CHANGELOG_DATE_INVALID', `CHANGELOG.md : date « ${entry.date} » inexistante.`);
    else if (entry.date > f.today)
      error('CHANGELOG_DATE_FUTURE', `CHANGELOG.md : la date ${entry.date} est dans le futur.`);
  }
  if (tagVersion?.rc === null && entry && !entry.unreleased) {
    // Une section « Non publié — <même version> » restante contredit l'entrée datée.
    const stale = findStaleUnreleased(f.changelog, version);
    if (stale)
      error(
        'CHANGELOG_STALE_UNRELEASED',
        `CHANGELOG.md : « ${stale} » subsiste alors que ${version} est daté.`,
      );
  }

  if (f.dirty.length > 0) {
    error(
      'DIRTY_TREE',
      `Arbre de travail sale (${f.dirty.slice(0, 5).join(', ')}${f.dirty.length > 5 ? '…' : ''}).`,
    );
  }

  if (f.tagObjectType !== null) {
    if (f.tagObjectType !== 'tag')
      error(
        'TAG_NOT_ANNOTATED',
        `Le tag ${f.tag} est léger : utiliser un tag annoté (git tag -a, ou -s).`,
      );
    if (f.tagCommit !== f.headCommit) {
      error(
        'TAG_NOT_AT_HEAD',
        `Le tag ${f.tag} désigne ${f.tagCommit?.slice(0, 12)}, pas HEAD (${f.headCommit.slice(0, 12)}).`,
      );
    }
    if (f.signed === false) {
      (f.requireSigned ? error : warn)(
        'TAG_NOT_SIGNED',
        `Le tag ${f.tag} n'est pas signé ou sa signature n'est pas vérifiable.`,
      );
    }
  } else if (f.requireSigned) {
    warn(
      'TAG_ABSENT',
      `Le tag ${f.tag} n'existe pas encore : sa signature ne peut pas être vérifiée.`,
    );
  }

  if (tagVersion) {
    const others = f.existingTags
      .filter((t) => t !== f.tag)
      .map((t) => ({ t, v: parseTag(t) }))
      .filter((x): x is { t: string; v: Version } => x.v !== null);
    const line = f.branch ? /^release\/(\d+)\.(\d+)$/.exec(f.branch) : null;
    if (line) {
      if (tagVersion.major !== Number(line[1]) || tagVersion.minor !== Number(line[2])) {
        error(
          'BRANCH_LINE_MISMATCH',
          `La branche ${f.branch} ne publie que des ${line[1]}.${line[2]}.x (tag ${f.tag}).`,
        );
      }
      const sameLine = others.filter(
        (x) => x.v.major === tagVersion.major && x.v.minor === tagVersion.minor,
      );
      const top = sameLine.sort((a, b) => compareVersions(b.v, a.v))[0];
      if (top && compareVersions(tagVersion, top.v) <= 0) {
        error(
          'VERSION_NOT_INCREASING',
          `${f.tag} ne dépasse pas ${top.t} sur la ligne ${line[1]}.${line[2]}.`,
        );
      }
    } else {
      const top = others.sort((a, b) => compareVersions(b.v, a.v))[0];
      if (top && compareVersions(tagVersion, top.v) <= 0) {
        error('VERSION_NOT_INCREASING', `${f.tag} ne dépasse pas le tag existant ${top.t}.`);
      }
    }
  }

  if (f.reachableFromReleaseBranch === false) {
    error(
      'COMMIT_UNREACHABLE',
      "Le commit n'est atteignable depuis aucune branche de release (branche par défaut ou release/X.Y).",
    );
  }

  if (f.ci === 'failure') error('CI_FAILED', 'La CI a échoué sur ce commit.');
  else if (f.ci === 'pending') error('CI_PENDING', 'La CI est encore en cours sur ce commit.');
  else if (f.ci === 'absent') error('CI_ABSENT', 'Aucune exécution de CI pour ce commit.');
  else if (f.ci === 'unknown') {
    (f.requireCi ? error : warn)(
      'CI_UNVERIFIABLE',
      'État de la CI non vérifiable (gh absent ou non authentifié).',
    );
  }

  if (f.reproducible === false) {
    error(
      'NOT_REPRODUCIBLE',
      "Deux constructions de l'archive depuis ce commit ne sont pas identiques.",
    );
  }
  return out;
}

function findStaleUnreleased(changelog: string, version: string): string | null {
  for (const line of changelog.split('\n')) {
    const m = UNRELEASED_RE.exec(line);
    if (m && m[1] === version) return line;
  }
  return null;
}

/** État de la CI à partir de `gh run list --json status,conclusion`. */
export function ciStateFromRuns(runs: { status?: string; conclusion?: string | null }[]): CiState {
  if (runs.length === 0) return 'absent';
  if (runs.some((r) => r.status === 'completed' && r.conclusion === 'success')) return 'success';
  if (runs.some((r) => r.status !== 'completed')) return 'pending';
  return 'failure';
}

// ── faits (git, fichiers) ────────────────────────────────────────────────

function git(root: string, args: string[]): string {
  return execFileSync('git', ['-C', root, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function gitTry(root: string, args: string[]): string | null {
  try {
    return git(root, args);
  } catch {
    // Absence de la référence demandée : la réponse est « inconnu », pas une panne.
    return null;
  }
}

export interface GatherOptions {
  root: string;
  tag?: string;
  requireCi: boolean;
  requireSigned: boolean;
  today?: string;
  ci?: CiState;
  reproducible?: boolean | null;
}

export async function gatherFacts(options: GatherOptions): Promise<ReleaseFacts> {
  const { root } = options;
  const pkg = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8')) as {
    version: string;
  };
  const tag = options.tag ?? `v${pkg.version}`;
  const headCommit = git(root, ['rev-parse', 'HEAD']);
  const tagType = gitTry(root, ['cat-file', '-t', `refs/tags/${tag}`]);
  const tagCommit = tagType ? gitTry(root, ['rev-parse', `refs/tags/${tag}^{commit}`]) : null;
  // Sans trim : la première colonne d'une ligne porcelain peut être une espace.
  const dirty = execFileSync(
    'git',
    ['-C', root, 'status', '--porcelain=v1', '--untracked-files=no'],
    {
      encoding: 'utf8',
    },
  )
    .split('\n')
    .filter(Boolean)
    .map((l) => l.slice(3));
  let branch = gitTry(root, ['symbolic-ref', '-q', '--short', 'HEAD']);
  const remotes = gitTry(root, ['for-each-ref', '--format=%(refname:short)', 'refs/remotes/']);
  let reachable: boolean | null = null;
  if (remotes) {
    const containing = (gitTry(root, ['branch', '-r', '--contains', tagCommit ?? headCommit]) ?? '')
      .split('\n')
      .map((l) => l.trim());
    reachable = containing.some((b) => /^[^/]+\/(main|master|release\/\d+\.\d+)$/.test(b));
    // HEAD détaché (checkout d'un tag en CI) : la ligne de maintenance se déduit
    // de la branche release/X.Y qui contient le commit, si la branche par défaut ne le contient pas.
    if (branch === null && !containing.some((b) => /^[^/]+\/(main|master)$/.test(b))) {
      const line = containing.map((b) => /^[^/]+\/(release\/\d+\.\d+)$/.exec(b)?.[1]).find(Boolean);
      if (line) branch = line;
    }
  }
  let signed: boolean | null = null;
  if (tagType === 'tag') {
    signed = gitTry(root, ['verify-tag', tag]) !== null;
  }
  return {
    tag,
    packageVersion: pkg.version,
    changelog: await fs.readFile(path.join(root, 'CHANGELOG.md'), 'utf8'),
    today: options.today ?? new Date().toISOString().slice(0, 10),
    dirty,
    tagObjectType: tagType === 'tag' || tagType === 'commit' ? tagType : null,
    tagCommit,
    headCommit,
    existingTags: (gitTry(root, ['tag', '--list', 'v*']) ?? '').split('\n').filter(Boolean),
    branch,
    reachableFromReleaseBranch: reachable,
    ci: options.ci ?? (await readCiState(root, tagCommit ?? headCommit)),
    signed,
    reproducible: options.reproducible ?? null,
    requireCi: options.requireCi,
    requireSigned: options.requireSigned,
  };
}

/** CI de `ci.yml` sur un commit, par la CLI `gh` (aucun jeton lu par ce script). */
export async function readCiState(root: string, commit: string): Promise<CiState> {
  try {
    const { stdout } = await run(
      'gh',
      [
        'run',
        'list',
        '--workflow',
        'ci.yml',
        '--commit',
        commit,
        '--json',
        'status,conclusion',
        '--limit',
        '30',
      ],
      { cwd: root, encoding: 'utf8', timeout: 60_000 },
    );
    return ciStateFromRuns(JSON.parse(stdout) as { status?: string; conclusion?: string | null }[]);
  } catch {
    // gh absent, non authentifié ou hors réseau : « inconnu », jamais « vert ».
    return 'unknown';
  }
}

// ── reproductibilité ─────────────────────────────────────────────────────

async function sha256File(file: string): Promise<string> {
  return createHash('sha256')
    .update(await fs.readFile(file))
    .digest('hex');
}

/**
 * Construit l'archive deux fois (SOURCE_DATE_EPOCH = date du commit, qui fixe
 * l'horodatage de la signature du manifeste) et compare l'empreinte de chaque
 * archive. Exige la clé de signature dans l'environnement (comme une release).
 */
export async function checkReproducible(root: string, nativeDir: string): Promise<boolean> {
  const epoch = git(root, ['log', '-1', '--format=%ct', 'HEAD']);
  const digests: Record<string, string>[] = [];
  for (let round = 0; round < 2; round++) {
    const outDir = await fs.mkdtemp(path.join(os.tmpdir(), `striart-repro-${round}-`));
    try {
      const { stdout } = await run(
        process.execPath,
        [
          path.join(root, 'scripts', 'pack.ts'),
          '--native-dir',
          nativeDir,
          '--out-dir',
          outDir,
          '--json',
        ],
        {
          cwd: root,
          encoding: 'utf8',
          env: { ...process.env, SOURCE_DATE_EPOCH: epoch },
          maxBuffer: 64 * 1024 * 1024,
        },
      );
      const result = JSON.parse(stdout) as {
        tarball: string;
        native: { platforms: { tarball: string | null }[] };
      };
      const files = [result.tarball, ...result.native.platforms.map((p) => p.tarball)].filter(
        (x): x is string => !!x,
      );
      const digest: Record<string, string> = {};
      for (const file of files) digest[path.basename(file)] = await sha256File(file);
      digests.push(digest);
    } finally {
      await fs.rm(outDir, { recursive: true, force: true });
    }
  }
  return JSON.stringify(digests[0]) === JSON.stringify(digests[1]);
}

// ── CLI ──────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  let values;
  try {
    ({ values } = parseArgs({
      args: process.argv.slice(2),
      strict: true,
      allowPositionals: false,
      options: {
        tag: { type: 'string' },
        root: { type: 'string' },
        'require-ci': { type: 'boolean', default: false },
        'require-signed': { type: 'boolean', default: false },
        repro: { type: 'boolean', default: false },
        'native-dir': { type: 'string' },
        notes: { type: 'string' },
        json: { type: 'boolean', default: false },
      },
    }));
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n`);
    process.exitCode = 2;
    return;
  }
  if (values.repro && !values['native-dir']) {
    process.stderr.write('--repro exige --native-dir.\n');
    process.exitCode = 2;
    return;
  }
  const root = path.resolve(values.root ?? REPO_ROOT);
  const reproducible = values.repro
    ? await checkReproducible(root, path.resolve(values['native-dir'] as string))
    : null;
  const facts = await gatherFacts({
    root,
    ...(values.tag !== undefined && { tag: values.tag }),
    requireCi: values['require-ci'],
    requireSigned: values['require-signed'],
    reproducible,
  });
  const problems = evaluateRelease(facts);
  if (values.notes) {
    const notes = changelogNotes(facts.changelog, facts.tag.replace(/^v/, ''));
    if (notes) await fs.writeFile(path.resolve(values.notes), `${notes}\n`);
  }
  const errors = problems.filter((p) => p.level === 'error');
  if (values.json) {
    process.stdout.write(
      `${JSON.stringify({ ok: errors.length === 0, tag: facts.tag, problems }, null, 2)}\n`,
    );
  } else {
    for (const p of problems) {
      process.stderr.write(`${p.level === 'error' ? '✖' : '⚠'} ${p.message} [${p.code}]\n`);
    }
    if (errors.length === 0) process.stdout.write(`Release ${facts.tag} conforme.\n`);
  }
  process.exitCode = errors.length === 0 ? 0 : 1;
}

function isEntryPoint(): boolean {
  const flag = (import.meta as { main?: unknown }).main;
  if (typeof flag === 'boolean') return flag;
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    // Chemin d'entrée illisible : ce n'est pas nous.
    return false;
  }
}

if (isEntryPoint()) await main();

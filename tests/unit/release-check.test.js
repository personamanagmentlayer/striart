import { describe, expect, it } from 'vitest';
import {
  changelogNotes,
  ciStateFromRuns,
  compareVersions,
  evaluateRelease,
  findChangelogEntry,
  parseTag,
  parseVersion,
} from '../../scripts/release-check.ts';

const CHANGELOG = `# Changelog

## [Non publié] — 0.12.0 en préparation

- à venir

## [0.11.0] — 2026-11-02

### Ruptures
- une rupture

## [0.10.0] — 2026-08-30

- ancien
`;

const base = (over = {}) => ({
  tag: 'v0.11.0',
  packageVersion: '0.11.0',
  changelog: CHANGELOG,
  today: '2026-11-03',
  dirty: [],
  tagObjectType: 'tag',
  tagCommit: 'a'.repeat(40),
  headCommit: 'a'.repeat(40),
  existingTags: ['v0.10.0', 'v0.11.0'],
  branch: 'main',
  reachableFromReleaseBranch: true,
  ci: 'success',
  signed: true,
  reproducible: null,
  requireCi: true,
  requireSigned: false,
  ...over,
});
const codes = (facts) =>
  evaluateRelease(facts)
    .filter((p) => p.level === 'error')
    .map((p) => p.code);

describe('SemVer', () => {
  it('accepte X.Y.Z et X.Y.Z-rc.N, refuse le reste', () => {
    expect(parseTag('v1.2.3')).toEqual({ major: 1, minor: 2, patch: 3, rc: null });
    expect(parseTag('v1.2.3-rc.4')?.rc).toBe(4);
    for (const bad of ['1.2.3', 'v1.2', 'v1.2.3-beta.1', 'v01.2.3', 'v1.2.3+meta', 'v1.2.3-rc']) {
      expect(parseTag(bad)).toBeNull();
    }
    expect(parseVersion('0.11.0')).not.toBeNull();
  });

  it('ordonne : rc < finale, mineure > patch', () => {
    const v = (s) => parseVersion(s);
    expect(compareVersions(v('1.0.0-rc.2'), v('1.0.0'))).toBeLessThan(0);
    expect(compareVersions(v('1.0.0-rc.2'), v('1.0.0-rc.10'))).toBeLessThan(0);
    expect(compareVersions(v('0.11.0'), v('0.10.9'))).toBeGreaterThan(0);
  });
});

describe('CHANGELOG', () => {
  it('trouve l’entrée datée et en extrait les notes', () => {
    expect(findChangelogEntry(CHANGELOG, '0.11.0')).toMatchObject({
      date: '2026-11-02',
      unreleased: false,
    });
    expect(changelogNotes(CHANGELOG, '0.11.0')).toBe('### Ruptures\n- une rupture');
    expect(findChangelogEntry(CHANGELOG, '0.12.0')?.unreleased).toBe(true);
    expect(findChangelogEntry(CHANGELOG, '9.9.9')).toBeNull();
  });
});

describe('evaluateRelease', () => {
  it('une release cohérente passe', () => {
    expect(codes(base())).toEqual([]);
  });

  it('tag ≠ version de package.json', () => {
    expect(codes(base({ packageVersion: '0.10.0' }))).toContain('VERSION_MISMATCH');
  });

  it('tag mal formé', () => {
    expect(codes(base({ tag: 'v0.11' }))).toContain('TAG_INVALID');
  });

  it('CHANGELOG sans entrée, non daté, daté dans le futur ou à date inexistante', () => {
    expect(codes(base({ tag: 'v0.13.0', packageVersion: '0.13.0' }))).toContain(
      'CHANGELOG_MISSING',
    );
    expect(codes(base({ tag: 'v0.12.0', packageVersion: '0.12.0' }))).toContain(
      'CHANGELOG_UNDATED',
    );
    expect(codes(base({ today: '2026-10-01' }))).toContain('CHANGELOG_DATE_FUTURE');
    const bad = CHANGELOG.replace('2026-11-02', '2026-02-31');
    expect(codes(base({ changelog: bad }))).toContain('CHANGELOG_DATE_INVALID');
  });

  it('une pré-version accepte « Non publié — X.Y.Z-rc.N en préparation »', () => {
    const rc = { tag: 'v0.12.0-rc.1', packageVersion: '0.12.0-rc.1', existingTags: ['v0.11.0'] };
    expect(codes(base(rc))).toContain('CHANGELOG_MISSING');
    const cl = CHANGELOG.replace('0.12.0 en préparation', '0.12.0-rc.1 en préparation');
    expect(codes(base({ ...rc, changelog: cl }))).toEqual([]);
  });

  it('une section « Non publié » du même numéro subsistant contredit l’entrée datée', () => {
    const cl = CHANGELOG.replace('0.12.0 en préparation', '0.11.0 en préparation');
    expect(codes(base({ changelog: cl }))).toContain('CHANGELOG_STALE_UNRELEASED');
  });

  it('arbre sale, tag léger, tag hors HEAD', () => {
    expect(codes(base({ dirty: ['src/a.ts'] }))).toContain('DIRTY_TREE');
    expect(codes(base({ tagObjectType: 'commit' }))).toContain('TAG_NOT_ANNOTATED');
    expect(codes(base({ tagCommit: 'b'.repeat(40) }))).toContain('TAG_NOT_AT_HEAD');
  });

  it('signature : avertissement, erreur avec requireSigned', () => {
    expect(codes(base({ signed: false }))).toEqual([]);
    expect(codes(base({ signed: false, requireSigned: true }))).toContain('TAG_NOT_SIGNED');
  });

  it('la version doit progresser', () => {
    expect(codes(base({ existingTags: ['v0.11.0', 'v0.12.0'] }))).toContain(
      'VERSION_NOT_INCREASING',
    );
  });

  it('branche de maintenance : reste dans sa ligne X.Y', () => {
    const maint = base({
      tag: 'v0.10.1',
      packageVersion: '0.10.1',
      branch: 'release/0.10',
      existingTags: ['v0.10.0', 'v0.11.0'],
      changelog: CHANGELOG.replace(
        '## [0.10.0]',
        '## [0.10.1] — 2026-09-01\n\n- fix\n\n## [0.10.0]',
      ),
    });
    expect(codes(maint)).toEqual([]);
    expect(codes({ ...maint, tag: 'v0.11.1', packageVersion: '0.11.1' })).toContain(
      'BRANCH_LINE_MISMATCH',
    );
  });

  it('commit hors branche de release', () => {
    expect(codes(base({ reachableFromReleaseBranch: false }))).toContain('COMMIT_UNREACHABLE');
  });

  it('CI : échec, en cours, absente, non vérifiable', () => {
    expect(codes(base({ ci: 'failure' }))).toContain('CI_FAILED');
    expect(codes(base({ ci: 'pending' }))).toContain('CI_PENDING');
    expect(codes(base({ ci: 'absent' }))).toContain('CI_ABSENT');
    expect(codes(base({ ci: 'unknown' }))).toContain('CI_UNVERIFIABLE');
    expect(codes(base({ ci: 'unknown', requireCi: false }))).toEqual([]);
  });

  it('archive non reproductible', () => {
    expect(codes(base({ reproducible: false }))).toContain('NOT_REPRODUCIBLE');
    expect(codes(base({ reproducible: true }))).toEqual([]);
  });

  it('ciStateFromRuns', () => {
    expect(ciStateFromRuns([])).toBe('absent');
    expect(
      ciStateFromRuns([
        { status: 'completed', conclusion: 'failure' },
        { status: 'completed', conclusion: 'success' },
      ]),
    ).toBe('success');
    expect(ciStateFromRuns([{ status: 'in_progress' }])).toBe('pending');
    expect(ciStateFromRuns([{ status: 'completed', conclusion: 'cancelled' }])).toBe('failure');
  });
});

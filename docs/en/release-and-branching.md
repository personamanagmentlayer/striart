# Striart branches and releases

> [Documentation](README.md) · Striart branches and releases
>
> This page describes how **Striart's own repository** is managed: branches,
> versions, tags, releases. It is unrelated to `targetBranch`, which configures the
> *target* repositories Striart orchestrates — see [Branches and pipeline](branches.md).

## Branches

Striart is **trunk-based**: one short, protected, always-green development branch.

| Branch | Role | Lifetime |
|---|---|---|
| `main` | Default branch. All work lands here through a pull request. | permanent |
| `feat/…`, `fix/…`, `chore/…`, `docs/…` | Working branches, one per topic, created from `main`. | a few days |
| `release/X.Y` | Maintenance of an **already published** version (security or regression fix). Created **only on demand**, from the relevant `vX.Y.Z` tag. | as long as the X.Y line is supported |

Rules:

- One pull request = one topic, opened against `main` (or `release/X.Y` for a
  backport). A maintenance fix is merged into `main` first, then backported with
  `git cherry-pick -x`: `main` never loses a fix.
- **Squash merge only.** A pull request becomes one commit on `main`: linear history,
  one commit = one topic, undone by a single `git revert`. The squash message uses the
  PR title (a Conventional Commits message) and keeps the commits' `Signed-off-by`
  and `Co-authored-by` lines.
- Commits follow [Conventional Commits](https://www.conventionalcommits.org/):
  `feat:`, `fix:`, `docs:`, `test:`, `chore:`, `refactor:`, `perf:`, `ci:`; the **why**
  goes in the body. A breaking change carries `!` (`feat!:`) or a `BREAKING CHANGE:` footer.
- Sign off your commits (`git commit -s`) to certify you may submit them under the
  project license (MIT).
- No force-push and no deletion on `main` and `release/*`.

### Expected protection

On `main` and `release/*` (rulesets versioned in
[`.github/rulesets/`](../../.github/rulesets/default-branch.json)): pull request
required, one approval, resolved conversations, green `ci-ok` check on an up-to-date
branch, linear history, squash only, no force-push or deletion. On `v*` tags: creation
reserved to maintainers, no move, no deletion.

## Continuous integration

The `CI` workflow runs on every pull request to `main` or `release/*` and on every
push to those branches (never on a tag: a tag points at an already tested commit). The
final **`ci-ok`** job fails if any upstream job is red, cancelled or skipped: it is the
only check to require. An outdated pull request run is cancelled by a new push; a push
run never is.

## Versions and tags

- **SemVer** (`MAJOR.MINOR.PATCH`). While the major is `0`, a **minor bump may break
  compatibility** (announced under "Breaking changes" in `CHANGELOG.md`); a **patch**
  bump only contains fixes. From `1.0.0`, a break requires a new major.
- The source of truth for the version is the `version` field of `package.json`.
- A tag is **annotated** and named `vX.Y.Z` (or `vX.Y.Z-rc.N` for a pre-release; `rc`
  is the only pre-release allowed). It is signed when a key is available
  (`git tag -s`). A published tag **never moves**: fix forward with the next version.
- `CHANGELOG.md` has one **dated** entry `## [X.Y.Z] — YYYY-MM-DD` per version.

`node scripts/release-check.ts` fails (exit 1) on a malformed tag or one that differs
from the `package.json` version, a missing, undated or future-dated CHANGELOG entry, a
dirty tree, a lightweight tag or one that does not point at `HEAD`, a version that does
not increase, a commit outside a release branch, a CI that is not green on that commit
(`--require-ci`) and, with `--repro --native-dir <dir>`, an archive that is not
reproducible.

## Cutting a release (maintainers)

1. On an up-to-date, green `main`: bump `version` in `package.json`, date the
   `CHANGELOG.md` entry, merge through a pull request.
2. `node scripts/release-check.ts` (preparation mode, no tag) must pass.
3. Create and push the annotated tag: `git tag -s -a vX.Y.Z -m "Striart vX.Y.Z"` (`-a`
   alone without a signing key), then `git push origin vX.Y.Z`.
4. The `Release` workflow runs on the tag. It **publishes nothing to a package
   registry**. It: (a) re-runs `release-check --require-ci` — tag, version, CHANGELOG,
   green CI on that commit; (b) fetches the native binaries from that commit's green CI
   run (what ships is what was tested); (c) checks that two builds of the archive are
   identical; (d) builds and signs the archives (`npm run pack:release`, minisign
   manifest), the CycloneDX SBOM and `SHA256SUMS`; (e) attaches a provenance
   attestation; (f) creates a **draft GitHub release** whose notes come from the
   CHANGELOG (flagged as pre-release for an `-rc.N`).
5. Review the draft, then publish it by hand.

Verify a downloaded archive: `sha256sum -c SHA256SUMS` and
`gh attestation verify <archive>.tgz --repo <owner>/striart`.

The `STRIART_NATIVE_SIGNING_KEY` secret is read only by the `archives` job, in the
`release` environment (required reviewers, restricted to `v*` tags); it is never
printed. Pull requests have no access to it: they sign with a throwaway key, in
`--dry-run`.

## Fixing a published version

1. Fix on `main` (pull request, squash).
2. `git switch -c release/X.Y vX.Y.Z` then `git push -u origin release/X.Y` — the branch
   exists only when needed.
3. `git cherry-pick -x <fix commit>` through a pull request to `release/X.Y`.
4. Version `X.Y.(Z+1)`, CHANGELOG entry, tag `vX.Y.(Z+1)` from `release/X.Y`:
   `release-check` requires the version to stay within the X.Y line.

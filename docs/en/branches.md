# Branches and pipeline

> [Documentation](README.md) · Branches and pipeline

## `targetBranch`: any branch

`main` is only a **configuration default**, not a constraint. The target
branch is set via `targetBranch`, and the whole machinery derives from it:

- agent clones are created **from** it (their task branch
  `striart/<agent>/task-<uuid>` starts at its HEAD);
- rebases (`autoRebase`, `striart sync`) happen **onto** it;
- merges land **into** it;
- `autoPush` pushes **it** to `origin`;
- `striart doctor` checks that it is the current branch.

Examples — a repo whose work happens on `dev`:

```js
// striart.config.mjs
export default {
  targetBranch: 'dev',       // agents start from dev, merge into dev
  testCommand: 'npm test',
};
```

A legacy repo on `master`:

```js
export default {
  targetBranch: 'master',
  testCommand: 'npm test',
};
```

For a brand-new project, align the name when creating the repo:

```bash
git init -b dev            # or -b master, -b main…
git add -A && git commit -m "chore: initial state"
striart init               # then adjust targetBranch in striart.config.mjs
```

## The constraint: the main repo must be on `targetBranch`

Before any merge, rollback, or promotion, Striart checks the main repo's
state (**fail closed** — refuse rather than merge into the wrong place):

- **Current branch ≠ `targetBranch`** → refusal `TARGET_BRANCH_MISMATCH`:

  > The main repo is on "master" but the expected branch is "main".
  > Check out the branch or adjust striart.config.

  Two ways out, your choice: `git checkout <targetBranch>` in the main repo,
  or align `targetBranch` in the config with the actual branch.

- **Uncommitted changes** in the main repo → refusal `MAIN_DIRTY`: commit or
  stash first. The orchestrator never merges over in-progress human work.

`striart doctor` flags the branch mismatch before you even attempt a merge
("on 'X' but targetBranch = 'Y' — merge/watch will refuse").

While `striart watch` runs, the target branch belongs to the orchestrator:
direct commits remain possible (agents will be rebased onto them at the next
merge), but switching branches or leaving the worktree dirty will suspend
merges until the repo returns to a clean state.

## The staging → main pipeline

To **never** expose the stable branch to an intermediate state, Striart
offers a second stage: agents merge continuously into `targetBranch` (the
staging branch), and `mainBranch` only advances through explicit promotion.

```js
export default {
  targetBranch: 'striart/staging',                // agents merge here continuously
  mainBranch: 'main',                             // promoted only via `striart promote`
  promoteTestCommand: 'npm run test:integration', // global gate (null → testCommand)
};
```

The `dev` → `main` scenario writes itself naturally:

```js
export default {
  targetBranch: 'dev',
  mainBranch: 'main',
  promoteTestCommand: 'npm run test:e2e',
};
```

### `striart promote`

1. Requires `mainBranch` in the config, **different** from `targetBranch`;
2. checks the repo state (`MAIN_DIRTY`, `TARGET_BRANCH_MISMATCH` — same
   guards as a merge);
3. refuses if `mainBranch` has commits outside the pipeline (fast-forward
   impossible): "Reconcile manually (merge mainBranch into targetBranch)" —
   Striart never invents a merge on the stable branch;
4. runs the **global Test Gate** (`promoteTestCommand`) on the staging
   branch; red → promotion refused, ticket created, staging rollback offered;
5. green → `mainBranch` advances by **fast-forward** onto the staging branch:
   atomic — `main` is never in an intermediate state, not even for a
   millisecond.

`striart promote --rollback` undoes the last promotion.

## `autoPush` and the remote

Agent clones have **no remote**: only the orchestrator pushes (golden rule
#1). By default `autoPush: false` — the human approves the push. With
`autoPush: true`, every green merge is followed by
`git push origin <targetBranch>`; a push failure is logged but does not undo
the local merge.

`striart rollback` accounts for the push: merge not pushed → local reset
(recoverable via reflog); merge already pushed → revert (published history is
preserved).

## See also

- [Configuration](configuration.md) — the full reference.
- [Commands](commands.md#striart-promote---rollback) — `promote`,
  `rollback`, `history`.
- [Troubleshooting](troubleshooting.md) — `TARGET_BRANCH_MISMATCH` and
  `MAIN_DIRTY` in practice.

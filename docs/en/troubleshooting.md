# Troubleshooting

> [Documentation](README.md) · Troubleshooting

## First reflex: `striart doctor`

```bash
striart doctor          # git, repo, config, LLM reachability, locks, tickets
striart doctor --json   # scriptable
```

The doctor checks, among other things: the git version, that the directory is
inside a Git repo, that the config loads and validates, that the LLM responds
(Ollama ping, or cloud provider API key presence), lock state, open tickets,
and **that the current branch is `targetBranch`** — a mismatch shows
"on 'X' but targetBranch = 'Y' — merge/watch will refuse".

## Error codes

Every Striart error carries a machine-readable `code` (shown by the CLI next
to the human message). The most frequent:

| Code | Meaning | Way out |
|---|---|---|
| `TARGET_BRANCH_MISMATCH` | The main repo is not on `targetBranch`. | `git checkout <targetBranch>`, or adjust the config — see [Branches](branches.md#the-constraint-the-main-repo-must-be-on-targetbranch). |
| `MAIN_DIRTY` | The main repo has uncommitted changes. | Commit or stash, then retry. |
| `ROUTER_FAILED` | The Router's LLM did not respond or returned unusable output. | `striart doctor` (LLM reachable? key present?); retry — the Router is a filter, not a guarantee. |
| `MERGE_CONFLICT` | Unresolved conflict (semantic merge failed or disabled). | Ticket in `.striart/conflicts/` — `striart resolve --prepare <id>` then `--apply <id>` (under lock + Test Gate). |
| `GATE_FAILED` | The test suite rejected the merge (a status returned by `mergeAgentCommit`, not a thrown `StriartError`). | Read the ticket's `test-output.log`; fix on the agent or main side. |
| `SESSION_LIVE` | The clone hosts a live autonomous session (verified PID). | Wait for the session to end — neither `stop`, `clean`, nor `--force` will get through. |
| `MAIN_SESSION_LIVE` | The **main repo itself** (not a clone) is reserved — an agent launched via `--on-main`, or a manual edit via `striart lock --start`. | Wait for the session to end (`striart lock` with no option shows reason/PID/duration), or `striart lock --stop` if it ended without cleaning up. |
| `IN_USE` | The clone's disk changed less than `presenceMinutes` min ago. | Wait, or `--force` knowingly (heuristic). |
| `REUSE_DIRTY` / `REUSE_UNMERGED` / `REUSE_IN_USE` | The archive to reuse has uncommitted / unmerged work / recent activity. | Inspect the clone; `--force` accepts the loss. |
| `HISTORICAL_SECRETS_FOUND` | A path matching `secretPatterns` once existed in the repo's history (readable via `git show <sha>:<file>` even if absent today). | Check/revoke the secret, then `--force` (`start`, `run`, `run --autonomous`) to clone anyway, or `secretPatterns: []` to disable the check. |

## Conflict tickets and manual mode

Every merge failure produces a complete ticket in
`.striart/conflicts/<ticket>/`: `base`/`ours`/`theirs` versions, LLM attempt
(`llm-attempt`), Test Gate log (`test-output.log`).

```bash
striart resolve                 # lists open tickets
striart resolve --prepare <id>  # seeds <file>.resolved from the agent's version
striart resolve --apply <id>    # replays the ticket's exact merge, under lock + Test Gate
striart resolve --close <id>    # marks a ticket resolved WITHOUT going through the Test Gate
striart resolve --all           # closes everything
```

`--prepare`/`--apply` are the **tested** path: the resolution goes through
the same inter-process lock and the same blocking Test Gate as an automatic
merge, instead of a `git merge` done by hand outside Striart's supervision
(the source of a real incident: collision with an active `striart watch`).
`--close` remains useful when the conflict has already been fixed some other
way.

**Manual mode**: after 3 consecutive failed semantic merges, Striart disables
LLM merging (safety rule — an LLM failing in a loop must not keep touching
the code). `striart resolve --unlock` re-enables it once the cause is
addressed.

## Undoing a merge: `striart rollback`

Undoes the **last Striart merge** on the target branch:

- merge not pushed → local `reset` (recoverable via reflog);
- merge already pushed → `revert` (published history is preserved).

Refuses if the target branch's last commit is not a Striart merge — it never
undoes a human commit. `striart history` rebuilds the list of merges and
rollbacks from the Git graph.

## Inconsistent state: `striart reconcile`

After a crash, a `kill -9`, a power cut: `striart reconcile` puts everything
back in order — dead sessions neutralized in the registry, queue unblocked,
orphaned locks broken, abandoned merge (orphaned `MERGE_HEAD`) cleanly
aborted. **Idempotent**: running it "for nothing" costs nothing.
`striart watch` replays it automatically.

## Stuck lock?

The `.striart/main.lock` lock automatically breaks orphaned locks (dead
holder process, or 30 min TTL exceeded). A lock wait times out after 2 min
with an explicit message. If a lock seems stuck: `striart reconcile`, then
`striart doctor`.

## Main repo reserved (`MAIN_SESSION_LIVE`)

`striart run --on-main` or `striart lock --start` declare a session on the
main repo itself (not a clone): while the watched PID is alive, every
mutating operation (merge, sync, promote, `resolve --apply`, `watch`'s
auto-merge) is refused. **No TTL**: unlike `main.lock`, nothing
automatically breaks a session declared for too long — `striart lock` (no
option) shows the reason, PID, and duration; `striart lock --stop` always
releases it (escape hatch, even if the PID is still alive).

## Autonomous sessions

- **Stuck session**: a profile that is not genuinely non-interactive (a
  command waiting for a confirmation) hangs until the timeout (`--timeout` >
  `profile.timeout` > `autonomousTimeoutMs`), then the process tree is killed
  (`session/cancel` first over ACP).
- **Failed session**: the clone is **kept** with a `keptReason`; the full log
  is in `.striart/logs/session-<agent>-<taskId>.log` (outside the clone — it
  survives its deletion).
- **Unauthenticated tool**: the session inherits the environment of the shell
  Striart was launched from — authenticate the tool in that shell first.

## The watcher

- `striart watch --daemon --status` — is the daemon running? PID? Logs in
  `.striart/logs/watch.log`.
- An orphaned daemon (PID file without a process) is detected and reported.
- The watcher only watches the clones' `.git/refs/heads/` — never the
  worktrees: a file change without a commit triggers nothing (by design:
  only commits count).

## Where are the logs?

| What | Where |
|---|---|
| Watcher/daemon logs | `.striart/logs/watch.log` |
| Autonomous session logs | `.striart/logs/session-<agent>-<taskId>.log` |
| Conflict tickets | `.striart/conflicts/<ticket>/` |
| Agent registry | `.striart/agents.json` |
| Task queue | `.striart/queue.json` |
| Merge history | `striart history` (rebuilt from the Git graph) |

# Troubleshooting

> [Documentation](README.md) · Troubleshooting

## First reflex: `striart doctor`

```bash
striart doctor                              # table of findings + actions to take
striart doctor --json | jq ".data.summary"  # scriptable: count of ok/warn/fail/skip
```

The doctor runs 23 checks: the git version, the **native component** (the
`striart-native` binary, signature, trusted keys), the **Test Gate container**,
the **terminal host (pty)**, the
repository and its first commit, initialization, whether the config loads and
validates, the **target branch** (missing → error; current branch different →
"merge and watch will refuse"), whether the LLM answers (Ollama ping, or the
cloud provider's API key present), historical secrets, the **main lock** and
the **state lock**, the main session, agents, open tickets, manual mode, the
**protected paths**, the **MCP server**, the **agent profiles**, **tokens and
cost**, **orchestration**, the **dashboard** (accepted hosts) and a summary of
the **protections relaxed** by the config. Each finding separates the
**fact** from the **action** (the exact command to run). "Operational" is
only announced when there is no warning at all; exit 1 as soon as a
prerequisite is missing. `striart init` chains this same diagnosis after
initialization.

## Exit codes

| Code | Nature | What to do |
|---|---|---|
| `0` | Success, or intended deferral (queued task, postponed rebase) | Nothing. |
| `1` | Execution or environment failure | Read the message and the hint; retrying may be enough. |
| `2` | Invalid usage (option, value, combination) | `striart <command> --help`. |
| `3` | Refusal: a guard protected work | Human decision: read the error code below. |
| `130` / `143` | Interrupted (Ctrl+C / SIGTERM) | See "Interrupting a command". |

## Error codes

Every Striart error carries a stable `code` (shown by the CLI under the
message, returned as is in `--json`, by MCP, the dashboard and the Control
Protocol) and, most of the time, a **hint**: the next command to run. In
`--json`, the error is a document on stdout (`ok: false`, `error.code`,
`error.kind`, `error.hint`, `error.details`). When one code covers several
causes, `error.details.reason` tells them apart with a stable sub-code (list
in [Commands](commands.md#machine-output---json)); the `*_CORRUPT` codes
carry `details.cause`. Every code is listed below, by nature.

**Refusals (exit 3)** — a guard protects work, retrying as is will change
nothing:

| Code | Meaning | Way out |
|---|---|---|
| `TARGET_BRANCH_MISMATCH` | The main repo is not on `targetBranch`. | `git switch <targetBranch>`, or adjust the config — see [Branches](branches.md#the-constraint-the-main-repo-must-be-on-targetbranch). |
| `MAIN_DIRTY` | The main repo has uncommitted changes. | Commit or stash, then retry. |
| `UNTRACKED_COLLISION` | Untracked files of the main repo would be overwritten by the merge. | Commit, move or delete them. |
| `SESSION_LIVE` | The clone hosts a live session (verified autonomous PID, ACP session host, or `--open` terminal for `clean`). | Wait for the session to end — neither `stop`, nor `clean`, nor `--force` will pass (`striart stop` stops an `--open` terminal). |
| `MAIN_SESSION_LIVE` | The **main repo** is reserved — agent launched via `--on-main` or intervention via `striart lock --start`. | Wait (`striart lock` shows reason/PID/duration), or `striart lock --stop` if it is over without having cleaned up. |
| `AGENT_HAS_PENDING` | `stop`: unmerged commits, or a clone unreadable by git (unknown work, presumed to exist). | `striart merge <agent>`, or `--force` to abandon. |
| `REUSE_DIRTY` / `REUSE_UNMERGED` / `REUSE_IN_USE` | The archive to reuse has uncommitted / unmerged work / recent activity. | Inspect the clone; `--reuse --force` accepts the loss. |
| `HISTORICAL_SECRETS_FOUND` | A path matching `secretPatterns` once existed in the repo history (readable via `git show <sha>:<file>` even though absent today). | Check/revoke the secret, then `--allow-historical-secrets` (`start`, `run`, `run --autonomous`), or `secretPatterns: []` to disable the check. |
| `AGENT_EXISTS` / `AGENT_QUEUED` | The agent is already active / already has a queued task. | `striart status`, `striart queue`, or `--reuse` for a stopped clone. |
| `CLONE_REMOVAL_PENDING` | Removal of the clone of this name was started and is not finished: the name cannot be reused. | `striart reconcile` (finishes it, unless a session is live). |
| `AFTER_CYCLE` | `--after` would create a dependency cycle. | `striart queue`. |
| `RESOLUTION_INCOMPLETE` / `STALE_TICKET` / `TICKET_NOT_APPLICABLE` / `TICKET_ALREADY_RESOLVED` | `resolve --apply`: missing resolution, stale ticket, conflict not file-by-file, already resolved. | `striart resolve --prepare <id>`, or rerun a normal merge. |
| `TICKET_CORRUPT` | The `ticket.json` is unreadable: nothing can be read, prepared or applied. | Inspect the ticket directory (the path is given), then `striart resolve --close <id>`. |
| `TICKET_PATH_UNSAFE` | A ticket names a path that is not a safe project path (absolute, climbing with `..`, or inside `.git`): nothing is written. The ticket file was probably edited by hand. | `striart resolve --close <id>`, then rerun the merge. |
| `TICKETS_UNREADABLE` | The `.striart/conflicts/` folder is unreadable (permissions, a file in its place, I/O) — `details.cause` carries the system cause. | `striart doctor`; fix the permissions. |
| `PROTECTED_PATHS_CHANGED` | The agent's commit changes a protected path (`AGENTS.md`, `.claude`, `striart.config.*`…) with no human resolution prepared. | Rerun `striart merge <agent>` to refresh the ticket with those paths, then decide each one (`resolve --prepare` / `--apply`). |
| `MERGE_WINDOW_EXCEEDED` | A conflict exceeds the Merger window (`tokens.merger.maxWindowTokens`): the model would truncate it. | Resolve by hand (`resolve --prepare`), or raise the window. |
| `TOKEN_BUDGET_EXCEEDED` | A `tokens.budgets` ceiling is reached: LLM call refused *before* sending, or agent session stopped. | `striart usage`; raise the ceiling or wait for the period to roll over. Does not count toward manual mode. |
| `TOKEN_PRICE_MISSING` | A **cost** ceiling is set with no price declared for that model: it cannot be enforced. | Declare the model in `tokens.pricing` (with `asOf`), or remove the cost ceiling. |
| `TOKEN_ACCOUNTING_FAILED` | `tokens.onAccountingError: 'fail'`: recording an LLM call (or re-reading the budget totals when a session starts) failed — accounting would be blind, so the operation is refused (`details.what`: `usage-ledger-write`, `post-call-budget-evaluation`, `session-budget-baseline`). With `'warn'` (default) the failure is only logged under the same code. | Inspect `.striart/usage/` (permissions, disk, antivirus), retry; or go back to `'warn'`. |
| `LOCK_LOST` | The main lock was lost (or was not held) during an operation: nothing was committed. | See "Stuck lock?". |
| `MERGE_STATE_CHANGED` | The main repo's state changed under the operation (`HEAD`, a merge opened by a third party): nothing was committed. | See "Stuck lock?". |
| `MERGE_RECOVERY_BLOCKED` | A merge open in the main repo will **not** be aborted by Striart (an earlier operation found it did not own it). | Finish it (`git commit`) or abort it (`git merge --abort`) by hand. |
| `MAIN_DIVERGED` | `promote`: `mainBranch` has commits outside the pipeline. | Merge `mainBranch` into `targetBranch` by hand. |
| `NOT_A_STRIART_MERGE` | `rollback`: the last commit is not a Striart merge. | `striart history`; beyond that, `git revert`. |
| `DAEMON_RUNNING` | A `watch`/`dashboard` daemon is already running. | `--status`, then `--stop`. |
| `DAEMON_STOP_DENIED` | `--stop`: the daemon belongs to another user (`EPERM`), it cannot be signaled from this account. Nothing is killed or forgotten: the PID file stays in place. | `striart <watch\|dashboard> --status`; stop it from the account that launched it. |
| `DAEMON_IDENTITY_UNVERIFIED` | `--stop`: the published PID is alive but its identity is unreadable (another user's process, hidden command line) — nothing is killed blindly, the PID file stays in place. | `striart <watch\|dashboard> --status`; check the process by hand (`ps`, Task Manager). |
| `DAEMON_PIDFILE_CORRUPT` | A daemon's PID file (`.striart/<watch\|dashboard>.pid`) is unreadable or has no valid PID: there is no way to know whether a daemon runs. Striart does **not** take it for "no daemon" (that would start a second daemon and leave `--stop` with no effect on the first). | Inspect the file (`details.path`), delete it if no daemon runs, then retry. |
| `DAEMON_SPAWN_FAILED` | The daemon's detached process could not be started (executable not found, permissions, no PID obtained). `details.cause` gives the reason; no PID file is left behind. | `striart doctor`; fix the cause, rerun `--daemon`. |
| `PTY_HOST_ALREADY_RUNNING` | A native pty host already holds this agent (the host's exclusive lock). | Attach to it: `striart attach <agent>`. |
| `PTY_SHELL_INVALID` | `pty.shell` designates an unusable shell: relative path, not found in the absolute `PATH` entries, or not executable. No fallback to `auto`. | Fix `pty.shell` in the config, or set it back to `auto`. |
| `TERMINAL_UNSAFE` | A path or argument contains NUL/CR/LF (or `"` on Windows): no terminal launcher can pass it. | Launch the tool by hand (the command is printed). |
| `NATIVE_INTEGRITY_FAILED` | The native binary is tampered with or unverifiable (digest mismatch, invalid signature, missing manifest, mismatched versions): it is **never** run. | Reinstall Striart (`npm install`), then `striart doctor`. See "Native component". |
| `MCP_READ_ONLY` / `MCP_DEPTH_LIMIT` / `MCP_SCOPE_DENIED` / `MCP_PROTECTED_TICKET` | Mutating MCP tool refused: server started `--read-only` / process descending from an autonomous session / outside the calling agent's scope (or no bound agent, another agent's ticket) / `resolve_prepare` or `resolve_apply` on a `PROTECTED_PATHS_CHANGED` ticket — approving a protected-path change is the decision the guard reserves to the human, refused to every MCP caller. | See [MCP server](mcp.md#who-is-calling-and-what-it-can-act-on); the human goes through `striart resolve`. |
| `CONTROL_UNAUTHENTICATED` / `CONTROL_ORIGIN_REFUSED` / `CONTROL_CSRF_REFUSED` / `CONTROL_NESTED_SESSION` | Dashboard or `striart api`: missing or expired session / request that does not come from the page / missing anti-CSRF headers / human-plane surface called from an agent session. | See "Dashboard: sign-in refused". |
| `ACP_AUTH_REQUIRED` | The ACP agent requires authentication, which Striart never does on its own. | Sign in with the tool itself, or set `acp.auth.methodId` (relaxation). |
| `ACP_HOST_BUSY` / `ACP_SESSION_CLOSING` / `ACP_BUS_DISABLED` / `ACP_HOST_AUTH_FAILED` | An ACP session already lives for this agent / it is closing / the bus is off (`acp.bus: false`) / client token refused by the host. | Wait for the session, or `striart stop <agent>`. |
| `ACP_IMPORT_UNPINNED` / `ACP_IMPORT_NO_INTEGRITY` / `ACP_DOWNLOAD_INTEGRITY_MISMATCH` / `ACP_EXTRACT_UNSAFE` | `profiles --import-acp`: unpinned version / no published sha256 checksum / checksum mismatch / archive with a symlink or escaping path. | Pick a pinned distribution; never bypass a checksum mismatch. |
| `ACP_PROXY_OPTION_LOCKED` / `ACP_PROXY_SESSION_ENDED` / `ACP_PROXY_PROMPT_BUSY` / `ACP_PROXY_COLLISION` / `ACP_PROXY_NO_PROFILE` / `ACP_PROXY_PROFILE_UNAVAILABLE` | `striart acp`: option frozen after the first prompt / session over / a prompt already running / Router collision (no clone created) / no ACP profile / profile outside the allow-list. | Open a new session; `acpAgent.collisionPolicy: 'wait'`; declare an `acp: true` profile (`striart profiles --detect`). |
| `COLLAB_DISABLED` / `COLLAB_NOT_MEMBER` / `COLLAB_KIND_FORBIDDEN` / `COLLAB_LIMIT_REACHED` | Collaboration channel: off (`collab.enabled: false`) / the agent is in no open group / `verdict` outside a reviewer's turn / message bound reached. | See [Execution modes](execution-modes.md#the-orchestration-modes). |
| `REVIEW_NOT_PENDING` | Human verdict requested on a review that no longer waits (deadline elapsed, already answered). | `striart review` for the list. |
| `HOOK_TARGET_TRACKED` / `HOOK_TARGET_FOREIGN` / `HOOK_PATH_UNSAFE` | `hook install`: the target is versioned by the repo / exists without being Striart's / a path cannot be written faithfully into the hook command. | `--user` instead of `--agent`; never overwrite a foreign file; `STRIART_HOOK_BIN_DIR` to a space-free directory. |

**Usage (exit 2)** — rejected before any action:

| Code | Meaning |
|---|---|
| `UNKNOWN_OPTION`, `UNKNOWN_COMMAND`, `MISSING_COMMAND`, `MISSING_ARGUMENT`, `MISSING_OPTION`, `MISSING_OPTION_VALUE`, `EXCESS_ARGUMENTS`, `INVALID_ARGUMENT`, `OPTION_CONFLICT` | Invalid command line (a "did you mean…" suggestion accompanies a misspelled command). |
| `INVALID_AGENT_NAME`, `EMPTY_PROMPT`, `REUSE_NEEDS_AGENT`, `PLAN_INVALID` | Invalid input regardless of the repo state. `PLAN_INVALID` / `COMMAND_NOT_AN_EXECUTABLE_NAME`: a plan task's `command` must be an **executable name** (no path, space or option) — it is typed into the pty's shell; options go in `agentCommand` or a profile. |
| `INVALID_RETENTION_DAYS` | `prune`: invalid retention (refused instead of deleting everything). |
| `USAGE_PERIOD_INVALID` | `usage`: malformed (`7d`, `24h`, `today`, `YYYY-MM-DD`) or inconsistent `--since`/`--until`. |
| `ORCHESTRATE_USAGE` | `orchestrate`: an option foreign to the chosen mode, or a mandatory option of the mode missing (`details.reason`). |
| `REVIEW_VERDICT_INVALID` | `review`: malformed verdict (`--request-changes` without `--comment`…). |
| `LOCK_PID_EPHEMERAL` | `lock --start` without `--pid` from a process that is not a durable interactive shell: the hint gives the `--pid` command suited to the shell. |
| `LOCK_PID_DEAD`, `LOCK_REASON_EMPTY`, `INVALID_PID` | A reservation that would protect nothing. |
| `UNSUPPORTED_OUTPUT_FORMAT`, `UI_REQUIRES_TTY`, `ATTACH_WRONG_CWD` | `--json` on `mcp`/`api`/`acp`/`attach`/`completion`/`watch --ui`, `watch --ui` with no terminal, `attach` outside the clone. |
| `MCP_ROOT_INVALID`, `MCP_SCOPE_CONFLICT` | `mcp`: `--root` does not designate an initialized Striart repo / `--agent` contradicts the clone of the current directory. |
| `HOOK_TOOL_UNKNOWN`, `HOOK_SCOPE_REQUIRED` | `hook install\|uninstall`: unknown tool (`claude`, `codex`, `copilot`, `gemini`, `cline`) / neither `--user` nor `--agent` (or both). |
| `ACP_AGENT_UNKNOWN` | `profiles --import-acp`: identifier absent from the ACP registry. |
| `PERMISSION_ID_INVALID`, `ELICITATION_CONTENT_INVALID`, `ACP_PROMPT_INVALID` | Malformed human answer (identifier, form not matching the agent's schema); invalid bus message (empty, too long, control characters). |
| `ACP_PROXY_OPTION_UNKNOWN`, `ACP_PROXY_OPTION_INVALID`, `ACP_PROXY_SESSION_UNKNOWN`, `ACP_PROXY_NOT_INITIALIZED`, `ACP_PROXY_AUTH_METHOD_UNKNOWN`, `ACP_PROXY_METHOD_UNSUPPORTED`, `ACP_PROXY_CWD_OUTSIDE_ROOT` | `striart acp`: malformed or out-of-protocol editor request — unknown/invalid session option, unknown session, `initialize` missing, authentication method other than `striart-local`, unserved method (`fs/*`, `terminal/*` never are), directory outside the served repo (`--root`). |
| `COLLAB_MESSAGE_INVALID`, `COLLAB_RECIPIENT_UNKNOWN`, `COLLAB_GROUP_AMBIGUOUS`, `COLLAB_ROLE_AMBIGUOUS` | Malformed collaboration message / unknown recipient / group or role to specify. |
| `CONTROL_PARSE_ERROR`, `CONTROL_INVALID_REQUEST`, `CONTROL_MESSAGE_TOO_LARGE`, `CONTROL_METHOD_UNKNOWN`, `CONTROL_METHOD_UNAVAILABLE`, `CONTROL_SUBSCRIPTION_UNKNOWN`, `CONTROL_VERSION_UNSUPPORTED` | Control Protocol: malformed or out-of-contract message (invalid JSON, unreadable `Content-Length` framing, message over 1 MB, unknown method or not served on this transport, unknown subscription, unsupported version). Fix the request. |

**Failures (exit 1)** — execution or environment, possibly transient:

| Code | Meaning | Way out |
|---|---|---|
| `NOT_A_GIT_REPO` / `NOT_INITIALIZED` / `EMPTY_REPO` | No repo, no `.striart/`, no commit. | `git init`, `striart init`, a first commit. |
| `UNKNOWN_BRANCH` | `targetBranch` (or `mainBranch`) does not exist — checked before any clone or LLM call. | Fix the config (`git branch --list`). |
| `CONFIG_INVALID` / `LLM_CONFIG_INVALID` | Config refused (only the faulty **key** is quoted, never its value; for a `dashboardAllowedHosts` pattern, the entry index; an **unknown** top-level key — a typo — carries `UNKNOWN_KEY` and a suggestion) / LLM provider misconfigured. | `striart doctor`, [Configuration](configuration.md). |
| `SECRET_PATTERN_INVALID` | A `secretPatterns` pattern is unsupported: `!` negation, `#` comment, empty pattern or newline. | Fix `secretPatterns` in the config. |
| `USER_CONFIG_INVALID` / `USER_CONFIG_UNSAFE` | The **user** config (`hooks.trustedRoots`) is invalid (JSON, unknown key, non-absolute root) / writable by group or others, or not owned by the user (POSIX). It is ignored: no root is trusted. | Fix the JSON; `chmod 600` the file. |
| `ROUTER_FAILED` / `LLM_FAILED` / `SEMANTIC_MERGE_FAILED` / `MEMORY_FAILED` / `RACE_JUDGE_FAILED` | The LLM did not answer or returned unusable output (after retries and backoff; an open circuit breaker fails without waiting). | `striart doctor` (LLM reachable? key present?); retry — the Router is a filter, not a guarantee. |
| `AGENT_UNKNOWN` / `TICKET_UNKNOWN` / `CLONE_NOT_FOUND` / `PROFILE_UNKNOWN` / `AFTER_UNKNOWN` / `PLAN_NOT_FOUND` / `REVIEW_UNKNOWN` | Target not found. | `striart status`, `striart resolve --all`, `striart profiles`, `striart review`. |
| `LOCK_TIMEOUT` | Main lock not obtained within 2 min. | See "Stuck lock?". |
| `LOCK_WAIT_CANCELLED` / `LOCK_IO_FAILED` | Wait for the lock cancelled before any acquisition (nothing started) / I/O on the lock or its queue impossible (permissions, antivirus, disk). | Retry; check the permissions of `.striart/`. |
| `STATE_LOCK_TIMEOUT` / `STATE_LOCK_LOST` / `STATE_LOCK_FAILED` | State lock (`.striart/state.lock`): not obtained / lost before the write (nothing written) / cannot be handled. | See "State lock and state files". |
| `STATE_READ_FAILED` / `STATE_WRITE_FAILED` | A state file cannot be read / written even after retries (the previous state stays intact). | Permissions, full disk, antivirus; retry. |
| `REGISTRY_CORRUPT` / `QUEUE_CORRUPT` / `LOCKS_CORRUPT` / `STATE_CORRUPT` / `MAIN_SESSION_CORRUPT` / `COLLAB_CORRUPT` / `REVIEW_CORRUPT` / `ORCHESTRATION_STATE_CORRUPT` | Unreadable state file (`details.path`, `details.cause`). | See "State lock and state files". |
| `NATIVE_UNAVAILABLE` / `NATIVE_COMMAND_FAILED` / `NATIVE_PROTOCOL_ERROR` | Native binary not found for this platform or its package missing / native command failed or timed out / binary of another protocol version. | See "Native component". |
| `GATE_ORPHAN_PROCESS` / `JOB_TERMINATE_INCOMPLETE` | Red Test Gate with no failing test: a descendant of the test was still alive after it exited and `gateOrphanGraceMs` (killed) / the process container cleanup did not complete (surviving processes). | See "Red Test Gate with no failing test". |
| `PTY_HOST_SPAWN_FAILED` / `PTY_ATTACH_LISTEN_FAILED` / `PTY_HOST_UNKNOWN_AGENT` / `PTY_SESSION_NOT_FOUND` | The terminal host could not start or listen / agent not in the registry / no terminal session for this agent. | `striart doctor` ("terminal host" line); `striart start <agent> --open`. `details.nativeCode` names the native cause, for instance `PTY_ENDPOINT_TOO_LONG`: on POSIX the attach socket path (`.striart/pty/<agent>/attach.sock`) exceeds the OS limit (104 bytes on macOS, 108 on Linux) — work from a shorter project path. |
| `PORT_IN_USE` | The dashboard port is taken. | `--port <other>`. |
| `CONTROL_INSTANCE_NOT_FOUND` / `CONTROL_TOKEN_UNPROTECTED` | `dashboard --link`: no dashboard runs for this repo (or its token file is unreadable) / the token file cannot be reserved to the user (refused: no token is left readable by others). | `striart dashboard --daemon`; permissions of the state directory. |
| `DAEMON_BUSY` | The PID-file lock of a daemon (`.striart/<watch\|dashboard>.pid.lock`) is held by another command beyond the wait. | Retry; `striart <watch\|dashboard> --status`. A lock older than 30 s is broken automatically. |
| `PROFILE_INVALID` | Malformed agent profile (only the faulty **field** is quoted, never the profile's env). | `striart profiles`. |
| `COMMITTER_IDENTITY_MISSING` / `STRIART_COMMIT_UNSAFE` | Commit contract: no git identity for the user in the main repo (`user.name`, `user.email`) / the Striart commit held forbidden paths and was undone. | Set the git identity; inspect the clone. |
| `ACP_AUTH_METHOD_UNAVAILABLE` | `acp.auth.methodId` is not a protocol method advertised by the agent ("terminal" methods are never passed to `authenticate`). | Fix `methodId`. |
| `ACP_HOST_SPAWN_FAILED` / `ACP_HOST_UNREACHABLE` / `ACP_HOST_LOST` / `ACP_HOST_FAILED` / `ACP_HOST_PROTOCOL` / `ACP_SESSION_NOT_FOUND` | ACP session host: could not start / unreachable / disappeared without reporting a result (see `.striart/logs/acp-host-<agent>.log`) / unexpected error / unexpected frame / no live ACP session for this agent (an argv session is *one-shot*). | Host log; relaunch the task. |
| `ACP_PROXY_QUEUE_TOOK_OVER` / `ACP_PROXY_UPSTREAM_ENDED` | `striart acp`: the queue relaunched the task before Striart could take it back / the upstream agent session ended before the turn finished. | `striart queue`; the outcome is reported in the session. |
| `ACP_REGISTRY_FETCH_FAILED` / `ACP_REGISTRY_INVALID` / `ACP_IMPORT_PLATFORM_UNSUPPORTED` / `ACP_EXTRACT_FAILED` | `--import-acp`: registry unreachable / invalid document / no distribution for this platform / extraction impossible. | Network; `acpRegistry.url`. |
| `ACP_IMPORT_ENV_FORBIDDEN` | `--import-acp`: the registry agent asks for a non-allowed environment variable (`details.variable`). | List it in `acpRegistry.allowEnv` if it is safe; never possible for `NODE_OPTIONS`, `PATH`, `LD_*`… |
| `ACP_SOCKET_DIR_UNSAFE` | POSIX: the private folder of the ACP session host socket is not a real directory of yours in mode `0700` (`details.path`). | Inspect it, remove it (`rm -r <path>`), retry. |
| `PERMISSION_NOT_PENDING` / `PERMISSION_OPTION_UNKNOWN` / `ELICITATION_INVALID` / `ELICITATION_NOT_PENDING` | Arbitration: request no longer waiting / option the agent did not propose / form schema refused (not validatable) / question no longer waiting. | Refresh the state; the request may have expired (fail closed). |
| `SESSION_LOG_UNAVAILABLE` | No session log for this agent (the session may not have started). | `striart status`. |
| `MCP_OVERLOADED` / `MCP_RESOURCE_UNKNOWN` | Too many simultaneous MCP requests / unknown resource. | `mcp.maxConcurrentRequests`; list the resources. |
| `COLLAB_GROUP_UNKNOWN` | Unknown collaboration group. | `striart status` (`orchestration` field). |
| `HOOK_CONFIG_UNREADABLE` | `hook install`: the tool's configuration is unreadable — left untouched. | Repair it, then rerun. |
| `SAFE_WRITE_UNSAFE` | Striart refuses to write (memory, instructions, collaboration inbox, git exclusion, hooks config) because a path component is a symlink, a junction or a non-directory inside the clone (`details.reason`, `details.path`) — it never writes through a link. | Inspect the path in the clone (an agent may have planted it), remove it; `striart doctor`. |
| `TERMINAL_LAUNCHER_UNSUPPORTED` / `TERMINAL_CONTEXT_MISSING` / `WARP_NOT_FOUND` | `terminal.launcher` unavailable on this platform / Warp requested outside an agent clone / Warp's data directory not found (installed for this user?). | Pick another launcher in `terminal.launcher`. |
| `CLONE_FAILED` / `SECRETS_EXCLUSION_FAILED` / `MERGE_FAILED` / `MERGE_ABORT_FAILED` / `REUSE_FETCH_FAILED` / `REUSE_NO_CLONE` | Git failure (`MERGE_ABORT_FAILED`: the main repo stays in a "merging" state). | `striart doctor`; `git merge --abort` by hand for `MERGE_ABORT_FAILED`. |
| `MERGE_COMMIT_FAILED` | git refused the merge commit (`pre-commit` / `commit-msg` hook, missing git identity): the merge is cancelled, the main repo is clean, nothing is committed. | Fix the hook or `git config user.name` / `user.email`, then rerun the merge. |
| `PROMOTION_DISABLED` / `UNSUPPORTED_RESOLUTION_KIND` | `promote` without `mainBranch` / `--apply` on a conflict not resolvable file by file. | See [Branches](branches.md#the-staging--main-pipeline); `git` by hand then `resolve --close`. |
| `UNEXPECTED` | Unforeseen error. | `STRIART_LOG_LEVEL=debug` for the full stack. |

**Warnings** (`warnings` field of `--json`, exit 0 — not errors):
`DEPRECATED_OPTION` (`--force` without `--reuse`, alias of
`--allow-historical-secrets` until 0.12), `TERMINAL_OPEN_FAILED` (the
`--open` tab did not open), `PTY_HOST_STOPPING` / `PTY_HOST_UNTOUCHED`
(`stop`: the terminal host is still stopping / was left in place),
`AGENT_ARTIFACT_FAILED` (`stop`/`clean`: the agent's ACP session host or Warp *Tab Config* could not be released — the stop or removal itself succeeded), `ALREADY_INTEGRATED` (`run --autonomous`, orchestrated modes, ACP proxy: the agent's commit was already in the target, nothing was merged, no Test Gate re-run, clone cleaned), a warning carrying a domain error code (`stop`: clearing the queue failed after the stop — `data.queueError`; `striart queue --retry`),
`ACP_BINARY_DOWNLOADED` (`--import-acp` with
`acpRegistry.allowBinaryDownload`: binary downloaded, checksum verified),
`CONTROL_LINK_PENDING` (`dashboard --daemon`: the daemon has not yet
published its address, rerun `striart dashboard --link`) and
`HOOK_ADVISORY_SKIPPED` (a hook answered neutrally without blocking
anything).

Result **statuses** (`CONFLICT`, `GATE_FAILED`, `SKIPPED_SESSION`,
`CANCELLED`, `BUDGET_EXCEEDED`, `COMMIT_REFUSED`, `REVIEW_REJECTED`…) are not
errors: they are in the `--json` document's `data.status`. A merge in
`GATE_FAILED` exits 3 with a ticket; a clone skipped by `clean` carries its
reason (`IN_USE`, `SESSION_LIVE`, `PENDING`, `BUSY`) in `skipped`.

| Command | `data.status` | Meaning | Exit |
|---|---|---|---|
| `merge`, `watch` | `MERGED` | Agent commit merged, Test Gate green (`mergeSha`: the commit `rollback` undoes). | 0 |
| | `UP_TO_DATE` | Nothing to merge; with `alreadyMerged: true` the commit was already in the target (`mergeSha` names it, no gate re-run). | 0 |
| | `CONFLICT` | Reason (`reason`): `MERGE_CONFLICT`, `UNMERGEABLE_CONFLICT` (binary, file mode…), `SEMANTIC_MERGE_FAILED`, `PROTECTED_PATHS_CHANGED`. A ticket is opened. | 3 |
| | `GATE_FAILED` | Red Test Gate: merge aborted, ticket opened. | 3 |
| `resolve --apply` | `MERGED` / `GATE_FAILED` | Resolution applied behind the gate / red gate (ticket left open, manual mode untouched). | 0 / 3 |
| | `ALREADY_CLEAN` | The commit was already merged or the conflict no longer reproduces: nothing to apply, ticket (and duplicates) closed. | 0 |
| `promote` | `PROMOTED` / `UP_TO_DATE` / `GATE_FAILED` | `mainBranch` fast-forwarded / nothing to promote / red global gate (`rolledBack`). | 0 / 0 / 3 |
| `rollback` | `ROLLED_BACK` | Last Striart merge undone (`mode`: local `reset` or published `revert`). | 0 |
| `run --autonomous`, orchestrated modes | `QUEUED`, `MERGED`, `EMPTY`, `SESSION_FAILED`, `MERGE_BLOCKED`, `COMMIT_REFUSED`, `COMMIT_FAILED`, `KEPT` | See "Autonomous sessions"; `EMPTY`: the session exited 0 with no commit at all. | 0 / 0 / 1 / 1 / 3 / 3 / 1 / 3 |
| `striart acp` proxy | same, plus `NOTHING_STARTED`; `keptCode: MERGE_DEFERRED` | No session started / merge left to the human (`MANUAL`) or editor disconnected (`DISCONNECTED`, `onDisconnect: 'keep'`). | — |
| commit contract (`commit` field) | `COMMITTED`, `NOTHING_TO_COMMIT`, `SKIPPED_AGENT_COMMITTED` | Striart committed `files` / nothing committable (`excluded`: secrets and injected files) / `agent-then-striart` and the agent committed itself. | — |

A ticket's `reason` (`ticket.reason`) is one of `MERGE_CONFLICT`, `UNMERGEABLE_CONFLICT`, `GATE_FAILED`, `SEMANTIC_MERGE_FAILED`, `SEMANTIC_GATE_FAILED` (the LLM merge passed the gate… then lost it after retries), `PROMOTION_GATE_FAILED` or `PROTECTED_PATHS_CHANGED`.

## Conflict tickets and manual mode

Every merge failure produces a complete ticket in
`.striart/conflicts/<ticket>/`: `base`/`ours`/`theirs` versions, LLM attempt
(`llm-attempt`), Test Gate log (`test-output.log`). The same commit retried
updates its open ticket (`attempts`) instead of creating a new one. Tickets
are written atomically; an unreadable `ticket.json` is rendered everywhere
(CLI, dashboard, Control Protocol, MCP) as a `CORRUPT` ticket with its cause,
never as an empty ticket. A ticket born from a Test Gate **execution** red
carries `gate: {code, orphanPids, truncated}` (stable code, PIDs of the
orphans killed, log truncated at the `gateMaxOutputBytes` ceiling) — see "Red
Test Gate with no failing test".

```bash
striart resolve                 # lists open tickets
striart resolve --all           # … including already resolved ones
striart resolve --prepare <id>  # seeds <file>.resolved from the agent's version (except protected paths: --accept-theirs <path>)
striart resolve --apply <id>    # replays the ticket's exact merge, under lock + Test Gate
striart resolve --close <id>    # marks a ticket resolved WITHOUT going back through the Test Gate
```

`--prepare`/`--apply` are the **tested** path: the resolution goes through the
same inter-process lock and the same blocking Test Gate as the automatic
merge, instead of a `git merge` done by hand outside Striart's framework (the
source of a real incident: a collision with an active `striart watch`).
`--close` remains useful if the conflict was already settled otherwise.

**Manual mode**: after 3 failed semantic merges in a row, Striart disables
LLM merging (safety rule — an LLM that keeps failing must not keep touching
the code). `striart resolve --unlock` re-enables it once the cause is dealt
with. A token-budget refusal (`TOKEN_BUDGET_EXCEEDED`) is not an LLM failure
and does not count.

**`PROTECTED_PATHS_CHANGED` ticket**: the agent changed a file that
configures or instructs agents (`AGENTS.md`, `.claude`, `.mcp.json`,
`.vscode/settings.json`, `striart.config.*`…). The merge was refused *before*
any merging. Review the diff of those paths; to accept, resolve them
explicitly (`resolve --prepare` then `--apply`). The list is tunable
(`protectedAgentPaths.extend` / `allow`).

## Undoing a merge: `striart rollback`

Undoes the **last Striart merge** of the target branch:

- unpushed merge → local `reset` (recoverable via reflog);
- already pushed merge → `revert` (published history is kept).

Refuses if the target branch's last commit is not a Striart merge — it never
undoes a human commit. `striart history` rebuilds the list of merges
(automatic, semantic or hand-resolved) and rollbacks from the Git graph.

## Inconsistent state: `striart reconcile`

After a crash, a `kill -9`, a pulled plug: `striart reconcile` puts
everything back in order — dead sessions neutralized in the registry, queue
unblocked, orphan locks broken, an abandoned merge (orphan `MERGE_HEAD`)
cleanly aborted, **clone removals already started finished**.
**Idempotent**: running it "for nothing" costs nothing. `striart watch`
replays it automatically.

## Interrupting a command (Ctrl+C)

- **Short commands** (`merge`, `sync`, `stop`…): cut short (exit 130).
  Recovery after interruption is proven: the lock held by the process is
  removed on its exit, a merge left mid-flight is aborted at the next lock
  acquisition. A wait for the main lock can be cancelled cleanly
  (`LOCK_WAIT_CANCELLED`, nothing started); once the lock is held, the
  operation is never interrupted midway.
- **Long commands** (`watch`, `dashboard`): clean stop — the in-flight merge
  (Test Gate included) completes and its result is shown; merges still
  queued do not start and are reported (`merge-deferred`, hint
  `striart merge <agent>`): the next watcher will not pick them up, rerun
  them by hand. `watch --ui` unmounts without waiting for the in-flight merge.
- **Sessions** (`run --autonomous`, `run --on-main`, `plan` outside
  `--dry-run`, `orchestrate`, `striart acp`): the agent's tree is killed (ACP:
  `session/cancel` first), **then** the session is unpublished — the
  (autonomous) clone is kept, the session returns `CANCELLED`. `plan` starts
  no further task and lists those left unapplied (`notApplied`); it exits
  130/143, `ok: false` in `--json`. A second Ctrl+C cuts immediately.
- **Daemons** (`watch --daemon`, `dashboard --daemon`): `--stop` goes through
  a stop request the daemon reads itself — clean stop on Windows too, where
  a signal would be an abrupt kill.

## Stuck lock?

The main lock (`.striart/main.lock`) is held by a **heartbeat**: its holder
refreshes it every 5 s. A lock wait expires after 2 min (`LOCK_TIMEOUT`) with
an explicit message naming the holder, its age and the number of operations
queued ahead of you (the queue is **fair**, served by arrival number,
`.striart/lock-queue/`). A lock is only broken on **proof** that its holder no
longer exists:

| `details.reason` of `LOCK_TIMEOUT` | Meaning | What to do |
|---|---|---|
| `HELD` | A long operation (merge, Test Gate) holds the lock, and beats. | Wait. |
| `HOLDER_FROZEN` | The holder is **alive** but its heartbeat is frozen (frozen process: debugger, `SIGSTOP`, synchronous loop). It is **never** broken by default — breaking it would leave two processes in the section once it thaws. | Stop the indicated PID if it is stuck, or allow breaking with `lock.breakFrozenHolderAfterMs` (≥ 60,000, logged relaxation). |
| `LOCK_UNREADABLE` | The file is unreadable (permissions, Windows sharing): never broken blindly. | Check the permissions of `.striart/`. |
| `BREAK_IN_PROGRESS` / `BREAK_FAILED` | Another process is breaking a stale lock / the stale lock cannot be deleted (antivirus, permissions). | Be patient; close whatever holds `.striart/main.lock`. |

The cases where the holder is gone — dead process, PID reassigned to another
program, old format older than 30 min, old invalid content — are broken
automatically, under a break lock (`.striart/lock-queue/break.lock`) that
compares content **and** date before deleting: two simultaneous breakers can
no longer delete each other's fresh lock. If a lock looks stuck:
`striart doctor` (the "Main lock" line says which case applies), then
`striart reconcile`.

**`LOCK_LOST`**: the operation found, just before an irreversible effect
(commit, write into the main repo), that it no longer held the lock (broken
by another process, or never held). **`MERGE_STATE_CHANGED`**: the main
repo's `HEAD` or `MERGE_HEAD` is no longer what the operation had set —
someone acted on it. In both cases, **nothing is committed** and the
repository stays recoverable (the next Striart operation aborts a merge left
open, unless the operation found it did not own it: then a
`.striart/merge-state-changed.json` marker makes every operation refuse —
`MERGE_RECOVERY_BLOCKED` — until that merge is finished or aborted by hand;
deleting the marker lets Striart abort it itself). Check who acted
(`git status`, `git log -3`, `striart doctor`) before retrying.

## State lock and state files

State files (`agents.json`, `queue.json`, `state.json`, `locks.json`,
`main-session.json`, tickets, permission requests, reviews…) are written
**atomically** (unique temporary file, `fsync`, rename, bounded retries on
Windows when another process holds the target); every read-modify-write goes
through a short **state lock**, `.striart/state.lock` (milliseconds, never
held during a long operation; fixed acquisition order: main lock then state
lock). `STATE_LOCK_TIMEOUT`: a **live**, identified holder is never broken,
however old — the wait expires (reasons `HELD`, `LOCK_UNREADABLE`,
`BREAK_IN_PROGRESS`, `BREAK_FAILED`); an orphan lock (dead holder, recycled
PID, old unreadable content) is broken automatically, under the
`state.lock.break` break lock. The "State lock" line of `doctor` says whether
a lock is free, orphaned or stuck. `STATE_LOCK_LOST`: the lock was lost
before the write — nothing was written, retry. A `*_CORRUPT` does not repair
itself: the file is JSON (`jq . .striart/<file>.json` gives the error);
restore or delete it (`agents.json` rebuilds badly — prefer restoring), then
`striart reconcile`. The `*.tmp` files of an interrupted write are swept by
`striart reconcile`.

## Native component

Striart relies on a small Rust binary, `striart-native`: process identity
(recycled PIDs), process tree (killing the Test Gate and sessions), the
terminal host (pty), a process container. It ships in a platform package
(`@jumsay/striart-native-<os>-<cpu>`, an optional dependency of the main
package), **verified** against a signed manifest (minisign) before every run.
`striart doctor` ("Native component" line) says which source is selected and
whether the signature is verified.

| Code / reason | Cause | Way out |
|---|---|---|
| `NATIVE_UNAVAILABLE` `PACKAGE_MISSING` | The platform package is not installed (optional dependencies skipped). | `npm install` without `--omit=optional`. |
| `NATIVE_UNAVAILABLE` `DEV_BUILD_MISSING` | From a repository checkout, the binary is not built. | `npm run native:build` (Rust toolchain required). |
| `NATIVE_UNAVAILABLE` `PLATFORM_UNSUPPORTED` / `PLATFORM_NOT_PUBLISHED` | No binary published for this platform (published: Windows, macOS and Linux, x64 and arm64; Linux as static musl). | Build by hand and point `STRIART_NATIVE_BIN` at it (absolute path — its integrity is then **not** verified, `doctor` says so). |
| `NATIVE_UNAVAILABLE` `ENV_NOT_ABSOLUTE` / `ENV_MISSING` / `BINARY_MISSING` | `STRIART_NATIVE_BIN` relative or pointing at a missing file / binary missing from its package. | Fix the variable; reinstall. |
| `NATIVE_INTEGRITY_FAILED` | SHA-256 digest mismatch, invalid manifest signature, missing manifest, main and native packages at different versions. The binary is **never** run (fail closed). | Reinstall Striart (`npm install`); never bypass. |
| `NATIVE_COMMAND_FAILED` / `NATIVE_PROTOCOL_ERROR` | The native command failed or timed out / the binary answers outside its protocol (another Striart version?). | `striart doctor --json`; reinstall. |

If the native binary is unavailable, `killProcessTree` does not go quiet: the
`NATIVE_*` error is logged at `error` level, then only the head process (and,
on POSIX, its group) is killed.

## Red Test Gate with no failing test

The Test Gate runs in the native process container. It returns red, with a
`code` in the result, in cases where the test itself did not fail:

| Code | Meaning | Way out |
|---|---|---|
| `GATE_ORPHAN_PROCESS` | The command returned 0 (or not), but descendants were still alive `gateOrphanGraceMs` after it exited: they were killed and the gate is red. The log lists the PIDs. | Fix the test that leaves a server or watcher behind; or raise `gateOrphanGraceMs` if shutdown is slow. |
| `JOB_TERMINATE_INCOMPLETE` | The container cleanup could not guarantee that no process survives. | `striart doctor`; check remaining processes by hand. |
| `GATE_INTERRUPTED` | The native container received an interruption signal (Ctrl+C, process stop) during the test: execution abandoned, nothing is committed. | Rerun. |
| `GATE_NATIVE_UNAVAILABLE` | Native binary unavailable or unverified, or the container report is unusable: the gate is **not run** (fail closed). | See "Native component"; explicit relaxation: `gateContainer: 'process'` (no orphan detection). |

## Dashboard: sign-in refused

- **401 "sign-in required"** on the bare URL: normal, the dashboard requires a
  one-time sign-in link. `striart dashboard --link` issues a new one (valid
  `dashboardLinkTtlMs`, 5 min by default, once).
- **Link "invalid, expired or already used"**: a link works once and only for
  the instance that issued it (the port is part of it). Issue another.
- **403 non-local `Host`**: the name you reach the dashboard by is neither the
  instance's (`<random-id>.localhost`, shown in the sign-in link — the bare
  `localhost` address is no longer served) nor listed in
  `dashboardAllowedHosts` (Codespaces, proxy). Strict
  patterns — see [Configuration](configuration.md#dashboard-and-control-protocol).
- **403 cross-site / `CONTROL_ORIGIN_REFUSED` / `CONTROL_CSRF_REFUSED`**: the
  request does not come from the dashboard page (another site, another local
  port, missing `X-Striart: 1`). A script should use `striart api`.
- **410 on `/api/…`**: those routes were replaced by the Control Protocol
  (`POST /rpc`, `GET /events`) in 0.11; see `rpc.discover` or
  `striart api --schema openrpc`.
- **`CONTROL_NESTED_SESSION`**: `striart api`, `acp`, `dashboard` or `--link`,
  but also `resolve`, `merge`, `stop`, `lock`, `rollback` and `promote`, called
  from an agent session (`STRIART_SESSION=1`) — refused on purpose: an agent
  does not arbitrate in the human's place. Run the command from a terminal
  outside the session.
- **`.env`: "variable(s) not allowed, ignored"**: the repository's `.env` is
  untrusted data, only API keys and display variables are applied. To admit
  others, use `env.allow` in the
  [user configuration](configuration.md#user-configuration-outside-the-repository);
  `NODE_*`, `LD_*`, `PATH*`, `STRIART_NATIVE_BIN`… never will be.

## Main repo reserved (`MAIN_SESSION_LIVE`)

`striart run --on-main` or `striart lock --start` declare a session on the
main repo itself (not a clone): as long as the watched PID lives, every
mutating operation (merge, sync, promote, `resolve --apply`, `watch`'s
auto-merge) is refused. **No TTL**: unlike `main.lock`, nothing automatically
breaks a session declared for too long — `striart lock` (no option) shows the
reason, PID and duration; `striart lock --stop` releases in every case
(emergency exit, even if the PID still lives).

`lock --start` refused with `LOCK_PID_EPHEMERAL`? The calling process is not
a durable interactive shell (script, `bash -c`, Git Bash): the reservation
would fall at the end of the command. Rerun with the command given by the
hint, which names the shell to watch (`--pid $PID` in PowerShell, `--pid $$`
in bash/zsh…).

## Autonomous sessions

- **Stuck session**: a profile that is not truly non-interactive (a command
  waiting for a confirmation) stays blocked until the timeout
  (`--timeout` > `profile.timeout` > `autonomousTimeoutMs`), then the process
  tree is killed (`session/cancel` first in ACP).
- **Failed session**: the clone is **kept** with a `keptReason`; the full log
  is in `.striart/logs/session-<agent>-<taskId>.log` (outside the clone — it
  survives its deletion; in ACP it is written as it goes).
- **Session stopped by a ceiling** (`BUDGET_EXCEEDED`): `striart usage` says
  which `tokens.budgets` ceiling; the interrupted work is not merged.
- **Clone kept without a merge**: `NO_COMMIT` (an agent commit was expected),
  `NO_CHANGES`, `ONLY_EXCLUDED_CHANGES` (only secrets or injected files
  remained), `COMMIT_REFUSED` / `COMMIT_FAILED` (Striart commit impossible),
  `MERGE_BLOCKED` (conflict, red gate, protected path), `CLEANUP_SKIPPED`
  (merge succeeded, cleanup refused by a guard) or `HUMAN_REVIEW_REQUIRED`
  (`KEPT` status, exit 3: `commitPolicy: 'human'` and the agent committed —
  **never an automatic merge**, in any mode). The `--json` document's
  `keptCode` says which.
- **"Noisy" success**: if the agent's commit was already in the target
  (it arrived another way), the status is `MERGED` with the
  `ALREADY_INTEGRATED` warning; nothing is merged and the Test Gate is **not**
  re-run. Check that the expected work is really in the target branch.
- **Unauthenticated tool**: the session inherits the environment of the shell
  Striart is launched from — authenticate the tool in that shell first. In
  ACP, `ACP_AUTH_REQUIRED` says so explicitly.
- **Commit failing with Codex**: its sandbox makes `.git` read-only — the
  preset has `commitPolicy: 'striart'` (Striart commits the worktree).
- **`ollama` profile**: it is now Aider on a local Ollama model; `aider` must
  be installed (`striart profiles --detect`).

## Orchestrated modes, reviews, collaboration

- `striart orchestrate` / v2 `plan` ends in `REVIEW_REJECTED`,
  `REVIEW_EXHAUSTED`, `VERDICT_INVALID`, `READ_ONLY_VIOLATION`,
  `SCOPE_VIOLATION`, `TEAM_COMMIT_FORBIDDEN`, `RACE_NO_WINNER`, `WAIT_TIMEOUT`
  or `SKIPPED`: these are node **statuses** (not errors), readable in
  `striart status` (`orchestration`) and the `--json` document.
- A human review waiting: `striart review` (list) then
  `striart review <id> --approve|--request-changes|--reject`. With no answer
  within `orchestration.review.humanTimeoutMs`, the node fails (fail closed).
- An agent reviewer that wrote in the author's clone fails the review
  (`READ_ONLY_VIOLATION`); `orchestration.review.reviewerWrites: 'discard'`
  discards its writes instead (relaxation).

## Advisory hooks

A hook installed by `striart hook install` **never** blocks: an empty answer
or a warning on stderr (`HOOK_ADVISORY_SKIPPED`) is the normal behavior
outside a clone, or when the repository's config is not trusted. For a hook
installed *for the user* to load a repository's full (code) config, list it in
`hooks.trustedRoots` of the user config — see
[Configuration](configuration.md#user-configuration-outside-the-repository).

## Terminal (`--open`) and Warp

- The tab does not open (`TERMINAL_OPEN_FAILED`): the agent is ready, the
  command to run by hand is printed. Change launcher: `terminal.launcher`.
- Warp: the tab opens through a *Tab Config* written in Warp's data directory
  (`WARP_NOT_FOUND` if Warp is not installed for this user). The
  `striart-<agent>-<fingerprint>.toml` file is deleted by `stop` and `clean`;
  if the deletion fails, the `AGENT_ARTIFACT_FAILED` warning says so (remove
  it by hand then).
- The hosted shell is slow to start on Windows (PowerShell 5.1 loads your
  profiles): `pty.shellArgs: ['-NoLogo', '-NoProfile']`, or
  `pty.shell: 'pwsh'`.
- `striart attach` after an eviction (a too-slow client): the recent history
  is replayed and re-displayed in the terminal.

## Push refused after the 0.11 update

Since simple-git 4, git no longer inherits any `GIT_*` variable from the
environment: an `autoPush` (or a promotion's push) that relied on
`GIT_SSH_COMMAND` or `GIT_ASKPASS` fails (`pushError`, local merge kept).
Configure authentication in git itself: credential helper over HTTPS,
`~/.ssh/config` and the SSH agent over SSH — see
[Branches and pipeline](branches.md#autopush-and-the-remote).

## The watcher

- `striart watch --status` — is the daemon running? PID? log in
  `.striart/logs/watch.log` (ndjson: one JSON line per event).
- An orphan daemon is detected and reported: a PID file with no process, **or**
  a PID reassigned by the OS to another process after a crash or reboot (the
  daemon is recognized by its command line — a foreign process is never
  killed). Same recognition for the pty host of an `--open` agent and for the
  ACP session host.
- `--stop` answers "stop requested…"? The watcher finishes its current merge
  (over 10 s); it will remove its PID file on exit — `--status` to follow.
  Rerunning `--stop` does not hurry it: the already-acknowledged request is
  not re-signaled.
- `striart stop` warns `PTY_HOST_STOPPING` or `PTY_HOST_UNTOUCHED`? The
  agent's `--open` terminal is still stopping, or was left in place
  (unidentifiable, another user, failed stop): the clone stays protected
  (`SESSION_LIVE`) while it lives — close it by hand before
  `striart clean <agent>`.
- The watcher only watches the clones' `.git/refs/heads/` — never worktrees:
  a file change without a commit triggers nothing (by design: only commits
  count). The transient state files of `.striart/` (locks, temporaries) do not
  wake it.

## Where are the logs?

| What | Where |
|---|---|
| CLI logs | stderr (`STRIART_LOG_LEVEL=debug` for detail) — never stdout |
| Daemon watcher log | `.striart/logs/watch.log` (ndjson, size rotation: `logMaxBytes`, `logGenerations`) |
| Daemon dashboard log | `.striart/logs/dashboard.log` |
| `watch --ui` log | `.striart/logs/watch-ui.log` |
| An agent's pty host (`--open`) | `.striart/logs/pty-<agent>.log` |
| An agent's ACP session host | `.striart/logs/acp-host-<agent>.log` |
| Autonomous session logs | `.striart/logs/session-<agent>-<taskId>.log` |
| Conflict tickets | `.striart/conflicts/<ticket>/` |
| Agent registry | `.striart/agents.json` |
| Task queue | `.striart/queue.json` |
| Token usage ledger | `.striart/usage/YYYY-MM-DD.ndjson` (`striart usage`) |
| Plans, groups, reviews, messages | `.striart/orchestration/`, `.striart/reviews/`, `.striart/collab/` |
| Merge history | `striart history` (rebuilt from the Git graph) |

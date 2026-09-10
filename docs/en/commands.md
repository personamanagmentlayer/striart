# Commands

> [Documentation](README.md) · Commands

Overview first, then details by functional group. Every mutating operation
(`run`, `merge`, `sync`, `stop`, `promote`, `resolve --apply`, queue retry) goes through the
[inter-process lock](architecture.md#inter-process-lock) — two concurrent
CLIs never trample each other.

| Command | Role |
|---|---|
| `striart init` | Initializes `.striart/`, the config, diagnoses the LLM. |
| `striart start <agent> [--command <cmd>] [--open]` | Isolated clone + task branch, no Router. |
| `striart start <agent> --reuse [--force]` | Reuses the kept clone of a stopped agent. |
| `striart attach <agent>` | Attaches an interactive terminal to an agent's owned pty (joins a session already opened by `--open`). |
| `striart run "<prompt>" [--agent <a>] [--command] [--open] [--force]` | Preventive Router: predicts files, launches or queues. |
| `striart run "<prompt>" --autonomous [--profile <p>] [--timeout <ms>] [--force]` | Autonomous mode: Striart drives the tool end to end. |
| `striart run "<prompt>" --on-main [--profile <p>] [--timeout <ms>]` | Launches the agent DIRECTLY on the main repo (no clone), under a protected session. |
| `striart run "<prompt>" --after <task\|agent>` | Declared dependency: waits for the referenced work to finish. |
| `striart plan <file.yaml> [--dry-run]` | Tasks-as-code: apply a versioned YAML plan. |
| `striart profiles [--json]` | Lists the configured agent profiles. |
| `striart watch [--no-merge]` | Watches commits; continuous merge + Test Gate + rebase. |
| `striart watch --daemon [--status\|--stop]` | Background watcher (PID file, logs, orphan detection). |
| `striart watch --ui` | Interactive Ink panel on top of the watcher: per-agent pty tail, `/` commands, `!` shell, `@agent` messages. |
| `striart merge <agent>` | Manual merge of an agent's latest commit. |
| `striart sync [agent]` | Rebases one agent (or all) onto the target branch. |
| `striart status [--json]` | Agent state: status, session, mode, branch, tool, size. |
| `striart queue [--retry]` | Task dashboard; `--retry` relaunches unblocked tasks. |
| `striart stop <agent> [--force]` | Terminates an agent (the clone stays on disk), unblocks the queue. |
| `striart rollback` | Undoes the last Striart merge (local reset or revert). |
| `striart doctor [--json]` | Full diagnosis — "why isn't this working?". |
| `striart history [--limit <n>] [--json]` | Merge/rollback history, rebuilt from the Git graph. |
| `striart promote [--rollback]` | Staging → main promotion (global Test Gate + fast-forward). |
| `striart resolve [--unlock\|--close <id>\|--prepare <id>\|--apply <id>\|--all]` | Conflict tickets. |
| `striart lock [--start <reason> [--pid <n>]\|--stop]` | Reserves/releases the main repo for a direct intervention (manual edit, hand-resolved conflict). |
| `striart clean [agent] [--stopped\|--all [--force]]` | Frees disk space (two-level safeguards). |
| `striart reconcile` | Idempotent reconciliation of all state (dead sessions, queue, locks). |
| `striart prune [--days <n>] [--dry-run]` | Retention for stopped inactive clones and resolved tickets. |
| `striart dashboard [--port <p>] [--daemon\|--stop\|--status]` | Real-time local web dashboard (127.0.0.1, SSE) + controls; `--daemon` runs it in the background. |
| `striart mcp` | Stdio MCP server (7 tools over the orchestrator). |

---

## Initialization and diagnosis

### `striart init`

Creates `.striart/` (agents, conflicts, logs, state files), adds `.striart/`
to `.gitignore`, generates `striart.config.mjs` if no config exists, and
diagnoses the LLM (warning, never blocking). Idempotent. Details:
[Getting started](getting-started.md#striart-init).

### `striart doctor [--json]`

Full diagnosis: git version, repo validity, config loaded and validated, LLM
reachability (Ollama ping or API key presence), locks in place, open tickets,
**current branch vs `targetBranch`** (a mismatch shows "merge/watch will
refuse"), and the **main session** state (free / occupied — see `striart
lock` below). The first reflex when something refuses to work — see
[Troubleshooting](troubleshooting.md).

## Launching agents

### `striart start <agent> [--command <cmd>] [--open]`

Creates the isolated clone and the task branch
`striart/<agent>/task-<uuid>`, **without going through the Router** (no file
prediction, no queuing). `--command` overrides the displayed tool
(`agentCommand` in the config); `--open` opens a terminal tab that runs
`striart attach <agent>`, itself connected to a detached **pty host** process
(one per agent, started idempotently) that actually owns the pty — the
hosted tool keeps running independently of the tab, so closing it (or even
`striart` itself) doesn't kill the session; `watch --ui`'s `@agent` bus below
can join the same session from elsewhere.

### `striart start <agent> --reuse [--force]`

**Reuses** the kept clone of a stopped agent: resync onto the current target
branch, new task branch, untracked files preserved (`node_modules` — warm
start). Explicit refusals:

- `REUSE_DIRTY` — the archive has uncommitted changes;
- `REUSE_UNMERGED` — committed work was never merged;
- `REUSE_IN_USE` — the clone's disk changed recently (`presenceMinutes`);
- `HISTORICAL_SECRETS_FOUND` — a path matching `secretPatterns` once existed
  in the repo's history (see [Architecture](architecture.md)).

`--force` accepts the loss (or, for the last refusal, clones/reuses anyway,
knowingly). `striart run --reuse` additionally goes through the Router.

### `striart attach <agent>`

Attaches an interactive terminal to the pty already owned by an agent's
detached host — exactly what `--open` launches under the hood, invocable
directly to (re)join a session (a closed tab, a second window watching the
same session). Must be run from **inside the agent's own clone directory**
(`.striart/agents/<agent>/`, checked strictly — the target root is derived
from that path rather than passed as an argument that could break shell
quoting; refused as `ATTACH_WRONG_CWD` otherwise). Does **not** start the pty
host itself: if it isn't running, `attach` fails with an error pointing at
`--open` (which starts it idempotently). Distinct from the `@agent` bus of
`watch --ui` below: `attach` gives the *real* raw terminal, the bus sends one
message at a time.

### `striart run "<prompt>" [--agent <a>] [--command] [--open] [--reuse] [--force]`

The normal path: the **Router** sends the prompt to the LLM, gets the list of
files likely to be touched, filters it (`isSafeProjectPath` — LLM output is
untrusted), then compares it to the predictions of active and queued tasks.
Intersection → the task is **queued** instead of heading into a conflict;
otherwise the agent starts. Without `--agent`, the name is derived from the
prompt (e.g. `refactor-the-authentic`). `--prompt <p>` is the scriptable
equivalent of the positional. `--force` clones/reuses anyway despite
`HISTORICAL_SECRETS_FOUND`; if the task is queued by a collision, the
decision is remembered (`QueueTask.force`) and still honored whenever the
queue later drains it — no confirmation is re-asked with no one around to
give it.

At launch, **semantic links** are reported for information (never blocking):
mutual imports (JS/TS, Python, Ruby, PHP) and linked packages of a monorepo
(npm/yarn, Cargo, Go, Maven).

### `striart run … --autonomous [--profile <p>] [--timeout <ms>] [--force]`

Striart launches the tool itself (an `agentProfiles` profile), supervises the
process, merges, runs the Test Gate, and deletes the clone if everything is
green. Full details: [Execution modes](execution-modes.md). Timeout
precedence: `--timeout` > `profile.timeout` > `autonomousTimeoutMs`.

### `striart run … --on-main [--profile <p>] [--timeout <ms>]`

Launches the agent **directly in the main repo**, not a clone:
`runMainSession` reserves a **main session** (`.striart/main-session.json`,
publishing the PID **of the orchestrator process itself**, not the spawned
agent's) under the main lock, briefly, then launches the tool without
holding the lock during the session (which can run for hours). While the
session is alive, every other mutating operation (`merge`, `sync`,
`promote`, `resolve --apply`, `watch`'s auto-merge…) is refused with
`MAIN_SESSION_LIVE`. No end-of-cycle merge: the agent is already working on
the target branch. Two use cases protected by this mechanism: an agent
launched directly in the main worktree, or a human editing/resolving a
conflict by hand without committing (see `striart lock` below).

### `striart run … --after <task|agent>`

**Declared dependency**: the task waits in the queue until the referenced
work finishes (merge + stop), then starts automatically. Unknown reference or
cycle → refused at launch. This is the building block underneath
[YAML plans](plans.md).

### `striart plan <file.yaml> [--dry-run]` and `striart profiles`

See [Plans — tasks-as-code](plans.md). `striart profiles [--json]` lists the
configured profiles (tool, expected env keys, timeout) — the AIs available
for `--profile` and for the `profile` field of plans.

## Orchestrating

### `striart watch [--no-merge]`

The core: watches every clone's refs, handles each commit in the
[serialized chain](architecture.md#the-serialized-chain) (pre-rebase, merge,
semantic merge, Test Gate, rebase of the other agents). `--no-merge` only
observes. The watcher **does not merge autonomous agents** — their merge
belongs to their own end of cycle. Replays `reconcile` automatically.

### `striart watch --daemon [--status|--stop]`

The same watcher, as a natively detached process: PID file and logs under
`.striart/` (`logs/watch.log`), orphaned-daemon detection, `--status` and
`--stop` to inspect and stop it. No pm2 or systemd dependency; restarting at
boot remains in the user's hands (OS scheduler).

### `striart watch --ui`

The same watcher plus an interactive Ink panel (**incompatible with
`--daemon`**): one tab per active **supervised** agent (autonomous agents
aren't tailed — no pty to follow), each live-tailing the agent's owned pty
through the attach protocol above, plus a permanent virtual **"🖥️ Terminal"**
tab (selected by default) that captures the output of every `/…`/`!…`
command run from the input field.

Field grammar:

- **`/command`** runs `striart <command>` (same binary, `argv`,
  `shell: false`) and shows its output in the Terminal tab. `/exit` quits the
  panel (same as Ctrl+C, native to the panel — not a real `striart` command);
  `/clear` clears the Terminal tab's own history, or sends the real shell
  clear command (`cls`/`clear`) to the selected agent; `/relaunch [agent]`
  retypes the agent's launch command (same resolution as `--open`) — useful
  when the 🟡 badge below signals the hosted tool has exited. `watch`, `mcp`,
  `attach`, `pty-host-run` are refused here (a second watcher, a stdin-bound
  protocol, or a real-terminal command none of which fit a background field);
  `dashboard` is refused unless `--daemon`/`--stop`/`--status`.
- **`!command`** runs a real command through the machine's default shell
  (`defaultShell()`), pipes, redirections, and any installed binary included;
  output also goes to the Terminal tab.
- **`@agent message`** sends `message` to the pty of the named supervised
  agent (starts its pty host if needed).
- **Bare text** (no prefix) is sent to the currently **selected** tab's
  agent — `@agent` is only needed to switch target, not to keep talking to
  the same one.

Autocompletion on `/` and `@` (Tab or Enter completes the highlighted
suggestion; a second Enter, once the list is empty, submits). `↑`/`↓` recall
input history when the field isn't empty and no suggestion is active; at an
empty field they switch the displayed tab instead. Page Up/Page Down scroll
the 500-line scrollback of the displayed tab. A `•` marks a tab whose content
changed while another tab was displayed. A 🟡 badge (vs 🟢) signals —
informationally only, **never an automatic restart** — that the hosted
tool's pty looks like it fell back to a bare shell prompt; `/relaunch` is the
fix.

Same trust boundary as `--open`/`attach`: a message sent through the `@agent`
bus, or the `!` shell, has exactly the same power as typing directly in the
terminal — see [SECURITY.md](../../SECURITY.md).

### `striart merge <agent>`

Manual merge of an agent's latest commit — same pipeline as the watcher
(pre-rebase, semantic merge, Test Gate). Refuses if the main repo is dirty
(`MAIN_DIRTY`) or on the wrong branch (`TARGET_BRANCH_MISMATCH`) — see
[Branches and pipeline](branches.md).

### `striart sync [agent]`

Rebases one agent (or all) onto the target branch, with the same safeguards
as the watcher (auto-stash when disjointness is verified, `SKIPPED_SESSION`
for live sessions). The
[6 statuses](architecture.md#the-6-synchronization-statuses) say exactly
what happened.

### `striart stop <agent> [--force]`

Terminates an agent: removes the registry entry, keeps the clone on disk,
unblocks the queue (tasks waiting on this agent start). Refuses to stop an
agent whose autonomous session is alive (`SESSION_LIVE`), even with
`--force`.

## Observing

### `striart status [--json]`

Each agent's state: status, active session, **mode** (🤖 autonomous +
profile / 👤 supervised), task branch, tool, additional clone size
(hardlinks count as 0), commits pending merge.

### `striart queue [--retry]`

The scheduler: `RUNNING` / `WAITING` tasks and what blocks each one.
`--retry` relaunches tasks that have become unblocked.

### `striart history [--limit <n>] [--json]`

History of Striart merges and rollbacks, **rebuilt from the Git graph** (not
a separate journal that could diverge).

### `striart dashboard [--port <p>] [--daemon|--stop|--status]`

Local web dashboard, bound to `127.0.0.1` only, **real-time** (SSE — pushed
on every change, no polling): agent state and mode, watcher status banner,
session logs, semi-autonomous permission arbitration, and controls (merge,
stop, retry, rollback, ticket resolution prepare/apply under the Test Gate,
manual close — CSRF-protected, `Host` header checked on every request).
`--daemon` runs it as a natively detached process (same mechanism as
`striart watch --daemon`: PID file and logs under `.striart/`, orphan
detection); `--status`/`--stop` inspect or stop it.

## Repairing and cleaning

### `striart rollback`

Undoes the **last Striart merge**: local reset (recoverable via reflog) if
the merge wasn't pushed, revert otherwise (published history is preserved).
Refuses if the target branch's last commit is not a Striart merge.

### `striart resolve [--unlock|--close <id>|--prepare <id>|--apply <id>|--all]`

Conflict tickets (`.striart/conflicts/<ticket>/`: BASE/OURS/THEIRS versions,
LLM attempt, Test Gate log). Without options: lists. `--close <id>` marks a
ticket resolved **without going through the Test Gate** (by hand, once the
conflict has been fixed outside Striart); `--unlock` re-enables semantic
merging after manual mode kicked in (3 consecutive failures); `--all` closes
everything.

`--prepare <id>` and `--apply <id>` form the **tested** path for human
resolution — preferred over `--close`: the resolution goes through the same
inter-process lock and the same blocking Test Gate as an automatic merge,
instead of a `git merge` done by hand outside Striart's supervision (the
source of a real incident: collision with an active `striart watch`).

- `--prepare <id>` seeds `<file>.resolved` in the ticket's folder for every
  conflicted file that has no resolution prepared yet, starting from
  `.theirs` (falling back to `.ours` then `.base`) — a starting point to
  edit, never overwritten if already present.
- `--apply <id>` replays the ticket's **exact** merge (`ticket.sha`, not the
  agent's current head, which may have moved on since) and applies the
  `.resolved` files (final content, binary supported) and `.delete` files
  (resolution = deletion) prepared in the ticket's folder, under the
  blocking Test Gate. Green → commit, the ticket is closed (along with
  duplicates covering the same files for the same agent), and the semantic
  failure streak is reset. Red → the ticket stays open, and **nothing** is
  touched on the streak or manual mode (a failed manual resolution is not an
  LLM failure). Refused without changing anything when: the ticket is
  already resolved, the conflict isn't a per-file one (e.g. `GATE_FAILED`
  with no conflicted file), the resolution is incomplete, the agent is
  unknown, an autonomous session is alive, or the ticket is stale (the main
  repo or the agent's history has moved on since).

### `striart lock [--start <reason> [--pid <n>]|--stop]`

Reserves or releases the main repo for a **direct intervention outside the
Router/agent path**: a manual edit without a commit, a conflict resolved by
hand with a raw `git merge`. Same mechanism as `--on-main` (session declared
in `.striart/main-session.json`, `assertNoLiveMainSession` guard inside
`withMainLock`) — fixes a real incident where a manual resolution was
undone by orphaned-merge recovery while an active `striart watch` held the
lock.

- `--start <reason>`: reserves, watched by default via the calling shell's
  PID (`process.ppid` — releases itself when the terminal closes), or an
  explicit `--pid <n>` (warns if that PID is not alive at declaration time).
  Check and publish are atomic under the main lock.
- `--stop`: releases — an **always-allowed escape hatch**, even if the
  declared PID is still alive.
- With no option: shows the status (free / occupied with reason, PID and
  duration / dead PID).

**No TTL** (unlike `.striart/main.lock`): a direct intervention can
legitimately run for hours; `striart lock --stop` is the only way out if the
PID was recycled by the OS.

### `striart clean [agent] [--stopped|--all [--force]]`

Frees disk space: stopped agents' clones by default; `--all` includes active
agents **with no pending work**. Two refusal levels, depending on what
Striart knows:

- `IN_USE` — the clone's disk changed less than `presenceMinutes` minutes
  ago: a **heuristic**, which `--force` can knowingly override;
- `SESSION_LIVE` — an autonomous session's PID is alive: a **verified fact**,
  which `--force` can**not** override.

Uncommitted or unmerged work (`PENDING`, `BUSY`) also protects the clone;
`--force` then accepts abandoning the unmerged work.

### `striart reconcile`

**Reconciliation** (level-triggered): neutralizes dead sessions in the
registry, unblocks the queue (even when no commit triggered it — e.g.
`clean` of a blocker), repairs orphaned locks and merges. Idempotent — can
be run at any time without risk. Replayed automatically by `striart watch`.

### `striart prune [--days <n>] [--dry-run]`

Retention: prunes stopped inactive clones and tickets resolved more than N
days ago (config `pruneDays`, default 14). `--dry-run` previews. A periodic
`striart prune` (cron/scheduled task) keeps `.striart/` healthy.

## Integration

### `striart promote [--rollback]`

Staging → main promotion of the
[two-stage pipeline](branches.md#the-staging-main-pipeline): global Test
Gate (`promoteTestCommand`) then fast-forward of `mainBranch`.

### `striart mcp`

Stdio MCP server — see [MCP server](mcp.md). Logs go to stderr: stdout is
reserved for the protocol.

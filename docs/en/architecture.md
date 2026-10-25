# Architecture

> [Documentation](README.md) · Architecture

## The three pillars

When several AI agents work on the same repo in parallel, they trample each
other: Git conflicts, greedy commits, semantically broken merges. Striart
solves this with three pillars:

1. **Physical isolation** — each agent works in a real, independent Git clone
   with no remote (`.striart/agents/<name>/`).
2. **Preventive Router** — before launching an agent, an LLM predicts which
   files will be touched and queues colliding tasks.
3. **Semantic merge + Test Gate** — agent commits are merged automatically;
   on conflict, an LLM merges the code; nothing is committed until `npm test`
   (or your command) passes.

Striart is not an opaque central brain: it's a **Git pacemaker**. The human
sees everything and can interrupt, correct, or approve.

## Why clones — and not worktrees?

Isolating files is 10% of the problem. A worktree (or a hand-made clone)
keeps two agents from writing to the same place *at the same time* — all the
rest stays on you, for every task: avoiding collisions *before* they happen,
bringing N branches back into the target branch, arbitrating conflicts,
guaranteeing nothing broken gets in. Striart automates precisely that rest.

| Need | Hand-managed worktrees | Claude Code subagents (built-in worktrees) | Striart |
|---|---|---|---|
| File isolation | ✅ | ✅ (zero friction) | ✅ full clones |
| Resilience to an agent going off the rails | ⚠️ shared `.git/`: a `reset --hard` or `gc` touches shared state | ⚠️ same | ✅ own refs/index, no remote, secrets excluded — blast radius bounded to the clone |
| Collision prevention | ❌ on you | ❌ depends on the model's task split | ✅ LLM Router + queue + `--after` dependencies |
| Getting work back into the target branch | ❌ manual merges | ❌ up to the agent | ✅ auto-merge, rebase of every agent after each merge, 3-way semantic merge |
| Quality gate | ❌ | ❌ | ✅ **blocking Test Gate** — nothing lands without a green suite |
| Multi-vendor | ❌ | ❌ Claude only | ✅ Claude + Aider + Codex + Ollama… side by side |
| Lifespan | the session | the session | ✅ hours/days, multiple sessions, persistent queue |
| Observability & control | ❌ | session-bound | ✅ real-time dashboard, persistent logs, semi-autonomous (you arbitrate permissions), rollback |

**Clones, not worktrees — a safety choice.** Git worktrees share the main
`.git/`: fine for a disciplined human, dangerous for an unsupervised agent
running its own git commands. Striart gives each agent a real clone — and
neutralizes the classic cost: local-path clone, git **natively hardlinks the
objects** (immutable, hence safe even if the main repo runs a `gc`),
near-instant creation, history paid once. Isolation covers everything
**mutable**: the worktree is a real copy, refs and index are the clone's own.

Deliberately **forbidden**: alternates (a live coupling with the main repo's
`gc`) and hardlinks/symlinks on the worktree or `node_modules` (in-place
write corruption, cache contamination).

**Nesting, not a duel.** Striart is agent-agnostic: Claude Code *is* one of
its agents. The natural setup — Striart hands it an isolated clone
(supervised, autonomous, or protocol-driven via ACP), and *inside* it Claude
Code remains free to use its own worktrees for its subagents: the two
mechanisms compose. Through the MCP server, the agent can even drive Striart
instead of bypassing it. In one sentence: **worktrees = zero-friction
intra-session parallelism; Striart = inter-agent orchestration with
continuous integration and a quality gate.**

## Clones have no `origin` remote

The orchestrator is the only one that pushes. Agents work in orphan clones,
on a task branch `striart/<agent>/task-<uuid>`. The orchestrator runs
`git fetch ../agent-a/` then merges into the main repo. **Tracked** secrets
(`secretPatterns` in the config: `.env`, `*.pem`…) are removed from clone
worktrees via sparse-checkout; untracked files are never cloned by git.
`.git/` objects, though, are hardlinked in full (see above): a **historical**
secret — deleted since, absent from both the worktree and today's tracked
files — remains readable via `git show <sha>:<file>`. `createAgent`/
`reuseAgent` scan the whole history against `secretPatterns` before cloning
and refuse (`HISTORICAL_SECRETS_FOUND`, fail closed, no clone created) if a
historical path matches; `--allow-historical-secrets` (`striart start`,
`striart run`, `striart run --autonomous`) overrides it as a conscious
decision — a consent distinct from `--force`, which only covers losing work.

Every git command aimed at a clone goes through `cloneGit`: it is **bounded
to the clone** (`GIT_CEILING_DIRECTORIES` — a clone with a missing or corrupt
`.git` fails outright instead of climbing up to the main repo that contains
it) and receives **no** inherited `GIT_*` variable (`GIT_DIR`,
`GIT_WORK_TREE`, `GIT_INDEX_FILE`… set by a git hook or an IDE would designate
a repository other than the clone), nor `EDITOR`, `VISUAL`, `PAGER`, `PREFIX`
or `SSH_ASKPASS`.

## The `.striart/` layout

```text
my-project/
├── .striart/                  # generated by striart init, gitignored
│   ├── agents/
│   │   ├── auth/             # real independent Git clone, no remote
│   │   └── billing/          # branch striart/<agent>/task-<uuid>
│   ├── agents.json           # registry: branch, tool, predictions, merge base
│   ├── queue.json            # queued tasks (Router collisions)
│   ├── locks.json            # optimistic locks (file → agent)
│   ├── state.json            # semantic failure counter / manual mode
│   ├── main.lock             # inter-process main lock (transient, beats every 5 s)
│   ├── lock-queue/           # fair queue of the main lock (+ break.lock, the break lock)
│   ├── state.lock            # short state lock (+ state.lock.break, transient)
│   ├── merge-state-changed.json  # marker "open merge that is not Striart's" (transient)
│   ├── main-session.json     # session declared on the main repo (--on-main, lock --start)
│   ├── removing/<agent>.json # clone removal started, to be finished (reconciliation)
│   ├── watch.pid / dashboard.pid  # background daemons
│   ├── <name>.stop / <name>.pid.lock  # a daemon's stop request / PID file lock (transient)
│   ├── completion-profiles.json  # profile names published by `striart profiles` for completion
│   ├── memory.md             # Memory Layer (if memoryLayer: true)
│   ├── conflicts/<ticket>/   # base/ours/theirs + llm-attempt + test-output.log
│   ├── permissions/          # arbitration requests (permissions, agent questions) of the semi-autonomous mode
│   ├── reviews/              # human reviews of `review` tasks
│   ├── collab/<group>.json   # collaboration channel messages
│   ├── orchestration/        # state of plans (runs/) and orchestrated groups (groups/)
│   ├── usage/                # token ledger YYYY-MM-DD.ndjson + cache/ of LLM results
│   ├── instructions/<agent>.json  # manifest of the instruction files injected into a clone
│   ├── control/              # dashboard token (dashboard-<port>.json, readable by the user alone)
│   ├── pty/<agent>/          # native pty host of an --open agent (host.pid, host.stop, attach channel)
│   ├── acp/<agent>/          # persistent ACP session host (host.pid, host.stop, bus.token, local channel)
│   ├── acp-agents/<id>/<version>/  # downloaded ACP binary (acpRegistry.allowBinaryDownload)
│   └── logs/                 # watch.log, dashboard.log, watch-ui.log, pty-<agent>.log, acp-host-<agent>.log, session-*.log
└── striart.config.mjs
```

## The serialized chain

**A single process orchestrates everything**: `striart watch` detects commits
from all agents (chokidar on each clone's `.git/refs/heads/` — stable refs
only, deduplicated by SHA) and handles each event in a **serialized chain**
(a promise chain acts as both a global lock and a FIFO queue). Only one merge
at a time can touch the main repo — the whole class of "what if C merges
while B rebases" bugs is eliminated structurally, with no explicit lock.

## Flow of an agent commit

```text
Commit detected on agent A (chokidar on .git/refs/heads/)
  → filters: awaitWriteFinish (stable ref) + SHA deduplication
  → enqueued in the serialized chain
┌─────────────────────────────────────────────────────────────────────┐
│  STEP 0: pre-rebase of A onto targetBranch (autoRebase)             │
│    busy worktree → stash -u → rebase → stash pop, ONLY if the       │
│    in-progress files are disjoint from the incoming commits         │
│    (verified by diff, not assumed); otherwise rebase postponed      │
│    rebase conflict → aborted, the regular merge takes over          │
│                                                                     │
│  STEP 1: fetch the agent's commit into a PRIVATE ref                │
│    (refs/striart/incoming/<agent>), then                            │
│    • already contained in the target → UP_TO_DATE (nothing to merge)│
│    • protected path changed by the agent → refusal + ticket → END   │
│    git merge <exact sha> --no-commit --no-ff                        │
│    ├─ clean    → continue                                           │
│    └─ conflict → classified: binary, lockfile, delete/modify,       │
│        submodule, too large → direct human ticket; text → semantic  │
│        merge (LLM, BASE/OURS/THEIRS, by regions for a big file) —   │
│        failure → abort + human ticket → END                         │
│        (3 failures in a row → manual mode until resolve --unlock)   │
│                                                                     │
│  STEP 2: Test Gate (testCommand, timeout testTimeoutMs), run in the │
│    native process container (a live orphan → red)                   │
│    ├─ green → continue                                              │
│    └─ red   → merge --abort + human ticket → END                    │
│                                                                     │
│  STEP 3: check before commit (lock still held? HEAD, MERGE_HEAD and│
│    index unchanged?) — otherwise LOCK_LOST / MERGE_STATE_CHANGED,   │
│    nothing is committed — then merge commit (+ push origin if       │
│    autoPush)                                                        │
│                                                                     │
│  STEP 4: syncAllAgents (except A)                                   │
│    each agent B, C... is immediately rebased onto the new main —    │
│    B always codes against the latest code                           │
│    (same stash/disjointness safeguards as step 0)                   │
└─────────────────────────────────────────────────────────────────────┘
  → next link in the chain (commit that arrived during processing)
```

In parallel, a periodic **silent fetch** (`fetchIntervalMs`, 20 s) measures
how far behind each agent is without ever touching their working tree — pure
visibility (logs, dashboard); actual resynchronization happens at steps 0
and 4.

### The 3-way semantic merge

When Git cannot merge automatically, Striart extracts the three versions of
each conflicted file:

- `git show :1:file` → **BASE** version (common ancestor);
- `git show :2:file` → **OURS** version (target branch);
- `git show :3:file` → **THEIRS** version (agent branch).

The Merger sends all three to the LLM with a prompt adapted to the file's
language, validates the output, then submits it to the Test Gate. LLM output
is **untrusted content**: it never lands without a green gate (see
[SECURITY.md](../../SECURITY.md)).

## The 6 synchronization statuses

| Status | When | Human action |
|---|---|---|
| `REBASED` (+ `stashed`) | Clean rebase — any stash restored | None |
| `UP_TO_DATE` | The agent has no commits behind | None |
| `SKIPPED_DIRTY` (+ `overlap`) | Work in progress overlapping the incoming commits, or `autoStash: false` | None immediately — webhook sent on overlap, resolved at the next commit |
| `REBASE_CONFLICT` (+ `stashKept`) | The agent's commits conflict with the target branch (disjointness only covers uncommitted work) | None — the semantic merge takes over at merge time |
| `STASH_CONFLICT` | Stash pop in conflict (theoretically impossible, disjointness verified) | Intervention — work is safe in the clone's stash |
| `SKIPPED_SESSION` (+ `pid`) | An autonomous session is running in the clone — it is untouchable while its PID lives | None — the rebase is **postponed**, not cancelled: end of cycle rebases anyway |

`SKIPPED_SESSION` is decided at the top of `syncAgentWithMain`, so for a
single-agent sync as well as for the batch: the clone is set aside **before**
anything is attempted on it. The usual safeguards (dirty worktree,
overlapping files) assume a human able to see their files move and react; an
autonomous session has no one to react, and it runs its own git commands. A
PID left in the registry after a crash is neutralized by the liveness check —
a clone can never stay frozen forever.

The disjointness check is deliberately conservative: renames count for
**both** their paths (old and new, `--no-renames` on the incoming commits,
`from` paths included on the worktree side) — worst case, a rebase is
postponed needlessly; never a false "safe".

## Inter-process lock

The serialized chain protects *inside* the `watch` process. Between processes
(a manual `striart merge` while `watch` runs, two CLIs, an MCP server, a
dashboard…), every mutating operation (`run`, `merge`, `sync`, `stop`,
`promote`, `resolve --apply`, `lock --start`, queue retry) goes through the
**main lock** `.striart/main.lock` (`src/lock.js`), in three layers:

1. **Reentrancy by async context** (`AsyncLocalStorage`). A `withMainLock`
   called *from inside* another one's critical section — directly or through
   a chain of `await`s (stop → queue retry, merge → sync) — crosses it without
   taking anything. A call coming from *another* context of the same process
   (a parallel MCP request, a dashboard background task) inherits nothing and
   waits its turn: the former global counter let two top-level critical
   sections run at the same time in one process (a defect proven by the
   2026-10-24 reliability audit). Work *launched without being awaited* from a
   critical section inherits the context; the ones that touch the main repo
   go through `runOutsideMainLock`.
2. **In-memory FIFO queue** per repository: a single context of the process
   takes part in the inter-process race at a time.
3. **Inter-process exclusion** by exclusive creation (`wx`, arbitrated by the
   kernel), preceded by a **fair queue** on disk (`.striart/lock-queue/`, a
   numbered ticket per waiting process, served by increasing number — no more
   starvation through disordered polling).

**Heartbeat.** The holder refreshes the lock every 5 s (`mtime` +
`heartbeatAt`). A random token is written in the file and re-read before any
deletion: release, process exit and breaking never remove another process's
lock. A present lock is only broken on **proof** its holder no longer exists:
dead process; PID reassigned to another program (identity re-read from the OS,
creation time included); old format (no heartbeat) older than 30 min; invalid
*and* old content. An *unreadable* file (permissions, Windows sharing) is
never broken. A **live** holder whose heartbeat is frozen (frozen process) is
**not** broken by default — breaking it would leave two processes in the
critical section when it thaws: the wait ends in `LOCK_TIMEOUT`
(`HOLDER_FROZEN`) with the PID to stop; `lock.breakFrozenHolderAfterMs`
relaxes this protection (logged, shown by `doctor`). The default wait is 2 min.

**Serialized breaking.** Any deletion of someone else's file (stale lock,
orphan waiting ticket) happens under a break lock (`lock-queue/break.lock`,
exclusive creation), re-reading the file and comparing content **and** date to
those judged: two simultaneous breakers can no longer delete each other's fresh
lock. (Rejected alternative: renaming to a tombstone then putting back — the
put-back is not atomic against a third process that has already recreated the
lock: two holders.) Reclaiming a stale break lock itself goes through a marker
with exclusive creation (`*.break.reclaim`). This building block
(`src/break-lock.ts`) is shared with the state lock.

**Check before the irreversible.** `assertMainLockHeld` lets a long operation
verify, just before an irreversible effect (commit, write into the main repo),
that it still holds the lock (`LOCK_LOST` otherwise), and the merge rechecks
`HEAD`, `MERGE_HEAD` and the index (`MERGE_STATE_CHANGED`). If the operation
finds that an open merge is not its own, it records it in
`.striart/merge-state-changed.json`, tied to the `MERGE_HEAD` at stake: every
operation then refuses (`MERGE_RECOVERY_BLOCKED`) instead of aborting a third
party's work.

On each acquisition — except with a main session declared live, see below — a
merge abandoned by an earlier crash (orphan `MERGE_HEAD`) is cleanly aborted.
`resolve --apply` (human resolution of a conflict ticket) runs entirely under
this lock, Test Gate included — the path that was missing so that a manual
resolution can no longer collide with a concurrent automatic merge (a real
incident: a `git merge` done by hand outside Striart's framework while a
`striart watch` ran). A cancellation `signal` (MCP, dashboard, Ctrl+C) only
cancels the **wait** for the lock (`LOCK_WAIT_CANCELLED`): a critical section
that has begun is never interrupted.

**Known debt (roadmap, "performance and reliability under load")**: the main
lock is still held during a merge's Test Gate and LLM calls; the integration
clone (decision D1: merge, LLM merge and Test Gate outside the lock, the lock
covering only the final fast-forward) is **decided but not delivered** — see
decision no. 3 of the `CLAUDE.md` in the `.claude` folder and the roadmap section "Performance and
reliability under continuous load".

## State files: atomic write and state lock

All the files of `.striart/` (registry, queue, state, optimistic locks, main
session, tickets, permission requests, reviews, plans, collaboration groups)
share a foundation (`src/json-file.js`):

- **Atomic write v2**: a uniquely named temporary file
  (`<file>.<pid>.<random>.tmp` — two writers never share the same), content
  forced to disk (`fsync`) before the rename, directory `fsync` on POSIX.
  Windows refuses the rename while another process has the target open
  (`EPERM`/`EACCES`/`EBUSY`, 24 to 70 % of writes per the audit): retried with
  exponential backoff and jitter within a bounded budget; beyond it the write
  fails (`STATE_WRITE_FAILED`) and the previous state stays intact. Abandoned
  temporaries are swept by reconciliation.
- **State lock** (`src/state-lock.ts`, `.striart/state.lock`): every
  read-modify-write of a state file takes it, for the time of *one* update
  (a few milliseconds), never during a long operation. Without it, the
  autonomous session publishing `sessionPid` to the registry while `watch`
  writes that same registry under the main lock lost one of the two writes
  (a lost update, proven by the audit). **Fixed acquisition order**: main lock
  *then* state lock, never the reverse; a section held under the state lock
  never takes `withMainLock` nor waits on git, an LLM or a process — that is
  what makes a deadlock impossible. Same breaking doctrine as the main lock:
  only debris is broken (dead holder, recycled PID, old unreadable content), a
  live, identified holder never; the holder rechecks its token just before
  writing (`STATE_LOCK_LOST`).
- **Replayable clone removal**: see `removing/` above and `striart clean`.
- **Rotation of long logs** by size (`logMaxBytes`, `logGenerations`) —
  `src/log-rotation.ts`; it is the only synchronous writer tolerated outside
  the "`fs/promises`" rule (sink of the pino logs and of a daemon's stdio).

## Main session (the main repo itself, outside clones)

`sessionPid` (the `agents.json` registry) protects each **clone** while its
autonomous session is alive — but nothing protected the **main repo itself**:
an agent launched directly in its worktree, or a human editing/resolving a
conflict by hand without committing. `main-session.js` closes that gap with a
singleton `.striart/main-session.json` (`{pid, reason, startedAt}`, a single
file for the whole repo — not one per agent) and two producers:
`runMainSession` (`striart run --on-main`, publishing the PID of the
**orchestrator process itself**, not the spawned agent's) and `striart lock
--start` (human editing). Without `--pid`, the watched PID is the calling
shell's, **provided** it is a durable interactive shell (identity read from
the OS, `process-info.ts`): an intermediary that dies with the command —
`cmd /c`, `bash -c`, Git Bash's ephemeral copy — would disarm the
reservation the second it is made. Fail-closed refusal
`LOCK_PID_EPHEMERAL`, with the `--pid` command suited to the shell; a dead
PID is refused (`LOCK_PID_DEAD`). An interrupted `runMainSession` (Ctrl+C,
SIGTERM) kills the agent's tree **before** unpublishing the session.

`assertNoLiveMainSession` (`lock.js`) is called inside `withMainLock` **right
before** the orphaned-merge recovery above: while the declared PID is alive,
every mutating operation is refused (`MAIN_SESSION_LIVE`) — without this
guard, the orphaned-`MERGE_HEAD` recovery would treat an in-progress manual
resolution as crash debris and abort it (the real incident that motivated the
guard: a manual resolution interrupted by `recoverOrphanMerge` while an
active `striart watch` held the lock). A dead PID blocks nothing (re-read on
every call, no active cleanup required); `stopMainSession` (the escape hatch,
`striart lock --stop`) is always allowed, even if the declared PID is still
alive. **No TTL** here (unlike `main.lock`): a deliberate choice — a session
on the main repo can legitimately run for hours, and an automatic circuit
breaker would risk disarming a still-real session.

Display surfaces only (no way to start a session from them): `striart doctor`
(the "Main repo" check), the dashboard banner ("🔓 Release" button when
occupied), and MCP's `striart_status` (`mainSession` field, `alive` computed
server-side).

## Why serialization makes auto-stash safe

The disjointness check (B's in-progress files vs. files touched by the
incoming commits) is only worth anything if the target branch doesn't move
between the check and the `stash pop` (TOCTOU problem). Since merges and
syncs live in the same chain, the target branch is **frozen** for the whole
check → stash → rebase → pop sequence: what was measured stays true to the
end.

## The CLI layer

The CLI (`src/cli/`, commander 15) is split into four layers, with no
business logic at all:

- **L4 — core** (`main.ts`, `caps.ts`, `exit.ts`): loads the `.env` from the
  repository root, a **single** probe of the terminal's capabilities (color,
  Unicode, width, OSC 8 links, OSC 9;4 progress, CI), language, signals,
  error rendering, and the **only** place where the exit code is decided
  (0/1/2/3/130/143);
- **L3 — surface** (`program.ts`, `parse.ts`, `registry.ts`): commands are
  declared from a **single registry** (`registry.ts` — help group, machine
  output format, foreground constraint), also consumed by the help, the
  completion scripts and `watch --ui`'s autocomplete; positive validation of
  every value before any call into the domain;
- **L3 — commands** (`commands/*.ts`, one per file, lazily loaded through
  `import()` with a literal specifier): `execute` returns a domain value and
  an outcome (`ok`/`refused`/`failed`), never a format nor an exit code;
- **L2 — rendering** (`output.ts`, `text.ts`, `render/*.ts`, `i18n/fr.ts` and
  `i18n/en.ts`): stdout = data, stderr = progress, warnings, errors and
  logs; control characters of any untrusted text neutralized; adaptive
  tables.

`src/cli.js` remains the stable entry point (`bin`, daemons, pty host,
`--open` tab): it enables Node's compile cache then delegates to
`src/cli/main.ts`. `--help`, `--version` and a usage error load neither git,
nor pino, nor execa (checked by an integration test; `npm run bench:startup`
measures the real cost on the machine). Long-running commands (`watch`,
`dashboard`) and sessions (`run --autonomous`, `run --on-main`, `plan`
outside `--dry-run`) stop cleanly on a signal; the others are "crash-only",
covered by recovery after a cut (lock removed on process exit, orphan merge
aborted). The CLI layer never imports synchronous `fs` (ESLint rule on
`src/cli/**/*.ts`): it starts on every Tab press, and a blocking disk walk
would be paid each time — the root `.env` is looked up asynchronously too.

The PIDs Striart publishes for its own detached processes (`watch`/
`dashboard` daemons, an agent's pty host and ACP session host) are checked **by identity**, not
just by liveness (`checkProcessInstance`, `src/process-info.ts`): `alive`
(alive and recognized by its command line), `dead`, `foreign` (the number
now belongs to another process — a PID recycled after a crash or a reboot)
or `unverified` (alive, identity unreadable: another user's process).
`foreign` counts as orphaned — never killed, never blocking; `unverified` is
treated as alive (fail closed) and is never killed either. The identity
(name, command line, parent, **creation time**) is read by the native binary
(`proc info`): a "parent" created after its child is not one, which closes the
recycled-PID window. An established verdict is cached for 60 s for display and
abstentions only: the cache is purged when a PID is
seen dead and on expiry, and every destructive decision — killing,
forgetting a PID file, reusing a pty host — re-reads the identity without
cache (abstaining wrongly makes you wait, killing wrongly hits an innocent).
Reads requested within the same 15 ms window (a `status` probes the daemon
and each host in parallel) are grouped into a single OS query
(`readProcessInfos`).

Stopping these processes goes through a **cross-platform clean-stop
channel** (`src/stop-request.ts`) rather than a signal: on Windows,
`process.kill` is a TerminateProcess — no handler, no draining, and a
watcher cut mid-Test Gate left the main repo "merging", an orphan
`main.lock` and the gate's tree alive. The requester atomically writes
`{pid, requestedAt}` to a request file; the target process (same `pid`)
reads it, adds `ackAt`, then stops through the same path as on SIGTERM and
removes the file on exit. Without an acknowledgement in time (a process from
an earlier version, or a stuck one), the requester falls back to the signal;
an acknowledgement already present means "stop in progress" and is never
signalled again. `watch` and `dashboard` as daemons listen for the request
(`daemonStopSignal`), and so does the pty host.

## Three planes, never mixed

Striart talks to three counterparts, through three distinct channels — the
separation is a security decision, not an organizational one:

| Plane | Who drives whom | Channel | Power |
|---|---|---|---|
| **Agent → Striart** | The coding agent drives the orchestrator | MCP server (`striart mcp`, stdio), **bound to the calling clone** | Read the state; merge *its* work; prepare/apply *its* resolutions. Never arbitrate a permission, close a ticket without the Test Gate, release the main repo. |
| **Human → Striart** | The human (IDE, browser, script) drives the orchestrator | **Striart Control Protocol v1**: JSON-RPC 2.0 over stdio (`striart api`) or token-protected loopback HTTP (`striart dashboard`) | Everything, including the gestures reserved to the human. Refused inside an agent session. |
| **Striart → agent** | The orchestrator drives the agent | Full **ACP v1** client, in a persistent session host | Start a session, hand it human prompts, answer its permissions and questions. |

MCP as the human plane was **rejected**: an agent would arbitrate itself. LSP
was rejected for the Control Protocol (its "document" model does not fit an
orchestrator's state).

- **The MCP server** (`src/mcp/`) is one module per responsibility:
  `protocol.ts` (dual era modern 2026-07-28 / legacy, per request),
  `scope.ts` (who is calling, on what: read-only → bound to an agent →
  orchestrator), `tools.ts` (ten tools), `resources.ts` (`striart://…`
  resources), `tasks.ts` (Tasks extension, honest cancellation),
  `change-feed.ts` (subscriptions), `ticket-view.ts` (MCP Apps), `server.ts`
  (stdio loop, concurrency partition). See [MCP server](mcp.md).
- **The Control Protocol** (`src/control/`) has **one** state source for all
  transports: the *hub* (`hub.ts`) guarantees a single state collection in
  flight, a sequence number per subscription, a monotonic revision, a
  delay-bounded coalescing, and back-pressure (a slow SSE client is
  disconnected, a stdio client is served by coalescing). State is read from
  **disk** (`.striart/`, clone refs — never their worktrees), not from a
  parallel state. The schemas (`schemas/`) are shared with `--json`. `auth.ts`
  carries the dashboard token (see [SECURITY.md](../../SECURITY.md)),
  `guard.ts` refuses the human plane to an agent session, `hosts.ts`
  validates `dashboardAllowedHosts`.
- **The ACP client** (`src/acp/` + facade `src/acp.ts`): `protocol.ts` (pure
  functions, paths bound to the clone), `session.ts` (the course: `initialize`,
  authentication on explicit decision, `session/new` with Striart's read-only
  MCP, prompt queue, permissions, elicitation, `fs/*`, `session/cancel`/`close`),
  `terminals.ts` (bound terminals), `elicitation-schema.ts` (strict validation
  of the agent's forms), `host.ts`/`host-run.ts`/`host-ipc.ts`/`host-entry.js`
  (the persistent host: detached process, local channel with tokens — owner
  and bus —, bounded backlog and frames, cancellation if the owner
  disappears), `session-log.ts` (as-you-go log).
- **The ACP proxy** (`src/acp-agent/`) reverses the perspective: Striart *is*
  the agent seen by the editor. `rpc.ts` structurally fixes the only requests
  Striart may address to the editor (`session/request_permission`,
  `elicitation/create`) — `fs/*` and `terminal/*` are never called, even by a
  programming mistake; `session.ts` carries a session (a clone, the upstream
  agent, the final merge); `cycle.ts` is now only the proxy-specific glue on
  the end-of-cycle primitive; `permission-relay.ts` takes over the
  permissions mailbox to put them to the human *inside* the editor.

## The autonomous cycle: a single end-of-session primitive

The sequence "session over → commit contract → merge (protected-paths guard) →
cleanup without `force`" used to exist in three copies (`runAutonomousTask`,
the orchestrated modes, the ACP proxy). It now lives in one place,
`src/autonomous-cycle.ts`, composed in layers (`applyCommitContract`,
`mergeAndCleanClone`, `concludeAutonomousSession`). Decision no. 6's
invariants are held there once: the cycle never holds the main lock;
`sessionPid` designates this process during the Striart commit then is
unpublished *before* the merge; the clone is only deleted on the fully green
path, never with `force`; no cancellation signal enters once the merge has
begun. The deliberate differences between the three former paths (an agent
commit already in the target: integrated or blocked depending on the caller;
French/English wording) are documented options of the primitive, not copies
that drift.

## Native components (Rust)

A small Rust binary, `striart-native` (`native/`, crate `striart-native`),
covers the frontiers where Node cannot offer what Striart needs — **never the
core**: the orchestrator spends its time waiting for git, the LLM or the
tests, not the processor. Four commands, a versioned protocol (JSON output
positively validated, errors as one JSON line on stderr):

| Command | Role |
|---|---|
| `proc info` | Identity of batches of PIDs (name, command line, parent, **creation time**), in one request, with no PowerShell nor `ps` — the base of `checkProcessInstance` (recycled PIDs). |
| `proc tree-kill` | Kills a process's whole tree (descendants enumerated from an OS snapshot, parent → child links verified by creation order, several passes) — used by `killProcessTree` (Test Gate, sessions). |
| `job run` | Runs a command in a **process container** (Windows Job Object `KILL_ON_JOB_CLOSE`; group + subreaper on Linux), kills and counts the orphans after a grace delay, returns a report. **Wired to the Test Gate** (`src/gate.js`): a descendant of the test still alive after `gateOrphanGraceMs` is killed and makes the gate red (`GATE_ORPHAN_PROCESS`), even if the command returned 0. |
| `pty-host` | The terminal host (see below). |

**The native pty host** replaced `node-pty` (removed from the dependencies). A
C++ addon whose ConPTY agent crashed under a nested console, relying on
prebuilds per OS × Node version and on an install script to approve, was a
supply-chain and reliability surface; the frontier already existed (the host
is a separate process speaking the ndjson attach protocol), the native
binary replaces it behind the **same protocol**, validated by the pty test
suite with no assertion changed. A native crash therefore does not take the
orchestrator down. The attach channel is local — a Windows named pipe whose
**DACL has a single ACE, the current user** (`PIPE_REJECT_REMOTE_CLIENTS`,
exclusive first instance against name squatting), a Unix socket created
directly at `0600` (umask `0177` for the time of the `bind`) — with a bounded
per-client queue (`pty.clientQueueBytes`) and explicit eviction of a too-slow
client. A Node host of an earlier version still alive after an update stays
recognized (and never killed blindly).

**Resolution, verification, distribution.** The binary is resolved in this
order, and the selected source is always visible (`striart doctor`) — never a
silent switch: (1) `STRIART_NATIVE_BIN` (absolute path, **integrity not
verified**, a conscious choice); (2) the development build
`native/target/release/` of a checkout (`npm run native:build`); (3) the
platform package `@jumsay/striart-native-<os>-<cpu>` (optional dependency,
esbuild pattern; Windows, macOS and Linux on x64 and arm64, Linux as static
musl), **verified** against the signed manifest embedded in the main package:
signature (minisign/Ed25519 by default, a named scheme replaceable by another
without touching the rest), then SHA-256 and size. No source →
`NATIVE_UNAVAILABLE`; a digest, signature or version mismatch →
`NATIVE_INTEGRITY_FAILED` — the binary is then **never** run (fail closed).
Loading rechecks the binary's on-disk identity (size, date, inode) on every
call. The public key is versioned (`native/keys/minisign.pub`); the private key
only exists as a CI secret (`STRIART_NATIVE_SIGNING_KEY`). `scripts/pack.ts`
requires the binaries (`--native-dir`), signs the manifest, verifies the
archive with the exact check of the loader and adds the native components (and
`Cargo.lock`) to the CycloneDX SBOM. Rust-side chain: pinned toolchain
(`native/rust-toolchain.toml`), versioned `Cargo.lock`; in CI, `cargo fmt`, `clippy -D warnings` and
`cargo test` on three OSes (and on both musl targets, x64 and arm64 — the
published Linux binaries are static musl), `cargo deny` (licenses, RustSec
advisories) on Linux.

**Trust anchor.** A manifest signature proves that the manifest, the package's
public key and the binaries are *consistent* with each other; it does not
prove where they come from — a malicious main package would ship its own key.
The signing `keyId` is therefore compared with a list that lives **outside the
verified package**: the key **pinned in the published code**
(`PINNED_NATIVE_KEY_IDS`) and `native.trustedKeyIds` of the *user* config
(never the repository's); an unknown key gives `NATIVE_INTEGRITY_FAILED`
(`KEY_NOT_TRUSTED`). A manifest marked `ephemeral` (a throwaway key for local
verification, which `pack:release` only allows with `--dry-run`) is refused at
run time (`EPHEMERAL_SIGNATURE`). The provenance of the main package stays
the registry's business (`@jumsay` scope) and the sigstore provenance
attestation, which **only the GitHub workflow** produces (`gh attestation
verify`; the self-hosted CI workflow produces none: the SHA-256 of each archive and the
manifest signature are what counts there). Accepted limit: the verification
cache (size, date, inode) does not protect against a process of the **same
user** replacing the binary between two checks — the same trust level as
access to `.striart/`.

**Abrupt host death: the guarantee depends on the OS.** On `SIGKILL` or
`TerminateProcess`, no code runs. **Windows**: the kernel closes the Job
Object handle (`KILL_ON_JOB_CLOSE`) and kills the *whole* descendance.
**Linux**: only the direct program gets `PR_SET_PDEATHSIG`; descendants that
left the group (`setsid`, a daemon) or ignore SIGHUP survive — POSIX has no
equivalent of `KILL_ON_JOB_CLOSE`. **macOS**: the kernel's SIGHUP only. On a
**clean** stop, the host kills the group then the tracked descendants
(refreshed every 2 s) that left it. On Windows, closing the console
(`CTRL_CLOSE_EVENT`) leaves ~5 s at most: `job run` waits, within a 4.5 s
budget, for the job to be killed and the report written. The Test Gate does
not rely on abrupt death: it reads the container report (`complete`,
`survivorPids` — an incomplete cleanup yields `JOB_TERMINATE_INCOMPLETE`). On
POSIX, the attach socket path is limited by the OS (104 bytes on macOS, 108 on
Linux): beyond that the host refuses to start with `PTY_ENDPOINT_TOO_LONG`.

**Consequence**: Striart now needs the native binary for process identity,
tree kill, the Test Gate container and the pty host. In development, it is built (`npm run
native:build`, Rust toolchain required — see CONTRIBUTING.md); for users, it
comes with the package. If the binary is unavailable, `killProcessTree` logs
the `NATIVE_*` error then kills at least the head process (last resort, never
silent). The Test Gate, however, is **fail closed**: without a healthy native binary it is not run and returns red
`GATE_NATIVE_UNAVAILABLE` (explicit relaxation: `gateContainer: 'process'`). A *preflight* that would refuse to start a **session** without a healthy
binary is **not** delivered (see the roadmap). macOS and
ARM64 are only compiled by CI, not yet proven on a machine.

## Orchestration modes and the collaboration channel

`src/orchestration/` runs the `version: 2` plans: `plan-schema.ts` (positive
validation), `scheduler.ts` (`sequential`/`parallel` chaining, fan-in
dependencies, failure policy), one module per mode (`review.ts` + `verdict.ts`
+ `human-review.ts`, `race.ts`, `team.ts`, `pipeline.ts`), `unit.ts` (one
autonomous turn/task on the cycle primitive), `briefing.ts` (turn prompts:
facts computed by Striart first, agents' texts framed as untrusted after),
`wait.ts` (bounded and interruptible waits — `ok`, `timeout`, `aborted`, never
an infinite wait), `store.ts` (state readable across processes, `runs/` and
`groups/`), `settings.ts` (`orchestration`, `collab`, `llmRoles`). The
**collaboration channel** (`src/collab/`) is mediated by Striart: `channel.ts`
(the store, under the state lock), `message.ts` (validation, neutralization,
token fence), `files.ts` (`.striart-inbox.md` / `.striart-outbox.json`, fixed
paths, opened without following links). No agent accesses another's clone; the
sender is inferred; the content is untrusted. See
[Execution modes](execution-modes.md#the-orchestration-modes).

## Tokens: accounting, ceilings, savings

`src/tokens/`: an **append-only** ledger per day (`ledger.ts` — field
allow-list, never any content, serialized `O_APPEND`, tolerant read,
incremental aggregates), **ceilings** on five scopes (`budget.ts` — alert at
the threshold, refusal *before sending*, fail closed), a local estimator
calibrated on real usage (`estimate.ts`), a table of **configurable prices**
(`pricing.ts` — no hard-coded price), the instrumentation of **every** LLM
call (`call.ts`, the single `llmGenerate` entry point: estimation, guard,
record), the counter of an agent session fed by its structured stream or its
ACP updates (`session-meter.ts` — it *signals* the crossing, does not kill by
itself), a cache of idempotent results (`cache.ts`) and the reports
(`report.ts`, source of `striart usage`, `status` and `doctor`). Savings come
from three mechanisms: the Merger only submits the conflicting regions
(`merge-hunks.ts`, local diff3), the Router tree is ranked and summarized
(`router-tree.ts`), and the Memory Layer de-duplicates. Call resilience
(exponential backoff with jitter, `Retry-After`, per-provider circuit
breaker) lives in `llm-resilience.ts`.

## Protected-paths guard, commit contract, instructions

Three modules set the boundaries of an agent session: `protected-paths.ts`
(81 patterns verified against the tools' documentation, a minimal glob
grammar shared with the validation of the roles' `files` — `glob-lite.ts` —,
case-insensitive comparison by default; the guard runs in `mergeAgentCommit`
*before* any merge), `commit-policy.ts` (who commits, with which files
excluded, which author and which message) and `agents/instructions.ts` (the
session rules handed to the agent through its profile's channel;
`git-exclude.ts` is the single module for a clone's `.git/info/exclude`,
shared by memory, instructions, collaboration and hooks). The profile catalog
(`agents/catalog.ts`), installed-tool detection (`agents/detect.ts`), the ACP
registry import (`agents/acp-registry.ts`) and the transcription of structured
outputs (`agents/transcript.ts`) complete `agentProfiles`.

## Terminal and hooks

`src/terminal/`: launchers (`launchers.ts`, one per terminal, argv quoted per
**its** target's grammar — `quote.ts`), Warp (`warp.ts`: a 0600 Tab Config
instead of the URI scheme, which executes nothing), private writes outside
`.striart/` (`private-file.ts`, refusing a planted symlink). The advisory
hooks (`src/hooks/`): one adapter per tool (`adapters.ts`, event schemas
verified in each one's documentation), the notice (`advisory.ts`, read-only,
outside the lock), installation (`install.ts`, only for the user or in a
clone, on explicit command) and config trust (`run.ts`, `src/user-config.ts`).

## Map of the new modules

| Module | Single responsibility |
|---|---|
| `lock.js`, `break-lock.ts`, `state-lock.ts` | Heartbeat main lock with a fair queue; shared serialized-break building block; short state lock. |
| `json-file.js`, `log-rotation.ts`, `stop-request.ts`, `ticket-id.ts`, `line-reader.ts` | Atomic write v2; log rotation; cross-platform clean stop; shared ticket-id pattern; line reading bounded *while* reading. |
| `native.ts`, `native-signature*.ts` | Resolution and verification of the native binary; named signature schemes (minisign). |
| `autonomous-cycle.ts`, `protected-paths.ts`, `commit-policy.ts`, `git-exclude.ts`, `glob-lite.ts` | Single end of session; protected paths; commit contract; `.git/info/exclude`; shared globs. |
| `agents/`, `acp/`, `acp-agent/` | Catalog, detection, instructions, ACP import; ACP v1 client and persistent host; `striart acp` proxy. |
| `control/`, `mcp/`, `hooks/`, `terminal/` | Control Protocol and dashboard token; MCP server; advisory hooks; terminal launchers. |
| `orchestration/`, `collab/` | `review`/`race`/`team`/`pipeline` modes and v2 plans; collaboration channel. |
| `tokens/`, `llm-resilience.ts`, `router-tree.ts`, `merge-hunks.ts` | Ledger, ceilings, prices, cache; backoff and circuit breaker; compacted Router tree; region-based merge. |
| `safe-write.ts`, `secret-patterns.ts`, `project-path.ts`, `agent-artifacts.ts` | A write that never follows a link inside a clone (`SAFE_WRITE_UNSAFE`); gitignore patterns of `secretPatterns` for the history; safe project path (relative, never absolute or `..`); release of an agent's ACP host and Warp *Tab Configs* (`stop`/`clean`). |
| `agent-name.ts`, `ticket-id.ts`, `merge-subject.ts`, `plan-command.ts`, `timer-limits.ts`, `pty-limits.ts` | Pattern of agent names and ticket ids (validated before any heavy load); format of the `merge(striart): …` subjects (single source); executable name of a plan `command`; 2^31 − 1 bound on delays; pty bounds. |
| `pty-attach.ts`, `pty-host.ts`, `pty-host-state.ts`, `watch-loop.ts`, `watch-ui.ts` | Multi-client attach protocol and pty host lifecycle; its state readable with no dependency; the `striart watch` loop (typed events, writes nothing); the `watch --ui` Ink UI. |
| `user-config.ts`, `doctor-relaxations.ts`, `state-watch-ignore.ts`, `agent-view.ts` | User config (`hooks.trustedRoots`); relaxed-protections summary; transient paths ignored by the Control Protocol and MCP-feed watchers; agent presentation (`REMOVING` state). |

## Golden rules

1. **Never push from an agent.** Clones are islands with no remote; only the
   orchestrator pushes.
2. **Never commit without a green Test Gate.** Even if the merging LLM is
   "sure of itself".
3. **Never delete a clone while an agent is working.** `striart stop` keeps
   the clone, and `striart clean` refuses at two levels, depending on what it
   knows: `IN_USE` when the clone's disk changed recently (`presenceMinutes`)
   — a heuristic, which `--force` can therefore knowingly override;
   `SESSION_LIVE` when an autonomous session's PID (or the ACP session host)
   is alive, or the pty host of an `--open` terminal is running — a verified
   fact, which **`--force` cannot override** (the host is recognized by its
   command line, `striart-native pty-host --agent <agent>`: a PID the OS
   handed to another process does not block the clone forever, and is never
   killed by `striart stop`). Uncommitted or unmerged work
   (`PENDING`, `BUSY`) also protects the clone.
4. **Mandatory human fallback.** 3 failed semantic merges in a row → manual
   mode until `striart resolve --unlock`. Each failure produces a complete
   ticket in `.striart/conflicts/` (BASE/OURS/THEIRS versions, LLM attempt,
   Test Gate log).

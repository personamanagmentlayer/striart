# Architecture

> [Documentation](README.md) · Architecture

## The three pillars

When several AI agents work on the same repo in parallel, they trample each
other: Git conflicts, greedy commits, semantically broken merges. Striart
solves this with three pillars:

1. **Physical isolation** — each agent works in a real, independent Git clone
   with no remote (`.striart/agents/<name>/`).
2. **Preventive Router** — before launching an agent, an LLM predicts which
   files will be touched and queues colliding tasks. It is a **coarse filter, not
   a guarantee**: see
   [what the Router and the merge are worth](#what-the-router-and-the-semantic-merge-are-worth--measurements-of-2026-10-26).
3. **Semantic merge + Test Gate** — agent commits are merged automatically;
   on conflict, an LLM merges the code; nothing is committed until `npm test`
   (or your command) passes.

Striart is not an opaque central brain: it's a **Git pacemaker**. The human
sees everything and can interrupt, correct, or approve.

## Why clones — and not worktrees?

Isolating files is only part of the problem. A worktree (or a hand-made clone)
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
no copy of the objects (cost not measured here), history paid once. Isolation covers everything
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
│   ├── idle/                 # idle GC: state.json (warnings), beats/<agent>.beat (output heartbeat of an autonomous session), close/<agent>.json (clean stop request)
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

All of `.striart/`, except `agents/` and `removing/` (working trees, never
walked), is **reserved to the user**: directories `0700`, files `0600`, or a
protected ACL on Windows (`privateStateDir`, see
[Configuration](configuration.md#local-data-privatestatedir)).

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
│    nothing is committed — then merge commit (the target's hooks,    │
│    under commitTimeoutMs, never bypassed); lock released →          │
│    delivery to origin if autoPush                                   │
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

### What the Router and the semantic merge are worth — measurements of 2026-10-26

The Router is a **coarse filter, not a guarantee** (architecture decision no. 4):
it reduces noise; the semantic merge and above all the Test Gate do the rest.
Two real benches, opt-in and outside `npm test`, put numbers on that position:
`npm run bench:router` and `npm run bench:merger`. Every case makes a **real call
to a cloud provider** — the `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` and
`GROQ_API_KEY` keys are read from the root `.env` (parsed, never executed; only
those three keys are kept, never displayed). Default models: `claude-haiku-5-5`,
`gpt-5.4-mini` and `openai/gpt-oss-120b` (Groq).

- **Router bench** (reproducible protocol, no human judgment). *Corpus*,
  versioned (`scripts/data/router-bench-tasks.json`): **94 real commits** from
  this repository's history, split once and for all by the hash of their SHA into
  a **tuning** set (60) and a held-out **test** set (34) — tune on the first,
  report on the second. The *task* is not the commit message (written after the
  work and optimistic, it often named the files) but a **natural, vague request**,
  generated once by an LLM from the diff with its paths masked, forbidden to name
  a path, file or symbol (a deterministic check rejects and regenerates). The
  submitted *tree* is the parent commit's `git ls-tree`, the *truth* the set of
  files that commit changed (lockfiles excluded). It measures precision and recall
  (code and total), full coverage, **overlap detection** over all pairs of tasks
  (seen / missed; needless alerts), tokens and latency, with **95 % bootstrap
  confidence intervals**. LLM requests are cached on disk (outside the repository):
  changing a purely deterministic variant pays nothing again. Variants: `legacy`,
  `balanced`, `recall` and ablations (`scripts/data/router-bench-variants.json`).
- **Merger bench**: 8 gold cases, textual conflicts (BASE / OURS / THEIRS) whose
  two sides stay **compatible in intent**, each with an **executable check** — the
  merged file is imported and its behaviour verified: a merge that "looks right"
  but is wrong fails. Several tries per case (`--repeat`).
- **Merge-cycle bench** (`npm run bench:merge`, no network): see
  [Observability](#observability-per-phase-durations-lock-contention-performance).

**Router — survey of 2026-10-26** (test set, 34 tasks, `claude-haiku-5-5`; 95 % CI
in brackets; the maintainer's survey, **not replayed by the documentation pass
and earlier than the last tweaks to the settings**). The full table, with
`gpt-5.4-mini`, is in
[Configuration](configuration.md#tokensrouter--router-reliability).

| Preset | Recall (code files) | Code overlaps detected | Needless alerts | Serialized tasks |
|---|---|---|---|---|
| `legacy` (behaviour from before the batch) | 30 % [21–39] | 39 % [23–55] | 8 % [2–18] | 0 % |
| `balanced` (default) | 51 % [43–60] | 78 % [62–90] | 33 % [14–56] | 9 % |
| `recall` | 72 % [60–84] | 100 % [97–100] | 64 % [46–83] | 29 % |

Merger — 8 cases × 3 tries, survey of 2026-10-26 (quote it **as is**, never as a
promise): `claude-haiku-5-5` **24/24** verified merges, `gpt-5.4-mini` **23/24**.
No figure is recorded for `openai/gpt-oss-120b`. The earlier Router survey (commit
message as the task, 24 commits: `claude-haiku-5-5` precision ~66 %, recall ~48 %,
overlaps detected ~58 %) came from an abandoned, more flattering protocol — a
recall ceiling —; it is replaced by the survey above.

Honest reading:

- With the default preset, **about half** of the code files really touched are
  not predicted and about **one code overlap in five** is not seen: the Router
  does not prevent every conflict, and nothing in Striart presents it as doing so.
  The `recall` preset sees almost everything, but by serializing one task in three
  to one in two (a serialized task collides with every active agent, so it
  "detects" everything by construction) — a trade-off, not a gain.
- About **26 % of the touched files are invisible to any signal** (neither
  lexical nor structural: semantic coupling with no trace in names, imports or
  history), according to the maintainer's measurement quoted at the top of
  `src/overlap.ts` (not replayed by the documentation pass): no Router
  prediction, with or without expansion, reaches them. That is why the runtime net
  exists
  ([`overlap`](configuration.md#overlap--the-runtime-overlap-net)), which reads
  the files *really* modified instead of predicting them.
- The "rename versus new caller" case: git merges **without conflict** a **wrong**
  result (the call added by the agent uses the old name). The Merger is not even
  invoked — **only the Test Gate catches it**, and only if the suite exercises that
  code. Striart's safety rests on the merge and the Test Gate, never on the
  Router; the quality of `testCommand` is load-bearing.
- Limits: 8 synthetic cases for the Merger; 94 commits from a single repository
  (JavaScript and TypeScript) for the Router, tasks generated by a single model
  (possible bias), specific models and a specific date, non-deterministic
  outputs, wide intervals on 34 tasks. The Router benches send data from the
  current repository to the provider: the file tree, the candidates' map (symbols
  and first documentation line) and the requests; **corpus generation**
  (`scripts/bench-router-corpus.ts`) sends commit **diffs**, paths masked (see
  [SECURITY.md](../../SECURITY.md)). Do not run them on a confidential
  repository.

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
lock is still held during a merge's Test Gate and LLM calls (outside the lock
since: the push to `origin`, see the next section; the merge commit stays under
the lock but is bounded by `commitTimeoutMs`); the integration
clone (decision D1: merge, LLM merge and Test Gate outside the lock, the lock
covering only the final fast-forward) is **decided but not delivered** — see
decision no. 3 of the `CLAUDE.md` in the `.claude` folder and the roadmap section "Performance and
reliability under continuous load".

## Delivery to `origin`: outside the lock

A green merge's push is no longer made inside the critical section: a corporate
`pre-push` hook, an authentication or a slow network used to freeze the whole
orchestrator for the duration of the push. An operation's effects — events
(webhooks), Memory Layer update, **delivery** — are now *deferred*: they leave
**after the main lock is released** (`runWithDeferredEffects`,
`src/orchestrator.js`). The delivery (`src/delivery.ts`) pushes the **exact SHA**
that passed the Test Gate (`<sha>:refs/heads/<branch>`, never `HEAD`, never
`--force`), with:

- a **hard timeout** (`pushTimeoutMs`) and the death of the process **tree** at
  the timeout (the hook is a grandchild of git) — which simple-git cannot do;
- no possible **prompt** (`GIT_TERMINAL_PROMPT=0`, `GCM_INTERACTIVE=never`, stdin
  closed, no inherited `GIT_*` variable);
- the hook's **output** kept, bounded to its tail (16 KiB), remote URL tokens
  redacted;
- a **per-repository chain** within the process (two successive merges push in
  order) and, between processes, recognition of a SHA already published by a
  concurrent push (`alreadyDelivered`);
- a guard: the SHA must still be in the local branch at push time
  (`PUSH_SUPERSEDED` otherwise — a rollback went through), and `rollback` awaits
  the in-flight deliveries of its process before deciding whether the merge is
  "published".

The **merge commit** stays under the lock (it concludes a merge open in the main
repo) but is also bounded: `commitTimeoutMs`, tree killed, the target's hooks
run and are **never bypassed** (`COMMIT_HOOK_REJECTED`, a ticket that keeps the
hook's output; `MERGE_COMMIT_FAILED` for a missing identity or signing). The
promotion advances `mainBranch` with `update-ref` as a **compare-and-swap** on
the old SHA — not a `git push .`, which would run the target's `pre-push` hooks
*under* the lock —, then delivers outside the lock. With `delivery: 'branch'`,
the SHA goes to `striart/<agent>/<task>` (`striart/promote/<date>-<sha8>` for a
promotion) and the remote target branch never advances because of Striart: the
forge stays the approval authority. **Why outside the lock**: even bounded, a
push under the lock would hold it up to `pushTimeoutMs` (2 min by default) and
freeze every other operation. **Accepted debt**: a `rollback` run by *another*
process during an in-flight push is not prevented (it is made loud, not
forbidden). See
[Configuration](configuration.md#delivery-to-origin-autopush-delivery-timeouts).

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

## Idle GC: close a forgotten session, never a clone

A forgotten agent keeps a process, a terminal or ACP session host and a clone
alive indefinitely. `src/idle/` detects them and, on the user's policy and
authorization, closes **the session** — the only exception to "a clone whose
session is alive is untouchable", strictly bounded:

- **No data is deleted or integrated.** No clone removal, no registry removal, no
  rebase, no merge; uncommitted work stays where it is. What is closed is the
  *session* (ACP host, pty host, or the process of an autonomous session) through
  its clean stop protocol, never a blind kill: a process that cannot be identified
  (recycled PID, other user, mute supervisor) is **not** killed
  (`IDLE_CLOSE_UNVERIFIED`, `IDLE_CLOSE_NOT_ACKNOWLEDGED`).
- **Fail closed everywhere.** `classify.ts` is pure (the clock is a parameter): an
  unreadable signal, an inconsistent clock or no signal make the agent *active*; a
  guard (human request, ticket, orchestration, merge, main session, removal,
  exclusion) makes it *protected*; an unreadable context source forbids any
  closing in the sweep.
- **Mandatory gradation**: detect → warn → grace → close, the warning having to
  date from *after* the last activity; a **fresh re-check** (registry, signals,
  guards, no hint) precedes the stop.
- **The authorization comes from the user** (`idle.closeRoots`, user config
  outside the repository), the policy from the repository (`idle.action`);
  `--close` is a human request that replaces both but neither the grace nor the
  guards.
- **Never under the main lock**: the sweep reads, closes a session and writes its
  state only under the state lock (`idle/state.json`, short section). In
  `striart watch` it runs outside the merge chain, one at a time, and waking from
  sleep neutralizes that round.
- **Surfaces**: `striart gc`, `striart status` (`--dry-run` sweep), the Control
  Protocol (`workspace.gc` and the state's `idle` field), the dashboard (badge,
  card, preview button), `watch --ui` / `--plain`. The agent plane (MCP) exposes
  no GC tool.

The output heartbeat of an argv autonomous session (`heartbeat.ts`) is an empty
file whose *mtime* is the signal — no agent data passes through it. For a
terminal, the native pty host publishes `host.output` (`{pid, lastOutputAt}`,
atomic write at most once per second, bound to its PID, removed on its exit); its
absence makes the output unobservable (see
[`striart gc`](commands.md#striart-gc-agent---close---dry-run)).

## Observability: per-phase durations, lock contention, performance

Batch L8 — **measure before deciding**: the intended gain of batch L9 (Test Gate
outside the lock, **not delivered**) must be proved by a before/after, not
asserted.

- **`timings`** (`src/timings.ts`): the results of `merge`, `resolve --apply`,
  `promote` and `run` carry, additively in `--json`, the durations in
  milliseconds per phase — `route`, `lockWait`, `sync`, `merge`, `semantic`,
  `gate`, `commit`, `delivery`, `memory`, `lockHeld` (the critical section, the
  number L9 is meant to bring down) and `total`. Monotonic clock; numbers, nothing
  else.
- **`lock:contention`**: an event on the observability bus, published when a
  caller had to *wait* for the main lock — the verb of the waiting operation, the
  wait duration, the holding operation and its age, the queue length. Never an
  agent or ticket name (it can derive from a prompt). It is neither sent to
  webhooks nor relayed by the Control Protocol or the MCP feed: measurement only.
- **`striart doctor` — `performance` check**: real latency of the state lock
  (median of 5 atomic writes under lock; budget 100 ms, alert above one second),
  duration of a `git status` of the main repository (flagged above 2 s), size of
  `.striart/` (time-bounded walk), number of agents, age of the oldest held lock
  (flagged above 5 min). Each measurement is bounded; a performance finding is a
  *warning*, never an error.
- **`npm run bench:merge`** (`scripts/bench-merge.ts`, no network): replays N real
  agents merging in parallel behind the lock, with a Test Gate that sleeps
  `--gate-ms`, and renders, per phase, p50 / p95 / p99 / max (including `lockHeld`
  and `lockWait`), the throughput and the share of wall time during which the lock
  is held, with the median of several runs (`--repeat`). While the gate runs under
  the lock, `lockHeld` grows with its duration and throughput is capped at 1 / gate
  duration: the bench renders these numbers reproducibly so the same scenario can
  be replayed after L9.
- **Stable failure codes**: a semantic-merge failure carries `errorCode` (the
  contract) next to the core's French text (`error`, kept for compatibility) and
  public `errorDetails` (identifiers only); an LLM call failure carries
  `details.causeCode` (`TRANSPORT`, `TIMEOUT`, `HTTP_4XX`, `HTTP_5XX`,
  `TRUNCATED`, `FILTERED`, `REFUSED`, `INVALID_JSON`, `INVALID_RESPONSE`), never a
  provider's message.

## Clone sizes: a display cache, never a guard

A clone's additional size is **display** (`sizeBytes` in `status`, the dashboard,
the Control Protocol). It is served from a cache (`clone-size-cache.ts`) while the
entry is under 5 minutes old **and** nothing moved (signature: worktree activity,
references, index, pack directory), or under 10 seconds old whatever happens — at
most one walk per clone every 10 s, even if its disk changes continuously. The
measurement instant is exposed (`sizesComputedAt`, ISO 8601): a size's age is
never hidden. The cache is in-memory in one process; an incomplete measurement
never enters it.

What is a **security decision** (`sessionActive`, the guards of `clean` and
`reuse`) reads something else: `cloneWorkActivityMs` (`clone-disk.ts`), exact,
never cached, fail closed — a walk of the worktree where every entry is read (a
directory `mtime` is not enough: an in-place write does not change it), never
following a symbolic link or a junction, and never walking `.git`. A clone with no
readable activity is not judged idle.
## Why serialization makes auto-stash safe

The disjointness check (B's in-progress files vs. files touched by the
incoming commits) is only worth anything if the target branch doesn't move
between the check and the `stash pop` (TOCTOU problem). Since merges and
syncs live in the same chain, the target branch is **frozen** for the whole
check → stash → rebase → pop sequence: what was measured stays true to the
end.

## Outgoing calls: the network layer

**Every outgoing call goes through `src/net.ts`** (`netFetch`): LLM (Ollama,
OpenAI-compatible, Anthropic, Azure), notification webhooks, the Ollama probe,
the ACP registry and its archives. Invariant **checked by a test**
(`net-single-entry`): no other module of `src/` calls `fetch()` or
`http(s).request()`. For each non-local call the layer applies, in order: a
valid `http(s)` URL, offline mode, the host allow-list, **HTTPS required** (API
key or not), TLS verification never switched off, **no redirect followed**
(bounded, hop-by-hop rechecked following for the ACP registry archives only) —
then applies to the process, idempotently and all-or-nothing, the corporate
proxy (`http.setGlobalProxyFromEnv`, or the environment proxy enabled at
startup), the corporate CA (`tls.setDefaultCACertificates`, **added** to the
default authorities) and the minimum TLS version. A proxy that is configured but
cannot be applied on this Node **refuses** the call (`NET_PROXY_UNSUPPORTED`)
rather than letting it go out directly.

The policy is a **user decision**: shell environment and **user config**
(`network`, `src/user-config.ts`) — never the repository config, never the
`.env` (the filter refuses these variables). The two sources combine on the
restrictive side. The loopback is exempt and does not read the user config, so
that a local Ollama depends on nothing. `session-env.ts` extends the policy to
agent sessions: `network.caFile` becomes the session's `NODE_EXTRA_CA_CERTS` (the
shell wins), `STRIART_PROXY_AUTH` is never passed on. `striart doctor` exposes
the effective policy (`inspectNetwork`). **Accepted limits**: no check of the
resolved IP address (DNS rebinding on an allowed host), no `ALL_PROXY` or SOCKS,
no end-to-end test with a real HTTPS proxy. Details and options:
[Configuration](configuration.md#enterprise-network-network).

## Local confidentiality, gate environment, redaction

A few modules draw the boundary between Striart's data and the rest of the
machine:

- `private-fs.ts` / `state-protection.ts`: `.striart/` reserved to the user
  (0700/0600 on POSIX; a protected DACL set by `icacls` and verified in SDDL on
  Windows), idempotent migration of what exists, failure = `STATE_UNPROTECTED`
  (fail closed), explicit relaxation `privateStateDir: false`. The protection is
  set **before** taking the main lock (an `icacls` costs 1 to 3 s on Windows:
  never under a lock), memoized per root and per process, and only if
  `.striart/` exists (it never creates the folder of a non-initialized repo).
  `agents/` and `removing/` are **never walked**: their git objects are hardlinks
  shared with the main repo, changing their ACL would change the main repo's too.
- `gate-env.ts`: the Test Gate environment is an allow-list (the gate runs tests
  the agent may have written); API keys and webhooks never enter it; the
  repository's `gateEnv` *requests*, the user's `gate.envAllow` *allows*.
- `redact-secrets.ts`: redaction **by content** (known key formats, JWTs,
  authorization headers, URL credentials, webhooks, private-key blocks) and by
  the environment's **exact values**, at bounded cost (non-nested patterns,
  256 KiB slices). Applied to the gate log, session and ACP logs, tickets, the
  output of the target's hooks and the pino logs. Defense in depth, not a
  guarantee: a secret with no recognizable shape is only found by its exact
  value, and a secret straddling two slices of one giant line escapes the
  patterns.
- `hardening-checks.ts`: the matching `doctor` findings.

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
equivalent of `KILL_ON_JOB_CLOSE`. **macOS**: the kernel's SIGHUP only — the direct program dies, but a grandchild in the same group can survive (observed in CI). On a
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
| `router-map.ts`, `router-retrieval.ts`, `router-expand.ts`, `router-cochange.ts`, `router-vague.ts`, `router-shared.ts`, `router-sources.ts`, `router-details.ts` | The hardened Router: repository map (symbols, docs), BM25 lexical retrieval, deterministic expansion (tests, imports, twins, co-change), vague-task detection (`**` sentinel), shared bookkeeping files, bounded source reader (disk or git objects), public shape of the details (`routing`). |
| `overlap.ts`, `overlap-settings.ts` | Runtime net: *observed* overlaps (git between commits, read-only), early rebase never on a live session; settings (leaf module). |
| `session-failure.ts` | `sessionFailure` marker of a clone kept after a failed session with no commit: the `**` sentinel no longer waits for it (`task:serialization-relaxed`, `SERIALIZATION_RELAXED`). |
| `idle/` | Idle GC: pure classification (`classify.ts`), signals and guards (`signals.ts`), sweep (`sweep.ts`), clean per-host closing (`close.ts`), user authorization (`authorize.ts`), output heartbeat (`heartbeat.ts`), state (`state.ts`), state view (`status.ts`), settings (`settings.ts`). |
| `timings.ts`, `doctor-perf.ts` | Per-phase durations of a core operation; `doctor` performance measurements. |
| `clone-disk.ts`, `clone-size-cache.ts` | Disk walk of a clone (exact fail-closed activity, display size); dated size cache. |
| `safe-write.ts`, `secret-patterns.ts`, `project-path.ts`, `agent-artifacts.ts` | A write that never follows a link inside a clone (`SAFE_WRITE_UNSAFE`); gitignore patterns of `secretPatterns` for the history; safe project path (relative, never absolute or `..`); release of an agent's ACP host and Warp *Tab Configs* (`stop`/`clean`). |
| `agent-name.ts`, `ticket-id.ts`, `merge-subject.ts`, `plan-command.ts`, `timer-limits.ts`, `pty-limits.ts` | Pattern of agent names and ticket ids (validated before any heavy load); format of the `merge(striart): …` subjects (single source); executable name of a plan `command`; 2^31 − 1 bound on delays; pty bounds. |
| `pty-attach.ts`, `pty-host.ts`, `pty-host-state.ts`, `watch-loop.ts`, `watch-ui.ts` | Multi-client attach protocol and pty host lifecycle; its state readable with no dependency; the `striart watch` loop (typed events, writes nothing); the `watch --ui` Ink UI. |
| `net.ts`, `session-env.ts` | **Single** entry point of outgoing calls (offline / allow-list / HTTPS policy, proxy, CA, TLS); network environment of agent sessions. |
| `delivery.ts` | Bounded merge commit and push (hard timeout, tree killed, no prompt), delivery of the exact SHA, delivery branch names. |
| `private-fs.ts`, `state-protection.ts`, `gate-env.ts`, `redact-secrets.ts`, `hardening-checks.ts` | `.striart/` reserved to the user; Test Gate environment; secret redaction; the hardening `doctor` findings. |
| `dashboard-page.ts`, `dashboard-client.ts`, `dashboard-messages.ts`, `dashboard-style.ts` | The dashboard page: skeleton rendered server-side in the instance's language, embedded TypeScript client, fr/en catalog, style sheet (light/dark). |
| `user-config.ts`, `doctor-relaxations.ts`, `state-watch-ignore.ts`, `agent-view.ts` | User config (`hooks.trustedRoots`, `env.allow`, `native.trustedKeyIds`, `network`, `gate.envAllow`); relaxed-protections summary; transient paths ignored by the Control Protocol and MCP-feed watchers; agent presentation (`REMOVING` state). |

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
   The one exception, and for the **session** only: the
   [idle GC](#idle-gc-close-a-forgotten-session-never-a-clone), on the user's
   policy and authorization, cleanly closes the session of a forgotten agent —
   never its clone or its work.
4. **Mandatory human fallback.** 3 failed semantic merges in a row → manual
   mode until `striart resolve --unlock`. Each failure produces a complete
   ticket in `.striart/conflicts/` (BASE/OURS/THEIRS versions, LLM attempt,
   Test Gate log).

<h1 align="center">
  <img src="assets/logo_striart.png" alt="Striart" width="420">
</h1>

<p align="center">
  <strong>Multi-agent Git orchestrator</strong> for Claude Code, Aider, Cursor, and any other AI coding agent.<br>
  Physical isolation · Preventive routing · Semantic merging · Blocking Test Gate
</p>

<p align="center">
  <img alt="version 0.10.0" src="https://img.shields.io/badge/version-0.10.0-6e56cf">
  <img alt="Node.js ≥ 22.18" src="https://img.shields.io/badge/node-%E2%89%A5%2022.18-339933?logo=node.js&logoColor=white">
  <img alt="422 tests" src="https://img.shields.io/badge/tests-422%20%E2%9C%94-2da44e">
  <img alt="no build" src="https://img.shields.io/badge/build-none-8250df">
  <img alt="MIT license" src="https://img.shields.io/badge/license-MIT-blue">
</p>

<p align="center">
  <a href="#why-striart--and-not-just-worktrees">Why Striart</a> ·
  <a href="#installation">Installation</a> ·
  <a href="#guide-3-agents-in-parallel-without-conflicts">Guide</a> ·
  <a href="#architecture">Architecture</a> ·
  <a href="#commands">Commands</a> ·
  <a href="#the-two-execution-modes">Execution modes</a> ·
  <a href="#configuration-striartconfigmjs-striartrcjson-">Configuration</a> ·
  <a href="#golden-rules">Golden rules</a>
</p>

<p align="center"><em>This is the English version of the <a href="README.md">French README</a>, which is the reference.</em></p>

When several AI agents work on the same repo in parallel, they trample each other:
Git conflicts, greedy commits, semantically broken merges. Striart solves this with three pillars:

1. **Physical isolation** — each agent works in a real, independent Git clone with no remote (`.striart/agents/<name>/`).
2. **Preventive Router** — before launching an agent, an LLM predicts which files will be touched and queues colliding tasks.
3. **Semantic merge + Test Gate** — agent commits are merged automatically; on conflict, an LLM merges the code; nothing is committed until `npm test` (or your command) passes.

Striart is not an opaque central brain: it's a **Git pacemaker**. The human sees everything and can interrupt, correct, or approve.

---

## Why Striart — and not just worktrees?

Isolating files is 10% of the problem. A worktree (or a hand-made clone)
keeps two agents from writing to the same place *at the same time* — all the
rest stays on you, for every task: avoiding collisions *before* they happen,
bringing N branches back into `main`, arbitrating conflicts, guaranteeing
nothing broken gets in. Striart automates precisely that rest.

| Need | Hand-managed worktrees | Claude Code subagents (built-in worktrees) | Striart |
|---|---|---|---|
| File isolation | ✅ | ✅ (zero friction) | ✅ full clones |
| Resilience to an agent going off the rails | ⚠️ shared `.git/`: a `reset --hard` or `gc` touches shared state | ⚠️ same | ✅ own refs/index, no remote, secrets excluded — blast radius bounded to the clone |
| Collision prevention | ❌ on you | ❌ depends on the model's task split | ✅ LLM Router + queue + `--after` dependencies |
| Getting work back into `main` | ❌ manual merges | ❌ up to the agent | ✅ auto-merge, rebase of every agent after each merge, 3-way semantic merge |
| Quality gate | ❌ | ❌ | ✅ **blocking Test Gate** — nothing lands without a green suite |
| Multi-vendor | ❌ | ❌ Claude only | ✅ Claude + Aider + Codex + Ollama… side by side |
| Lifespan | the session | the session | ✅ hours/days, multiple sessions, persistent queue |
| Observability & control | ❌ | session-bound | ✅ real-time dashboard, persistent logs, semi-autonomous (you arbitrate permissions), rollback |

**Clones, not worktrees — a safety choice.** Git worktrees share the main
`.git/`: fine for a disciplined human, dangerous for an unsupervised agent
running its own git commands. Striart gives each agent a real clone — and
neutralizes the classic cost: local-path clone, git **natively hardlinks the
objects** (immutable, hence safe), near-instant creation, history paid once.

**Nesting, not a duel.** Striart is agent-agnostic: Claude Code *is* one of
its agents. The natural setup — Striart hands it an isolated clone
(supervised, autonomous, or protocol-driven via ACP), and *inside* it Claude
Code remains free to use its own worktrees for its subagents: the two
mechanisms compose. Through the MCP server, the agent can even drive Striart
instead of bypassing it. In one sentence: **worktrees = zero-friction
intra-session parallelism; Striart = inter-agent orchestration with
continuous integration and a quality gate.**

---

## Installation

From source:

```bash
git clone https://github.com/personamanagmentlayer/striart.git
cd striart && npm install && npm link   # exposes the `striart` command
cd /path/to/my-project
striart init
```

Without `npm link`, everything can also be called directly: `node /path/to/striart/src/cli.js init`.

There is **nothing to compile**: `bin` points at the source (ESM). TypeScript
modules run as-is through Node's native type stripping, JSDoc-annotated `.js`
files coexist, and everything is checked by `tsc` — with no build step.

Prerequisites: Node.js 22.18+ (native type stripping), Git, and an LLM for the Router/Merger — local Ollama (default) **or** any cloud API (see Configuration).

---

## Guide: 3 agents in parallel without conflicts

```bash
cd my-project
striart init                          # creates .striart/, the config, checks the LLM

# Tab 1 — the orchestrator
striart watch                         # automatic merge + Test Gate + rebase

# Launch 3 agents (the Router checks for collisions before each launch)
striart run "Refactor the authentication module" --command "claude" --open
striart run "Add Stripe billing" --agent billing --command "aider --model gpt-4o" --open
striart run "New login component" --command "claude" --open
# without --agent, the name is derived from the prompt (e.g. refactor-the-authentic)

# ...and for a well-scoped task you don't want to babysit, Striart drives alone:
striart run "Add unit tests to src/parser.js" --autonomous --profile claude
```

`--open` opens a terminal tab directly in the agent's clone (Windows Terminal, Terminal.app, gnome-terminal) and launches the tool there. Each session is independent: it stays open until **you** close it.

From there, everything is automatic:

- Each agent commit is detected by `striart watch`, merged into `main`, and validated by the **Test Gate** — if it fails, the merge is aborted and a ticket is created.
- On a textual conflict, the **semantic merge** (LLM) attempts a resolution, revalidated by the Test Gate. If the gate rejects the merge, the Merger **retries with the error log as feedback** (`semanticGateRetries`) before opening a human ticket. After 3 consecutive failures: manual mode (safety rule).
- Conflicts **beyond the LLM's reach** (file deleted on one side and modified on the other, concurrent rename, binary, lockfile, oversized file, submodule, symlink, diverging executable bit) never go to the LLM: direct human ticket stating the nature of the conflict.
- The **invisible double rename** (git misses both renames, the merge looks "clean" but the file comes out duplicated) is tracked by a content heuristic: `⚠️` warning at merge time + webhook, non-blocking.
- With `memoryLayer: true`, every merge feeds a **shared semantic memory** (`.striart-memory.md` in each clone): agents know which APIs the others just added or changed — the countermeasure to the *semantic* conflict that has no Git conflict. The file also carries a **real-time "work in progress" section**: the other tasks (active and queued) and their Router-predicted files — everyone sees who is working where, at zero LLM cost.
- When a task starts, **semantic links** are reported (never blocking): files importing each other — relative-import graph for **JS/TS, Python, Ruby, PHP** — and linked packages of an **npm/yarn, Cargo, Go (go.work), Maven** monorepo.
- After each successful merge, the other agents are **rebased** onto the latest code.
- If the Router had queued a task, it starts as soon as the blocking agent is stopped (`striart stop`).

Real-time monitoring:

```bash
striart status          # agents, mode (auto/supervised), branches, tools, pending commits
striart queue           # scheduler: RUNNING / WAITING + blockers
striart dashboard       # http://localhost:3456 — real-time web view
striart resolve         # conflict tickets awaiting human resolution
```

---

## Architecture

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
│   ├── main.lock             # inter-process lock (transient)
│   ├── conflicts/<ticket>/   # base/ours/theirs + llm-attempt + test-output.log
│   └── logs/
└── striart.config.mjs
```

**A single process orchestrates everything**: `striart watch` detects commits from
all agents and handles each event in a **serialized chain**
(a promise chain acts as both a global lock and a FIFO queue).
Only one merge at a time can touch the main repo — the whole class of
"what if C merges while B rebases" bugs is eliminated structurally,
with no explicit lock.

### Flow of an agent commit

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
│  STEP 1: git merge FETCH_HEAD --no-commit --no-ff                   │
│    ├─ clean    → continue                                           │
│    └─ conflict → semantic merge (LLM, 3 versions BASE/OURS/THEIRS)  │
│        LLM failure → abort + human ticket → END                     │
│        (3 failures in a row → manual mode until resolve --unlock)   │
│                                                                     │
│  STEP 2: Test Gate (testCommand, timeout testTimeoutMs)             │
│    ├─ green → continue                                              │
│    └─ red   → merge --abort + human ticket → END                    │
│                                                                     │
│  STEP 3: merge commit (+ push origin if autoPush)                   │
│                                                                     │
│  STEP 4: syncAllAgents (except A)                                   │
│    each agent B, C... is immediately rebased onto the new main —    │
│    B always codes against the latest code                           │
│    (same stash/disjointness safeguards as step 0)                   │
└─────────────────────────────────────────────────────────────────────┘
  → next link in the chain (commit that arrived during processing)
```

In parallel, a periodic **silent fetch** (`fetchIntervalMs`, 20 s)
measures how far behind each agent is without ever touching their working
tree — pure visibility (logs, dashboard); actual resynchronization happens
at steps 0 and 4.

### The 6 synchronization statuses

| Status | When | Human action |
|---|---|---|
| `REBASED` (+ `stashed`) | Clean rebase — any stash restored | None |
| `UP_TO_DATE` | The agent has no commits behind | None |
| `SKIPPED_DIRTY` (+ `overlap`) | Work in progress overlapping the incoming commits, or `autoStash: false` | None immediately — webhook sent on overlap, resolved at the next commit |
| `REBASE_CONFLICT` (+ `stashKept`) | The agent's commits conflict with main (disjointness only covers uncommitted work) | None — the semantic merge takes over at merge time |
| `STASH_CONFLICT` | Stash pop in conflict (theoretically impossible, disjointness verified) | Intervention — work is safe in the clone's stash |
| `SKIPPED_SESSION` (+ `pid`) | An autonomous session is running in the clone — it is untouchable while its PID lives | None — the rebase is **postponed**, not cancelled: end of cycle rebases anyway |

The first five are returned by `syncAgentWithMain`. `SKIPPED_SESSION` is
decided one level up, in `syncAllAgents`: the clone is set aside **before**
anything is attempted on it. The usual safeguards (dirty worktree,
overlapping files) assume a human able to see their files move and react;
an autonomous session has no one to react, and it runs its own git commands.
A PID left in the registry after a crash is neutralized by the liveness
check — a clone can never stay frozen forever.

The disjointness check is deliberately conservative: renames count for
**both** their paths (old and new, `--no-renames` on the incoming commits,
`from` paths included on the worktree side) — worst case, a rebase is
postponed needlessly; never a false "safe".

### Inter-process lock

The serialized chain protects *within* the `watch` process. Across processes
(a manual `striart merge` while `watch` runs, two CLIs…), every mutating
operation (`run`, `merge`, `sync`, `stop`, `promote`, queue retry) goes
through a **file lock** `.striart/main.lock` created in exclusive `wx` mode —
atomicity is guaranteed by the OS kernel. The lock is reentrant within a
process, waits its turn by polling (2 min timeout), **automatically breaks
orphaned locks** (dead holder process, or 30 min TTL exceeded — a defense
against PID reuse), and on every acquisition, any merge abandoned by a
previous crash (orphaned `MERGE_HEAD`) is cleanly aborted.

### Why serialization makes auto-stash safe

The disjointness check (B's in-progress files vs. files touched by the
incoming commits) is only worth anything if `main` doesn't move between the
check and the `stash pop` (TOCTOU problem). Since merges and syncs live in
the same chain, `main` is **frozen** for the whole
check → stash → rebase → pop sequence: what was measured stays true to the end.

---

## Commands

| Command | Role |
|---|---|
| `striart init` | Initializes `.striart/`, the config, diagnoses the LLM. |
| `striart start <agent> [--command <cmd>] [--open]` | Isolated clone + task branch, no Router. |
| `striart start <agent> --reuse [--force]` | **Reuses** the kept clone of a stopped agent: resync onto current main, new task branch, untracked files preserved (node_modules — warm start). Refuses a dirty (`REUSE_DIRTY`), unmerged (`REUSE_UNMERGED`) or recently active (`REUSE_IN_USE`) archive; `--force` accepts the loss. `striart run --reuse` additionally goes through the Router. |
| `striart run "<prompt>" [--agent <a>] [--command] [--open]` | Preventive Router: predicts files, launches or queues (agent name derived from the prompt if absent). `--prompt <p>` is the scriptable equivalent of the positional. |
| `striart run "<prompt>" --autonomous [--profile <p>] [--timeout <ms>]` | **Autonomous mode**: Striart launches the agent itself, supervises, merges, runs the Test Gate, and deletes the clone if everything is green. |
| `striart run "<prompt>" --after <task\|agent>` | **Declared dependency**: the task waits in the queue until the referenced work finishes (merge + stop), then starts automatically. Unknown ref or cycle → refused at launch. |
| `striart plan <file.yaml> [--dry-run]` | **Tasks-as-code**: apply a YAML plan (task graph + dependencies) versioned in the repo. `--dry-run` validates and prints without launching anything. |
| `striart profiles [--json]` | Lists the configured agent profiles (tool, env keys, timeout) — the AIs available for `--profile` and plans. |
| `striart watch [--no-merge]` | Watches commits; continuous merge + Test Gate + rebase. |
| `striart merge <agent>` | Manual merge of an agent's latest commit. |
| `striart sync [agent]` | Rebases one agent (or all) onto the target branch. |
| `striart status [--json]` | Agent state: status, active session, **mode** (🤖 autonomous + profile / 👤 supervised), branch, tool, clone size, pending commits. |
| `striart queue [--retry]` | Task dashboard; `--retry` relaunches unblocked tasks. |
| `striart stop <agent> [--force]` | Terminates an agent (the clone stays on disk), unblocks the queue. |
| `striart rollback` | Undoes the last Striart merge: local reset (recoverable via reflog), or revert if the merge was already pushed. |
| `striart doctor [--json]` | Full diagnosis: git, repo, config, LLM reachability, locks, tickets — "why isn't this working?". |
| `striart watch --daemon [--status\|--stop]` | Background watcher: PID + logs in `.striart/`, orphaned-daemon detection. |
| `striart history [--limit <n>] [--json]` | History of Striart merges and rollbacks, rebuilt from the Git graph. |
| `striart promote [--rollback]` | Staging → main promotion: global Test Gate then fast-forward of `mainBranch`. |
| `striart resolve [--unlock\|--close <id>\|--all]` | Conflict tickets; `--close` marks resolved, `--unlock` re-enables semantic merging. |
| `striart clean [agent] [--stopped\|--all [--force]]` | Frees disk space: stopped agents by default; `--all` includes active agents **with no pending work**; `--force` also abandons unmerged work. |
| `striart reconcile` | **Reconciliation** (level-triggered): neutralizes dead sessions in the registry, unblocks the queue (even when no commit triggered it — e.g. `clean` of a blocker), repairs orphaned locks and merges. Idempotent. Replayed automatically by `striart watch`. |
| `striart prune [--days <n>] [--dry-run]` | Retention: prunes stopped inactive clones and tickets resolved more than N days ago (config `pruneDays`, 14). |
| `striart dashboard [--port <p>]` | Local web dashboard (127.0.0.1 only), **real-time** (SSE — pushed on every change, no polling): agent state and mode, watcher status banner, session logs, controls (merge, stop, retry, rollback, ticket closing). |
| `striart mcp` | Stdio MCP server: exposes the orchestrator to MCP hosts (Claude Code, Cursor…) — 5 tools, same locks and safeguards as the CLI (see the dedicated section). |

---

## The two execution modes

For each task, you choose who drives the agent.

**Supervised mode** (default). Striart prepares the isolated clone and gives
you the command; you launch your tool and watch it work. This is the mode for
open-ended, exploratory tasks, or for sensitive code.

```bash
striart run "Refactor the authentication module" --command claude --open
```

**Autonomous mode.** Striart launches the tool itself in non-interactive mode,
supervises the process, merges, runs the Test Gate, and deletes the clone if
everything is green. This is the mode for well-scoped tasks you don't want to
babysit.

```bash
striart run "Add unit tests to src/parser.js" --autonomous --profile claude
striart run "Translate error messages to English" --autonomous --profile codex --timeout 600000
```

Two easy-to-forget prerequisites: the tool must be **installed and already
authenticated** in the shell you launch Striart from — the session inherits its
environment, opens no login window, and cannot answer any prompt. And its
profile must be **genuinely non-interactive**: a command waiting for a
confirmation will hang until `--timeout`. When a session fails, the clone is
kept and the full log remains in `.striart/logs/session-<agent>-<taskId>.log`.

Profiles make the mode **vendor-agnostic**: each tool has its own headless
syntax, and `agentProfiles` describes it once. Claude, Codex, Aider, and
Ollama ship built-in; adding Kimi or any other tool is one config entry, and
does not erase the existing profiles. Several vendors can therefore work in
parallel on the same project, each in its own clone.

### ACP transport — the session you can actually watch

A profile can declare `acp: true`: Striart then talks to the tool over
**ACP (Agent Client Protocol)** — JSON-RPC over stdio, the v1 standard for
client ↔ coding-agent dialogue (Gemini CLI and Copilot CLI natively, Claude
Code via the official adapter, 25+ agents) — instead of passing the prompt as
argv and waiting for an exit code. Symmetrical to the MCP server: **MCP = the
agent drives Striart, ACP = Striart drives the agent.**

```js
agentProfiles: {
  'claude-acp': { command: 'claude-agent-acp', args: [], acp: true },
  'gemini-acp': { command: 'gemini', args: ['--experimental-acp'], acp: true },
  // De facto read-only: every requested permission is rejected.
  audit: { command: 'claude-agent-acp', args: [], acp: { permissions: 'reject' } },
  // SEMI-AUTONOMOUS: every permission is arbitrated by the human on the dashboard.
  prudent: { command: 'claude-agent-acp', args: [], acp: { permissions: 'ask', askTimeoutMs: 300000 } },
}
```

Same end-to-end contract (Router, merge, Test Gate, clone-deletion policy:
the orchestrator does not see the transport), but four things change:

- **The session stops being opaque**: messages, plan and tool calls are
  transcribed continuously into the session log — it tells the story, not
  just the ending.
- **Prompts become messages**: a permission request is answered by the
  profile's policy (`allow` by default — the trust level of the headless
  profiles, all running with `--yes`; or `reject`) and traced in the log. No
  more session stuck on a confirmation until the timeout.
- **Or arbitrated by you** (`permissions: 'ask'`) — the **semi-autonomous**
  mode: each request shows up at the top of the dashboard with one button per
  option offered by the agent; with no answer within `askTimeoutMs` (default
  120 s), **fail closed** — the refusal applies, never a default approval.
  The decision and its origin (human or timeout) are traced in the session log.
- **The filesystem goes through a checkpoint**: reads/writes the agent
  delegates to Striart are **scoped to the clone** — a path outside the clone
  is refused.
- **Shutdown is clean**: on timeout, `session/cancel` first (the agent can
  finalize), process-tree kill as the net.

With `acp: true`, `args` must **not** contain `{{prompt}}`: the prompt goes
through the protocol (a placeholder there is refused at config load — one
channel only). Argv profiles remain the path for tools without ACP; both
coexist freely.

### What autonomous mode guarantees

The clone is only deleted on the **fully green path**: exit 0, at least one
commit, successful merge, green Test Gate. Any other path keeps it and says
why — failed session, timeout, exit without a single commit, conflict, or red
gate. Cleanup **never** uses `--force`: if the agent left uncommitted work,
the clone survives. Session logs live under `.striart/logs/`, outside the
clone, so they always survive it.

### The two modes coexist on the same repo

Nothing forces a global choice: an autonomous agent and a supervised agent can
work side by side. The **session PID**, published to the registry while the
session lives, is what makes the state verifiable rather than assumed:

- **`striart watch` does not merge autonomous agents.** Their merge belongs to
  their own end of cycle. Without this filter, the watcher merged their
  *intermediate* commits and raced the final merge — main repo stuck in a
  "merging" state when the race was lost.
- **`striart sync` skips their clone** (`SKIPPED_SESSION`): you don't fight
  over the index with a session running its own git commands. The rebase is
  postponed, not cancelled.
- **`striart clean` refuses to delete it, even with `--force`**
  (`SESSION_LIVE`): `--force` exists to override a heuristic, not a fact.

A PID left in the registry after a crash is neutralized by the liveness check:
nothing stays frozen.

### What you must own

Without a human reviewing, **the Test Gate becomes the only authority**: the
quality of `testCommand` on your repo becomes load-bearing. A project with
weak tests will get merged code nobody has read.

And `--timeout` bounds time, **not spend**: an autonomous agent consumes
tokens unsupervised.

---

## Tasks-as-code — versioned plans

Instead of retyping a sequence of `striart run`, describe a **task graph** in a
YAML file committed with the code — inspired by Bruno (API collections as text
files co-located with the repo): you diff it, review it in a PR, replay it.

```yaml
# auth-rework.yaml
version: 1
tasks:
  - id: schema
    prompt: |
      Add a jwt_version column to the users table.
  - id: auth
    prompt: Move authentication to JWT.
    after: schema          # SEMANTIC dependency (no file collision would infer it)
  - id: tests
    prompt: Add tests for the JWT flow.
    after: auth
    autonomous: true       # Striart drives the tool
    profile: claude
```

```bash
striart plan auth-rework.yaml --dry-run   # validate and print, launch nothing
striart plan auth-rework.yaml             # apply
```

`apply` is **exactly equivalent** to the sequence of `striart run` it
describes, with plan `id`s resolved to agent names for `after`: no new
semantics, it composes the queue, `--after` and `reconcile`. Two design
guardrails:

- **A plan is data, never code** — no executable file: a plan travels (commit,
  PR, sharing), and executing it would be the config-as-code hole. The prompt
  stays data; an autonomous task references a **profile** (admin-defined in
  config), never a raw shell command.
- **`after` can only reference a task defined earlier** in the file — a simple
  rule that makes the graph acyclic by construction. Full validation happens
  **before** any application: an invalid plan applies no task.

Full commented example: [`examples/plan.example.yaml`](examples/plan.example.yaml).

---

## IDE and agent integration — MCP server

Striart exposes itself as an **MCP server** (Model Context Protocol): Claude
Code, Cursor, and any MCP host can drive the orchestrator — the agent becomes
a *client* of Striart instead of bypassing it.

```bash
# Claude Code, inside the target repo:
claude mcp add striart -- striart mcp
```

Five tools, mapped directly onto the orchestrator (same locks, same
safeguards as the CLI and the dashboard): `striart_status`, `striart_queue`
(read), `striart_run`, `striart_merge`, `striart_resolve` (mutating).

**Orchestration depth is capped at 1**: an autonomous session carries an
environment marker inherited by its descendants, and mutating tools are
refused to it with the reason. An agent can inspect state; it can neither
spawn agents nor merge — without this cap, `striart_run` → agent →
`striart_run` would recurse without bound, each level burning tokens
unsupervised.

In MCP mode, logs go to stderr: stdout is reserved for the protocol.

---

## Configuration (`striart.config.mjs`, `.striartrc.json`, …)

Everything has a sensible default — the minimal config is three lines:

```js
export default {
  testCommand: 'npm test',   // the Test Gate command — the one truly load-bearing setting
  targetBranch: 'main',      // branch to merge into
};
```

<details>
<summary><strong>Full commented reference</strong> — every option and its default (click to expand)</summary>

```js
export default {
  testCommand: 'npm test',        // Test Gate: 'yarn test', 'make test', 'pytest'...
  targetBranch: 'main',           // branch to merge/push into
  // Staging → main pipeline (optional): agents merge into targetBranch
  // (e.g. 'striart/staging') and `striart promote` fast-forwards mainBranch
  // after a global Test Gate — main is never in an intermediate state,
  // not even for a millisecond.
  mainBranch: null,               // e.g. 'main' (null = promotion disabled)
  promoteTestCommand: null,       // global integration gate (null → testCommand)
  autoPush: false,                // true → push origin after every green merge
  autoRebase: true,               // rebase agents onto main before merging
  autoStash: true,                // auto-stash during rebase if in-progress work
                                  // is disjoint from incoming commits (verified)
  semanticMerge: true,            // LLM conflict merging
  semanticGateRetries: 1,         // Merger retries with the gate log as feedback
  secretPatterns: ['.env', '.env.*', '*.pem', '*.key', 'credentials.json'],
                                  // TRACKED secrets removed from clone worktrees ([] = off)
  memoryLayer: false,             // shared semantic memory between agents (LLM summary per merge)
  memoryMaxEntries: 30,           // max size of .striart/memory.md (most recent entries)
  presenceMinutes: 10,            // a clone whose disk changed less than N minutes ago
                                  // is considered busy: striart clean skips it (golden rule #3)
  agentCommand: null,             // tool shown after start/run — null → 'claude' as an example
                                  // (overridable per agent via --command)

  // Autonomous mode: how to launch each tool WITHOUT human interaction.
  // {{prompt}} is substituted as an argv element (never through a shell).
  // Declaring a profile ADDS a vendor without erasing the built-in ones.
  // `striart profiles` lists configured profiles (tool, env, timeout).
  agentProfiles: {
    claude: { command: 'claude', args: ['-p', '{{prompt}}'] },
    codex:  { command: 'codex',  args: ['exec', '{{prompt}}'] },
    aider:  { command: 'aider',  args: ['--yes', '--message', '{{prompt}}'] },
    ollama: { command: 'ollama', args: ['run', 'qwen2.5-coder', '{{prompt}}'] },
    // Optional per-profile fields — for real multi-AI use:
    //   env     : variables OWN to this profile, merged over the environment
    //             (scope one key per tool, set MODEL…). From a .mjs, reference
    //             a secret without inlining it:
    //             env: { OPENAI_API_KEY: process.env.MY_OPENAI }
    //   timeout : max session duration (ms) — precedence:
    //             --timeout > profile.timeout > autonomousTimeoutMs
    //   acp     : ACP transport (Agent Client Protocol) — Striart talks to
    //             the tool over stdio JSON-RPC instead of argv. `true` or
    //             { permissions: 'allow' | 'reject' | 'ask', askTimeoutMs? }.
    //             'ask' = SEMI-AUTONOMOUS: each permission is arbitrated by
    //             the human on the dashboard, fail closed on timeout (120 s
    //             default). With acp, args must NOT contain {{prompt}} (the
    //             prompt goes via the protocol).
    // codex: { command: 'codex', args: ['exec', '{{prompt}}'],
    //          env: { OPENAI_API_KEY: process.env.MY_OPENAI }, timeout: 1800000 },
    // 'claude-acp': { command: 'claude-agent-acp', args: [], acp: true },
  },
  autonomousTimeoutMs: 1800000,   // max duration of an autonomous session (process tree killed beyond)
  webhookUrl: null,               // historical single channel (type guessed from the URL)
  // Multi-channel table — adds to webhookUrl. The type is explicit
  // (slack → {text}, discord → {content}, generic → {message}); the URL comes
  // from `url` or `urlEnv` (env var name — preferable, a webhook URL is a
  // secret), never both.
  notifiers: [],                  // e.g. [{ type: 'slack', urlEnv: 'SLACK_WEBHOOK_URL' }]
  dashboardPort: 3456,
  testTimeoutMs: 600000,          // max duration of the Test Gate (process tree killed beyond)
  fetchIntervalMs: 20000,         // silent fetch of watch (0 = disabled)
  cloneFilter: null,              // 'blob:none': partial clone for very large histories
  pruneDays: 14,                  // striart prune retention (stopped clones, resolved tickets)

  // Router/Merger LLM — local Ollama by default:
  ollamaModel: 'llama3.1:8b',
  ollamaHost: 'http://localhost:11434',
  // Router/Merger prompts, fully overridable (null → default) — e.g. rewrite
  // them in English for a local model that is more reliable in English.
  // REQUIRED placeholders (validated at load): router {{task}}+{{files}};
  // merger {{file}}+{{base}}+{{ours}}+{{theirs}}+{{feedback}} (post-gate retry).
  prompts: { router: null, merger: null },
  // ...or any provider:
  // llm: { provider: 'openai', model: 'gpt-4o-mini' },                       // key via OPENAI_API_KEY
  // llm: { provider: 'anthropic', model: 'claude-haiku-4-5-20251001' },      // key via ANTHROPIC_API_KEY
  // llm: { provider: 'azure', model: '<deployment>', baseUrl: 'https://<resource>.openai.azure.com' },
  // llm: { provider: 'openai', model: 'x', baseUrl: 'http://localhost:1234/v1' }, // LM Studio, vLLM, llama.cpp...
};
```

</details>

**Every provider on the market is supported** — natively (`ollama`,
`openai`, `anthropic`, `azure`) or through their OpenAI-compatible endpoint:
Gemini, Mistral, Groq, DeepSeek, xAI, Together, Fireworks, OpenRouter,
Perplexity, Cohere, and on-premise LM Studio, vLLM, llama.cpp, TGI.
AWS Bedrock and Google Vertex (SigV4/OAuth auth) go through a LiteLLM proxy.
**[.env.example](.env.example)** documents the exact config for each.

API keys are **never** in the config: only the name of an environment variable (`apiKeyEnv`), loaded from the shell or a `.env`.

---

## Large projects

Isolation through real clones costs disk — here is how to keep it in check:

- **History is already almost free**: the clone is made by local path, and git
  hardlinks `.git/objects` (immutable objects → safe even if the main repo
  runs a `gc`). Only the worktree is a real copy — that's the price of
  isolation, incompressible without risk.
- **Very large histories**: `cloneFilter: 'blob:none'` in the config — old
  blobs are fetched on demand from the main repo (kept as a fetch-only
  remote, push neutralized).
- **`node_modules`**: use **pnpm** in the target project (global store shared
  through hardlinks, managed by a tool designed for it). Never share
  `node_modules` between agents via symlink: tooling caches
  (`node_modules/.cache`, Vite, webpack) write to it constantly.
- **Monitoring and cleanup**: `striart status` and the dashboard show each
  clone's additional size (hardlinks count as 0);
  `striart clean` removes stopped agents' clones, and
  `striart prune` applies retention (stopped inactive clones and tickets
  resolved more than `pruneDays` days ago — `--dry-run` to preview).
  A periodic `striart prune` (cron/scheduled task) keeps `.striart/` healthy.

---

## Golden rules

1. **Never push from an agent.** Clones are islands with no remote; only the orchestrator pushes.
2. **Never commit without a green Test Gate.** Even if the merging LLM is "sure of itself".
3. **Never delete a clone while an agent is working.** `striart stop` keeps the clone, and `striart clean` refuses at two levels, depending on what it knows: `IN_USE` when the clone's disk changed recently (`presenceMinutes`) — a heuristic, which `--force` can therefore knowingly override; `SESSION_LIVE` when an autonomous session's PID is alive — a verified fact, which **`--force` cannot override**. Uncommitted or unmerged work (`PENDING`, `BUSY`) also protects the clone.
4. **Mandatory human fallback.** 3 failed semantic merges in a row → manual mode until `striart resolve --unlock`. Each failure produces a complete ticket in `.striart/conflicts/` (BASE/OURS/THEIRS versions, LLM attempt, Test Gate log).

---

## Development

**422 tests** (244 unit + 178 integration on real Git repos), `tsc` typecheck
over all the code (native TS + JSDoc-annotated JS), zero build step — `bin`
points at the source.

```bash
npm install
npm run test:unit        # 244 tests, ~20 s — the dev loop
npm run test:integration # 178 tests, ~7 min — real temporary Git repos
npm test                 # both
npm run lint             # ESLint (correctness) + Prettier --check
npm run test:ci          # typecheck + everything + coverage
```

See [CONTRIBUTING.md](CONTRIBUTING.md) and [SECURITY.md](SECURITY.md).

MIT license.

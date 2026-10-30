# Plans — tasks-as-code

> [Documentation](README.md) · Plans

Instead of retyping a sequence of `striart run`, describe a **task graph** in
a YAML file committed with the code — inspired by Bruno (API collections as
text files co-located with the repo): you diff it, review it in a PR, replay
it.

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

## Semantics

`apply` is **exactly equivalent** to the sequence of `striart run` it
describes, with plan `id`s resolved to agent names for `after`: no new
semantics, it composes the queue, `--after` and `reconcile`.

Task fields:

| Field | Role |
|---|---|
| `id` | **Plan-local** alias, target of an `after` — resolved to the real agent name at apply time, never used as the name itself. |
| `agent` | Agent name (optional, derived from the prompt if absent). |
| `prompt` | The task's prompt (scalar or YAML literal block). **Data**, never interpreted. |
| `after` | Reference to a task **defined earlier** in the file. The task waits in the queue until the referenced work finishes (merge + stop). |
| `autonomous` | `true` → Striart drives the tool ([autonomous mode](execution-modes.md)). |
| `profile` | The `agentProfiles` profile to use for an autonomous task. |
| `command` | Coding tool for a supervised task (equivalent to `--command`). |
| `timeout` | With `autonomous`: max session duration in ms, 1000 to 2147483647 (takes precedence over `autonomousTimeoutMs`). |

## `version: 2` plans — orchestration modes

`version: 2` is a **distinct format**, not a silent extension of v1: an
earlier Striart refuses it (`UNSUPPORTED_VERSION`, fail closed) instead of
applying a `mode: review` task with no review, and v1 keeps exactly its
semantics (queue, `--after`, non-blocking). v2 uses **positive validation**:
every unknown key is refused (`PLAN_INVALID`, stable `details.reason`), so is
every out-of-list value, and everything is validated **before** any side
effect, `--dry-run` included — the profiles named must exist in the config.

```yaml
# review-auth.yaml
version: 2
mode: sequential          # sequential (default) | parallel
onFailure: stop           # stop (default) | skip-dependents
tasks:
  - id: schema
    prompt: Add a jwt_version column to the users table.
    autonomous: true
    profile: claude
  - id: auth
    mode: review          # an author, reviewers, merge after approval THEN Test Gate
    prompt: Move authentication to JWT.
    after: schema
    author: { profile: claude }
    reviewers:
      - { name: security, profile: codex }
      - { name: human-eye, human: true }  # verdict through `striart review`
    quorum: all           # all | any | majority
    maxRounds: 3
  - id: perf
    mode: race            # best-of-n
    prompt: Speed up the parser.
    candidates: [{ profile: claude }, { profile: codex }]
    pick: smallest-diff   # first-green | smallest-diff | judge
    losers: archive       # keep | archive | clean
  - id: api
    mode: team            # several roles in the same clone
    prompt: A tested sum API.
    cadence: parallel     # turns | parallel (static partition)
    roles:
      - { name: backend, profile: claude, files: ['src/**'] }
      - { name: tests,   profile: codex,  files: ['tests/**'] }
  - id: delivery
    mode: pipeline        # ordered steps, each feeding the next
    after: [auth, api]    # `after` accepts a list (fan-in)
    handoff: merge        # merge | clone
    steps:
      - { id: schema, prompt: Design the schema, profile: claude }
      - { id: impl,   prompt: Implement the API, profile: codex }
```

**Plan level**: `mode` — `sequential` (default: each task implicitly depends
on the previous one; a *supervised* task is **awaited** until its agent leaves
the registry) or `parallel` (dependency graph, `concurrency` bounded by
`orchestration.maxConcurrency`); `concurrency`; `onFailure`. `striart plan
--mode`, `--concurrency` and `--on-failure` override them at application.

A `version: 2` application is **persisted** as a run (`.striart/orchestration/runs/<id>.json`,
observability only) as it progresses. If it is interrupted (crash, `Ctrl+C`,
process killed) before every task reached a terminal status, `striart plan
<file> --resume <run-id>` (the id is printed on interruption, and listed by
`striart status --json` under `orchestration.runs`) replays the **same plan
file** without rerunning tasks that already finished — a task skipped only
because of the interruption itself (never a real decision) is retried, not
left skipped forever. `--resume` requires the exact plan file that produced
the run (same tasks, same order) and refuses a run still owned by a live
process, or a `version: 1` plan (no run state exists for it).
**Task level**: `id`, `mode` (`task` by default, `review`, `race`, `team`,
`pipeline`), `agent`, `after` (an id or a list; an id defined earlier, or a
runtime reference — a live agent or task, awaited with a bounded timeout),
`resources` (any node kind — see below).

### Non-Git resources (deterministic scheduling)

`resources`: an optional list of up to 10 distinct, opaque names (at most 80
characters each — `db`, `port:5432`, `s3:uploads`, anything meaningful to
you; Striart never interprets them as a path or a command). Two nodes that
declare the **same** name never run at the same time, even with no `after`
between them, no collision predicted by the Router, and even in `parallel`
mode with a `concurrency` that would otherwise let them overlap. A conflict
only *delays* a node's launch (checked again on every scheduler tick); it is
never a failure and never a `SKIPPED` status — the node runs as soon as the
resource frees up. This is the deterministic guarantee the design in
[run-manager-design.md](run-manager-design.md) calls for: whatever the
Router predicts (or misses), a shared external resource (a database, a
port, a locked file, an external service) is never touched by two nodes at
once.

| Mode | Specific fields | Bounds |
|---|---|---|
| `task` | `prompt`, `autonomous`, `profile`, `command`, `timeout` | as in v1 |
| `review` | `prompt`, `author` (`profile`, `timeout`), `reviewers` (`name`, `profile`, `timeout`, `prompt`, `human`), `quorum`, `maxRounds` | 1 to 5 reviewers; a human reviewer has neither `profile` nor `timeout` |
| `race` | `prompt`, `candidates` (`profile`, `timeout`), `pick`, `losers` | 2 to 10 candidates |
| `team` | `prompt`, `cadence`, `rounds`, `roles` (`name`, `profile`, `timeout`, `prompt`, `files`) | 2 to 8 roles; in `parallel`, `files` is mandatory per role; `cadence: dynamic` refused (`CADENCE_UNAVAILABLE`) |
| `pipeline` | `handoff`, `steps` (`id`, `prompt`, `profile`, `timeout`) | 2 to 10 steps; no task-level `prompt` |

### Evidence bundle

Every node result (`result.nodes[i]`, also persisted in the run — see above)
carries an `evidence` bundle: what was actually produced and checked, built
from data the core already measured — never recomputed, never declared by
the agent itself.

| Field | Comes from |
|---|---|
| `objective` | The node's own prompt (`null` for `pipeline`: each step has its own) |
| `commit` | `{sha, mergeSha, alreadyMerged?}` of the merge that actually landed, or `null` if nothing merged |
| `gate` | The Test Gate that ran for that merge (`success`, `exitCode`, `timedOut`, `log`) — present even when the gate failed (`GATE_FAILED`/`MERGE_BLOCKED`): the log is the evidence of *why*, never withheld behind a null commit |
| `semantic` | Whether a semantic (LLM) merge was used instead of an ordinary Git merge |
| `resolvedFiles` | Files touched by a manual conflict resolution (empty outside a conflict) |
| `verdicts` | Review verdicts already collected for this node (`review`, `team`) — the same array as `result.verdicts` |
| `kept` | Work kept for human review instead of discarded (same as `result.kept`) |
| `usage` | Tokens/cost known for the node's agent (`src/tokens/ledger.ts`, `currentTotals`) — a lifetime total for that agent, not isolated to this one node (no finer boundary exists yet); `null` if the node never had an agent |

A node that never ran (dependency failed, interruption, a Router collision
before any launch) carries no `evidence` at all — absence here means "never
started", not "started and said nothing".

### Observability chain

Alongside `evidence`, a node result also carries `attempt` (how many times
it was actually launched — greater than 1 only for an autonomous task
retried after a Router collision) and, for a simple autonomous task,
`sessionLogPath` (the on-disk log of the session that produced the result,
under `.striart/logs/` — survives the clone's removal). Together with the
run's own `id` and `resumeCount` (how many times `--resume` actually
reopened it), this is the chain `run_id → task_id → attempt →
agent/session → commit_sha` the design in
[run-manager-design.md](run-manager-design.md) calls for.

`striart trace <run-id>` renders that chain for one run; `striart trace`
with no id renders the aggregate report (merged-task rate, the share of
nodes kept for a human decision, how many runs were actually resumed,
average cost per merged task) over the runs retained by
`orchestration.keepRuns` — see [Commands](commands.md).

Role and reviewer names use lowercase letters, digits and dashes (`author`
and `striart` are reserved). A derived agent name (`<agent>-<step>`,
`<agent>-<n>`) must stay a valid name: `agent` is limited to 30 characters for
`pipeline` and `race`.

**Router collision** on an orchestrated task: `orchestration.collisionPolicy`
is `wait` (default — the task waits, bounded by `waitTimeoutMs`, for the
colliding agents to leave then passes the Router again; fail closed
`WAIT_TIMEOUT`) or `fail`. Autonomous mode is therefore no longer lost in the
queue as in v1. Same path from the command line:
[`striart orchestrate`](commands.md#striart-orchestrate-mode-prompts). The
behavior of each mode, the collaboration channel and the session invariants
are described in
[Execution modes](execution-modes.md#the-orchestration-modes); the settings in
[Configuration](configuration.md#orchestration-and-collab--orchestration-modes-collaboration).

## Two design guardrails

- **A plan is data, never code** — no executable file: a plan travels
  (commit, PR, sharing), and executing it would be the config-as-code hole.
  The prompt stays data; an autonomous task references a **profile**
  (admin-defined in the config), never a raw shell command.
- **`after` can only reference a task defined earlier** in the file — a
  simple rule that makes the graph acyclic by construction. Full validation
  happens **before** any application: an invalid plan applies no task. The
  `PLAN_INVALID` refusal names the faulty task (position, `id`) and field; in
  `--json`, `error.details.reason` gives the cause as a stable sub-code
  (`PROMPT_MISSING`, `AFTER_FORWARD`, `DUPLICATE_ID`… — list in
  [Commands](commands.md#machine-output---json)). A plan with no `version:`
  line gives `VERSION_MISSING` (expected: `version: 1` or `version: 2`), a plan
  of any other version `UNSUPPORTED_VERSION`.

Full commented example:
[`examples/plan.example.yaml`](../../examples/plan.example.yaml).

## Interrupting a plan

A plan is not a transaction: each task goes through its own
`runTask`/`runAutonomousTask`. Ctrl+C (or SIGTERM) during application
therefore stops **cleanly**: the running autonomous session receives the
signal and stops like `run --autonomous` (agent tree killed, PID
unpublished, clone kept), and **no further task starts**. Tasks already
applied stay applied; those not started are listed (`notApplied` in
`--json`, "not applied (stop requested)" on screen) — nothing is lost
silently. To resume, rerun the plan without the tasks already done. The CLI
exits with 130 (143 for SIGTERM) and the `--json` document returns
`ok: false`: an interrupted plan did not reach its intent, even if the tasks
that ran succeeded.

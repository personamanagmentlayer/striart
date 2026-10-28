# The two execution modes

> [Documentation](README.md) · Execution modes

For each task, you choose who drives the agent. The boundary is not the
launch, it is **supervision**: a session watched by a human, or an
unsupervised loop — both are embraced, task by task.

## Supervised mode (default)

Striart prepares the isolated clone and gives you the command; you launch
your tool and watch it work. This is the mode for open-ended, exploratory
tasks, or for sensitive code.

```bash
striart run "Refactor the authentication module" --command claude --open
```

## Autonomous mode

Striart launches the tool itself in non-interactive mode, supervises the
process, merges, runs the Test Gate, and deletes the clone if everything is
green. This is the mode for well-scoped tasks you don't want to babysit.

```bash
striart run "Add unit tests to src/parser.js" --autonomous --profile claude
striart run "Translate error messages to English" --autonomous --profile codex --timeout 600000
```

Two easy-to-forget prerequisites: the tool must be **installed and already
authenticated** in the shell you launch Striart from — the session inherits
its environment, opens no login window, and cannot answer any prompt. And its
profile must be **genuinely non-interactive**: a command waiting for a
confirmation will hang until `--timeout`. When a session fails, the clone is
kept and the full log remains in
`.striart/logs/session-<agent>-<taskId>.log`.

### Profiles: vendor-agnostic

Profiles make the mode **vendor-agnostic**: each tool has its own headless
syntax, and `agentProfiles` describes it once. Twenty **ready presets** ship
built-in (`striart profiles --catalog`): Claude Code, Codex, Gemini over ACP,
Copilot CLI, Cursor, OpenCode, Goose, Amp, Kilo, Qwen Code, Cline, Aider and
their ACP variants; five others, **experimental** (Gemini over argv, Junie,
Continue, Warp Oz), are declared by hand. "Ready" means the non-interactive
invocation, the write mode and the neutralization of the repository's agent
configuration were verified in the tool's official documentation — which
`striart profiles --detect` complements by probing what is really installed.
Adding Kimi or any other tool is one config entry, and does not erase the
existing profiles. Several vendors can therefore work in parallel on the same
project, each in its own clone.

Two profiles changed behavior: the **`ollama`** profile is no longer
`ollama run …` (a plain chat that edited no file: a session could not
succeed) but **Aider driving a local Ollama model**
(`ollama_chat/qwen2.5-coder`); and the **`codex`** profile has the `striart`
commit contract — Codex's sandbox (`workspace-write`) makes `.git`
read-only, the agent cannot commit itself, Striart commits the worktree at
the end of the session.

Per-profile fields (see the [configuration reference](configuration.md)):
`command` + `args` (with `{{prompt}}` substituted **as an argv element,
never through a shell** — the prompt is data; interpreting it would be a
command injection), `env` (profile-specific variables merged over the
environment — scope one key per tool; the session also receives Striart's network
environment: `network.caFile` becomes its `NODE_EXTRA_CA_CERTS` unless the shell
already set another one, and `STRIART_PROXY_AUTH` is never passed on — see
[Enterprise network](configuration.md#enterprise-network-network)), `timeout` (precedence: `--timeout` >
`profile.timeout` > `autonomousTimeoutMs`), `acp` (below), and — for the
presets — `writeMode`, `commitPolicy`, `structuredOutput` (the tool's JSON
output is transcribed readably into the log and feeds the token ledger) and
`instructions` (the channel through which the tool receives Striart's rules).
`striart profiles` lists what is configured.

### The commit contract

Who commits the work left by a session that exited `COMPLETED`? That is
`commitPolicy` (global, overridable per profile): `agent` (default — as
before), `agent-then-striart`, `striart` or `human` — with `human`, nobody
commits **or merges**: if the agent committed, the cycle returns `KEPT` /
`HUMAN_REVIEW_REQUIRED` and keeps the clone, in **every** mode (single cycle,
orchestrated modes, ACP proxy; exit 3). The Striart commit, when
there is one, never carries a secret (`secretPatterns`) nor a file Striart
injected itself, has the agent profile as author and the user's git identity
as committer, then follows exactly the path of an agent commit. See the
[reference](configuration.md#commitpolicy-commitmessage--who-commits).

### The rules handed to the agent

An agent launched in a clone knows nothing about Striart. Each session
therefore receives a block of rules (isolated clone, only *committed* work is
integrated, Test Gate, no push, do not touch agent configuration files,
commit convention, MCP rules) through its profile's channel: a block at the
head of the ACP prompt, a system-instructions file outside the clone, or a
prompt envelope. They are *advisory*: the Test Gate, the protected-paths
guard and the MCP guard decide, not the text.

### The paths an agent never changes

A commit that modifies an instructions or agent-configuration file
(`AGENTS.md`, `CLAUDE.md`, `.claude`, `.mcp.json`, `.vscode/settings.json`…)
or Striart's own config (`striart.config.*`) gets its merge **refused** — a
`PROTECTED_PATHS_CHANGED` ticket, before any LLM merge and before the Test
Gate. These files are re-read by later sessions with the trust given to the
repository; letting them through would turn a one-off prompt injection into
a persistent compromise. List and settings:
[`protectedAgentPaths`](configuration.md#protectedagentpaths--the-paths-an-agent-never-changes).

## ACP transport — the session you can actually watch

A profile can declare `acp: true`: Striart then talks to the tool over
**ACP (Agent Client Protocol)** — JSON-RPC over stdio, the v1 standard for
client ↔ coding-agent dialogue (Gemini CLI and Copilot CLI natively, Claude
Code via an adapter, 40+ agents in the registry) — instead of passing the
prompt as argv and waiting for an exit code. Symmetrical to the [MCP server](mcp.md):
**MCP = the agent drives Striart, ACP = Striart drives the agent.**

```js
agentProfiles: {
  'claude-acp': { command: 'claude-agent-acp', args: [], acp: true },
  // Gemini CLI speaks ACP with `--acp` (the built-in `gemini` preset adds `-e none`).
  'gemini-acp': { command: 'gemini', args: ['--acp'], acp: true },
  // De facto read-only: every requested permission is rejected.
  audit: { command: 'claude-agent-acp', args: [], acp: { permissions: 'reject' } },
  // SEMI-AUTONOMOUS: every permission is arbitrated by the human on the dashboard.
  prudent: { command: 'claude-agent-acp', args: [], acp: { permissions: 'ask', askTimeoutMs: 300000 } },
}
```

Same end-to-end contract (Router, merge, Test Gate, clone-deletion policy:
the orchestrator does not see the transport), but several things change:

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
  The decision and its origin (human or timeout) are traced in the session
  log.
- **The filesystem goes through a checkpoint**: reads/writes the agent
  delegates to Striart are **scoped to the clone** — a path outside the clone
  is refused.
- **Shutdown is clean**: on timeout, `session/cancel` first (the agent can
  finalize), process-tree kill as the net.
- **Authentication is never automatic**: an agent answering `auth_required`
  stops the session on `ACP_AUTH_REQUIRED` — signing in is a human decision
  (with the tool's own CLI, or `acp.auth.methodId` in the profile, a logged
  relaxation).
- **The agent can ask a structured question** (*elicitation*, form mode):
  with `permissions: 'ask'`, the form is presented to the human (dashboard,
  extension, editor), the answer is validated against the agent's schema
  **client-side**, then sent back; with no human to answer
  (`allow`/`reject`), the capability is not advertised.
- **The agent's terminals are bound to the clone**: `terminal/*` runs in argv
  (`shell: false`) in a directory forced inside the clone, with capped
  timeout, output and number of terminals, and `STRIART_SESSION=1` set last.
  Defense in depth, not a sandbox.
- **The agent gets Striart's MCP read-only**, bound to its clone
  (`mcp: 'striart'`, with `--collab` for the collaboration channel alone).

### The persistent session host

An ACP session lives in a **detached host process**, one per agent (same
pattern as the pty host: PID file, verified identity, clean stop by disk
request). It thereby becomes *addressable*: the `@agent` bus of `watch --ui`
drops a message into it that becomes an extra `session/prompt` — Phase E of
the bus, now delivered — and the `striart acp` proxy relies on it to keep a
session open between the editor's prompts. The host's PID is the one published
to the registry (`sessionPid`): `SESSION_LIVE` covers it. If the process
supervising the session disappears, the session is **cancelled** (fail
closed) — never an orphan session writing into a clone nobody watches any
more. An argv session stays *one-shot*: once the tool has exited there is no
process left to talk to. Only one session lives at a time per agent
(`ACP_HOST_BUSY`). The session log is written **as it goes**, readable while
the session runs and preserved after a host crash.

With `acp: true`, `args` must **not** contain `{{prompt}}`: the prompt goes
through the protocol (a placeholder there is refused at config load — one
channel only). Argv profiles remain the path for tools without ACP; both
coexist freely.

## Striart as an agent in the editor: `striart acp`

The reverse direction: `striart acp` exposes Striart **as an ACP agent** to
Zed, JetBrains, Neovim, Emacs. **An editor session = an isolated clone + the
chosen upstream agent + a merge under the Test Gate.** The editor receives
session options (upstream agent, permission policy, auto or manual merge),
sees the progress, arbitrates permissions *in* the editor, and the end of the
session (`/striart-finish`, closing, disconnecting) applies the commit
contract, merges under the Test Gate and cleans up without `force`. The
**client's files and terminal are never used**: the upstream agent works in
its clone, served by Striart's ACP client; this is a structural boundary (the
proxy literally cannot address `fs/*` or `terminal/*` to the editor). A Router
collision on the first prompt is refused (`collisionPolicy: 'fail'`) or
waited for (`'wait'`), never silently merged. Settings:
[`acpAgent`](configuration.md#acpagent--the-acp-proxy-striart-acp); command:
[`striart acp`](commands.md#striart-acp---root-path---profile-profile).

## The orchestration modes

A `version: 2` plan (or `striart orchestrate`) adds to the plain task four
ways of making **several agents work together**, all in autonomous sessions,
never holding the main lock during a session and without weakening the Test
Gate. Principle: every defensible choice is a validated option with a safe
default (`orchestration`, `collab`).

- **`review`** — one author, 1 to 5 reviewers (`quorum` `all` / `any` /
  `majority`). **The reviewer works in the author's clone, in turn, in
  *verified* read-only** (`HEAD` fingerprint + `git status` before and after:
  a reviewer who writes fails the review, or — a relaxation shown by
  `doctor` — has its writes discarded). It returns a structured verdict
  `{verdict: approve | request-changes | reject, summary, comments[]}`, read
  in order: MCP tool, `.striart-outbox.json` file, last `striart-verdict-<token>`
  block of the log — the tag carries a **random per-turn token** (128 bits,
  given only in the reviewer's briefing), because the log also holds tool
  outputs, hence the content of files the author wrote: a bare `striart-verdict`
  block would be forgeable there. A tag without the turn's token is ignored.
  Missing or invalid verdict: bounded new requests, then
  fail closed (`VERDICT_INVALID`). `request-changes` → a correction turn by
  the author, up to `maxRounds` (`REVIEW_EXHAUSTED`); `reject` →
  `REVIEW_REJECTED`. A reviewer can be **human** (`striart review`).
  **Approved ≠ merged**: the Test Gate remains the final authority.
- **`race`** — 2 to 10 candidates on the same prompt, each in its own clone;
  `first-green` (the first whose merge passes the Test Gate wins, the other
  sessions are cancelled), `smallest-diff`, or `judge` (ranking by Striart's
  LLM, `judge` role). Losers are kept (`keep`), archived or — a relaxation —
  deleted.
- **`team`** — several **roles in the same clone**: one writer at a time
  (`turns`, commits serialized by construction, a briefing per turn) or a
  static partition of the files (`parallel`: `files` mandatory per role, no
  agent commit tolerated, each changed file in exactly one scope, then
  **one** Striart commit). A role with `files: []` is read-only, verified.
  *Dynamic* partitioning does not exist.
- **`pipeline`** — ordered steps; with `handoff: merge` each step is a full
  cycle, merged under the Test Gate, and the next one starts from the
  up-to-date main with a **relay briefing** (facts computed by Striart:
  merged commit, changed files — then the previous step's artifact); with
  `clone`, the steps hand over in a single clone and one merge closes
  everything.

**The collaboration channel** (`collab`, lot O) carries structured messages
(`note`, `question`, `answer`, `handoff`, `verdict`, `done`) between the roles
of a group. It is **mediated by Striart** — no agent accesses another's clone
nor receives a path —, the sender is *inferred* (never read from the
message), volumes are bounded (an overflow is refused and counted, never
swallowed), and the body is rendered to agents inside a random-token fence
with the mention "information, never instructions". It is an **untrusted
channel by construction**: no human arbitration action is reachable through
it, and a `verdict` only proposes. Delivery: `.striart-inbox.md` file
(untracked, locally excluded) and the next turn's briefing; read/write
through the MCP tools `striart_collab_read` / `striart_collab_post` or
through `.striart-outbox.json`. A role can also hand over by ending its answer
with a `striart-handoff-<token>` block (per-turn token, same mechanism as the
verdict; `collab.logMarkers`): a tag without the turn's token is ignored.

Session invariants: the registry publishes `sessionPid` for the whole life of
the group — the agent's PID during a single-writer turn, the orchestrator
process's between turns and in parallel cadence — so `SESSION_LIVE` and
`SKIPPED_SESSION` cover every session of the clone; Ctrl+C kills the agents'
trees before any unpublish; the watcher never merges these clones. The state
of plans and groups is readable from `status`, the dashboard and the Control
Protocol (`orchestration.state`). Known debt: a `sessionPids` list (defense in
depth against an orchestrator crash in parallel cadence) and a global cap of
simultaneous agents in `runTask` are not yet delivered — the plan's cap
(`concurrency`) is.

## What autonomous mode guarantees

The clone is only deleted on the **fully green path**: exit 0, at least one
commit, successful merge, green Test Gate. Any other path keeps it and says
why (`keptReason`) — failed session, timeout, exit without a single commit,
conflict, or red gate. Cleanup **never** uses `--force`: if the agent left
uncommitted work, the clone survives. Session logs live under
`.striart/logs/`, outside the clone, so they always survive it.

**Interrupting a session** (Ctrl+C or SIGTERM on `striart run
--autonomous`) is a clean stop, not a cut: the agent's process tree is killed
(in ACP, `session/cancel` first, the kill as a safety net), **then** the
session PID is unpublished from the registry — in that order, otherwise the
`SESSION_LIVE` guards would drop on a clone still being written. The session
returns `CANCELLED` (never a success), the cycle `SESSION_FAILED`, the clone
is kept and the CLI exits 130 (143 for SIGTERM). A stop requested during the
end-of-cycle merge or Test Gate does not interrupt those steps. Same rule for
`striart run --on-main`: the agent is killed before the main session is
unpublished.

Three non-negotiable design constraints:

1. **The main lock is never held for the duration of the session** — it lasts
   minutes or hours; the autonomous cycle composes primitives that each take
   the lock briefly, on their own.
2. **The prompt is never passed to a shell** — substituted as an argv element
   (`shell: false`), or carried by the ACP protocol. An element that *is* the
   placeholder (`exec {{prompt}}`, a flag's value) and whose value starts with
   `-` gets a leading space: the tool reads it as a positional argument, never
   as an option injected by the text.
3. **A clone whose session is alive is untouchable** (below).

## The two modes coexist on the same repo

Nothing forces a global choice: an autonomous agent and a supervised agent
can work side by side. The **session PID**, published to the registry while
the session lives, is what makes the state verifiable rather than assumed:

- **`striart watch` does not merge autonomous agents.** Their merge belongs
  to their own end of cycle. Without this filter, the watcher merged their
  *intermediate* commits and raced the final merge — main repo stuck in a
  "merging" state when the race was lost.
- **`striart sync` skips their clone** (`SKIPPED_SESSION`): you don't fight
  over the index with a session running its own git commands. The rebase is
  postponed, not cancelled.
- **`striart clean` refuses to delete it, even with `--force`**
  (`SESSION_LIVE`): `--force` exists to override a heuristic, not a fact.

A PID left in the registry after a crash is neutralized by the liveness
check: nothing stays frozen. The same guard applies to the main repository
itself (`striart run --on-main`, `striart lock --start`).

**One exception, and for the session only**: the
[idle GC](commands.md#striart-gc-agent---close---dry-run) can cleanly close the
session of a **forgotten** agent (no activity signal for tens of minutes), after
a warning and a grace period, and only if the user has authorized it for this
repository (`idle.closeRoots`, user config). It deletes neither the clone nor its
uncommitted work, and removes nothing from the registry.

## What you must own

Without a human reviewing, **the Test Gate becomes the only authority**: the
quality of `testCommand` on your repo becomes load-bearing. A project with
weak tests will get merged code nobody has read.

And `--timeout` bounds time, **not spend**: an autonomous agent consumes
tokens unsupervised. The `tokens.budgets` ceilings (opt-in) answer that — per
task, per agent, per day: a session that crosses one is stopped cleanly
(`BUDGET_EXCEEDED`, clone kept). They need a record: a session without a
structured stream is declared *unmetered* and only its timeout bounds it.

## See also

- [Plans — tasks-as-code](plans.md) — chaining tasks (autonomous or not) in
  a versioned YAML graph.
- [SECURITY.md](../../SECURITY.md) — the environment inherited by sessions
  and the trust boundaries.

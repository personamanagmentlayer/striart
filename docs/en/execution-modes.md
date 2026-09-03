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
syntax, and `agentProfiles` describes it once. Claude, Codex, Aider, and
Ollama ship built-in; adding Kimi or any other tool is one config entry, and
does not erase the existing profiles. Several vendors can therefore work in
parallel on the same project, each in its own clone.

Per-profile fields (see the [configuration reference](configuration.md)):
`command` + `args` (with `{{prompt}}` substituted **as an argv element,
never through a shell** — the prompt is data; interpreting it would be a
command injection), `env` (profile-specific variables merged over the
environment — scope one key per tool), `timeout` (precedence: `--timeout` >
`profile.timeout` > `autonomousTimeoutMs`), `acp` (below).
`striart profiles` lists what is configured.

## ACP transport — the session you can actually watch

A profile can declare `acp: true`: Striart then talks to the tool over
**ACP (Agent Client Protocol)** — JSON-RPC over stdio, the v1 standard for
client ↔ coding-agent dialogue (Gemini CLI and Copilot CLI natively, Claude
Code via the official adapter, 25+ agents) — instead of passing the prompt as
argv and waiting for an exit code. Symmetrical to the [MCP server](mcp.md):
**MCP = the agent drives Striart, ACP = Striart drives the agent.**

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

With `acp: true`, `args` must **not** contain `{{prompt}}`: the prompt goes
through the protocol (a placeholder there is refused at config load — one
channel only). Argv profiles remain the path for tools without ACP; both
coexist freely.

## What autonomous mode guarantees

The clone is only deleted on the **fully green path**: exit 0, at least one
commit, successful merge, green Test Gate. Any other path keeps it and says
why (`keptReason`) — failed session, timeout, exit without a single commit,
conflict, or red gate. Cleanup **never** uses `--force`: if the agent left
uncommitted work, the clone survives. Session logs live under
`.striart/logs/`, outside the clone, so they always survive it.

Three non-negotiable design constraints:

1. **The main lock is never held for the duration of the session** — it lasts
   minutes or hours; the autonomous cycle composes primitives that each take
   the lock briefly, on their own.
2. **The prompt is never passed to a shell** — substituted as an argv element
   (`shell: false`), or carried by the ACP protocol.
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
check: nothing stays frozen.

## What you must own

Without a human reviewing, **the Test Gate becomes the only authority**: the
quality of `testCommand` on your repo becomes load-bearing. A project with
weak tests will get merged code nobody has read.

And `--timeout` bounds time, **not spend**: an autonomous agent consumes
tokens unsupervised.

## See also

- [Plans — tasks-as-code](plans.md) — chaining tasks (autonomous or not) in
  a versioned YAML graph.
- [SECURITY.md](../../SECURITY.md) — the environment inherited by sessions
  and the trust boundaries.

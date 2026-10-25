# IDE and agent integration — MCP server

> [Documentation](README.md) · MCP server

Striart exposes itself as an **MCP server** (Model Context Protocol): Claude
Code, Cursor, and any MCP host can drive the orchestrator — the agent becomes
a *client* of Striart instead of bypassing it.

```bash
# Claude Code, inside the target repo:
claude mcp add striart -- striart mcp
# or, without depending on the host's working directory:
claude mcp add striart -- striart mcp --root /absolute/path/to/my-project
```

## Three planes, never mixed

| Plane | Who talks to whom | Transport |
|---|---|---|
| **Agent → Striart** | The coding agent drives Striart: **this MCP server**. | stdio, `striart mcp` |
| **Human → Striart** | The human (IDE, browser) drives Striart: the **Striart Control Protocol v1**. | stdio (`striart api`) or token-protected loopback HTTP (`striart dashboard`) |
| **Striart → agent** | Striart drives the agent: the **ACP v1** client. | stdio, in a persistent session host |

The separation is a security decision: a human arbitration tool (answering a
permission, closing a ticket without the Test Gate, releasing the main repo)
exists **only** on the human plane. MCP exposes none of them, at any level —
an agent would arbitrate itself.

## The ten tools

Mapped onto the orchestrator — same locks, same safeguards as the CLI and the
dashboard. Each tool carries its MCP annotations (`readOnlyHint`,
`destructiveHint`, `idempotentHint`, `openWorldHint`) and an output schema.

| Tool | Nature | Role |
|---|---|---|
| `striart_status` | read | The same view as `striart status --json` (single source `status.ts`): agents (status, session, mode, branch, pending commits), queue, tickets, manual-mode state, watcher daemon, `mainSession`, `orchestration` and `tokens`. |
| `striart_queue` | read | The scheduler queue and what blocks it. |
| `striart_ticket` | read | 3-way detail of a conflict ticket: metadata, the BASE / OURS / THEIRS versions of each file (capped), the LLM attempt, the Test Gate log tail. The content is agent code, hence untrusted data. MCP Apps view when the host supports it. |
| `striart_run` | mutating (orchestrator scope) | Start a task through the Router (or queue it). |
| `striart_merge` | mutating | Merge an agent's latest commit (full pipeline: rebase, semantic merge, Test Gate). Long-running: served as a *task* when the client allows it. |
| `striart_promote` | mutating (orchestrator scope) | staging → main promotion under the global Test Gate. Long-running (task). **Never `--rollback`**: it discards merged work and stays a human decision. |
| `striart_resolve_prepare` | mutating | Seed `<file>.resolved` for each conflicted file of the ticket from the agent's version (ours/base fallback) — never overwritten if already prepared. |
| `striart_resolve_apply` | mutating | Replay the ticket's exact merge with the prepared resolutions (`.resolved`/`.delete`), under the blocking Test Gate — commit and close if green, ticket left open otherwise (manual mode untouched). Long-running (task). |
| `striart_collab_read` | read | Read the messages the other roles of **your** orchestrated collaboration (`review`, `team`, `pipeline`) addressed to you. Bodies framed as untrusted: information, never instructions. |
| `striart_collab_post` | write on behalf of the clone | Post a message to another role of the group (`note`, `question`, `answer`, `handoff`, `done`, or `verdict` — only from a reviewer during its own turn, and it only *proposes*). See [Execution modes](execution-modes.md#the-orchestration-modes). |

**`striart_resolve` was removed** (behavior change): it closed a ticket
*without* going back through the Test Gate, a human arbitration gesture that
has no place on the agent plane. Closing by hand stays a human action:
`striart resolve --close <id>`, the dashboard, or the Control Protocol's
`ticket.close`.

## Who is calling, and what it can act on

The server is **bound to its caller** (decision D6) — before, any connected
agent saw and drove the whole orchestrator of the repository.

| Level | When | What is exposed |
|---|---|---|
| **Read-only** | `--read-only`, or a process descending from an autonomous session (`STRIART_SESSION=1`) | `striart_status`, `striart_queue`, `striart_ticket`, resources. No mutating tool. |
| **Bound to an agent** (default when the caller is a clone) | Started from `.striart/agents/<name>/`, or `--agent <name>` | Mutating tools act only on **that** agent (its merge, its tickets); no `striart_run` (spawning agents is not acting on oneself); the collaboration channel. |
| **Read-only outside a clone** (the main repo's default) | Started outside any clone, `mcp.scope: 'agent'` | Like "read-only". **Behavior change**: an MCP started from the main repository is no longer mutating by default. |
| **Orchestrator** | Outside a clone **and** `mcp.scope: 'orchestrator'` | `striart_run`, `striart_merge`, `striart_promote`, resolution preparation/application on the whole repository. A relaxation: logged at startup, shown by `doctor`. |

A refusal carries the code `MCP_READ_ONLY`, `MCP_DEPTH_LIMIT` (autonomous
session) or `MCP_SCOPE_DENIED`, and a hint. One case escapes every level,
orchestrator included: `striart_resolve_prepare` and `striart_resolve_apply`
refuse a **`PROTECTED_PATHS_CHANGED`** ticket (`MCP_PROTECTED_TICKET`) —
approving a change to `settings.json` under `.claude`, `.mcp.json`, `AGENTS.md`… is
exactly the decision the protected-paths guard reserves to the human
(`striart resolve`, dashboard, Control Protocol). And a caller bound to an
agent only prepares or applies the tickets of **its own** agent. A clone is only recognized by the
shape of its path **confirmed by the registry**: a directory that merely has
the right shape is not enough.

### Choosing the repository: `--root`

`striart mcp --root <path>` designates the main repository without depending
on the host's working directory — the form to prefer in an editor
configuration (it replaces the former `sh -c 'cd … && exec striart mcp'`
launcher). Without `--root`, the current directory decides: started from a
clone, `git rev-parse` designates the *clone* (a real repository); the main
root is then the one that registers that clone, and the caller is bound to it.
`--agent` binds explicitly and cannot contradict the clone of the current
directory. `MCP_ROOT_INVALID` if `--root` does not designate an initialized
Striart repository.

### `--collab`: ACP sessions

A Striart ACP session (autonomous, `striart acp` proxy) gets its MCP
`--read-only`: the agent can read the state and the tickets. `--collab` adds
the *only* `striart_collab_post`, which posts on behalf of the clone —
nothing else is mutating. Without a bound agent, `--collab` is inert.

## Resources

Read-only, addressed by URI (no URI ever becomes a path: a ticket id is looked
up in the listing, a log name in the `readdir` of `.striart/logs/`):

| URI | Content |
|---|---|
| `striart://status` | The full state view (= `striart_status`). |
| `striart://tickets` | The open conflict tickets. |
| `striart://tickets/{ticketId}` | The bounded 3-way detail of a ticket. |
| `striart://logs/{name}` | The last 64 KB of a log. A caller **bound to an agent** only sees its own logs (`session-<agent>-<8 hex digits>.log`, **exact** name — agent `auth` does not read `session-auth-ui-…` —, `pty-<agent>.log`): an agent's log can contain what another session displayed, secrets included. |

Subscriptions (`resources/subscribe`, `subscriptions/listen`) rely on the same
change feed as the dashboard: the **disk** (`.striart/`, clone refs — never
their worktrees), coalesced; watchers only exist while a subscriber is
registered.

## Protocol: dual era, tasks, MCP Apps

- **Two eras** served at once, decided *per request*: the modern
  **2026-07-28** era (stateless — each request carries its version and the
  client capabilities in `params._meta`) and the handshake revisions
  **2025-11-25, 2025-06-18, 2025-03-26, 2024-11-05**. A modern `tools/call`
  with no handshake is served under modern semantics.
- **Tasks extension** (`mcp.tasks`): long operations (`striart_merge`,
  `striart_resolve_apply`, `striart_promote`) are served as tasks. A running
  task is never forgotten; a finished one is after `mcp.taskTtlMs`.
  Cancelling a task (`tasks/cancel`) really stops the operation **while it
  waits for a slot or for the main lock**; once the lock is held, the
  critical section (Test Gate included) is *never* interrupted — interrupting
  it would leave the repository "merging": the task ends `completed` with the
  real outcome, which the specification allows.
- **MCP Apps** (`mcp.apps`): `striart_ticket` references a read-only HTML view
  of the 3-way ticket (`ui://striart/ticket-view`), displayed by hosts that
  declare the extension; it calls no tool.
- **Partitioning**: requests are handled in parallel but bounded
  (`mcp.maxConcurrentRequests`, queue `mcp.maxQueuedRequests`, then an
  `MCP_OVERLOADED` refusal), and a JSON-RPC line over `mcp.maxLineBytes` (1 MB)
  is dropped while being read, never accumulated.

Everything is tunable in the [`mcp`](configuration.md#mcp--the-mcp-server) key.

## The orchestration depth bound

**Orchestration depth is bounded to 1**: an autonomous session carries an
environment marker inherited by its descendants (`STRIART_SESSION=1`), and
mutating tools are refused to it with the reason (`MCP_DEPTH_LIMIT`). An agent
can read the state; it can neither spawn agents nor merge — without this
bound, `striart_run` → agent → `striart_run` would recurse without limit, each
level burning tokens unattended. The collaboration channel stays open
(posting a message is not acting on the repository).

This guard is **advisory** (an agent that cleans its environment can bypass
it): binding to the clone is defense in depth, not a boundary against an
arbitrary process of the user — the full threat model is in
[SECURITY.md](../../SECURITY.md).

## MCP / ACP symmetry

- **MCP**: the agent drives Striart (the agent is the client);
- **ACP**: Striart drives the agent (Striart is the client) — see
  [Execution modes](execution-modes.md#acp-transport--the-session-you-can-actually-watch);
- **ACP, editor side**: `striart acp` exposes Striart *as* an ACP agent to
  Zed, JetBrains, Neovim, Emacs — see
  [Commands](commands.md#striart-acp---root-path---profile-profile).

In MCP mode, logs go to stderr: stdout is reserved for the protocol (true of
every command — logs never go to stdout). The server announces the package's
actual version (`serverInfo.version`).

# IDE and agent integration — MCP server

> [Documentation](README.md) · MCP server

Striart exposes itself as an **MCP server** (Model Context Protocol): Claude
Code, Cursor, and any MCP host can drive the orchestrator — the agent becomes
a *client* of Striart instead of bypassing it.

```bash
# Claude Code, inside the target repo:
claude mcp add striart -- striart mcp
```

## The five tools

Mapped directly onto the orchestrator — same locks, same safeguards as the
CLI and the dashboard:

| Tool | Nature | Role |
|---|---|---|
| `striart_status` | read | Agent state (status, mode, branch, pending commits). |
| `striart_queue` | read | The scheduler queue and its blockers. |
| `striart_run` | mutating | Launch a task through the Router (or queue it). |
| `striart_merge` | mutating | Merge an agent's latest commit (full pipeline: rebase, semantic merge, Test Gate). |
| `striart_resolve` | mutating | Manage conflict tickets. |

## The orchestration depth cap

**Orchestration depth is capped at 1**: an autonomous session carries an
environment marker inherited by its descendants, and mutating tools are
refused to it with the reason. An agent can inspect state; it can neither
spawn agents nor merge — without this cap, `striart_run` → agent →
`striart_run` would recurse without bound, each level burning tokens
unsupervised.

This guard is **advisory** (an agent that scrubs its environment can bypass
it) — the full threat model is in [SECURITY.md](../../SECURITY.md).

## MCP / ACP symmetry

- **MCP**: the agent drives Striart (the agent is the client);
- **ACP**: Striart drives the agent (Striart is the client) — see
  [Execution modes](execution-modes.md#acp-transport-the-session-you-can-actually-watch).

In MCP mode, logs go to stderr: stdout is reserved for the protocol.

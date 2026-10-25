# Zed

> [Documentation](../README.md) · [Integrations](README.md) · Zed
> 🇫🇷 [Français](../../fr/integrations/zed.md)

Zed consumes MCP servers (`context_servers`) and external ACP agents
(`agent_servers`). Striart plugs in both ways: as an MCP server, and as an
ACP agent through the `striart acp` proxy.

## MCP configuration

In `settings.json` — user (`~/.config/zed/settings.json`) or project
(`.zed/settings.json` at the root, merged on top):

```json
{
  "context_servers": {
    "striart": {
      "command": "striart",
      "args": ["mcp", "--root", "/absolute/path/to/my-project"],
      "env": {}
    }
  }
}
```

Prefer the **project** file: it ties the server to the opened repository.

**Working directory — unverified.** Zed documents neither `cwd` nor the
launch directory for a context server: `--root` (see the
[common page](README.md#choosing-the-driven-repository---root)) pins the
repository without depending on it. Check the root in the server log.

## Striart as an ACP agent: `striart acp`

Zed is an ACP client: declare Striart as an external agent, in the same
`settings.json` (the **project** `.zed/settings.json` ties the entry to the
opened repository):

```json
{
  "agent_servers": {
    "Striart": {
      "type": "custom",
      "command": "striart",
      "args": ["acp"],
      "env": {}
    }
  }
}
```

A Zed session = an isolated clone + the upstream agent you pick in the
session options + a merge under the Test Gate; Zed's files and terminal are
**never** used by the upstream agent (see
[Striart as an ACP agent](README.md#striart-as-an-acp-agent-striart-acp)).
Prerequisite: at least one configured ACP profile (`striart profiles
--detect`). `/striart-finish` ends the session. **Test on a real Zed: still
to do** (not verified here).

## External ACP agents and forwarded MCP servers

MCP servers configured in Zed "may be forwarded to External Agents over
ACP": an ACP agent (Claude Agent, Codex, Gemini…) declared in
`agent_servers` then receives Striart's tools. Documented shape of a custom
agent:

```json
{
  "agent_servers": {
    "my-agent": {
      "type": "custom",
      "command": "node",
      "args": ["~/projects/agent/index.js", "--acp"],
      "env": {}
    }
  }
}
```

ACP requires an absolute `command` for a forwarded MCP server; if an agent
rejects `striart`, declare the server with its absolute path.

## What is covered

- Striart's tools in Zed's agent and, through forwarding, in ACP agents.
  (Zed supports MCP tools and prompts, not resources; Striart exposes tools
  and `striart://…` resources, so only the tools serve here.)
- Striart itself as an ACP agent (`striart acp`, above).
- Agent profiles can enable or disable each MCP tool.

## Security

- Since Zed v0.224.0, `agent.tool_permissions.default` is `"confirm"` by
  default: every tool action, MCP included, asks for approval. Keep that
  default. MCP tools are named `mcp:<server>:<tool>` (for example
  `mcp:striart:striart_run`) and only accept a `default` setting; only set
  `mcp:striart:striart_status` and `mcp:striart:striart_queue` to
  `"allow"`. Take the exact structure of these entries from the "Tool
  permissions" page (examples not reproduced verbatim here — **to check** on
  the page).
- **Worktree trust**: once a folder is trusted, its project settings and MCP
  servers start automatically. Read `.zed/settings.json` before trusting a
  cloned repository.

## Sources (checked on 2026-10-24)

- Zed, MCP — <https://zed.dev/docs/ai/mcp>
- Zed, external agents — <https://zed.dev/docs/ai/external-agents>
- Zed, tool permissions — <https://zed.dev/docs/ai/tool-permissions>
- Zed, configuration — <https://zed.dev/docs/configuring-zed>
- ACP, `McpServer` schema — <https://agentclientprotocol.com/protocol/session-setup>

(No update date shown on these pages.)

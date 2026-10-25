# JetBrains IDEs (IntelliJ IDEA, WebStorm, PyCharm…, 2025.2+)

> [Documentation](../README.md) · [Integrations](README.md) · JetBrains
> 🇫🇷 [Français](../../fr/integrations/jetbrains.md)

Three distinct JetBrains mechanisms touch Striart:

1. **AI Assistant (and Junie)** consume MCP servers: declare `striart mcp`
   there;
2. **ACP agents** (`~/.jetbrains/acp.json`) can receive AI Assistant's MCP
   servers, hence Striart;
3. **the IDE's built-in MCP server** exposes the IDE itself to external
   agents — the other direction, with a security trap ("brave mode").

A Striart JetBrains plugin (which will speak the Control Protocol,
`striart api`) is coming, with no announced date. Meanwhile Striart plugs in
through MCP (below) **and as an ACP agent** through `striart acp`.

## AI Assistant: declaring Striart

Settings | Tools | AI Assistant | Model Context Protocol (MCP) > Add (or `/`
in the chat > Add Command). STDIO transport, in the format:

```json
{
  "mcpServers": {
    "striart": {
      "command": "striart",
      "args": ["mcp"]
    }
  }
}
```

The dialog has a **Working directory** field ("the folder from which the
server is launched") separate from the JSON: **set it to the target
repository's root**. The server level (global or project) is chosen in the
same dialog — a global server with a fixed directory always drives the same
repository; prefer the project level.

## Junie

- Project: `.junie/mcp/mcp.json`; user: `~/.junie/mcp/mcp.json` (Junie CLI
  docs; an older blog post cites `~/.junie/mcp.json`).
- Same `mcpServers` format (`command`, `args`, `env`). In the plugin: Tools |
  Junie | MCP Settings | Add.
- **Working directory — unverified**: no `cwd` field documented; open the
  repository as the project, or pass `--root` (see the
  [common page](README.md#choosing-the-driven-repository---root)).

## ACP agents (`acp.json`)

"Add Custom Agent" creates `~/.jetbrains/acp.json`:

```json
{
  "default_mcp_settings": {
    "use_custom_mcp": true,
    "use_idea_mcp": false
  },
  "agent_servers": {
    "My agent": {
      "command": "/absolute/path/to/agent",
      "args": ["acp"]
    }
  }
}
```

- `use_custom_mcp` (true by default) passes the MCP servers declared in AI
  Assistant to the ACP agent — **including Striart**: the ACP agent then sees
  Striart's tools with no configuration of its own.
- `use_idea_mcp` (false by default) passes it the IDE's MCP server: leave it
  `false` (see "brave mode" below).
- ACP requires an **absolute** `command` for an MCP server forwarded to an
  agent: if the agent rejects `striart`, declare it in AI Assistant with the
  absolute path ([Windows](README.md#windows-the-striart-command); elsewhere,
  `which striart`).
- **Striart itself as an ACP agent**: declare it here, in `agent_servers`
  (an IDE session = an isolated clone + the chosen upstream agent + a merge
  under the Test Gate):

  ```json
  {
    "agent_servers": {
      "Striart": { "command": "/absolute/path/to/striart", "args": ["acp"] }
    }
  }
  ```

  `command` must be **absolute** (`which striart`; on Windows, `node` and the
  path of `src/cli.js` with `acp` as argument). The IDE's files and terminal
  are never used by the upstream agent; `/striart-finish` ends the session.
  **Test on a real JetBrains IDE: still to do** (not verified here).

## The IDE's built-in MCP server — caution

Settings | Tools | MCP Server > "Enable MCP Server" exposes the IDE (files,
search, refactoring, terminal, VCS…) to MCP clients (Claude Code, Codex,
Junie… through "Auto-Configure").

- **"brave mode"** ("Run shell commands or run configurations without
  confirmation"): the `execute_terminal_command` tool then runs without
  confirmation. **Keep it off** when agents driven by Striart can reach it:
  an agent could run `git merge`, `git push` or `git reset` **in the main
  repository** through the IDE, outside its clone, outside the lock and the
  Test Gate — the very incident that motivated the main-session guard
  ([Troubleshooting](../troubleshooting.md)).
- The IDE's tools take a `projectPath`: when the open project is the main
  repository rather than the agent's clone, the agent acts on the main
  repository. For an agent working in `.striart/agents/<name>/`, open that
  clone as the project, or do not give it this server.
- Prefer "Project Clients Auto-Configuration" over global registration, and
  narrow the "Exposed Tools" list.

## What is covered

- Striart's tools in AI Assistant, Junie and the ACP agents that receive AI
  Assistant's servers.

## Limits

- MCP resources and prompts are not documented on AI Assistant's side
  (Striart exposes none).
- Junie and `acp.json`: no documented `cwd`.

## Security

- AI Assistant's docs describe no approval prompt for external servers' tools
  (**unverified**): only declare Striart in projects where you accept that an
  agent launches and merges tasks.
- Project MCP files (`.junie/mcp/mcp.json`) may be committed: keep secrets
  out of them (reminder from the Junie docs).

## Sources (checked on 2026-10-24)

- AI Assistant, MCP — <https://www.jetbrains.com/help/ai-assistant/mcp.html>
  (AI Assistant 2026.2, page dated August 14, 2026).
- AI Assistant, ACP — <https://www.jetbrains.com/help/ai-assistant/acp.html>
  (October 7, 2026).
- IDE MCP server — <https://www.jetbrains.com/help/idea/mcp-server.html>
  (IntelliJ IDEA 2026.2, last updated May 13, 2026).
- Junie — <https://junie.jetbrains.com/docs/junie-cli-mcp-configuration.html>
  (October 23, 2026), <https://junie.jetbrains.com/docs/junie-plugin-mcp-settings.html>
- ACP, `McpServer` schema — <https://agentclientprotocol.com/protocol/session-setup>

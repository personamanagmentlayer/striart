# Warp

> [Documentation](../README.md) · [Integrations](README.md) · Warp
> 🇫🇷 [Français](../../fr/integrations/warp.md)

Warp touches Striart through three mechanisms: its agent's **MCP servers**,
its **rules** (AGENTS.md / WARP.md) and its **Tab Configs** to open a tab in
an agent's clone.

## MCP server

| Scope | File | Auto-spawn |
|---|---|---|
| Global | `~/.warp/.mcp.json` | on by default |
| Project | `.warp/.mcp.json` at the project root | **never** — started manually |

```json
{
  "mcpServers": {
    "striart": {
      "command": "striart",
      "args": ["mcp"],
      "working_directory": "/absolute/path/to/my-project"
    }
  }
}
```

`working_directory` ("Working directory path where the command is run") is
documented for CLI servers; **unverified**: that it is honoured in
`.mcp.json` files (it is described for the settings UI) and that a relative
path is accepted there. A **global** entry must pin the repository,
otherwise it drives the repository of the launch directory.

Warp can also read, after an explicit toggle, other agents' MCP files
(Claude Code's `.mcp.json`, `.codex/config.toml`, `.agents/.mcp.json`). The
Warp Agent CLI keeps its own configuration (macOS: `~/.warp_cli/.mcp.json`).

## Rules: AGENTS.md and WARP.md

- Warp uses `AGENTS.md` as the default project rules file; if `WARP.md` and
  `AGENTS.md` both exist in a directory, **`WARP.md` takes priority**. The
  file name must be upper case.
- Precedence: current subdirectory file > root file > global rules
  (`~/.agents/AGENTS.md` for the CLI).
- A Striart clone (`.striart/agents/<name>/`) is a full clone: it carries the
  repository's `AGENTS.md` / `WARP.md`, which Warp applies to the agent
  working there.

## Tab Configs: opening a tab in an agent's clone

`striart start --open` opens a tab in the terminal chosen by
`terminal.launcher` ([Configuration](../configuration.md#terminal--the---open-launcher));
**Warp is a launcher in its own right**: `terminal: { launcher: 'warp' }`, or
automatically when Striart is launched from a Warp session
(`TERM_PROGRAM=WarpTerminal`, disabled by `terminal.detectWarp: false`).
Warp's URI scheme (`warp://action/new_tab?path=…`) runs no command: Striart
therefore writes a Tab Config itself (TOML, `striart-<agent>-<fingerprint>.toml`,
mode 0600, a single pane in the clone, the `striart attach` command quoted for
the chosen shell) in the folder below, then opens it through
`warp://tab_config/<name>`. The fingerprint tells apart two repositories that
each have an `agent-a`. That file is removed by `striart stop` and
`striart clean` (a failure is reported as an `AGENT_ARTIFACT_FAILED`
warning: delete it by hand then). By hand, a Tab Config does the
equivalent. Folders:

- macOS: `~/.warp/tab_configs/`
- Windows: `%APPDATA%\warp\Warp\data\tab_configs\`
- Linux: `${XDG_DATA_HOME:-$HOME/.local/share}/warp-terminal/tab_configs/`

```toml
name = "Striart agent-a"

[[panes]]
id = "main"
type = "terminal"
directory = "/absolute/path/to/my-project/.striart/agents/agent-a"
commands = ["claude"]
```

Open it with `warp://tab_config/<name>`. The legacy YAML "Launch
Configurations" are replaced by Tab Configs (still read).

## What is covered

- Striart's tools in Warp's agent (Warp lists tools and resources per server;
  Striart exposes both).
- AGENTS.md rules in clones; one tab per agent.

## Security

- Configuration edits require approval; **project** servers never start on
  their own and enabling them lasts for the session ("if you still trust the
  repo").
- Keep confirmation on Striart's mutating tools in the Warp agent's
  permissions.
- Sharing a configuration scrubs secrets from `env`.

## Sources (checked on 2026-10-24)

- Warp, MCP — <https://docs.warp.dev/agents/capabilities/mcp> (last updated
  October 20, 2026).
- Warp, rules — <https://docs.warp.dev/agents/capabilities/rules> (October 20, 2026).
- Warp, Tab Configs — <https://docs.warp.dev/terminal/windows/tab-configs>
  (October 20, 2026).
- AGENTS.md — <https://agents.md/>

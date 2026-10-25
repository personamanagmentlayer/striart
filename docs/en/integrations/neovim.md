# Neovim — CodeCompanion.nvim

> [Documentation](../README.md) · [Integrations](README.md) · Neovim
> 🇫🇷 [Français](../../fr/integrations/neovim.md)

[CodeCompanion.nvim](https://codecompanion.olimorris.dev/) is a native MCP
client (MCP 2025-11-25, stdio transport) and an ACP client. Striart plugs in
as an MCP server.

## MCP configuration

```lua
require("codecompanion").setup({
  mcp = {
    servers = {
      ["striart"] = {
        cmd = { "striart", "mcp" },
      },
    },
    opts = {
      -- start Striart with every chat; otherwise `/mcp` starts it on demand
      default_servers = { "striart" },
    },
  },
})
```

The `mcp.servers` format (key = name, `cmd` = command and arguments) and
`opts.default_servers` are documented; the `striart` entry adapts the
official example.

**Working directory.** CodeCompanion documents no `cwd` option. According to
its source code (`lua/codecompanion/mcp/client.lua`, started with
`vim.system` without `cwd`), the server inherits **Neovim's current
directory** — derived from the source, **not documented**. Start Neovim at
the repository root (or `:cd` to it before the first chat).

## ACP agents

CodeCompanion ships ACP adapters (`claude_code`, `codex`, `gemini_cli`,
`goose`, `opencode`…). To forward Striart to them, the docs say to set
`mcpServers = "inherit_from_config"` in the adapter's `defaults`: "Only the
servers in `mcp.opts.default_servers` are passed, and setting
`mcp.opts.acp_enabled = false` stops them being passed at all." How to
override a built-in adapter is described on the "ACP adapters" page (not
reproduced here). The ACP session `cwd` is `vim.fn.getcwd()` (from the
source, not documented).

To use **Striart itself as an ACP agent** (`striart acp`), declare a custom
adapter whose command is `{ "striart", "acp" }` — the exact way to declare a
custom ACP adapter is taken from CodeCompanion's "ACP adapters" page (not
reproduced here, **unverified**). A Neovim session = an isolated clone + the
chosen upstream agent + a merge under the Test Gate. **Test on real Neovim:
still to do.**

## What is covered

- Striart's tools (text content), in the chat and for ACP agents that
  inherit the servers. MCP resources are not supported by CodeCompanion
  (Striart exposes some, `striart://…`, but only its tools serve here).

## Security

- **"MCP tools run without asking unless you set `require_approval_before`"**
  (CodeCompanion docs). Configure approval at least for `striart_run`,
  `striart_merge`, `striart_promote`, `striart_resolve_prepare`,
  `striart_resolve_apply` and `striart_collab_post`, through the server's
  `tool_overrides`. **Unverified**: the exact structure of
  `tool_overrides` — take it from the "MCP" page.
- MCP roots are a hint CodeCompanion cannot enforce (Striart does not use
  them).

## Sources (checked on 2026-10-24)

- CodeCompanion, MCP configuration —
  <https://codecompanion.olimorris.dev/configuration/mcp>; MCP support —
  <https://codecompanion.olimorris.dev/model-context-protocol>; ACP adapters —
  <https://codecompanion.olimorris.dev/configuration/adapters-acp>
  (sources: `doc/` in the olimorris/codecompanion.nvim repository, commits
  from 2026-10-10 to 2026-10-16; release v20.0.1 of 2026-10-17).

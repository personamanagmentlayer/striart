# Eclipse Theia (Theia IDE and Theia AI applications)

> [Documentation](../README.md) · [Integrations](README.md) · Eclipse Theia
> 🇫🇷 [Français](../../fr/integrations/theia.md)

Theia AI consumes MCP servers declared in its preferences; Striart plugs in
as a stdio MCP server.

## Configuration

Preference `ai-features.mcp.mcpServers` (the `settings.json` preferences
file, or Theia's preferences editor):

```json
{
  "ai-features.mcp.mcpServers": {
    "striart": {
      "command": "striart",
      "args": ["mcp"],
      "autostart": true
    }
  }
}
```

Documented fields for a local server: `command`, `args`, `env`, `autostart`
(default `true`). The "MCP: Start MCP Server" and "MCP: Stop MCP Server"
commands control the server; changes apply on the next restart.

**Working directory — unverified.** Theia documents no `cwd` field; its own
Git server example passes the repository **as an argument** (`--directory`).
Do the same with `striart mcp --root` (see the
[common page](README.md#choosing-the-driven-repository---root)), with the
repository's absolute path:

```json
{
  "ai-features.mcp.mcpServers": {
    "striart": {
      "command": "striart",
      "args": ["mcp", "--root", "/absolute/path/to/my-project"]
    }
  }
}
```

## What is covered

- Striart's tools, visible as soon as the server starts, usable by Theia AI
  agents.
- Theia can also expose its own tools as an MCP server (Streamable HTTP,
  `POST /mcp`); that is the other direction, unrelated to Striart.

## Limits

- No documented `cwd`: one entry per repository, with `--root`.
- No documented ACP support on Theia's side (**unverified**): `striart acp`
  does not apply until Theia is an ACP client.

## Security

- Each tool has a mode: Disabled, Confirm (global default) or Always Allow
  (preferences `ai-features.chat.defaultToolConfirmation` and
  `ai-features.chat.toolConfirmation`). Keep **Confirm** for Striart's
  mutating tools; "Always allow" only for `striart_status` and
  `striart_queue`.
- Theia's own MCP server (if enabled) should only be turned on in trusted
  environments (warning from its documentation).

## Sources (checked on 2026-10-24)

- Theia, "Using AI features" — <https://theia-ide.org/docs/user_ai/>
  (no date shown).
- `@theia/ai-mcp` package README —
  <https://github.com/eclipse-theia/theia/tree/master/packages/ai-mcp>
- `@theia/ai-mcp-server` package README —
  <https://github.com/eclipse-theia/theia/tree/master/packages/ai-mcp-server>

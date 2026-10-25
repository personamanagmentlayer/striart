# Devin Desktop (formerly Windsurf)

> [Documentation](../README.md) · [Integrations](README.md) · Devin Desktop
> 🇫🇷 [Français](../../fr/integrations/devin-desktop.md)

Windsurf became **Devin Desktop** on June 2, 2026. Two agents live side by
side, with two separate MCP configurations: **Devin Local** (default agent
for new tabs) and **Cascade** (the legacy agent, announced as available
"through July" by the official FAQ — check whether your version still has
it).

## Devin Local (default agent)

### Configuration

| Scope | File |
|---|---|
| User | `~/.config/devin/mcp_config.json` (Windows: `%APPDATA%\devin\mcp_config.json`) |
| Project (versioned) | `.devin/mcp_config.json` |
| Local (git-ignored, default scope of `devin mcp add`) | `.devin/mcp_config.local.json` |

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

Or from the command line, at the repository root:

```bash
devin mcp add striart -- striart mcp              # local scope
devin mcp add -s project striart -- striart mcp   # project scope
```

The MCP file moved in v3000.3 (Local 3.6); earlier versions kept
`mcpServers` in `config.json` and migrate automatically.

### Permissions

Devin Local **asks for approval before any MCP tool** by default. The
`allow` / `deny` / `ask` rules of Devin's configuration (format from Devin
Local's MCP page) name a tool as `mcp__<server>__<tool>`; only put read-only
tools in `allow`:

```json
{
  "permissions": {
    "allow": ["mcp__striart__striart_status", "mcp__striart__striart_queue"]
  }
}
```

Never `mcp__striart__*` or `mcp__*` in `allow`.

## Cascade (legacy agent)

### Configuration

**User file only**: `~/.config/devin/mcp_config.json` (or
`$XDG_CONFIG_HOME/devin/mcp_config.json`); Windows:
`%APPDATA%\devin\mcp_config.json`. **Unverified**: whether the old
`~/.codeium/windsurf/mcp_config.json` is still read.

With no per-project configuration, pin the repository with `--root` (see the
[common page](README.md#choosing-the-driven-repository---root)),
and hide the mutating tools with `disabledTools` — **Cascade does not ask
for approval before MCP tools by default** (outside a clone the server is
read-only anyway while `mcp.scope` stays `agent`):

```json
{
  "mcpServers": {
    "striart": {
      "command": "striart",
      "args": ["mcp", "--root", "/absolute/path/to/my-project"],
      "disabledTools": [
        "striart_run",
        "striart_merge",
        "striart_promote",
        "striart_resolve_prepare",
        "striart_resolve_apply",
        "striart_collab_post"
      ]
    }
  }
}
```

### The 100-tool limit

"Cascade has a limit of 100 total tools that it has access to at any given
time." Striart uses few (list in [MCP server](../mcp.md)); if the limit is
reached, disable tools from other servers rather than Striart's read-only
ones.

## What is covered

- Striart's tools for Devin Local and Cascade (Cascade also supports
  resources and prompts, which Striart does not use).

## Limits

- **Working directory — unverified** for both agents: no `cwd` field is
  documented. Prefer Devin Local's project configuration and check the root
  in the server log.
- The Striart extension (coming, no announced date) will be published on
  Open VSX, from which Devin Desktop will be able to install it.

## Security

- Team administration: as soon as a single MCP server is allowlisted, every
  other one is blocked; matching uses the server ID (the `mcp_config.json`
  key, case-sensitive), with an optional anchored regex on `command`/`args`.
- Agents are disabled in Restricted Mode workspaces.
- `.devin/mcp_config.json` is versioned: read it in every cloned repository.

## Sources (checked on 2026-10-24)

- Devin Desktop FAQ — <https://docs.devin.ai/desktop/devin-desktop-faq>;
  changelog — <https://docs.devin.ai/desktop/changelog> (June 2, 2026).
- Devin Local — <https://docs.devin.ai/desktop/devin-local>
- Devin Local / CLI MCP — <https://docs.devin.ai/cli/extensibility/mcp/configuration>
- Cascade MCP — <https://docs.devin.ai/desktop/cascade/mcp> (old URL
  `docs.windsurf.com/windsurf/cascade/mcp` redirects there).

(No update date shown on these pages.)

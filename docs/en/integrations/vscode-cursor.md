# VS Code and Cursor

> [Documentation](../README.md) · [Integrations](README.md) · VS Code and Cursor
> 🇫🇷 [Français](../../fr/integrations/vscode-cursor.md)

Until the Striart extension ships (VS Code Marketplace and Open VSX, in
preparation, no announced date), Striart is used in VS Code and Cursor as a
stdio MCP server declared in an `mcp.json` file.

## VS Code

### Configuration

VS Code knows two formats:

| File | Key | `cwd` | Note |
|---|---|---|---|
| `.vscode/mcp.json` (workspace) or the user profile's `mcp.json` | `servers` | yes | VS Code format; labelled "deprecated" in the add-server flow, still read |
| `.mcp.json` at the workspace root | `mcpServers` | **no** | portable Copilot format |
| `$COPILOT_HOME/mcp-config.json` (fallback `~/.copilot/mcp-config.json`) | `mcpServers` | yes | Copilot format, user level |

The driven repository is pinned with `--root`
([common page](README.md#choosing-the-driven-repository---root)): VS Code
interpolates `${workspaceFolder}` in `args`, which avoids surprises in a
multi-root workspace. (By default the server starts in the workspace
folder.)

`.vscode/mcp.json`:

```json
{
  "servers": {
    "striart": {
      "type": "stdio",
      "command": "striart",
      "args": ["mcp", "--root", "${workspaceFolder}"]
    }
  }
}
```

Portable format (`.mcp.json` at the root — the same file is read by Claude
Code; without `cwd`, the server inherits the launch directory):

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

From the command line (user profile, VS Code format):

```bash
code --add-mcp '{"name":"striart","type":"stdio","command":"striart","args":["mcp"]}'
```

A user-profile entry serves **every** workspace: it drives the repository of
the opened folder, not a fixed one.

### What is covered

- Striart's tools in Copilot's agent mode. Striart also exposes resources
  (`striart://…`) and no prompt.
- VS Code limit: at most 128 tools enabled per request — Striart adds few
  (list in [MCP server](../mcp.md)).

### Security

- `.vscode/mcp.json` and `.mcp.json` inherit **Workspace Trust**: in
  restricted mode these servers do not start; in a trusted workspace they
  start **without a separate MCP trust prompt, including after configuration
  changes**. Only trust a repository whose files you have read.
- Approvals: keep confirmation on mutating tools
  (`chat.tools.eligibleForAutoApproval` set to `false` for them) and do not
  use `chat.tools.global.autoApprove`, `/yolo` or `/autoApprove` with Striart
  connected. With sandboxing enabled, VS Code auto-approves tool
  confirmations: take that into account.

## Cursor

### Configuration

- Project: `.cursor/mcp.json`; global: `~/.cursor/mcp.json`. Both are merged;
  the project wins on equal names.
- Key `mcpServers`:

```json
{
  "mcpServers": {
    "striart": {
      "type": "stdio",
      "command": "striart",
      "args": ["mcp"]
    }
  }
}
```

**Working directory — unverified.** Cursor documents neither `cwd` nor the
launch directory. It does interpolate `${workspaceFolder}` (the folder that
contains `.cursor/mcp.json`) in `args`; `--root` (see the
[common page](README.md#choosing-the-driven-repository---root)) pins the
repository without a hard-coded path, on every platform:

```json
{
  "mcpServers": {
    "striart": {
      "command": "striart",
      "args": ["mcp", "--root", "${workspaceFolder}"]
    }
  }
}
```

### What is covered

Striart's tools in Cursor's agent (Cursor also supports prompts, resources,
roots and elicitation, which Striart does not use). No tool-count limit is
currently documented.

### Security

- Cursor asks for approval before every MCP tool by default.
- In **Auto-review** mode (default since Cursor 3.6), allowlisted tools run
  immediately: only allowlist the read-only tools, in
  `~/.cursor/permissions.json` or `<workspace>/.cursor/permissions.json`:

  ```json
  { "mcpAllowlist": ["striart:striart_status", "striart:striart_queue"] }
  ```

  Never `striart:*`. **Run Everything** mode runs every call without
  confirmation: avoid it with Striart connected.
- On Windows, when an administrator enables "MCP Network Controls", sandboxed
  stdio servers do not start: a "No sandbox" entry is required (Cursor docs).

## Sources (checked on 2026-10-24)

- VS Code, "MCP configuration reference" —
  <https://code.visualstudio.com/docs/agents/reference/mcp-configuration>
  (DateApproved 2026-10-21).
- VS Code, "MCP servers" —
  <https://code.visualstudio.com/docs/agent-customization/mcp-servers>;
  "Manage MCP servers" — <https://code.visualstudio.com/docs/agents/run/manage-mcp-servers>;
  tools and approvals — <https://code.visualstudio.com/docs/agents/run/tools>,
  <https://code.visualstudio.com/docs/agents/run/approvals>.
- Cursor, "MCP" — <https://cursor.com/docs/mcp>; help —
  <https://cursor.com/help/customization/mcp>; run modes —
  <https://cursor.com/docs/agent/security/run-modes>; permissions —
  <https://cursor.com/docs/reference/permissions> (no date shown).

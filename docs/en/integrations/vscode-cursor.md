# VS Code and Cursor

> [Documentation](../README.md) · [Integrations](README.md) · VS Code and Cursor
> 🇫🇷 [Français](../../fr/integrations/vscode-cursor.md)

Striart is used in VS Code and Cursor in two ways: as a **stdio MCP server**
declared in an `mcp.json` file (agent plane, below), and through the **VS Code
extension** (human plane, [further down](#vs-code-extension)), delivered in the
repository but **not yet published** (neither VS Code Marketplace nor Open VSX,
no announced date).

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

## VS Code extension

The extension (`extensions/vscode/`, version `0.1.0`, `private`) is a **thin
client of the Striart Control Protocol v1** — the human plane: it launches
`striart api --stdio` and contains no business logic; everything it shows comes
from `state.get` / `state.changed`, and every action is a protocol method, with
the same guards, locks and Test Gate as the CLI.

- **Striart view** in the activity bar: agents grouped as "Needs attention"
  (conflict tickets, permission requests and questions, agents ready to merge,
  broken clones), "Running" and "Idle", plus the queue; a status bar with an
  explicit offline state.
- **Command Palette** (`Striart:` prefix): merge, synchronize, stop, new task,
  open an agent's terminal, resolve a ticket, show an agent's diff, open the
  dashboard (one-time link), `doctor`, roll back the last merge, retry the queue,
  reconnect.
- **Actionable notifications** for agent permission requests and questions;
  closing a notification never answers (fail closed).
- English and French, automatic reconnection (exponential backoff with jitter).

**Security**: in an untrusted workspace (Workspace Trust) the extension is inert
— **no process is started** — because `striart api` loads the repository config,
which is code. The binary is resolved from **user** settings only
(`striart.binaryPath`, `striart.nodePath`), as `argv` with `shell: false`.
Launched from an agent session (`STRIART_SESSION=1`), the CLI refuses the
protocol. Details, settings and limits:
[`extensions/vscode/README.md`](../../../extensions/vscode/README.md).

**Delivery status.** The code, its unit, integration (against the real
`striart api`) and end-to-end (real VS Code, outside the extension's `npm test`) tests are in the repository. The
extension is **not published**: to try it, `cd extensions/vscode && npm install
&& npm run package` produces `striart-vscode.vsix`, to install by hand.
Publishing to the Marketplace and Open VSX is a separate manual step, not done.
The JetBrains plugin and the read-only cloud agents are **not delivered**.

## Sources (checked on 2026-10-24)
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

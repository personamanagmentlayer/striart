# Visual Studio 2022 (17.14+) / Visual Studio 2026

> [Documentation](../README.md) · [Integrations](README.md) · Visual Studio
> 🇫🇷 [Français](../../fr/integrations/visual-studio.md)

Visual Studio consumes MCP servers from GitHub Copilot's agent mode. Striart
plugs in as a stdio MCP server.

## Configuration

Visual Studio reads MCP configurations in this order (official docs):

1. `%USERPROFILE%\.mcp.json` — global to the user, for every solution;
2. `<SOLUTIONDIR>\.vs\mcp.json` — Visual Studio specific, per user and solution;
3. `<SOLUTIONDIR>\.mcp.json` — can be tracked with the repository;
4. `<SOLUTIONDIR>\.vscode\mcp.json`;
5. `<SOLUTIONDIR>\.cursor\mcp.json`.

Recommended: `<SOLUTIONDIR>\.vs\mcp.json` (not versioned, machine specific)
or `<SOLUTIONDIR>\.mcp.json` if the team wants to share the entry. The
top-level key is `servers`:

```json
{
  "servers": {
    "striart": {
      "type": "stdio",
      "command": "striart",
      "args": ["mcp"]
    }
  }
}
```

The official page only shows a remote-server example (`url`); the stdio
fields `type: "stdio"`, `command` and `args` are confirmed by its one-click
install link and by its description of the files ("name, transport type (for
example, stdio or SSE), the command to launch it, any arguments, and
optional environment variables").

**Working directory — unverified.** The docs describe neither a `cwd` field
nor the launch directory. The solution must live inside the target
repository initialized with `striart init`; if the server log shows another
root, pass `--root <repository>` in `args` (see
[the common page](README.md#choosing-the-driven-repository---root)).
If `striart` is not found, point at `node` with the absolute path of
`src/cli.js` ([Windows](README.md#windows-the-striart-command)).

## What is covered

- Striart's tools (read and mutate), usable by Copilot's agent mode. Striart
  exposes no prompt: nothing appears under "Add Reference > Prompts" or
  through `#`. Its resources (`striart://…`) are not used by this client
  (**unverified**).
- **Tools are disabled by default**: enable them manually in the chat
  window's tool list.

## Limits

- No documented configurable working directory (see above).
- No native extension is planned for Visual Studio at this stage; the
  extension to come (no announced date) targets VS Code and Open VSX.

## Security

- Visual Studio 2026 (18.7+) shows a trust dialog when a server's command,
  arguments or tool list change (not on first sight, which is the baseline):
  reject any change you did not make.
- On `notifications/tools/list_changed`, Visual Studio resets tool approvals
  ("rug-pull" protection).
- A tool approval can be remembered for the session, the solution or always:
  keep "always" for `striart_status` and `striart_queue`. Reset: Tools >
  Options > GitHub > Copilot > Tools.
- A versioned `.mcp.json` can launch any command: read it in every cloned
  repository.

## Sources (checked on 2026-10-24)

- Microsoft Learn, "Use MCP servers in Visual Studio" —
  <https://learn.microsoft.com/en-us/visualstudio/ide/mcp-servers>
  (`ms.date` 2026-05-26, updated 2026-10-14).

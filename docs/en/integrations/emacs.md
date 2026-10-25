# Emacs — agent-shell

> [Documentation](../README.md) · [Integrations](README.md) · Emacs
> 🇫🇷 [Français](../../fr/integrations/emacs.md)

[agent-shell](https://github.com/xenodium/agent-shell) is an ACP client for
Emacs (Emacs 29.1+, depends on `acp.el` and `shell-maker`, installed by
MELPA). It does not consume MCP servers itself: it **forwards** MCP servers
to the ACP agents it launches (Claude Agent, Codex, Gemini, Goose…). That is
how Striart plugs in.

## Configuration

```elisp
(setq agent-shell-mcp-servers
      '(((name . "striart")
         (command . "/absolute/path/to/striart")
         (args . ("mcp"))
         (env . ()))))
```

The shape follows the ACP `McpServer` schema (docstring of
`agent-shell-mcp-servers`); the protocol requires an **absolute** `command`
(`which striart`, or on Windows the path of `node` + `src/cli.js`, see the
[common page](README.md#windows-the-striart-command)). An agent can have its
own list (the `:mcp-servers` keyword of `agent-shell-make-agent-config`),
which takes precedence over the global one. Settings can be applied per
project with directory-local variables.

**Working directory.** The ACP session starts in `agent-shell-cwd`:
`agent-shell-cwd-function` if set, else the project root, else
`default-directory`. The directory in which the agent then starts the MCP
server depends on the agent (**unverified**); check the root in the server
log and, if needed, pass `--root <repository>` (see the
[common page](README.md#choosing-the-driven-repository---root)) to
`striart mcp`.

## What is covered

- Striart's tools for every ACP agent launched by agent-shell.

## Limits

- No documented public recipe for declaring a fully custom ACP agent command
  (the built-in agents go through an internal function): `striart acp`
  (command `striart`, argument `acp`) is to be wired through
  `agent-shell-agent-configs` — **unverified**, a real test is still to do.

## Security

- Tool approvals are those of the launched ACP agent (and of the permissions
  agent-shell relays to it): keep confirmation on Striart's mutating tools in
  the agent's configuration.

## Sources (checked on 2026-10-24)

- README and `agent-shell.el` (version 0.89.1, `acp` 0.17.1) —
  <https://github.com/xenodium/agent-shell> (last README commit: 2026-10-23).
- ACP, `McpServer` schema — <https://agentclientprotocol.com/protocol/session-setup>

# Striart for VS Code

Pilot your [Striart](https://github.com/personamanagmentlayer/striart) multi-agent Git orchestrator from VS Code: see every agent at a glance, merge under the Test Gate, resolve conflict tickets, and answer your agents' permission requests without leaving the editor.

> Français : [README.fr.md](README.fr.md)

The extension is a thin client of the **Striart Control Protocol v1** (the *human plane*). It spawns `striart api --stdio` and contains **no business logic**: everything it shows comes from `state.get` / `state.changed`, and every action is one protocol method — the same guards, locks and Test Gate as the CLI.

## What you get

- **Striart view** in the activity bar: agents grouped as **Needs attention** (conflict tickets, permission requests and questions, agents ready to merge, broken clones), **Running** and **Idle**, plus the task **Queue**. Status is always written in words (not colour only).
- **Status bar**: agents, conflicts, pending requests, watcher on/off, and an explicit **offline** state.
- **Command Palette** (all prefixed `Striart:`): Merge Agent, Synchronize Agents, Stop Agent, New Task, Open Agent Terminal, Resolve Conflict Ticket, Show Agent Diff, Open Dashboard (one-time link), Run Doctor, Roll Back Last Merge, Retry Queue, Reconnect, Show Output.
- **Actionable notifications** for agent permission requests and structured questions (elicitations): answer from VS Code. Closing a notification never answers (fail closed; the request stays in the view until it expires).
- **Proportionate confirmations**: a merge asks once and states what runs; a forced stop, a rollback or closing a ticket by hand writes the consequence and requires typing the exact name.
- **Automatic reconnection** with exponential backoff and jitter (bounded attempts), stale data clearly marked offline.
- **English and French** (follows the VS Code display language).

## Requirements

- Striart installed and a repository initialised (`striart init`).
- The extension runs where the repository lives (works in Remote SSH, dev containers and Codespaces); local `file:` folders only.

## Security model

| Concern | Behaviour |
|---|---|
| **Workspace Trust** | In an untrusted workspace the extension is inert: **no process is started**. This is stricter than "read-only" on purpose — `striart api` loads the repository configuration (`striart.config.mjs`), which is code. Trusting the workspace starts it automatically. |
| **Which binary runs** | Resolved from **user** settings only (`striart.binaryPath`, `striart.nodePath` are `machine`-scoped; values from `.vscode/settings.json` or `.code-workspace` are ignored and logged). Bare names are looked up in `PATH` excluding the workspace; relative paths are refused; the process is started with `argv` and `shell: false`. |
| **Agent text** | Everything coming from agents (prompts, commit messages, permission titles) is untrusted: control and bidirectional characters removed, length bounded, displayed as plain text. A URL requested by an agent is shown, never opened automatically. |
| **Protocol input** | Every message is validated against the published schema subset and bounded to 1 MiB; an unexpected shape is an explicit error, never a silent fallback. |
| **Privacy** | No telemetry, no network access, no secrets stored. |
| **Webviews** | None: native TreeView, QuickPick, InputBox and status bar only. |
| **Terminals** | "Open Agent Terminal" opens a terminal in the agent clone and may *pre-fill* the agent command **without executing it**. |
| **Agent diff** | The one local `git` call: read-only `git diff` in the agent clone with `core.fsmonitor`, external diff drivers and text conversion disabled (the clone is writable by the agent). |

Launched from inside an agent session (`STRIART_SESSION=1`) the protocol refuses by design (an agent must not arbitrate itself); the view then says so.

## Settings

| Setting | Default | Notes |
|---|---|---|
| `striart.binaryPath` | `striart` | Command name (PATH) or **absolute** path to the executable or entry script. User settings only. |
| `striart.nodePath` | `node` | Used when `binaryPath` is a script or a Windows npm shim. User settings only. |
| `striart.root` | `""` | Repository root (absolute or relative to the first workspace folder). Restricted in untrusted workspaces. |
| `striart.requestTimeoutSeconds` | `30` | Read-only requests. |
| `striart.actionTimeoutSeconds` | `3600` | Long actions (merge + Test Gate…). Expiry does not cancel the operation. |
| `striart.reconnect.initialDelaySeconds` / `maxDelaySeconds` / `maxAttempts` | `1` / `30` / `8` | Backoff; `0` attempts disables auto-reconnect. |
| `striart.notifications.requests` | `true` | Notify on agent requests. |

On Windows, npm installs a `striart.cmd` shim that Node cannot start safely without a shell; the extension maps it to the package entry script next to it, or tells you to set `striart.binaryPath` to `…\node_modules\@jumsay\striart\src\cli.js`.

## Known limitations

- Multi-root workspaces: the first folder (or `striart.root`) is used.
- Dashboard link in remote windows: the link targets the loopback of the *remote* machine; forward the port yourself.
- The agent diff covers the agent's pending commits (`HEAD~n..HEAD`), not uncommitted changes. A protocol method for it (`agent.diff`) would remove the local `git` call.

## Development

```bash
cd extensions/vscode
npm install
npm run build          # esbuild bundle -> dist/extension.cjs
npm run typecheck
npm run test:unit      # client, framing, validation, model, binary resolution (fake server)
npm run test:integration   # against the real `striart api` of a temporary Git repository
npm run test:e2e       # real VS Code via @vscode/test-electron (downloads VS Code)
npm run package        # striart-vscode.vsix (does not publish)
```

Publishing to the Marketplace / Open VSX is a separate, manual step.

# Integrations — IDEs, editors and terminals

> [Documentation](../README.md) · Integrations
> 🇫🇷 [Français](../../fr/integrations/README.md)

Striart integrates with a tool in **two complementary ways**, which map to
two distinct planes (see
[Architecture](../architecture.md#three-planes-never-mixed)):

- **Through its MCP server** (`striart mcp`, stdio) — the *agent → Striart*
  plane: the tool's agent reads the orchestrator's state, merges *its* work,
  prepares *its* resolutions, with the same locks and the same Test Gate as
  the CLI. Described in [MCP server](../mcp.md).
- **Through the ACP proxy** (`striart acp`, stdio) — Striart *is* the agent
  seen by an ACP-capable editor (Zed, JetBrains, Neovim, Emacs…): **an editor
  session = an isolated clone + the chosen upstream agent + a merge under the
  Test Gate.** See [Striart as an ACP agent](#striart-as-an-acp-agent-striart-acp)
  below.

The third plane, *human → Striart* (`striart api`, the Control Protocol), is
that of the upcoming IDE extensions — see "What is coming".

Each page below gives the exact configuration, what is covered, the limits
and the security points specific to the tool. **Paths and formats were
checked on 2026-10-24 against each vendor's official documentation**, cited
at the end of each page; anything that could not be checked is marked
"**unverified**".

| Tool | Page | Mechanism |
|---|---|---|
| Visual Studio 2022 (17.14+) / 2026 | [visual-studio.md](visual-studio.md) | `.mcp.json` (`servers`) |
| VS Code and Cursor | [vscode-cursor.md](vscode-cursor.md) | `.vscode/mcp.json` / `.mcp.json` / `.cursor/mcp.json` |
| Xcode 26.3+ | [xcode.md](xcode.md) | configuration of agents launched in Xcode |
| Eclipse Theia | [theia.md](theia.md) | `ai-features.mcp.mcpServers` preference |
| Devin Desktop (formerly Windsurf) | [devin-desktop.md](devin-desktop.md) | `mcp_config.json` (`mcpServers`) |
| JetBrains IDEs | [jetbrains.md](jetbrains.md) | AI Assistant (MCP), Junie, `acp.json` — **and `striart acp`** |
| Zed | [zed.md](zed.md) | `context_servers` (MCP) — **and `agent_servers` for `striart acp`** |
| Neovim (CodeCompanion) | [neovim.md](neovim.md) | `mcp.servers` — **and `striart acp`** |
| Emacs (agent-shell) | [emacs.md](emacs.md) | `agent-shell-mcp-servers` (ACP) — **and `striart acp`** |
| Warp | [warp.md](warp.md) | `.warp/.mcp.json`, AGENTS.md/WARP.md, Tab Configs, `--open` launcher |

Claude Code is covered by the [MCP server](../mcp.md) page
(`claude mcp add striart -- striart mcp`).

## Common to every tool

### Prerequisites

- `striart` installed from source and on the path (`npm link`, after
  `npm run native:build` — see [Getting started](../getting-started.md#installation)):
  it relies on a native binary (see
  [Architecture](../architecture.md#native-components-rust));
- the target repository initialized (`striart init`) — otherwise the tools
  answer with an explicit error.

### Choosing the driven repository (`--root`)

`striart mcp --root <absolute-path>` designates the main repository **without
depending on the working directory** the host gives the server — the form to
prefer in any editor configuration:

```json
{ "command": "striart", "args": ["mcp", "--root", "/absolute/path/to/my-project"] }
```

Without `--root`, the current working directory decides (root found by
`git rev-parse --show-toplevel`); started outside any Git repository, the
server refuses to start (`NOT_A_GIT_REPO` on stderr), and a `--root` that
does not designate an initialized Striart repository is refused
(`MCP_ROOT_INVALID`). When the tool lets you set the server's `cwd` (VS Code,
Warp `working_directory`, JetBrains AI Assistant's "Working directory"), both
work; when it does not document it, `--root` avoids guessing. The former
`sh -c 'cd … && exec striart mcp'` launcher is no longer needed.

The path is an argument value: a path with spaces or special characters stays
data (no shell is involved).

### Windows: the `striart` command

A global npm install creates a `striart.cmd` launcher on Windows. Some hosts
launch the command without a shell and do not resolve `.cmd` files (behavior
specific to each host, **unverified** tool by tool). If the server fails to
start, point at Node directly with an absolute path:

```json
{ "command": "node", "args": ["C:\\Users\\you\\AppData\\Roaming\\npm\\node_modules\\@jumsay\\striart\\src\\cli.js", "mcp", "--root", "C:\\path\\to\\my-project"] }
```

The exact folder is given by `npm root -g`. This absolute form is also the one
the ACP protocol requires when a client forwards the server to an agent: its
schema defines `command` as "the absolute path to the MCP server executable".

### Checking the server outside the tool

```bash
cd /path/to/my-project
printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | striart mcp
```

The JSON-RPC response lists the tools on stdout; logs go to stderr.
`striart doctor` diagnoses the environment (git, native component, config,
LLM, locks).

### Security — apply everywhere

- **Mutating tools stay subject to approval.** `striart_run`,
  `striart_merge`, `striart_promote`, `striart_resolve_prepare`,
  `striart_resolve_apply` and `striart_collab_post` launch agents, merge and
  act on behalf of a clone. Only enable auto-approval ("YOLO", "Run
  Everything", "brave mode", a generic `striart:*` allowlist…) for the read
  tools: `striart_status`, `striart_queue`, `striart_ticket`,
  `striart_collab_read`.
- **The server is bound to its caller** (lot D6). Started from an agent's
  clone (or with `--agent`), it only acts on **that** agent; started outside
  any clone — the case of an editor opened on the main repository — it is
  **read-only**, unless `mcp.scope: 'orchestrator'` in the config (a
  relaxation, logged and shown by `doctor`). `striart_resolve` (closing
  without the Test Gate) no longer exists on the MCP side, and no level offers
  permission arbitration: those gestures are human. The depth bound (an agent
  launched by Striart in autonomous mode cannot call the mutating tools)
  remains **advisory** — see [SECURITY.md](../../../SECURITY.md).
- **A versioned MCP configuration file is code.** A `.mcp.json` or
  `.vscode/mcp.json` committed in a repository you clone can launch an
  arbitrary command: read it before trusting the repository. (Striart, for
  its part, **protects** those files against an agent: a merge that changes
  them is refused — protected paths.)
- **No secrets in the server configuration.** `striart mcp` needs none; LLM
  provider keys are read from environment variables or the repository's
  `.env` (see [Configuration](../configuration.md)).

## Striart as an ACP agent: `striart acp`

ACP clients (Zed, JetBrains, Neovim with CodeCompanion, Emacs with
agent-shell…) launch an agent as a stdio subprocess. `striart acp` is that
agent: the configuration is the same everywhere — a command and an argument.

```json
{ "command": "striart", "args": ["acp"] }
```

Each editor page gives the exact location of this entry. Good to know:

- **One session = one clone.** `session/new` creates nothing; on the first
  prompt Striart goes through the Router, creates the clone and launches the
  upstream agent. The editor exposes **session options**: the upstream agent
  (among your `acp: true` profiles, restricted by `acpAgent.profiles`), the
  permission policy (`ask` by default: you decide *in* the editor), automatic
  or manual merge.
- **The editor's files and terminal are never used.** The upstream agent works
  in its clone, served by Striart's ACP client; your open files are only read
  as context references. The boundary is structural.
- **Ending the session** — the `/striart-finish` command, closing the session
  or disconnecting (per `acpAgent.onDisconnect`, `keep` by default: clone kept
  with no merge) — applies the commit contract, merges under the Test Gate,
  opens a ticket if red, and cleans up without `force`. `/striart-status`
  shows the state.
- **Prerequisite**: at least one configured ACP profile (`striart profiles
  --detect`, `--import-acp <id>`), and its tool installed and authenticated.
  With none: `ACP_PROXY_NO_PROFILE`.
- **Authentication**: Striart has no account and advertises a single method,
  `striart-local`; authenticating the upstream agent remains the business of
  its own tool (`ACP_AUTH_REQUIRED` otherwise).
- `--root <repo>` bounds the sessions to one repository; `--profile <p>`
  picks the upstream profile offered by default. Settings:
  [`acpAgent`](../configuration.md#acpagent--the-acp-proxy-striart-acp).

Publishing Striart in the **ACP registry** (the repository's
`registry/acp/striart/` entry, `npx` distribution of the package) is prepared
but not done: it is an act of the user, and the package is currently published
on no registry (install from the sources, see the README). Until then, declare
the command by hand as above.

### What is coming

Two native integrations, on the Control Protocol (`striart api`):

- a **VS Code extension** — **delivered in the repository**
  (`extensions/vscode/`, version `0.1.0`) but **not published**: neither VS Code
  Marketplace nor **Open VSX** (Cursor, Devin Desktop, VSCodium…), no announced
  date; see [VS Code and Cursor](vscode-cursor.md#vs-code-extension);
- a **JetBrains plugin**, on the same protocol — **not delivered**, no announced
  date.

Until then, the pages below describe the integration through MCP and ACP,
which work with the current version.

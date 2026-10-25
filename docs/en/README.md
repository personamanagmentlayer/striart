# Striart Documentation

> Complete documentation for Striart, the multi-agent Git orchestrator.
> The root [README.md](../../README.md) is the showcase and is shown by default;
> all the detail lives here.
> 🇫🇷 [Documentation française](../fr/README.md) — the [French README](../../README.fr.md) is the content reference.

## Contents

| Page | Content |
|---|---|
| [Getting started](getting-started.md) | Prerequisites (Git repo, first commit, LLM), installation, `striart init`, first run, the "3 agents in parallel" guide. |
| [Architecture](architecture.md) | Why clones and not worktrees, the serialized chain, the flow of an agent commit, the 6 synchronization statuses, the heartbeat inter-process lock and its fair queue, the state files and their lock, the three planes (MCP, Control Protocol, ACP), the native components (Rust), the orchestration modes, tokens, why auto-stash is safe. |
| [Commands](commands.md) | The CLI contract (exit codes, `--json`, language, completion) and the 30 commands in detail: options, safeguards, refusal codes. |
| [Configuration](configuration.md) | The full `striart.config.mjs` reference: every option, its default and bounds, LLM providers, `tokens`, `llmResilience`, `agentProfiles` and its presets, `commitPolicy`, `protectedAgentPaths`, `acpAgent`, `terminal`, `pty`, `mcp`, `orchestration`, the user configuration. |
| [Branches and pipeline](branches.md) | `targetBranch` on any branch (`main`, `master`, `dev`…), the current-branch constraint, the staging → main pipeline (`striart promote`), `autoPush` and the remote. |
| [Execution modes](execution-modes.md) | Supervised, autonomous, ACP transport and persistent host, semi-autonomous mode, the `striart acp` proxy, orchestration modes (`review`, `race`, `team`, `pipeline`), autonomous-mode guarantees, mode coexistence. |
| [Plans — tasks-as-code](plans.md) | The versioned YAML task graph: v1 and v2 plans (orchestration modes), syntax, validation, design guardrails. |
| [MCP server](mcp.md) | Driving Striart from Claude Code, Cursor, or any MCP host: the ten tools, the levels (read-only, bound to an agent, orchestrator), `--root`, the orchestration depth cap. |
| [Integrations](integrations/README.md) | Exact `striart mcp` and `striart acp` setup in Visual Studio, VS Code, Cursor, Xcode, Eclipse Theia, Devin Desktop (formerly Windsurf), JetBrains, Zed, Neovim, Emacs and Warp: coverage, limits, security, checked sources. |
| [Large projects](large-projects.md) | Keeping the disk cost of clones in check: hardlinks, partial clone, pnpm, retention. |
| [Troubleshooting](troubleshooting.md) | `striart doctor`, every error code by nature, conflict tickets, manual mode, `rollback`, `reconcile`, locks and state files, the native component, the dashboard. |

## Other documents

- [SECURITY.md](../../SECURITY.md) — threat model and trust boundaries.
- [CONTRIBUTING.md](../../CONTRIBUTING.md) — contributor guide.
- [CHANGELOG.md](../../CHANGELOG.md) — version history.
- [.env.example](../../.env.example) — exact configuration for every LLM provider.
- [examples/plan.example.yaml](../../examples/plan.example.yaml) — full commented YAML plan.

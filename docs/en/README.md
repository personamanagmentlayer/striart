# Striart Documentation

> Complete documentation for Striart, the multi-agent Git orchestrator.
> The root [README](../../README.en.md) is the showcase; all the detail lives here.
> 🇫🇷 [Documentation française](../fr/README.md) — the French version is the reference.

## Contents

| Page | Content |
|---|---|
| [Getting started](getting-started.md) | Prerequisites (Git repo, first commit, LLM), installation, `striart init`, first run, the "3 agents in parallel" guide. |
| [Architecture](architecture.md) | Why clones and not worktrees, the serialized chain, the flow of an agent commit, the 6 synchronization statuses, the inter-process lock, why auto-stash is safe. |
| [Commands](commands.md) | The 21 CLI commands in detail: options, safeguards, refusal codes. |
| [Configuration](configuration.md) | The full `striart.config.mjs` reference: every option, its default, LLM providers, overridable prompts. |
| [Branches and pipeline](branches.md) | `targetBranch` on any branch (`main`, `master`, `dev`…), the current-branch constraint, the staging → main pipeline (`striart promote`), `autoPush` and the remote. |
| [Execution modes](execution-modes.md) | Supervised, autonomous, ACP transport, semi-autonomous mode (human-arbitrated permissions), autonomous-mode guarantees, mode coexistence. |
| [Plans — tasks-as-code](plans.md) | The versioned YAML task graph: syntax, validation, design guardrails. |
| [MCP server](mcp.md) | Driving Striart from Claude Code, Cursor, or any MCP host; the orchestration depth cap. |
| [Large projects](large-projects.md) | Keeping the disk cost of clones in check: hardlinks, partial clone, pnpm, retention. |
| [Troubleshooting](troubleshooting.md) | `striart doctor`, error codes, conflict tickets, manual mode, `rollback`, `reconcile`, locks. |

## Other documents

- [SECURITY.md](../../SECURITY.md) — threat model and trust boundaries.
- [CONTRIBUTING.md](../../CONTRIBUTING.md) — contributor guide.
- [CHANGELOG.md](../../CHANGELOG.md) — version history.
- [.env.example](../../.env.example) — exact configuration for every LLM provider.
- [examples/plan.example.yaml](../../examples/plan.example.yaml) — full commented YAML plan.

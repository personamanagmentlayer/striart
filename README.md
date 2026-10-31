<h1 align="center">
  <img src="assets/logo_striart.png" alt="Striart" width="420">
</h1>

<p align="center">
  <strong>Multi-agent Git orchestrator</strong> for Claude Code, Aider, Cursor, and any other AI coding agent.<br>
  Physical isolation · Preventive routing · Semantic merging · Blocking Test Gate
</p>

<p align="center">
  <img alt="version 0.12.0" src="https://img.shields.io/badge/version-0.12.0-6e56cf">
  <img alt="Node.js ≥ 22.21" src="https://img.shields.io/badge/node-%E2%89%A5%2022.21-339933?logo=node.js&logoColor=white">
  <img alt="3293 tests" src="https://img.shields.io/badge/tests-3293-blue">
  <img alt="no build in development" src="https://img.shields.io/badge/build-none%20in%20dev-8250df">
  <img alt="MIT license" src="https://img.shields.io/badge/license-MIT-blue">
</p>

<p align="center">
  <a href="#why-striart--and-not-just-worktrees">Why Striart</a> ·
  <a href="#installation">Installation</a> ·
  <a href="#quick-start">Quick start</a> ·
  <a href="#documentation">Documentation</a> ·
  <a href="#golden-rules">Golden rules</a>
</p>

<p align="center"><em>🇫🇷 <a href="README.fr.md">Version française</a> — this is the default (English) README; the French version remains the content reference.</em></p>

When several AI agents work on the same repo in parallel, they trample each other:
Git conflicts, greedy commits, semantically broken merges. Striart solves this with three pillars:

1. **Physical isolation** — each agent works in a real, independent Git clone with no remote (`.striart/agents/<name>/`).
2. **Preventive Router** — before launching an agent, an LLM predicts which files will be touched and queues colliding tasks. It is a coarse filter, not a guarantee: safety rests on the merge and the Test Gate ([measurements](docs/en/architecture.md#what-the-router-and-the-semantic-merge-are-worth--measurements-of-2026-10-26)).
3. **Semantic merge + Test Gate** — agent commits are merged automatically; on conflict, an LLM merges the code; nothing is committed until `npm test` (or your command) passes.

Striart is not an opaque central brain: it's a **Git pacemaker**. The human sees everything and can interrupt, correct, or approve.

### The problems Striart solves

| Without Striart | With Striart |
|---|---|
| Two agents edit the same files; the conflict surfaces at merge time, after the work is done. | The **Router** predicts the files touched and queues colliding tasks **before** launch. |
| Landing N branches by hand, in the right order, rebasing the agents still running. | A **serialized merge chain** under a lock, and, under `striart watch`, an automatic rebase of every agent after each merge. |
| A conflict blocks — or worse, a "clean" merge breaks behaviour. | **3-way semantic merge** by LLM, then a **blocking Test Gate**: no commit without a green suite, otherwise abort + a complete human ticket. |
| A misbehaving agent (`reset --hard`, `gc`, secrets) damages shared state. | **Full clones** with no remote: the blast radius is the clone; secrets removed; protected paths for whatever configures the agent and Striart. |
| An autonomous session that overspends or runs unwitnessed. | **Token** budgets with caps (fail closed), heartbeat locks, crash recovery, human arbitration of permissions. |
| Every agent tool works its own way. | **20 ready presets** (Claude, Codex, Gemini, Copilot, Cursor, Aider…), drivable over **MCP** and **ACP**, including from the editor (`striart acp`). |

The landscape of similar projects (Claude Squad, Conductor, Nimbalyst, Weave,
Agent Client Protocol…) and **when to choose what** are in
**[docs/en/comparison.md](docs/en/comparison.md)**.

---

## Why Striart — and not just worktrees?

Isolating files is only part of the problem. A worktree (or a hand-made clone)
keeps two agents from writing to the same place *at the same time* — all the
rest stays on you, for every task: avoiding collisions *before* they happen,
bringing N branches back into the target branch, arbitrating conflicts,
guaranteeing nothing broken gets in. Striart automates precisely that rest.

| Need | Hand-managed worktrees | Claude Code subagents (built-in worktrees) | Striart |
|---|---|---|---|
| File isolation | ✅ | ✅ (zero friction) | ✅ full clones |
| Resilience to an agent going off the rails | ⚠️ shared `.git/`: a `reset --hard` or `gc` touches shared state | ⚠️ same | ✅ own refs/index, no remote, secrets excluded — blast radius bounded to the clone |
| Collision prevention | ❌ on you | ❌ depends on the model's task split | ✅ LLM Router + queue + `--after` dependencies |
| Getting work back into the target branch | ❌ manual merges | ❌ up to the agent | ✅ auto-merge, rebase of every agent after each `striart watch` merge, 3-way semantic merge |
| Quality gate | ❌ | ❌ | ✅ **blocking Test Gate** — nothing lands without a green suite |
| Multi-vendor | ❌ | ❌ Claude only | ✅ 20 ready presets (Claude, Codex, Gemini, Copilot, Cursor, Aider…) side by side |
| Lifespan | the session | the session | ✅ hours/days, multiple sessions, persistent queue |
| Observability & control | ❌ | session-bound | ✅ real-time dashboard (one-time sign-in link), token and cost ledger with ceilings, persistent logs, semi-autonomous (you arbitrate permissions), rollback |

The full reasoning (clones vs worktrees, nesting with Claude Code's
subagents, MCP/ACP symmetry) is in
**[docs/en/architecture.md](docs/en/architecture.md)**.

---

## Installation

From source:

```bash
git clone https://github.com/personamanagmentlayer/striart.git
cd striart && npm install && npm run native:build && npm link   # exposes the `striart` command
cd /path/to/my-project
striart init
```

Prerequisites: Node.js 22.21+ (native type stripping — nothing to compile on
the JavaScript side), Git, **a Git repository with at least one commit**, and
an LLM for the Router/Merger — local Ollama (default) **or** any cloud API. Striart
relies on a small signed **native binary** (Rust), verified before every run:
from source, `npm run native:build` builds it (Rust toolchain required); an
archive built by `npm run pack:release` embeds the prebuilt ones. Full details:
**[docs/en/getting-started.md](docs/en/getting-started.md)**.

---

## Quick start

```bash
cd my-project
striart init                          # creates .striart/, the config, then diagnoses

# Tab 1 — the orchestrator
striart watch                         # automatic merge + Test Gate + rebase

# Launch agents (the Router checks for collisions before each launch)
striart run "Refactor the authentication module" --command "claude" --open
striart run "Add Stripe billing" --agent billing --command "aider --model gpt-4o" --open

# ...and for a well-scoped task you don't want to babysit, Striart drives alone:
striart run "Add unit tests to src/parser.js" --autonomous --profile claude

# Several agents on ONE task: cross-review, race, team, pipeline
striart orchestrate review "Move auth to JWT" --author claude --reviewer codex

# Monitoring
striart status / queue / dashboard / usage / resolve
striart gc --dry-run                  # forgotten agents: idle sessions (closing is opt-in, with the user's authorization)
```

Striart is driven through **three distinct planes**: `striart mcp` (the agent
drives Striart, bound to its clone), `striart api` and `striart dashboard`
(the human drives Striart: Control Protocol, one-time sign-in link) and
`striart acp` (Striart as an ACP agent in Zed, JetBrains, Neovim, Emacs: an
editor session = an isolated clone + a merge under the Test Gate).

Scriptable exit codes (0 success, 1 failure, 2 usage, 3 refused by a guard),
`--json` on every command that has a result, help in English or French
(`STRIART_LANG`), bash/zsh/fish/PowerShell completion
(`striart completion <shell>`) — see [Commands](docs/en/commands.md#the-cli-contract).

---

## Documentation

The complete documentation lives in **[docs/en/](docs/en/README.md)**
(🇫🇷 [docs/fr/](docs/fr/README.md) — the French version is the reference),
and is also published as a browsable site:
**<https://personamanagmentlayer.github.io/striart/>**.

| Page | Content |
|---|---|
| [Getting started](docs/en/getting-started.md) | Prerequisites, installation, `striart init`, the "3 agents in parallel" guide. |
| [Architecture](docs/en/architecture.md) | Clones vs worktrees, serialized chain, commit flow, the 6 sync statuses, locks, state files, delivery outside the lock, the network layer, the three planes, native components, what the Router is worth, idle GC, observability. |
| [Commands](docs/en/commands.md) | The CLI contract (exit codes, `--json`, language, completion) and the 31 commands: options, safeguards, refusal codes. |
| [Configuration](docs/en/configuration.md) | Full `striart.config.mjs` reference: defaults and bounds, LLM providers, tokens, profiles, Router reliability, protected paths, terminal, MCP, orchestration, runtime overlap net, idle GC, delivery, Test Gate environment, enterprise network. |
| [Branches and pipeline](docs/en/branches.md) | `targetBranch` on any branch (`dev`, `master`…), staging → main pipeline. |
| [Execution modes](docs/en/execution-modes.md) | Supervised, autonomous, ACP, semi-autonomous, `striart acp`, orchestration modes (`review`, `race`, `team`, `pipeline`). |
| [Plans](docs/en/plans.md) | Tasks-as-code: the versioned YAML task graph (v1 and v2). |
| [MCP server](docs/en/mcp.md) | Driving Striart from Claude Code, Cursor, or any MCP host (bound to the calling clone). |
| [Integrations](docs/en/integrations/README.md) | Visual Studio, VS Code, Cursor, Xcode, Theia, Devin Desktop, JetBrains, Zed, Neovim, Emacs, Warp: MCP and ACP; VS Code extension delivered but not published. |
| [Striart compared](docs/en/comparison.md) | Problems solved, similar projects, and when to choose what (sources cited). |
| [Large projects](docs/en/large-projects.md) | Keeping the disk cost of clones in check. |
| [Troubleshooting](docs/en/troubleshooting.md) | `striart doctor`, every error code, tickets, `rollback`, `reconcile`, locks, enterprise network. |

---

## Golden rules

1. **Never push from an agent.** Clones are islands with no remote; only the orchestrator pushes.
2. **Never commit without a green Test Gate.** Even if the merging LLM is "sure of itself".
3. **Never delete a clone while an agent is working.** `striart clean` refuses at two levels: `IN_USE` (heuristic, `--force` possible knowingly) and `SESSION_LIVE` (verified fact — live autonomous session or `--open` terminal —, which **`--force` cannot override**).
4. **Mandatory human fallback.** 3 failed semantic merges in a row → manual mode until `striart resolve --unlock`, with a complete ticket per failure in `.striart/conflicts/`.

---

## Development

**3386 tests** (2226 unit + 1154 integration on real Git repos, plus 6
smoke tests of the built package — `pack` project —, counted by
`npx vitest list` on 2026-10-27; the badge counts them, it does not certify a
run), plus 87 end-to-end tests of the dashboard (`npm run test:e2e`, outside
`npm test`), `tsc` typecheck
over all the code (native TS + JSDoc-annotated JS), zero build step in
development — `bin` points at the source. Only the package built by `npm run pack:release` contains
emitted JS (`npm run pack:release`: Node refuses type stripping under
`node_modules`).

```bash
npm install
npm run native:build     # native binary (Rust toolchain) — required from source
npm run test:unit        # 2226 tests — the dev loop
npm run test:integration # 1154 tests — real temporary Git repos
npm run test:pack        # built package: pack → npm install → installed binary (network)
npm test                 # unit + integration (offline)
npm run lint             # ESLint (correctness) + Prettier --check
npm run test:ci          # typecheck + unit + integration with coverage, then package
npm run test:e2e         # dashboard end-to-end (Playwright + axe) — outside `npm test`, browser required
```

See [CONTRIBUTING.md](CONTRIBUTING.md) and [SECURITY.md](SECURITY.md).

MIT license.

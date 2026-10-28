# Getting started

> [Documentation](README.md) · Getting started

## Prerequisites

- **Node.js 22.21+** — Striart runs without a build step thanks to Node's
  native type stripping (TypeScript modules are executed as-is, on by default
  since 22.18); 22.21 is the floor because it is the first Node where
  `NODE_USE_ENV_PROXY=1` honors `HTTP(S)_PROXY` (corporate proxy: see
  [Configuration](configuration.md#enterprise-network-network)).
- **Git** — on the `PATH`.
- **A Git repository with at least one commit.** Striart initializes at the
  root of an existing Git repo (`striart init` looks for the root and fails
  otherwise), and agents are **real clones**: a repo without a single commit
  can neither be cloned nor provide a merge base — agent creation would fail.
  For a brand-new project:

  ```bash
  cd my-project
  git init -b main          # or -b dev, -b master… — see Branches and pipeline
  git add -A
  git commit -m "chore: initial state"
  ```

  The name of the created branch must match `targetBranch` in the config
  (default: `main`). Nothing mandates `main`: `master`, `dev`, or any other
  branch works identically — see **[Branches and pipeline](branches.md)**.
- **An LLM for the Router and the Merger** — local Ollama (default) **or**
  any cloud API (Anthropic, OpenAI, Azure, any OpenAI-compatible endpoint).
  See [Configuration](configuration.md#the-routermerger-llm).

## Installation

From source:

```bash
git clone https://github.com/personamanagmentlayer/striart.git
cd striart && npm install && npm run native:build && npm link   # exposes the `striart` command
```

A package built by `npm run pack:release` ships a small **native binary** (`striart-native`,
Rust) for its platform — Windows, macOS or Linux, on x64 or arm64 — installed
as an optional dependency and verified against a signed manifest before every
run: nothing to compile. From source, `npm run native:build` builds it (Rust
toolchain required, see CONTRIBUTING.md). `striart doctor` shows the selected
source and the verification state.

Without `npm link`, everything can also be called directly:
`node /path/to/striart/src/cli.js init`.

There is **nothing to compile on the JavaScript side**: `bin` points at the source (ESM). TypeScript
modules run as-is through Node's native type stripping, JSDoc-annotated `.js`
files coexist, and everything is checked by `tsc` — with no build step. The
published npm package, on the other hand, contains JS emitted at publication
time: Node refuses type stripping for files under `node_modules`.

## `striart init`

At the root of the target repo:

```bash
cd my-project
striart init
```

`init` is idempotent and never touches an existing file. It:

1. creates `.striart/` (gitignored): `agents/`, `conflicts/`, `logs/`,
   `queue.json`, `locks.json`, `agents.json` (the other folders — `usage/`,
   `reviews/`, `acp/`, `control/`… — are born on use);
2. adds `.striart/` to the repo's `.gitignore` if it isn't there yet;
3. generates `striart.config.mjs` **if no config exists** (cosmiconfig also
   accepts `striart.config.js`, `.striartrc.json`, etc.), then validates the
   config — an invalid config makes `init` fail;
4. chains the `striart doctor` diagnosis and shows only what needs an
   action: repository without a commit, missing target branch, unreachable
   LLM or missing API key… with the command to run. **Reported, never
   blocking**: initialization succeeds (exit 0), you can configure the LLM
   later.

Two settings to check before the first agent:

- **`testCommand`** — the Test Gate command, the one truly load-bearing
  setting: nothing is merged until it exits 0. On a project without a test
  suite, the default `npm test` will fail systematically — adjust it (see
  [Configuration](configuration.md)).
- **`targetBranch`** — the branch agents merge into (default `main`). The
  main repo must be **checked out on that branch** at merge time — see
  [Branches and pipeline](branches.md).

Then check everything:

```bash
striart doctor    # git, repo, config, target branch, LLM, secrets, locks, agents, tickets
```

## Guide: 3 agents in parallel without conflicts

```bash
cd my-project
striart init                          # creates .striart/, the config, then diagnoses

# Tab 1 — the orchestrator
striart watch                         # automatic merge + Test Gate + rebase

# Launch 3 agents (the Router checks for collisions before each launch)
striart run "Refactor the authentication module" --command "claude" --open
striart run "Add Stripe billing" --agent billing --command "aider --model gpt-4o" --open
striart run "New login component" --command "claude" --open
# without --agent, the name is derived from the prompt (e.g. refactor-the-authentic)

# ...and for a well-scoped task you don't want to babysit, Striart drives alone:
striart run "Add unit tests to src/parser.js" --autonomous --profile claude
```

`--open` starts a detached **pty host** that launches the tool in the clone,
then opens a tab (Windows Terminal, PowerShell console, Terminal.app,
gnome-terminal) that attaches to it through `striart attach <agent>`. The
session lives independently of the tab: closing it doesn't kill the agent,
and `striart attach <agent>` (from the clone) rejoins it. Without `--open`,
the exact command to run in the clone is printed.

From there, everything is automatic:

- Each agent commit is detected by `striart watch`, merged into the target
  branch, and validated by the **Test Gate** — if it fails, the merge is
  aborted and a ticket is created.
- On a textual conflict, the **semantic merge** (LLM) attempts a resolution,
  revalidated by the Test Gate. If the gate rejects the merge, the Merger
  **retries with the error log as feedback** (`semanticGateRetries`) before
  opening a human ticket. After 3 consecutive failures: manual mode (safety
  rule).
- Conflicts **beyond the LLM's reach** (file deleted on one side and modified
  on the other, concurrent rename, binary, lockfile, oversized file,
  submodule, symlink, diverging executable bit) never go to the LLM: direct
  human ticket stating the nature of the conflict.
- The **invisible double rename** (git misses both renames, the merge looks
  "clean" but the file comes out duplicated) is tracked by a content
  heuristic: `⚠️` warning at merge time + webhook, non-blocking.
- With `memoryLayer: true`, every merge feeds a **shared semantic memory**
  (`.striart-memory.md` in each clone): agents know which APIs the others
  just added or changed — the countermeasure to the *semantic* conflict that
  has no Git conflict. The file also carries a **real-time "work in
  progress" section**: the other tasks (active and queued) and their
  Router-predicted files — everyone sees who is working where, at zero LLM
  cost.
- When a task starts, **semantic links** are reported (never blocking): files
  importing each other — relative-import graph for **JS/TS, Python, Ruby,
  PHP** — and linked packages of an **npm/yarn, Cargo, Go (go.work), Maven**
  monorepo.
- After each successful merge, the other agents are **rebased** onto the
  latest code.
- If the Router had queued a task, it starts as soon as the blocking agent is
  stopped (`striart stop`).

## Real-time monitoring

```bash
striart status          # agents, sessions, mode, branches, pending commits, what needs a human
striart queue           # scheduler: RUNNING / WAITING + blockers
striart dashboard       # http://localhost:3456 — real-time web view (one-time sign-in link printed)
striart resolve         # conflict tickets awaiting human resolution
```

## Shell completion

```bash
striart completion bash >> ~/.bashrc          # zsh, fish, powershell too
```

Commands, options, agent names, ticket ids and profiles complete on Tab —
see [Commands](commands.md#striart-completion-shell).

## Going further

- [Architecture](architecture.md) — what happens under the hood on every commit.
- [Commands](commands.md) — the complete CLI reference.
- [Execution modes](execution-modes.md) — supervised, autonomous, ACP, semi-autonomous.
- [Troubleshooting](troubleshooting.md) — when something refuses to work.

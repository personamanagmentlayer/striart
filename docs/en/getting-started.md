# Getting started

> [Documentation](README.md) · Getting started

## Prerequisites

- **Node.js 22.18+** — Striart runs without a build step thanks to Node's
  native type stripping (TypeScript modules are executed as-is).
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
cd striart && npm install && npm link   # exposes the `striart` command
```

Without `npm link`, everything can also be called directly:
`node /path/to/striart/src/cli.js init`.

There is **nothing to compile**: `bin` points at the source (ESM). TypeScript
modules run as-is through Node's native type stripping, JSDoc-annotated `.js`
files coexist, and everything is checked by `tsc` — with no build step.

## `striart init`

At the root of the target repo:

```bash
cd my-project
striart init
```

`init` is idempotent and never touches an existing file. It:

1. creates `.striart/` (gitignored): `agents/`, `conflicts/`, `logs/`,
   `queue.json`, `locks.json`, `agents.json`;
2. adds `.striart/` to the repo's `.gitignore` if it isn't there yet;
3. generates `striart.config.mjs` **if no config exists** (cosmiconfig also
   accepts `striart.config.js`, `.striartrc.json`, etc.);
4. diagnoses the configured LLM — pings Ollama, or checks the API key for a
   cloud provider. **Warning only, never blocking**: you can initialize first
   and configure the LLM later.

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
striart doctor    # git, repo, config, LLM reachability, locks, tickets
```

## Guide: 3 agents in parallel without conflicts

```bash
cd my-project
striart init                          # creates .striart/, the config, checks the LLM

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

`--open` opens a terminal tab directly in the agent's clone (Windows
Terminal, Terminal.app, gnome-terminal) and launches the tool there. Each
session is independent: it stays open until **you** close it.

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
striart status          # agents, mode (auto/supervised), branches, tools, pending commits
striart queue           # scheduler: RUNNING / WAITING + blockers
striart dashboard       # http://localhost:3456 — real-time web view
striart resolve         # conflict tickets awaiting human resolution
```

## Going further

- [Architecture](architecture.md) — what happens under the hood on every commit.
- [Commands](commands.md) — the complete CLI reference.
- [Execution modes](execution-modes.md) — supervised, autonomous, ACP, semi-autonomous.
- [Troubleshooting](troubleshooting.md) — when something refuses to work.

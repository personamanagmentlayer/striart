# Striart compared with the alternatives

> State of the landscape as of **2026-10-26**, based on each project's public
> pages (links at the bottom). These tools move fast: the versions, licences
> and scopes quoted here must be **re-checked at the source** before any
> decision. Other tools' strengths are listed too — the right tool depends on
> the problem.

## The problem in one page

Running **several AI coding agents on the same repository** opens four fronts
that file isolation alone does not close:

1. **Collisions** — two agents edit the same files; you pay at merge time,
   after the work is done.
2. **Bringing the work back** — landing N branches on the target branch, in
   the right order, rebasing the agents that are still running.
3. **Semantic conflicts** — a merge with no Git markers can still break
   behaviour; a blocking conflict costs a human intervention.
4. **Trust** — nothing broken may land, and a misbehaving agent (reset, gc,
   secrets, configuration files) must not touch the other agents' state or the
   configuration that controls it.

The parallel-session managers surveyed below rely first on isolation (one
*worktree* per agent) and on displaying sessions, according to their public
pages. Striart covers all four fronts.

## What Striart brings

| Problem | Striart's answer |
|---|---|
| Two agents on the same files | **Preventive Router**: an LLM predicts the files touched; colliding tasks are queued (`--after`) before launch. |
| A misbehaving agent damages shared state | **Full clones** (not worktrees): own refs and index, no remote, secrets removed from the clone, hardlinked objects for a low disk cost. Blast radius = the clone. |
| N branches to land | **Serialized merge chain** under a lock; every agent is rebased after each `striart watch` merge. |
| Merge conflict | **3-way semantic merge** by LLM (by regions above a threshold), output validated. |
| Fear of an overconfident merge | **Blocking Test Gate**: never a commit without a green `testCommand`; otherwise `merge --abort` + a complete human ticket. |
| An agent edits what controls it | **Protected paths**: instructions, agent config and Striart config are refused before merge and before the gate. |
| Long, autonomous sessions | **Autonomous** mode (profiles, ACP), **token** budgets with caps (fail closed), heartbeat locks, crash recovery. |
| Several agent tools | **20 ready presets** (Claude, Codex, Gemini, Copilot, Cursor, Aider…) side by side; Striart favours none. |
| Several agents on ONE task | Orchestration modes: **cross-review, race, team, pipeline**, versioned YAML plans. |
| Visibility and control | Real-time dashboard (token, one-time link), `striart watch --ui`, permission arbitration, `rollback`, `doctor`. |
| Editor integration | **MCP** (the agent drives Striart, bound to its clone), **Control Protocol** (human), **ACP** client and `striart acp` proxy (Striart *is* the agent as seen by the editor). |

Philosophy: a **Git pacemaker**, not a central brain. The human sees
everything and can interrupt, correct and validate.

## Similar projects

### Parallel session managers (worktrees + interface)

| Project | What it is | Where it is strong | What it does not address (per its public pages) |
|---|---|---|---|
| **[Claude Squad](https://github.com/smtg-ai/claude-squad)** | Terminal app: several agents (Claude Code, Codex, Gemini, Aider…), one worktree + one tmux session each, review before applying. AGPL-3.0 (to be checked). | Simplicity, instant onboarding, multi-agent. | Collision prevention, assisted merge, test gate. |
| **[Conductor](https://conductor.build/compare/claude-code)** | Proprietary macOS app: isolated workspaces for Claude Code and Codex, review state, checks, PR flow. | Polished interface, end-to-end PR flow. | Single platform (macOS), proprietary. |
| **Crystal → [Nimbalyst](https://superset.sh/compare/conductor-vs-crystal)** | Open-source cross-platform app: Claude Code and Codex in parallel worktrees, in-app diff review and merge. The project was renamed (active development under Nimbalyst, per the sources — to be checked). | Cross-platform, built-in diff review. | Preventive routing, semantic merge. |
| **[Vibe Kanban](https://www.mindstudio.ai/blog/vibe-kanban-vs-paperclip-vs-claude-code-dispatch)** | Kanban board orchestrating agents in parallel worktrees. One source reports the vendor shut down in April 2026 (single source: verify). | "Task board" overview. | Same; check longevity. |
| **[bernstein](https://github.com/topics/git-worktrees)** | Deterministic orchestrator for CLI agents (no model in the coordination loop), one worktree per task, replayable runs. Beta per its listing. | Determinism, replayability. | LLM-assisted merge, built-in test gate. |

### Semantic merge and agents

| Project | What it is | Relation to Striart |
|---|---|---|
| **[Weave (Ataraxy Labs)](https://github.com/ataraxy-labs/weave)** | Git merge driver at **entity granularity** (functions, classes) via tree-sitter, no LLM; MCP server so agents can claim entities. Young (0.x versions). | A **deterministic** approach to the same false-conflict problem. Striart resolves the remaining conflicts by LLM *then* submits them to the Test Gate; the two approaches are not mutually exclusive. |
| **[Agent-proposed merge resolution](https://agentpatterns.ai/code-review/agent-proposed-merge-resolution/)** | Design pattern: the model's resolution is only a *proposal* until a build/test check has validated the tree that will actually land. | This is Striart's **Test Gate** principle, applied by construction to every merge. |

### Protocols and editors

| Project | Relation to Striart |
|---|---|
| **[Agent Client Protocol (Zed)](https://zed.dev/acp)** | Open standard (JSON-RPC over stdio, Apache 2.0) between editors and agents. Striart uses it both ways: ACP *client* (it drives the agent) and `striart acp` *proxy* (the editor sees Striart as an agent, with one clone, one merge and one gate per session). |
| **Claude Code built-in subagents and worktrees** | Zero friction for one session. Context is shared but isolation stops at the worktree (shared `.git/`), with no routing or gate (to be checked against Anthropic's documentation). Combines with Striart: an agent launched by Striart can use its own subagents. See [Architecture](architecture.md). |

## When to choose what

- **1–2 agents, clearly separated tasks**: hand-made worktrees or your tool's
  built-in support are enough. Striart is not needed.
- **You mainly want an interface to follow sessions**: Claude Squad, Conductor
  or Nimbalyst are more direct.
- **You want to reduce false merge conflicts deterministically**: Weave covers
  that part, without an LLM.
- **Several agents, several tools, unattended work, and the guarantee that no
  commit lands without a green test suite**: that is Striart's scope —
  prevention, landing the work, merge, gate, safeguards and observability in a
  single tool that runs locally (local LLM by default; a cloud LLM provider is optional).

## Sources

- [Running Parallel Claude Code Agents on a Single Codebase](https://medium.com/@koriigami/running-parallel-claude-code-agents-on-a-single-codebase-927d70e7349d)
- [Git Worktrees for AI Agents](https://pasqualepillitteri.it/en/news/7951/git-worktrees-ai-agents-claude-code-parallel)
- [Conductor vs Claude Code](https://conductor.build/compare/claude-code) ·
  [Conductor vs Crystal](https://superset.sh/compare/conductor-vs-crystal)
- [Claude Squad — README](https://cdn.jsdelivr.net/gh/smtg-ai/claude-squad@main/README.md)
- [Vibe Kanban vs alternatives](https://www.mindstudio.ai/blog/vibe-kanban-vs-paperclip-vs-claude-code-dispatch)
- [Weave — Ataraxy Labs](https://socket.dev/npm/package/@ataraxy-labs/weave) ·
  [Agent-Proposed Merge Resolution](https://agentpatterns.ai/code-review/agent-proposed-merge-resolution/)
- [Agent Client Protocol](https://zed.dev/acp)

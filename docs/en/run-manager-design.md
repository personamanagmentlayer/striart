# Design — Run Manager

> [Documentation](README.md) · Design — Run Manager
>
> **Status: shipped (v0.12.0).** All seven priorities below landed on
> `main` (PR #4) in the order this document lays out. Priorities 5 and 7
> shipped **scoped** to what could be delivered honestly rather than as
> originally sketched — see the note at the end of each of their sections.
> The rest of this document is kept as the design record; for the shipped
> behavior itself see [Plans](plans.md), [Commands](commands.md) (`striart
> draft`, `plan --resume`, `trace`, `work`) and
> [Configuration](configuration.md) (`agentProfiles.<name>.envAllow`).
> 🇫🇷 [Version française](../fr/conception-run-manager.md).

## Why

Striart already orchestrates the *agent → commit → semantic merge → Test
Gate → delivery* loop reliably (see [Architecture](architecture.md)). What's
missing to make it a true end-to-end orchestrator — objective → planning →
execution → verification → approval → integration → crash recovery — is a
**durable layer** connecting those steps and surviving a crash. Today:

- An interrupted v2 plan **does not resume**: `src/orchestration/store.ts`
  documents itself that the state persisted under
  `.striart/orchestration/{runs,groups}/` **"informs, decides nothing"** — it
  is never read back to drive execution. Relaunching a plan relaunches
  everything, including tasks already applied.
- Nothing arbitrates **non-Git** resources (a network port, a shared
  database, an external service): `src/lock.ts`/`locks.ts` only cover the
  main lock and file paths (`locks.json`).
- A task ends with a `GateResult` (one `testCommand`, green or red) and an
  `OrchestrationNodeResult` — nothing forces producing or keeping the
  evidence (acceptance criteria, exact diff, command output, review
  verdicts, cost) that justified the merge.
- An agent's session inherits the orchestrator's **full environment**
  (`src/session-env.ts`, a documented decision: "the agent tool needs its
  keys", see SECURITY.md): this is defense in depth, explicitly **not a
  sandbox**.

This document proposes closing these gaps, in an order that ships verifiable
value at each step rather than a one-shot rewrite.

## Overview

The three current security planes (human → Striart, agent → Striart,
Striart → agent — see [Architecture — three planes](architecture.md#three-planes-never-mixed))
and the serialized chain stay unchanged. A layer is added above:

```text
CLI / Dashboard / API
          │
          ▼
     Run Manager
  durable state + log
          │
     ┌────┴─────┐
     ▼          ▼
  Planner    Policy Engine
  objective   budgets, rights,
  → DAG       approvals
     │          │
     └────┬─────┘
          ▼
      Scheduler
 dependencies, priorities,
 collisions, resources
          │
          ▼
    Agent Runtime
 profiles, ACP, sandbox,
 checkpoints, cancellation
          │
          ▼
   Evidence Collector
 diff, tests, reviews, cost,
 artifacts, logs, verdict
          │
          ▼
 Merge Queue → Test Gates → Delivery
```

The Run Manager becomes the **functional source of truth** (the state of an
execution in progress). Git stays the source of truth for **code**;
`.striart/` keeps carrying evidence and transitions — but now **read back**,
not only logged.

**Naming**: the type `RunResult` already exists (`src/types.d.ts`, the
result of launching one task) and means something else than what this
document calls "Run". Use `PlanRunState`/`PlanRunRecord` (or equivalent) to
avoid the collision — to settle at implementation time.

## 1. Durable, resumable executions (priority 1)

Two explicit objects, persisted under the existing state lock
(`src/state-lock.ts`, atomic write via `src/json-file.js`):

```text
Run
├── initial objective
├── validated plan and its version
├── global budget
├── current state
├── tasks
├── events
└── final result

TaskRun
├── state
├── agent and workspace
├── attempt
├── dependencies
├── artifacts
├── evidence
└── error or human decision
```

Bounded state machine:

```text
PENDING → READY → RUNNING → VERIFYING → MERGING → SUCCEEDED
                 │          │
                 │          └→ REVIEW_REQUIRED
                 ├→ BLOCKED
                 ├→ FAILED
                 └→ CANCELLED
```

Every transition is persisted, idempotent and replayable. Add:

- `striart plan resume <run-id>` — resumes a run without relaunching
  `TaskRun`s already `SUCCEEDED`;
- checkpoints before launching an agent, before merge, before delivery;
- idempotency keys (task + attempt) to avoid duplicate clones or merges;
- distinct attempts instead of overwriting a task's history;
- automatic recovery via `reconcile` (already the name of an existing
  lock/state mechanism — reuse the vocabulary, not necessarily the code)
  after an orchestrator process crash.

**Closing criterion**: kill the process after every transition; resuming
duplicates no agent, no merge, no delivery, and reaches the same final state
as an uninterrupted run.

**Relation to what exists**: `src/orchestration/store.ts` is the natural
candidate to absorb into this layer rather than duplicate — its
`runs/`/`groups/` format becomes the basis of the new `Run`, read back
instead of only written.

## 2. Evidence bundle (priority 2)

The Test Gate stays mandatory and blocking, but a task must not be able to
declare itself "done" without evidence. Each `TaskRun` produces an
`EvidenceBundle`:

```text
- initial acceptance criteria;
- exact diff and commit;
- commands run and their results;
- tests added or changed;
- reviewer verdicts (already modeled for `review` — orchestration/verdict.ts);
- declared limitations;
- usage and cost (already measured, src/tokens/ — attach, don't recompute);
- artifacts needed to reproduce.
```

Multi-gate verification pipeline, risk-dependent:

```text
Format → types → targeted tests → integration tests
→ security → review → global Test Gate → merge
```

Missing evidence is a failure of that gate, never a silent success — the
same fail-closed philosophy as the rest of the project (see
[Architecture — golden rules](architecture.md#golden-rules)).

## 3. Planner (priority 3)

The Planner turns an objective into an **existing v2 plan** — don't create a
v3 format yet; have the Planner produce a valid v2 plan, then run it through
the current validator (`src/orchestration/plan-schema.ts`).

```text
User objective
      → repo analysis
      → DAG proposal
      → risk and cost estimate
      → schema validation
      → human approval
      → execution
```

The Planner must: break the objective into testable tasks, attach
acceptance criteria to each task, declare explicit dependencies (`after`,
already restricted to backward references by the current schema), propose
agent profiles (`agentProfiles`, existing catalog), estimate tokens/
duration/risk, flag uncertain areas, and **stop** if the objective is too
ambiguous rather than guess.

The human approves the plan and any overreach. **Structural guard**: the
Planner must never be able to change its own permissions or validate its
own output — the same principle as the three planes never mixing.

## 4. Deterministic scheduler (priority 4)

The LLM Router (`src/router.ts` and related modules) stays a **signal**,
never the coordination authority — the docs already say so: a coarse
filter, about half of touched files unpredicted with the default preset
(see [Architecture — what the Router and the merge are worth](architecture.md#what-the-router-and-the-semantic-merge-are-worth--measurements-of-2026-10-26)).

The Scheduler arbitrates from deterministic rules:

- graph dependencies (v2 plan);
- locks and protected paths (`protected-paths.ts`, already strict);
- predicted collisions (Router output, unchanged);
- actually observed overlaps (`src/overlap.ts`, already shipped);
- priorities and concurrency caps (the v2 plan already has `concurrency`);
- remaining budget (`src/tokens/budget.ts`, already shipped);
- agent availability and health (`ptyHostStatus`, `checkProcessInstance`);
- **shared non-Git resources**: database, ports, locked files, external
  services — **does not exist today**, to introduce as a new named lock
  kind (distinct from path locks), declared by the task profile or the
  plan.

**Closing criterion**: whatever the LLM answers (even wrong or absent),
dependencies, concurrency limits, budgets and protected paths stay
respected — the Scheduler never trusts the Router for a safety guarantee,
only for an optimization.

## 5. Policies and execution sandbox (priority 5 — a SECURITY.md decision first)

**This point contradicts a currently documented decision**, not just a gap:
`session-env.ts` deliberately inherits the orchestrator's full environment,
and SECURITY.md calls the model "defense in depth, not a sandbox".
Extending it must not happen in passing — this is an invariant change, so a
SECURITY.md review comes before any implementation, through [the process
already in place](architecture.md) for that kind of change.

If adopted, proposed execution profiles:

- filesystem limited to the workspace (the clone already is, for code —
  not the process itself);
- network denied by default or allow-listed **for the agent's own
  process** (`net.ts` already governs Striart's own outbound calls — not
  the hosted tool's);
- secrets handed out temporarily by a broker, never copied into the clone;
- explicit capabilities: read, write, terminal, browser, API access;
- CPU, memory, process and time limits (the native process container,
  `job run`, already bounds and kills a process tree — extend it, don't
  reinvent it);
- logging of sensitive actions;
- human approval before any escalation.

**Required controls** if implemented: a hostile task must not be able to
read outside its scope, retrieve the orchestrator's secrets, push, or
approve its own result.

> **Shipped, scoped**: `agentProfiles.<name>.envAllow` (a declarative
> inherited-environment allowlist) only — the real, honest,
> platform-independent piece. Filesystem/network/process sandboxing for the
> hosted tool is **not** implemented; SECURITY.md still calls the model
> "defense in depth, not a sandbox". See
> [Configuration](configuration.md#agent-profiles-agentprofiles) and
> SECURITY.md.

## 6. End-to-end observability (priority 6)

A shared identifier across the existing dashboard and registries:

```text
run_id → task_id → attempt_id → session_id → commit_sha
```

Every run should answer: why was this task created? why was this agent
chosen? why did it wait? what data was sent to the LLM? what evidence
allowed the merge? what did the result cost? can it be replayed?

Then measure real value: merged-task rate, human interventions, crash
recoveries, rollbacks, cost per merged task, defects that crossed the
gates.

## 7. Remote workers and multi-repo (priority 7)

Out of scope for this document for now — entirely dependent on priorities
1–6 (a non-durable Run Manager can't distribute without double execution).

> **Shipped, scoped**: `striart work <file> [--run <run-id>]` —
> cooperative workers (several independent processes sharing the same
> `.striart/` directory, on one machine or several) draining one run
> together via an atomic claim, never a network protocol, authentication,
> or cross-repository execution. See [Plans](plans.md#cooperative-workers)
> and [Commands](commands.md#striart-work-fileyaml---run-run-id).

## Build order

| Priority | Increment | Verifiable result |
|---|---|---|
| 1 | Durable Run Manager | Crash and resume without duplication |
| 2 | Evidence bundle | No success without criteria and artifacts |
| 3 | Planner producing v2 plans | Objective turned into a validated DAG |
| 4 | Deterministic scheduler | Constraints respected even when the Router is wrong |
| 5 | Policies and sandbox | A hostile task stays confined (SECURITY.md decision first) |
| 6 | Observability and benchmarks | Decisions measured on real runs |
| 7 | Remote workers and multi-repo | Distribution without double execution |

Don't start with Kubernetes, microservices, or a distributed rewrite. The
first genuinely "complete" version is simply: give an objective, approve a
plan, let Striart run it, resume it after a crash, and get an evidence
bundle explaining every merge. It's the durable Run Manager, not a more
powerful LLM, that is the priority foundation.

## Scope of this branch

This document alone, originally — it was meant to validate the target and
the order before starting priority 1 in a separate branch. The seven
priorities above were then implemented, each its own commit, on
`feat/run-manager`, and merged to `main` in PR #4 (v0.12.0).

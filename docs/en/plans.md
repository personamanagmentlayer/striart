# Plans — tasks-as-code

> [Documentation](README.md) · Plans

Instead of retyping a sequence of `striart run`, describe a **task graph** in
a YAML file committed with the code — inspired by Bruno (API collections as
text files co-located with the repo): you diff it, review it in a PR, replay
it.

```yaml
# auth-rework.yaml
version: 1
tasks:
  - id: schema
    prompt: |
      Add a jwt_version column to the users table.
  - id: auth
    prompt: Move authentication to JWT.
    after: schema          # SEMANTIC dependency (no file collision would infer it)
  - id: tests
    prompt: Add tests for the JWT flow.
    after: auth
    autonomous: true       # Striart drives the tool
    profile: claude
```

```bash
striart plan auth-rework.yaml --dry-run   # validate and print, launch nothing
striart plan auth-rework.yaml             # apply
```

## Semantics

`apply` is **exactly equivalent** to the sequence of `striart run` it
describes, with plan `id`s resolved to agent names for `after`: no new
semantics, it composes the queue, `--after` and `reconcile`.

Task fields:

| Field | Role |
|---|---|
| `id` | **Plan-local** alias, target of an `after` — resolved to the real agent name at apply time, never used as the name itself. |
| `agent` | Agent name (optional, derived from the prompt if absent). |
| `prompt` | The task's prompt (scalar or YAML literal block). **Data**, never interpreted. |
| `after` | Reference to a task **defined earlier** in the file. The task waits in the queue until the referenced work finishes (merge + stop). |
| `autonomous` | `true` → Striart drives the tool ([autonomous mode](execution-modes.md)). |
| `profile` | The `agentProfiles` profile to use for an autonomous task. |
| `command` | Coding tool for a supervised task (equivalent to `--command`). |
| `timeout` | With `autonomous`: max session duration in ms (takes precedence over `autonomousTimeoutMs`). |

## Two design guardrails

- **A plan is data, never code** — no executable file: a plan travels
  (commit, PR, sharing), and executing it would be the config-as-code hole.
  The prompt stays data; an autonomous task references a **profile**
  (admin-defined in the config), never a raw shell command.
- **`after` can only reference a task defined earlier** in the file — a
  simple rule that makes the graph acyclic by construction. Full validation
  happens **before** any application: an invalid plan applies no task.

Full commented example:
[`examples/plan.example.yaml`](../../examples/plan.example.yaml).

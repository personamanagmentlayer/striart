# Commands

> [Documentation](README.md) · Commands

First the **CLI contract** (global options, exit codes, machine output,
language and display, completion), shared by every command; then the
commands in detail, by functional group. Every mutating operation (`run`,
`merge`, `sync`, `stop`, `promote`, `resolve --apply`, `lock --start`, queue
retry) goes through the [inter-process lock](architecture.md#inter-process-lock)
— two concurrent CLIs never trample each other.

**31 public commands**, grouped in the help (`striart --help`) as below
(counted on 2026-10-27 from `node src/cli.js --help`, `help` excluded). A
single hidden internal command is never meant for a human: `__complete`
(dynamic values for the completion scripts). `pty-host-run`, the former
internal command that launched the pty host, was removed: the host is now
the native binary `striart-native pty-host` (see
[Architecture](architecture.md#native-components-rust)).

| Command | Role |
|---|---|
| **Setup and diagnosis** | |
| `striart init` | Initializes `.striart/` and the config, then reports whatever would make the first command fail. |
| `striart doctor` | Full diagnosis — "why doesn't it work?". |
| `striart completion <shell>` | Completion script (bash, zsh, fish, PowerShell). |
| **Launching agents** | |
| `striart start <agent> [--command <cmd>] [--open] [--allow-historical-secrets]` | Isolated clone + task branch, no Router. |
| `striart start <agent> --reuse [--force]` | Reuses the kept clone of a stopped agent. |
| `striart run "<prompt>" [--agent <a>] [--command <cmd>] [--open] [--after <ref>] [--reuse [--force]] [--allow-historical-secrets]` | Preventive Router: predicts the files, starts or queues. |
| `striart run "<prompt>" --autonomous [--profile <p>] [--timeout <ms>]` | Autonomous mode: Striart drives the tool end to end. |
| `striart run "<prompt>" --on-main [--profile <p>] [--timeout <ms>]` | Runs the agent DIRECTLY on the main repo (no clone), under a protected session. |
| `striart attach <agent>` | Attaches the terminal to an agent's owned pty (session opened by `--open`). |
| `striart plan <file.yaml> [--dry-run] [--mode <m>] [--concurrency <n>] [--on-failure <p>] [--resume <run-id>]` | Tasks-as-code: applies a versioned YAML plan (v1, or v2: orchestration modes); `--resume` replays an interrupted v2 run without rerunning finished tasks. |
| `striart draft "<objective>" [--out <file>]` | Planner: proposes a validated v2 plan for an objective — writes a file, starts nothing. |
| `striart profiles [--catalog \| --detect \| --import-acp <id>]` | Configured agent profiles; preset catalog; installed tools; import of an ACP registry agent. |
| **Orchestrating** | |
| `striart watch [--no-merge]` | Watches commits, merge + Test Gate + rebase continuously. |
| `striart watch --daemon \| --status \| --stop` | Background watcher (PID file, log, orphan detection). |
| `striart watch --ui` | Interactive Ink panel on top of the watcher: per-agent pty tail, `/` commands, `!` shell, `@agent` messages. |
| `striart merge <agent>` | Manual merge of an agent's latest commit, behind the Test Gate. |
| `striart sync [agent]` | Rebases one agent (or all) onto the target branch. |
| `striart stop <agent> [--force]` | Ends an agent (the clone stays on disk), unblocks the queue. |
| `striart orchestrate <mode> <prompts...>` | One-command orchestrated task: `review`, `race`, `team` or `pipeline` (a one-node v2 plan). |
| `striart review [<id>] [--approve \| --request-changes \| --reject] [--comment <t>]` | Human reviews of a `review` task: list, give a verdict. |
| **Observing** | |
| `striart status` | Overview: agents, sessions, queue, tickets, manual mode, reserved repo. |
| `striart queue [--retry]` | Started and waiting tasks, with what blocks them; `--retry` starts the unblocked ones. |
| `striart history [--limit <n>]` | Merge/rollback history, rebuilt from the Git graph. |
| `striart usage [--since <p>] [--until <p>] [--role <r>] [--agent <a>] [--task <id>]` | Token usage and cost, from the `.striart/usage/` ledger. |
| `striart dashboard [--port <p>] [--daemon \| --status \| --stop \| --link]` | Real-time local web dashboard (127.0.0.1, SSE) behind a one-time sign-in link, + control. |
| **Repairing and cleaning** | |
| `striart rollback` | Undoes the last Striart merge (local reset or revert). |
| `striart resolve [--unlock \| --close <id> \| --prepare <id> [--accept-theirs <path>…] \| --apply <id>] [--all]` | Conflict tickets: list, prepare, apply behind the Test Gate. |
| `striart lock [--start <reason> [--pid <n>] \| --stop]` | Reserves/releases the main repo for direct work. |
| `striart clean [agent] [--stopped \| --all] [--force]` | Frees disk space (two-level guards). |
| `striart reconcile` | Idempotent reconciliation of the whole state (dead sessions, queue, locks). |
| `striart prune [--days <n>] [--dry-run]` | Retention of idle stopped clones and resolved tickets. |
| `striart gc [agent] [--close] [--dry-run]` | Idle garbage collector: detects forgotten agents, warns them and, with the user's authorization, cleanly closes their session (never their clone). |
| **Integration** | |
| `striart promote [--rollback]` | staging → main promotion (global Test Gate + fast-forward). |
| `striart mcp [--root <path>] [--agent <a>] [--read-only [--collab]]` | MCP stdio server (agent → Striart plane: 10 tools, 4 resource kinds), bound to the calling clone. |
| `striart api --stdio [--framing <f>] \| --schema [openrpc\|json-schema]` | Striart Control Protocol v1 on stdio, for IDE extensions (human plane). |
| `striart acp [--root <path>] [--profile <p>]` | Striart as an ACP v1 agent for an editor (Zed, JetBrains, Neovim, Emacs…): an isolated clone + the upstream agent + a merge under the Test Gate. |
| `striart hook install\|uninstall <tool> (--user \| --agent <a>)` | Advisory hooks for coding tools (collisions, end of session) — the `hook <tool> <event>` sub-mode is called by the tool itself. |

---

## The CLI contract

### Global options

Valid on every command, before or after the command name:

| Option | Effect |
|---|---|
| `-v`, `--version` | Prints the version (`-V`, the historical alias, is only recognized at the head of the line, before the command). With `--json`: the contract's `{command: "version", data: {version}}` document, never the bare version. |
| `--json` | Machine output: one JSON document on stdout (ndjson stream for `watch` and `dashboard`) — see below. |
| `--plain` | Plain text: no color, glyph or link (CI logs, screen readers, legacy consoles). |
| `--no-color` | Disables color (like `NO_COLOR`). |
| `-q`, `--quiet` | Suppresses progress messages — never errors or data. |
| `-h`, `--help` | Command help, with examples. |

`striart help` and `striart help <command>` print the help and exit **0**;
`striart help <unknown>` is a usage error (`UNKNOWN_COMMAND`, exit 2), as is
`striart hook install <unknown tool>` (`HOOK_TOOL_UNKNOWN`, exit 2).

Anything after `--` is data: a prompt may contain "--json" without turning
machine output on. Likewise, a global option only affects the command being
run if parsing the line recognizes it as an option: the value of another
option (`lock --start=--json`, `lock --start -V`, where "--json" and "-V"
are the reason) stays a value, and `-V` anywhere but at the head does not
print the version.

**Human-only gestures.** `resolve`, `merge`, `stop`, `lock`, `rollback` and
`promote` are refused inside a Striart agent session
(`CONTROL_NESTED_SESSION`, exit 3, detected through `STRIART_SESSION=1`): an
agent does not approve its own ticket, release a lock or undo a merge. This
guard is *advisory* (see [SECURITY.md](../../SECURITY.md)). Same rule for
`api`, `acp` and `dashboard`.

**The repository's `.env`.** The CLI reads the `.env` at the repository root
as untrusted data: only an allowlist (`*_API_KEY` keys, the display variables
`STRIART_LANG`/`THEME`/`ASCII`/`NO_ANIMATION`, webhooks) is applied, a denylist
(`NODE_*`, `LD_*`, `PATH*`, `STRIART_NATIVE_BIN`…) always wins, a variable
already defined in the shell is never overwritten, and nothing is loaded in an
agent clone or inside a Striart session. Skipped names are reported on stderr
— see [Configuration](configuration.md) and `env.allow`.

### Exit codes

Decided in a single place (`src/cli/exit.ts`), classified by **nature**, not
by status — a new status falls into an existing class:

| Code | Meaning |
|---|---|
| `0` | Intent reached, **or a deferral by design**: task queued, rebase postponed, already up to date. |
| `1` | Execution or environment failure (git, LLM, disk, config, missing target) — retrying may be enough. |
| `2` | Invalid usage, rejected **before any action**: unknown option, out-of-range value, incompatible options. |
| `3` | **Refused**: a Striart guard protected work — merge conflict, red Test Gate, unmerged work, live session, historical secret… Retrying as-is changes nothing: a human decision is needed. |
| `130` / `143` | Interrupted by SIGINT (Ctrl+C) / SIGTERM (POSIX 128 + n convention, applied on Windows too). |

Direct consequence: `striart merge agent-a && npm run deploy` never deploys
after a red Test Gate (exit 3). The fine detail is in the `--json` document
(`data.status`, `error.code`).

Notable cases: `striart sync` exits 0 on a postponed or conflicting rebase
(the merge will catch up) and 3 on `STASH_CONFLICT`; `striart doctor` exits
1 as soon as a prerequisite is missing (warnings do not change the code);
`striart plan` returns the worst outcome of its tasks; in autonomous mode,
`MERGED` and `QUEUED` exit 0; `MERGE_BLOCKED`, `COMMIT_REFUSED`, a session
stopped by a token ceiling (`BUDGET_EXCEEDED`, also for `run --on-main`), a
session whose failure has a *refusal* cause (ACP agent not signed in:
`ACP_AUTH_REQUIRED`) and every case where `commitPolicy: 'human'` hands the
work back to the human — `KEPT` (`HUMAN_REVIEW_REQUIRED` when the agent
committed) or an empty session — exit 3; a failed, timed-out, interrupted or
empty session (outside `human`) exits 1. For an orchestrated node
(`orchestrate`, v2 plan), 3 also covers `REVIEW_REJECTED`, `REVIEW_EXHAUSTED`,
`VERDICT_INVALID`, `READ_ONLY_VIOLATION`, `SCOPE_VIOLATION`,
`TEAM_COMMIT_FORBIDDEN`, `RACE_NO_WINNER` and `KEPT`: a guard spoke, not an
incident. A node in `ERROR` follows the nature of the error code it carries
(`SESSION_LIVE`, `AGENT_EXISTS`… → 3). A wait for the main lock cancelled by Ctrl+C exits 130 (the signal
wins over the `LOCK_WAIT_CANCELLED` nature).

Values are strictly validated **before** any call into the domain (exit 2):
`--days 7d`, `--pid 12abc` or `--timeout 5000abc` are refused. Bounds:
`--timeout` from 1,000 ms to one week, `--port` from 0 to 65,535, `--limit`
from 1 to 10,000, `--days` from 0 to 36,500, `--pid` a positive integer,
`--concurrency` from 1 to 64, `--max-rounds` and `--rounds` from 1 to 10.
Agent names (`<agent>`, `--agent`) follow the `[a-z0-9][a-z0-9_-]` pattern
(64 characters at most), ticket ids the name of their directory.

### Machine output: `--json`

Every command that produces a result accepts `--json` and writes **a single
document** to **stdout** — errors included:

```json
{ "schemaVersion": 1, "command": "merge", "ok": true, "data": { "status": "MERGED", "…": "…" } }
{ "schemaVersion": 1, "command": "merge", "ok": false, "error": { "code": "MAIN_DIRTY", "kind": "refusal", "message": "…", "hint": "git status", "details": { } } }
```

- `ok` is `true` only for an exit-0 outcome; a merge with a red Test Gate
  returns `ok: false` with `data.status: "GATE_FAILED"`.
- `error.kind` is `usage`, `refusal` or `failure` — the same classification
  as exit codes 2, 3 and 1.
- `warnings` (present only when there are some) lists non-blocking warnings
  (`{code, message}`), for instance `DEPRECATED_OPTION` or
  `TERMINAL_OPEN_FAILED`.
- `error.details` carries identifiers only (agent, ticket, path, PID…) and
  additionally goes through **defensive redaction**: any field whose name
  suggests a secret (env, value, profile, headers, URL, token, password, API
  key…) is replaced with `"[redacted]"` — see [SECURITY.md](../../SECURITY.md).
  One exception: `profile` stays readable when it is a well-formed profile
  **name** (`[A-Za-z0-9][A-Za-z0-9._-]{0,63}`, a config identifier that
  `striart profiles` publishes); a profile definition (object: command,
  `env`) stays redacted.
- When one code covers several causes, `error.details.reason` tells them
  apart with a **stable** sub-code that is part of the contract (a script
  should test it, not the text):
  - `PLAN_INVALID`: `YAML`, `NOT_AN_OBJECT`, `UNSUPPORTED_VERSION` (only
    versions 1 and 2 exist), `TASKS_EMPTY`, `TASK_NOT_AN_OBJECT`,
    `VERSION_MISSING` (no `version:` line — `version: 1` or `version: 2`
    expected), `PROMPT_MISSING`, `FIELD_NOT_STRING`, `AUTONOMOUS_NOT_BOOLEAN`,
    `TIMEOUT_INVALID`, `DUPLICATE_ID`, `AFTER_FORWARD`,
    `COMMAND_NOT_AN_EXECUTABLE_NAME` (the `command` of a supervised task must
    be an **executable name** — `[A-Za-z0-9][A-Za-z0-9._+-]{0,63}`, no path,
    space or option — in v1 and v2 alike: it is typed into the pty's hosted
    shell; options go in `agentCommand` or a profile) — with, depending on
    the case, `task` (position in the file), `taskId`, `field`, `id`,
    `after`, `version` or `cause` (the YAML parser's message), never a
    task's content. The `version: 2` plan adds `UNKNOWN_KEY`, `MODE_INVALID`,
    `OVERRIDES_NEED_V2` (`--mode`, `--concurrency` or `--on-failure` on a v1
    plan), `CONCURRENCY_INVALID`, `ON_FAILURE_INVALID`, `KIND_UNKNOWN`,
    `AFTER_INVALID`, `AGENT_INVALID`, `COMMAND_AUTONOMOUS_CONFLICT`,
    `PROFILE_NEEDS_AUTONOMOUS`, `SPEC_NOT_AN_OBJECT`, `FIELD_NOT_BOOLEAN`,
    `REVIEWERS_MISSING`, `REVIEWERS_TOO_MANY`, `HUMAN_REVIEWER_PROFILE`,
    `QUORUM_INVALID`, `ROUNDS_INVALID`, `NAME_INVALID`, `NAME_RESERVED`,
    `NAME_DUPLICATE`, `STEPS_MISSING`, `STEPS_TOO_MANY`, `STEP_ID_INVALID`,
    `STEP_ID_DUPLICATE`, `HANDOFF_INVALID`, `PROMPT_FORBIDDEN`,
    `CANDIDATES_TOO_FEW`, `CANDIDATES_TOO_MANY`, `PICK_INVALID`,
    `LOSERS_INVALID`, `ROLES_TOO_FEW`, `ROLES_TOO_MANY`, `CADENCE_INVALID`,
    `CADENCE_UNAVAILABLE`, `PARALLEL_SCOPE_MISSING` and `SCOPE_INVALID`;
  - `CONFIG_INVALID`: `UNKNOWN_KEY` (unknown top-level key, with `key` and
    `suggestion`), `INVALID_VALUE` (with `key`, and `field` for a nested
    field: `agentProfiles.<name>.<field>`, `acpAgent.<field>`),
    `UNREADABLE` (with `cause`), `SAME_BRANCH` (`promote`: `mainBranch` =
    `targetBranch`), `HOST_PATTERN` (`dashboardAllowedHosts`: with
    `problem` — the refused pattern — and the entry **index**, never its
    value);
  - `LLM_CONFIG_INVALID`: `UNKNOWN_PROVIDER`, `NO_MODEL`, `NO_BASE_URL`,
    `NO_API_KEY` (with `provider` and, for the last one, the **name** of the
    `apiKeyEnv` variable, never its value);
  - `PROFILE_INVALID`: `COMMAND_EMPTY`, `ARGS_NOT_STRINGS`,
    `PLACEHOLDER_MISSING`, `PLACEHOLDER_FORBIDDEN`, `ACP_TRANSPORT`,
    `ACP_OPTION_INVALID`, `INSTRUCTIONS_CHANNEL_TRANSPORT`,
    `INSTRUCTIONS_FLAG_MISSING` and `ACP_ELICITATION_NEEDS_ASK` (with
    `field`);
  - `LOCK_TIMEOUT` (main lock): `HELD` (held by a running operation),
    `HOLDER_FROZEN` (live holder whose heartbeat is frozen — never broken),
    `LOCK_UNREADABLE`, `BREAK_IN_PROGRESS`, `BREAK_FAILED`;
    `STATE_LOCK_TIMEOUT` (state lock): `HELD`, `LOCK_UNREADABLE`,
    `BREAK_IN_PROGRESS`, `BREAK_FAILED` (no `HOLDER_FROZEN`: a live holder is
    never broken, the wait simply expires);
  - `NATIVE_UNAVAILABLE` (`DEV_BUILD_MISSING`, `PACKAGE_MISSING`,
    `PLATFORM_UNSUPPORTED`, `PLATFORM_NOT_PUBLISHED`, `ENV_NOT_ABSOLUTE`,
    `ENV_MISSING`, `BINARY_MISSING`), `NATIVE_INTEGRITY_FAILED`
    (`DIGEST_MISMATCH`, `SIGNATURE_INVALID`, `SIGNATURE_UNREADABLE`,
    `MANIFEST_MISSING`, `PACKAGE_VERSION_MISMATCH`,
    `MANIFEST_VERSION_MISMATCH`) and `NATIVE_COMMAND_FAILED` (`TIMEOUT`,
    `SPAWN`, `NO_REPORT`);
  - `PTY_SHELL_INVALID`: `RELATIVE_PATH`, `NOT_EXECUTABLE`, shell not found;
    `ORCHESTRATE_USAGE`: `OPTION_NOT_FOR_MODE`, `MISSING_OPTION`;
    `USER_CONFIG_INVALID`: the plain-text cause, with the faulty `key`.

  Unreadable state files (`REGISTRY_CORRUPT`, `QUEUE_CORRUPT`,
  `LOCKS_CORRUPT`, `STATE_CORRUPT`, `MAIN_SESSION_CORRUPT`, `TICKET_CORRUPT`,
  `COLLAB_CORRUPT`, `REVIEW_CORRUPT`, `ORCHESTRATION_STATE_CORRUPT`) carry
  `path` and `cause` (the JSON parser's error). The error message itself
  remains human text outside the contract, translated per `STRIART_LANG`
  without losing the actionable detail (faulty field, task, cause).

The document's `schemaVersion` stays **1**: no field changed meaning since
0.11. The additions of the 2026-10-24 wave are additive (`status --json`
gains `orchestration` and `tokens`, `doctor` gains the `native`, `gate`, `pty`,
`state-lock`, `protected`, `mcp`, `profiles`, `tokens`, `orchestration`,
`dashboard` and `relaxations` checks, then, on 2026-10-26, `network`,
`state-privacy` and `gate-env`, then, on 2026-10-27, `idle`, `delivery` and
`performance`: 29 checks). The published schemas
(`schemas/striart-document-v1.schema.json` for this document,
`schemas/striart-control-v1.openrpc.json` for the Control Protocol) ship in
the package and are printed by `striart api --schema`. The `$id` of the
document schema is `urn:striart:schema:document:v1`: a neutral identifier
(neither a private infrastructure URL nor an address to resolve); it is part
of the contract, like `schemaVersion`.

`watch` and `dashboard` (long-running commands) write an **ndjson stream**:
one line per event, `{schemaVersion, command, type, at, data}` — `watch`
emits `started`, `commit`, `merge`, `merge-skipped`, `merge-deferred`
(`data: {agent}`, see [`watch`](#striart-watch---no-merge)), `merge-error`, `sync`,
`reconcile`, `reconcile-error`, `behind`, `fetch-error`; `dashboard` emits
`listening` (`data: {url, port}`, plus `signInUrl` and `expiresAt` in the foreground). The stream ends with an `end` event
(`data: {ok, outcome, interrupted}`).

Five commands have **no** machine output, by nature: `mcp`, `api` and `acp`
(stdout is the protocol), `attach` (raw terminal) and `completion` (the
script is already the data). With `--json` they refuse with
`UNSUPPORTED_OUTPUT_FORMAT` (exit 2), as does `watch --ui`. (`striart api`
nevertheless returns the same wrapped document for every Control Protocol
method result: the protocol is the output.)

Human text is **outside the contract**: it may change between versions. Only
the `--json` document, the exit codes and the error codes are stable.
**Deliberate break in 0.11**: the four `--json` outputs that existed before
(`status`, `doctor`, `history`, `profiles`) are now wrapped — read `data`
instead of the root.

### Streams and logs

stdout carries only the command's **data** (human result, `--json` document,
MCP protocol); progress, warnings, errors (outside `--json`) and pino logs go
to **stderr**. That includes what precedes the result of a long command: the
`watch` **banner** ("watcher running…" and its mode) and the **introduction** of
`run --autonomous` / `run --on-main` are status lines, hence on stderr (silent
under `--json`, where the document or stream carries the information). The pino
logs themselves are in French whatever `STRIART_LANG` says: they do not go
through the i18n catalog (help, error and rendering messages only). `striart status | grep agent-a` or `striart merge a --json |
jq` never see a progress line. `STRIART_LOG_LEVEL=debug` details the logs on
stderr (`trace`, `debug`, `info` by default, `warn`, `error`, `fatal`,
`silent`). Under `watch --ui` the screen belongs to the panel: logs go to
`.striart/logs/watch-ui.log`.

### Language, colors, terminal

| Variable | Effect |
|---|---|
| `STRIART_LANG=fr\|en` | Language of messages and help. Without it: `LC_ALL`, `LC_MESSAGES`, `LANG`, then the system locale; any language other than French shows English. |
| `STRIART_THEME=default\|colorblind\|mono` | Palette: `colorblind` never pits red against green (blue/magenta), `mono` only uses bold, dim and underline. |
| `NO_COLOR`, `FORCE_COLOR` | Color ([no-color.org](https://no-color.org)). **Precedence: `NO_COLOR` (non-empty) > `FORCE_COLOR` (`0`/`false` disables) > `TERM=dumb` > interactive terminal.** `TERM=dumb` forces `plain` mode (no glyph, link or animation) but does not forbid an explicitly forced color: `FORCE_COLOR=1 TERM=dumb` colors, without glyphs. stdout and stderr are decided separately. |
| `STRIART_ASCII=1` | ASCII glyphs instead of ✓ ✗ → … (automatic on the legacy Windows console and `TERM=linux`) — **help included** (typographic arrows, dashes and quotes of `--help` and static texts; never data: file names, commit messages). |
| `STRIART_NO_ANIMATION=1` | No animated progress indicator (also off in CI and outside a terminal). |
| `FORCE_HYPERLINK=0\|1` | OSC 8 clickable links on paths (tickets, clones), otherwise detected (Windows Terminal, VS Code, iTerm2, WezTerm, kitty, ghostty, recent VTE). |

A line's level is always carried by a **word** ("ok", "warning", "error"):
glyph and color only double it — readable by a screen reader, with color
blindness, in a CI log. Tables adapt to the terminal width (secondary
columns drop first, never the identifier) and are never truncated outside a
terminal. Under Windows Terminal and ConEmu a long operation also shows in
the tab's progress bar (OSC 9;4). Any untrusted text displayed (an agent's
commit message, a path, git output, a reservation reason) is neutralized:
its control characters appear in visible `\xNN` form instead of driving the
terminal.

The `.env` file is loaded from the **repository root** (not the current
directory); a variable already set in the shell wins. It is filtered through an
allow-list (`*_API_KEY` keys, webhooks, display variables): see
[Configuration](configuration.md#the-routermerger-llm).

### `striart completion <shell>`

Writes to stdout the completion script for `bash`, `zsh`, `fish` or
`powershell`, generated from the real command tree (never a hand-maintained
list):

```bash
striart completion bash >> ~/.bashrc
striart completion zsh > "${fpath[1]}/_striart"
striart completion fish > ~/.config/fish/completions/striart.fish
striart completion powershell >> $PROFILE
```

The script carries a header in the CLI's language (`STRIART_LANG`). Commands,
options and dynamic values are completed: agent names (`<agent>`,
`--agent`, `--after`), ticket ids (`--close`, `--prepare`, `--apply`),
profiles (`--profile`), files (`plan`), and commander's **closed
enumerations** (`.choices()`: for instance the `<mode>` of `orchestrate`,
`--pick`, `--framing`), read from the same source as validation. Dynamic values come from the
internal command `striart __complete agents|tickets|profiles`, which reads
`.striart/` on every Tab, without git or lock; it only offers values that
match their pattern, and only from an initialized repository (`.git` **and**
`.striart`, owned by the current user on POSIX). Profile completion **never
executes** the repository's config — pressing Tab is not a decision to run
code: it offers the default profiles, plus those of a **data** config
(JSON/YAML, `.striartrc.*`) read directly. For a **code** config
(`striart.config.mjs`, `.js`, `.cjs`, `.ts`), the names come from the
`.striart/completion-profiles.json` cache published by `striart profiles` —
an explicit command, which does load the config — and only if it points to
the same config file. Until `striart profiles` has run, only the default
profiles are offered (see [SECURITY.md](../../SECURITY.md)).

---

## Setup and diagnosis

### `striart init`

Creates `.striart/` (agents, conflicts, logs, state files), adds `.striart/`
to `.gitignore`, generates `striart.config.mjs` if no config exists,
validates the config (an invalid config makes `init` fail), then **chains
the `striart doctor` diagnosis** and shows its `warning`/`error` findings
with the action to take: repository without a commit, missing target
branch, unreachable LLM… Initialization itself succeeds (exit 0); a
prerequisite missing for what comes next is reported, not counted as a
failure. Idempotent. Details: [Getting started](getting-started.md#striart-init).

### `striart doctor`

Full diagnosis — 29 checks: git version, **native component** (the
`striart-native` binary: selected source, signature verified or not,
version, the pinned key and the user's trusted keys `native.trustedKeyIds` —
never a silent fallback), **Test Gate container** (`gateContainer`: native, or
`process` = a relaxation with no orphan detection), **terminal host (pty)** (binary,
effective shell, `pty.shell`), repository and first commit, initialization,
config loaded and validated, **target branch** (missing → error: merge,
sync, watch and rollback would fail; current branch different → warning:
merge and watch will refuse), reachable LLM (Ollama ping or API key
present), **network** (offline / allow-list policy, proxy active or inactive
and its mechanism, corporate CA, minimum TLS; as warnings
`network.allowInsecureHosts` and `NODE_TLS_REJECT_UNAUTHORIZED=0` — **user**
config and shell only, see
[Enterprise network](configuration.md#enterprise-network-network)), historical
secrets, **main lock** (free / operation running with
its age and last heartbeat / live but frozen holder, never broken / orphan /
third-party merge open), **state lock**, **main session** (free / busy —
see `striart lock`), agents (including clones being removed or broken), open
tickets, manual mode, **protected paths** (defaults + `extend`,
relaxations), **MCP server** (clone-bound scope, or `orchestrator`),
**agent profiles** (verified presets, experimental ones, ACP download,
instructions), **tokens and cost** (accounting, ceilings, stale prices,
instructions footprint, LLM circuit breaker disabled), **orchestration**,
**dashboard** (hosts accepted besides the loopback), **local data**
(`.striart/` reserved to the user: number of items inspected, or what is still
readable by other accounts — the fix is `striart init`), **Test Gate
environment** (variables filtered, repository requests not allowed by
`gate.envAllow`), **idle GC** (the `idle.action` policy; with `close`, whether the
user config authorizes closing or the repository is missing from
`idle.closeRoots`), **delivery** (`delivery`, `pushTimeoutMs`, `commitTimeoutMs`:
information, not a relaxation), **performance** (real latency of the state lock,
main-repository `git status`, size of `.striart/`, number of agents, age of the
oldest held lock — each measurement is time-bounded and a slowness finding is a
warning, never an error) and a **relaxed protections** summary that gathers in one place everything the config
lowered (`hooks.trustedRoots` of the user config, `mcp.scope`, ACP
relaxations, `acpRegistry.allowBinaryDownload`, `dashboardAllowedHosts`,
`dashboardHostname: 'localhost'`, `protectedAgentPaths.allow`/`matchCase`,
`lock.breakFrozenHolderAfterMs`, `tokens.*`, `orchestration.*`, experimental
profiles, the user config's `env.allow`, `gate.envAllow` and
`network.allowInsecureHosts`, `idle.enabled: false`, `idle.closePty: true`,
`overlap.enabled: false`, `acpRegistry.allowEnv`,
`llm.allowAnyApiKeyEnv` / `llm.allowInsecureTransport`,
`gateContainer: 'process'`, `gateEnv: 'inherit'`, `privateStateDir: false`,
`NODE_TLS_REJECT_UNAUTHORIZED=0`, `unknownConfigKeys: 'warn'` and the three
config-as-code relaxations `secretPatterns: []`, `pty.shell` other than
`auto`, and `terminal.launcher: 'custom'`). An unknown top-level key (with
`unknownConfigKeys: 'warn'`) is also a warning of the "configuration" check;
`secretPatterns: []` is one of the "historical secrets" check (secret
exclusion and history scan switched off). Each finding separates the fact
from the action, and the list of actions follows the table. Active policies
that are not relaxations (`delivery: 'branch'`, `idle.action: 'warn'` or
`'close'`) are reported separately.

Severity: `error` = the next command will fail; `warning` = Striart works
but a capability is degraded or a human action is expected; `skipped` = not
applicable here. The verdict says "operational" only when there is no
warning at all. Exit 1 if there is at least one error.
`striart doctor --json | jq ".data.summary"` counts each level. The first
reflex when something refuses to work — see
[Troubleshooting](troubleshooting.md).

## Launching agents

### `striart start <agent> [--command <cmd>] [--open] [--allow-historical-secrets]`

Creates the isolated clone and the task branch
`striart/<agent>/task-<uuid>`, **without going through the Router** (no file
prediction, no queuing). Refuses a non-existent `targetBranch` upfront
(`UNKNOWN_BRANCH`): the agent would start, but none of its merges could
ever succeed.

- `--command` overrides this agent's tool (otherwise the config's
  `agentCommand`, otherwise `claude`). Without `--open`, the exact command
  to run is printed: `cd <clone path>; <tool>`, the path quoted for the
  platform's shell (single quotes on POSIX/PowerShell) — a project path
  containing `$(…)` does not execute on copy-paste.
- `--open` starts a detached **pty host** process (one per agent,
  idempotent) — the native binary `striart-native pty-host`, which actually
  owns the pty (ConPTY on Windows, POSIX pty elsewhere) and launches the tool
  in it — then opens a terminal tab that runs `striart attach <agent>`. The
  default launcher (`terminal.launcher: 'auto'`) is Windows Terminal when
  the current session is one (`WT_SESSION`), otherwise a PowerShell console
  on Windows, Terminal.app on macOS, gnome-terminal elsewhere; it is chosen
  in the config (`terminal`: Windows Terminal, Terminal.app, iTerm2,
  gnome-terminal, Konsole, kitty, WezTerm, Alacritty, **Warp**, or a custom
  argv command — see
  [Configuration](configuration.md#terminal--the---open-launcher)), and
  `auto` recognizes a Warp session (`TERM_PROGRAM=WarpTerminal`). The tab
  launches Node and the CLI by **absolute paths**: it works after a local
  install too, without `striart` on the `PATH`. The hosted tool lives
  independently of the tab: closing it (or even `striart`) does not kill the
  session, and `watch --ui`'s `@agent` bus can join it. A failure to open
  changes nothing: the agent is ready, a `TERMINAL_OPEN_FAILED` warning
  gives the command to run by hand (`striart attach <agent>` if the host is
  running). The hosted shell is `pty.shell` (PowerShell on Windows, `$SHELL`
  or bash elsewhere by default); the agent's command takes precedence.
- **Striart instructions**: at creation, on `--reuse` and after each rebase,
  Striart drops the session rules into the clone (the clone is isolated, only
  *committed* work is integrated, the Test Gate decides, never push nor touch
  agent configuration files) under the name the tool reads
  (`rules/striart.md` under `.claude`, `AGENTS.md`, `GEMINI.md`…), as an
  **untracked** file listed in the *clone's* `.git/info/exclude`: git status
  stays clean, and the file can only be committed by a deliberate
  `git add -f`, which the protected-paths guard refuses at merge. When the
  repository already has an `AGENTS.md`, `agentInstructions.agentsMd`
  decides: `override` (default — a composite `AGENTS.override.md` for the
  tools that read it) or `non-file` (nothing next to `AGENTS.md`, a
  warning). Autonomous-mode profiles get the same rules through their channel
  (ACP prompt, system-instructions file, or prompt envelope). Injection is
  *advisory*: a failure is a logged warning, never a refusal to create the
  agent. Settings:
  [Configuration](configuration.md#agentinstructions--the-rules-handed-to-agents).
- `--allow-historical-secrets` clones despite a `HISTORICAL_SECRETS_FOUND`
  refusal (a path matching `secretPatterns` once existed in the history —
  see [Architecture](architecture.md)): a conscious decision, to take after
  checking or revoking the secret.

`--force` **without** `--reuse` is a deprecated alias of
`--allow-historical-secrets` (same effect, `DEPRECATED_OPTION` warning); it
will be removed in 0.12.

### `striart start <agent> --reuse [--force]`

**Reuses** the kept clone of a stopped agent: resync onto the current target
branch, new task branch, untracked files preserved (`node_modules` — warm
start). Explicit refusals:

- `REUSE_DIRTY` — the archive has uncommitted changes;
- `REUSE_UNMERGED` — committed work was never merged;
- `REUSE_IN_USE` — the clone's disk changed recently (`presenceMinutes`);
- `HISTORICAL_SECRETS_FOUND` — see above.

`--force` accepts **losing work** (the first three refusals) and nothing
else: it does not lift the historical-secrets check, which requires
`--allow-historical-secrets`. Two distinct consents, never conflated.
`striart run --reuse` additionally goes through the Router.

### `striart attach <agent>`

Attaches an interactive terminal to the pty already owned by an agent's
detached host — exactly what `--open` launches under the hood, invocable
directly to (re)join a session (a closed tab, a second window watching the
same session). Must be run from **inside the agent's own clone directory**
(`.striart/agents/<agent>/`, checked strictly — the main repo is derived
from that path rather than passed as an argument; refused as
`ATTACH_WRONG_CWD` otherwise). Does **not** start the pty host: if it isn't
running, `attach` fails (exit 1) pointing at `striart start <agent> --open`.
The terminal is always restored on exit. Distinct from the `@agent` bus of
`watch --ui`: `attach` gives the *real* raw terminal, the bus sends one
message at a time. Several clients can attach to the same pty (read and
write), and a resize requested by one is broadcast to the others. A client
too slow to read the output is **explicitly evicted** by the host (its queue
exceeds `pty.clientQueueBytes`) then reconnects by itself; on reconnection,
the recent history (`pty.replayBytes`) is **replayed and re-displayed in the
real terminal**. After a few consecutive evictions without reading anything,
`attach` gives up with an error instead of looping.

### `striart run "<prompt>" [--agent <a>] [--command <cmd>] [--open] [--reuse] [--force] [--allow-historical-secrets]`

The normal path: the **Router** sends the prompt to the LLM, gets the list of
files likely to be touched, filters it (`isSafeProjectPath` — LLM output is
untrusted), then compares it to the predictions of active and queued tasks.
Intersection → the task is **queued** instead of heading into a conflict
(exit 0: deferral by design); otherwise the agent starts. Without `--agent`,
the name is derived from the prompt (e.g. `refactor-the-auth-module`).
`--prompt <p>` is the scriptable equivalent of the positional (both at once
and different: `OPTION_CONFLICT`). The target branch is checked **before**
the LLM call (`UNKNOWN_BRANCH`). The prediction is a **coarse filter**, not a
guarantee: on this repository's real history the measured recall is around half
of the touched files
([2026-10-26 measurements](architecture.md#what-the-router-and-the-semantic-merge-are-worth--measurements-of-2026-10-26));
what it misses, the semantic merge and the Test Gate catch.

`--allow-historical-secrets` is a conscious decision against
`HISTORICAL_SECRETS_FOUND`; if the task is queued, the decision is stored
(`QueueTask.allowHistoricalSecrets`) and honored when the queue clears,
without asking again for a confirmation no human is there to give. Consent
to **lose work** (`--reuse --force`), on the other hand, is **never**
persisted in the queue: it is about a clone's state at the moment it is
given, and replayed later it would cover work that appeared in the
meantime. `--force` without `--reuse`: deprecated alias of
`--allow-historical-secrets`, as for `start`.

Combinations refused before any action (exit 2): `--profile` or `--timeout`
without `--autonomous`/`--on-main`, `--reuse` without `--agent`
(`REUSE_NEEDS_AGENT`), `--open`/`--command` with `--autonomous` or
`--on-main`, `--autonomous` with `--on-main`.

At launch, **semantic links** are reported for information (never blocking):
mutual imports (JS/TS, Python, Ruby, PHP) and linked packages in a monorepo
(npm/yarn, Cargo, Go, Maven).

### `striart run … --autonomous [--profile <p>] [--timeout <ms>]`

Striart launches the tool itself (a profile from `agentProfiles`), supervises
the process, merges, runs the Test Gate and deletes the clone if everything
is green. Full details: [Execution modes](execution-modes.md). Timeout
precedence: `--timeout` > `profile.timeout` > `autonomousTimeoutMs`. Also
accepts `--agent`, `--after`, `--reuse [--force]` and
`--allow-historical-secrets`.

Three checks join the cycle, all configurable:

- **Commit contract** (`commitPolicy`, global and per profile): `agent`
  (default — the agent commits alone), `agent-then-striart` (Striart commits
  what the agent left if it committed nothing), `striart` (Striart always
  commits the rest), `human` (nobody commits **or merges**: clone kept for
  review — if the agent committed anyway, the cycle returns the `KEPT`
  status with `keptCode` `HUMAN_REVIEW_REQUIRED` and **never merges**, in
  every mode: single cycle, orchestrated modes, ACP proxy; exit 3). The
  Striart commit excludes `secretPatterns` and the files Striart injected itself,
  has the agent profile as author and the user's git identity as committer,
  and then follows the same path as an agent commit. Fail closed refusals:
  `COMMIT_REFUSED` (clone off its branch, git operation in progress,
  unmerged paths — exit 3), `COMMIT_FAILED`.
- **Protected-paths guard**: a commit that modifies an instructions or agent
  configuration file, or Striart's config (`AGENTS.md`, `CLAUDE.md`,
  `.claude`, `.mcp.json`, `striart.config.*`…), is refused at merge with a
  `PROTECTED_PATHS_CHANGED` ticket, before any LLM merge and before the Test
  Gate — `resolve` decides each path.
- **Token ceilings** (`tokens.budgets`, opt-in): a session that crosses a
  ceiling is stopped cleanly (`BUDGET_EXCEEDED` status, clone kept, exit 3).

An agent commit **already present** in the target branch (it arrived another
way) is not a failure: the work is integrated, the status is `MERGED`, the
clone is cleaned under the usual guards — but the success is **noisy**: an
`ALREADY_INTEGRATED` warning (`warnings` field of the `--json` document, a
line on stderr, a `session:already-integrated` event), `merge.mergeSha` names
the target commit that already carries the work, and **no Test Gate is
re-run** (nothing is merged). An `UP_TO_DATE` without an already-integrated
commit (nothing new) stays a blocked merge: a clone is never deleted on
"nothing to merge".

**Ctrl+C (or SIGTERM) stops cleanly**: the agent's process tree is killed
(in ACP, `session/cancel` first), **then** the session PID is unpublished —
never the other way round, otherwise the `SESSION_LIVE` guards would drop
on a clone still being written. The session returns `CANCELLED`, the cycle
`SESSION_FAILED` with the clone kept, and the CLI exits 130 (143 for
SIGTERM). A stop requested during the end-of-cycle merge or Test Gate does
not interrupt those steps.

### `striart run … --on-main [--profile <p>] [--timeout <ms>]`

Runs the agent **directly in the main repo**, not in a clone:
`runMainSession` reserves a **main session** (`.striart/main-session.json`,
publishing the PID **of the orchestrator process itself**, not that of the
spawned agent) under the main lock, briefly, then launches the tool without
holding the lock for the session (which may last hours). While the session
lives, any other mutating operation (`merge`, `sync`, `promote`,
`resolve --apply`, `watch`'s auto-merge…) is refused with
`MAIN_SESSION_LIVE`. No end-of-cycle merge: the agent already works on the
target branch. Incompatible with `--agent`, `--after`, `--reuse`, `--force`
and `--allow-historical-secrets` (no clone is created). Exit 0 if the
session returns `COMPLETED`, 3 if it is stopped by a token ceiling
(`BUDGET_EXCEEDED`) or by a *refusal* cause, 1 otherwise.

Ctrl+C (or SIGTERM) kills the agent's tree **before** unpublishing the main
session: never a main repo declared free while the agent is still writing
to its worktree.

### `striart run … --after <task|agent>`

**Declared dependency**: the task waits in the queue for the referenced work
to finish (merge + stop), then starts automatically. Unknown reference
(`AFTER_UNKNOWN`) or cycle (`AFTER_CYCLE`) → refused at launch. This is the
building block underneath [YAML plans](plans.md).

### `striart plan <file.yaml> [--dry-run] [--mode <m>] [--concurrency <n>] [--on-failure <p>] [--resume <run-id>]`

See [Plans — tasks-as-code](plans.md). A `version: 1` plan is the queue and
`--after` written in YAML; a `version: 2` plan adds the orchestration modes
(`sequential`/`parallel`, `review`, `race`, `team`, `pipeline` tasks).
`--mode`, `--concurrency` and `--on-failure` override the chaining, the
number of simultaneous tasks (in `parallel`) and the failure policy (`stop`:
nothing else starts; `skip-dependents`: only the dependents are skipped) of
the v2 plan; on a v1 plan they are refused (`PLAN_INVALID`,
`OVERRIDES_NEED_V2`). `striart plan` returns the worst
outcome of its tasks (refused > failed > ok). Outside `--dry-run`, **Ctrl+C
(or SIGTERM) stops cleanly**: the signal is passed to the running autonomous
session, which stops like `run --autonomous` (agent tree killed, PID
unpublished, clone kept); no further task starts. The result carries
`interrupted: true` and the `notApplied` list of tasks not started, shown as
"not applied (stop requested)"; the CLI exits with 130 (143 for SIGTERM), the
`--json` document returns `ok: false` (an interrupted plan did not reach
its intent) and the "plan applied" line becomes a warning. A second Ctrl+C
cuts immediately.

`--resume <run-id>` (v2 only, incompatible with `--dry-run`) replays the
**same plan file** after an interruption without rerunning tasks that
already finished — see [Plans — tasks-as-code](plans.md). The run id is
printed on interruption and listed by `striart status --json` under
`orchestration.runs`.

### `striart draft "<objective>" [--out <file>]`

Planner (see [Plans — tasks-as-code](plans.md)): turns a
natural-language objective into a `version: 2` plan file, validated by the
exact same path as a hand-written plan (unknown profile, bad dependency, …
all refused the same way). It **starts nothing** — no agent, no merge — and
writes the plan to `--out` (default `striart-draft-<timestamp>.yaml`),
refusing to overwrite an existing file (`DRAFT_FILE_EXISTS`). The human
approval step is explicit and separate: review the file, then
`striart plan <file> --dry-run`, then `striart plan <file>`. If the
objective is too ambiguous to plan safely, the Planner refuses rather than
guessing (`PLANNER_REFUSED`); an LLM failure after retries is
`PLANNER_FAILED`. Uses the `planner` LLM role (`config.llmRoles.planner`,
see [Configuration](configuration.md)).

### `striart profiles [--catalog | --detect | --import-acp <id>]`

With no option, lists the configured profiles (tool, argv/ACP transport, env
variable **names** — never their values —, timeout, preset, experimental
status, write mode, commit contract, structured output, instructions
channel): the AIs available for `--profile` and for a plan's `profile` field.
It is also the command that publishes the profile-completion cache
(`.striart/completion-profiles.json`). The three options are mutually
exclusive:

- `--catalog` lists the catalog **presets** (`src/agents/catalog.ts`): 20
  ready (Claude Code and its subscription profile, Codex, Gemini over ACP,
  Copilot CLI and ACP, Cursor, OpenCode, Goose, Amp, Kilo, Qwen Code, Cline,
  Aider and Aider on a local Ollama model, and the ACP variants) and 5
  experimental (Gemini over argv, Junie, Junie ACP, Continue, Warp Oz).
  "Ready" means the non-interactive invocation, the write mode and the
  neutralization of the repository's agent configuration were verified in
  the tool's official documentation (sources dated 2026-10-24, cited per
  preset); an experimental preset is **not** in the default profiles, it is
  declared by hand (`{ preset: '<id>' }`) and shows as a relaxation in
  `striart doctor`.
- `--detect` probes the installed tools: binary lookup in the `PATH` through
  the file system (no process, no shell), then `<binary> --version` in argv,
  run in an **empty** temporary directory — a tool that reads the
  configuration of its current directory finds nothing, the probe never
  executes the repository's config. Each tool is `found`, `outdated`
  (preset's minimum version not reached), `missing` or `unknown-version`.
- `--import-acp <id>` derives a **pinned** ACP profile from an agent of the
  [ACP registry](https://agentclientprotocol.com) (`acpRegistry.url`, https
  required). By default: **metadata only** — the profile points at the
  published version (`npx`/`uvx`: exact specifier; binary: archive and
  checksum described for you to install), no binary is downloaded. An
  unpinned version is refused (`ACP_IMPORT_UNPINNED`).
  `acpRegistry.allowBinaryDownload: true` allows downloading the archive for
  the current platform — refused without a published sha256 checksum
  (`ACP_IMPORT_NO_INTEGRITY`), verified against it
  (`ACP_DOWNLOAD_INTEGRITY_MISMATCH`), extracted under
  `.striart/acp-agents/<id>/<version>/` with no symlink nor escaping path
  (`ACP_EXTRACT_UNSAFE`), logged, and flagged by `doctor`.

## Orchestrating

### `striart watch [--no-merge]`

The core: watches the refs of every clone, processes each commit in the
[serialized chain](architecture.md#the-serialized-chain) (prior rebase,
merge, semantic merge, Test Gate, rebase of the other agents). `--no-merge`
only observes. The watcher **does not merge autonomous agents** — their
merge belongs to their end of cycle. Replays `reconcile` periodically,
queued on the same chain. `striart watch --json` produces the ndjson stream
described above.

**Ctrl+C (or SIGTERM) stops cleanly.** The operation **in flight** (merge,
semantic merge, Test Gate) completes and its result is reported before
exiting ("stopping: finishing the current operation" is shown when there is
one; a second Ctrl+C forces). Merges still **queued** do not start: each is
reported once per agent (`merge-deferred` event, a warning line with the
hint `striart merge <agent>`), as is a commit seen between the stop request
and the watcher closing; an autonomous agent, which the watcher never
merges, is not reported. Each deferred merge is also logged (`warn` level),
including under `watch --ui` where the event no longer goes out. The watcher
does not pick up a commit made before it started: a merge deferred this way
is rerun by hand. As a daemon, the same stop is triggered by `--stop` (see
below).

**Idle GC.** As long as `idle.enabled` is true (the default), `watch` runs a
[GC](#striart-gc-agent---close---dry-run) sweep every `idle.sweepIntervalMs`
(5 min) — **outside the merge chain** (a closure does not wait for a long merge)
and never under the main lock. With the default action (`report`) it only
detects; with `warn` or `close` it warns and then, with the user's
authorization, closes the session after the grace period. The ndjson stream
carries `idle-warned`, `idle-closed`, `idle-refused` and `idle-error`; Ctrl+C
waits for a sweep in flight to finish.

### `striart watch --daemon | --status | --stop`

The same watcher, as a native detached process: PID file
(`.striart/watch.pid`) and **ndjson** log (`.striart/logs/watch.log` — the
daemon runs `watch --json`), orphan daemon detection, `--status` and
`--stop` to inspect and stop it. `--daemon` refuses if a daemon is already
running (`DAEMON_RUNNING`). No dependency on pm2 or systemd; resuming at
boot is left to the user (the OS scheduler). The PID file is written
atomically, and every write or removal goes through an exclusive lock
(`.striart/watch.pid.lock`, created with `wx`): two simultaneous `--daemon`
start only one, the other gets `DAEMON_RUNNING`. A lock held beyond the wait
(about 10 s) returns `DAEMON_BUSY`; a lock older than 30 s, left by a dead
starter, is broken.

The published PID is **recognized by its command line**
(`node …/cli.js watch …`), not just by being alive: after a crash or a
reboot, the OS may have handed that number to another process. Such a PID is
reported as orphaned (`--status`), cleaned up by `--daemon`/`--stop`, and
**never killed**. A live process whose identity cannot be read (another
user) is presumed alive — `--daemon` refuses to start a second one — but is
never killed: `--stop` refuses with `DAEMON_IDENTITY_UNVERIFIED` (exit 3) and
keeps the PID file. `--status --json` tells the two cases apart
(`data.verified`). Before any stop, the identity is re-read without cache.

`--stop` is a **clean stop on every OS**, Windows included (where a signal
is a TerminateProcess that would cut the daemon mid-Test Gate): it drops a
stop request (`.striart/watch.stop`) that the daemon reads itself,
acknowledges, then handles like a SIGTERM — the watcher finishes and reports
the in-flight operation. Without an acknowledgement within 5 s (a daemon
from an earlier version, or a stuck one), it falls back to the signal.
`--stop` **then waits for the actual exit** (10 s): the PID file is removed
only once the process has exited — otherwise a second watcher could start
while the first one is still merging. Past the delay, `--stop` returns with
"stop requested: … finishes the current operation, then exits on its own"
(`data.stopping: true` in `--json`, `--status` hint) and leaves the PID
file, which the daemon removes itself on exit. A second `--stop` meanwhile
does not signal again (a second signal would force the exit mid-merge): it
waits. A daemon started by another user cannot be signalled from here:
`DAEMON_STOP_DENIED` refusal (exit 3), PID file kept.

### `striart watch --ui`

The same watcher, plus an interactive Ink panel (**incompatible with
`--daemon` and with `--json`**; requires a real terminal on input and
output, otherwise `UI_REQUIRES_TTY`): one tab per active **supervised**
agent (autonomous agents aren't tracked — no pty to join), each showing the
live tail of the agent's owned pty, plus a permanent virtual **"🖥️
Terminal"** tab (selected by default) that receives the watcher's events and
the output of any `/…`/`!…` command launched from the input field. Panel
texts in French or English depending on `STRIART_LANG`.

Input field grammar:

- **`/command`** runs `striart <command>` (same binary, `argv`,
  `shell: false`) and shows its output in the Terminal tab. `/exit` quits
  the panel (like Ctrl+C); `/clear` empties the Terminal tab, or sends the
  real shell clear command (`cls`/`clear`) to the selected agent;
  `/relaunch [agent]` retypes the agent's launch command (same resolution as
  `--open`) — useful when the 🟡 badge below signals that the hosted tool
  stopped. Commands that require the foreground are refused here, with their
  reason (command registry): `watch` (would double the host watcher), `mcp`
  (protocol on stdin/stdout, as `api` and `acp`), `attach` (must own the real terminal);
  `dashboard` is accepted only with `--daemon`/`--stop`/`--status`.
- **`!command`** runs a real command through the machine's default shell
  (`defaultShell()`), pipes, redirections and any installed binary
  included; the output also goes to the Terminal tab.
- **`@agent message`** sends `message` to the named agent: to a **supervised**
  agent's pty (starts its pty host if needed), or — Phase E, delivered with
  the full ACP client — to the **live ACP session** of an autonomous agent,
  where the text becomes an extra `session/prompt` played after the current
  turn (by the persistent session host). An argv session (one-shot: no
  process left to talk to), an ended or closing ACP session, or a disabled
  bus (`acp.bus: false`) are refused explicitly, with the reason.
- **Unprefixed text** goes to the agent of the currently **selected** tab —
  `@agent` is only needed to change the target.

Autocomplete on `/` and `@` (Tab or Enter completes the active suggestion; a
second Enter, once the list is empty, submits). `↑`/`↓` recall input history
when the field isn't empty and no suggestion is active; on an empty field
they switch tabs. Page Up/Page Down scroll the 500 lines of scrollback of the
displayed tab. A `•` marks a tab whose content changed while another one was
displayed. A 🟡 badge (vs 🟢) signals — purely informational, **never an
automatic relaunch** — that the hosted tool's pty seems to have fallen back
to a bare shell prompt; `/relaunch` is the fix. Watcher logs go to
`.striart/logs/watch-ui.log`.

The panel unmounts on the **first** SIGINT or SIGTERM received from outside
(a `kill` from another terminal, for instance), as on `/exit`. Unlike
`watch` in the foreground, leaving the panel does not wait for a merge in
progress to finish: it is left to recovery after a cut (lock removed on
process exit, orphan merge aborted at the next lock acquisition).

Same trust boundary as `--open`/`attach`: a message sent through the
`@agent` bus, or the `!` shell, has exactly the same power as typing
directly into the terminal — see [SECURITY.md](../../SECURITY.md).

### `striart merge <agent>`

Manual merge of an agent's latest commit — same pipeline as the watcher
(prior rebase, semantic merge, Test Gate). Refuses if the main repo is dirty
(`MAIN_DIRTY`), on the wrong branch (`TARGET_BRANCH_MISMATCH`), if untracked
files would be overwritten (`UNTRACKED_COLLISION`) or if the agent's
autonomous session is alive (`SESSION_LIVE`) — see
[Branches and pipeline](branches.md). A target branch with no commit at all is
refused up front (`UNKNOWN_BRANCH`), and a `HEAD` pointing to another **unborn**
branch gives `TARGET_BRANCH_MISMATCH` (hint `git switch <targetBranch>`), never a
raw git message — the same goes for `rollback`, `promote` and
`resolve --apply`. Exit 0 on `MERGED`/`UP_TO_DATE`,
**3 on `CONFLICT` or `GATE_FAILED`** (ticket created). The `--json` document
of a successful merge distinguishes `sha` (the agent's commit) from
`mergeSha` (the merge commit created on the target branch — the one
`rollback` undoes). Three guards apply before the final commit: an
**effective** change of a protected path (`AGENTS.md`, `.claude`,
`striart.config.*`…) refuses the merge and opens a `PROTECTED_PATHS_CHANGED`
ticket (exit 3), before any LLM merge; the exclusivity of the main lock is
rechecked before the commit (`LOCK_LOST` if another process took it over);
and so is the main repository's state — if someone acted on `HEAD` or opened
a merge during the operation, nothing is committed (`MERGE_STATE_CHANGED`,
exit 3). An agent commit already present in the target returns `UP_TO_DATE`
(no merge commit created).

**Merge commit and the target's hooks.** The commit that concludes the merge
runs the repository's hooks (`pre-commit`, `pre-merge-commit`,
`prepare-commit-msg`, `commit-msg`) and signing, under the hard
`commitTimeoutMs` timeout (process tree killed beyond it). A hook is **never
bypassed**: a rejection or a timeout cancels the merge (the main repo is clean),
opens a `COMMIT_HOOK_REJECTED` ticket that keeps the hook's output (16 KiB at
most, **secrets redacted** — same rule as the Test Gate log — in the ticket, the
error message and the `--json`) and exits 1. It is not an LLM failure: the
manual-mode counter is untouched, and the ticket closes at the agent's next
successful merge. Other git refusals (missing identity, signing impossible) give
`MERGE_COMMIT_FAILED`.

**Delivery (`autoPush`).** The push to `origin` is a deferred effect, after the
lock is released, of the exact tested SHA (see
[Configuration](configuration.md#delivery-to-origin-autopush-delivery-timeouts)).
The result carries `delivery` (mode, branch, SHA, `pushed`, `code`, hint) and
`pushError` (`[CODE] message`); in `delivery: 'branch'` mode the human output
adds the line "delivered on origin/striart/… (sha): approve it from the forge (PR/MR), the target branch was not pushed.". A
failed push changes neither the status nor the exit of the merge (the local work
is valid).

### `striart sync [agent]`

Rebases one agent (or all) onto the target branch, with the same safeguards
as the watcher (auto-stash if disjointness is verified, `SKIPPED_SESSION`
for live sessions, single-agent sync included). The
[6 statuses](architecture.md#the-6-synchronization-statuses) say exactly
what happened. Exit 0, including on a postponed or conflicting rebase
(deferral by design, the merge will catch up); 3 on `STASH_CONFLICT`.

### `striart stop <agent> [--force]`

Ends an agent: removes the registry entry, keeps the clone on disk, stops
its pty host if any (`--open`), then unblocks the queue (tasks that were
waiting on this agent start, and their launch command is printed).
Refusals:

- `AGENT_HAS_PENDING` — unmerged commits (`--force` abandons them), or a
  clone **present but unreadable** by git: pending work is unknown, hence
  presumed to exist (fail closed, `--force` to override);
- `SESSION_LIVE` — the agent's autonomous session is alive: refused **even
  with `--force`**.

A clone **gone from disk** (only an ENOENT error proves it) has no work left
to lose: the agent is removed from the registry without `--force`. Any other
error accessing the directory is treated as a present clone, hence checked —
and refused if unreadable.

The pty host is stopped **after** the registry removal and **outside** the
main lock (it may take a few seconds to exit, and the lock freezes the whole
orchestrator), through the same channel as the daemons: a stop request
`.striart/pty/<agent>/host.stop`, falling back to SIGTERM without an
acknowledgement within 3 s, then a wait for the exit (5 s) before removing
its PID file — while it lives, `clean`'s `SESSION_LIVE` guard holds. It is
**never killed blindly**: identity re-read without cache, a host that cannot
be identified or belongs to another user is left in place. The `stop`
itself succeeds (exit 0); whatever is left running is reported as a warning
(`warnings` field of `--json`, `data.ptyHost` for the detail):
`PTY_HOST_STOPPING` (the host is still stopping, the clone stays protected
until it exits) or `PTY_HOST_UNTOUCHED` (left in place — unidentifiable
process, another user, or a failed stop: close it by hand before
`striart clean <agent>`).

Clearing the queue after the stop can fail without undoing the stop (a
failing ticket or task no longer blocks the others): the agent is removed,
the queue stays as it is, and the failure is reported — `data.queueError`
(`{code, message}`), a warning with the same code on stderr and in `warnings`
— never hidden. `striart queue --retry` picks it up again. The agent's
peripheral artifacts (ACP session host, Warp *Tab Config*) are released in
the same move; a failure is reported in `data.artifacts.errors` and as an
`AGENT_ARTIFACT_FAILED` warning, without failing the stop.

### `striart orchestrate <mode> <prompts...>`

Launches **one** orchestrated task without writing a file: the command builds
a one-node `version: 2` plan and applies it through the same path as
`striart plan` (same complete validation before any effect, `--dry-run`
included). Four modes, all in autonomous sessions:

| Mode | What happens | Specific options |
|---|---|---|
| `review` | An **author** works, 1 to 5 **reviewers** (agents or a human) examine its clone in turn, in *verified* read-only. Structured verdict `approve` / `request-changes` / `reject`; the merge only happens after approval **then** the Test Gate. | `--author <profile>`, `--reviewer <profile>` (repeatable), `--human-reviewer`, `--quorum all\|any\|majority`, `--max-rounds <n>` |
| `race` | At least 2 candidates (`orchestration.race.maxCandidates`: 5 by default, 10 at most) on the same prompt, each in its own clone; the first whose merge passes the Test Gate wins (or the smallest diff, or an LLM judge's pick). | `--candidate <profile>` (repeatable, at least 2), `--pick first-green\|smallest-diff\|judge`, `--losers keep\|archive\|clean` |
| `team` | Several **roles** in the *same* clone: one writer at a time (`turns`), or a static partition of the files (`parallel`, a single Striart commit). | `--role name=profile[:glob,glob]` (repeatable; a bare `:` = read-only), `--cadence turns\|parallel`, `--rounds <n>` |
| `pipeline` | Ordered steps, each feeding the next (a briefing of facts computed by Striart, then the previous step's artifact). | `--step-profile <profile>` (repeatable, in order), `--handoff merge\|clone` |

One prompt argument per step for `pipeline`, a single one for the others.
Common: `--agent` (agent name or base of the derived names), `--timeout <ms>`
(per session), `--dry-run`. An option foreign to the chosen mode is refused
(`ORCHESTRATE_USAGE`, exit 2). Ctrl+C stops cleanly (agent trees killed
before any unpublish, clones kept). The Test Gate remains the final
authority: approved never means merged. The settings (bounds, quorum, loser
policy, cadence…) are in `orchestration` and `collab` — see
[Configuration](configuration.md) and
[Execution modes](execution-modes.md#the-orchestration-modes).

### `striart review [<id>] [--approve | --request-changes | --reject] [--comment <text>]`

The **human** reviews of a `review` task (a reviewer declared `human: true`
in the plan, or `--human-reviewer` of `orchestrate`).

- No argument: lists the requests (those waiting for a verdict first), with
  the state of the process that is waiting (`alive`).
- With an `<id>` (`rev-…`) and one of the three actions: gives the verdict.
  `--request-changes` requires `--comment` (passed to the author, framed as
  untrusted content); `--reject` merges nothing and keeps the clone;
  `--approve` lets the Test Gate decide next. A request that no longer waits
  (`orchestration.review.humanTimeoutMs` elapsed, already answered) is
  refused: `REVIEW_NOT_PENDING`.

Requests live in `.striart/reviews/` (disk mailbox, atomic answer under the
state lock, fail closed at the deadline), separate from the semi-autonomous
permissions. The dashboard and the Control Protocol present the same
requests (`review.list`, `review.answer`).

## Observing

### `striart status`

The overview: a table of agents (status, **session** — `running` only when
a PID is alive, autonomous session or `--open` terminal, otherwise `recent
activity` or nothing —, mode 🤖 autonomous + profile / 👤 supervised, task
branch, tool, additional clone size — hardlinks count as 0 —, pending
commits), then everything waiting on a human: open tickets, manual mode,
reserved main repo, unblockable tasks. A clone being removed shows as
`REMOVING`. `striart status --json` returns exactly the same view as the MCP
tool `striart_status` (`agents`, `queue`, `tickets`, `state`, `daemon`,
`mainSession` with `alive` computed) plus `orchestration` (plans and groups
of the orchestrated modes, running and recent, and the human reviews —
including those waiting for a verdict) and `tokens` (accounting on, today's
consumption, ceilings and their level, relaxations; `available: false` if
the config or the ledger is unreadable, without breaking the view).

The view also carries the additive fields `overlaps` (overlaps
[observed](configuration.md#overlap--the-runtime-overlap-net) at runtime between
agents, or between an agent and the target) and `idle`: the
[idle GC](#striart-gc-agent---close---dry-run) verdict for each agent, computed
by a `--dry-run` sweep (nothing is written or closed; `available: false` if the
sweep is impossible). Live sessions whose signals are all past the threshold
appear in the "things to handle", with the `striart gc --dry-run` hint.

### `striart queue [--retry]`

The scheduler: `RUNNING` / `WAITING` tasks and what blocks each one
(collision, `--after` dependency); a task nothing holds back any more is
marked ready (`ready`). `--retry` starts the tasks that became unblocked.

### `striart history [--limit <n>]`

History of Striart merges and rollbacks, **rebuilt from the Git graph** (not
a separate log that could drift). Each merge says how a possible conflict
was settled (`resolution`: `auto`, `semantic` with its files, or `manual`
with the id of the ticket resolved by `resolve --apply`). Default: 30
entries.

### `striart usage [--since <p>] [--until <p>] [--role <r>] [--agent <a>] [--task <id>]`

Token usage and cost, read from the **append-only** ledger
`.striart/usage/YYYY-MM-DD.ndjson` (UTC day): one record per Striart LLM call
(`router`, `merger`, `memory`, `judge`, `review`) and per agent session
(`agent`). The ledger **never** holds a prompt, a response, file content or a
key: each line is rebuilt field by field (allow-list). Tables by role (with a
TOTAL), agent, task (first 20), model and day, then the prompt-cache hit
rate, the answers served by the result cache and the footprint of the
injected instructions.

- `--since` / `--until`: `7d`, `24h`, `30m`, `today` or `YYYY-MM-DD` (UTC,
  whole day included). Inconsistent or unreadable period:
  `USAGE_PERIOD_INVALID` (exit 2).
- `--role`: `router`, `merger`, `memory`, `judge`, `review` or `agent`.
- **Cost** exists only for a model whose price is declared
  (`tokens.pricing`, no hard-coded price: a price changes without notice); a
  local Ollama model counts as 0 USD. Calls without a price are counted
  apart ("unpriced"), so are estimated records (no provider report), and a
  session without a structured stream is declared *unmetered* — only its
  timeout bounds it. The local token estimator stays on the cautious side (it
  over-estimates rather than let a call through above a ceiling) and
  calibrates itself on the recorded real usage.
- Retention is `tokens.retentionDays` (90 days), applied by `striart prune`.
  The same summary feeds `status --json` (`tokens` field), the "Tokens and
  cost" line of `doctor` and the Control Protocol.
- `npm run bench:tokens` (`scripts/bench-tokens.ts`, offline and
  deterministic) compares, before and after the token-saving batch, the
  estimated tokens of the Merger (a real three-way conflict), of the Router
  tree (the repository, then a synthetic 10,000-file monorepo), of the
  injected instructions (full / compact) and of the Memory Layer.

### `striart dashboard [--port <p>] [--daemon | --status | --stop | --link]`

Local web dashboard, bound to `127.0.0.1` only, **real-time** (SSE — pushed
on every change, no polling): state of the agents and their mode, watcher
status banner, session logs, arbitration of semi-autonomous permissions and
of the agent's questions (elicitation), human reviews, state of the
orchestration modes, diagnosis, and control (merge, stop, retry, rollback,
preparing and applying a ticket resolution behind the Test Gate, manual
close). It is the **browser client of the Striart Control Protocol v1**: the
page speaks JSON-RPC 2.0 (`POST /rpc`) and receives changes through
`GET /events`. Port: `--port`, otherwise the config's `dashboardPort`
(3456); an invalid port is refused before anything starts, a busy port
returns `PORT_IN_USE` with a suggestion.

**The page.** It is served in the instance's language (`STRIART_LANG`, then the
locale — same rule as the CLI; French and English, a single embedded catalog),
in a **light or dark** theme following the system preference
(`prefers-color-scheme`). Reading and tab order: a skip link ("Skip to main
content"), then the **"Needs your attention"** zone (conflict tickets to resolve, `BROKEN`/
`MISSING` agents, no watcher, reserved main session, manual mode, permissions,
agent questions, reviews), the task form, maintenance, then the data (agents,
queue, contended files, tickets, orchestration, history). A piece of
information's level is always carried by a word, never by color alone.
Destructive actions ask for a confirmation that names the consequence;
**"Force stop…"** lives in each agent's "More actions" menu (`<details>`, out of
reach of a careless click) and says what it does: it **removes the agent from
the registry without merging its pending commits** — the clone stays on disk,
but Striart will no longer integrate it —, with no Test Gate. When the real-time
stream is cut, an **"Offline"** state shows the data **time-stamped** ("last
update at …") and flags that they may be stale; reconnection is automatic. The
page does **not** show token usage (the Control Protocol does not expose it:
`striart usage`). It is **not declared WCAG 2.2 AA compliant**: the automated
audit (axe) is green according to the maintainer's reading (not rerun by the
documentation pass) and a manual review remains to be done; no real screen
reader has been tested. The page is served under a strict CSP whose script and
style sheet are identified **by hash, one per language** (no `unsafe-inline`, no
external source); `/favicon.ico` answers 204 with no data, even without a
session.

**Agent list.** Agents are grouped by state: **"Needs attention"** (`BROKEN` /
`MISSING`, commits waiting to be merged, a conflict ticket, a pending permission
request, question or review), **"Running"** (live session or recent activity, ACP
host running) and **"Idle"** (the rest, including a clone being removed). From
four agents on, a filter by group and a search by name appear; a click opens the
agent's detail (branch, tool, mode, session, clone size, pending commits, locked
files, open conflicts, tasks it blocks, inactivity). This "Idle" group is a
**display classification**: it says nothing about the GC decision below, which
rests on the activity signals.
**Inactivity (GC).** An agent whose session is alive but that the
[idle GC](#striart-gc-agent---close---dry-run) judges idle carries an **"Idle
for …"** badge (information, then warning once it has been warned or is
closable), an "Inactivity" row in its detail, and a card in the **"Needs your
attention"** zone that says where it stands (warned, closable after such a time,
clone and work kept) with a **"Run gc --dry-run"** button for that agent. The
dashboard **never** closes a session itself: the button previews (`workspace.gc`
in `dryRun`); closing stays `striart gc` or the `striart watch` sweep.

**Sign-in through a one-time link** (a 0.11 break: the dashboard is no longer
open to anyone who reaches the loopback). At startup Striart prints a
**sign-in link** (`http://<random-id>.localhost:<port>/auth?code=…` — a name
specific to the instance, see `dashboardHostname`); the browser
exchanges it for an `HttpOnly; SameSite=Strict` session cookie. The link is
signed (HMAC-SHA256 of the instance token), lives `dashboardLinkTtlMs` (5 min
by default), works **only once**, and the cookie lives `dashboardSessionTtlMs`
(12 h). Without a session, the bare URL answers **401** ("sign-in required"
page, no repository data) and `/rpc` answers a `CONTROL_UNAUTHENTICATED`
error; once signed in, the old `/api/*` routes answer **410** (replaced by
the protocol). The token itself is neither logged, nor in a URL, nor in a
cookie: it lives in a file readable by the user alone (0600 on POSIX, ACL
reduced to the user on Windows — `CONTROL_TOKEN_UNPROTECTED` refusal if it
cannot be set).

- `--daemon` runs it as a native detached process (same mechanism as
  `striart watch --daemon`, including the recognition of the published PID,
  the PID file lock and `--stop`'s clean stop — `.striart/dashboard.stop`,
  `.striart/dashboard.pid.lock`) and prints the sign-in link itself: the
  daemon never emits one (its output is a log on disk).
- `--link` issues a **new** link for the dashboard already running (the
  daemon's, or the one on `--port`) — `CONTROL_INSTANCE_NOT_FOUND` if none
  runs. Refused inside an agent session (`CONTROL_NESTED_SESSION`).
- `--status` also shows the actual address; `--stop` stops it.

Barriers, in order, on **every** request (reads included): a `Host`
header equal to the instance's name (anti-DNS-rebinding; the bare `localhost`
address is refused with 403 unless `dashboardHostname: 'localhost'`) or one listed
in `dashboardAllowedHosts`;
`Sec-Fetch-Site` neither cross-site nor same-site (403); a valid session
(401); then, on `/rpc`, the server's `Origin`, `X-Striart: 1` and a JSON
`Content-Type` (403: `CONTROL_ORIGIN_REFUSED` / `CONTROL_CSRF_REFUSED`).
`dashboardAllowedHosts` (empty by default) additionally accepts a public
name — Codespaces `*.app.github.dev`, a reverse proxy — and **relaxes only**
the `Host` check: token, cookie, `Origin` and anti-CSRF stay required; the
relaxation is logged at every start and shown by `doctor`. Details and
threat model: [SECURITY.md](../../SECURITY.md).

## Repairing and cleaning

### `striart rollback`

Undoes the **last Striart merge**: local reset (recoverable via reflog) if
the merge isn't pushed, revert otherwise (published history is kept).
Refuses if the target branch's last commit isn't a Striart merge
(`NOT_A_STRIART_MERGE`) — merges produced by `resolve --apply` are now
recognized too — or if the target branch has no commit (`UNKNOWN_BRANCH`) or is
not the current branch (`TARGET_BRANCH_MISMATCH`). A `revert` (already published
merge) also runs the target's hooks under `commitTimeoutMs`: rejection or
timeout → `COMMIT_HOOK_REJECTED`, `HEAD` unchanged, no ticket. Deliveries in
flight in this process are awaited before deciding "published?".

### `striart resolve [--unlock | --close <id> | --prepare <id> [--accept-theirs <path>…] | --apply <id>] [--all]`

Conflict tickets (`.striart/conflicts/<ticket>/`: BASE/OURS/THEIRS versions,
LLM attempt, Test Gate log). With no option: lists open tickets — `--all`
adds the already resolved ones. `--close <id>` marks a ticket resolved
**without going back through the Test Gate** (by hand, once the conflict was
fixed outside Striart) — on an already resolved ticket it is a refusal
(`TICKET_ALREADY_RESOLVED`, exit 3), like `--apply`, so that a script chaining
commands does not believe it acted; `--unlock` re-enables semantic merging after the
switch to manual mode (3 failures in a row). The four actions are mutually
exclusive.

The same agent commit retried (watch re-triggering, merge rerun) does not
create one more ticket: the **open** ticket for it is updated (`attempts`,
`updatedAt`, versions refreshed) and resolutions already prepared
(`.resolved`/`.delete`) are never touched. A ticket's id is the **name of its
directory**. The files of a ticket (`<prefix>.base`, `.ours`, `.theirs`,
`.llm-attempt`, `.resolved`, `.delete`) are named from the path by an
**injective** encoding (`ticket.fileNaming: 2`: every byte outside
`[A-Za-z0-9._-]` is written `%HH`, a too-long name is shortened with a SHA-256
digest) — `a/b.txt` and `a__b.txt` no longer share their resolution files,
which convention 1 (`/` and `\` → `__`) allowed; it is still read for tickets
created before. A ticket for a Test Gate execution failure carries
`gate: {code?, orphanPids?, truncated?}` (the stable code of the red —
`GATE_ORPHAN_PROCESS`…, the PIDs of the orphans killed, the log truncated at
the ceiling).

`--prepare <id>` and `--apply <id>` are the **tested** path for human
resolution — recommended over `--close`: the resolution goes through the
same inter-process lock and the same blocking Test Gate as the automatic
merge, instead of a `git merge` done by hand outside Striart (the source of
a real incident: a collision with an active `striart watch`).

- `--prepare <id>` seeds `<file>.resolved` in the ticket directory for every
  conflicted file with no resolution prepared yet, from `.theirs` (falling
  back to `.ours` then `.base`) — a starting point to edit, never overwritten
  if already present. **Exception: the paths of a `PROTECTED_PATHS_CHANGED`
  ticket** are never seeded from the agent's version — the `.resolved` file
  is what tells the human's decision from the agent's, and automatic seeding
  would have the human approve it unread. They are reported as *held*
  (`held: true` in `--json`, a warning line with the exact command); the
  human writes the final content, or explicitly names the path to take as the
  agent left it: `--prepare <id> --accept-theirs <path>` (repeatable;
  refused without `--prepare`, `OPTION_CONFLICT`).
- `--apply <id>` replays the ticket's **exact** merge (`ticket.sha`, not the
  agent's current head, which may have moved since) and applies the
  `.resolved` (final content, binary supported) and `.delete` (resolution =
  deletion) files prepared in the ticket directory, behind the blocking Test
  Gate. Green → commit (visible in `striart history` as a manual
  resolution), the ticket is closed (along with its duplicates on the same
  files of the same agent), the semantic failure counter is reset. Red →
  exit 3, the ticket stays open, **nothing** is touched on the counter or
  manual mode (a failed manual resolution isn't an LLM failure). A target hook
  that rejects the commit (`COMMIT_HOOK_REJECTED`) likewise leaves the original
  ticket open and intact. Refused
  without changing anything if: the ticket is already resolved
  (`TICKET_ALREADY_RESOLVED`), the conflict isn't file-by-file
  (`TICKET_NOT_APPLICABLE`), the resolution is incomplete
  (`RESOLUTION_INCOMPLETE`), the agent is unknown, an autonomous session is
  alive, or the ticket is stale (`STALE_TICKET` — the main repo or the
  agent's history moved since).

### `striart lock [--start <reason> [--pid <n>] | --stop]`

Reserves or releases the main repo for **direct work outside the
Router/agents**: manual editing without a commit, resolving a conflict by
hand with a raw `git merge`. Same mechanism as `--on-main` (session declared
in `.striart/main-session.json`, `assertNoLiveMainSession` guard in
`withMainLock`) — fixes a real incident where a manual resolution had been
undone by orphan-merge recovery while an active `striart watch` took the
lock.

- `--start <reason>`: reserves, under the main lock (two concurrent
  reservations cannot both succeed). The watched PID is the **calling
  shell**'s, provided it is a durable interactive shell: a process that
  isn't a shell, a shell running a single command (`bash -c`, `cmd /c`,
  `pwsh -Command`) or Git Bash/MSYS's ephemeral copy would die with the
  command and disarm the reservation at once — fail-closed refusal
  `LOCK_PID_EPHEMERAL`, with the corrective command suited to the detected
  shell (`--pid $PID` in PowerShell, `--pid $$` in bash/zsh,
  `--pid $fish_pid` in fish, `--pid $(cat /proc/$$/winpid)` in Git Bash).
  The npm `cmd /c striart.cmd` shim is skipped to designate the real
  terminal, and the reason is quoted in that shell's grammar (never a line
  that would expand `$(…)`). An explicit `--pid <n>` is only checked for
  liveness: a dead PID is refused (`LOCK_PID_DEAD`) — a reservation that
  protects nothing is worse than no reservation. Empty reason:
  `LOCK_REASON_EMPTY`; `--pid` without `--start`: `OPTION_CONFLICT`.
- `--stop`: releases — **an emergency exit that is always allowed**, even if
  the declared PID is still alive.
- With no option: shows the status (free / busy with reason, PID and
  duration / dead PID).

**No TTL** (unlike `.striart/main.lock`): direct work can legitimately last
hours; `striart lock --stop` is the only way out if the PID was recycled by
the OS.

### `striart clean [agent] [--stopped | --all] [--force]`

Frees disk space: clones of stopped agents by default (`--stopped` says so
explicitly); `--all` includes active agents **with no pending work**
(stopped, then deleted). Two levels of refusal, depending on what Striart
knows:

- `IN_USE` — the clone's disk changed less than `presenceMinutes` minutes
  ago: a **heuristic**, which `--force` may override knowingly;
- `SESSION_LIVE` — an autonomous session's PID is alive, **or** the pty host
  of a terminal opened by `--open` is running: a **verified fact**, which
  `--force` **cannot** override (`striart stop` stops the pty host).

Uncommitted or unmerged work (`PENDING`, `BUSY`) also protects the clone;
with `--all`, `--force` then accepts abandoning the unmerged work. A named
agent with no clone found: `CLONE_NOT_FOUND`.

Removing a clone is **replayable**: a marker `.striart/removing/<agent>.json`
(and `removing: true` in the registry of an active agent — `REMOVING` state
in `status`) is written *before* the `rm`, retried with exponential backoff,
then removed along with the registry entry. An interrupted `rm` (crash, a
Windows handle held) no longer leaves a half-deleted clone still registered:
`striart reconcile` finishes the removal already decided — unless a session
lives in the clone (a verified fact, never bypassed). Until it is done, the
name cannot be reused (`CLONE_REMOVAL_PENDING`).

The peripheral artifacts of a removed clone (ACP session host, Warp *Tab
Config*) are released with it. A failure at that level does not undo the
removal: it is reported (`data.artifactErrors`, `AGENT_ARTIFACT_FAILED`
warning).

### `striart reconcile`

**Reconciliation** (level-triggered): neutralizes dead sessions in the
registry, unblocks the queue (even when no commit triggered it — e.g. a
`clean` of a blocker), repairs orphan locks and merges, and **finishes the
clone removals already started** (`.striart/removing/` markers). Idempotent —
can be run at any time without risk. Replayed automatically by
`striart watch`.

### `striart prune [--days <n>] [--dry-run]`

Retention: prunes idle stopped clones, resolved tickets and inactive session
(`session-*.log`) and terminal (`pty-*.log`) logs older than N days
(`--days`, otherwise the config's `pruneDays`, default 14; `0` makes
everything stopped or resolved eligible) — never an active agent nor an open
ticket. The token usage ledger (`.striart/usage/`, daily files and result
cache) follows its own retention, `tokens.retentionDays` (90 days),
independent of `pruneDays`. A deletion that fails (handle held on Windows) is
reported in `failed`, never swallowed. `--dry-run` previews. An invalid retention is refused (exit 2, or
`INVALID_RETENTION_DAYS` at the API level) instead of deleting everything. A
periodic `striart prune` (cron/scheduled task) keeps `.striart/` healthy.

### `striart gc [agent] [--close] [--dry-run]`

**Idle garbage collector** (`src/idle/`). A forgotten agent — a terminal left
open, an ACP or autonomous session that no longer produces anything — keeps a
process, a host and a clone alive indefinitely. `gc` detects these agents and,
according to `idle.action`, **reports** them, **warns** them and closes **their
session**. It **never** touches the clone or the uncommitted work, does not
merge, does not rebase, removes nothing from the registry: it is the only
exception to "a clone whose session is alive is untouchable", and it concerns
the session only. Settings: the
[`idle` block](configuration.md#idle--the-gc-of-idle-agents-and-sessions);
threat model: [SECURITY.md](../../SECURITY.md).

**What "idle" means.** An agent is idle only if **all** its signals are older
than `idle.warnAfterMs` (30 min by default): activity is the *maximum* of the
timestamps, never a single signal.

| Signal | Source |
|---|---|
| `sessionStart` | clone creation, start of the last session, start of the ACP or terminal host — a session that has just been born is not idle |
| `sessionOutput` | last output of the agent: `.striart/idle/beats/<agent>.beat` heartbeat (argv autonomous session, touched by the supervising process at most every 10 s); session log (ACP); terminal: `host.output`, published by the native pty host |
| `worktree` | last real write in the clone's worktree |
| `refs` | `HEAD` reflog and the clone's branch references |
| `messages` | the clone's collaboration mailboxes (`.striart-inbox.md`, `.striart-outbox.json`) |

**Fail closed.** An unreadable signal, a file clock more than 5 s ahead, or the
absence of any signal makes the agent **active**, never idle. As soon as one
fresh signal is known, the worktree walk is skipped. An "unobservable" signal
(this kind of host does not publish it) counts neither for nor against. A
terminal whose last output is not observed (older native host that does not
publish `host.output`, program still silent) can only be closed under
`idle.closePty: true` (`PTY_OUTPUT_UNOBSERVABLE` in `closeBlockedBy`).

**Gradation.** Detect → warn → grace period → close:

- `idle.action: 'report'` (default): detection and report only (status,
  `idle:detected` event once per idle period).
- `'warn'`: also a warning (log, webhooks, `idle:warned` event). It only holds
  for the current idle period: any activity makes it stale.
- `'close'`: also the session is closed if the warning is at least
  `idle.graceMs` (5 min) old, if the inactivity reaches `idle.closeAfterMs`
  (2 h) and if **the user has authorized it** for this repository
  (`idle.closeRoots` in the
  [user configuration](configuration.md#user-configuration-outside-the-repository));
  a fresh re-check, just before acting, cancels the close if a signal appeared
  in the meantime. Without authorization, `close` degrades to a warning and the
  report says so (`closeAuthorized: false`).

**Guards.** Whatever the inactivity, an agent is *protected* (never touched) if
it has a pending human request (permission, question), an open conflict ticket,
a live orchestration plan or group (or membership of a collaboration group), a
merge/stop/sync/start/reuse in progress, a removal in progress, a main-repository
session or a config exclusion (`idle.excludeAgents`, `idle.excludeProfiles`). If
a **context source is unreadable** (human requests, tickets, orchestration, lock,
main session, GC state), the sweep stays cautious: no closure.

**How the session is closed** (never a blind kill):

- **ACP**: a stop request read by the host (`session/cancel`, agent shutdown);
  falls back to the tree kill only if the host is identified.
- **Terminal** (native pty host): the same host stop protocol.
- **Autonomous argv session**: the process that supervises it receives a stop
  request on disk, acknowledges it, then cancels it through its normal path
  (`CANCELLED`, clone kept). Supervisor alive but mute: **no kill**
  (`IDLE_CLOSE_NOT_ACKNOWLEDGED`). With no known supervisor, the agent cannot be
  identified (`IDLE_CLOSE_UNVERIFIED`, detail `NO_SUPERVISOR_RECORD`); *orphan*
  agent (dead supervisor): SIGTERM (POSIX) then tree kill, after its identity is
  checked against its creation time.

At most `idle.maxClosuresPerSweep` (4) sessions are closed per sweep. Never the
main repository's session, never Striart itself.

**Options.**

- `[agent]`: restrict the sweep to this agent (unknown: `AGENT_UNKNOWN`).
- `--dry-run`: writes nothing (no state, no event) and closes nothing; shows what
  would be warned or closed.
- `--close`: a *human request* to close. Replaces `idle.action` and the
  `idle.closeRoots` authorization, but **not** the prior warning, the grace
  period, the `closeAfterMs` threshold or the guards.

**Output and codes.** `0`: sweep done. `3`: at least one closure was **refused**
by a guard (`IDLE_CLOSE_BLOCKED`, `IDLE_CLOSE_UNVERIFIED`,
`IDLE_CLOSE_NOT_ACKNOWLEDGED`) — the session is intact, rerunning as is will not
change anything. `1`: a stop failed (`IDLE_CLOSE_FAILED`). These codes are
carried by the report (`refused[].code`), not thrown: a recalcitrant agent does
not stop the sweep. `--json` renders the full report (thresholds, agents, signals
read, `plan`, `closeBlockedBy`, `warned`, `closed`, `refused`).

**Where it runs.**

- **By hand**: `striart gc`, then `striart gc --dry-run` to preview.
- **In `striart watch`**: a sweep every `idle.sweepIntervalMs` (5 min), **outside
  the merge chain** and never under the main lock; one at a time. Waking up from
  sleep (the timer fires very late) neutralizes that round — agents frozen with
  the machine have not had time to resume. Stream events: `idle-warned`,
  `idle-closed`, `idle-refused`, `idle-error`.
- **Read-only**: `striart status` ("live idle sessions" line with the
  `striart gc --dry-run` hint), `striart_status` (MCP) and the Control Protocol
  state carry an additive `idle` field; `watch --ui` and `watch --plain` show
  "idle for N min"; the dashboard a badge, a card and a button (see the
  dashboard section above). The agent plane (MCP) exposes **no** GC tool.
- **Human plane**: the Control Protocol `workspace.gc` method (`dryRun`,
  `close`, `agent`).

The persistent state (warning instants, claimed closure) lives in
`.striart/idle/state.json`, under the state lock; the inactivity itself is never
stored, it is recomputed at every sweep.
## Integration

### `striart promote [--rollback]`

staging → main promotion of the [two-stage pipeline](branches.md#the-staging--main-pipeline):
global Test Gate (`promoteTestCommand`) then fast-forward of `mainBranch`.
Exit 3 if the gate is red (`PROMOTION_GATE_FAILED` ticket); `--rollback`
then resets staging to main (destructive, opt-in). Refusals:
`PROMOTION_DISABLED` (no `mainBranch`), `MAIN_DIVERGED` (`mainBranch` has
commits outside the pipeline, or moved during the gate: the update is a
compare-and-swap on the old SHA, never a `git push .` that would run the
target's hooks under the lock), `UNKNOWN_BRANCH` (target branch or `mainBranch`
missing or with no commit), `TARGET_BRANCH_MISMATCH`. With `autoPush`,
`mainBranch` is delivered to `origin` outside the lock — or, in
`delivery: 'branch'`, a `striart/promote/<date>-<sha8>` branch is delivered
instead and the remote `mainBranch` does not advance.

### `striart mcp [--root <path>] [--agent <agent>] [--read-only [--collab]]`

MCP stdio server — the **agent → Striart plane**; see [MCP server](mcp.md).
Logs go to stderr: stdout is reserved for the protocol. No `--json` (the
protocol is the output). Started in a **non-initialized** repo it refuses to
start (`NOT_INITIALIZED`, exit 1, empty stdout, hint `striart init`) rather than
expose tools that would fail one by one. The server is **bound to its caller**:

- started from an agent's clone (or with `--agent`), it only acts on that
  agent: its merge, its tickets;
- started outside any clone, it is **read-only**, unless
  `mcp.scope: 'orchestrator'` in the config (a relaxation, logged and
  shown by `doctor`);
- `--root <path>` designates the main repository without depending on the
  working directory (takes precedence; `MCP_ROOT_INVALID` if it is not an
  initialized Striart repository); `--agent` must name a registered agent
  and cannot contradict the clone of the current directory
  (`MCP_SCOPE_CONFLICT`);
- `--read-only` exposes no mutating tool; `--collab`, with `--read-only` and
  a bound agent, adds the single `striart_collab_post` (this is what
  Striart's ACP sessions pass to their agent); without a bound agent,
  `--collab` is inert.

### `striart api --stdio [--framing <f>]` and `striart api --schema [openrpc|json-schema]`

The **Striart Control Protocol v1** on stdio: the **human plane** for IDE
extensions (VS Code, JetBrains) and any local JSON-RPC 2.0 client. Only the
VS Code extension exists so far (`extensions/vscode/`, delivered but **not
published**: see [VS Code and Cursor](integrations/vscode-cursor.md#vs-code-extension));
the JetBrains plugin is not delivered. Zero
network surface: the extension launches the CLI as a subprocess, which works
as is over Remote SSH, devcontainers and Codespaces. stdout is the protocol
(logs go to stderr). Like `mcp`, it refuses a non-initialized repo
(`NOT_INITIALIZED`, exit 1). Framing is the client's choice: `ndjson` (one message
per line, default) or `content-length` (LSP style, that of `vscode-jsonrpc`
and `lsp4j`); a message over 1 MB is dropped and reported without closing
the stream. The requests of one connection run in parallel (bounded),
responses carry the `id` of their request, the elements of a batch run in
order. A request `id` is a string, `null` or a **safe integer**
(`Number.isSafeInteger`): a fractional number, or one outside the range of
exactly representable integers, is refused (`CONTROL_INVALID_REQUEST`,
response `id` `null`). `session.log` returns the **tail** of the session log
(64,000 bytes at most, read from the end of the file, never loaded whole: a
log can weigh hundreds of MB), realigned on a UTF-8 character boundary.

The 29 methods (negotiation `control.initialize`, `rpc.discover`) cover the
state (`state.get`, `state.subscribe` — current state then `state.changed`
and `control.notice` notifications, with a sequence number and a monotonic
revision, coalescing if the client reads too slowly —, `ticket.get`,
`session.log`, `doctor.run`, `orchestration.state`), the actions
(`task.run`, `agent.merge`, `agent.sync`, `agent.stop`, `queue.retry`,
`reconcile.run`, `staging.promote`, `merge.rollback`, `ticket.prepare`,
`ticket.apply`, `clones.clean`, `workspace.prune`, `workspace.gc` — the
[idle GC](#striart-gc-agent---close---dry-run)) and the gestures
**reserved to the human**: `ticket.close`, `permission.answer`,
`elicitation.answer`, `review.answer`, `mainSession.release`,
`semantic.unlock`. Every result is a `--json` document
(`{schemaVersion, command, ok, outcome, data}`); every error carries the
same document in `error.data`. `--schema openrpc` prints the OpenRPC
description of the methods, `--schema json-schema` the schema of the
`--json` document (no argument: `openrpc`); both ship in `schemas/`.
**Refused inside an agent session** (`CONTROL_NESTED_SESSION`,
`STRIART_SESSION=1`): an agent must not arbitrate its own permissions nor
close its own tickets — an *advisory* guard, see
[SECURITY.md](../../SECURITY.md). The HTTP transport of the same protocol is
that of the [dashboard](#striart-dashboard---port-p---daemon----status----stop----link).

### `striart acp [--root <path>] [--profile <profile>]`

Striart as an **ACP v1 agent** for an editor (Zed, JetBrains, Neovim, Emacs,
any ACP client): JSON-RPC on stdin/stdout. **A session opened by the editor
= an isolated clone + the chosen upstream agent + a merge under the Test
Gate.** Creating the session (`session/new`) creates nothing: the editor
receives the options (upstream agent, permission policy, end of session). On
the first prompt, Striart goes through the Router, creates the clone
(secrets, collision guard, autonomous mode — the watcher never merges it),
and launches the upstream agent through its own ACP client, in a persistent
session host, with its files and terminal **bounded to the clone**: the
editor's are **never** used nor relayed. Later prompts arrive through the
host's bus. The editor sees the progress, arbitrates permissions (`ask`
policy by default: the human decides *in* the editor, fail closed at the
deadline) and receives the outcome. Ending the session — `/striart-finish`,
closing the session or disconnecting per `acpAgent.onDisconnect` — applies
the commit contract, merges under the Test Gate (a ticket if red) and cleans
up without `force`; `/striart-status` shows the state. The upstream agent's
own commands (`/status`, `/compact`…) are relayed as is: Striart's are
prefixed.

- `--root`: every session must be inside this repository
  (`ACP_PROXY_CWD_OUTSIDE_ROOT` otherwise); by default, derived from the
  session's directory.
- `--profile`: upstream profile offered by default (takes precedence over
  `acpAgent.defaultProfile`). The profiles offered are those of
  `agentProfiles` declared `acp: true`, restricted by `acpAgent.profiles`;
  with none: `ACP_PROXY_NO_PROFILE`.
- Settings: `acpAgent`
  ([Configuration](configuration.md#acpagent--the-acp-proxy-striart-acp)).
  Refused inside an agent session. Per-editor integration:
  [Zed](integrations/zed.md), [JetBrains](integrations/jetbrains.md),
  [Neovim](integrations/neovim.md), [Emacs](integrations/emacs.md).

A malformed editor request gets a JSON-RPC error (`code`, `message`, and the
stable Striart code in `data.code` — the `ACP_PROXY_*` of
[troubleshooting](troubleshooting.md)). The advertised authentication is
`striart-local`: Striart has no account.

### `striart hook install|uninstall <tool> (--user | --agent <agent>) [--dry-run]`

The **advisory hooks** of the coding tools (Claude Code, Codex, Copilot CLI,
Gemini CLI, Cline). The `striart hook <tool> <event>` sub-mode is called *by
the tool* on each event (before and after a write tool, end of session): it
**informs** — a file the agent is about to write is predicted by the Router
or locked by another agent, a supervised session ends — and **never**
blocks: exit 0 and a neutral answer on any anomaly (unknown tool, oversized
input, invalid JSON, unreadable registry, outside a clone). For Claude Code,
Codex and Gemini CLI an exit code 2 would block the action; Copilot would
refuse on any non-zero code.

- `--user` writes the tool's **user** configuration (`settings.json` in the user's `.claude` folder,
  `~/.codex/hooks.json`, `~/.copilot/hooks/striart.json`,
  `~/.gemini/settings.json`, `~/Documents/Cline/Hooks/`): the hook serves in
  every project and stays neutral outside a Striart clone.
- `--agent <name>` writes it in the agent's **clone**, in an untracked file
  locally excluded from git — never in a versioned file
  (`HOOK_TARGET_TRACKED`: the agent would commit it and the protected-paths
  guard would refuse the merge). A file that is not Striart's is never
  overwritten (`HOOK_TARGET_FOREIGN`), an unreadable configuration file
  never rewritten (`HOOK_CONFIG_UNREADABLE`).
- `--dry-run` shows the files that would change without writing anything. A
  missing or doubled scope: `HOOK_SCOPE_REQUIRED`; unknown tool:
  `HOOK_TOOL_UNKNOWN` (usage: exit 2).
- The `hooks.collisions` and `hooks.notifySessionEnd` settings
  ([Configuration](configuration.md#hooks--advisory-hooks)) each turn off one
  of the two notices. A hook installed for the user only reads the
  repository's **data** config (never a `striart.config.mjs`); installed in
  a clone, it loads the full config of the root chosen at installation
  (`--root`), like a root listed in `hooks.trustedRoots` of the *user*
  config — see [SECURITY.md](../../SECURITY.md).

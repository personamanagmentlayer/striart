# AGENTS.md — Striart

Guidance for AI coding agents (and humans) contributing to Striart. Format:
[agents.md](https://agents.md/). The human contributor guide is
[CONTRIBUTING.md](CONTRIBUTING.md); the threat model is
[SECURITY.md](SECURITY.md); the architecture is described in
[docs/en/architecture.md](docs/en/architecture.md).

## What Striart is

A multi-agent Git orchestrator for AI coding agents: each agent works in its
own full Git clone (`.striart/agents/<name>/`), a Router predicts the files a
task will touch and serializes colliding tasks, and every merge goes through a
semantic merge step and a blocking Test Gate before it lands on the target
branch.

## Setup

Requirements: Node.js 22.18 or later (22 or 24 LTS recommended), Git, and a
Rust toolchain (via rustup; the pinned version in `native/rust-toolchain.toml`
installs itself) to build the native binary.

```bash
npm install
npm run native:build     # the native binary (process identity, tree kill, pty host)
npm run dev              # CLI with automatic reload (node --watch-path)
```

There is nothing to build on the JavaScript side in development: Node runs
the TypeScript sources directly (native type stripping). Only packaging emits
JavaScript. The native binary is required from a source checkout; without it
commands that touch processes fail with `NATIVE_UNAVAILABLE`, never silently.

## Checks to run before proposing a change

```bash
npm run test:unit        # fast loop: mocked LLM, no real Git
npm run test:integration # real temporary Git repositories (several minutes)
npm run typecheck        # tsc over .ts and JSDoc-annotated .js
npm run lint             # ESLint (correctness) + Prettier --check
npm run format           # Prettier --write, if lint reports formatting
npm run native:lint      # rustfmt --check + clippy, when you touch native/
npm run native:test      # cargo test, when you touch native/
```

`npm test` runs the unit and integration projects together. `npm run test:pack`
builds and installs the published package and needs network access.

## Code conventions

- ESM only (`"type": "module"`), no `require()`. `async`/`await` throughout,
  early returns, side effects (Git, filesystem) isolated in dedicated modules.
- New code is TypeScript with **erasable syntax only** (no `enum`, no runtime
  `namespace`, no parameter properties). A `.ts` module is imported with its
  `.ts` extension; type-only imports use `import type`. Shared data contracts
  live in `src/types.d.ts`.
- Never build a module path at runtime (`new URL('./x.ts', import.meta.url)`):
  packaging only rewrites static and literal `import()` specifiers.
- Git operations go through `simple-git`; filesystem access through
  `fs/promises`; logs through `src/logger.js` (pino), never `console.log` in
  library code. CLI output: stdout carries data only, everything else goes to
  stderr.
- Errors are thrown as `StriartError` (`src/errors.js`) with a stable `code`
  classified in `ERROR_KINDS`, an actionable English message and a `hint`.
  `details` carries identifiers only — never configuration values, URLs or
  secrets. Fail closed; never degrade silently.
- External commands run as `argv` with `shell: false`. User data (prompts,
  agent names, ticket ids) never becomes code or a path.

## Tests

- Vitest. `tests/unit/` is mocked and must stay fast (no disk-heavy work, no
  real Git); anything touching Git, the filesystem or processes belongs in
  `tests/integration/` (temporary repositories via `tests/helpers/temp-repo.js`).
- For a bug fix, write the test that reproduces it first and check that it
  fails without the fix.

## Invariants — do not break

- Every mutating operation on the main repository runs under the main lock,
  and the lock is never held during a long operation (agent session, Test
  Gate, LLM call).
- Nothing is committed to the target branch unless the Test Gate passes.
- Agents use full clones, never Git worktrees; only the orchestrator pushes.
- A clone whose session is alive is never rebased, merged or deleted.
- LLM output is untrusted content: Router paths are filtered, merged code goes
  through the Test Gate.
- A lock (main or state) is never broken if its holder may be alive — only on
  proof (dead process, recycled PID, old invalid content). Lock order is fixed:
  main lock, then state lock. JSON state files are written atomically and
  modified under the state lock.
- Three planes, never mixed: agent → Striart (MCP, bound to the calling clone,
  no human-arbitration tool), human → Striart (Control Protocol, refused inside
  an agent session), Striart → agent (ACP client). Never give one plane the
  power of another.
- An agent never changes the files that instruct or configure agents, or
  Striart's own config: such a merge is refused (protected paths).
- The native binary is never run unverified (signed manifest, digest, version),
  and the signing private key never enters the repository.
- Every relaxation of a protection is explicit, logged and shown by
  `striart doctor`; an unknown key in a security block of the config is
  refused.

Changes to these invariants, to the dashboard, the MCP server, session
launching or terminal opening deserve an issue first: read
[SECURITY.md](SECURITY.md) before touching them.

## Pull requests

- Search the existing code before adding a helper; reuse or extract rather
  than copy.
- Keep `docs/en/` and `docs/fr/` in sync when behaviour visible to users
  changes, and add new error codes to `docs/en/troubleshooting.md` and
  `docs/fr/depannage.md` (and their English translation to
  `src/cli/i18n/en.ts`). Document what is delivered, not what is only decided.
- Do not commit generated files (`dist/`, `coverage/`, `.striart/`) or secrets.

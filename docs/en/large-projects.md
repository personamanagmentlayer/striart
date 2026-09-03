# Large projects

> [Documentation](README.md) · Large projects

Isolation through real clones costs disk — here is how to keep it in check:

- **History is already almost free**: the clone is made by local path, and
  git hardlinks `.git/objects` (immutable objects → safe even if the main
  repo runs a `gc`: its `unlink`s don't touch the clones' inodes). Only the
  worktree is a real copy — that's the price of isolation, incompressible
  without risk.
- **Very large histories**: `cloneFilter: 'blob:none'` in the config — old
  blobs are fetched on demand from the main repo (kept as a fetch-only
  promisor remote, `pushurl` neutralized — the rule "clones have no pushing
  remote" still holds).
- **`node_modules`**: use **pnpm** in the target project (global store shared
  through hardlinks, managed by a tool designed for it). Never share
  `node_modules` between agents via symlink: tooling caches
  (`node_modules/.cache`, Vite, webpack) write to it constantly.
- **Monitoring and cleanup**: `striart status` and the dashboard show each
  clone's additional size (hardlinks count as 0); `striart clean` removes
  stopped agents' clones, and `striart prune` applies retention (stopped
  inactive clones and tickets resolved more than `pruneDays` days ago —
  `--dry-run` to preview). A periodic `striart prune` (cron/scheduled task)
  keeps `.striart/` healthy.
- **Warm restarts**: `striart start <agent> --reuse` rehabilitates a stopped
  agent's kept clone — untracked files preserved (`node_modules`), no
  reinstall. See [Commands](commands.md#striart-start-agent---reuse---force).

# A5 — Isolation: implementation notes

Files: `src/agents/isolation/{index,none,toolset,file-ownership,worktree,warnings}.ts`,
tests in `src/__tests__/isolation.test.ts` (29 tests, real git repos in tmpdirs).

## Interface, as built

`IsolationStrategy` matches §7.1 exactly (`name` / `check` / `allocate` / `release`).
`IsolationContext` gained four optional fields §7.1 did not name, because the
strategies need them and nothing outside `isolation/**` could be edited to supply
them another way:

| Field                | Who needs it             | Why                                                                                                                                                                                             |
| -------------------- | ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `peers?: LivePeer[]` | `none`, `file-ownership` | roster ∩ registry, computed by the caller. Keeps strategies pure and is the mechanism behind claim-as-lease: a disconnected agent is simply absent, so its claim stops blocking with no reaper. |
| `toolset?`           | `toolset-limited`        | the profile's tool lists; the context otherwise carries no profile.                                                                                                                             |
| `strict?`            | `file-ownership`         | warn by default, refuse under `--strict` (§7.2).                                                                                                                                                |
| `exitedAt?`          | `worktree`               | the `agent_exited` row's timestamp, which anchors `RECLAIM_GRACE_MS`.                                                                                                                           |

**Wiring the supervisor needs to do:** build `peers` from `agentLog.roster()` ∩
`registry`, mapping each peer's `ref.claims` (comma-joined at allocate time) back
to an array; pass `exitedAt` from the `agent_exited` row on reclaim; pass
`profile.allowedTools` / `disallowedTools` as `toolset`.

## Warning vs refusal

§7.1 gives `check` one `string[]`, but `spawn_result.warnings` implies two
classes. Rather than widen the frozen interface, advisory lines carry a
`warning: ` prefix (`warnings.ts`); anything unprefixed is a refusal. Callers use
`refusalsIn(reasons)` to gate the spawn and send the whole array as `warnings`.

## Worktree

- Allocation state comes from `git worktree list --porcelain` filtered to
  `<gitRoot>/.worktrees/`, **not** from a table. `isolation_allocated` events stay
  the supervisor's business; the strategy never reads them, so the two cannot drift.
- Branch `agent-chat/<slug(name)>`, worktree `<gitRoot>/.worktrees/<slug(name)>`.
  The slug exists because the name arrives from a model — `../../etc/pwned`
  cannot escape `basePath`, and there is a test for it.
- `findGitRoot` uses `--git-common-dir`, so allocating from inside a worktree
  still targets the main repo. Tested.
- `.claude/` is copied in so hooks fire.
- Budget defaults to 3 via `createWorktreeStrategy({ budget, basePath })`; the
  default export `worktreeStrategy` is the registry's instance.
- `allocate` sets `ref = { branch, worktree, gitRoot, base }` (plus `reused: 'true'`
  when it adopted). `release` needs that ref — an allocation without one is
  refused, never guessed at.

### Re-allocating over a crashed agent

`allocate` used to `branch -D` unconditionally, which destroyed the commits of an
agent that died before calling release. It now branches three ways:

| Leftover state                            | Behaviour                                                         |
| ----------------------------------------- | ----------------------------------------------------------------- |
| branch holds commits, worktree dir gone   | **adopt** — `worktree add <path> <branch>`, `ref.reused = 'true'` |
| branch holds nothing beyond base          | reset to current HEAD, so nobody inherits a stale base            |
| worktree dir on disk / branch checked out | throw `WorktreeInUseError`                                        |

Adoption rather than refusal, because a respawn under the same name _is_ that
agent continuing: handing back its own branch is what the operator wanted and it
needs no human rescue. `ctx.forceReset` discards and resets in every case,
including over a worktree still on disk — the allocate-side counterpart to
`ReleaseOptions.force`.

### Release refusal, and one deliberate divergence

Refuses (returns `false`, touches nothing) when dirty, when the branch holds
commits that exist nowhere else, or when `exitedAt` is inside the 120 s window.

brain compared against `origin/main` and treated "no remote" as safe. agent-chat
runs against local checkouts that often have no remote at all, where that reading
deletes every commit the agent made. The comparison is now: `origin/<branch>` if
it exists, else the commit the branch forked from (`ref.base`). Over-refusal is
the accepted failure mode — `force: true` is one flag away, and it is tested in
both directions (refuses unpushed, releases once pushed to a real bare remote).

## file-ownership

Pure half lifted from brain with one fix: brain's `globToRegex` emitted the
interior form for a trailing `**`, so `src/agents/**` matched **no file at all**
— silently, which for an advisory system means the advice never appears. Trailing
`**` now compiles to `.*`. Everything else is behaviour-for-behaviour.

## Composition

`resolve(names)` returns a single strategy directly and composes otherwise:
`allowedTools` intersect, `disallowedTools` union, `cwd` from the last strategy
that moved it, notes joined, refs merged. A failed allocate unwinds earlier
members with `force`. Supervisor should call `resolve()` even for one name, so
`['toolset-limited','worktree']` stays a config change.

## Not done, deliberately

- `worktree` sets no `addDirs`. Adding the base repo would grant write access
  back to the shared checkout via `--add-dir`, which defeats the isolation.
- `.worktrees/` is not added to any `.gitignore` — that is a repo-owner decision
  and lives outside this step's file ownership.
- No supervisor/CLI wiring, no event emission, no `--strict` flag plumbing.

# `agent-chat counts`

`agent-chat counts [--check] [--json] [--seat <s>] [--root <dir>]` prints every count of implementers, reviewers,
planners, claims, worktrees, slots, file claims and Shepherd reviewers. Each one is derived from live state by the
pure core in `src/agents/counts/` (CC-1282 K1) and printed beside the value each surface shows. Live state is the
truth. The ledger, the slot semaphore and spawn-time claims are caches. Every item a cache holds beyond live state
carries one verdict.

The verb is read-only. It never writes the burndown ledger and never sends a broker mutation.

## Output

One head line per count, then one indented line per item that does not simply agree:

```
implementers seat seat-a: live 1 (roster rows spawning, live or detached that hold the seat's implementing claims) · tick 1 · ledger 3 · UNEXPLAINED
  explained: escalated T-2 a (2h05m)
  UNEXPLAINED: T-3 (implementing claim, agent sa-t-3 not live, no disposition)
slots: live 4 (ps: claude processes) · agent ls 3 · explained
  explained: seat-session pid 4242 seat-a (0m)
shepherd-reviewers: live unread · unread
  unread: shepherd-reviewers (Shepherd exports no reviewer-slot reading)
```

The head line ends with the count's worst verdict: `agree`, `explained`, `UNEXPLAINED` or `unread`. An explained item
names its code (`spawning`, `respawn-pending`, `in-review`, `escalated`, `stale-action-due`, `slices-queued`,
`park-held`, `park-refused`, `parked-claim` or `seat-session`) and its age. A code past its age bound is unexplained.

`--json` prints one object, `{ "exit": 0 | 1 | 2, "counts": Count[] }`, where `counts` is K1's `Count[]` exactly.
The tp-operator cron reads this form.

`--seat <s>` keeps that seat's counts and the machine-wide ones (worktrees, slots, file claims, Shepherd reviewers).

## Exit status under `--check`

| exit | meaning                                                                               |
| ---- | ------------------------------------------------------------------------------------- |
| 0    | Every count agrees, or each difference is explained inside its age bound.             |
| 1    | At least one item is unexplained.                                                     |
| 2    | A live reader failed. An unread count is never printed as agreeing, and 2 outranks 1. |

Without `--check` the verb exits 0 whenever it could print.

## Readers

| input                         | source                                                                                                                                                            |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| roster, slot semaphore        | broker `agents` frame through `tickRoster` (retired rows included; a slow retired read marks the roster partial)                                                  |
| sessions, file claims         | broker `list` frame; sessions are registered names that are no spawned agent                                                                                      |
| processes                     | `ps -ww -eo pid,args`, rows whose executable is `claude`, with the agent id from `agents/<id>/settings.json` and `--name`                                         |
| worktrees                     | `git worktree list --porcelain` for each `git` repo of every seat in the charter                                                                                  |
| open PRs                      | `titan-factory shepherd prs --json`; when that snapshot is unread or older than 10 minutes, one `gh api` read per seat repo                                       |
| Shepherd runs, reviewer slots | `titan-factory shepherd status --json`; a bare run list (before K14) leaves Shepherd's reviewers unread, so `--check` exits 2                                     |
| ledger                        | `~/.agent-chat/burndown.json`                                                                                                                                     |
| last tick                     | the last row of `~/.agent-chat/burndown-ticks.jsonl`                                                                                                              |
| park-kept reasons             | `implementer_park_kept` and `reviewer_park_kept` lines in the tail of `broker.log`, mapped to a tree by the agent's roster `cwd` (K12 moves these to `events.db`) |

The broker reads never auto-start a broker. When the broker is down, the counts that need the roster print unread.

The `park-refused` bound is one tick, because no periodic worktree sweep runs yet. A keep older than that is
unexplained until K12 retries transient keeps.

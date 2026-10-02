# Unattended work: `agent-chat burndown` (CC-slice4-plan.md)

`agent-chat burndown tick` reads the claim ledger, advances every held claim a phase, and
spawns at most one new agent per opted-in initiative: a planner for estimate 3 or more,
otherwise an implementer, headless, on the account the budget gate picked. A worker that
must ask parks and waits for an answer; a worker that reports `DONE` with a PR hands the PR to
Shepherd, which owns CI, review and merge from then on.
`agent-chat burndown install` runs the tick on a schedule through launchd. Full design:
`claude-channels/sources/surplus-2026-09-26/autonomous-burndown-design.md`; slice plan:
`claude-channels/sources/CC-slice4-plan.md`.

## Install

1. Set `enabled: true` in `~/.agent-chat/burndown.config.json`, along with `reportTo` (a
   registered session name a spawned agent's `chat_send` reports to; a real tick refuses
   without it), `maxAgents`, `maxWorktreesPerRepo` and `reserveWorktrees`.
2. Work through every item in the [sign-off checklist](#sign-off-checklist) below.
   `agent-chat burndown install` prints the same list every time it runs, whether or not
   it goes on to install.
3. `agent-chat burndown install`. Add `--dry-run` first to see the plist and the
   `launchctl` calls without changing anything or loading the job.

`install` refuses while `enabled` is false. It writes the plist if absent or changed,
enables the service, bootstraps it if needed, and kickstarts one run.

## Commands

```
agent-chat burndown plan               dry run: what the tick would dispatch now, and every refusal
agent-chat burndown status             claim ledger, stalled claims and each account budget gate
agent-chat burndown tick --once [--dry-run]
                                        one pass: advance every claim, then spawn inside the ceilings
agent-chat burndown pause|resume       stop or resume new spawns from the next tick on
agent-chat burndown release <task>     drop every claim on a task so the tick may pick it again
agent-chat burndown install [--dry-run]
                                        print the checklist, then install and start the launchd job
agent-chat burndown uninstall          stop the launchd job and keep it from starting at login
agent-chat burndown job-status         launchd state: loaded, pid, and whether the tick may spawn
```

`agent-chat burndown plan --seat <name>` prints one seat's dry-run dispatch plan and its
refusals, as seats mode would plan it without the tick's live slot and worktree ceilings.
Add `--scored` for the seat's scored order with every component (`--top` and `--today`
apply only then); `--autonomy-root` points at another charter.

`agent-chat burndown pause` is the kill switch that takes effect fastest: the next tick
sees the pause marker and spawns nothing, but a running agent finishes on its own.
`agent-chat burndown uninstall` also removes the scheduled job itself.

## Seats mode (CC-205)

When `burndown.config.json` lists `seats`, the tick dispatches for those autonomy seats
instead of for briefs' `autonomy:` blocks. It reads the charter and seat files under
`claude-channels/sources/autonomy/` once per tick. Seats and a brief with an `autonomy:`
block together are a config error: the tick refuses before it reads the roster, since
both modes could dispatch the same work.

For each listed seat, in order, the tick:

- takes one sample of the seat pool's `seven_day` reading from the status file under the
  pool's `config_dir`, and keeps the seat's samples for 26 hours in the ledger's `seats`;
- gates the pool with `gatePool`, using the run start the seat watchdog shares
  (`runStartAt`, capped at 12 hours) and the samples as history;
- dispatches the seat planners' ready slices first, then scores the seat's scope and walks
  the order through `planSeat`: eligibility, route, repo, the post-advance collision
  check, orphan, trust on the pool's `config_dir`, role caps, worktree caps, then the pool
  gate;
- spawns on the pool's `config_dir` under the seat's prefix (`<prefix>-<task>`), and the
  new claims carry `seat` and `namePrefix`.

Seats share the tick's `maxAgents`, broker slots and per-repo worktree ceilings; an
earlier seat's dispatches count against a later one. They share their pool too (CC-275):
the pool reading does not move within a tick, so each dispatch planned on a pool, by any
seat, is charged before the next gate at the pool's `dispatch_seven_day_points` and
`dispatch_five_hour_points` (2 and 10 when the charter sets neither). The charge counts
toward the five-hour ceiling, the seven-day line, `per_day_points` and `per_run_points`.
A later seat's collision check also sees an earlier seat's dispatches this tick: the same
task, or a slice whose `owns` overlap one it dispatched in the same repo, is refused as
`claimed`. A seat claim's reviewer and successor spawns are charged the same way (CC-292).
They are resolved before new work is planned, so each one gates on the reading charged
with the spawns before it on its pool, and new dispatches then gate on all of them. When
the pool has headroom for one, an in-flight claim's reviewer wins over a new dispatch. A
spawn the charge closes is deferred, not stalled, and comes back next tick.

A seat file may set `pacing: reset-aware` (CC-404). `seats status` then replaces both
`per_day_points` caps with a day allowance of `(100 - reserve_seven_day -
day_start_seven_day) / days_to_reset`, taking `days_to_reset` from the reading's
`seven_day.resets_at`. `day_start_seven_day` is the current `seven_day` less the day's
spend since 07:00 from the watchdog's day meter (`basis: "day-start"`). With no such
meter it is the current `seven_day` (`basis: "current"`). Counting from the day start
keeps the day's own spend from shrinking its allowance. With no `resets_at`, or one
already past, the `per_day_points` caps stand. `seats status --json` reports the
allowance and its inputs under `budget.allowance`, with `source` set to `reset-aware` or
`per_day_points`. The tick and the seat watchdog still gate on
`per_day_points`.

A queued slice from before the switch to seats mode has no `seat`, and seats mode
dispatches only its own seats' slices, so it stays queued. Let such slices finish before
switching, or set `seat` and `namePrefix` on the queued claims in the ledger to hand them
to a seat. A seat whose files cannot be loaded,
or whose scope cannot be scored, is skipped with a `seat <name> skipped: <why>` line and a
`burndown_seat_skipped` event; the tick still advances every held claim and plans the
other seats.

A seat claim's reviewer and successor spawns (CC-274) take the repo, `config_dir` and grants
from the seat, and pass the seat's pool gate: a closed gate, or a pool within 10 points of a
stop (those spawns run on opus), defers the spawn with the `BUDGET-PAUSE` reason. A claim
whose seat is no longer listed in `seats` stalls once and is left for the owner; a listed
seat that could not load this tick defers instead.

## The launchd job

Label `dev.hjewkes.agent-chat-burndown`, at
`~/Library/LaunchAgents/dev.hjewkes.agent-chat-burndown.plist`. It runs
`agent-chat burndown tick --once` every 600 seconds (`StartInterval`), with `RunAtLoad`
false and no `KeepAlive`: a tick that is still running when the next interval fires is
launchd's problem, not something this job asks to be kept alive through. Its log is
`~/Library/Logs/agent-chat-burndown/burndown.log`. The job's environment is `HOME` and
`PATH`, plus `AGENT_CHAT_HOME` when set — the same allowlist the mirror job uses, and for
the same reason: nothing else rides along from the account that ran `install`.

## What each ledger phase means

`agent-chat burndown status` prints every held claim's phase.

| Phase            | Meaning                                                                                                                                                                                                                                                                                                |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `spawning`       | The tick sent a spawn frame and is waiting for the broker's roster to show the agent. Ten minutes with no row stalls the claim.                                                                                                                                                                        |
| `planning`       | A planner is running. On exit, a `burndown-slices` block adds one `implementing` claim per slice; no block stalls the claim.                                                                                                                                                                           |
| `implementing`   | A worker is running. On exit: a park request moves to `parked`; a `DONE` report with a PR registers the PR with Shepherd and moves to `shepherding`; a reviewable diff with no PR spawns a reviewer and moves to `reviewing`; a clean `DONE` with no diff finishes the claim; anything else stalls it. |
| `parked`         | The worker asked a question and stopped. An answer with the right `inReplyTo` spawns a successor in the same worktree and moves back to `implementing`.                                                                                                                                                |
| `reviewing`      | A reviewer is running. `Verdict: APPROVE` on a claim with a PR hands the PR to Shepherd and moves to `shepherding`; a first failure spawns one successor; a second stalls the claim.                                                                                                                   |
| `awaiting-merge` | A claim from before Shepherd. The next tick hands its PR to Shepherd and moves it to `shepherding`.                                                                                                                                                                                                    |
| `shepherding`    | Shepherd holds the PR. Once its run lands the PR, successors retire before the original agent, then the claim finishes. A run that ends without merging stalls the claim.                                                                                                                              |
| `done`           | Nothing left to do. The claim no longer holds its task or a lane.                                                                                                                                                                                                                                      |

## Shepherd hand-off (TP-469)

Shepherd is the factory's PR-shepherding service, reached through the `titan-factory` CLI on
`PATH`. The tick registers a claim's PR with
`titan-factory shepherd register <owner/repo#n> --task <initiative>/<task> --implementer <agent>`,
after the ledger write that moves the claim to `shepherding`. Each tick then reads
`titan-factory shepherd status --json` once, and `shepherd timeline` for a run that has
finished, to tell a merge from a stop. The tick no longer reads PRs through `gh`.

- **Registers once.** A claim Shepherd already lists is never registered again, so a worker's own `--kind` survives. A register
  that fails, or a Shepherd that does not list the PR, is registered again next tick;
  Shepherd's register is idempotent on `repo#pr`.
- **Shepherd unreadable.** A status or timeline read that fails leaves the claim untouched
  and prints an `unread` line.
- **A repo Shepherd does not cover.** Shepherd refuses the registration (a repo in its
  `denyRepos`, for example). The claim stalls with `Shepherd refused <repo#n> (<reason>)`.
  Burndown never merges, so the PR is left for the owner.
- **A PR Shepherd cannot name.** A PR that is not a `github.com` pull URL stalls the claim
  without a register.
- **Merge authority** is Shepherd's seat policy, not burndown's: a repo no seat lists is
  owner-gated there.

A claim with a `stalledReason` keeps its task and worktree but never respawns; only
`agent-chat burndown release <task>` clears it. `agent-chat doctor` reports the stalled
count.

## Sign-off checklist

Every item is yours to check by hand; nothing here is verified by an agent.
`agent-chat burndown install` prints this list and refuses while `enabled` is false.

- **Settings allowlist.** `permissions.allow` in the shared `~/.claude/settings.json`
  covers what a burndown worker runs: `git fetch`, `git merge --ff-only`, `git add`,
  `git commit`, `git push -u origin agent-chat/*` (the existing worktree branch prefix,
  not `bd/*`), `npm run format`, `npm run format:check`, `npm run typecheck`,
  `npm run build`, `npx vitest run`, `gh pr create`, `gh pr view`, `gh pr checks`.
  `gh pr merge` stays out until the merge-chore slice. Checked by one manual run that
  raised no approval request.
- **Decider deployed** in a restart window, or explicitly waived (parked questions wait
  for you until then).
- **Lean profiles live**: the `bd-*` profiles merged and installed after a broker
  restart.
- **Slot ceiling**: `burndown.config.json`'s `maxAgents` set and below free broker slots
  (`agent-chat agent ls`).
- **Worktree ceiling**: for each opted-in repo, `git worktree list` run, orphans from
  failed spawns reclaimed, and `maxWorktreesPerRepo` plus `reserveWorktrees` set so the
  tick can never take the repo's last worktree slots.
- **Trust**: `agent-chat burndown plan` shows no `trust` refusal for the opted-in repo.
- **Budget**: `burndown.config.json` reserves reviewed; the billing account(s) confirmed.
- **`reportTo`** set to a registered session name in `burndown.config.json` — a real tick
  refuses to run without it.
- **Opt-in scope**: exactly one initiative opted in, `lanes: 1`, `grants: []`.
- **Shepherd serving**: `titan-factory shepherd status` answers from the account that runs
  the tick, and each opted-in repo is in a Shepherd seat, or is accepted as owner-gated.
- **Three supervised ticks**: `agent-chat burndown tick --once` run by hand three times
  across one worker's life (spawn, shepherding, done), `burndown status` read after
  each.
- **Kill switch known**: `agent-chat burndown pause` stops new spawns on the next tick;
  `agent-chat burndown uninstall` removes the job.

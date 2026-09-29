# Unattended work: `agent-chat burndown` (CC-slice4-plan.md)

`agent-chat burndown tick` reads the claim ledger, advances every held claim a phase, and
spawns at most one new agent per opted-in initiative: a planner for estimate 3 or more,
otherwise an implementer, headless, on the account the budget gate picked. A worker that
must ask parks and waits for an answer; a worker that leaves a diff gets a reviewer.
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
earlier seat's dispatches count against a later one. A seat whose files cannot be loaded,
or whose scope cannot be scored, is skipped with a `seat <name> skipped: <why>` line and a
`burndown_seat_skipped` event; the tick still advances every held claim and plans the
other seats.

Known gap: a seat claim's reviewer and successor spawns still resolve their repo and
account through the brief's `autonomy:` block, so in seats mode they stall with
"initiative is no longer opted in with a repo" until a follow-up gives `advance` the
seat's placement.

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

| Phase            | Meaning                                                                                                                                                                                                |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `spawning`       | The tick sent a spawn frame and is waiting for the broker's roster to show the agent. Ten minutes with no row stalls the claim.                                                                        |
| `planning`       | A planner is running. On exit, a `burndown-slices` block adds one `implementing` claim per slice; no block stalls the claim.                                                                           |
| `implementing`   | A worker is running. On exit: a park request moves to `parked`; a reviewable diff spawns a reviewer and moves to `reviewing`; a clean `DONE` with no diff finishes the claim; anything else stalls it. |
| `parked`         | The worker asked a question and stopped. An answer with the right `inReplyTo` spawns a successor in the same worktree and moves back to `implementing`.                                                |
| `reviewing`      | A reviewer is running. `Verdict: APPROVE` plus green CI moves to `awaiting-merge`; a first failure spawns one successor; a second stalls the claim.                                                    |
| `awaiting-merge` | Waiting for the PR to merge. Once merged, successors retire before the original agent, then the claim finishes.                                                                                        |
| `done`           | Nothing left to do. The claim no longer holds its task or a lane.                                                                                                                                      |

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
- **Three supervised ticks**: `agent-chat burndown tick --once` run by hand three times
  across one worker's life (spawn, review, awaiting-merge), `burndown status` read after
  each.
- **Kill switch known**: `agent-chat burndown pause` stops new spawns on the next tick;
  `agent-chat burndown uninstall` removes the job.

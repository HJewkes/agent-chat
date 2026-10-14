# Unattended work: `agent-chat burndown` (CC-slice4-plan.md)

`agent-chat burndown tick` reads the claim ledger, advances every held claim a phase, and
spawns at most one new agent per opted-in initiative: a planner for estimate 3 or more,
otherwise an implementer, headless, on the account the budget gate picked. A worker that
must ask parks and waits for an answer; a worker that reports `DONE` with a PR hands the PR to
Shepherd, which owns CI, review and merge from then on.
`agent-chat burndown install` runs the tick on a schedule through launchd, or a systemd --user
timer on Linux. Full design:
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
agent-chat burndown pause|resume [--by <who>]
                                        stop or resume new spawns from the next tick on
agent-chat burndown release <task>     drop every claim on a task so the tick may pick it again
agent-chat burndown unstall <task> --slice <n>
                                        reload an outside-owns slice's owns from its plan; keep its PR and agents
agent-chat burndown brief approve <task>   promote brief:proposed to brief:ready=<today>; needs the plan file
agent-chat burndown install [--dry-run]
                                        print the checklist, then install and start the launchd job
agent-chat burndown uninstall          stop the launchd job and keep it from starting at login
agent-chat burndown job-status         launchd state: loaded, pid, and whether the tick may spawn
agent-chat burndown seats compare --seat <name> [--autonomy-root <dir>]
                                        check a seat's dry-run plan against score.py's order
agent-chat burndown config show [--json]   every resolved setting with the layer it came from
agent-chat burndown preset apply <name> --by <who> | clear --by <who> | list
agent-chat burndown override set --for <dur> --by <who> [--reason <text>] <json-patch>
agent-chat burndown override clear --by <who>
agent-chat burndown seat on|off <seat> --by <who>
```

`agent-chat burndown plan --seat <name>` prints one seat's dry-run dispatch plan and its
refusals, as seats mode would plan it without the tick's live slot and worktree ceilings.
Add `--scored` for the seat's scored order with every component (`--top` and `--today`
apply only then); `--autonomy-root` points at another charter. A `task tags errors:` line lists
malformed planning tags, such as a `dep:` naming no task on disk, which the order reads as closed.

### Workflow table (shadow, CC-637)

With `<autonomy-root>/workflow/shape-v1.yml` installed (the canonical copy is
`docs/workflow/shape-v1.yml`), each `--scored` row also prints `prior=<prior> profile=<profile>` after
`route=`. The prior is the task-time class of the PR shape plan (1.5), from the task's tags, estimate and
`done_when` and the `owns` of its plan's slices. The profile is the implementer that the prior's class row
dispatches. It is shadow only: `route` and the tick's dispatch do not change. A table that fails its lint
(an unknown class, prior, profile or ladder value, a misspelt key, or no fallback prior) is not used, and a
`workflow table: <problems>` line says why. With no table file the output is unchanged.

### Prior routing (CC-638)

The tick config key `priorRouting` (`off`, `shadow` or `on`; default `off`) lets the same prior pick the
implementer profile a seat's tick dispatches. It applies to implementer-routed task rows (classified by the
task's tags, estimate, `done_when` and the union of its plan's slice `owns`) and to queued slices (by the
slice's own `owns` and points). Planner, briefer and triage rows, fix rounds and resumes are unchanged, and a
prior whose class names a profile other than `bd-implementer` or `bd-implementer-lite` keeps today's.

- `off`: the workflow table is not read and the plan is today's.
- `shadow`: dispatches as today and notes `would-route <initiative> <id>[ slice <n>] (seat <s>): <today> ->
<profile> (prior <prior>: <reason>)` for each dispatch `on` would change.
- `on`: dispatches with the prior's profile and notes the same line as `route-change ...`. The pool gate sees the
  routed profile, so a row routed to `bd-implementer` waits under a sonnet-only pool.

Under `shadow` or `on` with no table at `<autonomy-root>/workflow/shape-v1.yml`, or one that fails its lint,
the seat routes as today and notes `prior routing <mode>: no workflow table at <path>; routing as today` or
`prior routing <mode>: workflow table: <problems>; routing as today`.

`agent-chat seats tick <seat> --dry-run` prints the same plan under a `seat <seat> tick at <time>
(dry run)` header (CC-889). It runs only with `--dry-run`. The timer's tick advances every held
claim, and the respawn ladder's first rung spans two ticks, so a live tick between timer ticks
would retire or respawn a stalled agent early. `agent-chat seats status <seat> --brief` prints
eight lines: the caps per role with names, the pool reading, the stop, the unread count and the
parked count. `--json` is unchanged, and it cannot be combined with `--brief`.

The tick walks that same order (CC-768): `planSeat` orders rows with `planOrder` over this week's
`milestones/<week>.yml` in the autonomy root, and each dispatch carries its `tier`. With no file and no planning
tags the order is `dispatchOrder`'s. A task `planOrder` drops as `dep-blocked` or `gated:<id>` is a `plan-blocked`
refusal with that reason. The file is read as `plan --scored` reads it, with epics checked against every task on disk. A file that
parses is used even when it has errors, and each error is reported as a `plan-blocked` refusal; a file that does
not parse is left out, so the tick orders by the tags alone.

`agent-chat burndown pause` is the kill switch that takes effect fastest: the next tick
sees the pause marker and spawns nothing, but a running agent finishes on its own.
`agent-chat burndown uninstall` also removes the scheduled job itself.

## Settings, presets and overrides (CC-955)

**Not live yet.** Until CC-955 S2 lands, the tick and the broker's hand-reserve gate still
read `burndown.config.json` alone. The verbs below write the settings and the log, and
`config show` resolves them, but nothing the tick spawns changes. Each verb except `pause`
and `resume` says so in its reply. To stop spawning today, use `burndown pause`.

`burndown.config.json` is the base layer. No verb rewrites it. Each value resolves from
these layers, lowest first:

```
schema default < burndown.config.json < seat file (caps, scope)
  < burndown.settings.json seats.<name> < active preset < unexpired override
```

`burndown config show` prints every resolved value tagged with the layer it came from.

- **`burndown.settings.json`.** It holds `seats.<name>` (`on`, `scope`, `briefGate {mode,
maxAgeDays}`, `caps`, `handReserve`), named `presets`, and the `active` preset.
  `burndown seat on|off` writes `seats.<name>.on`. If a preset or an override sets that seat
  too, the verb says which layer shadows it.
- **Presets.** `burndown preset apply <name>` makes a preset active, and `preset clear`
  deactivates it. The built-in `factory-only` turns on only the flat file's `reportTo` seat,
  with its brief gate `on`, and turns every other known seat off. A preset of the same name
  in the settings file shadows the built-in.
- **`burndown.override.json`.** `burndown override set --for 2h '<patch>'` lays a patch of
  the preset shape over everything else until `expiresAt`. After that the patch is ignored,
  and `config show` names it as lapsed. `override clear` removes it early.

Every verb here, plus `pause` and `resume`, takes the settings lock and appends one
`{at, by, verb, before, after}` row to `burndown.settings.log.jsonl`. The row holds only the
parts that changed. A replaced settings or override file is kept as `<file>.bak-<time>`.
`--by` is required, except on `pause` and `resume`, where it is optional so existing callers
keep working; without it the row records `(unrecorded)`. A pause still writes
`burndown.paused`, and a resume still removes it, when the settings file cannot be read or is
locked; either says the change went unlogged. A current state that no longer resolves (say an
active `factory-only` after `reportTo` was removed) does not block a change: only the result
must resolve, so `preset clear` repairs it. `seat on` warns when the flat file names no such
seat, since a misspelt seat turned on would become a seat of its own.

Once S2 has landed: the broker reads `handReserve` in-process. When a change moves a seat's
hand reserve while a live broker is older than `dist/` (or carries no build stamp), the verb prints
`broker predates settings; handReserve applies to the tick only until restart`.

## Seats mode (CC-205)

When `burndown.config.json` lists `seats`, the tick dispatches for those autonomy seats
instead of for briefs' `autonomy:` blocks. It reads the charter and seat files under
`claude-channels/sources/autonomy/` once per tick. Seats and a brief with an `autonomy:`
block together are a config error: the tick refuses before it reads the roster, since
both modes could dispatch the same work.

A seat file with `role: hub` dispatches nothing: the tick skips it and `burndown plan
--seat` refuses it. The charter's `hub:` key does not: it names the charter and
restart-window owner, whose seat dispatches like any other under its own prefix, pool and
`concurrency` block (CC-775). A seat without a `concurrency` block still dispatches nothing,
since every cap defaults to 0.

For each listed seat, in order, the tick:

- takes one sample of the seat pool's `seven_day` reading from the status file under the
  pool's `config_dir`, and keeps the seat's samples for 26 hours in the ledger's `seats`;
- gates the pool with `gatePool`, using the run start the seat watchdog shares
  (`runStartAt`, capped at 12 hours) and the samples as history. A seat with no ledger
  sample at or before its run start uses the watchdog's saved run and day meters as its
  whole history instead. The two sources are never mixed, because the meters' estimated
  samples never drop, and among real readings across a `seven_day` reset they would count
  the pre-reset readings again (see "The run meter" below);
- dispatches the seat planners' ready slices first, then scores the seat's scope and walks
  the order through `planSeat`: eligibility, route, repo, the post-advance collision
  check, orphan, trust on the pool's `config_dir`, role caps, worktree caps, then the pool
  gate. The collision check and `burndown landed` count a task as landed when a
  default-branch commit subject names it, or when a commit body lists it in a line or
  sentence opening `Covers` or `Also covers`; no other body mention counts (CC-1068);
- under an `on` brief gate, queues a brief:ready task's slices from its seat-written
  `sources/<ID>-plan.md` instead of spawning a planner or an implementer (CC-927). The
  plan's slice `owns` is where a brief:ready task declares the files it will touch, and
  the lint requires it. An implementer-routed task with no plan is refused `no-owns`; a
  planner-routed one spawns its planner as before. Under `shadow` the implementer still
  dispatches, with a `would-refuse no-owns` note (CC-952);
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

### Stop the line (CC-629)

Each tick runs `titan-factory service check --json` once, before it plans any seat, and
keeps the read (its time and cause) in the ledger's `serviceCheck`. The check names the first
failing cause.

- **Stopping causes.** Every cause stops except the note-only ones below, including a cause
  this build does not know, since nobody has judged it harmless: `stale pid`, `crash loop`,
  `not loaded`, `GitHub down` and the like.
- **Note-only causes.** `stale build` (serve still merges on an old build; it is a restart
  hint), `tick failing` and `tick stale` (they describe the tick itself, which would otherwise
  block itself). The tick reports them and the line runs.
- **Fail closed.** A check that exits other than 0 or 1, cannot be spawned (`ENOENT` and
  other spawn errors), or prints anything but its JSON is read as cause `unreadable`, which
  stops.
- **Timeout (CC-1125).** The read waits `SERVICE_CHECK_READ_TIMEOUT_MS` (30 s), above the
  check's own worst case of 21 s (three 6 s `/health` probes with two 1.5 s gaps). A check
  killed by that timeout means serve did not answer, so it is read as cause `unresponsive`,
  which stops, never as `unreadable`. The seat watchdog's read waits the same 30 s
  (`SERVICE_CHECK_TIMEOUT_MS`) and reports a timeout as `unresponsive: ...`.
- **Two reads.** One stopping read never stops the line, because one failed `/health` probe
  can read as `stale pid` while serve is healthy (TP-1726). The line stops only when this
  read and the previous persisted read both stop and the previous one is at most two tick
  intervals (20 minutes) old; a tick that skipped runs starts the count again. One ok or
  note read clears the stop at once.
- **Exemptions.** While the line is stopped every new implementer is refused `stop-line`,
  except a `cos:expedite` task (tier 0 takes the next free slot) and planners, since a plan
  opens no PR. Claims already in flight carry on.

`burndown plan --seat`, `seats tick --dry-run` and `seats compare` read the check too and
judge it against the persisted read, but write nothing. `plan --seat` prints the state on the
line under its header: `service check: ok`, `service check: <cause> (one stopping read, the
line runs; ...)`, `service check: line stopped (<previous>, then <current>): ...`, or the
note, `service check: <cause> (a note, the line runs): ...`.

The downstream WIP gate that once sat beside this one was removed by CC-866 (decisions
item 86(4)): seat concurrency caps govern implementer counts, and no `wip` refusal exists.

### Checking the seat plan against score.py: `seats compare` (CC-251)

`agent-chat burndown seats compare --seat <name>` makes the seat's dry-run plan, as
`burndown plan --seat` does, then runs
`python3 <autonomy root>/score.py --seat <name> --check-landed --json --top 1000` in the same
process, with `--today` pinned to the plan's day and one `--prior <initiative>=<n>` per claim
the seat dispatched this run. score.py therefore decays each initiative as the plan does, and
the raw and decayed scores it prints for each ID match the plan's exactly; no decay tolerance
is applied.

It walks score.py's order and prints each ID with its raw and decayed score and one verdict:

- `dispatched as pick <n>`;
- `refused [<kind>]: <reason>`, the plan's refusal, including `stop-line` while the line is
  stopped. An expedite dispatch above a stopped row passes the reorder rule by its tier;
- `held`, when the claim ledger holds the task;
- `held [intangible]`, when `planOrder` holds the intangible task back for a ready row of a
  higher tier (CC-778);
- `beyond caps [<kind>]: <reason>`, for a `role-cap`, `worktrees`, `slots`, `budget` or
  `lanes-full` refusal, or for a `share-cap:<kind>` skip, which the plan counts by kind
  rather than by ID: each count explains that many of the kind's lowest-ranked silent IDs.

It exits 1 on any of these, with the line in capitals:

- `UNEXPLAINED SKIP`: score.py lists the ID and the plan neither dispatched nor refused it;
- `OUT OF ORDER`: a dispatch comes before another dispatch that score.py ranks higher, with
  no recorded reason;
- `EXTRA DISPATCH`: the plan dispatched a task score.py does not list, such as one
  `--check-landed` found landed.

**The reorder rule.** A dispatch ahead of a higher-ranked one is explained, and passes with its
reason printed, only when:

- the plan's own placement (`SeatPlan.placement`, recorded by `planOrder` during the dry run,
  never recomputed here) puts it in a higher class-of-service tier than the ID it overtook:
  expedite, a fixed date with under 2 days of slack, or a milestone the seat owns (the line
  names the milestone and its float);
- both sit in the same tier 0, 1 or 2, which the plan sorts by age, slack, float and WSJF rather
  than by score;
- both sit in tier 3 or 4, and the initiative decays each side applied at that pick flip the
  pair. The plan's count for an initiative is its prior picks plus every `planOrder` pick before
  the jumper: tier 0 to 2 rows dispatched or not (the ledger may hold one, or a cap refuse it),
  but no share-cap skip. score.py's is its prior picks plus every row it ranks above the
  overtaken ID, share-capped rows included. The reorder passes only when score.py's counts
  favour the overtaken ID and the plan's favour the jumper; the line prints both counts.

Tiers 3 (standard) and 4 (intangible) follow score.py's order, so any other reorder fails,
and so does a lower tier dispatched ahead of a higher one. Ready slices are dispatched ahead
of the scored order by design; they are counted on their own line and left out of the order
check. The milestone and slack named in a reason are the ones `planOrder` placed the row by.

### The seat journal

A seat writes its own journal lines through the CLI, so the time comes from the machine clock
and never from a hand-typed stamp (CC-1058):

```
agent-chat seats log <seat> <text...> [--root <autonomy dir>]
```

It appends `<HH:MM> <text>` to `<root>/logs/<seat>/<YYYY-MM-DD>.md`, with the time and the
day both local, and prints the file. Words join with one space. It refuses and writes nothing
on a seat with neither `seats/<seat>.md` nor `logs/<seat>/`, on text with a line break, and on
text that opens with a time such as `05:17 tick` or `05:1x`: put the time later in the line.

### The run meter

The seat watchdog keeps each seat's run meter in `$AGENT_CHAT_HOME/seat-watchdog.json` at
`seats.<seat>.run = {since, last, spent, before?}`. The watchdog starts a new run only once
the meter is 12 hours old. The charter's run, though, starts at the owner's last message to
the seat. When the owner starts a new run, reset the meter (CC-472):

```
agent-chat seats run-start <seat> [--root <autonomy dir>]
```

It sets the meter to `{since: now, last: <pool seven_day now>, spent: 0, before: <the old
meter's last>}` and leaves every other seat and map untouched. It takes the watchdog's run
lock (`seat-watchdog.lock`), so a watchdog pass never overwrites the reset and the reset never
overwrites a pass; it waits up to 90 seconds for a pass to finish. It refuses and writes
nothing on `unknown_seat`, `no_reading` (no `seven_day` in the pool's status file, or one older
than 15 minutes) or `lock_held`. The watchdog, `seats status` and the CC-288 spawn gate read
the new run at once.

A seat file may set `pacing: reset-aware` (CC-404). The tick, the seat watchdog and
`seats status` then replace both `per_day_points` caps with one day allowance, built by
`pacedCaps` in `seats/stops.ts`: `(100 - reserve_seven_day - day_start_seven_day) /
days_to_reset`. `day_start_seven_day` is the current `seven_day` less the day's spend since
07:00, counted from the same history the day stop reads (`basis: "day-start"`), and
`days_to_reset` runs from 07:00 to the reading's `seven_day.resets_at`. Both terms share
the day start, so the allowance holds steady through the day and the day's own spend
does not shrink it. With no reading at or before 07:00, both run from now on the current
`seven_day` (`basis: "current"`). With no `resets_at`, or one already past, the
`per_day_points` caps stand. `seats status --json` reports the allowance and its inputs
under `budget.allowance`, with `source` set to `reset-aware` or `per_day_points`.

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

## On Linux: systemd --user units (CC-816)

On Linux the same verbs write and drive systemd --user units in `$XDG_CONFIG_HOME/systemd/user`
(else `~/.config/systemd/user`), named after the launchd label without `dev.hjewkes.`:

| launchd schedule       | systemd units                                                                       |
| ---------------------- | ----------------------------------------------------------------------------------- |
| `KeepAlive`            | `.service`, `Restart=always`, `WantedBy=default.target`                             |
| `StartInterval` N      | `Type=oneshot` `.service` + `.timer` with `OnBootSec=N` and `OnUnitActiveSec=N`     |
| minutes past each hour | `Type=oneshot` `.service` + `.timer` with one `OnCalendar=*-*-* *:MM:00` per minute |

The burndown tick is `agent-chat-burndown.{service,timer}`; the seat watchdog
(`agent-chat seats watchdog-install|watchdog-uninstall|watchdog-status`) is
`agent-chat-seat-watchdog.{service,timer}`. The service carries the plist's environment as
`Environment=` lines, `PATH` included, since the user manager's own `PATH` lacks `~/.local/bin`
and node's dir. That environment is `HOME` and `PATH`, plus `AGENT_CHAT_HOME` and `ACTIVE_ROOT`
when the installing shell sets them. The watchdog verbs take `--agent-chat-home <dir>`, which
wins over the shell's `AGENT_CHAT_HOME`. It is resolved to an absolute path, and install refuses
one inside a temp dir or a worktree. On Linux a home other than `~/.agent-chat` suffixes the
watchdog's unit names with its basename, minus leading dots and an `agent-chat-` prefix, so a
pilot and a default install can coexist: `~/.agent-chat-pilot` installs
`agent-chat-seat-watchdog-pilot.{service,timer}`, while `~/.agent-chat` keeps
`agent-chat-seat-watchdog.{service,timer}`. Pass the same flag or shell value to
`watchdog-uninstall` and `watchdog-status` to address those units. The launchd label and plist
path never change. Logs keep their file names under `$XDG_STATE_HOME` (else `~/.local/state`),
for example `~/.local/state/agent-chat-burndown/burndown.log`. `install` runs `daemon-reload`
and `enable --now` on the timer; the timer's elapsed `OnBootSec` starts one tick at once, as
launchd's kickstart does. `uninstall` runs `disable --now`, removes the units and reloads;
`job-status` reads `systemctl --user show`. The units only fire while the user manager runs, so
a server needs `loginctl enable-linger`.

## Event-driven ticks (CC-1111)

The timer is the backstop, not the only trigger. When an agent the tick spawned exits, or is
retired because `burndown release` dropped its claim, the broker starts one detached
`burndown tick --once` 30 seconds later. Exits inside that window share the tick. The ledger
lock the timer's tick takes is the single-flight lock: while any tick holds it, the broker
defers its kick by another 30 seconds, and a kicked tick that still races the timer exits
under the lock as a second tick always does. Kicked ticks write to `<home>/burndown-kick.log`,
which moves to `.1` before a tick once it passes 10 MB; `burndown_kick` and
`burndown_kick_deferred` rows in the broker log record each decision.
Brokers on a temp-dir home never kick. A kicked tick runs with the timer job's env plus
`XDG_RUNTIME_DIR` and `DBUS_SESSION_BUS_ADDRESS` when the broker has them; without the user bus
`systemctl --user` fails and the service check reads `not loaded` (CC-1144).

To measure the effect, `node scripts/exit-to-dispatch.mjs --hours 6` (after `npm run build`)
prints the median wait from a burndown implementer's exit to the next tick that dispatched.
It reads `events.db` and `burndown-ticks.jsonl` and writes nothing. Each exit takes one
dispatch from the first tick at or after it. A tick row's time is the tick's start, so the
wait leaves out planning time. An exit with no dispatch within `--max-wait-min` (default 30)
is reported as unmatched and left out of the median, since that slot waited for ready work,
not for a tick.

### Publish tasks (CC-987)

A publish is its own task, never a slice. It carries `ops:publish`, and its `done_when` is one
publish at a semver, `publish <package> at <version>`. Only that task waits on the
`release-through-ci` grant. The build work before it is a separate task it lists with `dep:`, and
the consumer work after it is another task with `dep:` on the publish task, so both dispatch as
ordinary code.

- The dispatch gate refuses an `ops:publish` task whose `done_when` is anything else as
  `ops-unresolved`, naming the split, before it reads the grant.
- The slice lint fails a slice that declares `publish` in `ops`. A slice with no `ops` field whose
  `doneWhen` mentions a publish gets a warning, not a failure, since the word is often subject
  matter; `"ops": []` silences it.
- The planner and briefer briefs state the rule.

## What each ledger phase means

`agent-chat burndown status` prints every held claim's phase.

| Phase            | Meaning                                                                                                                                                                                                                                                                                                |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `spawning`       | The tick sent a spawn frame and is waiting for the broker's roster to show the agent. Ten minutes with no row stalls the claim.                                                                                                                                                                        |
| `planning`       | A planner is running. On exit, a `burndown-slices` block adds one `implementing` claim per slice. A missing block, or one failing the slice lint (over 3 points, no `doneWhen`, no `owns`, an unknown or cyclic dep, a declared publish), stalls the claim with one reason line per slice and rule.    |
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
`agent-chat burndown release <task>` clears it. `release` also retires the claim's agents. For an
`outside-owns` stall whose plan owns have since been fixed, `agent-chat burndown unstall <task>
--slice <n>` reloads the slice's owns from the plan and clears the stall in place when the
branch fits them. It keeps the claim's PR, phase and agents and retires nobody, so the next tick
hands the PR to Shepherd with the implementer as fixer. `agent-chat doctor` reports the stalled
count.

The tick can route a stall to a read-only triager before the owner hears about it. The exception
classes and the `exceptions.route` dial (default `owner`) are on `main`; the triage job is not
yet. See [`triage.md`](triage.md).

## Sign-off checklist

Every item is yours to check by hand; nothing here is verified by an agent.
`agent-chat burndown install` prints this list and refuses while `enabled` is false.

- **Profile allowlist.** A worker no longer loads the shared `~/.claude/settings.json`
  (see [`permission-relay.md`](permission-relay.md), "What a worker launch loads"), so
  the `bd-*` profile's own `allowedTools` must cover what a burndown worker runs:
  `git fetch`, `git merge --ff-only`, `git add`, `git commit`,
  `git push -u origin agent-chat/*` (the existing worktree branch prefix, not `bd/*`),
  `npm run format`, `npm run format:check`, `npm run typecheck`, `npm run build`,
  `npx vitest run`, `gh pr create`, `gh pr view`, `gh pr checks`. `gh pr merge` stays
  denied until the merge-chore slice. Checked by one manual run that raised no approval
  request.
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
- **Seats mode, rehearsed** (only when `burndown.config.json` lists `seats`): for each
  listed seat, three dry runs, each `burndown tick --once --dry-run` (or
  `burndown plan --seat <name>` while the config lists no seats) followed by
  `burndown seats compare --seat <name>`, all three exiting 0. The output holds task data,
  so it goes to a private note, never to a PR.
- **Seats mode, one dispatcher**: each listed seat no longer dispatches scored work itself,
  so the tick's dispatches do not double the load on the seat's caps.
- **Seats mode, no autonomy blocks**: no brief carries an `autonomy:` block (the tick refuses
  both modes together).
- **Kill switch known**: `agent-chat burndown pause` stops new spawns on the next tick;
  `agent-chat burndown uninstall` removes the job.

A seat file may set `cap_excludes_waiting_owner: true` (CC-405). A running agent that carries
the session tag `waiting-owner` then no longer counts toward its role's cap in
`seats status`: it drops out of `active`, `names` and `detached` and is listed under
`waitingOwner` in that role's block of `--json`. Set the tag with `chat_tag` on the agent
(or on a peer), and remove it when the owner has answered. Without the key, or for an
untagged agent, the count is unchanged and `waitingOwner` is empty.

## Spawn door audit (CC-646)

Criterion 3 of M1, "every spawn made by the tick", has to be countable, so CI lists every
code path that can start a planner or implementer. `audit/spawn-doors.json` records one entry
per allowed door: `path`, `kind` (`spawn-frame`, `resume-frame`, `claude-launch` or
`broker-handler`), `why`, `owner` (a seat or `owner`), and `coordinatorSideDoor`, true when
a coordinator can use it to start a worker outside the tick (MCP `agent_spawn`, the CLI spawn).

`npm run audit:spawn-doors` (part of `npm run verify`) scans `src/`, skipping tests and
comments. It fails with `path:line` for a site with no record, and for a record whose site is gone.
To add a door, add its entry in the same change as the code, with the reason and owner. Review
tooling's `claude -p` lives outside `src/` and is kept as a record with `external: true`, which the stale check skips.

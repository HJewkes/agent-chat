# Human caller gate: who may send the human's frames

Decision record for CC-1083 (slice b), 2026-10-12. Follow-up implementation:
**CC-1138** (claude-channels initiative, tags `kind:security`, `repo:agent-chat`),
filed and open. Only its frame-class table has landed (see "Frame inventory"); the gate
itself has not. **CC-1151** has landed (#785, #818): the
tick and seat opt-out sites no longer run in an agent's process, and the root rule below
is superseded (see "The boundary that closes the class").

## The problem

The broker decides that a connection speaks for the human by one test:
`isHuman(conn)` in `src/broker/socket.ts` returns true when the connection has no
registered name. Every CLI invocation opens an unregistered connection, so any local
process that runs `agent-chat` counts as the human. That includes a spawned agent's own
`Bash` tool.

`agent-chat debug send <to> <text>` (`src/cli/debug.ts`) sends a `human_send` frame, so
an agent that runs it delivers free text with `from="human"`. As of origin/main
`d173e6c` (2026-10-12), no profile denies it: `HUMAN_ONLY_CLI_DENY` has no `debug` entry,
so any agent with `Bash` can run it today. CC-1083 slice a is planned, not landed. It will
add `Bash(agent-chat debug send:*)` to `HUMAN_ONLY_CLI_DENY` and to the load-time derived
denies. Even then, a deny list only matches the literal spelling. `node dist/cli.js debug send`, `npx agent-chat …`, an absolute path or a raw
socket write all pass it (`src/agents/profiles.ts`, the comment on
`HUMAN_ONLY_CLI_DENY`). This note decides whether the broker should also gate these
frames by caller.

## Frame inventory

This inventory comes from the `switch (msg.t)` dispatcher in `handleMessage`
(`src/broker/socket.ts`), read with `git show origin/main:src/broker/socket.ts` at
origin/main `d173e6c` (2026-10-12), and recounted at origin/main `907fed5` (2026-10-25).
It lists all 56 cases there, and each case appears in exactly one class: 8 refused, 6
requester mapped, 3 session bound and 39 out of scope. The recount added `account_move`
(Class 1), `codex_wake_capped` (Class 3), and `message_by_id` and `host_challenge`
(Class 4).

The same classes live in code as `FRAME_CLASSES` (`src/broker/frame-classes.ts`), typed
over the whole `ClientMessage` union. `src/__tests__/frame-classes.test.ts` fails when a
dispatcher case has no row there, or when this inventory and the table disagree. A new
frame therefore needs a row in both before the suite passes.

### Class 1: refused from a declared connection

These frames are guarded by `isHuman`, and they mean "the human decided".

| Frame                | Handler                                                         |
| -------------------- | --------------------------------------------------------------- |
| `human_send`         | `handleHumanSend`                                               |
| `answer`             | `handleAnswer`                                                  |
| `dismiss`            | `handleDismiss` (the branch where the caller is not the author) |
| `endorse_approve`    | `handleEndorseApprove`                                          |
| `approve_permission` | `handleApprovePermission`                                       |
| `teleport_abort`     | `handleTeleportAbort`                                           |
| `service_ask`        | `handleServiceAsk`                                              |
| `account_move`       | `handleAccountMove`                                             |

`account_move` moves a session to another account, which spends the human's quota on
that account. Its handler already refuses a registered connection as the human's call.

`service_ask` is here because it asks the human under a service label that nothing
vouches for. Profiles already deny agents `agent-chat ask` (CC-169, landed), and leaving
the frame open would get around that deny.

`dismiss` has two branches. The non-author branch is Class 1: dismissing another
session's item is the human's call. The author branch lets a session withdraw its own
item. With a declared id, the broker uses the declared agent's name as the caller in
`handleDismiss`, so the frame is accepted only when that agent is the item's author and
refused otherwise. That is what the agent's own registered connection gets today.

### Class 2: requester mapped to the declared agent

These frames take the requester from the connection and fall back to the human when the
connection has no registered name. With a declared id, the broker sets the declared agent
as the requester instead. The last column lists the checks the mapping turns on, which
the `HUMAN` fallback skips today.

| Frame             | Fallback today                                                                      | What the mapping turns on                                                                                                                                                           |
| ----------------- | ----------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `spawn`           | `handleSpawn`: `registry.nameOf(conn) ?? HUMAN`, no `parentAgentId`                 | `checkEscalation`, the worker-spawn ban, `checkCwd`, `rateRefusal`, and the predecessor-ownership check in `resolvePredecessor` (`src/agents/predecessor.ts`, via `predecessorFor`) |
| `resume`          | `handleResume`: `requester?.name ?? HUMAN`, no `requesterAgentId`                   | `checkOwnership` through `checkResumer` (CC-216): a worker may resume only agents it spawned                                                                                        |
| `surface`         | `handleSurface`: `requester?.name ?? HUMAN`, no `requesterAgentId`                  | `checkOwnership` through `checkSurfacer` (CC-225)                                                                                                                                   |
| `park`            | the `park` case: `requester?.name ?? HUMAN`, no `requesterAgentId`                  | `checkOwnership` for `park`                                                                                                                                                         |
| `retire_finished` | the `retire_finished` case: `caller` is `registry.nameOf(conn)`, so it is undefined | the "is the caller itself" refusal in `planFinished` (`src/agents/isolation/retire-finished.ts`). It does **not** limit `spawner` (see below)                                       |
| `retire`          | the `retire` case: the actor is `msg.caller`, a field the caller fills in           | **nothing**. The mapping fixes only the record (see below)                                                                                                                          |

For `retire_finished`, the broker passes the declared agent's name as `caller`. For
`retire`, it passes that name as `actor` and ignores `msg.caller`. If the declared id
resolves to no known agent, every frame in this class is refused rather than falling back
to `HUMAN`.

**`retire` stays unguarded under the mapping alone.** `retire`, `retireStale`,
`retireById` and `retireIdentity` (`src/agents/supervisor.ts`) never check ownership or
role. They use the actor only to name who did the retiring in the `agent_retired` row.
Making the declared agent the actor fixes that row, but any agent can still retire any
agent, through the CLI or otherwise. `retire_finished` has the same gap: `spawner` is
`msg.spawner`, which the caller chooses, so an agent can retire another spawner's
finished agents. Its retirement also goes through `retireById` with no actor, so the
`agent_retired` row says `human`.

CC-1138 therefore also adds an ownership check, the way `resolvePredecessor` does for a
takeover and `checkOwnership` does for resume. A worker requester may retire only agents
it spawned. The test is that the target's spawn row has `meta.parent` equal to the
requester's agent id, the same key `checkOwnership` uses. The check never uses the
`spawnedBy` name, because a name can be reused by a later agent. For `retire_finished`
from a declared worker, the same test filters the roster after `spawner` and `prefix`
scoping. Agents the worker did not spawn are skipped, whatever `spawner` the frame names. A coordinator, a human-started session and the unregistered human keep
today's behaviour, which matches `checkOwnership`. `retire_finished` also passes the
caller through to `retireById` as the actor.

The CC-216 `WORKER_CLI_DENY` deny list (`Bash(agent-chat agent:*)`, landed) covers these
frames today. It has the same weakness as `HUMAN_ONLY_CLI_DENY`: it matches only the
literal spelling.

### Class 3: bound to the declared session

| Frame                     | Today                                                                                                                     | With a declared id                                                            |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `permission_hook`         | `isHuman` passes, and the caller picks `msg.session`                                                                      | accepted only when `msg.session` names the declared agent                     |
| `permission_self_granted` | `isHuman` passes; the `approval_request` and `allow` `resolution` rows take `actor = msg.session`, which the caller picks | accepted only when `msg.session` names the declared agent                     |
| `codex_wake_capped`       | `isHuman` passes, and the caller picks `hostPid` and `host`, which name the capped session                                | accepted only when `registry.nameOnHost(hostPid, host)` is the declared agent |

The first two frames come from the PermissionRequest hook (`permission_self_granted` is CC-694's
audit row for a call the hook allowed itself). The hook runs inside an agent's process
tree, so it always carries the agent's id and has to stay open. Binding `msg.session`
keeps one agent from filing a prompt, or an audit row, under another agent's name.

### Class 4: out of scope, guarded by its own check

The gate leaves these frames alone. Each one already refuses an unregistered
connection, checks something other than "unregistered", or only reads.

| Frame                                                                                                                        | Its own check                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ---------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `send`, `broadcast`, `ask`, `notify`, `endorse`, `subscribe`, `unsubscribe`, `tag`, `claim`, `release`, `status`, `approval` | `SESSION_FRAMES`: each handler refuses or no-ops without a registered name                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `decided`                                                                                                                    | `handleDecided`: the connection's bound agent id must equal the configured decider's                                                                                                                                                                                                                                                                                                                                                                                                           |
| `teleport`, `teleport_plan_wait`, `teleport_launched`, `background`                                                          | the subject is the connection's own durable identity (`registry.entryFor(conn)?.agentId`); refused without one                                                                                                                                                                                                                                                                                                                                                                                 |
| `teleport_land_failed`                                                                                                       | `landFailed` requires the armed landing's token                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `register`                                                                                                                   | registry name rules, plus `refuseLauncherRegister`; it creates a name, it does not use the human's authority                                                                                                                                                                                                                                                                                                                                                                                   |
| `readopt`                                                                                                                    | `handleReadopt`: the name comes from the log for an adopted session, and is refused while a live connection holds it                                                                                                                                                                                                                                                                                                                                                                           |
| `permission_hook_withdrawn`                                                                                                  | only the connection that raised the hook may withdraw it                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `host_hello`                                                                                                                 | refuses a registered connection; the `machines` list bounds which hosts may be announced; the first live launcher holds a host                                                                                                                                                                                                                                                                                                                                                                 |
| `host_challenge`                                                                                                             | refuses a registered connection; it only hands out a nonce that `host_hello` must answer                                                                                                                                                                                                                                                                                                                                                                                                       |
| `host_probe_result`, `host_launch_result`                                                                                    | `HostDirectory.answer` settles only a request the broker sent on that same connection                                                                                                                                                                                                                                                                                                                                                                                                          |
| `spawn_launched`, `spawn_placed`                                                                                             | `remoteReportRefusal`: only the connection the broker handed that agent's remote launch may report on it                                                                                                                                                                                                                                                                                                                                                                                       |
| `job_kick`                                                                                                                   | `handleJobKick`: a closed job set (`burndown_tick`, `seats_watchdog`, `seats_heartbeat_check`); the request is rebuilt from `job` and `seat` alone; a seat must be at most 64 characters and have a seat file in the broker's own autonomy root; single flight per job and seat. The broker launches the job detached with `jobEnv` of its own environment plus the user bus, never the caller's. It runs only what the timers run, so it is accepted from a declared connection too (CC-1151) |
| `inbox`                                                                                                                      | reads the caller's own inbox; empty for an unnamed connection                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `list`, `queue`, `history`, `inbox_since`, `message_by_id`, `activity`, `reported`, `answers_since`, `agents`, `hosts`       | read-only. `inbox_since`, `message_by_id` and `answers_since` read any name's rows, which is a confidentiality question outside this gate                                                                                                                                                                                                                                                                                                                                                      |

## Options weighed

### 1. Peer credentials (SO_PEERCRED / LOCAL_PEERCRED): rejected

Node's `net.Socket` on AF_UNIX exposes no pid or uid, and `remoteAddress` is
`undefined` (already noted on `isHuman`). Reading credentials needs a native addon. It
would also only return the uid, and every agent runs under the human's uid. Getting the
pid and walking up its process tree would be racy and platform-specific. Not worth it.

### 2. A human token file: rejected as the primary gate

The broker would issue a secret that only the human's CLI presents. Agents run as the
same OS user, so they can read the file unless every profile denies reading it. That is
the same class of defence as the deny list, configuration rather than a guarantee, with
more moving parts: rotation, the file's location, and every profile listing it.

### 3. A self-declared agent identity, refused by the broker: recommended

`src/agents/launch-plan.ts` (`envFor`) sets `AGENT_CHAT_AGENT_ID` in every spawned
agent's environment, and the agent's `Bash` children inherit it. Observed 2026-10-12:
this implementer's own `Bash` env carries `AGENT_CHAT_AGENT_ID=32128f9e`,
`AGENT_CHAT_NAME` and `AGENT_CHAT_PROFILE`. `src/launch-identity.ts` already treats the
variable as the marker of "descends from an agent launch" (CC-898).

The design:

- `BrokerClient` sends a hello frame carrying the id, when the variable is set, on every
  connection before its first request.
- The broker resolves the declared id to that agent's name, and records the name and id
  per connection.
- **Class 1** frames are refused from a connection that declared an id. The broker
  appends `verdict_refused` the way `refuseToSession` does today.
- **Class 2** frames are not refused. The broker uses the declared agent as the
  requester: `requestedBy` is its name, and its id goes in `parentAgentId` for `spawn`
  (`SpawnRequest` has no `requesterAgentId`) or in `requesterAgentId` for `resume`,
  `surface` and `park`. Setting only `requestedBy` is not enough: with `parentAgentId`
  unset, `requesterOf()` reads the requester as a depth-0 coordinator with no granted
  tools, so the escalation check is skipped and fails open. For
  `retire_finished`, `caller` is its name; for `retire`, `actor` is its name. An id that
  resolves to no known agent is refused. CC-1138 also adds the retire ownership check
  described under Class 2.
- **Class 3**: `permission_hook` and `permission_self_granted` are accepted only when
  `msg.session` names the declared agent, and `codex_wake_capped` only when its host pid
  is registered under the declared agent.
- **Class 4** frames are unchanged.

Why class 2 frames get the agent as requester instead of being refused: an agent already
has these verbs through its own MCP tools (`agent_spawn`, `agent_resume`, `agent_surface`,
and so on), and those tools apply its role's checks. Mapping the CLI path to the same
requester gives the two paths the same result: the checks in the Class 2 table apply
however the agent spells the command. Refusing outright would also refuse a coordinator
that drives the CLI from its shell, which those checks already allow. `retire` and
`retire_finished` gain a limit only from the new ownership check, not from the mapping.
Once the gate lands, `WORKER_CLI_DENY` becomes defence in depth rather than the only
guard.

This catches every CLI spelling that the deny lists miss, because the gate keys on the
process's environment rather than on the command text.

**Limits, stated plainly.** The id is self-declared, so omitting or forging it fails
open. `env -u AGENT_CHAT_AGENT_ID agent-chat debug send …` or a raw `nc` write still
reaches the broker as the human, with `requestedBy = HUMAN` and a `permission_hook`
`session` of the caller's choosing. Declaring another agent's id makes the caller act as
that agent. The same `env -u` also gets past the kick boundary for the tick and seat
opt-out sites (see "The boundary that closes the class" below): with no id, a site runs
in-process as the units do.

**The root rule narrowed the opt-out sites; it did not close them.** This paragraph and
the list after it record why the rule was dropped; CC-1151 superseded it and it was never
built. It compared three
values with the broker's: `currentAutonomyRoot()`, `activeWorkRoot()` and `home()`. That
does stop one route. Moving `HOME` or `AGENT_CHAT_HOME` to a directory of your own and
planting a `chat.sock` symlink to the live socket makes the site's `home()` differ from
the broker's, so the site refuses, even if the planted `config.json` is a copy of the
real one. But the tick and the watchdog still run in the calling agent's process, and
read other inputs from it that the rule never compares. Each of these is open today to
an agent that calls an opt-out site from its own shell. Citations are at origin/main
`6031c17`:

- **`PATH`.** The tick runs programs by bare name, through `childEnv`
  (`src/exec.ts:14-17`), which copies the whole environment and strips
  only `AGENT_CHAT_NAME` and `AGENT_CHAT_AGENT_ID`. So the calling agent's `PATH` picks
  which binary answers:
  - `gh`, for PR state (`src/agents/burndown/pr-state.ts:68`, and the collision,
    leak-check, exited-adopt and pr-adopt ports);
  - `titan-factory`, for Shepherd's status (`SHEPHERD_BIN`,
    `src/shepherd-client.ts:15`, run at `:89`);
  - `active-work`, for task edits (`src/agents/burndown/brief-approve.ts:67`);
  - `git` (for example `src/agents/burndown/pr-adopt-ports.ts:61`).

  Those answers decide which agents are spawned, handed off or retired.

- **`GH_*` and `GH_CONFIG_DIR`.** These pass through `childEnv` unchanged
  (`exec.ts:15`), so the caller picks the `gh` host, token and config that answer
  `pr-state.ts:68`.
- **Git config variables.** `GIT_CONFIG_*`, `GIT_DIR` and the like also pass through
  `childEnv` unchanged. Only `GIT_ALLOW_PROTOCOL` is pinned (`exec.ts:15`).
- **`lastReport`.** `afterWorker` copies a worker report's first line into the claim
  (`src/agents/burndown/advance.ts:222`). The claim carries it into a reviewer spawn's
  patch (`:238`), a hand-off (`:232`), and the done update next to `retireAll` (`:240`).
  A planted report shapes what the tick spawns and records.

So, under the root rule alone, `PATH=/tmp/fake:$PATH agent-chat burndown tick --once`
from an agent shell would pass the rule and act as `HUMAN` on output the agent planted.

Two more inputs of the same kind were found later: `CLAUDE_CONFIG_DIR`, which picks the
worker transcript (`configDir` in `src/agents/transcript.ts:35`) that decides DONE,
retirement, a reviewer spawn and `lastReport`; and `NODE_OPTIONS`, which loads code into
the opted-out process.

**The boundary that closes the class: built (CC-1151).** An opted-out tick, watchdog or
heartbeat check never runs in the agent's process. When `AGENT_CHAT_AGENT_ID` is set,
`burndown tick --once`, `seats watchdog` and `seats heartbeat-check --seat S` send the
broker a Class 4 `job_kick` frame and run no policy themselves (`src/cli/verbs/job-kick.ts`,
#818). The frame names only the job, and the seat for a heartbeat check. Flags that would
choose policy are refused from an agent shell: `--root` on both seat verbs, `--seat` and
`--fire-cap` on the watchdog, and `--dry-run` on the tick (use `agent-chat burndown
plan`). `seats watchdog --dry-run` and `--replay`, and `heartbeat-check --dry-run`, still
run in-process: they send nothing with authority and write nothing.

The broker runs the job in its own environment (`src/broker/job-kick.ts`, #785). The tick
goes through the burndown kicker, so it shares the ledger-lock deferral and never overlaps
a kicked tick, and logs to `<home>/burndown-kick.log`. The seat jobs log to
`<home>/job-kick.log`. Every launch uses `launchDetached` with `jobEnv`
(`src/mirror/plist.ts:7`, which passes only `HOME`, `PATH`, `AGENT_CHAT_HOME`,
`ACTIVE_ROOT` and `AGENT_CHAT_ACTIVE_WORK_ROOT`, all from the broker) plus the user bus,
the way the launchd and systemd units run them. The job's env has no `AGENT_CHAT_AGENT_ID`,
so it takes the in-process path and cannot kick again. The root, `home()`, `PATH`,
`GH_*`, git config, `CLAUDE_CONFIG_DIR`, `NODE_OPTIONS` and planted-input questions go
away together, and the root-compare frame is not needed.

Tests: `src/__tests__/opt-out-kick.test.ts` plants `PATH` (fake `gh`, `titan-factory`,
`active-work` and `git` that touch a marker), `GH_TOKEN`, `GH_CONFIG_DIR`, `HOME` and
`CLAUDE_CONFIG_DIR` in the caller. For all three verbs the reply is the broker's, the
broker log has a `job_kick` row, and the marker never appears. That harness broker has an
ephemeral home, so it records the kick without launching. `src/__tests__/job-kick.test.ts`
covers the launch side: the job's env is `jobEnv` of the broker's env plus the bus, with no
`GH_*`, `GIT_*`, `NODE_OPTIONS` or `AGENT_CHAT_AGENT_ID`, and planted fields on the frame
never reach the job.

What stays open after that is the §11.4 OS-account limit:

- a broker started from an agent's environment, whether autostarted from an agent shell
  (it inherits that shell's `HOME`, `ACTIVE_ROOT`, `AGENT_CHAT_HOME` and `PATH`) or
  started on purpose with planted values;
- edits to the owner's real charter, seat files or `config.json`.

This meets the bar in `agent-teams.md` §11.4, which stops a confused agent but not an
adversarial one. It does not raise that bar. The OS account remains the trust boundary.
Every agent runs as the human's user and can do anything the human's CLI can do.

## Client-side callers

The frame inventory covers what the broker receives. This table covers who sends those
frames. It lists every sender of a Class 1, 2 or 3 frame under `src/` at origin/main
`d173e6c`, found by grepping for each frame's `t: '<frame>'` literal outside
`src/broker`. The MCP server's own commands (`src/server/commands/*`) are left out,
because they go over the session's registered connection, which the gate does not
change. Internal `Supervisor` calls are left out too: they never cross the socket.

| Sender                                                                                                                          | Frames                                                                                                  | Usual runner                                                     | Can run with the id set?                                                                                                                                                        | Under the gate as recommended                                                                                                                                                                              |
| ------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| burndown tick: `cli/verbs/burndown.ts`, `burndown/execute.ts`, `burndown/triage.ts`, `cli/burndown-broker.ts`                   | `spawn`, `resume`, `retire` (Class 2)                                                                   | the launchd job or systemd timer (`agent-chat burndown install`) | **yes**. `burndown/exec.ts` says "a tick run from an agent's shell carries both" identity variables. `docs/burndown.md` asks for supervised `burndown tick --once` runs by hand | would break if run in-process. Since CC-1151 the site sends only `job_kick` (Class 4) and the broker runs the tick with the unit's env, so the gate never sees these frames from the agent. **Unaffected** |
| seat watchdog: `cli/verbs/seat-respawn.ts`, `cli/verbs/seats.ts`                                                                | `spawn`, `retire`, `resume` (Class 2)                                                                   | launchd or systemd units (`src/mirror/plist.ts`)                 | yes, if a seat or coordinator runs `seats watchdog` by hand from its shell                                                                                                      | same as the tick: `seats watchdog` and `heartbeat-check` kick the broker (CC-1151). **Unaffected**                                                                                                         |
| seat watchdog: `cli/verbs/seat-broker.ts` (`sendAsOwner`)                                                                       | `human_send` (Class 1)                                                                                  | same units                                                       | same                                                                                                                                                                            | sent only by the broker-run job, which has no id (CC-1151). **Unaffected**                                                                                                                                 |
| `agent-chat agent …`: `cli/agents.ts`, `cli/verbs/agent-{park,resume,retire}.ts`                                                | `spawn`, `surface`, `park`, `resume`, `retire`, `retire_finished` (Class 2); `teleport_abort` (Class 1) | the owner, or a coordinator's shell                              | yes, from a coordinator's shell (`WORKER_CLI_DENY` keeps workers off the literal spelling)                                                                                      | mapped to the coordinator, the same as its MCP tools. That is intended. `teleport_abort` is refused, which is also intended                                                                                |
| `cli/human.ts`, `cli/verbs/{dismiss,endorse,approve,ask}.ts`, `inbox/apply.ts`, `cli/debug.ts`, `cli/verbs/teleport-request.ts` | Class 1 frames                                                                                          | the owner's terminal                                             | only when the owner types them into an agent's pane                                                                                                                             | refused. Intended; see the `!` commands question below                                                                                                                                                     |
| `mirror/source.ts`                                                                                                              | `answer`, `dismiss`, `endorse_approve`, `approve_permission` (Class 1)                                  | the mirror daemon's launchd or systemd unit                      | no, the unit does not carry the id                                                                                                                                              | unchanged                                                                                                                                                                                                  |
| `cli/verbs/permission-hook.ts`                                                                                                  | `permission_hook`, `permission_self_granted` (Class 3), `permission_hook_withdrawn` (Class 4)           | the PermissionRequest hook inside the agent's tree               | always                                                                                                                                                                          | accepted for the agent's own session. Intended                                                                                                                                                             |

## Open questions for CC-1138

- **Tick and seat callers run from an agent's shell.** This covers the burndown tick and
  the seat watchdog rows in the caller table. They are the factory's own programs: the
  task board, the charter and the seat files decide what they spawn, resume and retire,
  not the agent whose shell started them. Under the hello as written, a hand-run tick or
  watchdog would be checked as that agent and would break.

  **Superseded by CC-1151 (built in #785 and #818).** With the id set, these three sites
  send a `job_kick` frame, which is Class 4 and accepted from a declared connection, and
  the broker runs the job without the id. So CC-1138 needs no opt-out list, no opt-out
  argument on `withRunningBroker`, no root rule and no root-compare frame: none of them is
  to be built. The hello stays on at every site. The rest of this item records the
  rejected design and why it fell short.

  Options:
  1. Strip the id for these callers, the way `childEnv` (`src/exec.ts`) already
     strips it for the tick's subprocesses.
  2. Give them an exempt frame or source.
  3. Accept the refusal and document it.

  **Recommendation: option 1, scoped to exact call sites and refused for a caller-chosen
  root.** The opt-out is a per-call argument, not a per-module default. Call sites are at
  origin/main `f91dcbe`:

  | Call site                                                                                                                                  | Hello                                                                                                    |
  | ------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------- |
  | `burndownTickVerb.run` in `cli/verbs/burndown.ts` (the `new BrokerClient` there)                                                           | **off**, under the root rule below                                                                       |
  | `seatsWatchdogVerb.run` → `liveRun` → `withRunningBroker` in `cli/verbs/seats.ts`                                                          | **off**, under the root rule below                                                                       |
  | `seatsHeartbeatCheckVerb.run` → `withRunningBroker` (with `sendAsOwner`) in `cli/verbs/seats.ts`                                           | **off**, under the root rule below                                                                       |
  | `burndownReleaseVerb.run` in `cli/verbs/burndown.ts` (its `retire` frame)                                                                  | **on**. A release from an agent shell is checked as that agent, including the new retire ownership check |
  | `readBroker` in `cli/verbs/burndown.ts`, and every other `withRunningBroker` use in `cli/verbs/seats.ts` (`seats status`, `seats boot`, …) | **on** (the default)                                                                                     |

  `withRunningBroker` therefore takes an explicit opt-out argument that only those two
  seats call sites pass. Turning the hello off inside `withRunningBroker` itself would
  cover every seats verb. A test pins the opt-out call sites, so adding one is a reviewed
  change. Another test pins the root rule.

  **The root rule: the broker decides the root.** When `AGENT_CHAT_AGENT_ID` is set, each
  of the three opt-out sites does this before it acts on any policy:
  - It asks the broker, over the connection it already opens, for the roots the broker
    resolves in its own process: `currentAutonomyRoot()`, `activeWorkRoot()` and
    `home()`. `home()` is the `AGENT_CHAT_HOME` the broker runs on (`src/paths.ts`).
  - It refuses unless every one of those it resolved for itself equals the broker's. The
    two seats sites also refuse when `--root` is given. `burndown tick` has no `--root`
    flag (it takes only `--once` and `--dry-run`), so that part does not apply to it.

  `home()` is on the list because the policy roots are not the tick's only inputs. The
  tick and the watchdog also read state relative to `home()`: the burndown ledger
  (`burndown.json`, read in `burndown/run-tick.ts`), `config.json`'s limits, and
  `seat-watchdog.json`. `retireAll` in `burndown/execute.ts` retires the claim names
  that ledger lists. A site whose `home()` differs from the broker's would therefore act
  on state the caller planted, even if its policy roots matched.

  An equivalent form is to drop the site's own resolution and use the broker's roots
  and `home()` outright. CC-1138 picks one of the two. The compare form refuses loudly on a mismatch
  rather than quietly running a different policy, so this record leans towards it. With
  no agent id, the sites behave as today.

  This needs one new read-only frame. The broker answers it from its own process and
  never from the request. CC-1138 adds it to the frame inventory as Class 4.

  Why the broker: the watchdog, heartbeat-check and the tick read their policy (charter,
  seat files, task board) from roots resolved in the calling process. Every input to that
  resolution is something the calling agent can set:
  - `--root`;
  - `AGENT_CHAT_ACTIVE_WORK_ROOT`, `ACTIVE_ROOT`, and `XDG_DATA_HOME` on Linux, read by
    `activeWorkRoot()` (`src/agents/active-work.ts`);
  - `HOME`, through `os.homedir()` when none of those is set, and `APPDATA` on win32;
  - `AGENT_CHAT_HOME`, which picks the `config.json` whose `coordinatorConfig`
    `currentAutonomyRoot` (`src/agents/autonomy-root.ts`) applies.

  The tick's charter resolves the same way (`src/agents/burndown/policy.ts`). So
  `ACTIVE_ROOT=/tmp/fake agent-chat seats watchdog` or `HOME=/tmp/fake agent-chat seats
watchdog` picks a policy the caller wrote, with no `--root`. With that policy, an agent
  could drive `human_send` as the human, and `spawn` and `retire` as `HUMAN`, for any
  agent name, past the new ownership check.

  Earlier drafts of this rule stripped these variables one at a time, and each review
  found another. Comparing with the broker's values covers the root and `home()` inputs,
  but not the others the opt-out sites read from the calling process (`PATH`, `GH_*`,
  git config, planted reports). It is a stopgap, not a closure. See the Limits section:
  the boundary that closes the class is the broker kick frame (CC-1151). It has landed,
  an opted-out site runs nothing in the agent's process, and this frame is not built.

  Option 2 was rejected because the broker would have to trust a self-declared source,
  which an agent can set as easily as it can omit the id. That adds broker surface for no
  extra assurance. Option 3 was rejected because it breaks the supervised ticks
  `docs/burndown.md` asks for, and a seat relaunching its peers.

  **Limit.** An agent that runs `burndown tick` or `seats watchdog`, and so kicks the
  broker, starts a run with the tick's or watchdog's authority. The owner's files bound what that
  authority does: the charter, the seat files and the task board. The caller's brief does
  not. Those files sit under the same OS account, though, so an agent that edits them
  edits the policy. This is §11.4's limit again, not a new one.

  So worker profiles must also deny both verbs:
  - `Bash(agent-chat burndown:*)` is in the repo's shipped bd-* profiles (landed).
  - `Bash(agent-chat seats:*)` is in no profile. CC-1138 adds it to the same profiles and
    to `WORKER_CLI_DENY`.
  - CC-1138 also adds `DERIVED_DENIES` rules for both, triggered by
    `Bash(agent-chat send:*)`. That gives installed profile files the denies at load
    time, which is the same mechanism slice a uses for `debug send`.

- **Owner config question: which profile copy loads.** At runtime the broker loads
  `$AGENT_CHAT_HOME/profiles/<name>.json`, which defaults to `~/.agent-chat/profiles`
  (`profilesDir()` in `src/paths.ts`, `loadProfile` in `src/agents/profiles.ts`). It uses
  a builtin only when no such file exists. The repo's `profiles/*.json` are never read at
  runtime, and no install step copies them. Observed 2026-10-12: the installed
  `bd-implementer.json`, `bd-implementer-lite.json`, `bd-planner.json` and
  `bd-reviewer.json` in `~/.agent-chat/profiles` contain neither `agent-chat burndown`
  nor `agent-chat seats`. So the repo's burndown deny does not reach the agents that run.
  The owner decides whether to re-copy the repo profiles, or to let the derived-deny rules
  above cover them at load time. This record does not edit `~/.agent-chat`.

- **Seat verbs.** `seats watchdog` and `heartbeat-check` send `human_send` with
  `source: 'watchdog'` through `sendAsOwner` (`src/cli/verbs/seat-broker.ts`). They run
  from launchd or systemd units (`src/mirror/plist.ts`), which do not carry the id. Before
  the gate lands, confirm that no seat session runs these verbs from its own shell, where
  the id would be set. If one does, CC-1151 covers it: the call kicks the broker, which
  runs the check without the id, and the caller gets the kick reply, not the check's
  output (that goes to `<home>/job-kick.log`).
- **`teleport request`** (`src/cli/verbs/teleport-request.ts`) is a human verb that sends
  `human_send`. When the owner types it into a teleported agent's terminal pane, the
  shell carries the agent's id and the gate would refuse it. Decide whether that is
  acceptable, since the owner can run it from any other shell.
- **The owner's `!` commands inside an agent pane** hit the same issue for `queue answer`
  and the other verbs. Make the refusal message say why and suggest a plain shell.

## Relationship to the deny list

Keep both. The deny lists stop the common spelling: `HUMAN_ONLY_CLI_DENY` (landed;
the `debug send` entry is planned in CC-1083 slice a, not landed) and CC-216's
`WORKER_CLI_DENY` (landed). They stop it before the command runs, and the denial shows up in the agent's transcript. The broker gate catches the
other spellings at the point of authority. Neither replaces the OS account as the
boundary.

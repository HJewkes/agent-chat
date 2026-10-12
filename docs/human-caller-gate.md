# Human caller gate: who may send the human's frames

Decision record for CC-1083 (slice b), 2026-10-12. Follow-up implementation:
**CC-1138** (claude-channels initiative, tags `kind:security`, `repo:agent-chat`),
filed and open; nothing in it has landed.

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
origin/main `d173e6c` (2026-10-12). It lists all 49 cases there, and each case appears in
exactly one class: 7 refused, 6 requester mapped, 2 session bound and 34 out of scope. When a frame is added to the dispatcher, add it
here too.

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

`service_ask` is here because it asks the human under a service label that nothing
vouches for. Profiles already deny agents `agent-chat ask` (CC-169, landed), and leaving
the frame open would get around that deny.

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

| Frame                     | Today                                                                                                                     | With a declared id                                        |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| `permission_hook`         | `isHuman` passes, and the caller picks `msg.session`                                                                      | accepted only when `msg.session` names the declared agent |
| `permission_self_granted` | `isHuman` passes; the `approval_request` and `allow` `resolution` rows take `actor = msg.session`, which the caller picks | accepted only when `msg.session` names the declared agent |

Both frames come from the PermissionRequest hook (`permission_self_granted` is CC-694's
audit row for a call the hook allowed itself). The hook runs inside an agent's process
tree, so it always carries the agent's id and has to stay open. Binding `msg.session`
keeps one agent from filing a prompt, or an audit row, under another agent's name.

### Class 4: out of scope, guarded by its own check

The gate leaves these frames alone. Each one already refuses an unregistered
connection, checks something other than "unregistered", or only reads.

| Frame                                                                                                                        | Its own check                                                                                                                  |
| ---------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `send`, `broadcast`, `ask`, `notify`, `endorse`, `subscribe`, `unsubscribe`, `tag`, `claim`, `release`, `status`, `approval` | `SESSION_FRAMES`: each handler refuses or no-ops without a registered name                                                     |
| `decided`                                                                                                                    | `handleDecided`: the connection's bound agent id must equal the configured decider's                                           |
| `teleport`, `teleport_plan_wait`, `teleport_launched`, `background`                                                          | the subject is the connection's own durable identity (`registry.entryFor(conn)?.agentId`); refused without one                 |
| `teleport_land_failed`                                                                                                       | `landFailed` requires the armed landing's token                                                                                |
| `register`                                                                                                                   | registry name rules, plus `refuseLauncherRegister`; it creates a name, it does not use the human's authority                   |
| `readopt`                                                                                                                    | `handleReadopt`: the name comes from the log for an adopted session, and is refused while a live connection holds it           |
| `permission_hook_withdrawn`                                                                                                  | only the connection that raised the hook may withdraw it                                                                       |
| `host_hello`                                                                                                                 | refuses a registered connection; the `machines` list bounds which hosts may be announced; the first live launcher holds a host |
| `host_probe_result`, `host_launch_result`                                                                                    | `HostDirectory.answer` settles only a request the broker sent on that same connection                                          |
| `inbox`                                                                                                                      | reads the caller's own inbox; empty for an unnamed connection                                                                  |
| `list`, `queue`, `history`, `inbox_since`, `activity`, `reported`, `answers_since`, `agents`, `hosts`                        | read-only. `inbox_since` and `answers_since` read any name's rows, which is a confidentiality question outside this gate       |

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
  `msg.session` names the declared agent.
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
that agent. This meets the bar in
`agent-teams.md` §11.4, which stops a confused agent but not an adversarial one. It does
not raise that bar. The OS account remains the trust boundary. Every agent runs as the
human's user and can do anything the human's CLI can do.

## Client-side callers

The frame inventory covers what the broker receives. This table covers who sends those
frames. It lists every sender of a Class 1, 2 or 3 frame under `src/` at origin/main
`d173e6c`, found by grepping for each frame's `t: '<frame>'` literal outside
`src/broker`. The MCP server's own commands (`src/server/commands/*`) are left out,
because they go over the session's registered connection, which the gate does not
change. Internal `Supervisor` calls are left out too: they never cross the socket.

| Sender                                                                                                                          | Frames                                                                                                  | Usual runner                                                     | Can run with the id set?                                                                                                                                                        | Under the gate as recommended                                                                                                                             |
| ------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| burndown tick: `cli/verbs/burndown.ts`, `burndown/execute.ts`, `burndown/triage.ts`, `cli/burndown-broker.ts`                   | `spawn`, `resume`, `retire` (Class 2)                                                                   | the launchd job or systemd timer (`agent-chat burndown install`) | **yes**. `burndown/exec.ts` says "a tick run from an agent's shell carries both" identity variables. `docs/burndown.md` asks for supervised `burndown tick --once` runs by hand | checked as the shell's agent: escalation, coordinator depth, worker-spawn ban, rate limit. The new retire ownership check refuses its retires. **Breaks** |
| seat watchdog: `cli/verbs/seat-respawn.ts`, `cli/verbs/seats.ts`                                                                | `spawn`, `retire`, `resume` (Class 2)                                                                   | launchd or systemd units (`src/mirror/plist.ts`)                 | yes, if a seat or coordinator runs `seats watchdog` by hand from its shell                                                                                                      | same as the tick. The seat's relaunch is refused or checked as that agent. **Breaks**                                                                     |
| seat watchdog: `cli/verbs/seat-broker.ts` (`sendAsOwner`)                                                                       | `human_send` (Class 1)                                                                                  | same units                                                       | same                                                                                                                                                                            | refused. **Breaks**                                                                                                                                       |
| `agent-chat agent …`: `cli/agents.ts`, `cli/verbs/agent-{park,resume,retire}.ts`                                                | `spawn`, `surface`, `park`, `resume`, `retire`, `retire_finished` (Class 2); `teleport_abort` (Class 1) | the owner, or a coordinator's shell                              | yes, from a coordinator's shell (`WORKER_CLI_DENY` keeps workers off the literal spelling)                                                                                      | mapped to the coordinator, the same as its MCP tools. That is intended. `teleport_abort` is refused, which is also intended                               |
| `cli/human.ts`, `cli/verbs/{dismiss,endorse,approve,ask}.ts`, `inbox/apply.ts`, `cli/debug.ts`, `cli/verbs/teleport-request.ts` | Class 1 frames                                                                                          | the owner's terminal                                             | only when the owner types them into an agent's pane                                                                                                                             | refused. Intended; see the `!` commands question below                                                                                                    |
| `mirror/source.ts`                                                                                                              | `answer`, `dismiss`, `endorse_approve`, `approve_permission` (Class 1)                                  | the mirror daemon's launchd or systemd unit                      | no, the unit does not carry the id                                                                                                                                              | unchanged                                                                                                                                                 |
| `cli/verbs/permission-hook.ts`                                                                                                  | `permission_hook`, `permission_self_granted` (Class 3), `permission_hook_withdrawn` (Class 4)           | the PermissionRequest hook inside the agent's tree               | always                                                                                                                                                                          | accepted for the agent's own session. Intended                                                                                                            |

## Open questions for CC-1138

- **Tick and seat callers run from an agent's shell.** This covers the burndown tick and
  the seat watchdog rows in the caller table. They are the factory's own programs: the
  task board, the charter and the seat files decide what they spawn, resume and retire,
  not the agent whose shell started them. Under the hello as written, a hand-run tick or
  watchdog would be checked as that agent and would break.

  Options:
  1. Strip the id for these callers, the way `childEnv` (`burndown/exec.ts`) already
     strips it for the tick's subprocesses.
  2. Give them an exempt frame or source.
  3. Accept the refusal and document it.

  **Recommendation: option 1, done in the client.** These callers build their
  `BrokerClient` with the hello turned off: the tick's unregistered clients in
  `cli/verbs/burndown.ts` and `withRunningBroker` in `cli/verbs/seat-broker.ts`. The
  tick's registered `burndown` sender (`connectBroker` in `cli/burndown-broker.ts`) only
  sends Class 4 frames, so it does not need the change. The tick and the watchdog then reach the broker exactly
  as they do from launchd today. A test pins the list of callers that turn the hello off,
  so adding one is a reviewed change.

  Option 2 was rejected because the broker would have to trust a self-declared source,
  which an agent can set as easily as it can omit the id. That adds broker surface for no
  extra assurance. Option 3 was rejected because it breaks the supervised ticks
  `docs/burndown.md` asks for, and a seat relaunching its peers.

  Limit: an agent that runs `agent-chat burndown tick` or `seats watchdog` acts with the
  tick's authority. That authority is bounded by the tick's own policy (charter caps, the
  spawn gate, the task board), not by the caller's brief. Today the shipped bd-* profiles
  deny `Bash(agent-chat burndown:*)` by literal spelling (landed), and no profile denies
  `seats`. Whether to add a `seats` deny is part of CC-1138.

- **Seat verbs.** `seats watchdog` and `heartbeat-check` send `human_send` with
  `source: 'watchdog'` through `sendAsOwner` (`src/cli/verbs/seat-broker.ts`). They run
  from launchd or systemd units (`src/mirror/plist.ts`), which do not carry the id. Before
  the gate lands, confirm that no seat session runs these verbs from its own shell, where
  the id would be set. If one does, the next entry's recommendation covers it: the
  watchdog's client turns the hello off.
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

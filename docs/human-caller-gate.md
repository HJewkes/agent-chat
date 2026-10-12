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
`a162351` (2026-10-12), no profile denies it: `HUMAN_ONLY_CLI_DENY` has no `debug` entry,
so any agent with `Bash` can run it today. CC-1083 slice a is planned, not landed. It will
add `Bash(agent-chat debug send:*)` to `HUMAN_ONLY_CLI_DENY` and to the load-time derived
denies. Even then, a deny list only matches the literal spelling. `node dist/cli.js debug send`, `npx agent-chat …`, an absolute path or a raw
socket write all pass it (`src/agents/profiles.ts`, the comment on
`HUMAN_ONLY_CLI_DENY`). This note decides whether the broker should also gate these
frames by caller.

## Frames in scope

An unregistered connection gets the human's authority in three different ways.

**Human-only frames.** `isHuman` guards these, and they mean "the human decided":

| Frame                | Handler                                                         |
| -------------------- | --------------------------------------------------------------- |
| `human_send`         | `handleHumanSend`                                               |
| `answer`             | `handleAnswer`                                                  |
| `dismiss`            | `handleDismiss` (the branch where the caller is not the author) |
| `endorse_approve`    | `handleEndorseApprove`                                          |
| `approve_permission` | `handleApprovePermission`                                       |
| `teleport_abort`     | `handleTeleportAbort`                                           |
| `service_ask`        | `handleServiceAsk`                                              |

`service_ask` is on the list because an agent that sends it asks the human under a
service label that nothing vouches for. Profiles already deny agents `agent-chat ask`
(CC-169, `src/agents/profiles.ts`), so leaving the frame open would undo that deny.

**Lifecycle frames that fall back to `requestedBy = HUMAN`.** These do not check
`isHuman`. They take the requester's registered name, or `HUMAN` when there is none:

| Frame     | Where the fallback happens                                                |
| --------- | ------------------------------------------------------------------------- |
| `spawn`   | `handleSpawn`: `registry.nameOf(conn) ?? HUMAN`                           |
| `resume`  | `handleResume`: `requester?.name ?? HUMAN`                                |
| `surface` | `switchSurface` call: `requester?.name ?? HUMAN`                          |
| `park`    | the `park` case in the dispatcher: `requester?.name ?? HUMAN`             |
| `retire`  | the `retire` case: the actor is `msg.caller`, a field the caller fills in |

`requestedBy === HUMAN` switches off these checks in `src/agents/supervisor.ts`:
`checkEscalation`, the worker-spawn ban, the cwd policy (`checkCwd`) and the spawn rate
limit (`rateRefusal`). It also switches off the predecessor-ownership check
(`resolvePredecessor` in `src/agents/predecessor.ts`). So an agent that reaches these
frames over the CLI acts without its own role's limits. The CC-216 `WORKER_CLI_DENY` deny
list (`Bash(agent-chat agent:*)`) covers the same gap, with the same weakness as
`HUMAN_ONLY_CLI_DENY`: it matches only the literal spelling.

**`permission_hook`** stays open to agent connections. The PermissionRequest hook runs
inside an agent's process tree, so it always carries the agent's id. Today, though, the
caller chooses `msg.session`, which names the agent the prompt is filed for
(`handlePermissionHook`).

`approval` is a session frame (it requires a name), so it is out of scope.

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
- **Human-only frames** (the first table, including `service_ask`) are refused from a
  connection that declared an id. The broker appends `verdict_refused` the way
  `refuseToSession` does today.
- **Lifecycle frames** (the second table) are not refused. The broker uses the declared
  agent as the requester: `requestedBy` is its name and `requesterAgentId` is its id, and
  for `retire` the actor is its name, with `msg.caller` ignored. If the id resolves to no
  known agent, the frame is refused rather than falling back to `HUMAN`.
- **`permission_hook`** is accepted only when `msg.session` names the declared agent.
  Any other session is refused.

Why lifecycle frames get the agent as requester instead of being refused: an agent
already has these verbs through its own MCP tools (`agent_spawn`, `agent_resume`,
`agent_surface`, and so on), and those tools apply its role's checks. Mapping the CLI path
to the same requester gives the two paths the same result. The worker-spawn ban, the
escalation check, the cwd policy, the rate limit and the predecessor-ownership check then
apply however the agent spells the command. Refusing outright would also refuse a
coordinator that drives the CLI from its shell, which those checks already allow. Once
the gate lands, `WORKER_CLI_DENY` becomes defence in depth rather than the only guard.

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

## Open questions for CC-1138

- **Seat verbs.** `seats watchdog` and `heartbeat-check` send `human_send` with
  `source: 'watchdog'` through `sendAsOwner` (`src/cli/verbs/seat-broker.ts`). They run
  from launchd or systemd units (`src/mirror/plist.ts`), which do not carry the id. Before
  the gate lands, confirm that no seat session runs these verbs from its own shell, where
  the id would be set. If one does, give them a frame of their own, or a source the
  broker accepts from a declared agent, rather than exempting `human_send`.
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

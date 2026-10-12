# Human caller gate: who may send the human's frames

Decision record for CC-1083 (slice b), 2026-10-12. Follow-up implementation:
**CC-1138** (claude-channels initiative, tags `kind:security`, `repo:agent-chat`).

## The problem

The broker decides that a connection speaks for the human by one test:
`isHuman(conn)` in `src/broker/socket.ts` returns true when the connection has no
registered name. Every CLI invocation opens an unregistered connection, so any local
process that runs `agent-chat` counts as the human. That includes a spawned agent's own
`Bash` tool.

`agent-chat debug send <to> <text>` (`src/cli/debug.ts`) sends a `human_send` frame, so
an agent that runs it delivers free text with `from="human"`. Slice a of CC-1083 denies
that verb in the profile deny lists. A deny list only matches the literal spelling,
though. `node dist/cli.js debug send`, `npx agent-chat …`, an absolute path or a raw
socket write all pass it (`src/agents/profiles.ts`, the comment on
`HUMAN_ONLY_CLI_DENY`). This note decides whether the broker should also gate these
frames by caller.

## Frames in scope

The broker gives these frames the human's authority, and `isHuman` guards them:

| Frame                | Handler                                                         |
| -------------------- | --------------------------------------------------------------- |
| `human_send`         | `handleHumanSend`                                               |
| `answer`             | `handleAnswer`                                                  |
| `dismiss`            | `handleDismiss` (the branch where the caller is not the author) |
| `endorse_approve`    | `handleEndorseApprove`                                          |
| `approve_permission` | `handleApprovePermission`                                       |
| `teleport_abort`     | `handleTeleportAbort`                                           |

`permission_hook` and `service_ask` also check `isHuman`, but for a different reason.
They are for processes that never register, and the PermissionRequest hook runs
**inside** an agent's process tree. A caller gate must leave them open to connections
that come from an agent. `approval` is a session frame (it requires a name), so it is
out of scope.

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
- The broker records the declared id per connection. It refuses the frames in the table
  above from a connection that declared one, and appends `verdict_refused` the way
  `refuseToSession` does today.
- `permission_hook` and `service_ask` stay open to such connections.

This catches every CLI spelling that the deny list misses, because the gate keys on the
process's environment rather than on the command text.

**Limits, stated plainly.** The id is self-declared. `env -u AGENT_CHAT_AGENT_ID
agent-chat debug send …` or a raw `nc` write still gets through. This meets the bar in
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

Keep both. The deny list (CC-1083 slice a) stops the common spelling before the command
runs, and the denial shows up in the agent's transcript. The broker gate catches the
other spellings at the point of authority. Neither replaces the OS account as the
boundary.

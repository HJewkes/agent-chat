# Plans index — read this first

Three design documents landed together on 2026-07-27. They are plans, not
implementations. Nothing in them is built yet.

| Doc | What it is |
|---|---|
| [`agent-teams-plan.md`](./agent-teams-plan.md) | Spawning and supervising Claude Code agents inside agent-chat. The main event. |
| [`service-and-dashboard-plan.md`](./service-and-dashboard-plan.md) | Formalising the broker as a service, adding an HTTP layer and an interactive dashboard. |
| [`brain-spawn-survey.md`](./brain-spawn-survey.md) | Read-only survey of the existing spawn code in `~/projects/brain`, with file:line. Source material for the teams plan. |

They compose: the teams plan depends on parts of the service plan. Read the
teams plan's §12 for the exact dependency, and its §13 for sequencing.

## Why this exists

agent-chat and brain are complementary halves. brain can **spawn** agents but
has no message bus — children report by exit code and one final JSON parse, so
the topology is strictly parent→child. agent-chat has the **bus** — peers
register, address each other by name, escalate to a human queue, all over an
append-only event log — but cannot spawn anything.

The goal is to replicate Claude Code's agent-teams feature set while fixing the
two things it does badly, both named by the human:

- **Rigid topology.** Spawn-tree only. Agents cannot be long-lived peers, cannot
  be reattached to, and the human is not a first-class participant.
- **No persistence.** Agent state dies with the session; nothing is resumable.

Spawned agents therefore become **first-class peers in the existing registry**,
not children on a pipe. That is the design's whole point.

## Decisions already made — do not relitigate

- **Home:** lift brain's reusable spawning code into agent-chat. Leave brain
  untouched. Copy and adapt; do not extract a shared package.
- **MVP:** spawn + roster + lifecycle; visible (iTerm) spawning; inter-agent
  messaging; isolation.
- **Isolation is optional and pluggable** — `none`, `worktree`,
  `file-ownership`, `toolset-limited` behind one strategy interface. Not
  worktree-only.
- **Dashboard is interactive** — the browser can answer and dismiss, through the
  same broker path the CLI uses. Narrow surface: answer and dismiss only.
- **No `bypassPermissions`.** Spawned agents run under the normal permissions
  posture. brain's default is explicitly not inherited. A blocked agent is a
  first-class lifecycle state, and the blockers surface is load-bearing rather
  than a nicety.

## The hinge: presence is ephemeral, identity is durable

The one thing to internalise before reading either plan.

- **Presence** — "connected right now" — is tied to socket/process lifetime and
  is *never* persisted. This is what buys no heartbeats, no TTLs, no
  stale-entry reaper.
- **Identity** — "this agent exists, was spawned for this task, has this
  history, may be resumed" — is durable, in the event log.
- **Resuming** is a new process attaching to an existing identity, not a new
  registration.

Getting this backwards produces either a stale-agent reaper or agents that
evaporate on restart. Note brain determines liveness with a stored pid plus
`process.kill(pid,0)` and a 5s poll; agent-chat's socket-as-lease is strictly
better and replaces it.

## Constraints that bound both plans

- The MCP layer stays **stdio, one subprocess per session**. That is what makes
  channel delivery addressable at all — `notifications/claude/channel` carries
  only `content` and `meta`, no addressing field, so "which subprocess emits"
  *is* the address. This is also the house convention: all three reference
  services (active-work, brain, voltras-mcp) register stdio-per-session.
- The **event log stays the single source of truth**. New state is appended
  events or queries over them, never a parallel store.
- HTTP goes in the **shared broker**, never in the per-session MCP process. Two
  of the three reference services put it in the per-session process and both hit
  port collisions — voltras tracks it as VW-68 ("one shared daemon removes this
  race"); brain works around it with a `POST /api/shutdown` self-eviction
  protocol. agent-chat already has the shared daemon they want.

## Known bounds that shape the design

- **Headless agents do not relay permission prompts.** Verified live in CC-2
  with a positive control: an interactive session produces `approval_request`
  rows, a headless one produces none, ever. Since permissions are no longer
  bypassed, a headless agent blocked on a prompt is *invisible* to the very view
  meant to unblock it. See [`permission-relay.md`](./permission-relay.md).
- **The relay is behind a remote feature flag** (`tengu_harbor_permissions`,
  default false, currently true for this account). It can be revoked
  server-side, so nothing may depend on it for correctness.
- **Approvals age out by TTL, not by an event.** When the local dialog wins the
  race, the host sends the channel server nothing at all. A live blockers view
  must handle items vanishing with no event behind them.
- **Priority inversion is unsolved** (CC-16). Peer traffic arrives with the
  immediacy of a live event while the user's own request sits in the transcript
  looking answered, so agents serve the interrupt first. Volume throttling
  (CC-6) does not touch it. A fleet of spawned agents makes this worse, not
  better.

## Open, and worth deciding early

- `--output-format stream-json` versus brain's single final `JSON.parse`. See
  teams plan §9. Streaming is what would let headless progress appear live;
  much cheaper to design in than to retrofit.
- Whether this work belongs in the `claude-channels` initiative or a new one.
- Sequencing against the remaining CC-* verification tasks.

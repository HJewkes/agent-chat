# agent-teams: spawning and supervising Claude Code agents inside agent-chat

**Status:** plan only. No code, config, or docs were modified producing this.
**Written:** 2026-07-27. **Repo:** `/Users/hjewkes/projects/agent-chat` (branch
`main`, HEAD `5ca0ac0`, clean). Source read: this repo in full, and
`/Users/hjewkes/projects/brain` (`src/commands/launch.ts`, `src/server/dispatch.ts`,
`src/modules/agents/*`).

**Companion document:** `agent-teams-plan.md` assumes
`agent-chat-service-plan.md` (same directory) has been read. §12 states exactly
which of its steps this depends on and which it perturbs.

Every claim about existing behaviour cites `file:line` and was verified by
opening the file, not inherited from a brief.

---

## 0. What this builds, and what it deliberately does not

**Builds (MVP):**

1. Spawn a Claude Code agent, give it a durable identity, keep a roster, run it
   through a lifecycle that survives the death of whatever spawned it.
2. Spawn it **visibly** — into an iTerm pane, tab, or window — behind the same
   interface as headless.
3. Make the spawned agent a **first-class peer in the existing registry**,
   addressable by name over the existing bus, not a child on a pipe.
4. **Optional, pluggable isolation**: `none`, `worktree`, `file-ownership`,
   `toolset-limited`, behind one strategy interface.
5. **A blockers surface** — CLI and dashboard — for finding and clearing agents
   that are stuck on a permission prompt, plus the verdict write path. Spawned
   agents run under normal permissions (§11), so this is load-bearing, not a
   nicety.

**Does not build:** anything from brain's delivery/PR layer (`delivery*.ts`,
`merge-stack.ts`, `fix-agent.ts`, `auto-merge.ts`, `agent-done-handler.ts`) —
that is GitHub domain logic, not generic agent infrastructure. Nothing from
`dispatch-loop.ts` except the `Semaphore` class. No task/PM model: agent-chat has
no notion of a task and should not grow one to host this.

**Leaves brain untouched.** Code is lifted (copied and adapted), not extracted
into a shared package. A shared package between two private repos with different
DB layers (`better-sqlite3` vs `node:sqlite`), different id conventions, and
different lifecycles is a coupling neither repo has earned.

---

## 1. The hinge: presence is ephemeral, identity is durable

This is the load-bearing paragraph. Read it before anything else.

The service plan §4.5 says **do not persist the registry**, and gives the
correct reason: *"a registration outliving its process is a lease outliving the
thing it leases."* That buys agent-chat its cleanest property — the README's *"no
heartbeats, no TTLs, no stale-entry reaper."* `Registry.entries` is keyed by the
connection object itself (`registry.ts:73`), so liveness is not tracked, it is
*structural*: the entry cannot exist without the socket.

Spawning appears to need the opposite — agents that outlive a session, can be
listed tomorrow, can be resumed. Both are right, because they are about two
different things:

| | Presence | Identity |
|---|---|---|
| Means | "connected right now" | "this agent exists, was spawned for this brief, has this history, may be resumed" |
| Lives in | `Registry`, an in-memory `Map` keyed by socket (`registry.ts:73`) | the append-only event log (`broker/event-log.ts`) |
| Lifetime | the socket | forever |
| Recovered by | reconnect + re-register (`broker-client.ts:65-72`) | it was never lost |
| Persisted | **never** | **always** |

**Resuming is a new process attaching to an existing identity, not a new
registration of a new thing.** A resumed agent gets a fresh socket (new presence)
and reuses its agent id (same identity).

### 1.1 Replace brain's pid-based liveness. Say so out loud.

brain determines liveness by storing a pid in `agents.pid`
(`brain/src/modules/agents/schema.ts:21`) and calling `process.kill(pid, 0)`,
backed by a periodic DB poll. That is the weaker mechanism and it brings the
whole reaper problem with it: pids are reused, a wedged process is "alive", and
the poll interval is the resolution of your liveness signal.

agent-chat's socket-connection-as-lease is strictly better: no polling, no TTL,
no reaper, and pid reuse is irrelevant because the socket *is* the identity of
the connection. **When lifting brain's `agents` table, keep the durable identity
fields and drop `pid` as a liveness source.** A pid is still recorded — it is
useful for `kill` and for diagnostics — but nothing ever asks `process.kill(pid,0)`
to decide whether an agent is up. That question is answered by
`Registry.connFor(name)` (`registry.ts:141`), in O(1), with no I/O.

### 1.2 Identity lives in the event log, not in a second table

brain models identity as a mutable row: `UPDATE agents SET status = ...`
(`brain/src/modules/agents/data.ts:133-152`). Do **not** lift that shape. The
service plan's assumption 2 is binding — *the append-only log is the source of
truth; new state is appended events or queries over them, never a parallel
store.* An `agents` table alongside `events` in the same file would be exactly
the parallel store that assumption forbids, and it would immediately drift: the
socket handler would write rows, the HTTP layer would write rows, and the single
write path the service plan §4.2 is built to establish would be broken on day one.

So: **lift brain's columns as event payload fields, not as a table.** Agent
identity is a fold over the agent's own event rows. Three properties fall out,
all of them wanted:

1. It composes with SSE for free. The dashboard's agents view is live because
   `core.append()` already fans out (service plan §4.2, property 1). No second
   subscription, no polling.
2. It reuses the existing indexes. `events_msg_id` and `events_ref`
   (`event-log.ts:51-52`) are exactly the two indexes an agent fold needs — see
   §2.2. No schema migration at all.
3. History is free and honest. "This agent was spawned, attached, detached,
   resumed twice, exited" is the literal row sequence, not a reconstruction.

The cost is real and should be stated: **no `UNIQUE` constraint on agent name.**
That invariant moves from the schema into code (§2.4). At the scale this operates
at — tens of agents, one machine — that is an acceptable trade for not violating
the architecture's one non-negotiable rule.

---

## 2. Data model

### 2.1 New `EventKind`s

Added to the union at `protocol.ts:26-36`:

| Kind | `msg_id` | `ref` | `actor` | `target` | Meaning |
|---|---|---|---|---|---|
| `agent_spawned` | **the agent id** | — | spawner name (or `human`) | agent name | identity created |
| `agent_attached` | new | agent id | agent name | — | a process registered as this agent |
| `agent_detached` | new | agent id | agent name | — | its socket dropped |
| `agent_resumed` | new | agent id | spawner name | agent name | a new process was launched against this identity |
| `agent_exited` | new | agent id | agent name | — | the process ended; carries exit code / summary / cost |
| `agent_retired` | new | agent id | actor who retired it | agent name | terminal; isolation released, name freed |
| `isolation_allocated` | new | agent id | agent name | — | strategy + handle (branch, path, patterns) |
| `isolation_released` | new | agent id | agent name | — | released, or refused-and-why |
| `agent_spawn_refused` | new | — | requester | requested name | budget, depth, authority, or cwd refusal |
| `verdict_refused` | new | — | requester | — | something reached for the verdict path without human authority (§11.4) |

`agent_spawn_refused` and `verdict_refused` are deliberately events and not just
`reason` strings on a reply: refusals are the security-relevant thing (§11) and
must be in the log whether or not anyone was watching.

**Two kinds deliberately *not* added.** A permission verdict does not get its
own kind, and neither does "blocked":

- **The verdict is a `resolution` row** — `actor: 'human'`, `ref` = the
  `approval_request`'s `msg_id`, `body` = `allow` | `deny`, `meta` =
  `{request_id, behavior, via}`. That is the shape `dismiss` already writes
  (`broker/index.ts:201`), so the existing `CLOSED` subquery (`event-log.ts:67`)
  retires the item from `humanQueue()` with **no query change**. An
  `approval_verdict` kind would leave the item open forever until someone also
  taught `CLOSED` about it.
- **Blocked is derived, not recorded** (§11.5). An agent is blocked when it has
  an open `approval_request`. Recording it as state would need a matching
  "unblocked" event, and the host never sends one — when the local dialog wins,
  *"the host sends the channel server nothing"* (`docs/permission-relay.md:118-120`).

`approval_request` (`broker/index.ts:153-159`) gains one `meta` key: `agent_id`,
set when the actor is a known agent. That is the correlation key (`request_id`
already travels at `:158`) that lets a blocker row name the agent, its profile,
and its isolation handle rather than just a session name.

### 2.2 Why the id conventions matter

`agent_spawned` puts the **agent id in `msg_id`**; every later row puts it in
`ref`. That is not cosmetic — it means the two hot queries hit existing indexes:

- "the spawn record for agent X" → `events_msg_id` (`event-log.ts:51`)
- "everything that has happened to agent X" → `events_ref` (`event-log.ts:52`)

Agent ids use the same shape as message ids (`newMsgId()`, `event-log.ts:75` —
an 8-char uuid slice) so they read the same in the CLI and the log, and so
`history` output (`cli.ts:138-149`) renders them without special-casing.

### 2.3 What `agent_spawned.meta` carries

The durable identity payload, lifted from brain's `agents` table
(`brain/src/modules/agents/schema.ts:9-27`) minus the PM- and delivery-specific
columns (`brain_task`, `claim_token`, `dod_spec`):

```
name          agent name (the registry name it will hold)
parent        spawning agent id, or "" when the human spawned it
profile       profile name (§4)
model         resolved model id
surface       headless | iterm-pane | iterm-tab | iterm-window
isolation     none | worktree | file-ownership | toolset-limited
cwd           resolved working directory (post-isolation)
session_id    the uuid passed to --session-id; the resume handle
allowed_tools csv, as passed to --allowed-tools
perm_mode     the --permission-mode actually used, or "" for inherited
depth         spawn depth (§11.3)
```

`meta` keys must stay in `[A-Za-z0-9_]` — keys with hyphens are silently dropped
when `meta` becomes `<channel>` tag attributes (`docs/ideas.md`, P3). All of the
above comply. `body` on `agent_spawned` is the brief.

Values that appear only later — exit code, summary, cost, branch — go on the
event that learns them, never back onto `agent_spawned`. Append-only means
append-only.

### 2.4 The read model: `AgentLog`

`src/agents/identity.ts` — a query class over the same `EventLog` db handle,
mirroring how `humanQueue()` (`event-log.ts:135`) and `openQuestionCount()`
(`event-log.ts:156`) are already pure projections.

```ts
export type AgentLifecycle = 'spawning' | 'live' | 'detached' | 'exited' | 'retired'

export interface AgentIdentity {
  id: string
  name: string
  parent: string
  profile: string
  brief: string
  cwd: string
  isolation: string
  surface: string
  sessionId: string
  spawnedAt: number
  lifecycle: AgentLifecycle
  lastEventAt: number
  exit?: { code: number | null; summary: string; costUsd?: number }
}

export class AgentLog {
  constructor(private readonly events: EventLog) {}
  roster(opts?: { includeRetired?: boolean }): AgentIdentity[]
  get(id: string): AgentIdentity | undefined
  byName(name: string): AgentIdentity | undefined   // most recent non-retired
  nameIsClaimed(name: string): boolean
}
```

The lifecycle fold is a pure function over the row sequence — trivially unit
testable with a synthetic row list and no database:

```
agent_spawned                        -> spawning
… + agent_attached                   -> live
… + agent_detached                   -> detached
… + agent_resumed                    -> spawning  (then attached -> live)
… + agent_exited                     -> exited
… + agent_retired                    -> retired
```

`nameIsClaimed` enforces, in code, the uniqueness the schema no longer provides
(§1.2): a name is claimed while any non-`retired` identity holds it.

### 2.5 The pairing table — presence × identity

This is what the roster view (CLI and dashboard) actually renders, and it is
where the design pays off:

| Lifecycle (durable) | Presence (`connFor(name)`) | Renders as | Note |
|---|---|---|---|
| `live` | connected | **running** | the normal case |
| `live` | connected, open `approval_request` | **blocked** | derived, not stored (§11.5); the row a human acts on |
| `live` | connected, idle past threshold | **stalled?** | the relay-blind fallback (§11.6) |
| `live` | absent | **reconnecting** | broker bounced, or ≤8.85 s reconnect ladder (`broker-client.ts:17`) |
| `detached` | absent | **detached** | process gone, identity intact, resumable |
| `detached` | connected | — | impossible; log `agent_state_anomaly` and trust presence |
| `exited` | absent | **finished** | terminal unless resumed |
| `exited` | connected | — | a bug; the exit handler fired while a socket lives |
| `spawning` | absent | **starting** | between launch and first register |

The second row is the direct mitigation for service plan §8 item 4 — *"restart
empties the registry; `ps`/`chat_list`/`/api/sessions` all lie for ≤8.85 s."*
A durable agent cannot vanish from the roster during that window; it can only
change presence. **The agents view is therefore more truthful than the sessions
view**, which is a good reason to build it (§12.4).

---

## 3. Module layout

New code is confined to `src/agents/**` and `src/cli/agent.ts`. Everything
outside those is a small, enumerable edit (§3.1).

```
src/
  agents/
    types.ts            AgentProfile, SpawnRequest, AgentIdentity, LaunchPlan
    profiles.ts         builtin profiles + ~/.agent-chat/profiles/*.json loader
    identity.ts         AgentLog — the read model of §2.4
    launch-plan.ts      buildLaunchPlan() — the ONE argv builder (§5.2)
    supervisor.ts       spawn/resume/retire orchestration; owns the semaphore
    semaphore.ts        lifted verbatim from brain dispatch-loop.ts:57-77
    stream.ts           stream-json NDJSON parser -> derived progress (§9)
    isolation/
      index.ts          IsolationStrategy interface + strategy registry
      none.ts
      worktree.ts       lifted from brain worktree.ts, PM/delivery stripped
      file-ownership.ts lifted verbatim from brain (it is already pure)
      toolset.ts
    surfaces/
      index.ts          Surface interface + surface registry
      headless.ts       detached spawn, prompt on stdin, stream-json
      iterm.ts          pane | tab | window, via osascript
  cli/
    agent.ts            agent spawn | ls | attach | resume | kill | retire | logs
```

### 3.1 Edits outside `src/agents/**` — the complete list

| File | Edit | Size |
|---|---|---|
| `protocol.ts:26-36` | 9 new `EventKind`s | ~9 lines |
| `protocol.ts:71` | `register` gains optional `agentId` | 1 line |
| `protocol.ts:70-86` | new `ClientMessage`s: `spawn`, `agents`, `retire` | ~4 lines |
| `protocol.ts:89-111` | new `ServerMessage`s: `spawn_result`, `agents_result` | ~3 lines |
| `broker/core.ts` (service plan §4.2) | route the three new client messages to `Supervisor` | ~20 lines |
| `broker/core.ts` | append `agent_attached` / `agent_detached` on register/drop | ~10 lines |
| `server/index.ts:67-68` | env-driven auto-register before the model runs (§6.1) | ~12 lines |
| `server/tools.ts` | `chat_spawn`, `chat_agents`; seed `registeredName` (§6.2) | ~60 lines |
| `paths.ts` | `agentsDir()`, `agentDir(id)`, `profilesDir()` | ~4 lines |

No changes to `registry.ts`, `event-log.ts` (beyond the service plan's own
`since()` addition), `broker-client.ts`, or `log.ts`.

---

## 4. Agent profiles

A profile bundles the four things that always travel together, so a spawn is one
noun rather than six flags.

```ts
export interface AgentProfile {
  name: string
  description: string
  model: 'opus' | 'sonnet' | 'haiku' | string
  /**
   * Passed to --allowed-tools. THE permission lever (§11.1) — there is no
   * permissionMode field, by design. Declare the narrowest set that actually
   * completes the work: too wide is an authority leak, too narrow is an agent
   * that silently produces degraded output (§11.3).
   */
  allowedTools: string[]
  disallowedTools?: string[]
  isolation: IsolationName
  surface: SurfaceName
  /** Appended via --append-system-prompt, after the standard peer preamble. */
  promptPrelude: string
  /** Extra MCP servers merged into the generated --mcp-config. */
  mcpServers?: Record<string, unknown>
}
```

**There is deliberately no `permissionMode` field.** Not `bypassPermissions`,
and not a milder alias for it. A profile widens a posture by naming tools, which
is auditable and reviewable in a diff; a mode flag widens it by category, which
is neither. §11.1 gives the full argument.

**Every profile's `allowedTools` must include agent-chat's own MCP tools** —
`mcp__plugin_agent-chat_agent-chat__*`. This is not optional and it is easy to
miss: agent-chat's tools are themselves permission-gated, so a spawned agent
whose profile omits them can register (registration is not a tool call, §6.1) but
**cannot send a single message** — it appears as a healthy peer that never
answers. `docs/permission-relay.md:161-166` records this biting in practice: *"an
unapproved agent-chat session reports its own blockage."* `buildLaunchPlan()`
should append them unconditionally rather than trusting each profile to remember.

Builtins, shaped after brain's `buildDefaultAgents()` (`launch.ts:60-85`) but
carrying isolation and surface, which brain's cannot:

| Profile | model | tools | isolation | surface | why that surface |
|---|---|---|---|---|---|
| `explorer` | sonnet | Read, Grep, Glob | `toolset-limited` | headless | read-only; nothing it does can prompt |
| `reviewer` | sonnet | Read, Grep, Glob, Bash | `toolset-limited` | headless | Bash is narrow and allowlisted |
| `implementer` | opus | Read, Write, Edit, Bash, Grep, Glob | `worktree` | **iterm-pane** | writes; a prompt is answerable in the pane (§11.3) |
| `peer` | opus | Read, Write, Edit, Bash, Grep, Glob | `none` | **iterm-tab** | long-lived collaborator |

`peer` is the profile that expresses what this whole system is for: a long-lived
agent in a visible pane, sharing the checkout, addressable by name — the thing
Claude Code's spawn-tree topology cannot express.

**Writers default to a visible surface, and that is a permissions decision, not
an aesthetic one.** A visible agent that hits a prompt has a human-answerable
dialog sitting right there in its pane. A headless one does not, and — per
§11.2 — does not even produce a blocker row anyone could act on. The asymmetry
is severe enough that it should drive the default: **spawn writers visible unless
you have a reason not to.** §11.3.

**User profiles load from `~/.agent-chat/profiles/*.json` by name only.** A
spawn request names a profile; it never carries a profile body. That single rule
is what keeps `chat_spawn` from being "execute arbitrary argv" (§11.2). Profiles
are also the second copy of brain's two-layer definition idea (Claude Code
`--agents` objects and markdown templates with `{PLACEHOLDER}` substitution,
`brain/src/modules/agents/template-renderer.ts:12-24`). **Do not lift the
template engine for MVP** — `promptPrelude` plus the brief covers it, and brain's
renderer throws on unfilled placeholders, which is a footgun when the variable
source is a peer model rather than a PM database.

---

## 5. Spawning: one interface, surface as a parameter

brain has two divergent spawn paths that share no code: interactive
(`launch.ts:204-207`, `spawn(claude, args, {stdio:'inherit'})`) and headless
(`dispatch.ts:664-676`, `spawn(bin, args, {stdio:['pipe','pipe','pipe'],
detached:true})` with the prompt written to stdin at `:678-679`). Every flag that
exists in one and not the other is an accident of which path someone was editing.
That wart is worth not inheriting.

### 5.1 The split

```ts
export interface LaunchPlan {
  agentId: string
  bin: string
  args: string[]
  cwd: string
  env: Record<string, string>
  /** Headless only: the prompt goes on stdin, never in argv. */
  stdin?: string
  title: string
}

export interface LaunchHandle {
  surface: SurfaceName
  pid?: number        // headless only
  paneRef?: string    // iTerm session UUID, for `agent attach`
}

export interface Surface {
  readonly name: SurfaceName
  readonly interactive: boolean
  launch(plan: LaunchPlan): Promise<LaunchHandle>
}
```

`buildLaunchPlan()` is a **pure function** — profile + isolation allocation +
brief in, `LaunchPlan` out, no I/O. It is snapshot-tested against expected argv,
which is the cheapest possible guard against the two-paths drift.

### 5.2 What `buildLaunchPlan` produces

Common to every surface:

```
--model <profile.model>
--session-id <uuid>                      minted here; this is the resume handle
--append-system-prompt <peer preamble + profile.promptPrelude + brief>
--mcp-config <path to the generated config>
--allowed-tools <csv>                    profile tools + agent-chat's own (§4)
[--add-dir <path>]                       when isolation returns extra dirs
```

**No `--permission-mode` is ever emitted, on any surface.** Spawned agents run
under the environment's normal posture — the settings allowlists the user already
maintains. §11.1.

Surface-specific, and this is the *entire* difference:

| | headless | iterm-* |
|---|---|---|
| prompt | `-p` + `--output-format stream-json`, body on **stdin** | body is in `--append-system-prompt`; the pane starts interactive |
| stdio | `['pipe','pipe','pipe']`, `detached:true` | owned by the terminal |

Note what is *not* in that table any more: the permission posture used to be the
third row, and removing it is the point. Two spawn paths that differ only in how
the prompt is delivered are two paths that stay in sync.

`--mcp-config` is generated per agent, following brain's `writeMcpConfig`
(`dispatch.ts:590-605`) but written to `~/.agent-chat/agents/<id>/mcp.json`
rather than `tmpdir()`, so it survives for resume and for post-mortem. It always
contains agent-chat itself, resolved the same way the plugin shim resolves it
(`plugins/agent-chat/bin/agent-chat-launch.sh:33-49`), plus `profile.mcpServers`.

### 5.3 The launch file, and why it exists

**Never interpolate a brief into a shell command line.** Briefs are multi-line,
model-authored, and for iTerm would have to survive AppleScript's quoting *and*
the shell's. That is an injection surface and a debugging nightmare.

Instead the supervisor writes `~/.agent-chat/agents/<id>/plan.json` (mode `0600`,
dir `0700`) and every surface launches the same fixed command:

```
agent-chat run-agent <id>
```

`run-agent` reads `plan.json`, sets the title via OSC, `exec`s the binary with
the argv array — **no shell involved anywhere**. AppleScript then only ever
carries a fixed short string with an 8-char id in it, which sidesteps every
quoting problem the pane approach otherwise has. The same file is what makes
resume cheap: it is already on disk.

### 5.4 The iTerm surface, and the problem nobody expects

`iterm-panes.sh` bakes in two hard-won lessons and both must survive the port:

1. **Target the session by `ITERM_SESSION_ID`'s UUID** (`iterm-panes.sh:17`,
   `UUID="${ITERM_SESSION_ID#*:}"`), iterating windows/tabs/sessions to find it
   (`:44-55`). Never `current window` — it follows user focus and lands panes in
   whichever window happens to be frontmost when the AppleScript runs.
2. **`set name` does not stick** — iTerm overwrites it with the running job.
   Title with an OSC 0 escape instead (`iterm-panes.sh:35-38`). This moves into
   `run-agent`, where it is a `process.stdout.write`, not an escaped shell
   string.

**The problem:** the broker is spawned detached with `stdio:'ignore'`
(`broker-client.ts:90`) from whatever process happened to auto-start it. **It has
no `ITERM_SESSION_ID`.** The process that does the spawning is structurally not
the process that knows where to put the pane.

Resolution — and this is why the pane anchor is presence data, not identity data:

- The requesting session's MCP subprocess *does* inherit `ITERM_SESSION_ID` from
  Claude Code. It sends it on `register`, as a new optional field.
- The broker stores it on the `Registry` entry. **This is correct placement**: an
  anchor pane is a property of a live connection and is meaningless once that
  connection is gone. It is presence, it dies with the socket, nothing persists it.
- `{t:'spawn'}` carries the requester's connection, so the broker looks up the
  anchor from the registry entry — the requester cannot claim someone else's pane.
- **Fallbacks, in order:** no anchor → `iterm-window` (needs no anchor, uses
  `create window with default profile`); anchor recorded but the AppleScript
  search finds no matching session (pane was closed) → `iterm-window` with a
  logged `notice`; not macOS or iTerm2 not running → refuse with a reason naming
  `headless` as the alternative, and append `agent_spawn_refused`.

Assume macOS/iTerm2 for MVP, but the `Surface` interface is the seam: a
`tmux-pane` surface is a drop-in later, and nothing outside `surfaces/` knows
what a pane is. The word "iterm" must not appear in `supervisor.ts`.

### 5.5 The broker does the spawning, not the requester

The `{t:'spawn'}` request goes over the socket and the **broker** performs the
launch. Three reasons, all of them load-bearing:

1. **Persistence.** The broker outlives every session. An agent spawned by a
   session that then exits is not orphaned — that is the whole point of the
   feature, and it cannot be true if the requester holds the child.
2. **One write path.** `core.append()` is the single writer (service plan §4.2).
   A spawn appends 2-4 rows; doing that from an MCP subprocess would require a
   second writer to the same SQLite file.
3. **One budget.** The semaphore and the depth cap (§11.3) need exactly one
   enforcement point. Per-session enforcement is not enforcement.

---

## 6. How a spawned agent becomes a peer

This is the mechanism that dissolves the rigid-topology complaint, and it is
smaller than it sounds.

### 6.1 Auto-register from the environment, before the model does anything

`startMcpServer()` calls `broker.connect()` at `server/index.ts:68` and then
waits for the model to call `chat_register`. For a spawned agent that is both
unnecessary and unreliable — the name was already assigned at spawn time, and
depending on a model to comply with an instruction to claim it is a race that
will sometimes lose.

Instead: `buildLaunchPlan` puts `AGENT_CHAT_AGENT_ID` and `AGENT_CHAT_NAME` in
the child's env, and `startMcpServer()` reads them immediately after
`broker.connect()`:

```
if (process.env.AGENT_CHAT_AGENT_ID && process.env.AGENT_CHAT_NAME) {
  await broker.request({ t:'register', name, workingOn, cwd, pid, agentId }, 'register_result')
}
```

The broker's `register` handler (`broker/index.ts:169-175`, becoming
`core.register`) sees `agentId`, and:

- resolves it against `AgentLog.get(agentId)`;
- verifies `identity.name === msg.name` — a mismatch is refused and logged, so a
  session cannot borrow another agent's identity by guessing an id;
- appends `agent_attached` with `ref = agentId`;
- stores `agentId` on the `Registry` entry so `drop` (`broker/index.ts:220-231`)
  can append `agent_detached`.

Registration now happens before the model's first turn. The agent is in
`chat_list` output the instant its MCP server is up.

### 6.2 Seed `registeredName` in the tool handler — a real bug otherwise

`ToolHandler.registeredName` starts `null` (`tools.ts:167`) and `chat_send`
refuses while it is null: *"Call chat_register before sending, so the recipient
knows who you are"* (`tools.ts:234-235`). With env auto-registration the broker
knows the agent's name but the tool handler does not, so **a spawned agent would
be unable to send a single message** while appearing perfectly registered to
everyone else. Seed it from `AGENT_CHAT_NAME` in the `ToolHandler` constructor.

And make `chat_register` idempotent for a seeded handler: re-registering the same
name is a no-op success; registering a *different* name returns
`You are already registered as "<name>" (spawned agent); that name is fixed for
this session.` A spawned agent renaming itself would strand every peer that was
told to talk to it.

### 6.3 The name takeover rule for resume

`Registry.register` refuses a name held by another live connection
(`registry.ts:98-100`). On resume this bites: if the resumed process registers
before the dead process's `close` handler has fired, the resume fails with
*"name held by another session"* and the failure looks like a bug in resume
rather than a race.

**Rule:** when the incoming `register` carries an `agentId` that matches the
`agentId` on the entry currently holding that name, it is a **takeover**, not a
collision — drop the stale connection (appending `agent_detached` for it) and
accept the new one. Without a matching `agentId`, the existing refusal stands
unchanged. This is a five-line addition to the register path and it is the only
change the presence layer needs.

### 6.4 The human stays first-class

Nothing here demotes the human. The human already spawns from the CLI without
being a session, appears as `actor: 'human'` on `agent_spawned`, and shows in
`agent ls` as the parent of top-level agents. Two additions make it concrete:

- `agent-chat agent attach <name>` on a visible agent runs AppleScript `select`
  against the recorded `paneRef` — bringing the agent's pane to the front. That
  is the human joining an agent's context on the human's terms, which no
  spawn-tree topology offers.
- `agent-chat send <name> "..."` already works, unchanged, because the agent is
  an ordinary peer (`cli.ts:124-136`).

---

## 7. Pluggable isolation

### 7.1 The interface

```ts
export type IsolationName = 'none' | 'worktree' | 'file-ownership' | 'toolset-limited'

export interface IsolationContext {
  agentId: string
  agentName: string
  baseCwd: string
  /** For file-ownership: the paths this agent declares it will modify. */
  declaredPaths?: string[]
}

export interface Allocation {
  cwd: string
  env?: Record<string, string>
  addDirs?: string[]
  allowedTools?: string[]
  disallowedTools?: string[]
  /** One line for the agent's brief: "you own src/cli/**; everything else is read-only". */
  note?: string
  /** Strategy-specific handle — branch, worktree path, claim id. Goes in meta. */
  ref?: Record<string, string>
}

export interface IsolationStrategy {
  readonly name: IsolationName
  /** Pre-flight. Empty array = safe to proceed. Non-empty = reasons, shown to the requester. */
  check(ctx: IsolationContext): Promise<string[]>
  allocate(ctx: IsolationContext): Promise<Allocation>
  /** Returns false when it refused (dirty/unpushed) rather than failed. */
  release(ctx: IsolationContext, alloc: Allocation, opts?: { force?: boolean }): Promise<boolean>
}
```

`check` is separate from `allocate` on purpose: it lets `chat_spawn` answer
*"this would collide with alice"* without side effects, and it is what makes
`file-ownership` useful as advice rather than only as enforcement.

### 7.2 The four strategies

**`none`** — `allocate` returns `{ cwd: baseCwd }`. `check` returns a *warning*
line (not a refusal) naming any live agent already running in the same cwd.
`release` is a no-op returning true. This is the correct default for `peer`
agents: shared checkout, humans and agents in the same tree, coordination by
conversation. Twenty lines.

**`worktree`** — lift `brain/src/modules/agents/worktree.ts`. What to keep and
what to cut:

*Keep:* `findGitRoot()` via `--git-common-dir` (`worktree.ts:89-100`) — this is
the fix for nested worktrees when allocating from inside one, and it is not
obvious. `inspectWorktreeForRelease()` (`:184-234`) and the dirty/unpushed
refusal in `releaseWorktree` (`:259-268`) — this is the guard that stops an
agent's uncommitted work being destroyed by a reclaim, and the comment explains
which two incidents produced it. `cleanupStaleAllocations` (`:378-391`). The
budget concept (`DEFAULT_BUDGET = 3`, `:81`). Copying `.claude/` into the
worktree (`:153-158`) so hooks fire.

*Cut:* everything keyed to brain's PM and GitHub domain — the `workstream`
requirement and its hard throw (`:113-118`), `getDeliveryForTask` /
`ACTIVE_DELIVERY_STATUSES` (`:37-45`, `:336-339`), `cleanupOrphanRemoteBranches`
(`:461-487`) and its `gh` calls, `requireWorktreeIsolation` (`:494-507`).

*Re-anchor:* allocation is keyed by **agent id**, not task id. The branch is
`agent-chat/<name>` rather than `agent/<workstream>/<taskId>`. And the 120 s
`RECLAIM_GRACE_MS` (`:59`) survives — but its justification changes: in brain it
guards a racing push/PR; here it guards the window between `agent_exited` and a
human noticing there is unpushed work. Anchor it on the `agent_exited` row's
timestamp. **The grace window and the release refusal are the two things most
likely to be dropped as "brain-specific" during the lift. They are not.**

*Re-home:* allocations are `isolation_allocated` events, not a
`worktree_allocations` table (`brain/src/modules/agents/schema.ts:30-38`). Live
allocations = allocated rows whose agent has no matching `isolation_released`.
Same rule as §1.2.

**`file-ownership`** — lift `brain/src/modules/agents/file-ownership.ts`
**verbatim**. It is the cleanest thing in either repo for this purpose: 170 lines,
zero imports, entirely pure — `matchPattern` (`:25-56`), `checkConflicts`
(`:75-97`), `getOwners` (`:116-127`), `formatOwnershipBrief` (`:154-170`). It
drops in with no adaptation at all.

What agent-chat adds that brain cannot: in brain the manifest is a static object
assembled at dispatch time. Here, **a claim is a lease held by presence**. The
strategy's `check()` builds the manifest from the claims of currently-*connected*
agents (roster ∩ registry), so a claim by a dead agent stops blocking the moment
its socket closes — no stale locks, no reaper. That is `docs/ideas.md` I6
realised through a different door, and it is the reason `file-ownership` belongs
in agent-chat rather than staying in brain.

`allocate` returns `cwd: baseCwd` plus a `note` from `formatOwnershipBrief`, so
the constraint reaches the model as prose in its brief. Policy: **warn by
default, refuse when `--strict`**. Refusing by default would break the common
case of two agents both touching `package.json`.

**`toolset-limited`** — `allocate` returns `{ cwd: baseCwd, allowedTools,
disallowedTools }` from the profile. Fifteen lines. Be honest about it in the
docs: this restricts *what an agent can do*, not *where it collides*. A read-only
explorer cannot conflict with anyone, which is a real and useful form of
isolation, but it is not a substitute for `worktree` for a writer.

### 7.3 Composition

`toolset-limited` is really a decorator over any of the others. The interface
supports this — allocations merge, with `allowedTools` intersecting and `cwd`
taken from the last non-`none` strategy. **For MVP, ship single-strategy
selection** (a profile names one), but implement `resolve(names: IsolationName[])`
in `isolation/index.ts` from the start so `['toolset-limited','worktree']` is a
config change later, not a refactor. Say this in the code comment; a future
contributor will otherwise hardcode the single-strategy assumption into the
supervisor.

---

## 8. Lifecycle

```
spawn request
  -> authority + budget + depth checks (§11)         refuse -> agent_spawn_refused
  -> profile load                                    refuse -> agent_spawn_refused
  -> isolation.check()                               refuse (or warn) -> agent_spawn_refused
  -> semaphore.acquire()
  -> isolation.allocate()                            -> isolation_allocated
  -> buildLaunchPlan() -> write plan.json + mcp.json
  -> append agent_spawned  (the identity now exists, before any process does)
  -> surface.launch()
  -> [child registers via env]                       -> agent_attached   -> lifecycle: live
  ...
  -> [may block on a permission prompt at any time]  -> approval_request -> derived: blocked
  -> [human verdict, or answered in its own pane]    -> resolution       -> derived: live again
  ...
  -> socket drops                                    -> agent_detached
  -> process exits (headless: exit handler;
                    visible: no signal — see below)  -> agent_exited
  -> semaphore.release()
  -> retire (explicit, or on `agent retire`)         -> isolation_released, agent_retired
```

**`agent_spawned` is appended before the launch, not after.** If the launch then
fails, the identity exists in a `spawning` state with a failure appended — which
is what you want when debugging why a pane never opened. The reverse order loses
failed spawns entirely.

### 8.1 Exit detection differs by surface, and presence papers over it

Headless gets a real `proc.on('exit')` (brain's shape at `dispatch.ts:705-708`)
carrying an exit code and, from stream-json, a summary and cost.

**Visible surfaces get nothing.** The broker does not own the iTerm pane's
process; when the human types `/exit`, no callback fires anywhere in agent-chat.

This is exactly where presence saves the design: the MCP subprocess exits when
Claude Code closes the pipe (`server/index.ts:93-96`), the socket drops, and
`agent_detached` is appended. For a visible agent, **`agent_detached` with no
subsequent reattach is the exit signal**, and `agent_exited` is synthesised after
a short settle window (~30 s) that distinguishes a real exit from the reconnect
ladder (`broker-client.ts:17`, worst case 8.85 s). No exit code, no cost — say so
in the roster rather than showing zeros. That asymmetry is inherent to visible
spawning, not a defect in this design.

### 8.2 Resume

`--session-id <uuid>` is minted at spawn and recorded in
`agent_spawned.meta.session_id` (brain does the same, `dispatch.ts:647-648`).
Resume rebuilds the launch plan with `--resume <that uuid>` in place of
`--session-id`, reuses the agent id and name, and appends `agent_resumed`.
Isolation is *not* reallocated — the existing `isolation_allocated` handle is
reused, so a resumed worktree agent lands back in its own worktree with its
branch intact.

**Be honest about the limit:** the conversation transcript that `--resume`
restores lives in Claude Code's own state (`~/.claude/projects/…`), not in
agent-chat. If it has been cleaned up, resume yields identity, brief, and
isolation — but not memory. Durable identity is not durable *context*, and the
CLI should say which one it is giving you.

### 8.3 Kill and retire, kept distinct

- `agent kill <name>` — end the process. Headless: SIGTERM to the recorded pid,
  SIGKILL after 3 s. Visible: **refuse**, and print *"<name> is running in an
  iTerm pane; exit it there, or `agent-chat agent attach <name>` to go to it."*
  Killing a pane the human is looking at, from a bus a peer model can reach, is
  not a thing to build.
- `agent retire <name>` — close the identity: release isolation (which may
  refuse on dirty/unpushed, §7.2), append `agent_retired`, free the name. Retire
  is the only thing that frees a name, so a detached agent's name stays reserved
  and its peers' remembered addressing stays valid.

### 8.4 Budgets must not reap a blocked agent

Since permissions are no longer bypassed (§11.1), an agent sitting still for an
hour is a normal, recoverable state. Three rules follow, and the first is the one
that will otherwise be got wrong:

1. **Never auto-fail on wall clock.** A blocked agent has done nothing wrong; it
   is waiting on a human. Reaping it as `failed` destroys its work, releases its
   worktree, and — worst of all — makes the blocker disappear from the view whose
   entire job is to show it. If a wall-clock cap is ever added, blocked time is
   excluded from it, and the cap **escalates to the human** (a `notice`, which
   `humanQueue()` already carries) rather than killing anything.
2. **Cost budgets are safe; wall-clock budgets are not.** brain passes
   `--max-budget-usd` (`dispatch.ts:655-656`) and that lift is fine as-is: a
   blocked agent burns no tokens, so a cost cap cannot fire while it waits. This
   is the honest reason to prefer a spend cap over a time cap, and it is worth
   writing down because "add a timeout" is the reflex.
3. **A blocked agent keeps its semaphore slot.** It still owns its worktree and
   is resumable in place, so releasing the slot would let a second agent allocate
   over the top of it. The cost is real — blocked agents starve the concurrency
   budget — and the mitigation is visibility, not eviction: `agent ls` prints
   `3/3 slots (1 blocked)` so *"why can't I spawn"* has an answer on screen, and
   the blockers view (§11.5) is one command away.

---

## 9. `--output-format stream-json`: what it buys, what it costs

brain parses a single final `JSON.parse` of `--output-format json`
(`dispatch.ts:718-724`). Consequences visible in its own code: on a crash there
is no output at all (`catch { /* non-JSON output */ }` at `:723`) and progress is
invisible for the entire run. brain's `stall-detector.ts` is not a fallback for
this and is **not a lift candidate** — it detects stalls by shelling out to
`git log --grep <taskId>` (`:60-72`) against PM task rows, which is brain's
domain model, not a process signal.

**Buys:** incremental visibility — tool-use boundaries, assistant text, and cost
as they happen, so the dashboard can show a headless agent working rather than a
row that sits still for twenty minutes; early failure detection; and — the
reason this got more important under the new permissions posture — **it is the
only way to see a headless agent's permission denials** (§11.2), which arrive as
ordinary `tool_result` frames carrying *"Claude requested permissions to use
Bash, but you haven't granted it yet"* and are otherwise completely silent.

**Costs:** an incremental NDJSON parser with partial-line buffering (the existing
`lineReader` at `protocol.ts:119-135` is exactly this and can be reused —
genuinely free); coupling to a stream schema that is less stable than the final
result object; and volume — a 20-minute agent emits thousands of frames, and one
event row per frame would swamp a log whose other users produce tens of rows a day.

**Recommendation — adopt it, with two rules:**

1. **Raw frames go to a file, never to the event log.**
   `~/.agent-chat/agents/<id>/stream.jsonl`. It is telemetry, not bus truth, and
   assumption 2 is about the bus. `agent logs <name>` tails it.
2. **Only derived rows are appended:** one `agent_exited` at the end (with
   summary, cost, duration), at most one progress row per ~60 s carrying a
   one-line "currently: <tool>" — throttled in the parser, not the log — and one
   `notice` per *distinct* denied tool (§11.2), deduplicated, because the same
   denial repeating forty times is one fact.

**Lifecycle correctness must not depend on it.** Visible agents produce no
stream, so anything that derives `live` / `detached` / `exited` from frames
re-splits behaviour by surface — the exact wart §5 exists to avoid. Liveness is
presence, which works for both.

**Denial visibility, however, does depend on it, and only for headless.** That
is a degradation rather than a correctness dependency, and it is worth stating
precisely because the two are easy to conflate: without the stream, a headless
agent's denials are invisible and it appears to be working normally right up
until it delivers something wrong. That asymmetry is the strongest argument in
this document for spawning writers visible (§4, §11.3), and the second-strongest
for adopting stream-json at all.

brain's `parseCompletionMessage` (`completion-protocol.ts:28-50`, the
`DONE <id> <summary>` / `FAILED <id> <reason>` parser) is a clean 20-line lift
for extracting a final summary, and works on either output format. Take the
parser; leave `handleCompletion` (`:55-76`), which is entirely PM task-status
wiring.

---

## 10. Surface: tools, CLI, and wire messages

### 10.1 Wire protocol additions

```ts
// Session -> broker
| { t: 'spawn'; name: string; profile: string; brief: string;
    cwd?: string; isolation?: IsolationName; surface?: SurfaceName }
| { t: 'agents'; includeRetired?: boolean }
| { t: 'retire'; name: string }
// register gains:  agentId?: string;  termSessionId?: string

// Broker -> session
| { t: 'spawn_result'; ok: boolean; agentId?: string; name?: string; reason?: string;
    warnings?: string[] }
| { t: 'agents_result'; agents: AgentIdentity[] }
```

`warnings` is how `isolation.check()`'s non-fatal output reaches the requesting
model — "you are sharing a checkout with bob" is information it should have.

### 10.2 MCP tools

- **`chat_spawn`** — `{name, profile, brief, cwd?}`. Note the omissions: no
  `model`, no `tools`, no `permission_mode`, no `isolation` override. Those come
  from the named profile, and a peer model does not get to raise them (§11.2).
  The description must state the budget and that spawned agents are ordinary
  peers reachable with `chat_send`.
- **`chat_agents`** — the roster with presence, so a model can find a detached
  agent it spawned an hour ago. This is the tool that makes the topology feel
  flat: agents discover each other through a list, not through a parent handle.

Both are gated (§11) and both refuse clearly rather than failing.

### 10.3 CLI

```
agent-chat agent spawn <name> --profile <p> [--cwd] [--surface] [--isolation] [--brief|-]
agent-chat agent ls [--all]        roster: lifecycle x presence (§2.5)
agent-chat agent attach <name>     select the iTerm pane, or print how to reach it
agent-chat agent resume <name>     new process, same identity
agent-chat agent kill <name>       headless only
agent-chat agent retire <name>     release isolation, free the name
agent-chat agent logs <name> [-n]  tail stream.jsonl
agent-chat run-agent <id>          internal; the fixed launch command of §5.3
```

`run-agent` is a process-launch contract the moment the first `plan.json` is
written — it must be treated the same way `broker` and `mcp` are (service plan
§4.3): never renamed without changing the plan writer in the same commit.

---

## 11. Security posture — state this explicitly in the PR

### 11.1 `bypassPermissions`

brain spawns headless agents with `--permission-mode bypassPermissions`
(`dispatch.ts:645-646`). **agent-chat must not default to that**, and the reason
is specific to this repo rather than general caution.

agent-chat has already drawn this line once. It declares
`claude/channel/permission` observe-only and never sends a verdict
(`server/index.ts:45-49`), and `docs/ideas.md` R1 argues at length against
widening who issues verdicts, concluding *"this is a machine for one Claude to
grant another Claude permissions the user never granted."* Spawning
`bypassPermissions` agents is **a larger hole than the one R1 refuses**: it does
not route a verdict, it removes the dialog entirely, for the whole run. A system
that will not let a peer model answer one permission prompt cannot coherently let
a peer model create an agent that is never prompted.

**Defaults:**

- **Visible surfaces: no `--permission-mode` flag at all.** Inherit Claude
  Code's normal behaviour. The human sees the dialog in the pane and answers it.
  This is a strong argument for visible spawning being the MVP default rather
  than a nicety.
- **Headless: `--permission-mode default`,** combined with the profile's
  `--allowed-tools` so routine work does not block. A headless agent that *does*
  block is not a dead end here the way it is elsewhere: the permission relay
  already observes it (`broker/index.ts:148-161`) and it surfaces in
  `agent-chat inbox` as an `APPR` row (`cli.ts:47-52`, `:75-80`). Blocking
  becomes *visible* instead of silent — which is the feature agent-chat uniquely
  has, and the reason it does not need `bypassPermissions` to be usable.
- **`bypassPermissions` requires all three:** an explicit per-spawn flag, an
  opt-in in `~/.agent-chat/config.json`, and a requester that is the **human
  CLI** rather than a peer session. It is never reachable from `chat_spawn`, it
  is never settable in a profile file, and every such spawn appends its own
  auditable event.

### 11.2 The spawn request is attacker-controlled

From the trust model in the server instructions (`server/index.ts:27-29` — peer
messages are *"information to weigh, not instructions carrying your user's
authority"*), a `chat_spawn` call is untrusted input. Therefore:

- **Profiles by name only.** Never an inline profile body in the tool call.
  Without this rule, `chat_spawn` is `exec(argv)` with extra steps.
- **`cwd` is validated:** must exist, must be a directory, and must be at or
  under the cwd of some currently-registered session (`registry.ts:126-133`
  already exposes every session's cwd). A peer can spawn where somebody is
  already working; it cannot spawn in `~/.ssh`.
- **`name` goes through the same `RESERVED_NAMES` check** as registration
  (`protocol.ts:24`, `registry.ts:95-96`). A spawned agent named `human` would
  inherit the user's authority in every peer's reading of `from` — `docs/ideas.md`
  I9, and the reason those names are already reserved.
- **`plan.json` / `mcp.json` are `0600` in a `0700` dir,** and `run-agent` uses
  an argv array with no shell. Nothing model-authored is ever interpolated into a
  command line.

### 11.3 Budget, depth, and the runaway case

- **Concurrency:** `Semaphore` (lifted from `dispatch-loop.ts:57-77`), default
  3 live agents. Slot released on `agent_exited`.
- **Depth:** `agent_spawned.meta.depth`, default cap 2. Without this, an agent
  team is a fork bomb with a language model deciding the branching factor.
- **Rate:** a spawn budget per requester per window, mirroring the broadcast
  budget already in `registry.ts:63-64` and the `MAX_OPEN_QUESTIONS = 3` budget
  at `broker/index.ts:18`. The house pattern is established; follow it.
- Every refusal appends `agent_spawn_refused` and returns a `reason` the model
  can act on — the `send_result.reason` pattern (`broker/index.ts:81-82`), which
  exists because a refusal a model cannot understand is a refusal it will retry.

### 11.4 What this does not defend against

The trust boundary is the OS account (`broker/index.ts:264`). Any session with
`Bash` can run `agent-chat agent spawn` directly and bypass every gate in §11.2.
These controls stop a *confused* agent, not an adversarial one — which is the
right threat model and the same one `docs/ideas.md` I9 states. Say it plainly in
the PR rather than implying more.

---

## 12. Relationship to the service/HTTP/dashboard plan

### 12.1 Hard dependency: service plan Step 1

`BrokerCore` must land first. Everything here appends events, and today `events`
is a module-level `let` assigned only inside `startBroker()`
(`broker/index.ts:21`, `:259`) — the exact hazard service plan §8 item 1
describes. Building the supervisor against that would either add a second writer
or force `BrokerCore` to be extracted mid-feature. **Do not start Step A1 before
service Step 1 is merged.**

Soft dependency on **Step 2a** (the frozen `types.ts`) if the dashboard gets an
agents view, and on **Steps 4-5** for that view to render.

### 12.2 One coordination item worth doing early

Service plan Step 2a freezes `src/dashboard/types.ts` and enumerates the
`EventKind` union in the SSE frame contract (§6.1). Adding nine agent kinds later
**unfreezes it and re-serialises all three fan-out agents** (§9, "Parallelisation
and file ownership").

**Land the `EventKind` additions in Step 2a itself**, before the fan-out, even
though no agent code exists yet. Nine string literals in `protocol.ts` and the
matching entry in the SSE contract. This is the single highest-value piece of
coordination between the two plans and it costs ten minutes.

Same rule for `paths.ts`: service plan Step 2 is the "edit once before fan-out"
moment. Add `agentsDir()`, `agentDir(id)`, `profilesDir()` there.

### 12.3 Conflicts, and the one that is not a conflict

- **`src/cli/**` — real conflict.** Service Step 3 gives agent A exclusive
  ownership of the CLI restructure. `src/cli/agent.ts` is a new command group in
  that tree. Sequence it *after* Step 3; do not run them concurrently.
- **`broker/core.ts` — real conflict.** The supervisor wiring edits the same file
  Step 1 creates and Step 6 edits. Serialise.
- **§4.5 "do not persist the registry" — not a conflict.** This plan does not
  persist the registry; it persists *identity*, which is a different thing, and
  the registry stays exactly as ephemeral as it is today (§1). Add one
  cross-reference sentence to service plan §4.5 so a later reader does not read
  the agents work as a reversal of a decision that was correct.
- **§7.5 "no MCP-over-HTTP" — unaffected and reinforced.** Spawned agents get
  their own stdio MCP subprocess, which is what makes them individually
  addressable. Nothing here pushes toward a shared HTTP MCP server; if anything
  it raises the cost of ever doing so.

### 12.4 Should the dashboard grow an agents view? Yes.

And with a specific justification beyond "it would be nice":

The sessions view is known to lie for up to 8.85 s after a broker restart
(service plan §8 item 4). The agents view **structurally cannot** — identity is
durable, so an agent shows as *"live / reconnecting"* rather than disappearing
(§2.5, row 2). It is the more truthful of the two views and it directly mitigates
a wart the service plan can otherwise only paper over with a caveat banner.

- `GET /api/agents` → `AgentLog.roster()` joined with `Registry.list()`.
- `Agents.tsx`: lifecycle, presence, profile, isolation handle, parent, brief,
  age. Rows retire out of the list on `agent_retired` over SSE.
- **Read-only.** No spawn button, no kill button. That matches §5's deliberately
  narrow interactive surface (answer and dismiss only), and spawning from a
  browser reopens the authority question of §11.2 in a context with no session
  identity to attribute it to. Revisit later, separately, or not at all.

---

## 13. Sequencing

Each step ends with `npm test` green and a repo that still works. Preconditions
are per-step.

**A0 — EventKinds + protocol variants.** *Precondition: none; do it inside
service Step 2a.* Nine kinds, three client messages, two server messages, two
optional `register` fields. No behaviour. §12.2.

**A1 — Identity read model.** *Precondition: service Step 1 (BrokerCore).*
`AgentLog` (§2.4), the lifecycle fold, `nameIsClaimed`. Pure queries and a pure
fold — tested against synthetic rows with no process and no database file.
*Acceptance: fold tests cover every transition in §2.4 plus both anomalies in §2.5.*

**A2 — Presence bridge. The key step, and it comes before spawning.**
*Precondition: A1.* `agentId` on register, env auto-registration in
`server/index.ts` (§6.1), seeded `registeredName` in `ToolHandler` (§6.2), the
takeover rule (§6.3), `agent_attached` / `agent_detached` in the register and
drop paths.

*Acceptance, and this is the whole point of the ordering:* set
`AGENT_CHAT_AGENT_ID` and `AGENT_CHAT_NAME` by hand, launch `claude` yourself,
and watch it appear in `agent-chat agent ls` as a durable peer that another
session can `chat_send` to. **The hard part — a spawned process becoming a
first-class peer — is fully working and tested before one line of spawning code
exists.** If A2 does not work, no amount of spawn machinery will help.

**A3 — Profiles + launch plan.** *Precondition: A2.* `AgentProfile`, the four
builtins, the `~/.agent-chat/profiles/` loader, `buildLaunchPlan()` as a pure
function, `plan.json` / `mcp.json` writing, and `agent-chat run-agent`.
*Acceptance: snapshot tests on argv for every surface × profile combination.*
Still nothing spawned.

**A4 — Surfaces.** *Precondition: A3.* `headless` first (easiest to assert on),
then `iterm-pane` / `iterm-tab` / `iterm-window` with the anchor plumbing and the
fallback ladder (§5.4). Exposed only as `agent-chat agent spawn` — human-driven.
No MCP tool yet, so §11's authority question does not exist yet.

**A5 — Isolation.** *Precondition: A4.* `none` and `toolset-limited` (trivial),
then `worktree` (the lift, §7.2 — the largest single chunk), then
`file-ownership` (verbatim lift + the presence-lease `check`).

**A6 — Lifecycle.** *Precondition: A5.* Exit handling for both surface classes
including the settle window (§8.1), `agent_exited`, isolation release with the
refusal path, the semaphore, resume (§8.2), kill and retire (§8.3).

**A7 — MCP tool surface + security gates.** *Precondition: A6.* `chat_spawn`,
`chat_agents`, and the whole of §11.2/§11.3. **Deliberately last:** every step
before it is human-triggered from a CLI the human already trusts, so the peer
authority question arrives exactly once, in one reviewable diff, instead of being
smeared across six steps.

**A8 — stream-json enrichment.** *Precondition: A6.* Headless only, `stream.jsonl`
to disk, throttled derived rows, `agent logs`. §9.

**A9 — Dashboard agents view.** *Precondition: A7 + service Steps 4 and 5.*
`GET /api/agents`, `Agents.tsx`, read-only. §12.4.

**A10 — Docs.** README agents section; a `docs/agent-teams.md` recording the
presence/identity split (§1) and the security posture (§11) — both are decisions
a future reader will otherwise try to "fix".

### Parallelisation

A0-A3 are serial and touch shared files. After A3, two tracks can run
concurrently on distinct ownership:

| Track | Owns exclusively | Must not touch |
|---|---|---|
| **S — surfaces** (A4, A8) | `src/agents/surfaces/**`, `src/agents/stream.ts` | `src/agents/isolation/**` |
| **I — isolation** (A5) | `src/agents/isolation/**` | `src/agents/surfaces/**` |

`supervisor.ts` and `types.ts` are shared: edited in A3, then A6 by one owner.
A6, A7, A9 are serial.

---

## 14. Risks

**1. The broker has no `ITERM_SESSION_ID`.** Visible spawning depends on
environment owned by the requester, not by the process that does the spawning
(§5.4). Mitigated by carrying the anchor as presence data on the registry entry,
with a window fallback. Residual: the anchor pane can close between request and
launch — hence the fallback rather than a failure. **This is the risk most likely
to be discovered late**, because it works perfectly when developed from a
foreground broker and fails the first time the broker auto-starts detached.

**2. Name-lease vs. durable-identity collision on resume.** `registry.ts:98-100`
refuses a held name, and a resumed process routinely races the dead one's `close`
handler. Without the takeover rule (§6.3) resume fails intermittently, with an
error message that points at the wrong subsystem. Small fix, easy to omit,
expensive to diagnose.

**3. Spawn authority.** `chat_spawn` lets a peer model create processes.
Mitigated by profiles-by-name-only, cwd validation, reserved names, depth and
concurrency caps, and `bypassPermissions` being human-CLI-only (§11). Residual
and unavoidable: any session with `Bash` bypasses all of it. The controls are
against confusion, not adversaries (§11.4).

**4. The worktree lift drags brain's domain in.** `worktree.ts` imports
`getDeliveryForTask` and reasons about PR states (`:37-45`, `:336-339`). A
mechanical copy pulls in the delivery layer this plan explicitly excludes; an
over-aggressive strip removes the dirty/unpushed release refusal and the reclaim
grace window, which are the two things protecting an agent's uncommitted work
(§7.2). Both failure directions are plausible. Review that file's diff line by
line.

**5. Identity-in-the-log has no `UNIQUE` constraint.** Name uniqueness is a code
invariant (§2.4) rather than a schema one. A bug in `nameIsClaimed` produces two
live identities with one name, and the registry will happily hold one of them
while the roster shows both. Cheap guard: assert the invariant in `roster()` and
append an anomaly event rather than throwing.

**6. Resume restores identity, not memory.** The transcript lives in Claude
Code's state, not agent-chat's (§8.2). A user who reads "resumable" as "picks up
where it left off" will be disappointed the first time `~/.claude/projects` has
been cleaned. Wording problem, not an engineering one — but it will be the first
complaint if the CLI does not say which one it is giving you.

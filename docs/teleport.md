# teleport — a session that hands off to its own successor

**Status:** IMPLEMENTED 2026-07-29 on branch `feat/teleport-identity`. The
design below is what was built; **§14 records the five things the
implementation had to decide that this document did not**, and is the part to
read first if code and prose ever disagree. **Written:**
2026-07-28, branch `feat/plugin-packaging`. **Tracked as:** CC-20. **Revised**
the same day, once the five open decisions below closed — see §12. The
revision is a simplification, not a reversal: §4-§6 and §12 changed
substantially; §5's pinned properties, §7, §9's core hazard, §11 and §13
survive with light edits, noted where they occur.

Every claim about current behaviour below was checked against source in this
repo — `src/agents/{identity,supervisor,launch-plan,launch-files,profiles,semaphore}.ts`,
`src/broker/{core,registry,event-log,subscriptions,socket}.ts`, `src/protocol.ts`,
`src/api-contract.ts`, `src/server/index.ts`, `src/agents/isolation/*`, and
`src/__tests__/{agent-takeover,api-contract}.test.ts`. Where a claim comes from
somewhere else — Claude Code's own internals, or `docs/agent-teams.md` — it says
so, because that document has repeatedly described defences that were never
implemented and its prose is intent, not fact.

---

## 1. Why this exists

**Instructions and loaded code are fixed at launch.** The MCP server reads
`INSTRUCTIONS` (`src/server/index.ts`) once, when the `Server` is constructed,
and passes it to Claude Code in the initialize response. `dist/` is loaded once,
at process start. Nothing re-reads either while the process lives.

The failure this produces is not hypothetical. Three sessions found a security
gap, wrote the fix, committed it, and could not run it: their own instructions
had been read at launch, the broker and their MCP subprocesses were still
executing the old build, and the only ways to pick up their own work were

- **exit and start fresh** — lose everything the sessions knew, which is the
  expensive half of what they were; or
- **keep running stale** — stay useful and stay wrong.

Teleport is the third option: a session ends itself deliberately, on its own
terms, after writing down what it knew and starting a successor that boots from
the current build.

## 2. What teleport is not

- **Not `--resume`.** `Supervisor.resume()` rewrites `--session-id` to
  `--resume` in the stored launch plan and relaunches. That deliberately
  restores the transcript — a full, old context window — which is the opposite
  of what teleport wants. A resumed agent also replays a plan written at its
  original spawn: same argv, same `mcp.json`, same everything. Resume is for
  continuity after a crash. Teleport is for renewal.
- **Not the active-work session record.** That is a workspace artefact written
  for a human reader across initiatives. A handoff is written by the session
  itself, for one specific successor, about one specific mid-flight state.
- **Not a summary someone else produced.** No peer, no supervisor and no
  template knows what the session was three tool calls into. Only it does.
- **Not spawning a subagent.** The descendant is a peer with its own durable
  identity. It outlives the predecessor by construction — that is the point.

## 3. The hinge it stands on

`docs/agent-teams.md` Part 1 states the split and the code implements it:

- **Presence is ephemeral.** `Registry` holds it in a `Map<Conn, Entry>` and
  never persists it. `BrokerCore.drop` deletes the entry when the socket closes.
  This is what buys no heartbeats and no stale-entry reaper.
- **Identity is durable.** `AgentLog` folds it out of the event log every time
  it is asked (`foldAgent`), holding no state of its own.
- **Resuming is a new process attaching to an existing identity**, not a new
  registration — carried by `agentId` on the `register` frame.

Teleport is that same move with the handoff made explicit and self-authored. It
must be built on this substrate rather than beside it: a standalone teleport
would need to remember which session succeeded which, and that is a parallel
store of session identity, which the event-log-as-single-source-of-truth
constraint forbids. **"Descends from" is an event.**

Specifically, it is `meta.teleport_from` on the descendant's `agent_spawned`
row, written by the broker from the requesting connection. That matters for §6.

---

## 4. The sequence

> **Superseded design note.** The first pass of this document gave teleport
> three tools and a deliberate overlap window: the descendant would boot while
> the predecessor was still alive, question it over the bus, and a separate
> `teleport_shutdown_predecessor` call would later close the loop. §13 of that
> draft named the no-overlap version as the fallback "if the first three
> teleports never once use the overlap." The human chose the fallback up
> front, without waiting to observe it: the overlap's whole value was a
> live predecessor to interrogate, and every mechanism it required — a second
> registry name, a broker-only rename door, an extra semaphore slot, a
> shutdown tool whose entire design problem was "make sure it can't target the
> wrong agent" — existed only to make that overlap survivable. Delete the
> overlap and all four things it required go with it. What is below is v0, not
> a placeholder for it.

One wire message, and what happens after it is mostly not the model's to
drive:

```ts
// src/protocol.ts — ClientMessage addition
| { t: 'teleport'; handoff: string }
```

```ts
| { t: 'teleport_result'; ok: boolean; reason?: string; name?: string; agentId?: string }
```

**The message names no agent.** The subject is resolved by the broker from
`registry.entryFor(conn)` — the same technique `Registry.anchorFor` already
uses to stop a session claiming someone else's pane, and that
`SocketServer.handleSpawn` uses to derive `requestedBy` and `parentAgentId`.
That discipline outlives the overlap it was first written for; see §6.

### 4.1 `agent_teleport(handoff)` — the predecessor writes its own record and starts the clock

Caller must be a registered connection carrying an `agentId` (see §12 D3 for
the ordinary-session case, which this design now requires rather than defers
around). The broker:

1. refuses if `events.openQuestionCount(callerName)` is nonzero. This check
   used to gate a separate readiness call (see the superseded §4.2 below); it
   moves here because there is no longer a second call to gate. The reason is
   unchanged and still mechanical: `BrokerCore.answer` resolves the recipient
   with `events.authorOf(msgId)` and delivers by **name**. If the predecessor's
   name stops being held by a live connection while a question is outstanding,
   the human's eventual answer is appended to the log and delivered to
   nothing, recoverable only by someone who happens to query an inbox nobody
   is watching. A predecessor with open questions must answer, dismiss, or
   restate them in the handoff first — teleport does not get to abandon them
   by leaving. **Consequence of folding this into the single call:** the
   refusal now happens at teleport time, not at a later readiness step, so
   the `reason` on the `teleport_result` has to be actionable, not just
   accurate — it must name which questions are outstanding, the same way
   `send_result.reason` names a route failure rather than just reporting
   "failed." A refusal a model cannot act on is a refusal it will simply
   retry against the same wall.
2. reads the caller's identity, live tags, subscriptions and allocation from
   its own connection and its `agent_spawned` row, for use in step 5;
3. appends `agent_handoff` — actor the predecessor's name, `ref` its agentId,
   `body` the handoff text verbatim;
4. branches on whether the predecessor is visible (§4.2): a **visible**
   predecessor gets notified and a 30-second abortable countdown; a
   **headless** one does not — there is nothing here for the countdown to
   protect, so the sequence proceeds straight to step 5. Either way,
   everything from here on is broker-driven, not agent-driven.
5. once the countdown (if any) resolves without an abort: appends
   `agent_stood_down` for the predecessor, shuts the predecessor down (§4.3),
   then launches the descendant (§5) carrying the tags, subscriptions and
   allocation read in step 2, and registers it **under the predecessor's own
   name** (§5.1) — no generation suffix, because by the time registration
   happens the name is actually free.

There is no reply naming a _new_ agent the way the old design's step 5 did:
the descendant keeps the name the caller already knows, so "the descendant's
name" is not new information.

### 4.2 The countdown — visible predecessors only, human-abortable, never agent-abortable

**Decided: the countdown exists for visible predecessors and only for
them.** A headless predecessor completes automatically — write handoff, stand
down, launch descendant, no wait:

- **Visible predecessor:** notify the human → 30-second countdown → human may
  abort → shut down elegantly → reopen the descendant in the same iTerm
  window (§4.3).
- **Headless predecessor:** write handoff → stand down → launch descendant.
  No countdown, no notice-and-wait.

This asymmetry is deliberate, not an inconsistency to "fix" later. The
countdown's entire purpose is giving a **human** a veto over ending a process
they can see. A headless agent has no pane and no human watching it in the
moment — there is no one positioned to exercise the veto a countdown would
offer, so the 30 seconds would be pure added latency on every headless
teleport, bought in exchange for a safety mechanism nobody is there to use.
Making the two paths uniform would not make the design more consistent; it
would spend real latency on a veto that only one of the two cases can ever
act on.

**The abort is human-only, structurally, not by convention, for the case
that has one.** There is no `teleport_abort` in `ClientMessage`, no
agent-facing parameter that shortens or skips the countdown, and no wire path
from an MCP tool call to cancelling it. This is the same shape as CC-15's
override and this document's own §6: the wrong capability is not checked
against, it is unrepresentable. The failure being prevented is concrete — a
descendant (or the predecessor itself, mid-teleport) suppressing its own
predecessor's veto would turn a human safety valve into a formality the
moment anything downstream of the human wanted it gone. Abort lives wherever
a human already intervenes today: the CLI or the dashboard, acting on the
standing "kill/retire" path, not on any teleport-specific wire message.

### 4.3 Shutdown and reopening — the countdown's payload, not a new tool

When the countdown elapses unaborted, the broker does what the deleted
`teleport_shutdown_predecessor` tool used to do, minus the part that made it
dangerous: there is no descendant alive yet to hand a live worktree to, so
there is no race to sequence against. In order:

1. **Transfer the isolation allocation to the not-yet-launched descendant's
   pending identity** (§9), before anything is torn down.
2. Terminate the predecessor's process. `Supervisor.kill` already implements
   the SIGTERM-then-SIGKILL ladder; the "refuses on a visible surface" rule
   this document previously cited no longer applies unmodified, because this
   shutdown is not an outside agent reaching in — it is the countdown the
   predecessor itself started, with a human veto already offered and not
   taken. What survives from that rule is CC-23's substrate: for a **visible**
   predecessor, closing the process and then **reopening the descendant in
   the same iTerm window** shares a pane-management path with headless↔
   terminal switching, and should reuse it rather than growing a second way to
   open a pane.
3. Append `agent_retired` for the predecessor directly (not via
   `Supervisor.retire`, which also calls `isolation.release` — see §9 for why
   that would delete the tree the descendant is about to stand in),
   `body: 'superseded by teleport'`. This is what frees the name:
   `AgentLog.nameIsClaimed` treats every non-retired identity as holding its
   name, and `foldAgent` makes `retired` absorbing.
4. Launch the descendant (§5) and register it under the freed name.

Steps 3 and 4 are why there is no eviction race to design around here, unlike
the superseded §5.1 below: the predecessor's name is fully free — no
connection holding it — before the descendant ever asks for it. The ordinary,
un-special-cased `Registry.register` path handles it.

> **Superseded: the old §4.2 and §4.3.** The original design split readiness
> (`agent_teleport_ready`, agent-invoked, gated on the same open-questions
> check) from shutdown (`agent_teleport_shutdown_predecessor`, invoked by the
> _descendant_, resolving its predecessor via `meta.teleport_from` because the
> tool could not be allowed to name a target). Both existed to make an overlap
> safe: readiness so the predecessor could still be doing things after
> spawning its successor, shutdown so the descendant — not the predecessor —
> decided when the overlap ended. With no overlap, nothing is alive to invoke
> a second tool, so both collapse into steps of the single sequence above. The
> "not revocable" argument for readiness (mark ready as your last act, no
> unreadiness operation, because a toggle invites the question of who else
> may flip it) is now moot the same way: there is no window in which the
> predecessor could be "ready" and then given new work, because standing down
> and shutdown happen back-to-back inside one broker-driven sequence, not as
> two calls a model makes at will.

---

## 5. Launching the descendant

Reuse the spawn path, with four things pinned rather than chosen.

**Profile, surface, cwd and tool lists are inherited, with no parameter to
change them.** A teleport is a continuation, not a re-negotiation. A `profile`
argument on the teleport tool would be a model authoring its own privilege
escalation and calling it a handoff: an `explorer` could teleport into an
`implementer`. There is deliberately no such argument, for the same reason
`loadProfile` resolves by name only and refuses to take a profile body.

**Depth is inherited, not incremented.** This is a real bug waiting in the
obvious implementation. `Supervisor.depthOf` reads the parent's `meta.depth` and
returns it plus one; `preflight` refuses when depth exceeds `MAX_DEPTH` (2). If
teleport reuses the ordinary parent path, a depth-1 agent can teleport twice and
then never again — a long-running agent loses the ability to pick up its own
improvements precisely because it has been running long enough to need it.
Succession is not branching. `meta.depth` on the descendant must equal the
predecessor's.

**The launch plan and MCP config are rebuilt now, not reused.**
`writeLaunchFiles(buildLaunchPlan(...), buildMcpConfig(profile, cliEntry()))` —
which is what makes the descendant's MCP subprocess exec the _current_
`dist/cli.js` and read the _current_ `INSTRUCTIONS` string. This is the entire
payoff of the feature and it is genuinely delivered: the instructions string is
read at that process's construction, and that process is new.

**The handoff is the brief**, so it arrives as a turn.
`buildLaunchPlan` already delivers the brief positionally after `--` for
interactive surfaces and on stdin for headless ones. No new mechanism.

### 5.1 Naming — the descendant keeps the predecessor's name

**Resolved (was D1): the descendant registers under the predecessor's base
name**, so peers who already know `cc27` keep addressing something real —
they just get a newer generation of it. The lineage (that it _is_ a newer
generation, and which one) is advertised separately, in the roster (§10.1),
not smuggled into the name.

This is now cheap. It was not always going to be, and the reasoning for why
is worth keeping because it is the reasoning that makes the "no overlap"
decision (§4) load-bearing rather than arbitrary — this is **the trap the v0
sequencing avoids**, and it is the reason not to casually reintroduce an
overlap later.

**The trap.** Two live processes cannot hold one registry name —
`Registry.register` refuses a held name unless the incoming `agentId`
matches, and that exception exists for resume takeover, where the
predecessor is _supposed_ to die. Reusing that exception for a teleport with
an overlap would have been a disaster in a quiet costume: a same-`agentId`
registration evicts the predecessor's socket, `SocketServer` ends it with
`{fatal: true}`, and `BrokerClient`'s fatal handler calls `process.exit(0)`
on the MCP subprocess. Under an overlap, the predecessor would be severed
from the bus **at descendant-registration time, before any readiness gate
ran** — an ungated shutdown reached by accident, not by design. (The takeover
path itself is tested end to end in `agent-takeover.test.ts` and does exactly
this, on purpose, for resume — it is a fine mechanism for the thing it was
built for.) The first pass of this document saw the trap and routed around
it with a generation-suffixed name (`cc27` → `cc27-g2`), which sidestepped
the eviction race at the cost of every peer's remembered address going stale.

**Measured, not assumed.** The trap above was verified against real OS
processes rather than read off the source, because this document has been
wrong before about what the code does. A real headless `claude` was left
mid-`Bash` with its own MCP subprocess as a child; an evictor then registered
under the same agentId and name. The MCP subprocess stopped answering
`kill(pid, 0)` **~100-120 ms later** (102/112/114 ms across three runs),
bracketed in the log by `agent_detached "superseded by resume"` →
`agent_attached` — while the parent `claude` process stayed alive and running
for the full window observed. That is precisely "a live session with a dead
bus", confirmed by parent/child pids rather than by anything either process
said about itself. No meaningful concurrent-registration window exists: the
gap is socket-write and teardown latency, not an interval anyone could act in.

Two consequences worth carrying. First, **nothing may be designed on the
assumption that an evicted predecessor gets a turn to notice and react** — it
does not; it is severed and oblivious. Second, and easy to get wrong:
**takeover requires the same NAME as well as the same `agentId`.** A probe
that varied the name hit the impostor-refusal path instead and observed no
eviction at all, which would read as "the trap is not real" to anyone who
tested it carelessly.

**"Dead bus" understates it, and this is the sharpest thing measured.** A
separate probe killed the MCP subprocess of a live session directly, and
Claude Code **restarted the MCP server** — new pid, same parent. The session's
next turn then called `chat_list` and it SUCCEEDED, returning "No sessions are
registered", with the session itself absent from its own roster. So the state
after severing is not a dead bus anyone would notice. It is a WORKING bus on
which the session is silently deregistered, unreachable by every peer, with
nothing anywhere prompting it to register again. The session cannot tell: its
tools work and return plausible answers.

This is not a defect in adoption — registration is per-connection by design —
but it is the concrete shape of what D2's shutdown must never leave behind,
and it is invisible from inside the session that it happens to. Any shutdown
path that severs a connection without ending the process produces this state,
which is why shutdown must signal the HOST pid and not the registry's `pid`.

**Why v0 doesn't need the workaround.** With no overlap (§4), there is never
a moment when two live processes want the same name. The predecessor's
connection is fully closed — `agent_retired` appended, name no longer
claimed by any live entity — _before_ the descendant's registration is even
attempted (§4.3, steps 3-4). Registration goes through the ordinary,
un-special-cased `Registry.register` path: no same-`agentId` eviction, no
race, no ungated shutdown, because there is nothing left to evict.

**Do not reintroduce an overlap without reopening this.** If a future
revision brings back a live-predecessor-plus-live-descendant window for any
reason — richer interrogation, staged rollout, whatever — the eviction race
above comes back with it, and "the descendant keeps the base name" stops
being free. That would need its own naming answer again: either the
generation-suffix workaround this revision deleted, or a broker-only rename
door, or something not yet designed. Do not assume the current naming
decision still holds once an overlap exists.

---

## 6. Shutdown is self-directed, not peer-directed

> **Superseded framing.** The first pass of this document posed this as "why
> peer-over-peer shutdown is unrepresentable," because the descendant used to
> call `teleport_shutdown_predecessor` to end a _different_ live process. With
> no overlap (§4), that call no longer exists: the predecessor's own
> `agent_teleport` invocation is what starts the countdown that ends in its
> own shutdown (§4.1, §4.3). There is no peer-over-peer shutdown left to
> defend against in v0, because nothing shuts down anyone but itself. The
> reasoning below is kept because it states a principle this document still
> holds, and because it is exactly the principle to reapply if a future
> revision ever gives one agent power over another agent's process again.

The requirement was never "check that the caller is a descendant, or a
predecessor, or anything else about who is asking." A check is a line someone
relaxes later during an unrelated refactor, and this bus is machine-wide — a
capability that lets one agent end a _different_ agent's process would let
one initiative terminate another person's sessions.

The shape that held under the old design, and that any future shutdown-of-
another-agent operation should still be held to: **the operation takes no
argument, and its object is derived from a relationship the broker itself
recorded.**

- The now-deleted `teleport_shutdown_predecessor` had no fields — no name to
  pass, no id to pass, nothing to validate.
- Its object was found by following `meta.teleport_from` on the caller's own
  spawn row — a value the broker wrote, from the connection that requested
  the teleport, never from any client-supplied field. The same discipline
  `handleSpawn` already applies to `anchor` and `parentAgentId`.
- Generalising it to arbitrary peers would have required _adding a
  parameter_, which is a visible, reviewable, deliberate act in a diff — not
  the removal of an `if`.

**If any shutdown operation is reintroduced that can affect a process other
than the caller's own, it must be held to this same shape.** Requiring a
parameter to generalise it is the whole defence; a boolean check that the
caller "is a descendant" is not a substitute, because a check is a line that
erodes and a missing parameter is a line that has to be added back on
purpose.

What this never defended against, and still does not: a human at the CLI can
retire or kill anything; the socket is 0600 and reaching it means being the
local user, which is the same trust boundary the whole system already rests
on. And a raw client speaking the wire protocol directly can send any frame —
the defence was always that no frame _exists_ naming another agent as a
shutdown target, not that a tool-layer check hides one.

---

## 7. (a) Permission state — what teleport serialises, and why

**Answer: teleport serialises the launch posture, and nothing about in-memory
permission state — because it cannot, and because trying would be the wrong
requirement anyway.**

First, what is actually here. agent-chat holds **no permission state at all**. It
observes: `SocketServer.handleApproval` records an `approval_request` row and
sets `awaitingApproval` on the registry entry. It never sends a verdict — the
capability is registered as `claude/channel/permission` and declined on purpose
(`docs/permission-relay.md` establishes the host _would_ accept one). The only
permission-shaped things in the launch path are `--allowed-tools` /
`--disallowed-tools` from the profile, `--permission-mode default` pinned for
headless surfaces in `buildLaunchPlan`, and `profiles.ts` refusing a
`permissionMode` field in a profile file with a stated reason. There is no API
here that can read a session's in-memory permission context, so "inherit the
predecessor's memoized snapshot" is not a thing this codebase can express even
if it wanted to.

Second, the distinction the task draws is the right one and it resolves cleanly.
Per `docs/permission-relay.md` — which reports Claude Code internals plus four
observed rows from 2026-07-27, and which **I did not re-verify, because it
describes code that is not in this repo** — `persistPermissions` does two
independent things on "always allow": writes the rule to disk fire-and-forget,
_and_ updates that session's in-memory context. Settings reads are memoized with
no file watcher, so another session's write never reaches your cached view.

The consequence for teleport is that the two requirements are not just different,
they point in opposite directions:

- **"Same permissions as the predecessor has right now"** would mean copying a
  snapshot that has been diverging in memory since the predecessor launched, and
  that is _stale by definition_ — it is a cached read of a file that other
  sessions have since written.
- **"Same permissions the predecessor would get if it started now"** is what a
  fresh process gets for free, by reading disk at launch.

Teleport takes the second. A session teleporting to escape staleness must not
carry a stale permission view across in the same breath.

Concretely, for persisted grants the descendant is a **superset**: anything the
predecessor was granted via "always allow" was written to disk, so the
descendant reads it too, along with anything other sessions granted meanwhile.
What the descendant loses is genuinely session-scoped: one-shot "allow once"
decisions, and any denial the predecessor was honouring. The honest summary is
that the descendant is normally more permissive than the predecessor, and
occasionally re-prompts where the predecessor no longer would.

**The failure mode to say out loud:** a _headless_ descendant cannot be prompted
at all — verified in CC-2 with a positive control, per `docs/agent-teams.md`
Part 1, and consistent with `buildLaunchPlan` pinning `--permission-mode default`
for headless precisely because there is no human at a pane. A headless agent that
teleports and then hits a prompt its predecessor had satisfied session-scoped
will degrade silently. Prefer teleporting visible agents; for headless ones,
treat a post-teleport stall as a permission stall until proven otherwise.

---

## 8. (c) What else carries across

| Thing                                | Carries?                        | How, and the failure if not                                                                                                                                                                                                                                                                                                                                                                                   |
| ------------------------------------ | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Handoff text                         | yes                             | The descendant's brief, delivered as its first turn.                                                                                                                                                                                                                                                                                                                                                          |
| Profile, model, tool lists, surface  | yes, pinned                     | No parameter to change them (§5).                                                                                                                                                                                                                                                                                                                                                                             |
| cwd / worktree                       | yes                             | The predecessor's _allocated_ cwd, not a re-allocation (§9).                                                                                                                                                                                                                                                                                                                                                  |
| Tags                                 | yes                             | Read from the predecessor's live registry entry via `Registry.tagsOf`, passed as `AGENT_CHAT_TAGS`. Tags are registry-only and ephemeral; the predecessor is connected when it teleports, so they are readable exactly then.                                                                                                                                                                                  |
| Subscriptions                        | yes                             | Same source, passed as `AGENT_CHAT_SUBSCRIPTIONS`, applied at the descendant's own registration before its first turn. Needs a small `Registry.subscriptionsOf(conn)` accessor — `Entry.subscriptions` exists, nothing exposes it today.                                                                                                                                                                      |
| Registered name                      | **yes**                         | The descendant registers under the predecessor's base name once the predecessor's connection is fully closed (§5.1). Resolved D1.                                                                                                                                                                                                                                                                             |
| Lineage (generation, predecessor id) | new, not carried but advertised | `meta.generation`/`meta.teleport_from` on the descendant's spawn row, projected into the roster as `gen=`/`from=` (§10.1). Not a v1 gap — a deliberate, broker-derived addition that replaces "peers address a name that stops resolving" as the way lineage is visible.                                                                                                                                      |
| Open human-queue questions           | **no** — blocked instead        | `agent_teleport` refuses while any remain (§4.1 step 1). Transferring them would require rewriting the `actor` of logged rows, which an append-only log will not do, and leaving them would silently orphan the human's answers.                                                                                                                                                                              |
| Inbox                                | no                              | `EventLog.inboxFor` keys on `target` name. Unread messages to the predecessor stay addressed to it. The predecessor should drain and summarise them in the handoff; nothing enforces that.                                                                                                                                                                                                                    |
| File-ownership claims                | follows isolation               | Claims are a lease held by presence — `file-ownership.ts` builds the manifest from currently-connected agents. With no overlap (§4), the predecessor's connection is gone before the descendant's allocation exists, so there is no window where both are simultaneously counted as claimants — the descendant re-declares them via its inherited allocation (§9), it does not race the predecessor for them. |
| Terminal anchor                      | yes, incidentally               | `terminalAnchor()` is read by the descendant's own MCP process from its own environment.                                                                                                                                                                                                                                                                                                                      |
| Transcript / conversation            | **no, and deliberately**        | A clean context window is the feature.                                                                                                                                                                                                                                                                                                                                                                        |

**"The right files auto-loaded"** deserves honesty: there is no file-loading
mechanism in the launch path. The levers are `--add-dir` (via
`Allocation.addDirs`) and the brief text. So "auto-loaded" reduces to a
convention — the handoff format below requires a _read these first_ list, and
the descendant follows it because it is told to. Whether Claude Code expands
`@path` references inside a positional prompt or on stdin **I did not verify**;
if it does, the handoff should use that form and this becomes a real mechanism
rather than an instruction. Worth ten minutes with the installed CLI before
implementing.

### 8.1 Handoff format

Authored by the predecessor, stored verbatim by the broker. The broker templates
nothing — the moment it does, the handoff becomes a form to fill in and stops
being what the session actually knew. The _tool description_ demands:

1. what I was mid-way through, in enough detail to resume without me;
2. state on disk — branch, uncommitted files, what builds and what does not;
3. what I would have done next, and why that and not the alternative;
4. what I already tried that did not work (the most expensive thing to lose);
5. who I owe a reply to, and what I promised;
6. files to read first, in order.

Size cap — 8 KB is a reasonable start, **refused rather than truncated**. A
truncated handoff loses its tail, and the tail is items 4-6.

**Item 6 is a mechanism, not a convention — verified.** `@path` expansion
works in a brief on BOTH delivery paths, positional-after-`--` and stdin
with `-p`. A real headless agent was spawned with `@<abs-path>` in its brief
and with Read, Bash, Glob and Grep all DENIED — the denial is the control,
since it makes "the model went and fetched it" impossible. The transcript
carried an `attachment` record of `type: "file"` holding the file's literal
content, inserted BEFORE the assistant's first turn, with zero `tool_use`
frames; the model then answered with marker text it had no tool available to
go and get. So this is Claude Code's own client-side expansion, not the model
choosing to read.

Write item 6 as `@`-prefixed absolute paths. The descendant then starts with
those files already in context rather than with a list of files it is trusted
to remember to open — which also means the handoff should carry POINTERS
rather than pasted file contents, and that in turn is an argument the 8 KB cap
is more generous than it first looks.

---

## 9. The isolation trap

This is the part most likely to destroy work, so it gets its own section. §5's
core hazard survives the revision unchanged; only the framing of the naming
half needs updating, since the descendant now keeps the predecessor's name
(§5.1) rather than getting a generation suffix.

`worktreeStrategy.allocate` derives both the branch and the worktree path from
**the agent name** (`branchFor(ctx.agentName)`, `slug(ctx.agentName)`). The
first pass of this document argued the descendant would get a _different_
worktree because it had a different name; that argument no longer holds
literally, because the descendant now keeps the same name. Do not read that
as the hazard going away — it changes shape and gets worse to reason about,
because it now depends on timing instead of always firing:

- If the descendant allocates normally **after** the predecessor's worktree
  has already been released, `branchFor`/`slug` produce the _same_ path and
  branch it always did — which might look like it "just works," but only
  because the branch happens not to have been deleted yet, or the worktree
  directory happens to still exist. That is luck, not a guarantee, and it is
  strictly worse than the old failure mode: the old one was silent but
  _consistent_ (always a clean tree); this one is silent and _inconsistent_
  (works today, fails the next time release runs a beat earlier).
- If shutdown (§4.3) calls `Supervisor.retire` instead of appending
  `agent_retired` directly, `retire` also calls `isolation.release`, which
  for a worktree runs `git worktree remove` and `git branch -D` — **on the
  tree the descendant is about to stand in, or is already standing in,
  depending on exactly when in the sequence retire runs.** It would be
  refused while the tree is dirty or holds unmerged commits
  (`inspectForRelease`) and refused inside `RECLAIM_GRACE_MS`, which is luck
  rather than design; on a clean, pushed tree it would succeed and delete it.

So teleport must **inherit the allocation, never re-allocate and never
release** — the conclusion is unchanged by the naming decision, and if
anything is reinforced by it, since "just let the descendant allocate
normally" is now a trap that sometimes doesn't spring instead of one that
always does:

- the descendant is launched with `isolation: 'none'` and `cwd` set to the
  predecessor's `Allocation.cwd`;
- an `isolation_allocated` row is appended for the descendant carrying the
  predecessor's `ref` verbatim plus `meta.inherited_from`, so a later release
  still finds the branch, worktree path and git root it needs;
- `Supervisor` transfers the `Live` entry's `allocation` and `isolation` fields
  to the descendant's id, so the descendant's eventual `retire` releases the
  real strategy rather than the no-op one;
- the predecessor is closed by appending `agent_retired` directly, bypassing
  release — this is §4.3 step 3, and it is why that step says "directly" and
  not "via `Supervisor.retire`."

Without the third step the worktree leaks: the descendant holds
`isolation: 'none'`, whose release does nothing, and the tree survives every
retirement forever.

`checkCwd` is satisfied for free — the predecessor is a registered session
working in that directory, so the containment rule passes on its own terms.

One more consequence of dropping the overlap: during the 30-second countdown
(§4.2) the predecessor is still alive and still in its worktree. Nothing stops
it from continuing to edit files in that window — the risk §11 calls out
below — but the window is now bounded and human-visible rather than
open-ended, which is the whole point of choosing v0 over the overlap.

---

## 10. Events, and the read model

Two new kinds, unchanged in shape from the first pass even though who appends
them changed — `agent_stood_down` used to be appended by the predecessor
calling `teleport_ready`; now the broker appends it itself when the countdown
(§4.2) elapses unaborted. The row looks the same either way:

- **`agent_handoff`** — actor: predecessor name; `ref`: predecessor agentId;
  `body`: the handoff text; `meta.successor`: descendant agentId.
- **`agent_stood_down`** — actor: predecessor name; `ref`: predecessor agentId.
  No body. No longer "readiness" in the sense of a self-declared flag (§4.3's
  superseded note) — it now just records that the countdown ran out and the
  sequence proceeded, which is still worth a row of its own rather than
  folding into `agent_retired`, since "stood down" and "process actually
  gone" are different instants and both are worth being able to query
  separately.

Plus two `meta` fields on the existing `agent_spawned` row — `teleport_from`
and `generation`. Their _purpose_ changed even though their shape didn't.
Under the old design `teleport_from` existed so the descendant's shutdown
call could resolve its target (§6, superseded); that consumer is gone. What
both fields feed now is **decision 5: lineage in the structured roster.**

### 10.1 Lineage in the roster (CC-11)

`generation` and `teleport_from` are **broker-derived, not self-reported** —
written by the broker at descendant-spawn time from its own resolution of the
predecessor's identity, the same way `requestedBy` and `parentAgentId` are
written today, never taken from a client-supplied field. That puts them on
the trustworthy side of CC-11's still-open question about which roster
fields can be believed versus which are effectively the agent describing
itself. A roster field a compromised or careless agent could set is not
lineage, it's a claim; these are derived, so they're fact.

Target shape, one line per roster entry that has a lineage:

```
planner  gen=2  from=ag00f31c
```

`gen` is `meta.generation` folded up from the chain of `agent_spawned` rows
(1 for a never-teleported agent, incrementing per hop); `from` is the
immediate predecessor's agentId, not the whole chain — the chain itself is
already in the log as a walk of `teleport_from` pointers, and the roster is
not the place to unroll it.

**This is a projection, not a second store.** The succession itself stays an
event — `agent_handoff` plus the `meta.teleport_from`/`meta.generation`
stamp on the spawn row are the source of truth. The roster line above is
computed from those on read, the same relationship `roster()` already has to
the rest of the event log (§3). If the roster ever disagreed with the log, the
roster would be the thing that's wrong.

Consequences, all checked against the current implementation:

- `EVENT_KINDS` in `protocol.ts` is a runtime array and `SSE_EVENT_NAMES` is
  _derived_ from it, so the SSE surface picks new kinds up automatically. The
  cost is the deliberate tripwire in `api-contract.test.ts` — a test asserting
  `EVENT_KINDS` equals the frozen list, whose own comment says: if this fails
  because you added a kind deliberately, check the Log and Queue views handle
  it, then add it below. That is the process; follow it rather than routing
  around it.
- `AGENT_KINDS` in `event-log.ts` must gain both, or `agentEvents()` will not
  return them and no query can see them.
- **Neither kind goes in `SUBSCRIBABLE_KINDS`, and `agent_handoff` especially
  not.** `SystemEventFeed.offer` copies `row.body` into `SystemEvent.detail` and
  pushes it to subscribers. Subscribing to a kind whose body is a document would
  fan a whole handoff into every subscriber's context — a content leak by
  construction, into a channel whose stated guarantee is "you learn who is here,
  never what anyone said". If peers need succession visibility, the descendant's
  `agent_spawned` (carrying `generation`/`teleport_from` for the roster
  projection above) and the predecessor's `agent_retired` are already
  subscribable and already say enough.
- **No new lifecycle state.** `AGENT_LIFECYCLES` stays as it is and `TRANSITIONS`
  in `identity.ts` gains nothing, so both new kinds only bump `lastEventAt`.
  Standing down stays a **query** — "does an `agent_stood_down` row exist for
  this id" — in the same spirit as `humanQueue()` and `openQuestionCount()`.
  Making it a state would put it in `pairPresence`'s switch and force a
  rendering decision for a condition that lasts seconds.

Two small projections on `AgentLog`, both pure:

```ts
stoodDown(agentId: string): boolean   // an agent_stood_down row exists
successorOf(agentId: string): AgentIdentity | undefined  // spawn row with meta.teleport_from
```

---

## 11. What this does not defend against

Stated bluntly, in the house style, because a mechanism whose limits are unclear
gets trusted past them.

- **A predecessor whose countdown never resolves.** If the process dies mid-
  countdown, before the broker's own stand-down/shutdown/launch sequence
  (§4.1 step 5) runs, the descendant never gets launched and the name stays
  held by a connection that is already gone — a state the ordinary
  presence-is-ephemeral cleanup (`BrokerCore.drop`) will eventually resolve by
  freeing the name, but with no descendant to take it. There is still no
  timeout that substitutes for the human: recovery is a human at the CLI
  re-running the launch by hand, same as before.
- **A predecessor that keeps working during the 30-second countdown.**
  Nothing stops it (§9). The window is bounded now instead of open-ended,
  which is strictly better than the overlap design this replaced, but it is
  not zero — a predecessor that races to finish "just one more edit" before
  its own countdown expires can still leave the tree in a state the
  descendant inherits mid-change.
- **A handoff that is wrong or a lie.** The broker stores text. Nothing verifies
  the state it describes matches the disk. A confident, inaccurate handoff is
  worse than none, and this design has no answer for it beyond the format.
- **Teleport does not upgrade the broker.** The descendant's MCP subprocess
  execs the current `dist/cli.js` and reads the current instructions — real, and
  the point. The **broker** is a long-lived process still running whatever
  `dist/` it started with, and `cliEntry()` resolves against the running
  broker's package root. If the improvement is in broker code, the broker must
  be restarted, and that drops every registration on the machine — presence is
  ephemeral, so every client climbs its reconnect ladder. Teleport upgrades the
  agent, not the bus. Do not let this doc's existence suggest otherwise.
- **A stale `dist/` teleports into a stale `dist/`.** `paths.ts` already warns
  that a spawn from a source checkout runs whatever `npm run build` last
  produced. A teleport that skips the build achieves nothing at real cost. The
  tool description should say: build first, then teleport.
- **Nothing here contains a compromised predecessor.** It authors its
  successor's brief and inherits its own profile. Teleport is a continuity
  mechanism, not a sandbox boundary, and the trust boundary remains the OS
  account.

---

## 12. Decisions for the human

The first pass of this document posed five open questions with
recommendations. Three are now resolved by explicit human decision — D1
(naming), D2 (overlap and visible-predecessor shutdown), D3 (who can
teleport) — one of them (D3) against this document's own recommendation.
D4 dissolves as a logical consequence of D2 rather than being decided either
way. D5 was not addressed and is still open; §13 says so again so it does not
get silently treated as settled. Recommendations that were overruled are kept
below, because the reasoning that argued for them is part of the record of
what teleport is not, and because a future revision that wants to revisit any
of these should see what was weighed and rejected, not just the verdict.

**D1 — does the descendant take over the base name at cutover? Resolved: yes.**
The descendant keeps the predecessor's base name (§5.1). This document had
recommended against it in v1, on the grounds that renaming a live
registration under an overlap needed a broker-only rename door and left a
window where the name resolved to neither identity. That recommendation was
correct for the design it was made against — an overlap — and wrong for the
one actually adopted. Once overlap was deleted (§4, decision below), the
rename problem dissolved: there is no live registration to rename, only a
free name for the descendant to claim through the ordinary registration
path. The human's framing: "we should keep the name so peers can keep
talking to it, but we should advertise the descendant version and lineage
somewhere" — which is exactly §10.1's `gen=`/`from=` roster projection.

**D2 (overlap) — is there a live-predecessor overlap window at all?
Resolved: no, v0 has none.** Sequence: predecessor writes handoff, human is
notified, 30-second countdown with a human-only abort, predecessor stands
down, predecessor shuts down, descendant registers and takes the name (§4).
This is not a compromise between the original design's D2 (what to do about
a _visible_ predecessor) and something else — it subsumes D2, because with
no overlap there is no moment where a live predecessor and a live descendant
coexist for D2's original question ("do we kill it?") to even apply to. What
the human chose instead, described fully in §4.2-§4.3: notify, count down,
give a human the veto, then shut down elegantly and reopen the descendant in
the same iTerm window for a visible predecessor. This is richer than either
of the first pass's D2 options ("never kill a visible agent" or evict it
outright) — it keeps the automation the second option wanted, gated by the
human veto the first option wanted, instead of forcing a choice between them.
This document's own §13 (uncertainty about the overlap's value) named the
no-overlap version as the fallback if the overlap went unused; the human
chose it up front rather than waiting to observe that. Consequence: this
deletes generation names (§5.1), the `teleport_shutdown_predecessor` tool as
a distinct mechanism (§4.3), the broker-only rename door D1 would otherwise
have needed, and D4 below as a live question.

**D3 — can an ordinary, human-started session teleport? Resolved: it must be
able to, and this is now a prerequisite, not an exclusion.** This document had
recommended "not in v1," on the grounds that an ordinary session has no
`agentId`, no spawn row, and no `pid` the broker can safely act on. The human
overruled that recommendation directly, because the motivating incident in
§1 _was_ three ordinary sessions — recommending against exactly the case that
justifies the feature's existence was a real gap in the first pass, not a
defensible conservatism. The resolution is not "make ordinary sessions
teleport-capable somehow"; it is **durable identity for ordinary sessions is
now a prerequisite**, filed as **CC-30**, and teleport deliberately slips
behind it rather than shipping a version that only helps the case that
wasn't the emergency. Everything in §4 through §10 assumes the caller already
has a durable `agentId` — that assumption is now honest, because CC-30 is
what will make it true for ordinary sessions too, not a gap this document
papers over.

**D4 — may teleport overdraw the agent slot budget by one? Resolved: the
question dissolves.** `Semaphore`'s `DEFAULT_SLOTS` existed as a constraint
because the overlap needed two live occupants — predecessor and descendant —
for one logical agent, for the duration of the interrogation window. With no
overlap (D2 above), there is never a moment where both are live and holding
slots simultaneously: the predecessor's slot frees at shutdown (§4.3) before
the descendant's launch (§5) claims one. No exception to the slot budget is
needed, and none is added. This is not "resolved yes" or "resolved no" —
the premise the question was asked under no longer holds.

**D5 — should standing down also refuse on unread inbox items? Still open.**
_Recommendation unchanged from the first pass: no, warn only._ This is
unaffected by the other four decisions — it was never about the overlap, only
about how strict the
open-questions-style gate in §4.1 step 1 should be. Open questions are a real
orphaning bug (an answer delivered to a name nobody holds, §4.1); unread
inbox items are just unread, and a hard refusal on them would make teleport
unreachable for any agent people are actively talking to. This one the human
has not weighed in on explicitly; treat it as still open, not as silently
decided by inertia.

---

## 13. Where I am uncertain

- ~~Whether `@path` expansion works in a positional or stdin brief.~~
  **SETTLED — it works, on both paths. See §8.1.**
- The right handoff size cap. 8 KB is a guess with no measurement behind it, in
  the same category as the thread-depth constants that `registry.ts` is candid
  about not having validated.
- Whether `agent_handoff` and `agent_stood_down` should be one kind with a
  `meta.phase`. One kind costs less tripwire churn; two kinds keep a query from
  depending on a stringly field. I chose two and I hold that loosely — this
  question is unaffected by the overlap's removal, since both kinds still
  exist and still fire in sequence, just from a different caller (§10).
- D5 (§12) is a genuinely open decision, not a resolved one dressed as open —
  say so rather than assume "warn only" by default because it was the
  original recommendation.

---

## 14. What the implementation decided that this document did not

Written 2026-07-29, alongside the code (`src/agents/teleport.ts`,
`supervisor.ts`, `broker/socket.ts`, `server/tools.ts`). Everything here is a
gap the design left, found by building it. Where this section and anything
above disagree, this section is what the code does.

**1. An adopted session has no profile to inherit, so it inherits the
HARNESS.** §5 pins "profile, surface, cwd and tool lists are inherited", and D3
then required ordinary human-started sessions to teleport — but an adopted
identity is minted at `chat_register` and carries no model, no tools, no
isolation and no surface. The first instinct was a new builtin profile for
descendants. The human rejected that framing outright: _"allowedTools should
just be the default tools rather than us setting allowed/disallowed, and
ideally we pull model from that parent session for continuity ... we should try
to replicate the configuration that the current session is running over."_ So
the descendant of an ordinary session gets **no `--allowed-tools` and no
`--disallowed-tools` flag at all** — it lives under the human's own settings,
exactly as its predecessor did — and its model is read from Claude Code's own
transcript (`transcript.ts:observedModel`, `message.model` on the newest
assistant row; observed on a live transcript, not inferred). Empty `model` or
empty `allowedTools` in a profile now MEANS "inherit" in `buildLaunchPlan`.
Note the cost, stated where the code does it: with no allow list, agent-chat's
own tools stop being allowlisted for the descendant and fall back to ordinary
permission rules. That is right for a session already living under them and
wrong for anything else, which is why nothing but teleport can produce it — a
profile file still fails validation without both fields.

**2. `model` is the one negotiable field.** A parameter on the teleport tool,
against §5's "no parameter to change them" — kept narrow deliberately, from the
same human note: an agent may succeed itself onto a cheaper or stronger model on
purpose. A model is not a privilege; a profile, a surface and a tool list are,
and none of them are settable.

**3. Teleport refuses a session that never reported `hostPid`.** §5.1 measured
that severing the MCP subprocess leaves a working bus on which the session is
silently deregistered and cannot tell. The only pid that ends the session is
Claude Code's own, which arrives on `register` (CC-30). If it is absent — an
MCP server older than teleport — the sequence does not start. Refusing is the
only option that cannot produce two live processes on one name.

**4. The abort is a wire frame with a check, not an absent capability.** §4.2
asks for a human-only abort and §6 argues that the strong form of such a rule is
an operation nobody can express. These pull against each other here, because
the human at the CLI and an agent reach the broker over the SAME socket: a veto
that no frame can express is a veto the human cannot exercise either. So
`teleport_abort` exists and the broker refuses it from any REGISTERED
connection, leaving the human at the CLI (`agent-chat teleport abort <name>`),
who could already retire or kill anything on a 0600 socket. No MCP tool exposes
it. This is the one place in teleport where a check stands in for a structural
defence, and it is marked as such in `socket.ts`.

**5. D5 resolved: warn only.** Decided by the human 2026-07-29. Teleport reports
how many messages arrived for the name during the session and tells the
predecessor to say in the handoff which it had already handled. It does not
refuse: unread items stay addressed to the name, the descendant keeps the name,
and `chat_inbox` still returns them.

Two smaller notes worth having written down:

- **The visible/headless split is read off the SURFACE, not off a separate
  notion of visibility.** A descendant of an ordinary session is `iterm-tab`, so
  ordinary sessions always get the countdown; the iTerm surface's existing
  ladder handles a missing or closed anchor by opening a window, which is the
  same fallback a spawn already gets.
- **The predecessor's `Live` entry is dropped at relaunch**, not left for its
  own exit to clear. `Supervisor.find(name)` scans by name, and while both
  entries are in the map "the live agent called scout" resolves to the dead one.

---

## 15. What the first live teleports found

Run 2026-07-29 on an isolated bus (`AGENT_CHAT_HOME=/tmp/tport`), against real
Claude Code sessions in real iTerm panes. Four runs: one aborted, one that
failed, two that completed — the second of those a gen-3 hop. Every fix below
came from watching it rather than from reading the code, which is the point of
having done it.

**1. An aborted predecessor was never told.** The abort appended a `notice`
targeted at the session. Notices are not pushed live, and `notice` is not an
inbox kind either — so the row existed, nothing delivered it, and the
predecessor went on believing it was seconds from being shut down. That is the
exact belief an abort exists to end. It is now a `message` from `agent-chat`,
delivered on the next turn and durable in the inbox if the session is mid-turn.

**2. A visible descendant could not find its own launch plan.** The tab opened
and died with `no launch plan for agent 71aa68a5 at ~/.agent-chat/...` while the
plan sat in the relocated home the broker was actually using. A pane is opened
by AppleScript and runs in a fresh shell carrying the USER's environment, not
the broker's; headless never had the bug because it is spawned by the broker and
inherits it. `runAgentCommand` now carries `AGENT_CHAT_HOME` explicitly. **This
was never teleport-specific** — every visible spawn under a relocated home had
it, and nothing caught it because the default home makes it invisible.

**3. The descendant opened as a new tab, which is the wrong place.** §4.3 says
"reopen in the same iTerm window", and a tab satisfies that literally while
being wrong in practice: it left the predecessor's pane behind at a dead shell
prompt and moved the work out of the split the human was watching. The
descendant now runs IN the vacated pane — `write text` into the anchor session
itself, after a 750 ms settle so the command is not typed into a TUI still
tearing down. Note what this is NOT: it is not `iterm-pane`, which SPLITS the
anchor. Splitting is right for a spawn, where the requester's pane stays alive
beside the new agent, and wrong here, where it would halve a pane whose session
is about to die. Reuse is available only to teleport, because only teleport has
an anchor its caller has just vacated.

What the runs confirmed working, and could not have been confirmed any other
way: SIGTERM on the reported `hostPid` ends Claude Code and its MCP subprocess
with it; the descendant's registration wins the name once that socket closes;
the countdown notice reaches the human queue and `agent-chat teleport abort`
stops it; an ordinary session's descendant comes up on the inherited
configuration and registers under the same name; and a descendant can itself
teleport again — `gen=3` — with lineage intact through both hops.

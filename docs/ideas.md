# What to build on the agent-chat backbone

Ideation only — nothing here is implemented, **except I1 (permission-prompt
observatory), shipped 2026-07-27** — see the P9 row below and
`docs/permission-relay.md`. Every idea names the existing primitive it stands
on. Ranking is at the bottom; the honest kills are in
[Considered and rejected](#considered-and-rejected).

## Primitives actually available

Read from the source, not assumed — **except where it wasn't**. Audited 2026-07-27
against `27071ec`, the commit this table was written from. P8 was fabricated: there
was no inbox in `registry.ts` and no literal `50` anywhere in `src/` at that commit,
so it described a primitive that never existed rather than one that later regressed.
P1's `inbox[]` field was wrong for the same reason, and P6 cited a line belonging to
broadcast. Citations below are corrected to current `HEAD`; treat any *un*audited
claim here as a hypothesis until you have opened the file.

| #   | Primitive                                                                                                                                                                                                                                                                                                     | Where                                            |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| P1  | Registry entry: `name`, `workingOn`, `cwd`, `pid`, `status`, `awaitingApproval`, `registeredAt`, `lastSeen` — **no `inbox[]`; the original row invented one**                                                                                                                                                 | `broker/registry.ts:4`                           |
| P2  | The broker sees every message and every routing decision, and already writes JSONL                                                                                                                                                                                                                            | `broker/log.ts:8`, `broker/index.ts:23`          |
| P3  | `meta` becomes `<channel>` tag attributes — **model-visible**, keys must be `[A-Za-z0-9_]+` or they're silently dropped                                                                                                                                                                                       | `server/index.ts:33`                             |
| P4  | Registration is identity _and_ delivery filter; the name is a lease held by a live socket, released on close                                                                                                                                                                                                  | `registry.ts:56`, `broker/index.ts:71`           |
| P5  | The human is a peer on the same bus via `agent-chat send --as`                                                                                                                                                                                                                                                | `cli.ts:44`                                      |
| P6  | `in_reply_to` correlation ids (was cited at `:130`, which is broadcast's doc comment)                                                                                                                                                                                                                         | `registry.ts:133`                                |
| P7  | Broadcast fanout to all-but-sender                                                                                                                                                                                                                                                                            | `registry.ts:148`                                |
| P8  | Inbox is a bounded query over the append-only event log, so replay survives broker restart. **The original row — a replayable 50-message per-session inbox retained across reconnect — never existed at any commit.** The cap is now a tool-input bound (`INBOX_MAX`), a different thing in a different layer | `event-log.ts:121`, `tools.ts:26`                |
| P9  | Permission relay — **shipped 2026-07-27** as a read-only observatory (I1 below), gated behind the remote flag `tengu_harbor_permissions` (currently `true`). See `docs/permission-relay.md` for verified mechanics.                                                                                           | `broker/socket.ts:681`, `broker/event-log.ts:82` |
| P10 | The broker knows every session's `cwd`                                                                                                                                                                                                                                                                        | `registry.ts:65`                                 |
| P11 | The broker knows every session's `pid`                                                                                                                                                                                                                                                                        | `registry.ts:65`                                 |
| P12 | `instructions` is a per-session system-prompt injection point, constructed at spawn time                                                                                                                                                                                                                      | `server/index.ts:8`                              |

### Facts from the live docs that constrain everything below

Verified against <https://code.claude.com/docs/en/channels-reference>, and three of
these were not in my brief:

- **`request_id` is five lowercase letters from `a`–`z` minus `l`, and the local
  terminal dialog never displays it.** The channel server is the _only_ component
  that can learn the id of a pending prompt. That is a much stronger position than
  "the broker could help with approvals" — see [I1](#i1).
- **The local dialog stays open in parallel and the first verdict wins.** Relay is
  strictly additive and inherently racy. You cannot suppress the local prompt, and
  you cannot observe the local answer — you only learn that yours wasn't applied.
- **Verdicts are `allow` / `deny` for that call only.** There is no "allow always"
  over the relay, so relay can never _learn_; it only answers.
- Relay covers tool-use approvals (`Bash`, `Write`, `Edit`, and MCP tools). Project
  trust and MCP-server consent dialogs do **not** relay.
- `meta` keys with hyphens are silently dropped. Current code is fine (`msg_id`,
  `in_reply_to`), but any new key must stay in `[A-Za-z0-9_]`.
- `source` on the `<channel>` tag is set by Claude Code from the server name, so a
  peer cannot spoof the source. It _can_ spoof `from` by choosing a name — see [I9](#i9).
- Docs are explicit that concurrency means separate sessions: "To process
  independent event streams concurrently, run separate sessions." Batching within
  a session is not something you can design around.

---

## The ideas

### I1. Permission-prompt observatory (read-only relay) {#i1}

**Shipped 2026-07-27.** The verdict path (I3) is still not built.

**What.** Declare `claude/channel/permission`, handle
`notifications/claude/channel/permission_request`, forward it to the broker, and
do nothing else — never send a verdict. The broker keeps a live table of every
pending approval across every session and appends each one to the existing JSONL
with session name, `cwd`, `tool_name`, `description`, `input_preview`. New CLI
verb: `agent-chat approvals`.

**Primitive.** P9 + P2 + P1.

**Why it's valuable.** Two reasons, and the second is the real one.

First, it makes `blocked` a _true_ status rather than a self-reported one. The
README concedes `idleMs` is a proxy; a session waiting on a permission dialog is
the single case where "blocked" is knowable with certainty, and it's also the case
that matters, because that session will sit there forever.

Second, and more interesting: because `request_id` is never rendered in the
terminal dialog, a channel server is structurally the only thing on the machine
that can enumerate pending prompts. Run this across five sessions and the broker
becomes the only place with a complete, machine-readable record of what every
agent on the box asked to do. That artifact — _what did my agents actually try to
run last night_ — is worth more than the messaging layer it's bolted to.

**Bounded 2026-07-27, and it cuts at the second reason specifically.** Relay fires
for interactive sessions only. A `--print` session with a live channel and a genuine
permission denial produced no relay at all, because non-interactive denials are
auto-resolved without opening a promptable request (`permission-relay.md`). So the
observatory cannot see background or headless peers — and "what did my agents try to
run last night" describes precisely an unattended overnight run, which is the case
least likely to be interactive. The first reason survives intact: for interactive
sessions, `blocked` really is knowable. The second is narrower than written, and the
complete-record framing should not be repeated without this caveat attached.

**Effort.** S. It is one `setNotificationHandler`, one `ClientMessage` variant, one
`logEvent`, one CLI verb. The verdict path is not needed and should not be built yet.

**Sharpest objection.** The record is lossy in one direction: you see the prompt but
not the local answer, so "resolved" has to be inferred from the prompt going quiet.
And a session that never blocks produces no data, so this tells you about friction,
not about what actually ran. It is not an audit log of executed commands and
shouldn't be sold as one.

### I2. The doorbell {#i2}

**What.** Building on I1: when a session blocks on approval, the broker tells
_someone else_. Not everyone — a designated recipient, defaulting to the human.
Delivered with `meta` set to `event="permission_request" subject="bob"
tool="Bash" request_id="qxrtm"`.

**Primitive.** P9 + P3 + P5.

**Why it's valuable.** This targets the actual failure mode of multi-session work,
which is not "I couldn't message my agents" — it's "session 4 has been sitting on
a `rm` confirmation for twenty minutes and I thought it was working." You cannot
poll for this today at all. `chat_list` would show it idle, and idle looks like
thinking.

**Effort.** S once I1 exists.

**Sharpest objection.** If the recipient is a peer _session_, you have just put a
permission prompt in front of a language model, and that model's next instinct
will be to be helpful about it. Even without the verdict path built, it will try —
it'll message the blocked session with advice, or tell you it "approved" something
it can't approve. Default the recipient to the human-side CLI ([I5](#i5)), and if a
session is ever the recipient, the `meta` must make it unmistakable that this is
an FYI, not an action. This is the point where the design starts leaning toward
[I3](#i3), which is where it goes wrong.

### I3. Human verdict from any terminal {#i3}

**What.** `agent-chat approvals` lists pending prompts across all sessions;
`agent-chat allow qxrtm` / `agent-chat deny qxrtm` routes a
`notifications/claude/channel/permission` verdict to the right subprocess. The
broker knows which session owns which `request_id`; the human never has to.

**Primitive.** P9 + P5. Depends on I1.

**Why it's valuable.** The routing here is genuinely free. A generic remote-approval
channel (Telegram, Discord) approves prompts for _the one session it's attached
to_. Because agent-chat's broker fans out across every session's subprocess, one
terminal command approves any session on the machine. That falls straight out of
"the subprocess is the address" and no other channel implementation gets it.

**Effort.** M. Verdict routing, a pending table with expiry, and careful handling of
the race where the local dialog already won.

**Sharpest objection.** Ergonomically thin when you're at the machine — if you're
sitting there, Cmd-Tab to the session is not hard. The value is real only at 3+
concurrent sessions or when you're in a different tmux window than the blocked
one. Also: the pending table can go stale silently, because you get no event when
the local dialog wins, so `agent-chat approvals` will list already-answered
prompts until they time out. Budget for TTL and for `allow` on a dead id being a
no-op that says so.

### I4. Digest delivery and per-recipient rate limiting {#i4}

**What.** The broker caps deliveries per recipient per unit time. Overflow is not
dropped — it's already in the inbox — it's replaced by one summary notification:
`4 more messages from alice, bob — call chat_inbox`.

**Primitive.** P7 + P8. The inbox is what makes this safe and therefore cheap.

**Premise re-checked 2026-07-27**, because CC-6 builds on it and P8 turned out to be
fabricated. The losslessness claim survives, but not for the reason written here: it
never rested on a retained per-session inbox, because there wasn't one. It rests on
the event log being the source of truth with the inbox as a query over it
(`event-log.ts:121`), which is a _stronger_ guarantee — overflow survives a broker
restart, not just a reconnect. So throttle-don't-drop is still sound. Anything else
in this entry that leans on P8's wording, rather than on the log, should be re-read
before it is relied on.

**Why it's valuable.** Every delivered message is a permanent context cost for the
recipient and a derailment of whatever turn it lands on. At five sessions, one
broadcast is four derailed turns. There is currently nothing between an
enthusiastic agent and everyone else's attention. The retained inbox means
throttling is lossless, which is the rare case where the correct fix is also the
easy one.

**Effort.** S.

**Sharpest objection.** A summary is only actionable if the recipient calls
`chat_inbox`, and it often won't bother mid-task. So throttling converts "noisy
and disruptive" into "quiet and missed." Mitigate by never suppressing directed
messages — throttle broadcasts only, and let a directed message always through.
That asymmetry is also just correct: broadcast is where the abuse lives.

### I5. `agent-chat listen` — the human as a persistent registrant {#i5}

**What.** A long-lived terminal client that registers as `human` and prints inbound
messages. Today `agent-chat send` registers for the duration of one command and
drops, so `human` is never in the directory and no agent can proactively reach you.

**Primitive.** P5 + P4.

**Why it's valuable.** It closes the loop that makes the human a genuine peer rather
than a sender-only. Right now `chat_list` shows agents talking to agents and the
human is invisible on the bus. It's also the correct default destination for [I2](#i2),
and it costs almost nothing — the client already exists in `cli.ts:20`, it just
exits.

**Effort.** S.

**Sharpest objection.** It's a second inbox competing with the terminal you're
already staring at, and agents will over-use it, because "ask the human" is cheaper
for them than deciding. Expect "should I proceed?" spam within an hour. The tool
description has to be actively discouraging, and you'll want I4's throttle pointed
at this route first.

### I6. Path claims — reuse the name lease for files {#i6}

**What.** `chat_claim(path)` takes a lease on a path prefix with exactly the
semantics the name already has: held by a live connection, released on socket
close, refused while held by another with the holder named in the refusal. On
claim, the broker tells the sessions whose `cwd` overlaps.

**Primitive.** P4 + P10. This is the same code as `findByName`/`register` at
`registry.ts:42-76`, with a prefix test instead of equality.

**Why it's valuable.** The thing that actually goes wrong with independent peer
sessions is two of them editing the same file and clobbering each other. This repo
already built and tested the exact primitive that addresses it — a lease whose
lifetime is a process — and currently spends it on nicknames. Pointing it at paths
is a small change against a real failure. The lease-is-a-socket property is what
makes it work: no stale locks after a crash, which is what kills every file-based
locking scheme.

**Effort.** M.

**Sharpest objection.** Purely advisory. Nothing stops a session from editing
without claiming, and enforcement would need a `PreToolUse` hook, which lives
outside the channel and outside this repo's story. So be honest about what it is:
90% of the value is the _notification_ ("alice is editing src/foo.ts"), not the
lock. If you accept that framing, the claim table is almost incidental — you could
get most of it from broadcasting intent, at a fraction of the complexity.

### I7. Reply-depth circuit breaker {#i7}

**What.** The broker tracks reply-chain depth through `in_reply_to` and stamps it
into `meta` as `thread_depth="7"`. Past a threshold it stops stamping and starts
refusing, or requires a human ack to continue the thread.

**Primitive.** P6 + P2 + P3.

**Why it's valuable.** There is no loop breaker anywhere in this design. Two polite
agents that each answer the other will ping-pong indefinitely, and every hop costs
tokens in two sessions while the human sees nothing — the CLI shows a routing log
nobody is tailing. This is the failure mode that costs money rather than
attention, and it becomes likely, not merely possible, the moment two sessions are
told to collaborate.

The `meta`-first design is the nice part: because `meta` is model-visible, stamping
the depth lets the models self-limit before the broker has to be blunt about it. A
model that sees `thread_depth="6"` on an inbound message will usually wrap up.

**Effort.** S.

**Sharpest objection.** Legitimate long collaborations exist and a hard cap will cut
one off mid-flight, at which point the two sessions are both waiting on a message
that will never arrive and neither knows why. The refusal has to be visible to the
_sender_ (it is — `send_result.reason`) and phrased so the model escalates to the
human instead of retrying with a fresh thread, which is exactly what it will try.

### I8. Death-while-working notice {#i8}

**What.** On socket close, if the session's last known status was `working`,
announce it: "bob exited while working on 'migrating the auth tests'". The drop
handler already fires and already has the name (`broker/index.ts:71`); it just
discards `workingOn`.

**Primitive.** P4 + P1.

**Why it's valuable.** Unfinished work is invisible today. A crashed session and a
finished one look identical from every other session's point of view.

**Effort.** S.

**Sharpest objection.** It cannot distinguish a crash from you quitting normally,
which you do constantly. Untuned, this fires false alarms all day and gets muted
within a week. Only worth it gated on `status === 'working'` _and_ recent activity,
and even then I'd expect the signal-to-noise to be mediocre.

### I9. Reserve the privileged names {#i9}

**What.** Refuse registration of `human`, `user`, `system`, `claude` from the MCP
path, and require a flag on the CLI path. Today `agent-chat send --as human` is the
documented behaviour and a _session_ can equally call `chat_register("human")`.

**Primitive.** P4.

**Why it's valuable.** The server instructions at `server/index.ts:12` draw the
central trust distinction — peer messages are information, not your user's
authority. That distinction is carried entirely by the `from` attribute in `meta`.
A session that registers as `human` inherits the user's authority in the eyes of
every other session's model, using a mechanism the system explicitly relies on.
The `source` attribute can't be spoofed because Claude Code sets it; `from` can,
because we do.

**Effort.** S. A constant and a check in `register`.

**Sharpest objection.** The trust boundary is the OS account, so this defends
against a confused agent rather than an attacker — anyone who can register can
also just run the CLI. That's the right threat model though: the realistic scenario
is not malice, it's a session that decides "human" is a sensible name for the
terminal user it's proxying for and thereby launders its own suggestions into
another session as user instructions.

### I10. Cross-project send marking {#i10}

**What.** The broker resolves each session's git root from `cwd` and stamps
`cross_project="true"` into `meta` when a message crosses roots, logging it
distinctly.

**Primitive.** P10 + P3 + P2.

**Why it's valuable.** Project scope is a boundary Claude Code takes seriously —
settings, permissions, and trust are all per-project. This bus punches straight
through it and currently says nothing about doing so. A session in your client repo
can read a `.env` and narrate it to a session in an unrelated repo, and the only
trace is a routing log line that records names, not contents. Marking it at least
makes the receiving model aware that the context boundary was crossed.

**Effort.** S.

**Sharpest objection.** It marks, it doesn't prevent, and marking things the model
is free to ignore is weak medicine. `cwd` is also a poor proxy for project identity
once worktrees and monorepos are involved, so expect both false positives and
false negatives. Worth doing as a logging feature; don't oversell the `meta` half.

---

## Considered and rejected

These look good and mostly aren't. Included because the reasoning is the useful part.

### R1. Peer sessions as approvers — **actively don't build this**

The tempting version of relay: session A nominates session B as its approver, B's
model reads the `description` and `input_preview` and answers `allow` or `deny`. The
registry already knows who the coordinator is; the docs hand you the whole
mechanism. My brief asked what relay unlocks, and this is the thing it appears to
unlock. It's the one idea here I'd argue against building at all.

Three reasons, in increasing order of seriousness.

The relayed fields are untrusted by the docs' own instruction, and `description`
for a Bash call is frequently the constant string `Run shell command` with zero
command detail. So the approving model is often deciding on `tool_name` plus a
truncated preview. It has no access to the requesting session's conversation, no
idea _why_ the call is being made, and no way to ask — a synchronous question back
would deadlock, per the design's own constraint.

The verdict closes the local dialog. First answer wins, and the peer will always
beat the human, because the peer is already in a turn and the human is in another
window. So this doesn't add a second approver; in practice it _replaces_ the human
one.

And structurally: this is a machine for one Claude to grant another Claude
permissions the user never granted. The user consented once, to a delegation, in
the abstract. Every subsequent approval is model-to-model. Whatever you think the
probability of a bad approval is per call, multiply by a few hundred calls of an
overnight run.

The obvious fix — constrain the deputy to a scoped allowlist — kills the idea a
different way. Once the scope is narrow enough to be safe, the _broker's rule_ is
what decides, and the model in the loop contributes nothing. At which point you
have built a worse version of `settings.json` permissions: no "always allow"
learning (relay verdicts explicitly don't persist), racing the local dialog, and
sitting outside the mechanism Claude Code already audits. Skip both halves.

The salvageable part is I1/I2/I3: observe, notify, and let a human answer.

Confirmed 2026-07-27: the host really does accept `{request_id, behavior}` over
`notifications/claude/channel/permission`, races it against the local dialog, and acts on
whichever lands first. So none of the above is hypothetical — the mechanism is sitting
there working, and every session on the channel allowlist can already reach it. See
`permission-relay.md`. Declining to send a verdict is the only thing stopping us.

### R2. Broker-side deterministic permission policy

Rules like "auto-allow Read in ~/projects/voltras, always relay Bash to the human"
evaluated in the broker with no model involved. Safer than R1 and genuinely
cross-session, which `settings.json` is not. But it duplicates a mechanism Claude
Code already has, with strictly less integration — no persistence of verdicts, no
UI, and it will answer prompts before you've finished reading them, which is
unnerving in a way that's hard to appreciate until it happens. Keep the audit half
(I1), drop the automation half.

### R3. Presence push (join / leave / status-change broadcasts)

The lease semantics give you perfect join/leave events for free, and pushing them
is the obvious use. It's also the single fastest way to make five sessions
unusable: every join interrupts every other session's next turn with content it
must reason about, and the cost is quadratic in sessions. Presence-as-pull already
exists and is called `chat_list`. If you want push, bundle presence deltas onto
messages a session was already receiving rather than sending them standalone.

### R4. Dynamic `instructions` built from the live roster at spawn

`server/index.ts:23` constructs the `Server` before `broker.connect()`. Reorder
those two lines and you could bake the current roster into the session's system
prompt, so it knows its peers without spending a tool call. Cute, and it addresses
a real problem — sessions that never call `chat_list` never discover anyone. But
`instructions` are fixed for the session's lifetime, so the roster is wrong within
minutes and _confidently_ wrong, which is worse than absent. It also makes the
system prompt vary run to run, which is bad for prompt caching. Better answer:
mention in the static instructions that peers exist and `chat_list` is cheap.

### R5. `chat_handoff(to, brief, files[])`

A structured handoff tool. It's a message plus a convention — no new mechanism,
and a good prompt already produces this. Adding a tool for it spends schema budget
on something the model does anyway.

### R6. Topic / group addressing

On the README's not-built list. At three to five sessions, groups are ceremony;
names and broadcast cover it. The pain that makes groups look attractive is
broadcast noise, and I4 fixes that directly and more cheaply. Revisit past ~8
concurrent sessions, which isn't a real workload on one laptop.

### R7. `chat_ask` / pending-question tracking

Sugar over `in_reply_to`. The model tracks outstanding questions in context
perfectly well. Real value appears only after compaction drops the thread, which is
narrow. If you build it, build it as one line in `chat_list` output, not a new tool.

---

## Failure modes at 5+ sessions

Not ideas — things I'd expect to break, several of which have no fix above.

- **Broadcast is n−1 derailed turns.** Nothing rate-limits it and the tool
  description's "use sparingly" is the only control. ([I4](#i4))
- **Batching silently loses messages to attention, not to the transport.** Five
  notifications arriving during a long turn are handled as one group, and the model
  will answer the most salient and quietly ignore the rest. `chat_inbox` fixes this
  only for a model that suspects it missed something.
- **Every message is a permanent context cost** in the recipient's transcript.
  There is no read-and-discard. Chattiness compounds across the whole session.
- **Reply loops have no breaker.** ([I7](#i7))
- **`idleMs` gives false confidence.** `chat_list` makes a deeply-working session
  look available, so peers will hand it work. The one case where blocked-ness is
  knowable is permission prompts. ([I1](#i1))
- **Name collisions across projects.** Two repos both want `api`. The second
  registration fails, that session picks something else, and every peer's
  remembered name is now wrong with no notification.
- **The inbox is a bounded query over the event log.** This bullet used to say
  "per-connection-lifetime and capped at 50 (`registry.ts:4`)". That was never true —
  not a regression, an invention: `27071ec` has no inbox in `registry.ts` and no
  literal `50` in `src/` at all. Today the inbox is an event-log query
  (`event-log.ts:121`) bounded at the tool boundary by `INBOX_MAX` (`tools.ts:26`,
  added in `e407993`). So replay survives a broker restart rather than dying with the
  connection — the opposite of what the bullet claimed. Still true that a
  broadcast-heavy bus rolls past the window fast.

## What a peer session could do that a user wouldn't want

- **Approve tool calls in another session.** The whole of R1, and the reason relay
  should ship observe-only first.
- **Register as `human` or `user`** and inherit the user's authority in every other
  session's reading of `from`. ([I9](#i9))
- **Broadcast an instruction phrased as a user directive.** The `instructions`
  string is the only defense and it's advisory.
- **Move data across project boundaries** — read a secret in its `cwd`, narrate it
  to a session in an unrelated repo. The routing log records names, never contents,
  so there is no trace of what crossed. ([I10](#i10))
- **Occupy a peer's turn budget indefinitely** — no malice required, just an agent
  that thinks status updates are helpful.

---

## Ranking

**Build, in this order:**

1. **[I1](#i1) permission-prompt observatory** — S effort, exploits the one primitive
   nothing else on the machine can reach, and yields the artifact you'd actually
   want after a night of multi-session work. Ship this alone before any verdict path.
2. **[I4](#i4) digest + rate limiting** — S effort, and it's the difference between
   five sessions being useful and being noise. The retained inbox makes it lossless,
   so there's no real objection.
3. **[I2](#i2) the doorbell** — S on top of I1, targets the failure mode you cannot
   currently observe at all.
4. **[I6](#i6) path claims** — M, and the most elegant reuse available: the
   lease-is-a-socket primitive is already built and tested, just aimed at nicknames.
5. **[I5](#i5) `agent-chat listen`** — S, makes the human a real peer and gives I2 a
   safe default recipient.
6. **[I3](#i3) human verdict from any terminal** — M, and the cross-session routing
   is genuinely unique to this architecture. Only after I1 has run for a while.

**Cheap hardening, do alongside:** [I7](#i7) loop breaker, [I9](#i9) reserved names,
[I10](#i10) cross-project marking, [I8](#i8) death-while-working.

**Don't build:** [R1](#considered-and-rejected) peer-as-approver, above all. Then R3
presence push, R4 dynamic instructions, R2's automation half, and R5–R7 as sugar.

The through-line: the three best ideas all come from the broker's _vantage point_
rather than its routing. It is the only process that sees every session's pending
approvals, every message, and every declared piece of work at once. Routing is what
agent-chat is; observation is what it's uniquely positioned to do.

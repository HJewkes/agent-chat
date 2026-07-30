# Working as a team — how the tools fit together

What each tool is for, how they compose, and the failure modes we have actually hit.

`docs/cross-agent-communication.md` is the evidence behind the messaging rules and is worth
reading whole. This document is the shorter question: given the tools, how do you use them
together without hurting yourself?

The condensed version of everything here lives in the MCP server `instructions`, which every
session reads before it can send anything. **Keep the two in step.** This is the surface where
a divergence is invisible until a session acts on the wrong rule.

---

## 1. The one idea everything else follows from

**Presence is ephemeral; identity is durable.**

A _session_ is a process connected to the broker. It appears in `chat_list`, holds a name while
it lives, and is gone when the socket drops.

An _agent_ is a durable identity in the event log. It has a name, a brief, a resume handle, and
a lifecycle that outlives any particular process. `agent_list` shows agents; `chat_list` shows
who is currently connected. **The two answer different questions**, and an agent can exist while
nothing is attached to it.

This is why a spawned agent is a **peer, not a subagent**. It outlives whatever spawned it,
which has a consequence people find counterintuitive:

> Spawning is not a way to get work done before your turn ends.

If you spawn an agent and finish your turn, the agent keeps going and reports to whoever is
still listening. You cannot spawn your way out of a deadline.

---

## 2. The tools, and the order you use them in

```
agent_profiles          what may I spawn, and what does each grant?
      │
agent_spawn             start one; it registers itself before its first turn
      │
chat_subscribe          tell me when it joins, leaves, or dies
      │
chat_list / agent_list  who is connected / who exists
      │
chat_send               talk to it by name, like any other peer
```

**`agent_profiles` before `agent_spawn`.** A profile bundles model, tool set, surface and
isolation. Read it rather than guessing a name, and prefer the narrowest that completes the
work — the tool list is the permission lever, and it is the only one. There is deliberately no
`bypassPermissions` anywhere in a profile.

**`agent_spawn`** returns `{agentId, name}` _synchronously_, and that identity is yours from the
moment it returns. You never have to match a later broadcast against your own spawn to work out
which agent is which.

That identity is genuinely yours the moment it returns, but the agent is still booting. You are
auto-subscribed to `agent_attached` and `agent_exited` for whatever you spawn — no `chat_subscribe`
call needed — so you learn the moment it actually attaches rather than polling `agent_list`.

**`chat_send`** addresses it by name. A spawned agent is an ordinary peer on the bus — there is
no separate channel for "your" agents, and no privileged relationship.

---

## 3. Choosing a surface

Surface is not cosmetic. It decides **whether a human can answer the agent's permission
prompts**.

| Surface        | Where it lands                         | Can be prompted? |
| -------------- | -------------------------------------- | ---------------- |
| `iterm-pane`   | stacks in a column beside you          | yes              |
| `iterm-tab`    | a tab in your window                   | yes              |
| `iterm-window` | its own window; the no-anchor fallback | yes              |
| `headless`     | no terminal at all                     | **no**           |

A headless agent that hits a permission prompt cannot ask anyone. It degrades silently and
produces worse output rather than blocking — which is the right behavior, but only if you chose
it knowingly. Use headless for read-only work (`explorer`, `reviewer`) and a visible surface for
anything that writes.

`iterm-pane` is the coordinator view: the first agent splits your pane, and each later one
stacks beneath it, so your pane keeps its width. `iterm-tab` is for independent peers you are
not watching.

**Placement follows the anchor, never focus.** The broker resolves the target pane from the
_spawning session's own registration_, so an agent lands in the tab you spawned it from even if
you have since switched tabs. You cannot aim a spawn at a pane you do not hold.

---

## 4. Choosing isolation

| Strategy          | What it actually does                                              |
| ----------------- | ------------------------------------------------------------------ |
| `worktree`        | its own git worktree and branch — the only real answer for writers |
| `file-ownership`  | declared file ownership within a shared checkout                   |
| `toolset-limited` | narrows capability, **not** collision                              |
| `none`            | shares your checkout entirely                                      |

`toolset-limited` is honest about being capability isolation: a read-only explorer cannot
conflict with anyone, which is genuinely useful. For an agent that **writes**, it is not a
substitute for `worktree` and must not be used as one.

If two agents share a checkout, give them **distinct file ownership**. Two agents editing one
file is not parallelism.

---

## 5. Subscriptions

`chat_subscribe` scopes by **name**, **tag**, **spawned**, or **all**. Tags are many per session,
and a tag selector matches the _subject's_ tags — "tell me about the agent-teams agents" is a
question about them, not about you. `spawned` is provenance rather than naming — it matches
whatever you yourself have spawned, and `agent_spawn` sets it up for you automatically (see §2).

Two properties worth knowing:

- **Lifecycle only.** `message`, `broadcast`, `question` and `answer` are not subscribable. A
  global subscriber learns who is here, never what they said. Reading a peer's trail is still
  possible through `chat_activity` — explicit, one session at a time, and itself logged.
- **Coalesced.** Three agents starting together arrive as one notification, not three. Peer
  traffic already lengthens turns; a per-event join feed would make that worse for no added
  information.

`all` is real and noisy. Prefer a tag.

A spawner can set an agent's starting tags and subscriptions, so it is listening to the right
things before its first turn rather than depending on the model remembering to subscribe.

---

## 6. Relaying a decision: `chat_endorse`

A peer relaying what a human wants is **not** that human's authority over another agent's work.
That norm is right and it is load-bearing — but it left a gap. On 2026-07-27 one session relayed
four of its human's decisions to peers. One peer refused to act on them, correctly citing the
norm. Another accepted only after checking with its own human. Both were right, and that is
exactly what exposed the problem: the bus could carry _"my human said X"_ and nothing more, so
every cross-session decision cost a round trip through a second human, or stalled.

`chat_endorse` adds the missing third state. A recipient can now tell apart:

| What arrives       | `from`  | `provenance`     | What it means                                                                              |
| ------------------ | ------- | ---------------- | ------------------------------------------------------------------------------------------ |
| Human-authored     | `human` | —                | Your human typed it and sent it.                                                           |
| Agent-authored     | a peer  | —                | That peer's own words, including any claim about a human.                                  |
| **Human-endorsed** | a peer  | `human-endorsed` | The peer composed it; **their** human read those exact bytes and approved delivering them. |

The middle and bottom rows are the distinction that matters. `from` stays the composer in both,
deliberately — the authority is the human's, the words are the agent's, and collapsing the
endorsed case into `from: human` would let an agent's phrasing acquire the appearance of a
human's own.

### The flow

1. The composing agent calls `chat_endorse` with `to` and `text`. **Nothing is sent.**
2. The text lands in the human queue as an `ENDR` item. `agent-chat inbox` prints it in full and
   untruncated, naming the recipient — that print _is_ the thing being endorsed.
3. The human runs `agent-chat endorse <id>` to approve, or `agent-chat dismiss <id>` to decline.
4. On approval the **broker** delivers the stored text. The composer never sends it, and so gets
   no opportunity to alter it between approval and delivery.

### Why you can trust the marker

`provenance` is set in exactly one function, `BrokerCore.endorse`. No client message carries the
field, no tool parameter reaches it, and the approval frame is refused outright from any
registered connection — so no session can endorse its own message or a peer's. This is the same
lesson `source` teaches over `from` on a channel tag: **a marker an agent can set is worth
nothing**, because the whole value is that a recipient can trust it without checking.

### Tool-permission approval is not endorsement

The easiest mistake to make here. Approving a `chat_send` prompt means _"you may call this
tool"_, not _"I endorse this text"_. A human who clicks **don't ask again** grants every future
send in that session with no further attention, so permission approval decays to nothing while
the content varies freely. Endorsement binds to the **specific message body** and to nothing
else.

### The risk this design carries

An endorsed message carries real authority, which points a laundering vector the other way: an
agent that composes something subtly off what its human meant and gets it rubber-stamped has
laundered its own intent into an instruction to a peer. Four things push back on that, and none
of them is enough alone:

- the human sees the exact delivered bytes, in full;
- endorsement covers **one message** — never a session, a peer or a topic, so a second message
  is a second decision;
- the request, its text, and the human's verdict are all rows in the event log, so the record
  shows what was approved and by whom;
- the recipient still weighs it. **An endorsed message is not auto-obeyed by anything.** Even a
  genuine instruction from someone else's principal is not automatically binding on your work.

Composing agents get a budget of 2 open requests. A backlog is the condition under which these
stop being read and start being waved through.

### When not to use it

Your human can already send as themselves with `agent-chat send`. If the message is short and
they are at the keyboard, that is simpler and stronger. `chat_endorse` earns its place when the
relay is long enough that retyping it by hand is the reason it does not happen.

---

## 7. Failure modes we have actually hit

These are not hypothetical. Each cost real time.

**"ok" is not "working".** A successful spawn means a process launched. It does not mean the
agent is running, understood the brief, or did anything. This is the same rule as delivery:
`delivered: true` proves a message reached a _subprocess_, not that a session saw it. The only
evidence a session saw something is **that session quoting it back**.

**Verification is the bottleneck, not generation.** In the session that built most of this, four
bugs were found — a launch path that could never work, tests that opened real windows on the
developer's laptop, a false permission warning on every read-only spawn, and agents silently
running in the wrong repository. **All four were found by measuring, none by reading the code.**
Three would have shipped otherwise. Spawning more writers does not help when checking is the
constraint.

**Never report that something did not happen without a positive control in the same run.** A
broken send path and successful suppression are indistinguishable otherwise.

**Quote the observation, not the conclusion.** A peer can check a log line; they cannot check
your inference, and a wrong conclusion travels further than the observation that would refute
it.

**Suspect yourself before you suspect a peer.** In a shared checkout the ambient hypothesis is
"someone else did this", and it is usually wrong.

**Nobody rewrites history in a shared checkout.** Ownership splits the filesystem; it cannot
split the commit graph. `--amend` and `rebase` target whoever committed last, and the "am I
HEAD?" check expires before the command runs.

**Beware substring filters over session names.** Grepping for `cc-relay` silently excludes
`cc2-relay`. It fails _toward_ false confidence.

---

## 8. When not to spawn

Spawning has a cost that is easy to underweight: a slot, a context, and **someone to read the
output**. Unread agent output is worse than none — it looks like progress.

Spawn when the work needs a second, genuinely longer-lived context: a review that should happen
while you do something else, an exploration whose findings you want but whose search you do not
want in your context, a task that must outlive your session.

Do not spawn to parallelise something you could finish yourself, and do not spawn to look busy.

Good candidates share a shape: **independent, read-mostly, and file-disjoint**. Bad candidates
share files — especially the few modules everything touches, where two agents produce merge
conflicts rather than throughput.

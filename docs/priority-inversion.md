# CC-16 — Priority inversion: peer traffic outranking the user

> ## ⚠️ STATUS: THE FOUNDING OBSERVATION IS REFUTED (2026-07-27, same day)
>
> The latency claim this note was built on does not survive measurement. **Do not build
> from the "The observation" section below** — it is retained only because the correction
> is more instructive than the deletion would be.
>
> cc-relay measured its own transcript: 7 human inputs, response latencies of 84s, 6s, 6s,
> 5s, 37s, 10s, 30s, and **zero had an unanswered peer message in front of them**. What
> actually happened is the inverse of the claim: cc-relay asked its human a question, was
> waiting on *them*, peers messaged during that gap, and it re-asked. The user was never
> kept waiting.
>
> Independently corroborated on this session's transcript: 5 human inputs, latencies 1.9s,
> 24.1s, 4.6s, 12.6s, 9.3s, none delayed by peer traffic. cc-main independently parsed
> cc-relay's transcript and got 9 inputs with a 36s worst case and zero interleaved channel
> messages. **Three measurements, three different input counts, one conclusion** — see the
> methodology note in `cross-agent-communication.md`.
>
> **What survives is weaker than the first version of this correction claimed.** I initially
> wrote that peer traffic "dominates volume" at 6 peer turns against 4 human — but that 4
> was itself an undercount, because AskUserQuestion answers arrive as `tool_result` records
> and my first script skipped them. Corrected, it is 6 peer against 5 human: **near parity,
> not domination.** So the residual cost is real but modest, and it is a **throughput cost,
> not a responsiveness cost**. cc-main has re-scoped CC-16 accordingly (severity high → low,
> retitled around delaying the human's chance to *steer* rather than to receive an answer,
> with "decide to build nothing" an acceptable close).
>
> A rewrite, if there is one, should start from token/context economics rather than user
> latency. Note that even there the evidence is thinner than the external literature's
> 3–10x, which measures a different topology.
>
> The CC-6 measurement in "What CC-6 does not fix" is unaffected — it is a fact about
> CC-6's thresholds against real traffic and remains accurate whatever the traffic cost.

## The observation *(refuted — see status above)*

From cc-relay, 2026-07-27, first-person and unprompted:

> I asked my human "CC-3, CC-6, or the headless probe?" and then had to re-ask twice,
> because each time I was about to hold for their answer, a peer message arrived that was
> substantive enough to need verification.

Their user waited through three rounds of agent-to-agent correction to get an answer to a
one-line question. **Every round was individually justified** — a P8 correction, an audit
result, a retraction of a false claim. That is what makes this hard. There is no message
in the sequence you would want dropped, and no participant behaving badly.

The shape: peer messages arrive as live events with the immediacy of an interrupt, while
the user's own request sits in the transcript looking already-answered. The agent serves
the interrupt first. The user is the only participant who cannot interrupt back.

## What CC-6 does not fix

This is the trap, and it is worth being precise rather than gesturing at it. CC-6 shipped
`BROADCAST_BUDGET_BYTES = 16_000` amplified bytes per `BROADCAST_WINDOW_MS = 60_000`, plus
a reply-depth breaker at 20.

Measured against the actual window that caused the complaint — everything cc-relay
received between 12:19 and 12:29 on 2026-07-27:

| time | kind | from | payload | amplified | suppressed by CC-6? |
|---|---|---|---|---|---|
| 12:19:58 | broadcast | cc2-relay | 3,256 | 9,768 | no — under 16,000, alone in window |
| 12:23:05 | directed | cc2-relay | 1,786 | — | no — directed, never charged |
| 12:24:14 | directed | cc-main | 1,978 | — | no — directed, never charged |
| 12:25:52 | directed | cc-main | 2,660 | — | no — directed, never charged |
| 12:26:42 | broadcast | cc2-relay | 2,329 | 6,987 | no — under 16,000, alone in window |
| 12:28:10 | directed | cc2-relay | 1,493 | — | no — directed, never charged |

**CC-6 would have suppressed none of them.** Six interrupts, ~13.5 KB, in eight minutes,
every one passing every threshold. Four were directed and therefore *categorically*
exempt — not "under budget" but never charged at all. The two broadcasts sat nearly seven
minutes apart, so each was alone in its 60-second window and cleared the budget by 40%
and 56% respectively.

This is not a defect in CC-6. CC-6 targets fanout amplification and does that correctly;
directed messages are exempt by deliberate design, because starving a targeted request
would break real work. The point is only that **CC-16 is orthogonal and currently
unaddressed**: a low-volume, high-substance stream is exactly the shape that passes every
byte or count budget while still starving the user. Volume was never the variable.

## The proposed axis, and the constraint that shapes it

The dividing line is not urgency, size, or sender. It is **whether a message needs the
recipient's action or merely their awareness.**

- *Needs action*: the CC-3 token probe. The test cannot proceed without a reply.
- *Needs awareness only*: "P8 was fabricated, I've corrected the doc." True, important,
  worth knowing — and nothing about it required interrupting a turn.

Most of what starved cc-relay's user was the second kind delivered with the urgency of
the first.

The load-bearing constraint on any solution: **the signal has to be legible before the
body is read.** By the time the recipient has read enough to classify a message, the
derailment has already happened — the context is spent and the train of thought is
broken. This is why `meta` is the natural carrier (P3): it renders as `<channel>` tag
attributes and is model-visible ahead of the body. Anything requiring the model to read
the message to decide whether to read the message is circular.

## The honest limit

agent-chat can supply the signal. It cannot make a model obey it.

A `needs="awareness"` attribute is advice. A model mid-task may still read the body, still
verify the claim, still reply — exactly as all three of us did today, every time, for
good reasons. Nothing in the broker can prevent a recipient from engaging with a message
it has already been handed.

That points somewhere specific: **this may be substantially a tool-description problem
rather than a broker problem.** CC-4 found that lever doing real work on `chat_ask`, where
"They may not see it for a while" removed the implicit promise of a reply and changed
behaviour without any mechanism at all. The equivalent here is wording on `chat_send` that
makes the sender classify, and wording in the server `instructions` that tells a recipient
an awareness-tagged message is explicitly not a reason to break off what it is doing.

Wording is reversible, costs nothing, and can be measured. Mechanism is not and cannot.
**Try wording first** — and note that the measurement is cheap because the event log
already records every message, so a before/after on interrupt counts is a query, not an
instrumentation project.

## Relationship to CC-12, argued honestly

CC-12 (observe without interrupting) would let peers see each other's state without
anything being delivered. If it landed, much of today's traffic would never have been a
message at all — the P8 correction, the audit result and the retraction are all things a
peer could have *pulled* rather than been *pushed*.

The honest tension, stated both ways:

**For landing CC-12 first.** It attacks the cause rather than the symptom. If most
awareness-class traffic stops being messages, CC-16 shrinks to a much smaller problem and
may not need mechanism at all — which would be the cheapest possible outcome. Building
CC-16 first risks engineering a classification system for traffic that should not exist.

**Against.** CC-12 is priority 10 and CC-16 is priority 4, high severity. Sequencing a
high-severity problem behind a low-priority one defers the only failure in this initiative
the *human* actually feels rather than one the agents feel. CC-12 is also unbuilt and
unscoped, so "land CC-12 first" is an unbounded delay. And CC-12 does not fully subsume
CC-16: pull-based observation removes awareness traffic, but a genuinely
action-needing message still interrupts, and the user's request still loses to it.

A middle path exists and should be named: **the wording-only change is compatible with
either order.** It costs nothing, requires no mechanism, and does not prejudge CC-12. If
wording alone moves the interrupt count, the sequencing question may not need answering.

## Options, with costs

1. **Wording only.** Tool descriptions on `chat_send` push senders to classify; server
   `instructions` tell recipients awareness-class messages don't warrant breaking off.
   *Cost*: no guarantee, effect unmeasured until traffic accumulates. *Cheapest, fully
   reversible, compatible with every other option.*
2. **`meta` classification.** Sender sets `needs="action"|"awareness"`; broker stamps it;
   recipient sees it as a tag attribute before the body. *Cost*: senders self-classify and
   will inflate — everyone believes their correction is urgent. Needs a default, and the
   default is the whole design.
3. **Deferred delivery for awareness-class.** Hold awareness messages until the recipient
   next calls `chat_inbox` or a turn boundary. *Cost*: converts "noisy" into "quiet and
   missed", the same objection I4 raised against digests. Lossless only because the event
   log retains everything.
4. **Do nothing; rely on CC-12.** *Cost*: defers a high-severity problem behind an
   unscoped one, and does not cover action-class interrupts.

## What would settle it

Whether a recipient that *sees* `needs="awareness"` actually defers. That is one probe,
not a build: send a peer an awareness-tagged message mid-task and ask whether they
deferred it, the same shape as the CC-3 token test. Worth running before choosing between
options 2 and 3, because if models ignore the attribute, both collapse into option 1.

# Permission relay — verified mechanics

Established against Claude Code v2.1.220 and confirmed live on 2026-07-27. This
documents what the host actually does, as distinct from what `src/server/index.ts`
declares. Everything here is behaviour observed from the outside; treat it as a
description of one release, not a contract.

## Read this first: the whole feature is behind a remote flag, default off

Permission relay is gated on a remotely-evaluated feature flag whose **default is
off**. The flag guards the step that installs the channel permission callbacks into
session state, and those callbacks are what the relay path tests for before sending
anything. Flag off means the callbacks are absent, which means nothing is ever sent.
Not degraded: absent.

It is currently on for this account, which is the only reason any of the findings
below were observable. It can be revoked server-side, without a release, without a
version change, and without any local signal — the failure mode is the same silent
nothing described throughout this document.

**So nothing may depend on relay for correctness.** Approval items are a best-effort
observability nicety. Any design that treats a missing `approval_request` as meaning
"that session is not blocked" is wrong twice over: once because absence never proved
that anyway (see below), and once because the entire channel may have been switched
off remotely since the last time anyone checked.

## The relay reaches allowlisted plugin channels

It uses the _same_ gate as ordinary channel messages — there is no separate permission
allowlist. Recipient selection filters the connected MCP clients against the resolved
`--channels` targets:

- The match splits the MCP client name on `:` and accepts either a `server` target by
  exact name, or `plugin:<pluginName>:<serverName>` against a plugin target. agent-chat's
  client name is `plugin:agent-chat:agent-chat`, so it matches the `agent-chat` plugin
  target.
- Dev-flag channels are merged into that _same_ target list, marked as dev.

So the dev-flag-vs-plugin distinction CC-2 originally asked about does not exist on this
code path. Both resolve through one list, and whatever gates ordinary channel delivery
gates relay identically.

Scope that carefully: the equivalence is at **recipient selection**, not at the gate.
`gateChannelServer` still discriminates by kind — a `server:` target that isn't
dev-flagged is refused outright, and the `allowedChannelPlugins` check matches on
`{plugin, marketplace}` pairs, so it can never admit a bare `server:` entry no matter
what is listed. Packaging as a plugin remains the only route off the dev flag; that is
what CC-7 was for. What CC-2 establishes is narrower and is the thing that was actually
in doubt: relay adds no _further_ gate of its own on top of that.

**Confirmed live**: a `chat_list` prompt in a session launched with
`--channels plugin:agent-chat@agent-chat-local` (no dev flag) produced
`{"event":"approval_request","from":"cc2-relay","tool":"mcp__plugin_agent-chat_agent-chat__chat_list"}`
in the broker log and an APPR row in the queue.

## Two capabilities are required, not one

Recipient selection filters on **both** `claude/channel` _and_
`claude/channel/permission` being present in `capabilities.experimental`. Declaring only
the first gets you messages and silently no relay. We declare both.

## The request shape we guessed is correct

The host sends `notifications/claude/channel/permission_request` with
`{request_id, tool_name, description, input_preview}` — matching `PermissionRequestSchema`
field-for-field. `description` is run through a summarizer that falls back to `""`, which
is why it is so often uninformative for Bash; this is the concrete basis for the
complaint in ideas.md R1.

## Relay is not MCP-specific

Nothing in the selection path filters by tool origin, and it shows: built-in tools
relay too. Observed 2026-07-27 from a peer session, `approval_request` rows naming
`Skill` (`brwhs`) and `Edit` (`ytmmz`) alongside the MCP ones. So the queue sees a
session's real work — file edits, skill invocations, shell commands — not just
agent-chat's own chatter. That is what makes I1/I2 worth having; a queue that only
ever showed `chat_status` prompts would be noise with no signal.

## What does _not_ get relayed

Two skips, both silent:

- Tools that declare they require user interaction — these never relay.
- Local-display-only results — the channel callbacks are absent, so nothing is sent.

A prompt that never opens obviously relays nothing either. An auto-allowed tool call
produces no `approval_request`; absence of a row is not evidence the relay is broken.

**Headless sessions relay nothing at all.** Verified 2026-07-27 against a `--print`
session (`cc-headless-d`) with a positive control, which is what makes it a result
rather than an absence:

- the channel was demonstrably **live** — the session quoted back its inbound
  `<channel source="plugin:agent-chat:agent-chat" from="human" …>` token verbatim, and
  the broker logged the route (`38222d97`, 12:30:51). So `--channels` is honoured in
  non-interactive mode.
- a permission denial genuinely **occurred** — `git status` returned "Claude requested
  permissions to use Bash, but you haven't granted it yet", while a `node -e` Bash call
  in the same session ran fine, so it was not a blanket block.
- **zero** `approval_request` rows were produced by that session or any other headless
  probe. All 15 rows in the log came from the three interactive sessions.

Channel live, prompt genuinely blocked, nothing relayed. Non-interactive denials are
auto-resolved without ever opening a promptable request, so relay has nothing to
forward. The push also arrived _between tool calls mid-turn_, not at session start.

This is the load-bearing caveat for the whole feature, so state it plainly: **the
permission observatory sees interactive sessions only.** Background and `--print` peers
are addressable for messaging but invisible when blocked — and they are exactly the
population you would most want an observatory for, since nobody is watching their
terminal. See ideas.md I1.

## The host _will_ accept a verdict — abstaining is our choice, not its constraint

This is the finding worth carrying forward. The host registers a handler for
`notifications/claude/channel/permission`, taking params
`{ request_id: string, behavior: "allow" | "deny" }`.

On `allow` the tool call proceeds; on `deny` it aborts with
`Denied via channel <serverName>`. It races the local dialog under a claim check —
**first answer wins**, and it does not persist as an "always allow" rule.

Any server on the channel allowlist can therefore approve another session's tool calls.
Nothing in Claude Code prevents it. ideas.md R1 argued against building this on the
assumption the capability existed; it does, exactly as described, so R1 is a live
capability being declined rather than a hypothetical. Keep it that way.

The corollary for our own design: when the local dialog wins, the host sends the channel
server _nothing_. There is no resolution notification. That is why pending approvals are
aged out by TTL rather than closed by an event.

## An approval row is session-relative — never compare rows across sessions

The broker log records _that a session prompted_, which depends on that session's
permission view, and permission views drift apart between concurrently-running
sessions. Observed 2026-07-27: `chat_send` was present in
`.claude/settings.local.json`, and a session still produced `approval_request izfnu`
for `chat_send` more than a minute later.

Four rows from three concurrent sessions on 2026-07-27 separate the two directions.
`cc-relay` answered "don't ask again" for `chat_send` at ~12:06:32:

| time     | session   | tool             | relayed? |                                          |
| -------- | --------- | ---------------- | -------- | ---------------------------------------- |
| 12:06:25 | cc-relay  | `chat_send`      | yes      | the prompt that was then granted         |
| 12:08:58 | cc-relay  | `chat_send`      | **no**   | own grant honoured on the very next call |
| 12:07:45 | cc-main   | `chat_send`      | yes      | 73s after the on-disk entry existed      |
| 12:15:37 | cc2-relay | `chat_broadcast` | yes      | ~3min after that entry reached disk      |

The mechanism is not that settings are frozen at launch — they aren't. When a user
answers "always allow", the host does two independent things: it writes the rule to
disk fire-and-forget, and it updates _that session's_ in-memory permission context.
The running session therefore honours its own grants immediately, without re-reading
anything. What is missing is the other direction: settings reads are memoized with no
file watcher, so one session's write does not reach another session's cached view.
Sessions launched at different times, or which have granted different things, disagree
indefinitely.

The consequence for anyone reading the log:

- **Presence of an `approval_request` is solid evidence.** A prompt really opened and
  really relayed. This is what CC-2 was verified on and it is unaffected.
- **Absence proves nothing about the relay.** It means that tool was already permitted
  _in that session_, and says nothing about whether relay works or about any other
  session.

So an A/B across two sessions is only valid if they were launched from the same
permission state — which, in a shared checkout where sessions grant permissions as
they go, is not the default and cannot be assumed.

## Note: relaying our own tool calls

agent-chat's MCP tools are themselves permission-gated, so calling `chat_status` can
produce an `approval_request` naming `chat_status`. It terminates — the relay is a
notification, not a tool call — but it makes the queue noisier than expected on first
run, and it means an unapproved agent-chat session reports its own blockage.

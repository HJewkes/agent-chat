# Permission relay — verified mechanics

Read out of the Claude Code binary (v2.1.220) and confirmed live on 2026-07-27.
This documents what the host actually does, as distinct from what `src/server/index.ts`
declares. Symbol names are minified and will drift between releases; the shapes won't.

## The relay reaches allowlisted plugin channels

It uses the *same* gate as ordinary channel messages — there is no separate permission
allowlist. Recipient selection is:

```js
SSd(clients, name => Sft(name, k0()) !== undefined)
```

- `k0()` returns `Mt.allowedChannels`, the resolved `--channels` targets.
- `Sft(name, targets)` splits the MCP client name on `:` and matches either
  `kind:"server"` by exact name, or `plugin:<pluginName>:<serverName>` against a
  `{kind:"plugin", name}` entry. agent-chat's client name is
  `plugin:agent-chat:agent-chat`, so it matches the `agent-chat` plugin target.
- Dev-flag channels are merged into that *same* array with `dev:true`.

So the dev-flag-vs-plugin distinction CC-2 originally asked about does not exist on this
code path. Both resolve through one list, and whatever gates ordinary channel delivery
gates relay identically.

Scope that carefully: the equivalence is at **recipient selection**, not at the gate.
`gateChannelServer` still discriminates by kind — a `server:` target that isn't
dev-flagged is refused outright, and the `allowedChannelPlugins` check matches on
`{plugin, marketplace}` pairs, so it can never admit a bare `server:` entry no matter
what is listed. Packaging as a plugin remains the only route off the dev flag; that is
what CC-7 was for. What CC-2 establishes is narrower and is the thing that was actually
in doubt: relay adds no *further* gate of its own on top of that.

**Confirmed live**: a `chat_list` prompt in a session launched with
`--channels plugin:agent-chat@agent-chat-local` (no dev flag) produced
`{"event":"approval_request","from":"cc2-relay","tool":"mcp__plugin_agent-chat_agent-chat__chat_list"}`
in the broker log and an APPR row in the queue.

## Two capabilities are required, not one

`SSd` filters on **both** `claude/channel` *and* `claude/channel/permission` being
present in `capabilities.experimental`. Declaring only the first gets you messages and
silently no relay. We declare both.

## The request shape we guessed is correct

The host sends `notifications/claude/channel/permission_request` with
`{request_id, tool_name, description, input_preview}` — matching `PermissionRequestSchema`
field-for-field. `description` is run through a summarizer that falls back to `""`, which
is why it is so often uninformative for Bash; this is the concrete basis for the
complaint in ideas.md R1.

## What does *not* get relayed

Two skips, both silent:

- `t.tool.requiresUserInteraction?.()` — these never relay.
- `localDisplayOnly` results — the channel callbacks are undefined, so nothing is sent.

A prompt that never opens obviously relays nothing either. An auto-allowed tool call
produces no `approval_request`; absence of a row is not evidence the relay is broken.

## The host *will* accept a verdict — abstaining is our choice, not its constraint

This is the finding worth carrying forward. The host registers a handler for
`notifications/claude/channel/permission`:

```js
MHs = z.object({
  method: z.literal('notifications/claude/channel/permission'),
  params: z.object({ request_id: z.string(), behavior: z.enum(['allow', 'deny']) }),
})
```

On `allow` it calls `buildAllow(input)` and the tool call proceeds; on `deny` it aborts
with `Denied via channel <serverName>`. It races the local dialog under a `claim()`
check — **first answer wins**, and it does not persist as an "always allow" rule.

Any server on the channel allowlist can therefore approve another session's tool calls.
Nothing in Claude Code prevents it. ideas.md R1 argued against building this on the
assumption the capability existed; it does, exactly as described, so R1 is a live
capability being declined rather than a hypothetical. Keep it that way.

The corollary for our own design: when the local dialog wins, the host sends the channel
server *nothing*. There is no resolution notification. That is why pending approvals are
aged out by TTL rather than closed by an event.

## An approval row is session-relative — never compare rows across sessions

The broker log records *that a session prompted*, which depends on that session's
permission view, and permission views drift apart between concurrently-running
sessions. Observed 2026-07-27: `chat_send` was present in
`.claude/settings.local.json`, and a session still produced `approval_request izfnu`
for `chat_send` more than a minute later.

The mechanism is not that settings are frozen at launch — they aren't. When a user
answers "always allow", `persistPermissions` does two independent things: `wfe(d)`
writes the rule to disk fire-and-forget, and `ste(...)` updates *that session's*
in-memory permission context. The running session therefore honours its own grants
immediately, without re-reading anything. What is missing is the other direction:
settings reads are memoized (`Tqn` over the `E2n` map) with no file watcher, so one
session's write does not reach another session's cached view. Sessions launched at
different times, or which have granted different things, disagree indefinitely.

The consequence for anyone reading the log:

- **Presence of an `approval_request` is solid evidence.** A prompt really opened and
  really relayed. This is what CC-2 was verified on and it is unaffected.
- **Absence proves nothing about the relay.** It means that tool was already permitted
  *in that session*, and says nothing about whether relay works or about any other
  session.

So an A/B across two sessions is only valid if they were launched from the same
permission state — which, in a shared checkout where sessions grant permissions as
they go, is not the default and cannot be assumed.

## Note: relaying our own tool calls

agent-chat's MCP tools are themselves permission-gated, so calling `chat_status` can
produce an `approval_request` naming `chat_status`. It terminates — the relay is a
notification, not a tool call — but it makes the queue noisier than expected on first
run, and it means an unapproved agent-chat session reports its own blockage.

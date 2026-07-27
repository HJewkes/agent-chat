# agent-chat

Cross-session messaging between Claude Code sessions on one machine, delivered
through the experimental **channels** capability.

Sessions register a name, see who else is active, and send each other messages
that arrive _in the running session_ — not in a fresh cloud sandbox, not on the
next poll. Agents can also escalate to you, and you answer from a terminal.

> **Status: proof of concept.** Channels are a research preview and the flag
> syntax may change. See [Limits](#limits).

## Why it works the way it does

Claude Code spawns an MCP server as a **subprocess per session**. That
subprocess holds exactly one stdio pipe, pointing at exactly one session — so
the process _is_ the session's address. Routing to a session means "the
subprocess registered as `bob` emits the notification and the others don't."

That's fortunate, because the channel protocol has nowhere to put an address:

```ts
mcp.notification({ method: 'notifications/claude/channel', params: { content, meta } }) // the entire schema
```

Two consequences fall out for free:

- **Registration is the delivery filter.** There's no separate subscription model.
- **Process lifetime is the registration lease.** A dead session drops its
  socket, which deregisters it and kills the route. No heartbeats, no TTLs, no
  stale-entry reaper.

## The log is the source of truth

Delivery is a side effect; the record is an append-only SQLite event log. Every
message, question, notice, answer, registration and routing failure is a row.
Derived state is always a query, never a stored aggregate:

| View                | Query                                                                                |
| ------------------- | ------------------------------------------------------------------------------------ |
| a session's inbox   | events where `target = name`                                                         |
| the human queue     | events where `target = 'human'` and nothing references them as answered or dismissed |
| the question budget | open `question` rows per actor                                                       |

Resolution is itself an event, so nothing is ever mutated or deleted. Two things
follow that are worth having: a session's inbox now **survives a broker restart**,
and an answer written to a session that has just died isn't lost — it's in the
log, and that session picks it up from `chat_inbox` when it comes back.

```
session A ─┐                        ┌─ agent-chat mcp ── stdio ── session A
session B ─┼─ agent-chat mcp ─ unix ┤
session C ─┘                 socket └─ broker ── events.db (append-only)
     you ──── agent-chat inbox ─────┘
```

## The human is a queue, not a session

Nothing holds a socket for you, so items accumulate whether or not you're
looking. `human` is a reserved name — a session cannot register as it, which also
closes off a session inheriting your authority in how peers read the `from`
attribute.

Three kinds of item, distinguished by whether they need an answer:

| Kind         | Needs an answer | Raised by                                          |
| ------------ | --------------- | -------------------------------------------------- |
| **question** | yes             | `chat_ask`                                         |
| **notice**   | no              | `chat_notify`                                      |
| **message**  | no              | `chat_send(to: "human")`                           |
| **approval** | yes             | permission relay — [not built yet](#not-built-yet) |

```
$ agent-chat inbox
ASK   f2fa2fcd  bob            2m ago
      the adapter test needs real hardware — skip it or mock the BLE layer?
note  d62dfb07  carol          2m ago
      docs pass done, 3 dead links found

2 waiting, 1 needing an answer.
answer with: agent-chat answer <id> "..."

$ agent-chat answer f2fa2fcd "mock the BLE layer, keep hardware behind a flag"
```

The answer routes back to whoever asked, arriving as a channel message with
`in_reply_to` set. Sessions are limited to **3 open questions** — "ask the human"
is cheaper for an agent than deciding, and the budget forces triage.

## Setup

```bash
npm install && npm run build
claude mcp add agent-chat -- node /Users/you/projects/agent-chat/dist/cli.js mcp
claude --dangerously-load-development-channels server:agent-chat
```

The dev flag is required while channels are in research preview — a bare
`server:` entry can never be allowlisted, only a packaged plugin can.

The broker starts itself on first use and outlives the session that spawned it.
State lives in `~/.agent-chat/` (`chat.sock`, `events.db`, `broker.log`);
override with `AGENT_CHAT_HOME`.

## Tools

| Tool                                | Purpose                                     |
| ----------------------------------- | ------------------------------------------- |
| `chat_register(name, working_on)`   | Announce this session. Call once at start.  |
| `chat_status(status, working_on?)`  | `working` / `available` / `blocked`.        |
| `chat_list()`                       | Who's active, their status, work, and cwd.  |
| `chat_send(to, text, in_reply_to?)` | Message one session by name.                |
| `chat_broadcast(text)`              | Message everyone else.                      |
| `chat_ask(text)`                    | Ask the human. Budgeted, non-blocking.      |
| `chat_notify(text)`                 | Leave the human a notice needing no answer. |
| `chat_inbox(limit?)`                | Re-read recent messages, including answers. |

Inbound messages arrive as `<channel source="agent-chat" from="alice"
msg_id="a1b2c3d4">`, plus `in_reply_to` and `broadcast` when they apply.

## CLI

```
agent-chat inbox                what your agents need from you
agent-chat answer <id> <text>   answer; routes back to the asker
agent-chat dismiss <id>         close an item without answering
agent-chat send <to> <text>     message a session as the human
agent-chat ps                   who's registered
agent-chat history [n]          recent events from the log
agent-chat broker               run the broker in the foreground
agent-chat mcp                  the MCP server (Claude Code spawns this)
```

## Tests

```bash
npm run build && npm test
```

40 checks across three suites. `registry.test.ts` covers live routing decisions,
`event-log.test.ts` covers the projections, and `routing.test.ts` drives real MCP
sessions over stdio. The properties that matter:

- a directed message reaches the addressee **and nobody else**
- an unknown recipient is refused rather than fanned out
- a reply carries `in_reply_to` back to the original `msg_id`
- a broadcast reaches everyone _except_ the sender
- an inbox replays only what that session received, and survives a restart
- a question leaves the queue when answered or dismissed, and only then
- an answer routes back to the asker as a channel message
- the question budget counts only _unanswered_ questions, per session
- reserved names are refused, so no session can register as `human`
- a name is rejected while held, released on exit, then reclaimable

## Limits

**Delivery is fire-and-forget.** `mcp.notification()` is unacknowledged — "Delivered"
means "written to a pipe," nothing more. Messages land on the recipient's _next
turn_, and several arriving while they're busy are batched into one. Nothing
blocks waiting for a reply: that would deadlock two sessions each awaiting the
other's turn.

**No rate limiting.** At five sessions, one broadcast is four derailed turns, and
every delivered message is a permanent context cost in the recipient's transcript.
`chat_broadcast` says "use sparingly" and that is currently the only control.

**No reply-loop breaker.** Two polite agents that each answer the other will
ping-pong indefinitely, burning tokens in both while you see nothing.

**`idleMs` is a proxy.** It measures time since this session last called a
`chat_*` tool, not since it last did anything. A session deep in a long task
looks idle.

**Peer messages are not user instructions.** The server `instructions` tell Claude
to treat inbound text as information from a peer rather than its user's authority,
and never as approval for a pending permission prompt. The socket is `0600`, so
the trust boundary is the OS account.

**The dev flag is required per session.** `--channels` accepts `server:<name>`,
but a `kind: "server"` entry has no allowlist path in Claude Code's gate — only
`kind: "plugin"` does.

## Not built yet

- **Permission relay** (`claude/channel/permission`), which is what makes the
  `approval` item kind real. Claude Code can forward a session's tool-approval
  prompts to the channel server; because `request_id` is never shown in the
  terminal dialog, a channel server is the only thing on the machine that can
  enumerate pending prompts. Ship it **observe-only** first — see
  [docs/ideas.md](docs/ideas.md) for why routing verdicts between _sessions_ is a
  bad idea.
- Broadcast rate limiting and a reply-depth circuit breaker.
- Plugin packaging, to drop the dev flag.
- Path claims — reusing the lease primitive for files instead of nicknames.

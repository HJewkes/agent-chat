# agent-chat

Cross-session messaging between Claude Code sessions on one machine, delivered
through the experimental **channels** capability.

Sessions register a name, see who else is active, and send each other messages
that arrive _in the running session_ — not in a fresh cloud sandbox, not on the
next poll. Agents can also escalate to you, and you answer from a terminal.

> **Status: proof of concept.** Channels are a research preview and the flag
> syntax may change. See [Limits](#limits).

## Docs

**Start here: [`docs/working-as-a-team.md`](docs/working-as-a-team.md)** — the
canonical, current guide to how the tools fit together. Everything else in
`docs/` is context, not required reading:

| Doc                                    | What it is                                                                                                        |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `working-as-a-team.md`                 | Current guide — how the tools compose, day to day.                                                                |
| `demo-walkthrough.md`                  | Current guide — a live runbook for sanity-checking what's shipped.                                                |
| `permission-relay.md`                  | Current guide — verified mechanics of the permission relay, as built.                                             |
| `phone-queue.md`                       | Current guide — `agent-chat mirror`: the human queue in a Matrix room on your phone.                              |
| `cross-agent-communication.md`         | Lessons learned from real multi-session runs; the evidence behind the messaging rules in `working-as-a-team.md`.  |
| `teleport.md`                          | Design record — implemented; §14 records where the build diverged from the design.                                |
| `agent-teams.md`                       | Design record — Parts 1-2 shipped (identity, spawning, supervision); Part 3 is still a plan. See its §11.         |
| `notes-a4-surfaces.md`                 | Implementation notes — what got built for surfaces, and seams left open.                                          |
| `notes-a5-isolation.md`                | Implementation notes — the isolation strategies, as implemented.                                                  |
| `priority-inversion.md`                | Explored and rejected — founding observation was refuted the same day; kept for the correction, not the claim.    |
| `context-budget-research.md`           | What a running session can learn about its own context fill and account budget, and where each figure comes from. |
| `adr-event-store.md`                   | Decision record — why the event log is append-only SQLite with derived views.                                     |
| `replacing-built-in-agent-dispatch.md` | Why this machine routes agent dispatch through the bundled skill instead of Claude Code's own Agent tool.         |
| `egress-scan.md`                       | Current guide — the pre-push egress scan, its CI job, `.egress-allow` and the private term list.                  |
| `ideas.md`                             | Backlog — ideation only, ranked, nothing implemented.                                                             |

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

Plain notices (a `notice` with no item kind) also age out of the human queue at
read time once older than `noticeTtlHours` in `~/.agent-chat/config.json`
(default 72). No row is written, so the log is unchanged and old notices drop out
with no backfill. Questions, approvals, endorsements and kinded notices
(`ready-to-merge`, `needs-grant`, `stalled`) stay until answered or dismissed.

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

| Kind         | Needs an answer | Raised by                                    |
| ------------ | --------------- | -------------------------------------------- |
| **question** | yes             | `chat_ask`                                   |
| **notice**   | no              | `chat_notify`                                |
| **message**  | no              | `chat_send(to: "human")`                     |
| **approval** | yes             | permission relay — `agent-chat approve <id>` |

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
`in_reply_to` set. To answer from your phone instead, `agent-chat mirror` projects this
queue into a Matrix room; see [`docs/phone-queue.md`](docs/phone-queue.md). Sessions are limited to **3 open questions** — "ask the human"
is cheaper for an agent than deciding, and the budget forces triage.

## Setup

You need Claude Code with the **channels** research preview available to your
account. Channels are what deliver a message into an already-running session; the
tools work without them, but every push is silently discarded.

agent-chat ships as a plugin, so no dev flag is needed. Build it, tell the plugin
where the build lives, allowlist it, then launch with `--channels`:

```bash
git clone https://github.com/HJewkes/agent-chat && cd agent-chat
npm install && npm run build

# Claude Code copies an installed plugin into its own cache and will not resolve
# paths outside that copy, so the plugin shim has to be told where the real
# checkout is. Without this step it exits with "cannot locate the agent-chat
# server" and the session comes up with no chat tools.
mkdir -p ~/.agent-chat && echo "$PWD" > ~/.agent-chat/mcp-home

claude plugin marketplace add "$PWD"
claude plugin install agent-chat@agent-chat-local
claude --channels plugin:agent-chat@agent-chat-local
```

`AGENT_CHAT_REPO=<repo root>` or `npm link` both work in place of the `mcp-home`
file; the shim tries them in that order. Note the variable is `AGENT_CHAT_REPO`,
not `AGENT_CHAT_HOME` — the latter relocates the runtime state directory holding
the socket, and setting it here would partition sessions from each other.

The allowlist entry lives in machine-wide managed settings, at
`/Library/Application Support/ClaudeCode/managed-settings.json` on macOS and
`/etc/claude-code/managed-settings.json` on Linux:

```json
{
  "channelsEnabled": true,
  "allowedChannelPlugins": [{ "marketplace": "agent-chat-local", "plugin": "agent-chat" }]
}
```

Installing and allowlisting grants _permission_; it does not activate anything.
Without `--channels` naming the plugin at launch, the server's tools still work
and its channel pushes are silently discarded. The gate logs nothing when it
drops them, so "the plugin connected fine" is never evidence — only an inline
`<channel>` tag is.

The broker starts itself on first use and outlives the session that spawned it.
State lives in `~/.agent-chat/` (`chat.sock`, `events.db`, `broker.log`);
override with `AGENT_CHAT_HOME`.

Set `AGENT_CHAT_NO_AUTOSTART=1` to stop the CLI starting a broker: when none is
listening, a verb prints one stderr line starting `broker unavailable` and exits 69
(`EX_UNAVAILABLE`), so a caller can tell a down broker from any other failure. Only
`1` enables it. `agent-chat agent resume <name> --message-stdin` reads the resume
message from stdin instead of `--message`, keeping the text out of `ps` and argv limits.

## Tools

| Tool                                                                      | Purpose                                                                                                              |
| ------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `chat_register(name, working_on, declared?)`                              | Announce this session. Call once at start.                                                                           |
| `chat_status(status, working_on?, dnd?, declared?)`                       | `working` / `available` / `blocked`; set `dnd` to hold peer pushes.                                                  |
| `chat_list()`                                                             | Who's active, their status, work, tags, and where.                                                                   |
| `chat_send(to \| to_tag, text, in_reply_to?)`                             | Message one session, a named list, or everyone carrying a tag.                                                       |
| `chat_tag(target?, add?, remove?)`                                        | Label yourself or a peer by role, e.g. `owner:src`. Not authorization.                                               |
| `chat_activity(name, limit?)`                                             | See what a peer has been doing, without interrupting it.                                                             |
| `chat_broadcast(text)`                                                    | Message everyone else. Use sparingly.                                                                                |
| `chat_ask(text)`                                                          | Ask the human. Budgeted, non-blocking.                                                                               |
| `chat_endorse(to, text)`                                                  | Have the human approve a message, then deliver it under your authority.                                              |
| `chat_notify(text)`                                                       | Leave the human a notice needing no answer.                                                                          |
| `chat_inbox(limit?)`                                                      | Re-read recent messages, including answers.                                                                          |
| `chat_subscribe(scope, target?, kinds?)`                                  | Be told when sessions or agents join or leave.                                                                       |
| `chat_unsubscribe(scope?, target?)`                                       | Stop being told; omit both to drop every subscription.                                                               |
| `agent_spawn(name, profile, brief, inherit?, worktree?, remote_control?)` | Spawn a durable peer. `inherit: "context"` copies YOUR conversation; `remote_control: true` opts in (headless: n/a). |
| `agent_teleport(handoff, model?, remote_control?)`                        | End this session for a successor on the current build. Keeps a `--remote-control` launch; the arg overrides.         |
| `agent_surface(name)`                                                     | Pull a headless agent into a visible terminal.                                                                       |
| `agent_background()`                                                      | Send yourself headless, releasing your terminal.                                                                     |
| `agent_profiles()`                                                        | List spawnable profiles: model, tool set, surface, isolation.                                                        |
| `agent_list()`                                                            | List durable agents with lifecycle state and whether attached.                                                       |
| `agent_logs(name, limit?)`                                                | Read a headless agent's settings-level permission-denial trace.                                                      |
| `chat_transcript(name?, limit?)`                                          | Recent turns of a session's own transcript.                                                                          |

`chat_list` splits what it knows about a session by trust, not by topic (CC-11).
The **observed** half — git branch, checkout, whether that checkout is a linked
worktree — is derived from the session's own process at registration; no tool
parameter reaches it, so no model can assert it. The **declared** half is an open
bag of short `key=value` labels the session chose for itself (`role`,
`initiative`, `task`, whatever a fleet finds useful), rendered marked
`(self-reported)` so a reader never mistakes a claim for a fact. Declared labels
are capped at 8 keys, 64 characters each and 512 bytes in total: every session on
the machine reads them, so an uncapped bag is a way to spend everyone else's
context. Two sessions sharing a checkout now also produce a notice to the human
even when they described their work differently — the text comparison alone
could not see that case.

`chat_transcript` reads the per-session log Claude Code writes to
`~/.claude/projects/<slug>/<session-id>.jsonl` whether or not anyone looks at it,
so observing a session costs it nothing and does not interrupt it. **It is not
gated.** Any session on this machine may read any other's, by explicit decision
(CC-19, 2026-07-27): there is no opt-in and no consent handshake, and the trust
boundary is the OS account, the same as for the socket. Assume your own
transcript is readable by every other session here.

Inbound messages arrive as `<channel source="plugin:agent-chat:agent-chat"
from="alice" msg_id="a1b2c3d4" thread_depth="1">`, plus `in_reply_to` and
`broadcast` when they apply, and `thread_hint="wrap_up"` on a long chain.
`source` is set by Claude Code from the server name and cannot be spoofed;
`from` is chosen by the sender and can be.

## CLI

```
agent-chat inbox                what your agents need from you
agent-chat answer <id> <text>   answer; routes back to the asker
agent-chat dismiss <id>         close an item without answering
agent-chat approve <id> allow|deny
                                answer an agent's permission prompt
agent-chat send <to> <text>     message a session as the human
agent-chat mirror start|stop|status
                                the queue on your phone (docs/phone-queue.md)
agent-chat burndown plan|status dry run: the task each opted-in initiative
                                would dispatch next, and every refusal
agent-chat burndown install|uninstall|job-status
                                the launchd tick job (docs/burndown.md)
agent-chat gh-write -- <gh args...>
                                one gh write, spaced machine-wide (config.json
                                ghWriteGapSeconds, default 3) and retried on
                                GitHub's secondary rate limit (60 s, 120 s, 300 s)
agent-chat suite-slot -- <command...>
                                run a full test suite holding one of the
                                machine-wide full-suite slots (config.json
                                fullSuiteSlots, default 4)
agent-chat ps                   who's registered
agent-chat history [n]          recent events from the log
agent-chat broker               run the broker in the foreground
agent-chat mcp                  the MCP server (Claude Code spawns this)
```

Implementer briefs should use `agent-chat gh-write --` for merge PUTs, PR creates, comments and PR body PATCHes, since every seat and agent shares one GitHub user and so one secondary rate limit. It passes gh's stdout, stderr and exit code through; stdin is not forwarded, so send bodies with `-f`/`-F` or `--input <file>`. GitHub rejects a secondary-rate-limited request without performing it, so retrying after a rate-limit response cannot apply a write twice. Any other failure is never retried, because repeating a non-idempotent POST could duplicate it. Nothing sleeps while holding the lock: a writer that must wait records when the next write may start, releases the lock, and waits outside it.

### The gh shim on a spawned agent's PATH (CC-395)

gh's `pr view`, `pr list` and `pr checks` read through GraphQL. Every agent on the machine shares one GitHub user, so they share one hourly GraphQL budget. To keep agents off that budget, `run-agent` writes a `gh` script into `<state dir>/gh-shim/` at each launch and puts that directory first on the agent's `PATH`. Nothing in `~/.claude*` or the profiles is touched. The script runs `dist/gh-shim/main.js`, which answers these shapes from REST through `gh api`:

| Command                       | Handled flags                                                                                                             | REST reads                                                                                     |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `gh pr view [n\|url\|branch]` | `--json` (required), `--jq`/`-q`, `--repo`/`-R`                                                                           | `pulls/<n>`; `pulls/<n>/files`; check runs, statuses and workflow runs for `statusCheckRollup` |
| `gh pr list`                  | `--json` (required), `--jq`, `--repo`, `--state`, `--head`, `--base`, `--limit` (up to 100)                               | `pulls?state=`                                                                                 |
| `gh pr checks [n]`            | `--json`, `--jq`, `--repo`; without `--json` it prints gh's tab-separated table and exits 1 on a failure, 8 while pending | `pulls/<n>`, `commits/<sha>/check-runs`, `commits/<sha>/status`, `actions/runs?head_sha=`      |
| `gh run view <id>`            | `--json` (required), `--jq`, `--repo`                                                                                     | `actions/runs/<id>`, `actions/runs/<id>/jobs`                                                  |
| `gh run watch <id>`           | `--repo`, `--exit-status`, `--interval`/`-i` (default 3 s), `--compact`                                                   | `actions/runs/<id>` per poll, then its jobs                                                    |

JSON output uses gh's field names and its compact, key-sorted form. `--jq` runs through `jq -rc`, which matches gh's output. Without `jq` on `PATH`, the command passes through. `author.name` is always empty, because REST does not return it. `pr view` and `pr list` refuse fields that REST cannot answer, such as `reviewDecision`, `commits` and `mergeable` on a list. Those commands pass through.

Every other command goes to the real gh with its argv untouched, writes included, and so does any command whose flags, fields or selector the shim does not recognise. When a REST read fails, the shim prints nothing and reruns the command on the real gh, so the error shown is gh's own. Set `AGENT_CHAT_GH_SHIM_OFF=1` to send every command straight through. The shim takes effect for agents launched after a broker restart.

## Restart window

`scripts/restart-window.sh` runs the daily broker restart in one command. It refuses, one line per blocker, when `agent-chat service restart` reports an unanswered ask or a mid-spawn agent, when a `git push` or `git-remote-http*` process is running, or when the checkout behind the installed `agent-chat` is not a clean `main`. It then restarts the broker, runs `npm ci && npm run build` in that checkout, and checks `events.db` for exactly one `broker_started` and no `ledger_shadow_error` since the restart, plus a parseable `agent ls --json`. It exits 1 on a refusal, 2 on a failed post-check, and prints `restart-window OK` otherwise. It accepts no `--force`, and running it needs the owner's approval of the day's window. `RESTART_WINDOW_DB` overrides the database path.

## Tests

```bash
npm run build && npm test
```

`npm test` and `npm run verify` run `vitest run` through `agent-chat suite-slot`,
so at most `fullSuiteSlots` (default 4) full suites run at once machine-wide. A
runner in another repo takes a slot the same way, for example
`"test": "agent-chat suite-slot -- vitest run"`. Each held slot is a directory
`~/.agent-chat/suite-slots/<i>` holding the wrapper's pid. The wrapper waits for a
free slot, runs the command, passes its exit code through and removes the slot.
On SIGINT or SIGTERM it forwards the signal to the command, removes the slot once
the command exits, and exits by the same signal. A slot whose pid is no longer
running is taken over, so a runner killed outright frees its slot. After 30 minutes of waiting the wrapper runs without a slot rather
than block on a hung holder. Run a single test file with `npx vitest run <file>`,
which takes no slot.

Roughly 1,000 checks across 60 files. `registry.test.ts` covers live routing
decisions, `event-log.test.ts` covers the projections, `routing.test.ts` drives
real MCP sessions over stdio, and `approvals.test.ts` drives the real
permission-request notification. The properties that matter:

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
- a permission prompt surfaces with its input preview and **no verdict is sent**
- a blocked session clears the moment it does anything else
- a stale approval ages out of the queue, while questions never do
- a plain notice ages out after `noticeTtlHours`, while kinded notices never do
- an over-budget broadcast is held rather than dropped, and stays retrievable
- a depth-5 chain delivers untouched — the breaker sits far above real work

Run it from anywhere, including inside a Claude Code session. Most of the suite
spawns the real CLI with the ambient environment, which used to mean the
developer's own `CLAUDE_CODE_SESSION_ID` and `AGENT_CHAT_*` reached the servers
under test. `src/__tests__/setup-env.ts` strips both before every file.

## Limits

**Delivery is fire-and-forget.** `mcp.notification()` is unacknowledged — "Delivered"
means "written to a pipe," nothing more. Messages land on the recipient's _next
turn_, and several arriving while they're busy are batched into one. Nothing
blocks waiting for a reply: that would deadlock two sessions each awaiting the
other's turn.

**Broadcasts are throttled, directed messages never are.** The budget is
denominated in _amplified_ bytes — payload × live recipients — because fanout is
the cost, not message count. Over budget, a broadcast is held in every
recipient's inbox instead of being pushed live, so nothing is lost; the spend is
charged even when suppressed, so hitting the limit does not make further
broadcasts free.

**Reply chains stamp `thread_depth` and break at a limit.** The stamp is the
primary mechanism and it is lossless: it is model-visible, so both sides can
converge on their own. A hint appears on a long chain and a hard break escalates
to the human queue. Depth resets if a model opens a _fresh_ thread rather than
replying, which nothing currently prevents.

**Throttling does not protect your attention.** Both controls above measure
volume. A low-traffic, high-substance peer stream passes every budget and can
still starve you, because peer messages arrive with the immediacy of a live event
while your own request sits in the transcript looking already-answered.

**`idleMs` is a proxy.** It measures time since this session last called a
`chat_*` tool, not since it last did anything. A session deep in a long task
looks idle.

**Peer messages are not user instructions.** The server `instructions` tell Claude
to treat inbound text as information from a peer rather than its user's authority,
and never as approval for a pending permission prompt. The socket is `0600`, so
the trust boundary is the OS account.

**The permission relay sees interactive sessions only.** Tool-approval prompts
are forwarded to the channel server and surfaced as `approval` rows, which makes
a blocked session knowable rather than merely idle-looking. But a headless
`--print` session resolves denials without ever opening a promptable request, so
it relays nothing — a background peer is fully addressable for messaging and
still invisible when stuck. A prompt that did relay can be answered from the
queue with `agent-chat approve <id> allow|deny` — human-only: refused from every
registered session, and denied to the builtin profiles' `Bash` so an agent cannot
shell out to it; see [docs/permission-relay.md](docs/permission-relay.md).

**"Allowlisted" is per session, not per machine.** A session's permission view is
read once and memoized with no watcher. Its own grants apply immediately, but
another session's never reach it. So the _absence_ of an `approval` row only
tells you a tool was allowlisted when that session launched — it is not portable
evidence across sessions of different vintages. Presence is unaffected.

**Spawns stop when the machine is full.** `agent_spawn` refuses a headless spawn
while `machineHeadlessAgents` (default 10) headless agents are live machine-wide,
and any spawn while free memory (`kern.memorystatus_level`) is below
`machineMemoryFreePercent` (default 15) percent. Both keys live in
`~/.agent-chat/config.json`. Swap used is reported by `seats status` but never
refuses, because macOS keeps swap allocated after memory pressure ends. A reader
that fails lets the spawn through. Details are in `docs/agent-teams.md` §11.3.

## Not built yet

- Path claims — reusing the lease primitive for files instead of nicknames.
- A per-pair rate backstop, since `thread_depth` resets on a fresh thread.

## License

MIT. See [LICENSE](LICENSE).

This is a personal proof of concept, published because the mechanics are worth
reading rather than because it wants maintaining. Expect it to track whatever
Claude Code build it was last run against; the behaviour it depends on is a
research preview and is not a stable interface.

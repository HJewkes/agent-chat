# agent-chat: service, HTTP, and dashboard — implementation plan

**Status:** plan only. No code, config, or docs were modified producing this.
**Written:** 2026-07-26. **Repo:** `/Users/hjewkes/projects/agent-chat`, branch
`feat/plugin-packaging` (HEAD `a027926`, pushed). 48 tests passing.

**This work is not starting immediately.** The live multi-session routing test
(CC-3) runs first. This document is written to be picked up by someone with no
memory of the conversation that produced it: every claim about current
behaviour cites `file:line`, and every step states its own preconditions.

References read: `/Users/hjewkes/projects/active-work` (primary),
`/Users/hjewkes/projects/brain`, and voltras (via research report).

---

## 0. Assumptions this plan rests on

Stated here so a later reader can check whether they still hold.

1. **The MCP layer stays stdio, one subprocess per Claude Code session.**
   `src/server/index.ts:90` connects a `StdioServerTransport`. This is not a
   compromise — it is the house standard: all three references are
   stdio-per-session (active-work registers `active-work mcp serve --stdio`;
   brain registers `command`/`args` in `.mcp.json`; voltras is stdio-only). It
   is *also* load-bearing here for a reason unique to agent-chat, see §1.
2. **The append-only SQLite log is the source of truth**
   (`src/broker/event-log.ts`). Every derived view — a session's inbox
   (`event-log.ts:121`), the human queue (`event-log.ts:135`), the question
   budget (`event-log.ts:159`) — is a query. Nothing here adds a store.
3. **The dashboard is interactive** — answer and dismiss only. Decided by the
   user; §5 records the constraints that came with the decision.
4. **Auto-start-on-first-use is mandatory.** Agents must never have to start the
   broker by hand (`src/client/broker-client.ts:88-91`).
5. The plugin packaging in `plugins/agent-chat/` and the launcher shim
   `bin/agent-chat-launch.sh` work and are out of scope. Their path resolution
   must not be disturbed (§8, item 7).

---

## 1. The one place agent-chat must NOT copy active-work

This is the most important paragraph in the document.

**In active-work, the stdio MCP server is not a client of the daemon.** The MCP
subprocess, the CLI, and the HTTP daemon all independently read and write plain
files on disk, coordinated by atomic writes plus `proper-lockfile` advisory
locks. The daemon is a *convenience* — it hosts a dashboard and an
MCP-over-HTTP route. Kill it and the CLI and the stdio MCP keep working.

**agent-chat cannot work that way, and must not be refactored toward it.**
Routing requires a live process holding the open per-session socket
connections. `Registry` is keyed by connection object
(`src/broker/registry.ts:38`, `private readonly entries = new Map<C, Entry>()`)
and delivery is a write to that specific socket (`src/broker/index.ts:32-37`,
`deliverTo`). A file on disk cannot hold a socket. Therefore:

- **The broker is load-bearing for correctness, not just a UI host.**
- **The MCP server stays a client of the broker** (`src/server/index.ts:69`,
  `new BrokerClient(deliver)`).
- **The lifecycle design diverges from active-work in one specific way: the
  broker must auto-start, and must never require a supervisor or a manual
  `setup` step.** active-work's daemon is started by an explicit setup step or a
  launchd/systemd unit and is deliberately *not* auto-started per request,
  because nothing breaks while it is down. Here everything breaks.

The consequence for restart — process lifetime *is* the registration lease — is
worked through in §4.5.

## 1.1 Why HTTP goes in the broker: demonstrated, not preferred

Two of the three references independently arrived at the same bug by putting a
dashboard HTTP server inside the **per-session MCP process**:

- **voltras** — port and DB collisions when two sessions run concurrently. Its
  own code says *"VW-68: one shared daemon removes this race."*
- **brain** — `.mcp.json` runs the full `serve` (HTTP dashboard + MCP stdio) per
  session, so every new Claude session tries to bind 7800 and **evicts the
  previous holder** via a `POST /api/shutdown` self-eviction protocol
  (`brain/src/commands/serve.ts:177-258`).

agent-chat already has the shared daemon those two lack. Putting the HTTP layer
in the broker means this class of bug cannot exist here: exactly one process
ever binds the port, and it is the same process that already owns the
single-instance guard (`broker/index.ts:237`, `probeExisting`).

This is the rationale to cite in review. It is not a style preference.

---

## 2. House conventions, concrete

| Concern | active-work / brain (concrete) | agent-chat plan |
|---|---|---|
| Lifecycle verbs | `mcp serve [--stdio\|--detach\|--port]`, `mcp status`, `mcp stop`, `mcp restart`, `mcp logs [--lines]`, top-level `doctor` | `service start\|stop\|status\|restart\|logs\|open`, top-level `doctor` |
| Detach | `spawn(process.execPath, …, {detached:true, stdio:'ignore'})` | identical — already what `broker-client.ts:90` does |
| `stop` | read PID → SIGTERM → poll liveness ≤3 s → remove PID file | identical, plus §4.4 |
| `status` | two-stage on purpose: `process.kill(pid,0)` **then** `GET /health` with a 500 ms timeout | three-stage: socket probe → PID → `/health` (§4.3) |
| State files | `<stateRoot>/daemon.pid`, `<stateRoot>/daemon.meta.json` = `{port, version, started}` | `~/.agent-chat/broker.pid`, `~/.agent-chat/broker.meta.json`, same fields |
| `/health` | `{ok, version, pid, uptime_ms, port}` | same + `socket`, `sessions`, `queue_open` |
| Logging | pino dual-stream: pretty→stderr when TTY, JSON lines→`<stateRoot>/daemon.log`; level from env | **keep `logEvent`** JSONL (§7.1); `service logs` tails `~/.agent-chat/broker.log`, default 50 lines, no `--follow` |
| Supervision | launchd `~/Library/LaunchAgents/dev.hjewkes.<name>.plist` (RunAtLoad + KeepAlive), logs to `~/Library/Logs/<name>/`; systemd user unit on Linux | **none** (§7.2) |
| UI stack | React 19 + Vite + `vite-plugin-singlefile` → one self-contained `dist/dashboard/index.html`; `react-native`→`react-native-web` alias | identical |
| UI tsconfig | `src/dashboard/` **excluded from the main tsconfig**, own Vite config, `outDir` explicitly resolved to `<repo>/dist/dashboard` | identical (§8, item 9) |
| Build | `tsup && build:dashboard` | `tsc && npm run build:dashboard` — this repo builds with `tsc`, not tsup |
| Serving | daemon serves `/ui` and `/ui/*` from `dist/dashboard/`, SPA fallback to index.html, placeholder page when unbuilt. Not a separate port. | identical |
| Data transport | REST + **SSE** `EventSource('/events')`. No websockets anywhere in the house style — a doc claims `/ws` but the code is SSE; the doc is stale. | REST + SSE, but §6 — this is where we exceed the reference |
| Companion skill | `postinstall` copies `skill/` → `~/.claude/skills/<name>/` | optional, §7.4 |

---

## 3. Port: **7600**

Taken on this machine: **7400** active-work daemon, **7723** voltras dashboard,
**7800** brain daemon. Verified with `lsof -nP -iTCP -sTCP:LISTEN` — 7400 and
7723 currently listening, 7600 clear.

7600 sits inside the established 7xxx band, avoids all three, and leaves
7500/7700/7900 free for whatever comes next. All house services bind loopback
only, deliberately; agent-chat does the same.

- Override `AGENT_CHAT_PORT`, mirroring `AW_PORT`
  (`active-work/src/server/daemon.ts:36`).
- Also `--port` on `service start`; the bound port is recorded in
  `broker.meta.json` so `restart` reuses it.
- Bind `127.0.0.1` only. Never `0.0.0.0`.
- **The bind is best-effort.** On `EADDRINUSE` the broker logs
  `logEvent('http_unavailable', {port})` and carries on serving the unix socket.
  Deliberate divergence: in active-work the daemon *is* the port; here the
  socket is the service and the port is an accessory. Messaging must never fail
  because a dashboard port is occupied.

---

## 4. Service lifecycle

### 4.1 Module layout

`src/server/` currently means "the MCP stdio server", while in active-work
`src/server/` means "the daemon". Someone moving between the repos will get this
wrong. **Rename `src/server/` → `src/mcp/`** — 2 files, ~6 import sites,
mechanical. Optional and independently revertible; nothing else depends on it.

```
src/
  paths.ts               + pidPath() metaPath() tokenPath() dashboardDir() defaultPort()
  protocol.ts            unchanged — the socket wire protocol
  broker/
    core.ts        NEW   BrokerCore: Registry + EventLog + EventHub; the ONE write path
    socket.ts      NEW   the net.createServer half, lifted out of index.ts
    daemon.ts      NEW   startBroker(): socket first, then HTTP, PID file, signals
    http.ts        NEW   hono app factory (pure — builds, does not bind)
    api-routes.ts  NEW   GET read model + POST answer/dismiss
    sse.ts         NEW   /events — event-log tail with resume cursor (§6)
    dashboard-routes.ts NEW  static SPA serving + token injection
    events.ts      NEW   EventHub (shape copied from active-work/src/server/events.ts)
    lifecycle.ts   NEW   pid/meta read+write+remove, isProcessAlive, probeSocket
    health.ts      NEW   buildHealthPayload()
    doctor.ts      NEW   install health checks (§7.3)
    event-log.ts   unchanged  + one read method, EventLog.since() (§6.2)
    registry.ts    unchanged
    log.ts         unchanged — the routing JSONL
    index.ts       re-exports only
  mcp/                   (was src/server/) — index.ts, tools.ts, behaviour unchanged
  client/broker-client.ts  unchanged
  cli/
    index.ts             commander root
    human.ts             inbox | answer | dismiss
    service.ts           start | stop | status | restart | logs | open
    debug.ts             ps | history | log | send
    doctor.ts            doctor
    format.ts            ago() / LABEL / column padding, lifted from cli.ts:41-51
  dashboard/             excluded from tsconfig; own vite.config.ts
    index.html main.tsx App.tsx styles.css tokens.ts types.ts vite.config.ts
    components/  QueueItemCard.tsx SessionRow.tsx EventRow.tsx LiveIndicator.tsx
    views/       Queue.tsx Sessions.tsx Log.tsx
    utils/       api.ts live.ts
```

### 4.2 `BrokerCore` — the load-bearing refactor, and the single write path

Today `src/broker/index.ts:20-21` holds module-level mutable singletons:

```ts
const registry = new Registry<Conn>()
let events: EventLog          // assigned only inside startBroker(), index.ts:258
```

An HTTP handler importing `events` before `startBroker()` runs gets `undefined`.
Fix by making both owned by an explicit object:

```ts
export class BrokerCore {
  readonly registry: Registry<Conn>
  readonly events: EventLog
  readonly hub: EventHub
  readonly startedAt: number
  constructor(deliver: (conn: Conn, message: DeliveredMessage) => void)

  append(input: AppendInput): { id: number; msgId: string }   // EventLog.append + hub fan-out
  answer(msgId: string, text: string): { ok: boolean; reason?: string }
  dismiss(msgId: string): { ok: boolean; reason?: string }
}
```

Three properties fall out, and all three are requirements:

1. **`append()` is the only place rows are written.** Every existing
   `events.append(...)` call site in `broker/index.ts` (lines 55, 63, 87, 100,
   127, 136, 155, 175, 200, 227) becomes `core.append(...)`. SSE fan-out is a
   side effect of that one function — no polling, no second writer, no drift.
2. **`answer()`/`dismiss()` are the only verdict paths.** They are lifted
   verbatim from `handleAnswer` (`broker/index.ts:91-124`) and the `dismiss`
   case (`broker/index.ts:197-201`). The socket handler
   (`broker/index.ts:195-201`) and the HTTP route both *call* them. That is one
   write path with two callers, not two write paths. The transport-specific part
   — writing a `ServerMessage` back down a socket — stays in `socket.ts`.
3. `deliver` is injected by `socket.ts`, so `core` stays free of transport I/O
   and the existing tests (`src/__tests__/registry.test.ts`, `routing.test.ts`)
   keep working untouched.

The HTTP layer reads `core.registry` **in-process**. It has to: the live session
list exists only in this process's memory (`registry.ts:38`). An out-of-process
API for it is not possible — which is another way of stating §1.1.

### 4.3 Commands

| Command | Behaviour |
|---|---|
| `service status` | **Three-stage**, extending active-work's two-stage. (1) socket probe — connect to `~/.agent-chat/chat.sock`, reusing `probeExisting` (`broker/index.ts:237`); this is authoritative liveness. (2) PID file for pid/port/started. (3) `GET /health`, 500 ms timeout, for uptime/session count/queue depth. Report each stage separately so "running but HTTP down" is legible. |
| `service start [--port] [--foreground]` | Default detached spawn; `--foreground` is today's `agent-chat broker` (`cli.ts:156`). |
| `service stop` | read PID → SIGTERM → poll `process.kill(pid,0)` ≤3 s → SIGKILL → remove PID file. See §4.4. |
| `service restart` | stop + start, reusing the port from `broker.meta.json` unless `--port` overrides. Prints the §4.5 warning. |
| `service logs [-n 50]` | tail `~/.agent-chat/broker.log`. Default 50 lines, no `--follow`, matching `mcp logs`. |
| `service open` | `open http://127.0.0.1:<port>/ui`, or print the URL when not a TTY. |
| `doctor` | §7.3 |

**Do not rename `agent-chat broker` or `agent-chat mcp`.** Both are
process-launch contracts: `broker-client.ts:90` spawns `[brokerEntry(), 'broker']`
and `plugins/agent-chat/.claude-plugin/plugin.json` passes `args: ["mcp"]` to the
launcher shim. Keep them as hidden aliases for `service start --foreground` and
the MCP entrypoint. If they ever must change, change the spawn site and the
plugin manifest in the same commit.

### 4.4 Single-instance guard, and why `stop` is not sticky

The guard today is `probeExisting(sock)` (`broker/index.ts:237-249`): connect to
the socket; if something answers, log `broker_exit` and return `null`. That is
*better* than a PID file — it proves the process is accepting connections and is
immune to stale files after `kill -9`. A TCP listener adds a second, competing
guard. Rules:

1. **Probe the socket first and exit before touching the port.** Two racing
   auto-starts must never both reach `listen(7600)`.
2. Bind the unix socket (`broker/index.ts:262`), `chmod 0600`
   (`broker/index.ts:264`), *then* bind the port. `EADDRINUSE` on the port is
   logged and swallowed (§3).
3. Write the PID file only after both binds. It is **diagnostic only** —
   `status` never uses it to answer "is it running".
4. `removePidFile()` in the shutdown handler alongside the existing socket
   unlink (`broker/index.ts:267-273`).

**`service stop` is not sticky.** `BrokerClient.onDrop()`
(`broker-client.ts:65`) calls `connect()` (`:93`), which on failure calls
`spawnBroker()` (`:88`). Any live session's MCP subprocess resurrects the broker
within ~100 ms. With sessions attached, `stop` is functionally a restart.

- **Recommended:** document it honestly, and have `stop` print how many sessions
  were attached at stop time so the behaviour is visible rather than baffling.
- **Rejected:** an inhibit file checked by `spawnBroker`. It creates a state
  where a stale file silently prevents auto-start — breaking assumption 4, the
  one thing that must never break. Revisit only if the honest version proves
  painful in daily use.

### 4.5 Restart vs. the registration lease — the sharpest interaction

Process lifetime *is* the registration lease, and `Registry.entries` is an
in-memory `Map` (`registry.ts:38`). A broker restart evaporates every
registration. What survives, what heals, and what breaks:

- **Survives — everything durable.** Inboxes, human queue, question budgets, and
  history are all queries over SQLite (`event-log.ts:121/135/159/180`). An answer
  written while a session was down is picked up by `chat_inbox` when it returns.
  This is exactly the property the log-as-truth design bought.
- **Self-heals — registrations.** `onDrop()` (`broker-client.ts:65-72`)
  reconnects and replays `{t:'register', ...identity}`.
- **Broken for 0.1–8.85 s — presence and directed routing.** The reconnect
  ladder is `[100, 250, 500, 1000, 2000, 5000]` ms (`broker-client.ts:17`). In
  that window `Registry.list()` (`registry.ts:89`) is empty or partial, so
  `agent-chat ps`, `chat_list`, and `/api/sessions` all **lie**, and a directed
  `chat_send` fails with `no active session named "bob"` (`registry.ts:135`) —
  which a sending model reads as *"bob is gone"*, not *"the broker bounced"*.

Mitigations to build:

- `/health` and `/api/sessions` expose `brokerUptimeMs`. Under ~10 s the
  dashboard renders "broker restarted — sessions reconnecting" instead of an
  empty table.
- `service restart` prints the same warning plus the attached-session count.
- **Do not persist the registry.** A registration outliving its process is a
  lease outliving the thing it leases, and reaping stale entries is precisely
  the complexity this design earns its way out of (README: "no heartbeats, no
  TTLs, no stale-entry reaper").

---

## 5. Interactive dashboard — decided

The user decided: the browser can **answer** and **dismiss** escalations.
Constraints that came with the decision, and how each is satisfied:

| Constraint | Satisfied by |
|---|---|
| Writes go through the broker on the same path the CLI uses | `core.answer()` / `core.dismiss()` (§4.2), called by both the socket handler and the HTTP route |
| No second write path; resolution is itself an event | `core.append()` is the single writer. `dismiss` appends a `resolution` row exactly as `broker/index.ts:200` does today. The HTTP layer never touches `EventLog` directly. |
| Narrow interactive surface | **answer and dismiss only** |
| Loopback only | bind `127.0.0.1` (§3), plus §6.5 |

**Permanently out of scope for the UI:**

- **Permission verdicts.** Approval items render read-only with the message the
  CLI already prints — *"answer in that session's terminal"* (`cli.ts:79`). The
  relay is observe-only by construction: `src/server/index.ts:45-49` declares
  `claude/channel/permission` and never sends a verdict, and
  `docs/ideas.md` R1 argues at length against widening who issues verdicts. The
  dashboard must not become a backdoor around that.
- **Human-initiated `send`.** Composing new messages to sessions stays a CLI
  debug affordance.
- **Session control** — no kill, no rename, no status override.

### 5.1 Concurrent clients: browser and CLI acting on the same item

Already solved by the existing design; the job is to not break it, and to make
the UI *reflect* it rather than trust its own optimistic state.

**The broker is the arbiter.** `EventLog.isOpen(msgId)` (`event-log.ts:173`)
tests whether anything references the item as `answer` or `resolution`
(`event-log.ts:67`, the `CLOSED` subquery). `handleAnswer` checks it first and
returns `{ok:false, reason:'<id> is not an open item'}`
(`broker/index.ts:92-94`); the dismiss case does the same
(`broker/index.ts:198`). The second verdict on an item loses, deterministically,
whichever surface it came from.

**Why no lock is needed:** both callers run in the same single-threaded Node
process (§1.1 again). The check-then-append inside `core.answer()` cannot be
interleaved because nothing awaits between the `isOpen` test and the `append`.
**This must stay true — a future `await` inserted between those two lines
reintroduces the race.** Put that in a comment in `core.ts`.

**UI rules, which follow directly:**

1. **No optimistic removal.** Clicking Answer marks the row pending/disabled.
   The row disappears when the corresponding `answer` or `resolution` event
   arrives over SSE — same trigger, whoever caused it.
2. **A CLI answer removes the row live.** Someone types
   `agent-chat answer 3f2a "…"` in a terminal and the browser row vanishes
   within the SSE round trip. That is the payoff for streaming real events (§6).
3. **`ok:false` is a normal outcome, not an error toast.** On
   `"not an open item"`, show "already resolved elsewhere" inline and wait for
   the SSE event to remove the row — it may already have arrived.
4. **Reconnect reconciliation is free** — the resume cursor (§6.2) replays
   everything the browser missed, including the resolution it slept through.

---

## 6. `/events` — where this plan exceeds the reference

active-work's SSE broadcasts a single generic `change` ping from a filesystem
watcher (`active-work/src/server/daemon.ts:154-160`) and the UI refetches
everything over REST. It has to: it has no event stream, just files.

agent-chat has a real append-only log with a monotonic primary key
(`event-log.ts:39`, `id INTEGER PRIMARY KEY AUTOINCREMENT`). So `/events` should
be **a tail of the event log with a resume cursor**, and a reconnecting browser
should miss nothing.

### 6.1 Frame format

One SSE frame per appended row, using the row id as the SSE event id:

```
id: 4821
event: question
data: {"id":4821,"ts":1753600000000,"kind":"question","actor":"alice",
       "target":"human","msgId":"3f2a","ref":null,"body":"…","meta":{}}
```

`event:` is the `EventKind` union (`protocol.ts:22-33`): `message`, `broadcast`,
`question`, `notice`, `answer`, `resolution`, `approval_request`, `registered`,
`deregistered`, `route_failed`. The browser can therefore subscribe per kind —
the Queue view listens for `question`/`notice`/`message`/`approval_request` plus
`answer`/`resolution` to retire rows; the Log view listens for everything.

### 6.2 Resume cursor

Because we set `id:`, the browser's native `EventSource` **automatically** sends
`Last-Event-ID` on reconnect. No client bookkeeping at all. Server side:

1. Read the cursor from the `Last-Event-ID` header, or `?since=<id>` for
   non-EventSource clients.
2. **Subscribe to the hub first, buffering live frames.** Then run the catch-up
   query `SELECT * FROM events WHERE id > ? ORDER BY id` up to the current max
   id, emit those, then flush the buffer, dropping any buffered frame whose id
   the query already covered. **Subscribe-then-query, never
   query-then-subscribe** — the reverse order silently drops anything appended
   in between.
3. **Bound the replay.** If the gap exceeds ~500 rows, emit `event: reset`
   instead and let the UI do a full refetch. Stops a browser left open overnight
   from replaying the whole log.
4. Heartbeat comment line every 25 s (active-work's `HEARTBEAT_MS`,
   `active-work/src/server/http.ts:31`) so proxies and dead-peer detection keep
   the stream healthy.
5. New `EventLog.since(id, limit)` — the one addition to `event-log.ts`, and it
   is a read.

### 6.3 Ephemeral events that are NOT in the log

Two pieces of state are in-memory only and were always meant to be:

- **`status` / `workingOn` changes** — `Registry.setStatus()` (`registry.ts:80`)
  mutates the entry and appends nothing.
- **`awaitingApproval`**, which derives the `blocked` status
  (`registry.ts:93`, `registry.ts:113`).

These must not be written to the log just to make the UI live — that would turn
ephemeral presence into permanent history and violate assumption 2. Instead the
hub carries a **transient** frame with **no `id:`**, so it never advances the
resume cursor:

```
event: session_status
data: {"reason":"status"}
```

The UI treats it as "refetch `/api/sessions`". Document the no-id rule in
`sse.ts` — it is subtle, and a future contributor will otherwise add an id.

### 6.4 HTTP surface, complete

```
GET  /health                 {ok,version,pid,uptime_ms,port,socket,sessions,queue_open}
GET  /api/queue              EventLog.humanQueue()              event-log.ts:135
GET  /api/sessions           Registry.list() + brokerUptimeMs   registry.ts:89
GET  /api/history?limit=     EventLog.history()                 event-log.ts:180
GET  /events                 SSE tail, §6.1–6.3
POST /api/answer             {msgId,text} -> core.answer()
POST /api/dismiss            {msgId}      -> core.dismiss()
GET  /ui, /ui/*              SPA + placeholder when unbuilt
ANY  /mcp                    404 with an explanatory body, §7.5
```

### 6.5 Auth on the loopback port

The socket is `chmod 0600` — *"this user only; the trust boundary is the OS
account"* (`broker/index.ts:264`). A loopback TCP port is reachable by **any
local OS user**, which is strictly weaker. Restore parity:

- Write a random token to `~/.agent-chat/ui.token`, mode `0600`, at broker start.
- `/api/*` (reads and writes) requires an `X-Agent-Chat-Token` header.
- `dashboard-routes.ts` injects the token into the served `index.html` — the
  server can read the 0600 file, an unauthorized local user cannot.
- Reject requests whose `Origin` is present and is not `http://127.0.0.1:<port>`.

Note honestly in the PR: a session with `Bash` can already run
`agent-chat answer` and forge a human verdict. The token closes the *multi-user*
gap the TCP port opens; it does not change the agent threat model, which is
unchanged from today.

---

## 7. Deliberate divergences from the house pattern

Stated up front so review does not read them as oversights.

**7.1 No pino.** active-work's `logger.ts` writes an *operational* log.
agent-chat's `log.ts` writes a *domain* log — the README calls it "the only
external evidence that a message went to exactly one session" — and its JSONL
shape is documented. Replacing it with pino would either lose that shape or
duplicate it. Keep `logEvent` (`broker/log.ts:8`); `service logs` gives it
active-work's `mcp logs` ergonomics.

**7.2 No launchd/systemd supervision.** active-work ships a launchd plist with
`RunAtLoad`+`KeepAlive` because its daemon is not auto-started. agent-chat
auto-starts on first use (`broker-client.ts:88`), which already provides the
availability a supervisor would — and `KeepAlive` *plus* auto-start means two
owners racing to resurrect one process, making the non-sticky-`stop` problem
(§4.4) strictly worse. If supervision is ever added it must go through the same
`probeExisting` guard so the loser exits cleanly.

**7.3 A top-level `doctor`** — conventional in 2 of 3 references, and unusually
valuable here. Real time was lost this cycle to two failures a `doctor` catches
instantly: the channel gate silently dropping pushes, and the CLI not being on
`PATH`. Checks:

1. Node version (`node:sqlite` needs ≥22).
2. `~/.agent-chat` exists and is writable; `events.db` opens; the socket path is
   under the ~104-byte cap (`paths.ts:5-7`).
3. Broker reachable via socket probe; HTTP port bound; `/health` answers.
4. `agent-chat` resolvable on `PATH`; `dist/cli.js` built.
5. Launcher shim resolution — do `AGENT_CHAT_ENTRY` / `AGENT_CHAT_REPO` /
   `~/.agent-chat/mcp-home` / `PATH` find a real file?
   (`bin/agent-chat-launch.sh:33-49`).
6. MCP registration present; plugin installed from the local marketplace
   (`.claude-plugin/marketplace.json`).
7. **Channel allowlist** — `allowedChannelPlugins` contains
   `agent-chat@agent-chat-local` in managed settings. Per commit `a027926`, with
   this entry absent the broker still reports `delivered:true` while the peer
   session sees no `<channel>` tag. Silent, and expensive to diagnose. This check
   alone justifies the command.
8. `dist/dashboard/index.html` present (warn, not fail).

**7.4 `postinstall` companion skill** — optional. The repo has no `skill/`
directory today. If one is written (when to escalate to the human vs. a peer,
how to pick a session name), copy it to `~/.claude/skills/agent-chat/` in
`postinstall`, matching both references. Not required by any step below.

**7.5 No MCP-over-HTTP route.** active-work serves `/mcp`
(`active-work/src/server/daemon.ts:86`). Doing that here would destroy directed
messaging: the channel notification carries only `content` and `meta`
(`src/server/index.ts:60-64`) with no addressing field, so "which subprocess
emits" *is* the address. Collapse to one shared HTTP MCP server and there is
nothing left to address with. `/mcp` returns 404 with a body explaining this, so
a reader who expects the house pattern gets told why instead of filing a bug.

**7.6 State dir stays `~/.agent-chat`,** not XDG via `env-paths`. `paths.ts:4-7`
documents why: unix socket paths cap near 104 bytes on macOS.

**7.7 `zod` stays on v3.** active-work is on v4; nothing here needs v4.

---

## 8. Existing behaviour the new layers touch or break

| # | Issue | Where | Handling |
|---|---|---|---|
| 1 | `events` is a module-level `let` assigned only inside `startBroker()` | `broker/index.ts:21`, `:258` | `BrokerCore` (§4.2) |
| 2 | Two competing single-instance guards once a port exists | §4.4 | socket probe first; port failure non-fatal |
| 3 | `stop` resurrected by any live client within ~100 ms | `broker-client.ts:65,88,93` | document; print attached-session count |
| 4 | Restart empties the registry; `ps`/`chat_list`/`/api/sessions` lie for ≤8.85 s | §4.5 | `brokerUptimeMs` + UI caveat; do not persist the registry |
| 5 | `APPROVAL_TTL_MS = 10 min` silently drops approvals out of `humanQueue()` | `event-log.ts:64`, `:143` | in a *live* UI these visibly vanish with no event behind them. Render approvals with an expiry countdown. **Do not change the TTL** — the comment at `:60-63` explains why it exists. |
| 6 | Loopback TCP is weaker than the socket's `chmod 0600` | `broker/index.ts:264` | token file + Origin check (§6.5) |
| 7 | `dist/` is gitignored; the plugin shim locates the checkout at spawn time | commit `a027926`, `bin/agent-chat-launch.sh` | `build` becomes `tsc && npm run build:dashboard`; `dist/dashboard/` must land where `dashboard-routes.ts` probes. **Do not touch the shim's resolution order** — its build check targets `dist/cli.js` and stays correct. |
| 8 | `cli.ts:2-7` suppresses the `node:sqlite` ExperimentalWarning at the entrypoint | `cli.ts:2-7` | preserve **verbatim and first** when splitting into `src/cli/index.ts`. Losing it puts warnings into the MCP server's stderr, which is the stdio transport's neighbour. |
| 9 | `tsconfig.json` compiles all of `src/**/*` with `lib: ["ES2023"]` and no DOM | `tsconfig.json:12`, `:19` | `src/dashboard` must be added to `exclude` or `tsc` fails on JSX and DOM globals. This is why both references exclude it. |
| 10 | Runtime deps go 2 → ~4 (`hono`, `@hono/node-server`, `commander`), plus react/vite dev deps | `package.json` | intended cost of matching the house stack; call it out in the PR |
| 11 | `vitest` 2.x here vs 3.x in both references | `package.json` | bump when convenient, not as part of this work |
| 12 | README and `docs/ideas.md` describe a socket-only architecture | — | README gains a dashboard section. `docs/ideas.md` I3 ("human verdict from any terminal") is partly realised by the UI — cross-reference, do not rewrite. |

---

## 9. Sequencing

Each step ends with `npm test` green (48 tests today) and a shippable repo.
Preconditions are per-step so the order stands on its own.

**Step 1 — `BrokerCore` extraction. No behaviour change.**
*Precondition: none.* Split `broker/index.ts` into `core.ts` + `socket.ts`.
Every `events.append` → `core.append`. Lift `handleAnswer` and the dismiss case
into `core.answer`/`core.dismiss`. Add `EventHub` wired to `core.append`, no
subscribers yet. **Acceptance: the existing 48 tests pass unmodified.** New unit
tests for `core.append` fan-out and `core.answer` on an already-closed item.
*Blocks everything.*

**Step 2 — Lifecycle + health, still no HTTP.**
*Precondition: step 1.* `lifecycle.ts`, `health.ts`, PID/meta files, `paths.ts`
additions, shutdown cleanup. `buildHealthPayload()` is callable and unit-tested
before any server exists.

**Step 2a — Freeze the API contract.**
*Precondition: step 2.* Write `src/dashboard/types.ts` — response shapes for
queue/sessions/history/health plus the SSE frame. One small file, written once,
imported by both the API and the UI. **This is what lets steps 3, 4, and 5 run in
parallel; do not skip it.**

**Step 3 — CLI restructure.**
*Precondition: step 2.* commander root with `human` / `service` / `debug` /
`doctor` groups. Old flat verbs kept as hidden aliases for one release (README
and `docs/ideas.md` reference them by name). `agent-chat broker` and
`agent-chat mcp` keep their exact strings (§4.3). Port `cli.ts:2-7` first.

**Step 4 — HTTP layer, reads only.**
*Precondition: steps 1, 2, 2a.* `http.ts` (pure factory), `api-routes.ts` GETs,
`sse.ts` with the resume cursor, `/health`, `/ui` placeholder, port bind in
`daemon.ts` with `EADDRINUSE` tolerance, `/mcp` explanatory 404. Test via
`app.fetch()` with no port bound — active-work's `buildHttpApp` is pure for
exactly this reason (`active-work/src/server/http.ts:14-19`). SSE tests must
cover the subscribe-then-query ordering (§6.2 step 2) and the >500-row `reset`.

**Step 5 — Dashboard SPA.**
*Precondition: step 2a for types; merges after step 4.* React + Vite singlefile
→ `dist/dashboard`, `dashboard-routes.ts`, three views (Queue / Sessions / Log),
`utils/api.ts`, `utils/live.ts`, `LiveIndicator`. The `tsconfig` exclusion
(§8, item 9) and the `build` script change land here.

**Step 6 — Interactive writes.**
*Precondition: steps 4 and 5.* `POST /api/answer`, `POST /api/dismiss` calling
`core.answer`/`core.dismiss`; token file + Origin check; UI affordances and the
four reconciliation rules from §5.1. Approvals stay read-only.

**Step 7 — `doctor`.** *Precondition: step 2 (needs the probes).* Can slot
anywhere after step 2; listed late because it is the least coupled.

**Step 8 — Docs.** README dashboard + `service` sections, `docs/ideas.md`
cross-reference.

### Parallelisation and file ownership

Steps 1, 2, and 2a are serial and touch the hot files. **Do them solo, on one
branch, before fanning out.** After 2a is frozen, three agents can run
concurrently:

| Agent | Owns exclusively | Must not touch |
|---|---|---|
| **A — CLI** (steps 3, 7) | `src/cli/**`, `src/cli.ts` (becomes a 3-line shim), `src/broker/doctor.ts` | `src/broker/http*.ts`, `src/dashboard/**` |
| **B — HTTP** (step 4) | `src/broker/http.ts`, `api-routes.ts`, `sse.ts`, `dashboard-routes.ts`, `daemon.ts` | `src/cli/**`, `src/dashboard/**` |
| **C — UI** (step 5) | `src/dashboard/**` except `types.ts`, plus `vite.config.ts` | `src/broker/**`, `src/cli/**` |

Shared, edited once then frozen:

- `src/paths.ts` — all additions in step 2, before the fan-out.
- `src/dashboard/types.ts` — step 2a. Frozen. Any change re-serialises all three agents.
- `package.json` — **all deps added in one commit at the head of the fan-out.**
  A and B both need `hono`/`commander`; C needs react/vite. Three agents editing
  `package.json` is by far the likeliest merge conflict here.
- `tsconfig.json` — one edit, in step 5, by agent C only.

Step 6 is serial after 4 and 5 — it edits both `api-routes.ts` and the UI.

---

## 10. Why the CLI survives the dashboard

Worth stating in the README, since it was a genuine open question.

1. **The human is a queue, not a session.** No MCP subprocess holds a pipe to
   the user, so there is no MCP path to them — by construction, not omission
   (`protocol.ts:16-20`: "nothing holds a socket for it, so items accumulate
   whether or not anyone is attached"). Something outside the MCP layer has to
   be the human's mouth.
2. **argv is load-bearing.** `agent-chat mcp` is how Claude Code spawns the
   server (`plugin.json`, `args: ["mcp"]`); `agent-chat broker` is how
   `spawnBroker()` auto-starts the daemon (`broker-client.ts:90`). Both are
   process-launch contracts, not conveniences.
3. **The dashboard is not always reachable** — ssh, tmux, a headless box, or the
   port already taken (§3). A UI that is the *only* way to unblock an agent is a
   single point of failure for a system whose whole purpose is unblocking agents.

The step-3 grouping encodes that: `inbox`/`answer`/`dismiss` stay top-level as
the daily verbs and the dashboard's peer; `service *` is operations; `debug *`
(`ps`, `history`, `log`, `send`) is the diagnostic tier the dashboard largely
replaces day to day. `send` is arguably human-facing (`docs/ideas.md` P5, "the
human is a peer on the same bus", `cli.ts:44`) — it sits in `debug` because
unprompted human→agent messages are rarer than answering an escalation, and
because §5 deliberately keeps it out of the UI.

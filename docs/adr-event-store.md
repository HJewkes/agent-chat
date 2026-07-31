# ADR: the latency model of `EventStore`

Status: proposed. Supersedes nothing. Gates any work on a remote/cloud-backed store.

## Context

PR #19 extracted `EventStore` (`src/broker/event-store.ts`) out of the sqlite-backed
`EventLog`. That fixed a *coupling* problem: `BrokerCore` now holds an interface
(`src/broker/core.ts:38`), the concrete class is injectable (`src/broker/core.ts:49`,
`BrokerCoreOptions.events`), and `event-log.ts` is the only file in the tree that
knows `node:sqlite` exists.

It did not fix — and was not meant to fix — the *latency* problem. All 14 methods
are synchronous, because `node:sqlite` is synchronous. A network-backed
implementation cannot honestly satisfy that signature. So the shape is swappable
and the contract is not. This ADR decides the latency model before anyone writes
a remote adapter against a signature that can't hold one.

The relevant fact about this codebase is not the number of call sites; it is that
the design is **fold-on-read**. `AgentLog` "holds no state: every call re-reads and
re-folds" (`src/agents/identity.ts:212-221`), so `roster()`, `get()`, `byName()`,
`bySession()`, `nameIsClaimed()`, `stoodDown()`, `successorOf()` and `spawnMeta()`
each scan the whole agent-event set (`identity.ts:221`, `:285`, `:302`;
`supervisor.ts:318`). That is cheap against a local file and pathological against a
network.

## Options

### (a) Async everywhere

Convert all 14 methods to `Promise`, ripple `await` outward.

Blast radius, honestly measured: 21 direct `.events.` call sites, plus 41
`core.append(...)` sites that inherit it through `BrokerCore.append`
(`core.ts:62`), plus 10 `core.agents.*` calls that inherit it through the
`AgentLog` fold. Several sit in places that do not go async cheaply:

- `SocketServer.handleMessage(conn, msg): void` (`socket.ts:690`) is a sync
  dispatcher; every read arm replies inline (`socket.ts:786`, `:789`, `:795`,
  `:803`). Making it async doesn't just add `await` — it lets two connections'
  handlers interleave where today they cannot, which matters for the budget gates
  that read-then-write (`socket.ts:480`, `:524-525`) and for `handleRoute`'s
  per-recipient append loop (`socket.ts:378`), where one row per recipient is
  written in order.
- `BrokerCore`'s constructor builds the store and the `AgentLog` over it
  (`core.ts:48-51`); `EventLog`'s constructor opens the DB and applies the schema
  (`event-log.ts:115-121`). A network store needs an async connect that a
  constructor cannot express.
- `onAppend` watchers are sync callbacks (`core.ts:81`), consumed at
  `socket.ts:79` and `supervisor.ts:186`.
- `buildHealthPayload` (`health.ts:15`) is a pure sync function whose `queue_open`
  field is a live store read (`health.ts:24`).

And even done perfectly, (a) is insufficient on its own: it turns each
`AgentLog.all()` fold into a full-log network round-trip, so a roster render
becomes several. Async-everywhere buys the right to be remote and does nothing
about being remote *well*.

### (b) Local write-ahead cache: sync reads, async replication out

Keep local sqlite as the authoritative fast path; replicate to a remote store in
the background. Preserves every call site verbatim — zero churn, and the sync
budget gates and reply-inline handlers keep working.

Cost: two sources of truth with the local one winning. The log's ordering is a
local `INTEGER PRIMARY KEY AUTOINCREMENT` (`event-log.ts` SCHEMA), and `msgId` is a
random 8-char uuid slice (`newMsgId`), so ids order rows within one machine and
carry no cross-machine ordering at all. Openness is *derived* — `isOpen` /
`authorOf` / `openEndorsement` are queries over resolution rows (`core.ts:282-283`,
`:331`, `:369`) — so replication lag between two hosts means two humans can each
see the same endorsement request as open and each approve it. Nothing in the
current design can detect that, because there is no merge step, only a fold.

### (c) Sync is permanent; a cloud store must front a local mirror

Declare the sync contract load-bearing rather than incidental. A "cloud-backed
`EventStore`" is by definition never a thin network client: it is a local
sqlite-shaped store that satisfies `EventStore` synchronously, plus an out-of-band
process that syncs it with the service. Re-hosting stops meaning "swap the class"
and starts meaning "add a sync process beside it."

This is (b) with the authority question opened rather than assumed: local may be a
cache of a remote authority, not just a leader with a follower.

## Decision

**Adopt (c).** Keep `EventStore` synchronous, and require any remote-backed
implementation to be a local mirror plus an out-of-band sync process.

The justification is this repo's shape, not general principle. Fold-on-read
(`identity.ts:212-221`) is deliberate — it is why identity state cannot drift from
the log — and it only works over a store with sub-millisecond reads. Async
everywhere doesn't rescue it; it just makes the same design remote and slow, while
converting a sync socket dispatcher (`socket.ts:690`) into one with interleaving
that the read-then-write budget checks (`socket.ts:480`, `:524`) were never written
to tolerate. Option (c) keeps the fold honest, keeps the ~70-site ripple unwritten,
and confines the hard part to one component that can be built and tested on its
own.

Next, in order:

1. Decide authority: is the local mirror the leader (b-style, remote is an archive)
   or a follower of a remote log? This determines whether `append` may be locally
   ordered at all.
2. If remote-authoritative, `id` and ordering need a design — the current
   `AUTOINCREMENT` id is a local sequence and is already exposed to clients as a
   resume cursor (`core.ts:63-66`).
3. Prototype the sync process against the derived-state hazard specifically:
   two hosts, one open `endorse_request`, both approving.
4. Confirm the sync-read budget empirically — `AgentLog.all()` re-folds per call and
   has 10 callers; if a mirror ever becomes slower than local sqlite, that is where
   it shows first.

## What this ADR does not decide

- Not a spec for the remote adapter: no wire protocol, schema, auth, or API shape.
- Not a relay/cloud-service integration design, and not a claim about which service.
- Not a decision to build any of it now, and not a deprecation of `EventLog`, which
  remains the only implementation.
- Not a change to the `EventStore` interface — no method signature moves as a result
  of this ADR. It records that they stay synchronous, and why.

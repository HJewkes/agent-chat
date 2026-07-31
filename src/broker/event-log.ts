import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite'
import { randomUUID } from 'node:crypto'
import { home } from '../paths.js'
import type { DeliveredMessage, EventKind, Provenance, QueueItem } from '../protocol.js'
import type { AgentEventRow, AppendInput, EventStore } from './event-store.js'

/**
 * Append-only event log. Everything that happens on the bus lands here; live
 * delivery is a side effect, not the record. Derived state (a session's inbox,
 * the human queue) is a query, never a stored aggregate — which is why the
 * inbox now survives a broker restart and why "resolved" is itself an event.
 *
 * The sqlite-backed implementation of `EventStore`, and the only file in the
 * tree that knows `node:sqlite` exists.
 */

export type { AgentEventRow, AppendInput, EventStore } from './event-store.js'

interface Row {
  id: number
  ts: number
  kind: string
  actor: string
  target: string | null
  msg_id: string | null
  ref: string | null
  body: string | null
  meta: string | null
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS events (
  id     INTEGER PRIMARY KEY AUTOINCREMENT,
  ts     INTEGER NOT NULL,
  kind   TEXT    NOT NULL,
  actor  TEXT    NOT NULL,
  target TEXT,
  msg_id TEXT,
  ref    TEXT,
  body   TEXT,
  meta   TEXT
);
CREATE INDEX IF NOT EXISTS events_target ON events(target, id);
CREATE INDEX IF NOT EXISTS events_msg_id ON events(msg_id);
CREATE INDEX IF NOT EXISTS events_ref ON events(ref);
`

/** Kinds that a recipient should see in their inbox. */
const INBOX_KINDS = ["'message'", "'broadcast'", "'answer'"].join(',')
/** Kinds that need the human to look at them. */
const QUEUE_KINDS = ["'message'", "'question'", "'notice'", "'approval_request'", "'endorse_request'"].join(
  ',',
)
/**
 * The local terminal dialog stays open in parallel and the first verdict wins,
 * but Claude Code sends no event when it does. A pending approval is therefore
 * presumed answered after this long rather than lingering in the queue forever.
 */
export const APPROVAL_TTL_MS = 10 * 60 * 1000

/** An item is closed once something references it as answered or dismissed. */
const CLOSED = `SELECT ref FROM events WHERE kind IN ('answer','resolution') AND ref IS NOT NULL`

/**
 * Kinds the agent read model folds over. `agent_spawn_refused` and
 * `verdict_refused` are absent on purpose: a refusal never creates or advances
 * an identity, so folding it would invent an agent that was never spawned.
 */
const AGENT_KINDS = [
  'agent_spawned',
  'agent_attached',
  'agent_detached',
  'agent_resumed',
  'agent_exited',
  'agent_retired',
  'agent_handoff',
  'agent_stood_down',
  'isolation_allocated',
  'isolation_released',
] as const satisfies readonly EventKind[]

const AGENT_KINDS_SQL = AGENT_KINDS.map(k => `'${k}'`).join(',')

// Loaded through require so Vite/vitest don't try to pre-bundle a builtin they
// don't yet know about. The type import above is erased, so it costs nothing.
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as {
  DatabaseSync: new (path: string) => DatabaseSyncType
}

export const newMsgId = (): string => randomUUID().slice(0, 8)

const toMessage = (row: Row): DeliveredMessage => {
  const meta = (row.meta ? JSON.parse(row.meta) : {}) as Record<string, string>
  return {
    msgId: row.msg_id ?? String(row.id),
    from: row.actor,
    text: row.body ?? '',
    at: row.ts,
    ...(row.ref ? { inReplyTo: row.ref } : {}),
    ...(row.kind === 'broadcast' ? { broadcast: true } : {}),
    ...(meta.event ? { event: meta.event } : {}),
    // Replayed from the row the broker wrote, so a message re-read from the
    // inbox carries the same marker the live push did. Nothing a client sends
    // reaches `meta`, which is what keeps this as trustworthy on the way out as
    // it was on the way in.
    ...(meta.provenance === 'human-endorsed' ? { provenance: 'human-endorsed' as Provenance } : {}),
  }
}

export class EventLog implements EventStore {
  private readonly db: DatabaseSyncType

  constructor(dbPath?: string) {
    const file = dbPath ?? path.join(home(), 'events.db')
    fs.mkdirSync(path.dirname(file), { recursive: true })
    this.db = new DatabaseSync(file)
    this.db.exec('PRAGMA journal_mode = WAL')
    this.db.exec(SCHEMA)
  }

  append(input: AppendInput): { id: number; msgId: string } {
    const msgId = input.msgId ?? newMsgId()
    const stmt = this.db.prepare(
      `INSERT INTO events (ts, kind, actor, target, msg_id, ref, body, meta)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    const result = stmt.run(
      Date.now(),
      input.kind,
      input.actor,
      input.target ?? null,
      msgId,
      input.ref ?? null,
      input.body ?? null,
      input.meta ? JSON.stringify(input.meta) : null,
    )
    return { id: Number(result.lastInsertRowid), msgId }
  }

  /** Everything addressed to `name`, oldest first. */
  inboxFor(name: string, limit: number): DeliveredMessage[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM (
           SELECT * FROM events
           WHERE target = ? AND kind IN (${INBOX_KINDS})
           ORDER BY id DESC LIMIT ?
         ) ORDER BY id ASC`,
      )
      .all(name, limit) as unknown as Row[]
    return rows.map(toMessage)
  }

  /**
   * Everything one session did or had done to it, newest last. Read-only and
   * pure query: observing a peer this way puts nothing into that peer's context,
   * which is the whole point — today the only way to learn what a session was
   * doing was to message it, so observation and interruption were the same act.
   */
  activityFor(name: string, limit: number): QueueItem[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM (
           SELECT * FROM events
           WHERE actor = ? OR target = ?
           ORDER BY id DESC LIMIT ?
         ) ORDER BY id ASC`,
      )
      .all(name, name, limit) as unknown as Row[]
    return rows.map(row => ({
      msgId: row.msg_id ?? String(row.id),
      kind: row.kind as QueueItem['kind'],
      from: row.actor,
      text: row.body ?? '',
      at: row.ts,
      meta: {
        ...((row.meta ? JSON.parse(row.meta) : {}) as Record<string, string>),
        ...(row.target ? { target: row.target } : {}),
      },
    }))
  }

  /** Open items for the human: addressed to them and not yet answered or dismissed. */
  humanQueue(): QueueItem[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM events
         WHERE target = 'human' AND kind IN (${QUEUE_KINDS})
           AND msg_id NOT IN (${CLOSED})
           AND (kind != 'approval_request' OR ts > ?)
         ORDER BY id ASC`,
      )
      .all(Date.now() - APPROVAL_TTL_MS) as unknown as Row[]
    return rows.map(row => ({
      msgId: row.msg_id ?? String(row.id),
      kind: row.kind as QueueItem['kind'],
      from: row.actor,
      text: row.body ?? '',
      at: row.ts,
      meta: (row.meta ? JSON.parse(row.meta) : {}) as Record<string, string>,
    }))
  }

  /** How many items of one kind this session has outstanding, for budgeting. */
  openCount(actor: string, kind: EventKind): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM events
         WHERE actor = ? AND kind = ? AND msg_id NOT IN (${CLOSED})`,
      )
      .get(actor, kind) as unknown as { n: number }
    return row.n
  }

  /**
   * Same budget, but by durable agent identity rather than by name (CC-38).
   *
   * `openCount` is keyed on `actor`, which is whatever the composer typed into
   * `chat_register` this connection — a session that re-registers under a new
   * name gets a fresh budget every time. `agent_id` in `meta` is minted by the
   * broker at adoption and cannot be self-asserted, so counting by it closes
   * that for any session with a durable identity. A raw, never-adopted
   * connection has no `agent_id` to key on and falls back to `openCount`.
   */
  openCountByAgent(agentId: string, kind: EventKind): number {
    const rows = this.db
      .prepare(`SELECT meta FROM events WHERE kind = ? AND msg_id NOT IN (${CLOSED})`)
      .all(kind) as unknown as { meta: string | null }[]
    return rows.filter(row => {
      const meta = (row.meta ? JSON.parse(row.meta) : {}) as Record<string, string>
      return meta.agent_id === agentId
    }).length
  }

  /**
   * The stored text of an endorsement request that is still open, with who
   * composed it and who it was composed for.
   *
   * Delivery reads the body from HERE rather than from the approving request,
   * which is what makes the delivered bytes necessarily the bytes the human was
   * shown. Returns undefined once the item is closed, so an approval is a grant
   * over exactly one message and cannot be replayed.
   */
  openEndorsement(msgId: string): { composer: string; recipient: string; text: string } | undefined {
    const row = this.db
      .prepare(
        `SELECT * FROM events
         WHERE msg_id = ? AND kind = 'endorse_request' AND msg_id NOT IN (${CLOSED}) LIMIT 1`,
      )
      .get(msgId) as unknown as Row | undefined
    if (!row) return undefined
    const meta = (row.meta ? JSON.parse(row.meta) : {}) as Record<string, string>
    if (!meta.recipient) return undefined
    return { composer: row.actor, recipient: meta.recipient, text: row.body ?? '' }
  }

  /**
   * The questions this session still has outstanding, not just how many.
   *
   * Teleport refuses while any are open, and a refusal a model cannot act on is
   * one it will retry against the same wall — so the reason has to name them,
   * the way `send_result.reason` names a route failure rather than reporting
   * "failed".
   */
  openQuestions(actor: string): QueueItem[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM events
         WHERE actor = ? AND kind = 'question' AND msg_id NOT IN (${CLOSED})
         ORDER BY id ASC`,
      )
      .all(actor) as unknown as Row[]
    return rows.map(row => ({
      msgId: row.msg_id ?? String(row.id),
      kind: row.kind as QueueItem['kind'],
      from: row.actor,
      text: row.body ?? '',
      at: row.ts,
      meta: (row.meta ? JSON.parse(row.meta) : {}) as Record<string, string>,
    }))
  }

  /**
   * Peer traffic that landed in `name`'s inbox since `since`.
   *
   * Deliberately NOT called "unread": nothing anywhere tracks a read cursor, so
   * this counts what ARRIVED in a window the caller picks. Teleport uses it to
   * warn — never to refuse — since the descendant keeps the name and `chat_inbox`
   * still returns every one of these rows after the hop.
   */
  inboxCountSince(name: string, since: number): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM events
         WHERE target = ? AND kind IN (${INBOX_KINDS}) AND ts >= ?`,
      )
      .get(name, since) as unknown as { n: number }
    return row.n
  }

  /** The session that raised `msgId`, so an answer knows where to go back to. */
  authorOf(msgId: string): string | undefined {
    const row = this.db.prepare(`SELECT actor FROM events WHERE msg_id = ? LIMIT 1`).get(msgId) as unknown as
      { actor: string } | undefined
    return row?.actor
  }

  isOpen(msgId: string): boolean {
    const row = this.db
      .prepare(`SELECT 1 AS hit FROM events WHERE msg_id = ? AND msg_id NOT IN (${CLOSED}) LIMIT 1`)
      .get(msgId) as unknown as { hit: number } | undefined
    return row !== undefined
  }

  /**
   * Every row that bears on an agent identity, oldest first, for the fold in
   * `agents/identity.ts`.
   *
   * The db handle stays private and this returns plain rows rather than the read
   * model reaching in: the fold is then a pure function over a row list, unit
   * testable with no database at all, which is the point of the A1 ordering.
   */
  agentEvents(): AgentEventRow[] {
    const rows = this.db
      .prepare(`SELECT * FROM events WHERE kind IN (${AGENT_KINDS_SQL}) ORDER BY id ASC`)
      .all() as unknown as Row[]
    return rows.map(row => ({
      kind: row.kind as EventKind,
      ts: row.ts,
      actor: row.actor,
      target: row.target,
      msgId: row.msg_id,
      ref: row.ref,
      body: row.body,
      meta: (row.meta ? JSON.parse(row.meta) : {}) as Record<string, string>,
    }))
  }

  history(limit: number): QueueItem[] {
    const rows = this.db
      .prepare(`SELECT * FROM (SELECT * FROM events ORDER BY id DESC LIMIT ?) ORDER BY id ASC`)
      .all(limit) as unknown as Row[]
    return rows.map(row => ({
      msgId: row.msg_id ?? String(row.id),
      kind: row.kind as QueueItem['kind'],
      from: row.actor,
      text: row.body ?? '',
      at: row.ts,
      meta: {
        ...((row.meta ? JSON.parse(row.meta) : {}) as Record<string, string>),
        ...(row.target ? { target: row.target } : {}),
      },
    }))
  }

  close(): void {
    this.db.close()
  }
}

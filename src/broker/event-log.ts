import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite'
import { randomUUID } from 'node:crypto'
import { home } from '../paths.js'
import type { DeliveredMessage, EventKind, QueueItem } from '../protocol.js'

/**
 * Append-only event log. Everything that happens on the bus lands here; live
 * delivery is a side effect, not the record. Derived state (a session's inbox,
 * the human queue) is a query, never a stored aggregate — which is why the
 * inbox now survives a broker restart and why "resolved" is itself an event.
 */

export interface AppendInput {
  kind: EventKind
  actor: string
  target?: string
  msgId?: string
  ref?: string
  body?: string
  meta?: Record<string, string>
}

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
const QUEUE_KINDS = ["'message'", "'question'", "'notice'", "'approval_request'"].join(',')
/**
 * The local terminal dialog stays open in parallel and the first verdict wins,
 * but Claude Code sends no event when it does. A pending approval is therefore
 * presumed answered after this long rather than lingering in the queue forever.
 */
export const APPROVAL_TTL_MS = 10 * 60 * 1000

/** An item is closed once something references it as answered or dismissed. */
const CLOSED = `SELECT ref FROM events WHERE kind IN ('answer','resolution') AND ref IS NOT NULL`

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
  }
}

export class EventLog {
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

  /** How many questions this session has outstanding, for budgeting. */
  openQuestionCount(actor: string): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM events
         WHERE actor = ? AND kind = 'question' AND msg_id NOT IN (${CLOSED})`,
      )
      .get(actor) as unknown as { n: number }
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

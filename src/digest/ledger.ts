import fs from 'node:fs'
import { createRequire } from 'node:module'
import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite'
import { NOTICE_LIVE } from '../broker/notice-expiry.js'
import { resolveNoticeTtlMs } from '../config.js'
import type {
  ClassReversal,
  DecidedEntry,
  LedgerFacts,
  QueueEntry,
  ReportStatus,
  StatusReport,
} from './types.js'

/** Read-only queries over the broker's events.db for the digest. Never writes, never migrates. */

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as {
  DatabaseSync: new (path: string, options?: { readOnly?: boolean }) => DatabaseSyncType
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

const WEEK_MS = 7 * 24 * 3_600_000
/** Mirrors `APPROVAL_TTL_MS` in the event log: an unanswered approval older than this is presumed answered. */
const APPROVAL_TTL_MS = 10 * 60 * 1000

const CLOSED = `SELECT ref FROM events WHERE kind IN ('answer','resolution') AND ref IS NOT NULL`
const DECIDED = `SELECT ref FROM events WHERE kind = 'decided' AND ref IS NOT NULL`

export const EMPTY_FACTS: LedgerFacts = {
  available: false,
  escalations: [],
  otherNotices: 0,
  decided: [],
  reversals: [],
  reports: [],
}

const metaOf = (row: { meta: string | null }): Record<string, string> => {
  try {
    return (row.meta ? JSON.parse(row.meta) : {}) as Record<string, string>
  } catch {
    return {}
  }
}

export function readLedgerFacts(
  dbPath: string,
  sinceMs: number,
  now: number,
  noticeTtlMs = resolveNoticeTtlMs(),
): LedgerFacts {
  if (!fs.existsSync(dbPath)) return EMPTY_FACTS
  const db = new DatabaseSync(dbPath, { readOnly: true })
  try {
    const open = openQueue(db, now, noticeTtlMs)
    return {
      available: true,
      escalations: open.filter(e => e.kind !== 'notice' || e.itemKind !== undefined),
      otherNotices: open.filter(e => e.kind === 'notice' && e.itemKind === undefined).length,
      decided: decidedSince(db, sinceMs),
      reversals: reversals(db, now - WEEK_MS),
      reports: reportsSince(db, sinceMs),
    }
  } finally {
    db.close()
  }
}

/** The human queue as `humanQueue()` computes it, minus plain messages, which are not asks. */
function openQueue(db: DatabaseSyncType, now: number, noticeTtlMs: number): QueueEntry[] {
  const rows = db
    .prepare(
      `SELECT * FROM events
       WHERE target = 'human' AND kind IN ('question','notice','approval_request','endorse_request')
         AND msg_id NOT IN (${CLOSED}) AND msg_id NOT IN (${DECIDED})
         AND (kind != 'approval_request' OR ts > ? OR json_extract(meta, '$.source') = 'hook')
         AND ${NOTICE_LIVE}
       ORDER BY id ASC`,
    )
    .all(now - APPROVAL_TTL_MS, now - noticeTtlMs) as unknown as Row[]
  return rows.map(row => {
    const itemKind = metaOf(row).kind
    return {
      msgId: row.msg_id ?? String(row.id),
      kind: row.kind,
      from: row.actor,
      text: row.body ?? '',
      at: row.ts,
      ...(itemKind === undefined ? {} : { itemKind }),
    }
  })
}

interface DecidedRow extends Row {
  q_actor: string | null
  q_body: string | null
  overruled: number
  accepted: number
}

function decidedSince(db: DatabaseSyncType, sinceMs: number): DecidedEntry[] {
  const rows = db
    .prepare(
      `SELECT d.*, q.actor AS q_actor, q.body AS q_body,
         EXISTS (SELECT 1 FROM events a WHERE a.kind = 'answer' AND a.ref = d.ref AND a.id > d.id) AS overruled,
         EXISTS (SELECT 1 FROM events r WHERE r.kind = 'resolution' AND r.ref = d.ref AND r.id > d.id) AS accepted
       FROM events d LEFT JOIN events q ON q.msg_id = d.ref AND q.kind = 'question'
       WHERE d.kind = 'decided' AND d.ts >= ?
       ORDER BY d.id ASC`,
    )
    .all(sinceMs) as unknown as DecidedRow[]
  return rows.map(row => {
    const meta = metaOf(row)
    return {
      questionId: row.ref ?? '',
      asker: row.q_actor ?? '(unknown)',
      question: row.q_body ?? '',
      answer: row.body ?? '',
      by: row.actor,
      at: row.ts,
      class: meta.class ?? '(none)',
      basis: meta.basis ?? '(none)',
      precedent: meta.precedent ?? '(none)',
      state: row.overruled ? 'overruled' : row.accepted ? 'accepted' : 'awaiting audit',
    }
  })
}

/** Decisions per class over the last week and how many the human overruled; the design's weekly reversal rate. */
function reversals(db: DatabaseSyncType, sinceMs: number): ClassReversal[] {
  return db
    .prepare(
      `SELECT COALESCE(json_extract(d.meta, '$.class'), '(none)') AS class, COUNT(*) AS decided,
         SUM(EXISTS (SELECT 1 FROM events a WHERE a.kind = 'answer' AND a.ref = d.ref AND a.id > d.id)) AS overruled
       FROM events d WHERE d.kind = 'decided' AND d.ts >= ?
       GROUP BY class ORDER BY class`,
    )
    .all(sinceMs) as unknown as ClassReversal[]
}

/** `Status: BLOCKED`, `**Status:** NEEDS_CONTEXT`, `Status TP-1 (F6): BLOCKED`; not "no BLOCKED" in prose. */
const STATUS_LINE = /\b[Ss]tatus(?:\s+[\w-]+(?:\s*\([^)\n]*\))?)?\s*:?\**\s*(BLOCKED|NEEDS_CONTEXT)\b/

export function reportStatus(body: string): { status: ReportStatus; line: string } | undefined {
  const match = STATUS_LINE.exec(body)
  if (match?.[1] === undefined) return undefined
  const start = body.lastIndexOf('\n', match.index) + 1
  const end = body.indexOf('\n', match.index)
  const line = body.slice(start, end === -1 ? undefined : end).trim()
  return { status: match[1] as ReportStatus, line: line.length > 120 ? `${line.slice(0, 117)}...` : line }
}

function reportsSince(db: DatabaseSyncType, sinceMs: number): StatusReport[] {
  const rows = db
    .prepare(
      `SELECT * FROM events WHERE kind = 'message' AND ts >= ?
         AND (body GLOB '*BLOCKED*' OR body GLOB '*NEEDS_CONTEXT*')
       ORDER BY id ASC`,
    )
    .all(sinceMs) as unknown as Row[]
  return rows.flatMap(row => {
    const found = reportStatus(row.body ?? '')
    if (found === undefined) return []
    const to = row.target ?? '(broadcast)'
    return [{ msgId: row.msg_id ?? String(row.id), from: row.actor, to, at: row.ts, ...found }]
  })
}
